/**
 * scripts/onboard-user.js — CLI tool to manually add a user
 *
 * Use this during beta when you are onboarding users concierge-style
 * (i.e., before the self-serve signup form is wired up to the server).
 *
 * Usage:
 *   node scripts/onboard-user.js
 *
 * It will prompt for all required fields, encrypt credentials,
 * and write the user to Supabase.
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const readline = require('readline');
const { onboardUser } = require('../user-runner');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, res));

async function main() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║  ClubCompanion — Onboard New User   ║');
  console.log('╚══════════════════════════════════════╝\n');

  const email    = await ask('Email: ');
  const name     = await ask('Full name: ');
  const phone    = await ask('Phone (for SMS, leave blank to skip): ');
  const plan     = ((await ask('Plan [starter/member/concierge] (default: member): ')) || 'member').toLowerCase().trim();
  const username = await ask('\nInvited Clubs username: ');
  const password = await ask('Invited Clubs password: ');

  console.log('\n── Club preferences ──');
  const homeClub   = await ask('Home club name (default: Laurel Springs Golf Club): ') || 'Laurel Springs Golf Club';
  const targetDay  = await ask('Target day (default: Saturday): ') || 'Saturday';
  const earliest   = parseInt(await ask('Earliest hour 0–23 (default: 6): ') || '6', 10);
  const latest     = parseInt(await ask('Latest hour 0–23 (default: 11): ') || '11', 10);
  const numPlayers = parseInt(await ask('Number of players (default: 2): ') || '2', 10);

  console.log('\n── Guest 1 ──');
  const g1First = await ask('First name: ');
  const g1Last  = await ask('Last name: ');
  const g1Phone = await ask('Phone (optional): ');

  rl.close();

  console.log('\nCreating user...');
  try {
    const user = await onboardUser({
      email, name, phone: phone || null, plan,
      username, password,
      configData: {
        home_club_name:            homeClub,
        home_club_target_day:      targetDay,
        home_club_days_in_advance: 6,
        home_earliest_hour:        earliest,
        home_latest_hour:          latest,
        aa_enabled:                false,
        aa_target_day:             'Sunday',
        aa_earliest_hour:          6,
        aa_latest_hour:            9,
        number_of_players:         numPlayers,
        fallback_to_earliest:      true,
      },
      playersData: g1First ? [{ slotIndex: 1, firstName: g1First, lastName: g1Last, phone: g1Phone || null }] : []
    });

    console.log(`\n✅ User created successfully!`);
    console.log(`   ID:    ${user.id}`);
    console.log(`   Email: ${user.email}`);
    console.log(`   Plan:  ${user.plan}`);
    console.log('\nThe agent will pick up this user on the next scheduler run.\n');
  } catch (err) {
    console.error('\n❌ Onboarding failed:', err.message);
    process.exit(1);
  }
}

main().catch(console.error);
