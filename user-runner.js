/**
 * user-runner.js — Per-user booking orchestrator
 *
 * Loads one user's complete config from Supabase, builds the config object
 * that check-availability.js and book-tee-time.js expect, runs the booking
 * flow, writes results back to the database, and sends user notifications.
 *
 * This is the heart of the multi-tenant system. The scheduler calls
 * runForUser(userId, runType) for each active user at the right time.
 *
 * Design:
 *   - Each user gets an isolated Playwright browser context (no cookie leakage)
 *   - Errors are caught per-user and logged — one user's failure never crashes others
 *   - All results are persisted to Supabase before notifications go out
 */

'use strict';

const path = require('path');
const db   = require('./db/client');
const { unpackCredentials } = require('./lib/encrypt');
const { notifyBookingSuccess, notifyBookingFailed, alertInternalError } = require('./lib/notify');

// The existing single-user modules — we reuse their internals by injecting config
const checkAvailability = require('./check-availability');
const bookTeeTime       = require('./book-tee-time');

// ─── Config builder ───────────────────────────────────────────────────────────
/**
 * Convert a Supabase user_configs row into the shape that the existing
 * check-availability.js / book-tee-time.js modules expect.
 * This is the translation layer between the DB schema and legacy code.
 */
function buildLegacyConfig(userRow, configRow, credRow, playersRows) {
  const { username, password } = unpackCredentials(credRow);

  return {
    portal: {
      loginUrl: 'https://members.invitedclubs.com/club/scripts/login/login.asp',
      teeTimes: 'https://apps.invitedclubs.com/portal/pls/portal/!CCTTWEB.controller'
    },
    credentials: { username, password },   // injected — never read from .env by the module
    booking: {
      homeClub: {
        name:           configRow.home_club_name,
        daysInAdvance:  configRow.home_club_days_in_advance,
        targetDay:      configRow.home_club_target_day,
        preferredTimeRange: {
          earliestHour: configRow.home_earliest_hour,
          latestHour:   configRow.home_latest_hour,
        }
      },
      accessAdvantage: {
        enabled:        configRow.aa_enabled,
        targetDay:      configRow.aa_target_day,
        preferredTimeRange: {
          earliestHour: configRow.aa_earliest_hour,
          latestHour:   configRow.aa_latest_hour,
        },
        preferredClubs: configRow.aa_preferred_clubs || []
      },
      numberOfPlayers:           configRow.number_of_players,
      fallbackToEarliestAvailable: configRow.fallback_to_earliest,
      clubTiers:                 configRow.club_tiers || []
    },
    players: [
      {
        role:      'primary',
        firstName: userRow.name?.split(' ')[0] || 'Member',
        lastName:  userRow.name?.split(' ').slice(1).join(' ') || '',
        phone:     userRow.phone || ''
      },
      ...playersRows.map(p => ({
        role:      'guest',
        index:     p.slot_index,
        firstName: p.first_name,
        lastName:  p.last_name,
        phone:     p.phone || ''
      }))
    ],
    defaultGuestIndex: 1,
    notifications: {
      sms:                  !!userRow.phone,
      logToFile:            false,   // Cloud logging instead
      preBookingAlertMinutes: 5,
      alertOnNewSlots:      true
    },
    twilio: {
      accountSid:  process.env.TWILIO_ACCOUNT_SID  || '',
      authToken:   process.env.TWILIO_AUTH_TOKEN   || '',
      fromNumber:  process.env.TWILIO_FROM_NUMBER  || '',
      toNumber:    userRow.phone || ''
    },
    intelligence: {
      surgeIntervalMinutes:       3,
      normalIntervalMinutes:     15,
      bookingDayIntervalMinutes:  5,
      minClubReliabilityScore:   0.2
    }
  };
}

// ─── Main runner ──────────────────────────────────────────────────────────────

/**
 * Run the full check-availability + book flow for a single user.
 *
 * @param {string} userId   - Supabase user UUID
 * @param {string} runType  - 'availability_check' | 'booking'
 * @param {object} options  - { dryRun: bool }
 * @returns {object}        - { success, booking, slotsFound, error }
 */
async function runForUser(userId, runType = 'availability_check', options = {}) {
  const startTime = Date.now();
  const tag = `[runner:${userId.slice(0, 8)}]`;
  console.log(`\n${tag} Starting ${runType}...`);

  let user, config, cred, players;

  // ── Load user data from DB ────────────────────────────────────────────────
  try {
    const [userRes, configRes, credRes, playersRes] = await Promise.all([
      db.getUserById(userId),
      db.getUserConfig(userId),
      db.getCredentials(userId),
      db.getPlayers(userId)
    ]);

    if (userRes.error)   throw new Error(`User not found: ${userRes.error.message}`);
    if (configRes.error) throw new Error(`Config not found: ${configRes.error.message}`);
    if (credRes.error)   throw new Error(`Credentials not found: ${credRes.error.message}`);

    user    = userRes.data;
    config  = buildLegacyConfig(userRes.data, configRes.data, credRes.data, playersRes.data || []);
    cred    = credRes.data;
    players = playersRes.data || [];

    console.log(`${tag} Loaded config — home club: ${configRes.data.home_club_name}, players: ${configRes.data.number_of_players}`);
  } catch (err) {
    console.error(`${tag} ❌ Failed to load user data:`, err.message);
    await alertInternalError({ id: userId, email: userId }, err);
    await db.recordAttempt({
      userId, runType, success: false,
      errorMessage: `Data load failed: ${err.message}`,
      durationMs: Date.now() - startTime
    });
    return { success: false, error: err.message };
  }

  // ── Run availability check ────────────────────────────────────────────────
  if (runType === 'availability_check') {
    try {
      const results = await checkAvailability.run(config);

      const slotsFound = (results || []).reduce((sum, r) => sum + (r.slots?.filter(s => s.slotsAvailable > 0).length || 0), 0);
      const clubsChecked = (results || []).length;

      // Save snapshots for each club
      for (const result of results || []) {
        if (result.error || !result.slots) continue;
        await db.saveSnapshot({
          userId,
          clubName:     result.clubName,
          snapshotDate: result.date,
          dayOfWeek:    new Date(result.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' }),
          slots:        result.slots
        }).catch(e => console.error(`${tag} Snapshot save failed:`, e.message));
      }

      await db.recordAttempt({
        userId, runType: 'availability_check', success: true,
        clubsChecked, slotsFound, durationMs: Date.now() - startTime
      });

      console.log(`${tag} ✅ Checked ${clubsChecked} clubs, found ${slotsFound} open slots`);
      return { success: true, slotsFound, clubsChecked, results };

    } catch (err) {
      console.error(`${tag} ❌ Availability check failed:`, err.message);
      await alertInternalError(user, err);
      await db.recordAttempt({
        userId, runType: 'availability_check', success: false,
        errorMessage: err.message, durationMs: Date.now() - startTime
      });
      return { success: false, error: err.message };
    }
  }

  // ── Run booking ────────────────────────────────────────────────────────────
  if (runType === 'booking') {
    if (options.dryRun) {
      console.log(`${tag} DRY RUN — would book but skipping actual reservation`);
      return { success: true, dryRun: true };
    }

    try {
      const result = await bookTeeTime.run(config);

      if (result.success) {
        // Persist booking to DB
        const { data: booking } = await db.recordBooking({
          userId,
          clubName:           result.club,
          bookingDate:        result.date,
          teeTime:            result.slot?.display || result.teeTime,
          teeTimeHour:        result.slot?.hour,
          numPlayers:         config.booking.numberOfPlayers,
          bookingType:        result.bookingType || 'home_club',
          inPreferredWindow:  result.inWindow !== false,
          confirmationRef:    result.confirmationRef,
          rawResponse:        result.rawResponse
        });

        await db.recordAttempt({
          userId, runType: 'booking', success: true,
          bookingId: booking?.id, durationMs: Date.now() - startTime
        });

        // Notify the user
        await notifyBookingSuccess(user, {
          clubName:          result.club,
          date:              result.date,
          teeTime:           result.slot?.display || result.teeTime,
          numPlayers:        config.booking.numberOfPlayers,
          inPreferredWindow: result.inWindow !== false
        });

        console.log(`${tag} ✅ Booked — ${result.club} at ${result.slot?.display} on ${result.date}`);
        return { success: true, booking: result };

      } else {
        // No slot found
        await db.recordAttempt({
          userId, runType: 'booking', success: false,
          errorMessage: result.reason || 'No available slots',
          durationMs: Date.now() - startTime
        });

        await notifyBookingFailed(user, {
          reason: result.reason || 'No slots available in the booking window',
          date:   result.date || 'target date'
        });

        console.log(`${tag} ⚠️  No booking made — ${result.reason}`);
        return { success: false, reason: result.reason };
      }

    } catch (err) {
      console.error(`${tag} ❌ Booking failed:`, err.message);
      await alertInternalError(user, err);
      await db.recordAttempt({
        userId, runType: 'booking', success: false,
        errorMessage: err.message, durationMs: Date.now() - startTime
      });
      await notifyBookingFailed(user, { reason: `Unexpected error: ${err.message}`, date: 'target date' });
      return { success: false, error: err.message };
    }
  }

  return { success: false, error: `Unknown runType: ${runType}` };
}

// ─── Onboarding helper ────────────────────────────────────────────────────────
/**
 * Create a new user record from the signup form submission.
 * Call this from your webhook handler when a new user completes signup.
 */
async function onboardUser({ email, name, phone, plan, username, password, configData, playersData }) {
  const { packCredentials } = require('./lib/encrypt');

  // 1. Create user
  const { data: user, error: userErr } = await db.createUser({ email, name, phone, plan });
  if (userErr) throw new Error(`Failed to create user: ${userErr.message}`);

  // 2. Encrypt and store credentials
  const packed = packCredentials(username, password);
  const { error: credErr } = await db.upsertCredentials({ userId: user.id, ...packed });
  if (credErr) throw new Error(`Failed to store credentials: ${credErr.message}`);

  // 3. Store booking config
  const { error: confErr } = await db.upsertUserConfig(user.id, configData);
  if (confErr) throw new Error(`Failed to store config: ${confErr.message}`);

  // 4. Store guest players
  for (const player of (playersData || [])) {
    await db.upsertPlayer({ userId: user.id, ...player });
  }

  console.log(`[onboard] ✅ User onboarded: ${email} (${user.id})`);
  return user;
}

module.exports = { runForUser, onboardUser, buildLegacyConfig };
