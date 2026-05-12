/**
 * setup-login.js
 *
 * Run ONCE to save your Invited Clubs login session.
 * A browser window will open — log in, then press Enter.
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const readline = require('readline');

const SESSION_FILE = path.join(__dirname, 'session.json');
const LOGIN_URL    = 'https://members.invitedclubs.com/club/scripts/login/login.asp';

async function setupLogin() {
  console.log('');
  console.log('='.repeat(60));
  console.log('  Invited Clubs — One-Time Login Setup');
  console.log('='.repeat(60));
  console.log('');
  console.log('A browser window will open. Please:');
  console.log('  1. Log in to your Invited Clubs account');
  console.log('  2. Make sure you reach the HOME PAGE');
  console.log('  3. Come back here and press Enter');
  console.log('');

  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context  = await browser.newContext({ viewport: null });
  const page     = await context.newPage();

  await page.goto(LOGIN_URL);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => rl.question('\nPress Enter once you are on the home page... ', () => { rl.close(); resolve(); }));

  const currentUrl = page.url();
  if (currentUrl.includes('login')) {
    console.log('\n⚠️  Still looks like the login page — make sure you completed login.');
  }

  // Find the member ID from the "Book A Tee Time" link
  let memberId = null;
  const teeLinks = await page.$$('a[href*="apps.invitedclubs.com"]');
  for (const link of teeLinks) {
    const href = await link.getAttribute('href') || '';
    const m = href.match(/ID=([a-f0-9]{32})/i);
    if (m) { memberId = m[1]; break; }
  }

  // Navigate all the way to the home club tee time view so that
  // LOC and ENTITY cookies are saved in the correct state.
  if (memberId) {
    console.log(`\n✅  Found member ID: ${memberId.slice(0, 8)}...`);
    console.log('    Opening tee time portal...');
    try {
      const portalUrl = `https://apps.invitedclubs.com/portal/pls/portal/!CCTTWEB.controller?ID=${memberId}`;

      // Step 1: load portal entry (establishes apps session)
      await page.goto(portalUrl, { waitUntil: 'networkidle', timeout: 25000 });

      // Step 2: wait for modal AJAX content to appear
      await page.waitForFunction(
        () => { const c = document.getElementById('cc_web_content'); return c && c.innerHTML.trim().length > 200; },
        { timeout: 15000 }
      ).catch(() => {});

      // Step 3: if on the selection screen, navigate to home club tee times
      // Use window.location.href (in-page navigation) — same as clicking #home_club
      const hasSelectionScreen = await page.evaluate(() => !!document.getElementById('home_club'));
      if (hasSelectionScreen) {
        console.log('    Selection screen found — navigating to home club tee times...');
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {}),
          page.evaluate(() => {
            window.location.href = '/portal/pls/portal/!CCTTWEB.controller?EVENT=HASH&ACT=VIEW&LOC=CONT';
          })
        ]);
      }

      // Step 4: wait for date tabs to confirm we reached the tee time view
      await page.waitForFunction(
        () => !!document.querySelector('div[id^="Tab-2"]'),
        { timeout: 15000 }
      ).catch(() => {});

      const hasTabs = await page.evaluate(() => !!document.querySelector('div[id^="Tab-2"]'));
      if (hasTabs) {
        console.log('    ✅  Tee time tabs confirmed — LOC/ENTITY cookies captured correctly.');
      } else {
        console.log('    ⚠️  Tee time tabs not found. Session saved anyway — try re-running setup.');
      }
      await page.waitForTimeout(1000);

    } catch (e) {
      console.log('    (portal navigation error — continuing anyway):', e.message.slice(0, 80));
    }
  } else {
    console.log('\n⚠️  Could not find member ID automatically.');
    console.log('    The booking scripts will use the default ID from the config.');
  }

  // Save all cookies from all domains
  const cookies = await context.cookies();
  const session = {
    savedAt: new Date().toISOString(),
    memberId: memberId || null,
    cookies
  };

  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  console.log(`\n✅  Session saved to: session.json`);
  console.log(`    Cookies captured: ${cookies.length}`);
  if (memberId) console.log(`    Member ID saved: ${memberId.slice(0, 8)}...`);

  await browser.close();
}

setupLogin().catch(err => { console.error('Error:', err); process.exit(1); });
