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
    const clicked = await page.evaluate((tabId) => {
      const tab = document.getElementById(tabId);
      if (tab) { tab.click(); return true; }
      return false;
    }, `Tab-${dateStr}`).catch(() => false);

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

// minPlayers: only return slots with at least this many open spots (speeds up booking)
async function parseSlots(page, isoDate, minPlayers = 1) {
  const dt  = new Date(isoDate + 'T12:00:00');
  const y   = dt.getFullYear();
  const mo  = String(dt.getMonth() + 1).padStart(2, '0');
  const d   = String(dt.getDate()).padStart(2, '0');
  const divId = `Div-${y}${mo}${d}`;

  return page.evaluate((divId, minPlayers) => {
    const container = document.getElementById(divId);
    if (!container || container.innerHTML.trim().length < 80) return [];
    const slots = [];
    const seen  = new Set();
    for (const row of container.querySelectorAll('tr')) {
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
      // Filter by minPlayers right here — no point returning slots we can't use
      if (!timeText || isNaN(slotsAvail) || slotsAvail < minPlayers) continue;
      const m = timeText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      let hour = parseInt(m[1]), min = parseInt(m[2]);
      if (m[3].toUpperCase() === 'PM' && hour !== 12) hour += 12;
      if (m[3].toUpperCase() === 'AM' && hour === 12) hour = 0;
      const key = `${hour}:${min}`;
      if (!seen.has(key)) {
        seen.add(key);
        slots.push({ display: timeText, hour, minutes: min, slotsAvailable: slotsAvail, _row: null });
      }
    }
    slots.sort((a, b) => a.hour * 60 + a.minutes - (b.hour * 60 + b.minutes));
    return slots;
  }, divId, minPlayers).catch(() => []);
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
 * Click the Reserve button for a given tee time display string.
 * The Reserve column (cells[0]) contains a link/button/image.
 */
async function clickReserveButton(page, isoDate, timeDisplay) {
  const dt  = new Date(isoDate + 'T12:00:00');
  const y   = dt.getFullYear();
  const mo  = String(dt.getMonth() + 1).padStart(2, '0');
  const d   = String(dt.getDate()).padStart(2, '0');
  const divId = `Div-${y}${mo}${d}`;

  return page.evaluate(({ divId, timeDisplay }) => {
    const container = document.getElementById(divId);
    if (!container) return false;
    for (const row of container.querySelectorAll('tr')) {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 2) continue;
      // Find time cell
      let timeCell = null;
      for (let i = 0; i < cells.length; i++) {
        if (cells[i].textContent.trim() === timeDisplay) { timeCell = i; break; }
      }
      if (timeCell === null) continue;
      // Click the first interactive element in cells[0]
      const btn = cells[0].querySelector('a, input[type="image"], input[type="button"], button, [onclick]');
      if (btn) { btn.click(); return true; }
      // Fallback: click the cell itself
      cells[0].click();
      return true;
    }
    return false;
  }, { divId, timeDisplay });
}

/**
 * Wait for the inline booking form to appear after clicking Reserve.
 * The portal expands the form inline (NOT a jQuery dialog).
 * Detected by: countdown timer text, Save button, or Cancel button.
 */
async function waitForBookingModal(page) {
  return pollUntil(page, () => page.evaluate(() => {
    // Most reliable: portal-specific save/cancel span IDs
    if (document.getElementById('save_button') || document.getElementById('cancel_button')) return true;

    // Countdown timer text (also unique to the booking form)
    const bodyText = document.body.innerText || '';
    if (bodyText.includes('reservation will close') || bodyText.includes('allotted time')) return true;

    return false;
  }).catch(() => false), 12000);
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
 * The portal renders Save/Cancel as <span id="save_button"> / <span id="cancel_button">
 * inside a <div class="cc-buttons">.
 */
async function confirmBooking(page) {
  const clicked = await page.evaluate(() => {
    // Primary: portal-specific span IDs
    const byId = document.getElementById('save_button');
    if (byId) { byId.click(); return 'save_button#id'; }

    // Fallback: any span/div/button/input whose text is exactly "Save"
    const all = Array.from(document.querySelectorAll('span, div, button, input[type="button"], input[type="submit"], a'));
    for (const el of all) {
      const label = (el.value || el.textContent || '').trim();
      if (label === 'Save') { el.click(); return `Save via ${el.tagName}`; }
    }

    // Wider fallback: anything containing "save"
    for (const el of all) {
      const label = (el.value || el.textContent || '').trim().toLowerCase();
      if (label.includes('save')) { el.click(); return `save-partial via ${el.tagName}`; }
    }

    return null;
  });

  if (!clicked) {
    log('❌  Save button not found — saving debug HTML');
    fs.writeFileSync(path.join(__dirname, 'debug-no-save-btn.html'), await page.content());
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
async function _bookWithSession(page, effectiveConfig, { isoDate, clubs, dryRun = false, guests = [] }) {
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
    const allSlots = await parseSlots(page, isoDate, numPlayers);
    const inWindow = allSlots.filter(s => s.hour >= earliestHour && s.hour <= latestHour);
    log(`   ${allSlots.length} total slots, ${inWindow.length} in ${earliestHour}:00–${latestHour}:00 window`);
    if (inWindow.length > 0) {
      log(`   ✅ In-window: ${inWindow.map(s => `${s.display}(${s.slotsAvailable})`).join(', ')}`);
      candidates.push({ club, slot: inWindow[0], inWindow: true });
    } else if (allSlots.length > 0 && fallbackEnabled) {
      log(`   ⏱️  No in-window slots — earliest available: ${allSlots[0].display} (${allSlots[0].slotsAvailable} spots)`);
      candidates.push({ club, slot: allSlots[0], inWindow: false });
    } else {
      log(`   No slots available`);
    }
  }

  if (candidates.length === 0) {
    log('\n❌  No suitable slot found at any club');
    return { success: false, error: 'No suitable slots found at any club', date: isoDate };
  }

  // ── Phase 2: Select best candidate ────────────────────────────────────────
  candidates.sort((a, b) => {
    if (a.inWindow !== b.inWindow) return a.inWindow ? -1 : 1;
    const tierDiff = getTier(a.club.name) - getTier(b.club.name);
    if (tierDiff !== 0) return tierDiff;
    return (a.slot.hour * 60 + a.slot.minutes) - (b.slot.hour * 60 + b.slot.minutes);
  });

  const winner     = candidates[0];
  const winnerNote = winner.inWindow ? '' : ' ⚠️  (outside preferred window — earliest available fallback)';
  log(`\n🎯  Selected: ${winner.slot.display} (${winner.slot.slotsAvailable} spots) at ${winner.club.name}${winnerNote}`);

  if (dryRun) {
    log(`🔍  DRY RUN — would book ${winner.slot.display} at ${winner.club.name}`);
    return { success: false, dryRun: true, club: winner.club.name, slot: winner.slot, date: isoDate };
  }

  // ── Phase 3: Navigate back to winner and book ──────────────────────────────
  log(`\n→ Navigating to ${winner.club.name} to book…`);
  const navBack = await goToClub(page, winner.club);
  if (!navBack) return { success: false, error: `Re-navigation to ${winner.club.name} failed`, date: isoDate };
  const dateBack = await navigateToDate(page, isoDate);
  if (!dateBack) return { success: false, error: 'Date navigation failed on booking attempt', date: isoDate };

  // ── Click Reserve ──────────────────────────────────────────────────────────
  log(`Clicking Reserve for ${winner.slot.display}…`);
  const reserved = await clickReserveButton(page, isoDate, winner.slot.display);
  if (!reserved) {
    log('❌  Reserve button not found — saving debug HTML');
    fs.writeFileSync(path.join(__dirname, 'debug-no-reserve.html'), await page.content());
    return { success: false, error: 'Reserve button not found', date: isoDate };
  }

  // ── Wait for booking form ──────────────────────────────────────────────────
  await sleep(600);
  const modalOk = await waitForBookingModal(page);
  if (!modalOk) {
    log('⚠️  Booking modal did not appear — saving debug screenshot');
    await page.screenshot({ path: path.join(__dirname, 'debug-no-modal.png') });
    return { success: false, error: 'Booking modal did not appear', date: isoDate };
  }
  await page.screenshot({ path: path.join(__dirname, 'debug-booking-form.png') });
  log('    Booking form appeared — screenshot saved');

  // ── Fill guest details ─────────────────────────────────────────────────────
  await fillBookingForm(page, guests);

  // ── Confirm booking ────────────────────────────────────────────────────────
  const confirmed = await confirmBooking(page);
  if (!confirmed) return { success: false, error: 'Save button not found', date: isoDate };

  await sleep(3000);
  await page.screenshot({ path: path.join(__dirname, 'debug-confirmation.png') });

  // Portal still showing form = Save was rejected
  const formStillVisible = await page.evaluate(() => !!document.getElementById('save_button')).catch(() => false);
  if (formStillVisible) {
    const errLine = await page.evaluate(() => {
      const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean);
      return lines.find(l =>
        l.match(/CCTT-\d+/) ||
        l.toLowerCase().includes('minimum') ||
        l.toLowerCase().includes('required') ||
        l.toLowerCase().includes('unable')
      ) || 'Unknown error (form still showing)';
    }).catch(() => 'Could not read error');
    log(`❌  Booking rejected: ${errLine}`);
    return { success: false, error: errLine, date: isoDate };
  }

  const pageText = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => '');
  if (pageText.includes('cctt-') || pageText.includes('minimum') || pageText.includes('unable to') || pageText.includes('cannot be')) {
    log('⚠️  Confirmation page may contain an error — check debug-confirmation.png');
    return { success: false, error: 'Portal returned an error on confirmation page', date: isoDate };
  }

  log('');
  log('✅  BOOKING CONFIRMED');
  log(`   Club: ${winner.club.name}`);
  log(`   Date: ${isoDate}`);
  log(`   Time: ${winner.slot.display}${winnerNote}`);

  return { success: true, club: winner.club.name, slot: winner.slot, date: isoDate, inWindow: winner.inWindow };
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

  let browser, context, page;
  try {
    browser = await chromium.launch({ headless, args: headless ? ['--no-sandbox'] : ['--start-maximized'] });
    context = await browser.newContext({ viewport: headless ? { width: 1280, height: 900 } : null });
    if (session.cookies?.length) await context.addCookies(session.cookies);
    page = await context.newPage();

    log('Loading portal…');
    await page.goto(PORTAL_URL, { waitUntil: 'networkidle', timeout: 25000 });

    const sessionOk = await page.evaluate(() => {
      const c = document.getElementById('cc_web_content');
      return !!(c && c.innerHTML.trim().length > 200);
    }).catch(() => false);

    if (!sessionOk || page.url().includes('login')) {
      if (headless) {
        await browser.close();
        browser  = await chromium.launch({ headless: false, args: ['--start-maximized'] });
        context  = await browser.newContext({ viewport: null });
        if (session.cookies?.length) await context.addCookies(session.cookies);
        page     = await context.newPage();
        await page.goto(PORTAL_URL, { waitUntil: 'networkidle', timeout: 25000 });
      }
      log('Session expired — log in to the browser and press Enter...');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      await new Promise(resolve => rl.question('Press Enter once logged in… ', () => { rl.close(); resolve(); }));
      await page.goto(PORTAL_URL, { waitUntil: 'networkidle', timeout: 25000 });
    } else {
      log('Session valid ✅');
    }

    if (!skipExistingCheck) {
      const alreadyBooked = await checkExistingReservation(page, isoDate);
      if (alreadyBooked === true) {
        await browser.close();
        return { success: false, alreadyBooked: true, error: 'Already have a reservation for this date' };
      }
    }

    const result = await _bookWithSession(page, config, { isoDate, clubs, dryRun, guests: guests || [] });

    // Save updated cookies (CLI only)
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
    const d = new Date();
    d.setDate(d.getDate() + (config.booking.homeClub.daysInAdvance || 6));
    isoDate = d.toISOString().split('T')[0];
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
  const { loginToPortal } = require('./lib/login');
  const { chromium: pw }  = require('playwright');

  const username = injectedConfig?.credentials?.username;
  const password = injectedConfig?.credentials?.password;
  if (!username || !password) throw new Error('run() requires injectedConfig.credentials');

  // ── Login ────────────────────────────────────────────────────────────────
  const { browser, page } = await loginToPortal(pw, username, password);

  // ── Resolve target date ──────────────────────────────────────────────────
  const targetDay  = injectedConfig?.booking?.homeClub?.targetDay  || 'Saturday';
  const daysAhead  = injectedConfig?.booking?.homeClub?.daysInAdvance || 6;
  const targetDate = getNextTargetDate(targetDay, daysAhead);

  // ── Resolve clubs ────────────────────────────────────────────────────────
  const homeClub = GA_CLUBS.find(c => c.home) || { name: injectedConfig?.booking?.homeClub?.name || 'Laurel Springs Golf Club', home: true };
  const tierNames = injectedConfig?.booking?.clubTiers || [];
  const clubs = [
    homeClub,
    ...tierNames.map(name => GA_CLUBS.find(c => c.name === name)).filter(Boolean)
  ];

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
