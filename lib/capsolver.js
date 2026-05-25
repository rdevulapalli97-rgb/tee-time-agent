/**
 * lib/capsolver.js — reCAPTCHA v3 solver via CapSolver API
 *
 * CapSolver uses real browser profiles that score 0.9+ on reCAPTCHA v3,
 * bypassing the CCTT-608B rejection that headless Playwright browsers trigger.
 *
 * Cost: ~$0.001–0.003 per solve (pennies per week for one booking/week).
 * Sign up at https://capsolver.com — free $1 credit on signup.
 *
 * Usage:
 *   Set CAPSOLVER_API_KEY in your environment or config.json.
 *   The booking agent will automatically use it when available.
 */

'use strict';

const https = require('https');

/**
 * Post a JSON body to a URL, return parsed response.
 */
function apiPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u    = new URL(url);
    const req  = https.request({
      hostname: u.hostname,
      path:     u.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let buf = '';
      res.on('data', chunk => buf += chunk);
      res.on('end', () => {
        try   { resolve(JSON.parse(buf)); }
        catch  { reject(new Error(`CapSolver: invalid JSON response: ${buf.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Solve a reCAPTCHA v3 challenge.
 *
 * @param {string} apiKey   Your CapSolver API key
 * @param {string} siteKey  reCAPTCHA site key from the target page
 * @param {string} pageUrl  URL of the page where the CAPTCHA appears
 * @param {string} [action] reCAPTCHA action string (default: 'submit')
 * @returns {Promise<string>} Solved gRecaptchaResponse token
 */
async function solveRecaptchaV3(apiKey, siteKey, pageUrl, action = 'submit') {
  // ── Step 1: Create task ─────────────────────────────────────────────────
  const createRes = await apiPost('https://api.capsolver.com/createTask', {
    clientKey: apiKey,
    task: {
      type:        'ReCaptchaV3TaskProxyless',
      websiteURL:  pageUrl,
      websiteKey:  siteKey,
      pageAction:  action,
      minScore:    0.5,   // request at least 0.5; CapSolver typically returns 0.7–0.9
    },
  });

  if (createRes.errorId !== 0) {
    throw new Error(
      `CapSolver createTask failed [${createRes.errorCode}]: ${createRes.errorDescription}`
    );
  }

  const { taskId } = createRes;
  if (!taskId) {
    throw new Error(`CapSolver: missing taskId in response: ${JSON.stringify(createRes)}`);
  }

  // ── Step 2: Poll for result ─────────────────────────────────────────────
  // Typical solve time: 5–20 seconds. Poll every 2s, timeout at 60s.
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(r => setTimeout(r, 2000));

    const pollRes = await apiPost('https://api.capsolver.com/getTaskResult', {
      clientKey: apiKey,
      taskId,
    });

    if (pollRes.errorId !== 0) {
      throw new Error(
        `CapSolver getTaskResult failed [${pollRes.errorCode}]: ${pollRes.errorDescription}`
      );
    }

    if (pollRes.status === 'ready') {
      const token = pollRes.solution?.gRecaptchaResponse;
      if (!token) {
        throw new Error(`CapSolver: no token in solution: ${JSON.stringify(pollRes.solution)}`);
      }
      return token;
    }

    if (pollRes.status === 'failed') {
      throw new Error(`CapSolver: task failed: ${JSON.stringify(pollRes)}`);
    }

    // status === 'processing' — keep polling
  }

  throw new Error('CapSolver: timed out after 60s waiting for reCAPTCHA solution');
}

/**
 * Extract the reCAPTCHA site key from a Playwright page.
 * Tries several detection methods in order of reliability.
 *
 * @param {object} page  Playwright page
 * @returns {Promise<string|null>}
 */
async function extractSiteKey(page) {
  return page.evaluate(() => {
    // Method 1: captured by our init script hook (most reliable)
    if (window.__captchaSiteKey) return window.__captchaSiteKey;

    // Method 2: reCAPTCHA anchor iframe src contains ?k=SITEKEY
    for (const iframe of document.querySelectorAll('iframe[src*="recaptcha"]')) {
      const m = (iframe.src || '').match(/[?&]k=([A-Za-z0-9_-]{20,60})/);
      if (m) return m[1];
    }

    // Method 3: <script src="...api.js?render=SITEKEY"> (v3 standard load)
    for (const script of document.querySelectorAll('script[src*="recaptcha"]')) {
      const m = (script.src || '').match(/[?&]render=([A-Za-z0-9_-]{20,60})/);
      if (m && m[1] !== 'explicit') return m[1];
    }

    // Method 4: scan all script src/inline content for a 40-char alphanumeric key
    // (heuristic — only as last resort)
    const allText = document.documentElement.innerHTML;
    const m = allText.match(/['"](6[A-Za-z0-9_-]{38,42})['"]/);
    if (m) return m[1];

    return null;
  }).catch(() => null);
}

module.exports = { solveRecaptchaV3, extractSiteKey };
