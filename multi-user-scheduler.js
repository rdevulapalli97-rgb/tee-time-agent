/**
 * multi-user-scheduler.js — Production scheduler for all Club Concierge users
 *
 * This is the main entry point for the cloud server. It runs continuously,
 * waking up on a configurable interval to:
 *   1. Load all active users from Supabase
 *   2. Determine which users need an availability check vs. a booking run
 *   3. Run each user's job in parallel (with isolation and error containment)
 *   4. Sleep until the next interval
 *
 * Booking logic:
 *   - Saturday home-club booking:   Opens Sunday at 7am (6 days in advance)
 *   - Sunday Access Advantage:      Opens Monday at 7am
 *   - Between booking windows:      Availability check every 15 minutes
 *   - On booking day window:         More frequent checks (every 5 min)
 *
 * Run with:
 *   node multi-user-scheduler.js
 *
 * On Railway/Render:
 *   Set START_COMMAND=node multi-user-scheduler.js in your deployment config
 */

'use strict';

require('dotenv').config();
const cron   = require('node-cron');
const db     = require('./db/client');
const { runForUser } = require('./user-runner');
const { slackAlert } = require('./lib/notify');

// ─── Config ───────────────────────────────────────────────────
const AVAILABILITY_INTERVAL_MIN = parseInt(process.env.AVAIL_INTERVAL_MIN  || '15', 10);
const BOOKING_DAY_INTERVAL_MIN  = parseInt(process.env.BOOKING_INTERVAL_MIN || '5', 10);
const MAX_CONCURRENT_USERS      = parseInt(process.env.MAX_CONCURRENT      || '5',  10);

// ─── State ────────────────────────────────────────────────────
const runningUsers = new Set();   // prevent overlapping runs per user
let totalRuns = 0;
let startTime = Date.now();

// ─── Helpers ──────────────────────────────────────────────────

function log(msg) {
  console.log(`[scheduler ${new Date().toISOString()}] ${msg}`);
}

/**
 * Determine if right now is within the booking window for a user's config.
 * Booking window = within 30 minutes of when the portal opens.
 */
function isBookingWindow(configRow) {
  const now     = new Date();
  const dayOfWeek = now.getDay();  // 0=Sun, 1=Mon, ..., 6=Sat
  const hour    = now.getHours();
  const minute  = now.getMinutes();
  const nowMin  = hour * 60 + minute;

  // Sunday 7am = booking window for Saturday tee times (6 days advance)
  const homeBookingDay  = 0;   // Sunday
  const homeBookingHour = 7;

  // Monday 7am = booking window for Sunday Access Advantage
  const aaBookingDay  = 1;   // Monday
  const aaBookingHour = 7;

  const windowStart = homeBookingHour * 60;   // 7:00am in minutes
  const windowEnd   = windowStart + 60;       // 8:00am — 1 hour window

  if (dayOfWeek === homeBookingDay && nowMin >= windowStart && nowMin < windowEnd) {
    return { active: true, type: 'home_club' };
  }
  if (configRow.aa_enabled && dayOfWeek === aaBookingDay && nowMin >= windowStart && nowMin < windowEnd) {
    return { active: true, type: 'access_advantage' };
  }
  return { active: false };
}

/**
 * Process one user — wrapped so errors are always caught.
 */
async function processUser(user) {
  if (runningUsers.has(user.id)) {
    log(`Skipping ${user.email} — already running`);
    return;
  }

  runningUsers.add(user.id);
  try {
    const { data: configRow } = await db.getUserConfig(user.id);
    if (!configRow) {
      log(`⚠️  No config for ${user.email} — skipping`);
      return;
    }

    const window = isBookingWindow(configRow);

    if (window.active) {
      log(`🏌️ BOOKING window active for ${user.email} (${window.type})`);
      await runForUser(user.id, 'booking');
    } else {
      await runForUser(user.id, 'availability_check');
    }

  } catch (err) {
    log(`❌ Unhandled error for ${user.email}: ${err.message}`);
    await slackAlert(`🚨 Unhandled scheduler error\nUser: ${user.email}\nError: ${err.message}`).catch(() => {});
  } finally {
    runningUsers.delete(user.id);
  }
}

/**
 * Process all active users in batches to avoid overwhelming the server.
 */
async function runAllUsers(label = 'scheduled') {
  totalRuns++;
  log(`--- Run #${totalRuns} (${label}) ---`);

  const { data: users, error } = await db.getAllActiveUsers();
  if (error) {
    log(`❌ Failed to fetch users: ${error.message}`);
    await slackAlert(`🚨 Scheduler could not fetch users: ${error.message}`).catch(() => {});
    return;
  }

  if (!users || users.length === 0) {
    log('No active users found');
    return;
  }

  log(`Processing ${users.length} active user(s)...`);

  // Batch users to limit concurrency
  for (let i = 0; i < users.length; i += MAX_CONCURRENT_USERS) {
    const batch = users.slice(i, i + MAX_CONCURRENT_USERS);
    await Promise.all(batch.map(user => processUser(user)));
  }

  log(`--- Run #${totalRuns} complete ---\n`);
}

// ─── Cron schedules ───────────────────────────────────────────
//
//  We use two schedules:
//    1. Every 5 minutes during the booking windows (Sun & Mon 7–8am)
//    2. Every 15 minutes at all other times
//
//  node-cron syntax: second minute hour day month weekday

// Every 15 minutes — availability checks throughout the week
cron.schedule('*/15 * * * *', () => {
  runAllUsers('15-min interval').catch(err => log(`❌ Cron error: ${err.message}`));
});

// Every 5 minutes on Sunday 7–8am — home club booking window
cron.schedule('*/5 7 * * 0', () => {
  runAllUsers('Sunday booking window').catch(err => log(`❌ Cron error: ${err.message}`));
});

// Every 5 minutes on Monday 7–8am — Access Advantage booking window
cron.schedule('*/5 7 * * 1', () => {
  runAllUsers('Monday AA booking window').catch(err => log(`❌ Cron error: ${err.message}`));
});

// ─── Health check HTTP endpoint ───────────────────────────────
// Railway / Render use this to confirm the process is alive
const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    const { data: users } = await db.getAllActiveUsers().catch(() => ({ data: [] }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:       'ok',
      uptime_s:     Math.floor((Date.now() - startTime) / 1000),
      total_runs:   totalRuns,
      active_users: (users || []).length,
      running_now:  runningUsers.size,
      timestamp:    new Date().toISOString()
    }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  log(`✅ Club Concierge scheduler started on port ${PORT}`);
  log(`   Availability checks: every ${AVAILABILITY_INTERVAL_MIN} min`);
  log(`   Booking window:      every ${BOOKING_DAY_INTERVAL_MIN} min (Sun/Mon 7–8am)`);
  log(`   Max concurrent:      ${MAX_CONCURRENT_USERS} users`);

  // Run once immediately on startup (catches any missed windows)
  runAllUsers('startup').catch(err => log(`❌ Startup run error: ${err.message}`));
});

// ─── Graceful shutdown ────────────────────────────────────────
process.on('SIGTERM', () => {
  log('SIGTERM received — shutting down gracefully...');
  server.close(() => {
    log('Server closed. Exiting.');
    process.exit(0);
  });
});

process.on('uncaughtException', async (err) => {
  log(`💥 Uncaught exception: ${err.message}`);
  await slackAlert(`💥 Scheduler crash\n\`${err.message}\`\n\`\`\`${err.stack?.slice(0, 500)}\`\`\``).catch(() => {});
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  log(`⚠️  Unhandled rejection: ${reason}`);
  await slackAlert(`⚠️ Unhandled rejection in scheduler\n\`${reason}\``).catch(() => {});
});
