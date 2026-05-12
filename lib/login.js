/**
 * lib/login.js — Automated Invited Clubs portal login
 *
 * Uses a broad approach: finds all visible inputs on the login page,
 * fills the first text/email input with username and the password input
 * with password. Robust against different portal form structures.
 */

'use strict';

const BASE_URL  = 'https://apps.invitedclubs.com/portal/pls/portal/!CCTTWEB.controller';
const LOGIN_URL = 'https://members.invitedclubs.com/club/scripts/login/login.asp';

async function loginToPortal(chromium, username, password) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  // ── Step 1: Load login page ─────────────────────────────────────────────
  console.log('[login] Loading login page...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // ── Step 2: Fill login form ─────────────────────────────────────────────
  // Confirmed field names from live portal inspection:
  //   username: input[name="user"]
  //   password: input[name="pw"]
  // The page also has a signup form (NEW_CLUBMEMNUM etc.) — target login form specifically.

  // Click the username field first to ensure focus is in the login form
  await page.click('input[name="user"]');
  await page.type('input[name="user"]', username, { delay: 50 });
  console.log('[login] Typed username');

  await page.click('input[name="pw"]');
  await page.type('input[name="pw"]', password, { delay: 50 });
  console.log('[login] Typed password');

  // ── Step 3: Submit — press Enter on the password field ──────────────────
  // Using keyboard Enter is more reliable than clicking submit for JS-driven forms
  // 'load' instead of 'networkidle' — mylocker.asp makes background requests
  // that prevent networkidle from ever firing, causing a 30s timeout.
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }),
    page.keyboard.press('Enter')
  ]);

  console.log('[login] Post-submit URL:', page.url());

  const postUrl = page.url();
  if (postUrl.includes('login') || postUrl.includes('signup')) {
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 400) || '').catch(() => '');
    console.error('[login] Login failed. URL:', postUrl);
    console.error('[login] Page text:', bodyText);
    throw new Error(`Login failed — portal rejected credentials. URL: ${postUrl}`);
  }

  // ── Step 6: Find member ID ──────────────────────────────────────────────
  let memberId = null;

  // Try finding it from tee time links
  const teeLinks = await page.$$('a[href*="apps.invitedclubs.com"]');
  for (const link of teeLinks) {
    const href = await link.getAttribute('href') || '';
    const m = href.match(/ID=([a-f0-9]{32})/i);
    if (m) { memberId = m[1]; break; }
  }

  // Fallback: check page source
  if (!memberId) {
    const src = await page.content();
    const m = src.match(/ID=([a-f0-9]{32})/i);
    if (m) memberId = m[1];
  }

  if (!memberId) {
    throw new Error('Logged in but could not find member ID. Portal structure may have changed.');
  }

  const portalUrl = `${BASE_URL}?ID=${memberId}`;

  // ── Step 7: Navigate to tee time portal ────────────────────────────────
  console.log(`[login] Navigating to portal — member ID: ${memberId.slice(0, 8)}...`);
  // Use 'load' — portal SPA makes continuous background requests, networkidle never fires
  await page.goto(portalUrl, { waitUntil: 'load', timeout: 30000 });

  // Wait for the portal content iframe to populate
  await page.waitForFunction(
    () => { const c = document.getElementById('cc_web_content'); return c && c.innerHTML.trim().length > 200; },
    { timeout: 20000 }
  ).catch(() => {});

  // Dismiss home club selection screen if present
  const hasSelectionScreen = await page.evaluate(() => !!document.getElementById('home_club')).catch(() => false);
  if (hasSelectionScreen) {
    await page.evaluate(() => { document.getElementById('home_club')?.click(); }).catch(() => {});
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    console.log('[login] Dismissed home club selection screen');
  }

  const cookies = await context.cookies();
  console.log(`[login] ✅ Portal session established`);

  return { browser, context, page, memberId, portalUrl, cookies };
}

module.exports = { loginToPortal };
