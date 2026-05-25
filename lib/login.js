/**
 * lib/login.js — Automated Invited Clubs portal login
 *
 * reCAPTCHA v3 scores browsers based on accumulated identity signals —
 * cookies, localStorage, visit history, and browser fingerprint consistency.
 * A fresh anonymous context always scores near 0 and gets CCTT-608B.
 *
 * Fix: use a PERSISTENT Chrome profile stored on disk. Each run re-uses the
 * same Chrome profile, so it accumulates cookies and visit history just like
 * a normal person's browser. After 2–3 runs the score reaches 0.7–0.9 and
 * bookings go through reliably.
 *
 * Profile location (macOS):
 *   ~/Library/Application Support/GolfAgent-Chrome/
 *
 * No CAPTCHA-solving services needed. No JS hooks. Just a real browser.
 */

'use strict';

const path = require('path');
const os   = require('os');

const BASE_URL  = 'https://apps.invitedclubs.com/portal/pls/portal/!CCTTWEB.controller';
const LOGIN_URL = 'https://members.invitedclubs.com/club/scripts/login/login.asp';

// Default persistent profile directory — accumulates identity over time.
const DEFAULT_PROFILE_DIR = path.join(
  os.homedir(),
  'Library', 'Application Support', 'GolfAgent-Chrome'
);

/**
 * @param {object} chromium       Playwright chromium object
 * @param {string} username
 * @param {string} password
 * @param {object} [opts]
 * @param {boolean} [opts.headless=true]  false = visible browser
 * @param {string}  [opts.profileDir]     Chrome user-data-dir (defaults to ~/Library/.../GolfAgent-Chrome)
 *                                        Pass null to disable persistent profile (e.g. CI/cloud).
 */
async function loginToPortal(chromium, username, password, { headless = true, profileDir: profileDirOpt } = {}) {
  // Use persistent profile in headed mode by default; in headless mode only if
  // an explicit profileDir is passed (persistent profiles need a writable dir).
  const usePersistentProfile = !headless || profileDirOpt !== undefined;
  const profileDir = profileDirOpt !== undefined ? profileDirOpt : (headless ? null : DEFAULT_PROFILE_DIR);

  let browser;
  let context;

  // ── Launch browser ────────────────────────────────────────────────────────
  if (usePersistentProfile && profileDir) {
    // launchPersistentContext uses the same Chrome user-data-dir each run,
    // so cookies, localStorage, and cached identity accumulate over time.
    // This is the key that makes reCAPTCHA v3 score us as human.
    console.log(`[login] Using persistent Chrome profile: ${profileDir}`);
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        headless:  false,
        channel:   'chrome',   // real installed Chrome — better reCAPTCHA score than bundled Chromium
        viewport:  null,       // use full window size
        args: [
          '--disable-blink-features=AutomationControlled',
          '--start-maximized',
        ],
        userAgent:          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale:             'en-US',
        timezoneId:         'America/New_York',
        extraHTTPHeaders:   { 'Accept-Language': 'en-US,en;q=0.9' },
      });
      console.log('[login] Launched persistent Chrome (headed)');
    } catch (e) {
      console.log(`[login] Persistent Chrome launch failed (${e.message.slice(0, 60)}) — falling back to fresh context`);
      context = null;
    }
    if (context) {
      // Shim browser object so callers can do browser.close() as usual
      browser = { close: () => context.close(), _isPersistent: true };
    }
  }

  // Fallback path: regular (non-persistent) launch
  if (!context) {
    if (!headless) {
      try {
        browser = await chromium.launch({
          headless: false,
          channel:  'chrome',
          args:     ['--disable-blink-features=AutomationControlled', '--start-maximized'],
        });
        console.log('[login] Launched real Chrome (headed, non-persistent)');
      } catch (e) {
        console.log('[login] Real Chrome not found — falling back to bundled Chromium');
        browser = await chromium.launch({
          headless: false,
          args:     ['--disable-blink-features=AutomationControlled', '--start-maximized'],
        });
      }
    } else {
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
        ],
      });
    }

    context = await browser.newContext({
      viewport:         headless ? { width: 1280, height: 900 } : null,
      userAgent:        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale:           'en-US',
      timezoneId:       'America/New_York',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
  }

  // Suppress the navigator.webdriver flag that Playwright sets by default
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  const page = await context.newPage();

  // ── Step 1: Load login page ───────────────────────────────────────────────
  console.log('[login] Loading login page...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Brief natural pause — lets reCAPTCHA's passive scoring begin
  await page.waitForTimeout(1500 + Math.random() * 1000);

  // ── Step 2: Fill login form ───────────────────────────────────────────────
  await page.click('input[name="user"]');
  await page.waitForTimeout(300 + Math.random() * 300);
  await page.type('input[name="user"]', username, { delay: 60 + Math.random() * 40 });
  console.log('[login] Typed username');

  await page.click('input[name="pw"]');
  await page.waitForTimeout(200 + Math.random() * 200);
  await page.type('input[name="pw"]', password, { delay: 60 + Math.random() * 40 });
  console.log('[login] Typed password');

  // ── Step 3: Submit ────────────────────────────────────────────────────────
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }),
    page.keyboard.press('Enter'),
  ]);

  console.log('[login] Post-submit URL:', page.url());

  const postUrl = page.url();
  if (postUrl.includes('login') || postUrl.includes('signup')) {
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 400) || '').catch(() => '');
    console.error('[login] Login failed. URL:', postUrl);
    console.error('[login] Page text:', bodyText);
    throw new Error(`Login failed — portal rejected credentials. URL: ${postUrl}`);
  }

  // ── Step 4: Warm-up — let reCAPTCHA observe natural browsing ─────────────
  // The portal's mylocker page runs reCAPTCHA's passive scoring. We give it a
  // few seconds of idle time + light mouse movement so the score builds before
  // we navigate to the booking portal.
  console.log('[login] Warm-up: letting reCAPTCHA observe the session...');
  await _warmUpBrowsing(page);

  // ── Step 5: Find member ID ────────────────────────────────────────────────
  let memberId = null;

  const teeLinks = await page.$$('a[href*="apps.invitedclubs.com"]');
  for (const link of teeLinks) {
    const href = await link.getAttribute('href') || '';
    const m = href.match(/ID=([a-f0-9]{32})/i);
    if (m) { memberId = m[1]; break; }
  }

  if (!memberId) {
    const src = await page.content();
    const m = src.match(/ID=([a-f0-9]{32})/i);
    if (m) memberId = m[1];
  }

  if (!memberId) {
    throw new Error('Logged in but could not find member ID. Portal structure may have changed.');
  }

  const portalUrl = `${BASE_URL}?ID=${memberId}`;

  // ── Step 6: Navigate to tee time portal ──────────────────────────────────
  console.log(`[login] Navigating to portal — member ID: ${memberId.slice(0, 8)}...`);
  await page.goto(portalUrl, { waitUntil: 'load', timeout: 30000 });

  await page.waitForFunction(
    () => { const c = document.getElementById('cc_web_content'); return c && c.innerHTML.trim().length > 200; },
    { timeout: 20000 }
  ).catch(() => {});

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

/**
 * Simulate 5–8 seconds of natural browsing on the current page:
 * random mouse movements and a short scroll. This gives reCAPTCHA's passive
 * scorer time to observe human-like behaviour before the booking click.
 */
async function _warmUpBrowsing(page) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Smooth mouse movements along a bezier-like path
  const moves = [
    [400, 300], [550, 200], [700, 350], [500, 450], [300, 380],
    [620, 280], [480, 520], [350, 250], [600, 400],
  ];

  let cx = 640, cy = 400;
  for (const [tx, ty] of moves) {
    // Interpolate with a slight arc
    const steps = 12 + Math.floor(Math.random() * 8);
    for (let i = 0; i <= steps; i++) {
      const t  = i / steps;
      const nx = cx + (tx - cx) * t + Math.sin(t * Math.PI) * (Math.random() - 0.5) * 30;
      const ny = cy + (ty - cy) * t + Math.sin(t * Math.PI) * (Math.random() - 0.5) * 20;
      await page.mouse.move(nx, ny).catch(() => {});
      await sleep(12 + Math.random() * 18);
    }
    cx = tx; cy = ty;
    await sleep(200 + Math.random() * 400);
  }

  // Small scroll — reads as "user looked at the page"
  await page.evaluate(() => { window.scrollBy(0, 120 + Math.random() * 80); }).catch(() => {});
  await sleep(600 + Math.random() * 400);
  await page.evaluate(() => { window.scrollBy(0, -(60 + Math.random() * 40)); }).catch(() => {});
  await sleep(800 + Math.random() * 600);
}

module.exports = { loginToPortal, DEFAULT_PROFILE_DIR };
