/**
 * book-tee-time.js — Invited Clubs Booking Agent
 *
 * Uses the SAME navigation architecture as check-availability.js (confirmed working):
 *   - Single live browser session
 *   - window.location.href navigation (EVENT=HASH only works in live session)
 *   - div[id^="Tab-2"] date tabs (not td)
 *   - pollUntil for AJAX waits
 *   - Cell scanning for time parsing
 *
 * Exports bookTeeTime() for agent.js.
 * Also runnable standalone:
 *   node book-tee-time.js                         # book Saturday 6 days out
 *   node book-tee-time.js --dry-run               # find slot but don't book
 *   node book-tee-time.js --date 2026-05-17       # specific date
 */

const { chromium } = require('playwright');
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const { loginToPortal } = require('./lib/login');

const CONFIG_FILE  = path.join(__dirname, 'config.json');
const SESSION_FILE = path.join(__dirname, 'session.json');
const LOG_FILE     = path.join(__dirname, 'booking-log.txt');

const IS_CLI = require.main === module;

if (IS_CLI && !fs.existsSync(CONFIG_FILE))  { console.error('❌  config.json not found'); process.exit(1); }
if (IS_CLI && !fs.existsSync(SESSION_FILE)) { console.error('❌  session.json not found — run 1-SETUP.command first'); process.exit(1); }

const config  = IS_CLI ? JSON.parse(fs.readFileSync(CONFIG_FILE,  'utf8')) : {};
const session = IS_CLI ? JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) : {};

const BASE_URL   = 'https://apps.invitedclubs.com/portal/pls/portal/!CCTTWEB.controller';
const MEMBER_ID  = session.memberId || '';
const PORTAL_URL = IS_CLI ? `${BASE_URL}?ID=${MEMBER_ID}` : '';

// GA_CLUBS mirror — used for fallback resolution
const GA_CLUBS = [
  { name: 'Laurel Springs Golf Club',         home: true           },
  { name: 'Brookfield Country Club',          entity: '02771'      },
  { name: 'The Clubs of Peachtree City',      entity: '02812'      },
  { name: 'Windermere Golf Club',             entity: '02820'      },
  { name: 'Eagle Watch Golf Club',            entity: '02832'      },
  { name: 'Polo Golf & Country Club',         entity: '02845'      },
  { name: 'Atlanta National Golf Club',       entity: '02847'      },
  { name: 'Brookstone Golf & Country Club',   entity: '03181'      },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  if (config.notifications?.logToFile) {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pollUntil(page, condFn, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await condFn()) return true; } catch (e) {
      if (!e.message) throw e;
      const msg = e.message.toLowerCase();
      if (!msg.includes('context') && !msg.includes('navigation') && !msg.includes('target closed')) throw e;
    }
    await sleep(200);
  }
  return false;
}

// ── Portal navigation (identical to check-availability.js) ───────────────────
async function dismissNotice(page) {
  await page.evaluate(() => {
    for (const btn of document.querySelectorAll('button, input[type="button"], input[type="submit"]')) {
      const label = (btn.textContent || btn.value || '').trim();
      if (label.includes('Dismiss')) { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); return; }
    }
    if (typeof $ !== 'undefined') {
      try { $('#popup_message').closest('.ui-dialog').find('button').first().trigger('click'); } catch(e) {}
    }
  }).catch(() => {}); // clicking Dismiss can trigger navigation, destroying context before result returns
  await pollUntil(page, () => page.evaluate(() => !document.querySelector('.ui-widget-overlay')), 3000);
  await sleep(200);
}

async function goToClub(page, club) {
  const clubPath = club.home
    ? '/portal/pls/portal/!CCTTWEB.controller?EVENT=HASH&ACT=VIEW&LOC=CONT'
    : `/portal/pls/portal/!CCTTWEB.controller?EVENT=HASH&ACT=VIEW&LOC=NTWK&ENTITY=${club.entity}`;

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 25000 }).catch(() => {}),
    page.evaluate((p) => { window.location.href = p; }, clubPath).catch(() => {}) // navigation destroys context before result returns — suppress
  ]);
  await sleep(400);

  const hasTabs = await pollUntil(page,
    () => page.evaluate(() => !!document.querySelector('div[id^="Tab-2"]')).catch(() => false),
    12000
  );
  if (hasTabs) await dismissNotice(page);
  return hasTabs;
}

async function navigateToDate(page, isoDate) {
  const dt  = new Date(isoDate + 'T12:00:00');
  const y   = dt.getFullYear();
  const mo  = String(dt.getMonth() + 1).padStart(2, '0');
  const d   = String(dt.getDate()).padStart(2, '0');
  const dateStr = `${y}${mo}${d}`;

  for (let attempt = 0; attempt < 8; attempt++) {
    // Use Playwright locator click for real mouse events (reCAPTCHA-safe)
    let clicked = false;
    try {
      await page.locator(`#Tab-${dateStr}`).click({ timeout: 4000 });
      clicked = true;
    } catch (e) {
      clicked = await page.evaluate((tabId) => {
        const tab = document.getElementById(tabId);
        if (tab) { tab.click(); return true; }
        return false;
      }, `Tab-${dateStr}`).catch(() => false);
    }

    if (clicked) {
      await sleep(250);
      await pollUntil(page, () => page.evaluate((ds) => {
        const details = document.getElementById('SheetDetails-' + ds);
        if (details && details.innerHTML.trim().length > 20) return true;
        const div = document.getElementById('Div-' + ds);
        return !!(div && div.innerHTML.trim().length > 100);
      }, dateStr).catch(() => false), 10000);
      await sleep(100);
      return true;
    }

    const advanced = await page.evaluate(() => {
      const next = document.getElementById('cc_tab_next');
      if (next && next.style.visibility !== 'hidden') { next.click(); return true; }
      return false;
    }).catch(() => false);
    if (!advanced) break;
    await sleep(900);
  }
  return false;
}

// Parse tee time slots — exact same logic as check-availability.js (confirmed working).
// Scans every cell for a time pattern, then finds the next pure-integer cell as slot count.
async function parseSlots(page, isoDate, minPlayers = 1) {
  const dt  = new Date(isoDate + 'T12:00:00');
  const y   = dt.getFullYear();
  const mo  = String(dt.getMonth() + 1).padStart(2, '0');
  const d   = String(dt.getDate()).padStart(2, '0');
  const divId = `Div-${y}${mo}${d}`;

  let result;
  try {
    result = await page.evaluate((divId) => {
      const container = document.getElementById(divId);
      const debug = { divId, found: !!container, htmlLen: container ? container.innerHTML.trim().length : 0, rows: 0, slots: [] };
      if (!container || container.innerHTML.trim().length < 80) return { debug, slots: [] };

      const slots = [];
      const seen  = new Set();
      const allRows = container.querySelectorAll('tr');
      debug.rows = allRows.length;

      for (const row of allRows) {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 2) continue;

        let timeText = null, slotsAvail = NaN;
        for (let i = 0; i < cells.length; i++) {
          const txt = cells[i].textContent.trim();
          const tm  = txt.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
          if (tm) {
            timeText = `${tm[1]}:${tm[2]} ${tm[3].toUpperCase()}`;
            for (let j = i + 1; j < cells.length; j++) {
              const raw = cells[j].textContent.trim();
              const n   = parseInt(raw);
              if (!isNaN(n) && raw === String(n)) { slotsAvail = n; break; }
            }
            break;
          }
        }

        if (!timeText || isNaN(slotsAvail) || slotsAvail <= 0) continue;

        const m = timeText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        let hour = parseInt(m[1]), min = parseInt(m[2]);
        if (m[3].toUpperCase() === 'PM' && hour !== 12) hour += 12;
        if (m[3].toUpperCase() === 'AM' && hour === 12) hour  = 0;

        const key = `${hour}:${min}`;
        if (!seen.has(key)) {
          seen.add(key);
          slots.push({ display: timeText, hour, minutes: min, slotsAvailable: slotsAvail });
        }
      }

      slots.sort((a, b) => a.hour * 60 + a.minutes - (b.hour * 60 + b.minutes));
      return { debug, slots };
    }, divId);
  } catch (err) {
    log(`   parseSlots evaluate error: ${err.message}`);
    return [];
  }

  // Log diagnostics every time so we can see exactly what's happening
  const dbg = result?.debug;
  if (dbg) {
    log(`   parseSlots: div=${dbg.divId} found=${dbg.found} htmlLen=${dbg.htmlLen} rows=${dbg.rows} → ${result.slots.length} slots`);
  }

  const slots = result?.slots || [];
  return slots.filter(s => s.slotsAvailable >= minPlayers);
}

// ── Interactive guest prompt ──────────────────────────────────────────────────
/**
 * Prompt for guest names in the terminal before opening the browser.
 * In headless mode uses pre-configured guests from config instead.
 * @param {number} numGuests   how many guests to collect
 * @param {number} startIndex  which config guest to show as default (1-based)
 * @returns {Array} [{ firstName, lastName, phone }, ...]
 */
async function promptForGuests(numGuests, startIndex = 1) {
  const configGuests = (config.players || []).filter(p => p.role === 'guest');
  const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));
  const guests = [];

  console.log('');
  for (let i = 0; i < numGuests; i++) {
    const cfgGuest    = configGuests.find(g => g.index === startIndex + i) || configGuests[i];
    const hasDefault  = cfgGuest && !cfgGuest.firstName.startsWith('GUEST');
    const defaultHint = hasDefault ? ` (Enter for ${cfgGuest.firstName} ${cfgGuest.lastName})` : '';

    console.log(`  Guest ${i + 1}${numGuests > 1 ? ` of ${numGuests}` : ''}:`);
    const rawFirst = await ask(`    First name${defaultHint}: `);
    const firstName = rawFirst.trim() || (hasDefault ? cfgGuest.firstName : '');

    if (!firstName) { rl.close(); throw new Error('First name is required'); }

    const rawLast = await ask(`    Last name: `);
    const lastName  = rawLast.trim() || (hasDefault ? cfgGuest.lastName : '');

    if (!lastName)  { rl.close(); throw new Error('Last name is required'); }

    const rawPhone = await ask(`    Phone (optional — press Enter to skip): `);
    const phone    = rawPhone.trim() || (hasDefault ? cfgGuest.phone || '' : '');

    guests.push({ firstName, lastName, phone });
    console.log('');
  }

  rl.close();
  return guests;
}

// ── Booking-specific functions ────────────────────────────────────────────────

/**
 * Click the Reserve button using Playwright's real mouse events.
 * DOM .click() inside evaluate() has no mouse events → reCAPTCHA flags it as a bot → CCTT-608B.
 * page.locator().click() moves the cursor, fires mousemove/mousedown/mouseup → passes reCAPTCHA.
 */
async function clickReserveButton(page, isoDate, timeDisplay) {
  // Move mouse to a neutral position first (more human-like)
  await page.mouse.move(640, 400, { steps: 5 }).catch(() => {});
  await sleep(150 + Math.floor(Math.random() * 200));

  try {
    // Monitor AJAX requests AND responses so we can see exactly what's sent/returned
    const ajaxResponses = [];
    const ajaxRequests  = [];
    const onRequest = (request) => {
      const url = request.url();
      if (url.includes('CCTTWEB') || url.includes('ccttweb')) {
        ajaxRequests.push({
          method:   request.method(),
          url:      url.slice(-100),
          postData: (request.postData() || '').slice(0, 500),
          referer:  (request.headers()['referer'] || '').slice(0, 120)
        });
      }
    };
    const onResponse = async (response) => {
      if (response.url().includes('CCTTWEB') || response.url().includes('ccttweb')) {
        const body = await response.text().catch(() => '');
        ajaxResponses.push({ status: response.status(), url: response.url().slice(-80), body: body.slice(0, 800) });
      }
    };
    page.on('request',  onRequest);
    page.on('response', onResponse);

    // Use Playwright's real locator click — simulates actual mouse cursor movement + click
    // hasText matches the inner span text "11:00 AM" inside the cc-reserve-button span
    const locator = page.locator('span.cc-reserve-button.cc-selectable').filter({ hasText: timeDisplay }).first();
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await sleep(100);
    await locator.click({ timeout: 8000 });

    // Wait briefly to capture AJAX response
    await sleep(1500);
    page.off('request',  onRequest);
    page.off('response', onResponse);

    if (ajaxRequests.length > 0) {
      log(`   AJAX requests sent (${ajaxRequests.length}):`);
      ajaxRequests.forEach(r => {
        log(`     → ${r.method} ...${r.url}`);
        if (r.postData) log(`       POST: ${r.postData}`);
        if (r.referer)  log(`       Referer: ${r.referer}`);
      });
    } else {
      log(`   No AJAX requests captured`);
    }
    if (ajaxResponses.length > 0) {
      log(`   AJAX responses (${ajaxResponses.length}):`);
      ajaxResponses.forEach(r => log(`     [${r.status}] ...${r.url}\n       ${r.body.replace(/\s+/g, ' ').slice(0, 600)}`));
    } else {
      log(`   No AJAX responses captured after Reserve click`);
    }

    return 'locator-click';
  } catch (e) {
    log(`   Locator click failed (${e.message.slice(0, 80)}) — trying elementHandle`);
    // Fallback: get bounding box and use page.mouse.click() for real coordinates
    try {
      const handle = await page.evaluateHandle((timeDisplay) => {
        for (const span of document.querySelectorAll('span.cc-reserve-button.cc-selectable')) {
          const inner = span.querySelector('span') || span;
          if (inner.textContent.trim() === timeDisplay || span.textContent.trim() === timeDisplay) return span;
        }
        return null;
      }, timeDisplay);
      const box = await handle.asElement()?.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
        await sleep(80);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return 'mouse-click';
      }
    } catch (e2) {
      log(`   ElementHandle click failed: ${e2.message.slice(0, 60)}`);
    }
    return false;
  }
}

/**
 * After clicking Reserve, wait to learn whether the booking form opened
 * (save_button present) or the slot became unavailable (error state).
 * Returns: 'ready' | 'error' | 'timeout'
 */
async function waitForBookingFormState(page) {
  const start = Date.now();
  while (Date.now() - start < 12000) {
    try {
      const state = await page.evaluate(() => {
        if (document.getElementById('save_button')) return 'ready';
        const body = (document.body?.innerText || '').toLowerCase();
        // Portal error messages when a slot is no longer available
        if (body.includes('we are sorry') || body.includes('no available') ||
            body.includes('no tee time') || body.includes('not available') ||
            body.includes('already been reserved')) {
          if (document.getElementById('cancel_button')) return 'error';
        }
        // Also treat cancel-only state (no save) as error after a brief wait
        const hasSave   = !!document.getElementById('save_button');
        const hasCancel = !!document.getElementById('cancel_button');
        if (hasCancel && !hasSave) return 'error';
        return null;
      }).catch(() => null);
      if (state) return state;
    } catch(e) { /* context reset — keep polling */ }
    await sleep(300);
  }
  return 'timeout';
}

/** Dismiss an open booking form by clicking Cancel. */
async function cancelBookingForm(page) {
  await page.evaluate(() => {
    const c = document.getElementById('cancel_button');
    if (c) c.click();
  }).catch(() => {});
  await sleep(800);
}

/**
 * Fill guest player rows in the booking form.
 * @param {object} page
 * @param {Array}  guests  [{ firstName, lastName, phone }, ...]
 *
 * The portal form rows: [checkbox][#][PlayerType select][PlayerName input/select][Email]
 * Player Type must be set to "Guest" first — this may reveal name inputs.
 */
async function fillBookingForm(page, guests = []) {
  const guestList = guests;
  if (!guestList.length) return true;

  // Save form HTML for inspection
  fs.writeFileSync(path.join(__dirname, 'debug-booking-form.html'), await page.content());

  // Find all player-type rows (rows with a select containing "Guest" or "Member" options)
  const playerRowCount = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('tr')).filter(r => {
      const sels = r.querySelectorAll('select');
      return Array.from(sels).some(s =>
        Array.from(s.options).some(o => /guest|member/i.test(o.text))
      );
    }).length;
  });
  log(`    Detected ${playerRowCount} player rows in form`);

  // Fill each guest row sequentially
  for (let gi = 0; gi < guestList.length; gi++) {
    const { firstName, lastName, phone } = guestList[gi];
    const rowIndex = gi + 1; // 0-based among player rows; row 0 is the member

    // Step 1: Set Player Type dropdown to "Guest"
    const typeSet = await page.evaluate((rowIndex) => {
      const playerRows = Array.from(document.querySelectorAll('tr')).filter(r => {
        const sels = r.querySelectorAll('select');
        return Array.from(sels).some(s =>
          Array.from(s.options).some(o => /guest|member/i.test(o.text))
        );
      });
      if (playerRows.length <= rowIndex) return 'row-not-found';
      const sel = playerRows[rowIndex].querySelector('select');
      if (!sel) return 'no-select';
      const guestOpt = Array.from(sel.options).find(o => /guest/i.test(o.text));
      if (!guestOpt) return 'no-guest-option';
      sel.value = guestOpt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return 'set';
    }, rowIndex);

    log(`    Player ${rowIndex + 1} type set: ${typeSet}`);
    if (typeSet !== 'set') { log(`    Skipping name fill for row ${rowIndex + 1}`); continue; }

    await sleep(600); // wait for name inputs to appear after type change

    // Step 2: Fill name inputs
    const filled = await page.evaluate(({ rowIndex, firstName, lastName, phone }) => {
      const playerRows = Array.from(document.querySelectorAll('tr')).filter(r => {
        const sels = r.querySelectorAll('select');
        return Array.from(sels).some(s =>
          Array.from(s.options).some(o => /guest|member/i.test(o.text))
        );
      });
      if (playerRows.length <= rowIndex) return 'row-not-found';
      const inputs = Array.from(playerRows[rowIndex].querySelectorAll('input[type="text"], input:not([type])'));
      if (!inputs.length) return 'no-inputs';
      const set = (el, val) => {
        el.value = val;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set(inputs[0], firstName);
      if (inputs[1]) set(inputs[1], lastName);
      if (inputs[2] && phone) set(inputs[2], phone);
      return `filled-${inputs.length}`;
    }, { rowIndex, firstName, lastName, phone });

    log(`    Player ${rowIndex + 1} (${firstName} ${lastName}): ${filled}`);
  }

  return true;
}

/**
 * Click the Save button to finalize the booking.
 */
async function confirmBooking(page) {
  // First: dump every interactive element so we can see what's actually on the page
  const pageInfo = await page.evaluate(() => {
    const url = window.location.href;
    const bodySnippet = (document.body?.innerText || '').slice(0, 300).replace(/\s+/g, ' ');
    const interactive = Array.from(document.querySelectorAll(
      'input[type="submit"], input[type="button"], input[type="image"], button, a[href], span[id], div[id*="button"], div[id*="save"], div[id*="confirm"]'
    )).slice(0, 30).map(el => ({
      tag: el.tagName,
      id: el.id || '',
      cls: el.className || '',
      txt: (el.value || el.textContent || '').trim().slice(0, 40),
      onclick: !!(el.onclick || el.getAttribute('onclick'))
    }));
    return { url, bodySnippet, interactive };
  }).catch(e => ({ url: 'eval-error', bodySnippet: e.message, interactive: [] }));

  log(`   confirmBooking — URL: ${pageInfo.url}`);
  log(`   Body: ${pageInfo.bodySnippet}`);
  log(`   Interactive elements (${pageInfo.interactive.length}):`);
  pageInfo.interactive.forEach(el => log(`     [${el.tag}] id="${el.id}" cls="${el.cls}" txt="${el.txt}" onclick=${el.onclick}`));

  const clicked = await page.evaluate(() => {
    // 1. Portal span IDs
    const byId = document.getElementById('save_button');
    if (byId) { byId.click(); return 'save_button#id'; }

    const cancelId = document.getElementById('cancel_button');
    // (don't click cancel — just note its presence for context)

    // 2. input[type="submit"] or input[type="button"] with save/confirm/book/reserve value
    for (const el of document.querySelectorAll('input[type="submit"], input[type="button"], input[type="image"]')) {
      const v = (el.value || el.alt || '').trim().toLowerCase();
      if (v.includes('save') || v.includes('confirm') || v.includes('book') || v.includes('reserv')) {
        el.click(); return `input submit: "${el.value}"`;
      }
    }

    // 3. <button> elements
    for (const el of document.querySelectorAll('button')) {
      const v = (el.textContent || '').trim().toLowerCase();
      if (v.includes('save') || v.includes('confirm') || v.includes('book') || v.includes('reserv')) {
        el.click(); return `button: "${el.textContent.trim()}"`;
      }
    }

    // 4. Any element with id/class containing "save" or "confirm"
    for (const el of document.querySelectorAll('[id*="save"],[id*="confirm"],[id*="book"],[class*="save"],[class*="confirm"]')) {
      if (el.tagName === 'INPUT' || el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'SPAN' || el.tagName === 'DIV') {
        el.click(); return `by id/class: ${el.tagName}#${el.id}.${el.className} "${(el.textContent||'').trim().slice(0,30)}"`;
      }
    }

    // 5. Widest fallback: any clickable element whose visible text contains save/confirm
    const all = Array.from(document.querySelectorAll('span, div, a, label'));
    for (const el of all) {
      const own = (el.childNodes[0]?.nodeValue || '').trim().toLowerCase(); // own text node only
      if (own === 'save' || own === 'confirm' || own === 'book') {
        el.click(); return `text-node: ${el.tagName}#${el.id} "${own}"`;
      }
    }

    return null;
  }).catch(e => { log(`   confirmBooking evaluate error: ${e.message}`); return null; });

  if (!clicked) {
    log('❌  Save button not found after exhaustive search');
    // Write debug to /tmp which is always writable
    try {
      const html = await page.content().catch(() => 'page.content() failed');
      fs.writeFileSync('/tmp/debug-no-save-btn.html', html);
      log('   Debug HTML written to /tmp/debug-no-save-btn.html');
    } catch(e) { log(`   Could not write debug HTML: ${e.message}`); }
    return false;
  }
  log(`    Clicked Save (${clicked})`);
  return true;
}

/**
 * Check if there's already an existing reservation for the target date.
 * Returns: true (booked), false (not booked), null (could not determine).
 */
async function checkExistingReservation(page, isoDate) {
  try {
    // Navigate to reservations view
    const reservationPath = '/portal/pls/portal/!CCTTWEB.controller?EVENT=HASH&ACT=VIEW&LOC=RSRV';
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {}),
      page.evaluate((p) => { window.location.href = p; }, reservationPath)
    ]);
    await sleep(2000);

    // Check if the target date appears in the reservations table
    const dt  = new Date(isoDate + 'T12:00:00');
    const dateStrings = [
      dt.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }),
      dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      `${dt.getMonth() + 1}/${dt.getDate()}/${dt.getFullYear()}`
    ];

    const found = await page.evaluate((strs) => {
      const txt = document.body.innerText;
      return strs.some(s => txt.includes(s));
    }, dateStrings);

    log(`    Existing reservation check for ${isoDate}: ${found ? 'ALREADY BOOKED' : 'none found'}`);
    return found;
  } catch (e) {
    log(`    Could not check reservations (${e.message.slice(0, 60)}) — proceeding anyway`);
    return null;
  }
}

// ── Core booking logic (used by both CLI and agent) ───────────────────────────
/**
 * Perform the actual scan-and-book using an already-authenticated page.
 * All browser/login setup is handled by the caller.
 *
 * @param {object} page             Authenticated Playwright page
 * @param {object} effectiveConfig  Full config (legacy shape from buildLegacyConfig)
 * @param {object} opts
 *   isoDate  {string}   YYYY-MM-DD
 *   clubs    {Array}    GA_CLUBS-style objects to scan in order
 *   dryRun   {boolean}
 *   guests   {Array}    [{ firstName, lastName, phone }]
 * @returns {{ success, club, slot, date, inWindow, error }}
 */
async function _bookWithSession(page, effectiveConfig, { isoDate, clubs, dryRun = false, guests = [], portalUrl = null, reloginFn = null }) {
  const { earliestHour, latestHour } = effectiveConfig.booking.homeClub.preferredTimeRange;
  const numPlayers      = effectiveConfig.booking.numberOfPlayers || 2;
  const fallbackEnabled = effectiveConfig.booking.fallbackToEarliestAvailable !== false;
  const clubTiers       = effectiveConfig.booking.clubTiers || clubs.map(c => c.name);

  log('='.repeat(60));
  log(`🏌️   Booking agent — ${isoDate}`);
  log(`⏰   Preferred window: ${earliestHour}:00–${latestHour}:00`);
  log(`👥   Players: ${numPlayers}`);
  if (dryRun) log('🔍   DRY RUN — no booking will be made');
  log('='.repeat(60));

  const getTier = (name) => {
    const idx = clubTiers.indexOf(name);
    return idx === -1 ? clubTiers.length : idx;
  };

  // ── Phase 1: Scan all clubs, collect candidates ────────────────────────────
  const candidates = [];
  for (const club of clubs) {
    log(`\n→ Scanning ${club.name}…`);
    const navOk = await goToClub(page, club);
    if (!navOk) { log(`   Navigation failed — skipping`); continue; }
    const dateOk = await navigateToDate(page, isoDate);
    if (!dateOk) { log(`   Date not available — skipping`); continue; }
    // Get ALL slots with ≥1 spot (don't pre-filter by numPlayers — do it below for transparency)
    const allSlots  = await parseSlots(page, isoDate, 1);
    const withRoom  = allSlots.filter(s => s.slotsAvailable >= numPlayers);
    const inWindow  = withRoom.filter(s => s.hour >= earliestHour && s.hour <= latestHour);
    log(`   ${allSlots.length} total slots, ${withRoom.length} with ${numPlayers}+ spots, ${inWindow.length} in ${earliestHour}:00–${latestHour}:00 window`);
    if (allSlots.length > 0) {
      log(`   All times: ${allSlots.map(s => `${s.display}(${s.slotsAvailable})`).join(', ')}`);
    }
    if (inWindow.length > 0) {
      candidates.push({ club, slot: inWindow[0], inWindow: true });
    } else if (withRoom.length > 0 && fallbackEnabled) {
      log(`   ⏱️  No in-window slots — earliest with room: ${withRoom[0].display} (${withRoom[0].slotsAvailable} spots)`);
      candidates.push({ club, slot: withRoom[0], inWindow: false });
    } else if (allSlots.length > 0) {
      log(`   ⚠️  Slots exist but none have ${numPlayers}+ spots available`);
    } else {
      log(`   No slots available`);
    }
  }

  if (candidates.length === 0) {
    log('\n❌  No suitable slot found at any club');
    return { success: false, error: 'No suitable slots found at any club', date: isoDate };
  }

  // ── Phase 2: Sort candidates by preference ────────────────────────────────
  candidates.sort((a, b) => {
    if (a.inWindow !== b.inWindow) return a.inWindow ? -1 : 1;
    const tierDiff = getTier(a.club.name) - getTier(b.club.name);
    if (tierDiff !== 0) return tierDiff;
    return (a.slot.hour * 60 + a.slot.minutes) - (b.slot.hour * 60 + b.slot.minutes);
  });

  log(`\n🎯  Booking order (${candidates.length} candidate${candidates.length > 1 ? 's' : ''}):`);
  candidates.forEach((c, i) => log(`   ${i + 1}. ${c.slot.display} at ${c.club.name}${c.inWindow ? '' : ' (fallback)'}`));

  if (dryRun) {
    const top = candidates[0];
    log(`🔍  DRY RUN — would book ${top.slot.display} at ${top.club.name}`);
    return { success: false, dryRun: true, club: top.club.name, slot: top.slot, date: isoDate };
  }

  // ── Phase 3: Fresh login before booking ───────────────────────────────────
  // Phase 1 visits up to 8 clubs, leaving the server-side session in a
  // degraded state that causes CCTT-608B on Reserve. A completely fresh
  // login gives us a clean session with correct LOC/ENTITY cookies — the
  // same state the user's browser is in when they manually book a tee time.
  let bookingPage = page;
  let phase3Browser = null;
  if (reloginFn) {
    log('\n→ Phase 3: fresh login for clean booking session…');
    try {
      const lr = await reloginFn();
      bookingPage   = lr.page;
      phase3Browser = lr.browser;
      portalUrl     = lr.portalUrl || portalUrl;
      log('   Phase 3 fresh login ✅');
    } catch (e) {
      log(`   Phase 3 re-login failed (${e.message.slice(0, 80)}) — using existing session as fallback`);
      bookingPage = page;
    }
  } else if (portalUrl) {
    // Fallback: just reload the portal entry point (less reliable but keeps
    // the same browser session when no reloginFn is provided).
    log('\n→ Refreshing portal session before booking…');
    await page.goto(portalUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
    await page.waitForFunction(
      () => { const c = document.getElementById('cc_web_content'); return c && c.innerHTML.trim().length > 200; },
      { timeout: 15000 }
    ).catch(() => {});
    const hasSelection = await page.evaluate(() => !!document.getElementById('home_club')).catch(() => false);
    if (hasSelection) {
      await page.evaluate(() => document.getElementById('home_club')?.click()).catch(() => {});
      await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      await pollUntil(page, () => page.evaluate(() => !!document.querySelector('div[id^="Tab-2"]')).catch(() => false), 10000);
    }
    log('   Portal session refreshed ✅');
  }

  // ── Phase 3: Try each candidate until one succeeds ────────────────────────
  for (const candidate of candidates) {
    log(`\n→ Attempting ${candidate.slot.display} at ${candidate.club.name}…`);

    const navBack = await goToClub(bookingPage, candidate.club);
    if (!navBack) { log(`   Re-navigation failed — skipping`); continue; }
    const dateBack = await navigateToDate(bookingPage, isoDate);
    if (!dateBack) { log(`   Date navigation failed — skipping`); continue; }

    // Click reserve
    const clickResult = await clickReserveButton(bookingPage, isoDate, candidate.slot.display);
    if (!clickResult) { log(`   Reserve button not found — skipping`); continue; }
    log(`   Clicked reserve (${clickResult})`);

    // Wait to learn if form opened or slot is gone
    await sleep(600);
    const formState = await waitForBookingFormState(bookingPage);
    log(`   Form state: ${formState}`);

    if (formState === 'error') {
      log(`   Slot no longer available — cancelling and trying next`);
      await cancelBookingForm(bookingPage);
      await sleep(500);
      continue;
    }
    if (formState === 'timeout') {
      log(`   Form timed out — skipping`);
      await cancelBookingForm(bookingPage);
      continue;
    }

    // Form is ready — fill guests and save
    log(`   Booking form ready — filling details`);
    await fillBookingForm(bookingPage, guests);

    const confirmed = await confirmBooking(bookingPage);
    if (!confirmed) { log(`   Save failed — trying next slot`); continue; }

    await sleep(3000);
    await bookingPage.screenshot({ path: '/tmp/debug-confirmation.png' }).catch(() => {});

    // Check if form is still showing (portal rejected the save)
    const formStillVisible = await bookingPage.evaluate(() => !!document.getElementById('save_button')).catch(() => false);
    if (formStillVisible) {
      const errLine = await bookingPage.evaluate(() => {
        const lines = (document.body?.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
        return lines.find(l =>
          l.match(/CCTT-\d+/) || l.toLowerCase().includes('minimum') ||
          l.toLowerCase().includes('required') || l.toLowerCase().includes('unable')
        ) || 'Unknown error (form still showing)';
      }).catch(() => 'Could not read error');
      log(`   Booking rejected: ${errLine} — trying next slot`);
      await cancelBookingForm(bookingPage);
      continue;
    }

    const inWindowNote = candidate.inWindow ? '' : ' ⚠️  (outside preferred window — earliest available fallback)';
    log('');
    log('✅  BOOKING CONFIRMED');
    log(`   Club: ${candidate.club.name}`);
    log(`   Date: ${isoDate}`);
    log(`   Time: ${candidate.slot.display}${inWindowNote}`);

    if (phase3Browser) await phase3Browser.close().catch(() => {});
    return { success: true, club: candidate.club.name, slot: candidate.slot, date: isoDate, inWindow: candidate.inWindow };
  }

  if (phase3Browser) await phase3Browser.close().catch(() => {});
  log('\n❌  All candidates exhausted — no booking made');
  return { success: false, error: 'All available slots were taken by the time booking was attempted', date: isoDate };
}

// ── Main booking function (CLI entry point) ───────────────────────────────────
/**
 * @param {object} opts
 *   isoDate     {string}  YYYY-MM-DD target date
 *   clubs       {Array}   club objects to try in order (from GA_CLUBS)
 *   dryRun      {boolean} navigate + find slot but don't click Reserve
 *   headless    {boolean} run headless (default false)
 *   skipExistingCheck {boolean} skip the existing-reservation check
 * @returns {{ success, club, slot, date, alreadyBooked, error }}
 */
async function bookTeeTime({ isoDate, clubs, dryRun = false, headless = false, skipExistingCheck = true, guestIndex = null, guests: preloadedGuests = null } = {}) {
  const numPlayers = config.booking.numberOfPlayers || 2;
  const numGuests  = numPlayers - 1;
  const startGuest = guestIndex ?? (config.defaultGuestIndex || 1);

  // ── Collect guest names BEFORE opening the browser ─────────────────────────
  let guests = preloadedGuests;
  if (!guests && numGuests > 0) {
    if (headless) {
      const allGuests = (config.players || []).filter(p => p.role === 'guest');
      guests = [];
      for (let i = 0; i < numGuests; i++) {
        const g = allGuests.find(p => p.index === startGuest + i) || allGuests[i];
        if (!g || g.firstName.startsWith('GUEST')) {
          return { success: false, error: `Guest ${startGuest + i} not configured in config.json — required for headless booking.` };
        }
        guests.push({ firstName: g.firstName, lastName: g.lastName, phone: g.phone || '' });
      }
    } else {
      console.log(`\n👤  Who are you playing with?`);
      try {
        guests = await promptForGuests(numGuests, startGuest);
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
  }

  // ── Credentials — prefer env vars, fall back to session.json ──────────────
  // Apps.invitedclubs.com session cookies are server-side sessions that die
  // the moment the setup browser closes. We must always do a fresh login.
  const username = process.env.INVITED_USERNAME || session.username || '';
  const password = process.env.INVITED_PASSWORD || session.password || '';

  let browser, context, page;
  let portalUrl = PORTAL_URL;
  try {
    if (username && password) {
      log('Logging in fresh (session cookies expire on browser close)…');
      const lr = await loginToPortal(chromium, username, password);
      browser   = lr.browser;
      context   = lr.context;
      page      = lr.page;
      portalUrl = lr.portalUrl || PORTAL_URL;
      log('Fresh login successful ✅');
    } else {
      // Fallback: restore saved cookies (likely stale — only works if run
      // within minutes of setup and before the browser was closed)
      log('⚠️  No credentials in session.json or env vars — restoring saved cookies (may fail).');
      log('   Run 1-SETUP.command again and enter your username/password when prompted.');
      browser = await chromium.launch({ headless, args: headless ? ['--no-sandbox'] : ['--start-maximized'] });
      context = await browser.newContext({ viewport: headless ? { width: 1280, height: 900 } : null });
      if (session.cookies?.length) await context.addCookies(session.cookies);
      page = await context.newPage();
      log('Loading portal…');
      await page.goto(portalUrl, { waitUntil: 'load', timeout: 25000 });
    }

    if (!skipExistingCheck) {
      const alreadyBooked = await checkExistingReservation(page, isoDate);
      if (alreadyBooked === true) {
        await browser.close();
        return { success: false, alreadyBooked: true, error: 'Already have a reservation for this date' };
      }
    }

    const result = await _bookWithSession(page, config, {
      isoDate,
      clubs,
      dryRun,
      guests: guests || [],
      portalUrl,
      // Provide a reloginFn so Phase 3 gets a fresh browser session.
      // Phase 1 scanning corrupts server-side state after visiting many clubs;
      // a full re-login is the only reliable way to reset it.
      reloginFn: (username && password)
        ? () => loginToPortal(chromium, username, password)
        : null,
    });

    // Save updated cookies (CLI only — not needed for auth but useful for debugging)
    const updatedCookies = await context.cookies();
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ ...session, savedAt: new Date().toISOString(), cookies: updatedCookies }, null, 2));

    await browser.close();
    return result;

  } catch (err) {
    log(`❌  Error: ${err.message}`);
    try { await page?.screenshot({ path: path.join(__dirname, 'debug-booking-error.png') }); } catch {}
    try { await browser?.close(); } catch {}
    return { success: false, error: err.message };
  }
}

// ── Standalone CLI ────────────────────────────────────────────────────────────
if (require.main === module) {
  const args        = process.argv.slice(2);
  const isDryRun    = args.includes('--dry-run');
  const isHeadless  = args.includes('--headless');
  const dateIdx     = args.indexOf('--date');
  const guestIdx    = args.indexOf('--guest');
  const playersIdx  = args.indexOf('--players');

  // --guest N  selects which guest (1, 2, or 3)
  const guestIndex = guestIdx !== -1 ? parseInt(args[guestIdx + 1]) || 1 : null;

  // --players N  overrides numberOfPlayers for this run
  if (playersIdx !== -1 && args[playersIdx + 1]) {
    config.booking.numberOfPlayers = parseInt(args[playersIdx + 1]) || 2;
  }

  let isoDate;
  if (dateIdx !== -1 && args[dateIdx + 1]) {
    isoDate = args[dateIdx + 1];
  } else {
    // Snap to the next target day (e.g. Saturday) that is at least daysInAdvance days out.
    // Previously this used today+6 which produced random weekdays instead of Saturdays.
    isoDate = getNextTargetDate(
      config.booking.homeClub.targetDay || 'Saturday',
      config.booking.homeClub.daysInAdvance || 6
    );
  }

  const fallbackNames = config.fallbackClubs || [];
  const orderedClubs  = [
    GA_CLUBS.find(c => c.home),
    ...fallbackNames.map(name => GA_CLUBS.find(c => c.name === name)).filter(Boolean)
  ].filter(Boolean);

  bookTeeTime({ isoDate, clubs: orderedClubs, dryRun: isDryRun, headless: isHeadless, guestIndex })
    .then(r => {
      if (r.success) process.exit(0);
      if (r.alreadyBooked) { console.log('Already booked for this date.'); process.exit(0); }
      if (r.dryRun) { console.log('Dry run complete.'); process.exit(0); }
      console.error('Booking failed:', r.error);
      process.exit(1);
    })
    .catch(err => { console.error('Fatal:', err.message); process.exit(1); });
}

// ── Multi-tenant export ───────────────────────────────────────────────────────
/**
 * Agent mode entry point — called by user-runner.js.
 * Logs in via loginToPortal, then calls _bookWithSession with the live page.
 * Returns { success, club, slot, date, inWindow, error }.
 */
async function run(injectedConfig) {
  const { chromium: pw }  = require('playwright');

  const username = injectedConfig?.credentials?.username;
  const password = injectedConfig?.credentials?.password;
  if (!username || !password) throw new Error('run() requires injectedConfig.credentials');

  // ── Login ────────────────────────────────────────────────────────────────
  const { browser, page, portalUrl } = await loginToPortal(pw, username, password);

  // ── Resolve target date ──────────────────────────────────────────────────
  // injectedConfig._targetDate allows callers (e.g. trigger-booking.js) to
  // override the date rather than using the 6-days-ahead formula.
  const targetDay  = injectedConfig?.booking?.homeClub?.targetDay  || 'Saturday';
  const daysAhead  = injectedConfig?.booking?.homeClub?.daysInAdvance || 6;
  const targetDate = injectedConfig?._targetDate || getNextTargetDate(targetDay, daysAhead);

  // ── Resolve clubs ────────────────────────────────────────────────────────
  const homeClub = GA_CLUBS.find(c => c.home) || { name: injectedConfig?.booking?.homeClub?.name || 'Laurel Springs Golf Club', home: true };
  const tierNames = injectedConfig?.booking?.clubTiers || [];
  const clubs = [
    homeClub,
    ...tierNames.map(name => GA_CLUBS.find(c => c.name === name)).filter(Boolean)
  ].filter((c, i, arr) => arr.findIndex(x => x.name === c.name) === i); // deduplicate

  // ── Resolve guests ───────────────────────────────────────────────────────
  const numPlayers = injectedConfig?.booking?.numberOfPlayers || 2;
  const numGuests  = numPlayers - 1;
  const allGuests  = (injectedConfig?.players || []).filter(p => p.role === 'guest');
  const guests = [];
  for (let i = 0; i < numGuests; i++) {
    const g = allGuests[i];
    if (!g || !g.firstName || g.firstName.startsWith('GUEST')) {
      log(`[run] Guest ${i + 1} not configured — booking for ${numPlayers - guests.length - 1} fewer player(s)`);
      break;
    }
    guests.push({ firstName: g.firstName, lastName: g.lastName, phone: g.phone || '' });
  }

  // ── Book ─────────────────────────────────────────────────────────────────
  try {
    const result = await _bookWithSession(page, injectedConfig, {
      isoDate: targetDate,
      clubs,
      dryRun: false,
      guests,
      portalUrl,
      // Phase 3 re-login: same rationale as bookTeeTime — multi-club Phase 1
      // scan degrades session state, fresh login before Reserve is required.
      reloginFn: () => loginToPortal(pw, username, password),
    });
    await browser.close().catch(() => {});
    return result;
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

function getNextTargetDate(dayName, daysAhead) {
  const days = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
  const target = days[dayName] ?? 6;
  const today = new Date();
  let d = new Date(today);
  d.setDate(today.getDate() + daysAhead);
  // Find the nearest target day within ±1 day of daysAhead
  while (d.getDay() !== target) d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

module.exports = { bookTeeTime, run, GA_CLUBS };
