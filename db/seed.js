/**
 * db/seed.js — Seed Rohit as a test user
 *
 * Run once after setting up your Supabase database:
 *   node db/seed.js
 *
 * This creates a full test user so you can immediately verify
 * the stack end-to-end without going through the signup form.
 * The test user uses FAKE credentials — update them with your
 * real Invited Clubs login before the first live booking run.
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const db = require('./client');
const { packCredentials, selfTest } = require('../lib/encrypt');

async function seed() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   ClubCompanion — Database Seed     ║');
  console.log('╚══════════════════════════════════════╝\n');

  // Verify encryption is working before writing anything
  console.log('Verifying encryption...');
  const encOk = selfTest();
  if (!encOk) { console.error('❌ Encryption self-test failed — check ENCRYPTION_KEY in .env'); process.exit(1); }

  // ── 1. Upsert primary user ────────────────────────────────────
  console.log('\nCreating test user (Rohit)...');
  const { data: existing } = await db.getUserByEmail('rdevulapalli97@gmail.com');

  let userId;
  if (existing) {
    console.log('  User already exists, updating...');
    await db.updateUser(existing.id, { name: 'Rohit Devulapalli', plan: 'concierge', active: true });
    userId = existing.id;
  } else {
    const { data: user, error } = await db.createUser({
      email: 'rdevulapalli97@gmail.com',
      name:  'Rohit Devulapalli',
      phone: '',  // Add your real phone number here
      plan:  'concierge'
    });
    if (error) { console.error('❌ Failed to create user:', error.message); process.exit(1); }
    userId = user.id;
    console.log(`  Created user: ${userId}`);
  }

  // ── 2. Encrypt and store credentials ──────────────────────────
  console.log('\nStoring encrypted credentials (PLACEHOLDER — update before live runs)...');
  const packed = packCredentials(
    'YOUR_INVITED_CLUBS_USERNAME',  // ← Replace with real credentials
    'YOUR_INVITED_CLUBS_PASSWORD'   // ← Replace with real credentials
  );
  const { error: credError } = await db.upsertCredentials({ userId, ...packed });
  if (credError) { console.error('❌ Failed to store credentials:', credError.message); process.exit(1); }
  console.log('  ✅ Credentials encrypted and stored');

  // ── 3. User config ────────────────────────────────────────────
  console.log('\nStoring booking config...');
  const { error: confError } = await db.upsertUserConfig(userId, {
    home_club_name:            'Laurel Springs Golf Club',
    home_club_target_day:      'Saturday',
    home_club_days_in_advance: 6,
    home_earliest_hour:        6,
    home_latest_hour:          11,
    aa_enabled:                true,
    aa_target_day:             'Sunday',
    aa_earliest_hour:          6,
    aa_latest_hour:            9,
    aa_preferred_clubs:        [],
    number_of_players:         2,
    fallback_to_earliest:      true,
    club_tiers: [
      'Laurel Springs Golf Club',
      'Atlanta National Golf Club',
      'Eagle Watch Golf Club',
      'Polo Golf & Country Club',
      'Brookstone Golf & Country Club',
      'Brookfield Country Club',
      'The Clubs of Peachtree City',
      'Windermere Golf Club'
    ],
    home_club_cron: '0 7 * * 0',
    aa_cron:        '0 7 * * 1',
  });
  if (confError) { console.error('❌ Failed to store config:', confError.message); process.exit(1); }
  console.log('  ✅ Config stored');

  // ── 4. Guest players ──────────────────────────────────────────
  console.log('\nStoring guest players (placeholders)...');
  const guests = [
    { slotIndex: 1, firstName: 'GUEST1_FIRST', lastName: 'GUEST1_LAST', phone: '' },
    { slotIndex: 2, firstName: 'GUEST2_FIRST', lastName: 'GUEST2_LAST', phone: '' },
    { slotIndex: 3, firstName: 'GUEST3_FIRST', lastName: 'GUEST3_LAST', phone: '' },
  ];
  for (const g of guests) {
    const { error } = await db.upsertPlayer({ userId, ...g });
    if (error) console.warn(`  ⚠️  Player ${g.slotIndex} failed:`, error.message);
  }
  console.log('  ✅ Guest players stored');

  // ── 5. Seed a sample booking for the admin dashboard ──────────
  console.log('\nSeeding sample booking history...');
  const sampleBookings = [
    { clubName: 'Laurel Springs Golf Club', bookingDate: '2026-05-03', teeTime: '7:30 AM', teeTimeHour: 7, numPlayers: 2, bookingType: 'home_club', inPreferredWindow: true },
    { clubName: 'Atlanta National Golf Club', bookingDate: '2026-04-27', teeTime: '8:00 AM', teeTimeHour: 8, numPlayers: 2, bookingType: 'access_advantage', inPreferredWindow: true },
    { clubName: 'Laurel Springs Golf Club', bookingDate: '2026-04-19', teeTime: '9:06 AM', teeTimeHour: 9, numPlayers: 2, bookingType: 'home_club', inPreferredWindow: true },
    { clubName: 'Eagle Watch Golf Club', bookingDate: '2026-04-13', teeTime: '6:48 AM', teeTimeHour: 6, numPlayers: 2, bookingType: 'access_advantage', inPreferredWindow: true },
  ];
  for (const b of sampleBookings) {
    await db.recordBooking({ userId, ...b }).catch(e => console.warn('  Sample booking:', e.message));
  }
  console.log('  ✅ Sample bookings seeded');

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  Seed complete!                                      ║');
  console.log('║                                                      ║');
  console.log('║  Next steps:                                         ║');
  console.log('║  1. Update credentials in Supabase directly, or      ║');
  console.log('║     re-run: node scripts/onboard-user.js             ║');
  console.log('║  2. Start the scheduler: node multi-user-scheduler.js║');
  console.log('║  3. Visit /admin to see your dashboard               ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
}

seed().catch(err => {
  console.error('\n❌ Seed failed:', err.message);
  process.exit(1);
});
