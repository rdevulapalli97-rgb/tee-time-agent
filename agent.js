/**
 * agent.js — Tee Time Booking Agent Orchestrator
 *
 * The master loop that combines:
 *   - Smart interval selection (surge vs. normal)
 *   - History-based club prioritization
 *   - Automatic booking on booking day (Sundays → Saturday, Mondays → Sunday)
 *   - Pre-booking SMS alert with 5-minute cancel window
 *   - Existing reservation detection
 *   - SMS notifications for new slots, bookings, errors
 *
 * Usage:
 *   node agent.js             # runs the smart loop forever
 *   node agent.js --force-book [--date YYYY-MM-DD]  # force a booking attempt now
 *   node agent.js --check-only  # one scrape run, update dashboard, exit
 */

const { execSync, spawn } = require('child_process');
const fs       = require('fs');
const path     = require('path');

const { sendSMS, notifyConfigured } = require('./notify');
const history  = require('./history');
const { bookTeeTime, GA_CLUBS } = require('./book-tee-time');

const CONFIG_FILE      = path.join(__dirname, 'config.json');
const AVAILABILITY_FILE = path.join(__dirname, 'availability.json');
const PENDING_FILE     = path.join(__dirname, 'pending-booking.json');
const CANCEL_FLAG      = path.join(__dirname, 'cancel-booking.flag');
const AGENT_STATE_FILE = path.join(__dirname, 'agent-state.json');

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadConfig() { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
  try {
    const config = loadConfig();
    if (config.notifications?.logToFile) {
      fs.appendFileSync(path.join(__dirname, 'agent.log'), `[${new Date().toISOString()}] ${msg}\n`);
    }
  } catch {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatDate(isoDate) {
  return new Date(isoDate + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric'
  });
}

function loadState() {
  try {
    if (fs.existsSync(AGENT_STATE_FILE)) return JSON.parse(fs.readFileSync(AGENT_STATE_FILE, 'utf8'));
  } catch {}
  return { lastBookedDate: null, lastSlotSnapshot: {}, consecutiveFailures: 0 };
}

function saveState(state) {
  fs.writeFileSync(AGENT_STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Booking day detection ─────────────────────────────────────────────────────
/**
 * Returns booking info if today is a day when we should try to book.
 * - Sunday  → book Saturday 6 days out (home club)
 * - Monday  → book Sunday  6 days out (access advantage)
 */
function getBookingTarget(now, config) {
  const dow = now.getDay(); // 0=Sun, 1=Mon

  if (dow === 0) { // Sunday → book Saturday
    const target = new Date(now);
    target.setDate(now.getDate() + (config.booking.homeClub.daysInAdvance || 6));
    return {
      isoDate: target.toISOString().split('T')[0],
      type: 'homeClub',
      label: `Saturday ${formatDate(target.toISOString().split('T')[0])} (home club)`,
      timeRange: config.booking.homeClub.preferredTimeRange
    };
  }

  if (dow === 1 && config.booking.accessAdvantage?.enabled) { // Monday → book Sunday
    const target = new Date(now);
    target.setDate(now.getDate() + 6);
    return {
      isoDate: target.toISOString().split('T')[0],
      type: 'accessAdvantage',
      label: `Sunday ${formatDate(target.toISOString().split('T')[0])} (access advantage)`,
      timeRange: config.booking.accessAdvantage.preferredTimeRange
    };
  }

  return null;
}

// ── Interval selection ────────────────────────────────────────────────────────
function getNextInterval(config, isBookingDay) {
  const intel = config.intelligence || {};
  if (isBookingDay) return (intel.surgeIntervalMinutes  || 3)  * 60 * 1000;
  return               (intel.normalIntervalMinutes     || 15) * 60 * 1000;
}

// ── Run check-availability.js as subprocess ───────────────────────────────────
function runAvailabilityCheck() {
  return new Promise((resolve, reject) => {
    log('Running availability check…');
    const proc = spawn('node', ['check-availability.js', '--headless'], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    proc.stdout.on('data', d => process.stdout.write(d));
    proc.stderr.on('data', d => process.stderr.write(d));

    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`check-availability.js exited with code ${code}`));
    });
  });
}

// ── Detect newly appeared slots since last snapshot ───────────────────────────
function detectNewSlots(results, lastSnapshot) {
  const newSlots = [];
  for (const r of results) {
    if (!r.slots?.length) continue;
    const key = `${r.clubName}::${r.date}`;
    const prev = lastSnapshot[key] || [];
    for (const slot of r.slots) {
      if (slot.slotsAvailable > 0 && !prev.includes(slot.display)) {
        newSlots.push({ club: r.clubName, date: r.date, time: slot.display, slots: slot.slotsAvailable });
      }
    }
  }
  return newSlots;
}

function buildSlotSnapshot(results) {
  const snap = {};
  for (const r of results) {
    const key = `${r.clubName}::${r.date}`;
    snap[key] = (r.slots || []).filter(s => s.slotsAvailable > 0).map(s => s.display);
  }
  return snap;
}

// ── 5-minute cancel window ────────────────────────────────────────────────────
async function waitForCancel(timeoutSec) {
  log(`Waiting ${timeoutSec / 60} minutes for cancellation…`);
  const end = Date.now() + timeoutSec * 1000;
  while (Date.now() < end) {
    if (fs.existsSync(CANCEL_FLAG)) {
      fs.unlinkSync(CANCEL_FLAG);
      log('Cancel flag detected — booking cancelled');
      return true;
    }
    if (!fs.existsSync(PENDING_FILE)) {
      log('Pending booking file removed — treating as cancel');
      return true;
    }
    await sleep(10000); // check every 10s
  }
  return false;
}

// ── Find best slot from availability results ──────────────────────────────────
function findBestSlot(results, isoDate, config, type) {
  const timeRange = type === 'homeClub'
    ? config.booking.homeClub.preferredTimeRange
    : config.booking.accessAdvantage?.preferredTimeRange || config.booking.homeClub.preferredTimeRange;

  const { earliestHour, latestHour } = timeRange;
  const numPlayers      = config.booking.numberOfPlayers || 2;
  const fallbackEnabled = config.booking.fallbackToEarliestAvailable !== false;

  // Club tier order from config (or fall back to home + fallbackClubs)
  const fallbackNames = config.fallbackClubs || [];
  const clubTiers     = config.booking.clubTiers || ['Laurel Springs Golf Club', ...fallbackNames];
  const getTier = (name) => {
    const idx = clubTiers.indexOf(name);
    return idx === -1 ? clubTiers.length : idx;
  };

  const candidates = []; // { clubName, slot, inWindow }

  for (const clubName of clubTiers) {
    const record = results.find(r => r.date === isoDate && r.clubName === clubName);
    if (!record?.slots?.length) continue;

    const eligible = record.slots.filter(s => s.slotsAvailable >= numPlayers);
    const inWindow = eligible.filter(s => s.hour >= earliestHour && s.hour <= latestHour);

    if (inWindow.length > 0) {
      candidates.push({ clubName, slot: inWindow[0], inWindow: true });
    } else if (eligible.length > 0 && fallbackEnabled) {
      // Track best fallback (earliest slot at this club)
      candidates.push({ clubName, slot: eligible[0], inWindow: false });
    }
  }

  if (candidates.length === 0) return null;

  // Sort: in-window first → then tier → then earliest time
  candidates.sort((a, b) => {
    if (a.inWindow !== b.inWindow) return a.inWindow ? -1 : 1;
    const tierDiff = getTier(a.clubName) - getTier(b.clubName);
    if (tierDiff !== 0) return tierDiff;
    return (a.slot.hour * 60 + a.slot.minutes) - (b.slot.hour * 60 + b.slot.minutes);
  });

  const winner = candidates[0];
  if (!winner.inWindow) {
    log(`⏱️  No in-window slots found — falling back to earliest available: ${winner.slot.display} at ${winner.clubName}`);
  }
  return { club: winner.clubName, slot: winner.slot, date: isoDate, inWindow: winner.inWindow };
}

// ── Get ordered club list for booking attempt ─────────────────────────────────
function getOrderedClubsForBooking(config) {
  const fallbackNames = config.fallbackClubs || [];
  const homeClub      = GA_CLUBS.find(c => c.home);
  const fallbacks     = fallbackNames
    .map(name => GA_CLUBS.find(c => c.name === name))
    .filter(Boolean);
  return [homeClub, ...fallbacks].filter(Boolean);
}

// ── Main agent cycle ──────────────────────────────────────────────────────────
async function runCycle(opts = {}) {
  const config  = loadConfig();
  const state   = loadState();
  const now     = new Date();
  const bookingTarget = getBookingTarget(now, config);
  const isBookingDay  = !!bookingTarget;
  const smsEnabled    = config.notifications?.sms !== false && notifyConfigured();

  log(`\n${'═'.repeat(55)}`);
  log(`Agent cycle — ${now.toLocaleString()}`);
  log(`Mode: ${isBookingDay ? `BOOKING DAY → ${bookingTarget.label}` : 'dashboard update'}`);
  log(`SMS: ${smsEnabled ? 'enabled' : 'not configured'}`);
  log('═'.repeat(55));

  // ── 1. Run availability check + update dashboard ─────────────────────────
  try {
    await runAvailabilityCheck();
  } catch (e) {
    log(`❌  Availability check failed: ${e.message}`);
    state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
    if (state.consecutiveFailures >= 3) {
      await sendSMS(`⚠️ Tee Time Agent: ${state.consecutiveFailures} consecutive check failures. Session may be expired — run 1-SETUP.command.`);
      state.consecutiveFailures = 0;
    }
    saveState(state);
    return getNextInterval(config, isBookingDay);
  }
  state.consecutiveFailures = 0;

  // ── 2. Read results + update history ────────────────────────────────────
  let results = [];
  try {
    const data = JSON.parse(fs.readFileSync(AVAILABILITY_FILE, 'utf8'));
    results = data.results || [];
    history.recordRun(results);
  } catch (e) {
    log(`⚠️  Could not read availability.json: ${e.message}`);
  }

  // ── 3. Notify on newly appeared slots ───────────────────────────────────
  if (config.notifications?.alertOnNewSlots && smsEnabled) {
    const newSlots = detectNewSlots(results, state.lastSlotSnapshot || {});
    if (newSlots.length > 0) {
      const msg = `⛳ New tee times:\n` +
        newSlots.slice(0, 5).map(s =>
          `  ${s.time} @ ${s.club.replace('Golf Club','').replace('Country Club','').trim()} (${formatDate(s.date)}, ${s.slots} spots)`
        ).join('\n');
      log(`New slots detected — sending SMS`);
      await sendSMS(msg);
    }
  }
  state.lastSlotSnapshot = buildSlotSnapshot(results);

  // ── 4. Booking logic (only on booking days) ──────────────────────────────
  if (isBookingDay || opts.forceBook) {
    const targetDate = opts.forceDate || bookingTarget?.isoDate;

    if (!targetDate) {
      log('Force book requested but no target date — pass --date YYYY-MM-DD');
      saveState(state);
      return getNextInterval(config, false);
    }

    // Skip if already booked this date
    if (state.lastBookedDate === targetDate) {
      log(`Already booked for ${targetDate} — skipping booking logic`);
      saveState(state);
      return getNextInterval(config, false);
    }

    // Find best slot in current results
    const bestSlot = findBestSlot(results, targetDate, config, bookingTarget?.type || 'homeClub');

    if (!bestSlot) {
      log(`No suitable slot yet for ${targetDate} — will retry`);
      saveState(state);
      return getNextInterval(config, isBookingDay);
    }

    const fallbackNote = bestSlot.inWindow === false ? '\n⚠️ Outside preferred time window (no in-window slots found).' : '';
    log(`\n🎯  Found slot: ${bestSlot.slot.display} at ${bestSlot.club} on ${formatDate(targetDate)}${bestSlot.inWindow === false ? ' (fallback — outside window)' : ''}`);

    // Pre-booking SMS + 5-min cancel window
    const cancelMinutes = config.notifications?.preBookingAlertMinutes || 5;
    const bookAt = new Date(Date.now() + cancelMinutes * 60000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    if (smsEnabled) {
      await sendSMS(
        `⛳ Tee Time Agent: Found ${bestSlot.slot.display} at ${bestSlot.club} for ${formatDate(targetDate)} (${bestSlot.slot.slotsAvailable} spots).${fallbackNote}\n` +
        `Auto-booking at ${bookAt}.\n` +
        `Run 5-CANCEL-BOOKING.command to stop.`
      );
    }

    // Write pending-booking.json
    fs.writeFileSync(PENDING_FILE, JSON.stringify({
      proposedAt: now.toISOString(),
      targetDate,
      club:  bestSlot.club,
      time:  bestSlot.slot.display,
      slots: bestSlot.slot.slotsAvailable
    }, null, 2));

    const cancelled = await waitForCancel(cancelMinutes * 60);
    if (fs.existsSync(PENDING_FILE)) fs.unlinkSync(PENDING_FILE);

    if (cancelled) {
      log('Booking cancelled — continuing normal operation');
      if (smsEnabled) await sendSMS('✅ Tee time booking cancelled.');
      saveState(state);
      return getNextInterval(config, false);
    }

    // ── Execute booking ────────────────────────────────────────────────────
    log('\nExecuting booking…');
    const orderedClubs = getOrderedClubsForBooking(config);
    // Prioritize the club we found the slot at
    const reorderedClubs = [
      orderedClubs.find(c => c.name === bestSlot.club),
      ...orderedClubs.filter(c => c.name !== bestSlot.club)
    ].filter(Boolean);

    const result = await bookTeeTime({
      isoDate: targetDate,
      clubs:   reorderedClubs,
      headless: true,
      skipExistingCheck: false
    });

    if (result.success) {
      log(`\n✅  BOOKED: ${result.slot.display} at ${result.club}`);
      state.lastBookedDate = targetDate;
      if (smsEnabled) {
        await sendSMS(
          `✅ Booked! ${result.slot.display} at ${result.club}\n` +
          `${formatDate(targetDate)} · ${config.booking.numberOfPlayers} players\n` +
          `Check debug-confirmation.png for receipt.`
        );
      }
      saveState(state);
      return getNextInterval(config, false); // slow down — booking made
    }

    if (result.alreadyBooked) {
      log('Already booked for this date');
      state.lastBookedDate = targetDate;
      saveState(state);
      return getNextInterval(config, false);
    }

    log(`❌  Booking failed: ${result.error}`);
    if (smsEnabled) {
      await sendSMS(`❌ Booking failed: ${result.error}\nRun 5-BOOK-NOW.command to try again manually.`);
    }
    saveState(state);
    return getNextInterval(config, isBookingDay); // keep trying on booking day
  }

  saveState(state);
  return getNextInterval(config, false);
}

// ── Continuous loop ───────────────────────────────────────────────────────────
async function main() {
  const args        = process.argv.slice(2);
  const forceBook   = args.includes('--force-book');
  const checkOnly   = args.includes('--check-only');
  const dateIdx     = args.indexOf('--date');
  const forceDate   = dateIdx !== -1 ? args[dateIdx + 1] : null;

  log('🏌️  Tee Time Agent started');
  log(`   SMS: ${notifyConfigured() ? 'configured ✅' : 'not configured (add Twilio to config.json)'}`);
  log(`   History: ${require('./history').getSummary().split('\n').length} clubs tracked`);
  if (forceBook) log(`   FORCE BOOK mode${forceDate ? ' for ' + forceDate : ''}`);
  if (checkOnly) log('   CHECK ONLY mode — single run, then exit');

  if (checkOnly) {
    await runCycle({ forceBook: false });
    log('Check-only run complete — exiting');
    process.exit(0);
  }

  if (forceBook) {
    const result = await runCycle({ forceBook: true, forceDate });
    process.exit(result > 0 ? 0 : 1);
  }

  // Continuous loop
  while (true) {
    let nextMs;
    try {
      nextMs = await runCycle({});
    } catch (err) {
      log(`❌  Unhandled error in cycle: ${err.message}`);
      nextMs = 5 * 60 * 1000; // retry in 5 min on unexpected error
    }

    const nextRun = new Date(Date.now() + nextMs);
    log(`\nNext run at ${nextRun.toLocaleTimeString()} (in ${Math.round(nextMs / 60000)} min)`);
    await sleep(nextMs);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
