/**
 * scripts/trigger-booking.js — Manually trigger a booking run
 *
 * Runs the full booking flow for all active users right now,
 * regardless of the scheduled window. Use this to test or
 * to manually trigger a booking outside the normal Sunday window.
 *
 * Usage (local):
 *   node scripts/trigger-booking.js
 *
 * Usage (Railway console):
 *   node scripts/trigger-booking.js
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const db           = require('../db/client');
const { runForUser } = require('../user-runner');

// Find the next upcoming Saturday (or whatever day, ≥1 day from now)
function nextUpcomingDay(dayName) {
  const days = { Sunday:0, Monday:1, Tuesday:2, Wednesday:3, Thursday:4, Friday:5, Saturday:6 };
  const target = days[dayName] ?? 6;
  const d = new Date();
  d.setDate(d.getDate() + 1); // start from tomorrow
  while (d.getDay() !== target) d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

async function main() {
  // Allow: node trigger-booking.js --date 2026-05-16
  const dateArgIdx = process.argv.indexOf('--date');
  const targetDate = dateArgIdx !== -1 && process.argv[dateArgIdx + 1]
    ? process.argv[dateArgIdx + 1]
    : nextUpcomingDay('Saturday');

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║  Club Concierge — Manual Booking Run  ║');
  console.log('╚══════════════════════════════════════╝\n');
  console.log(`  Target date: ${targetDate}\n`);

  const { data: users, error } = await db.getAllActiveUsers();
  if (error) { console.error('❌ Could not fetch users:', error.message); process.exit(1); }
  if (!users?.length) { console.log('No active users found.'); process.exit(0); }

  console.log(`Found ${users.length} active user(s):\n`);
  users.forEach(u => console.log(`  • ${u.email}`));
  console.log('');

  for (const user of users) {
    console.log(`\n─── Running booking for ${user.email} ───`);
    try {
      const result = await runForUser(user.id, 'booking', { targetDate });
      if (result.success) {
        console.log(`\n✅ SUCCESS`);
        console.log(`   Club: ${result.booking?.club}`);
        console.log(`   Date: ${result.booking?.date}`);
        console.log(`   Time: ${result.booking?.slot?.display}`);
      } else {
        console.log(`\n⚠️  No booking made: ${result.error || result.reason}`);
      }
    } catch (err) {
      console.error(`\n❌ Error for ${user.email}:`, err.message);
    }
  }

  console.log('\n─── Done ───\n');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
