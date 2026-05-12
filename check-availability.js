/**
 * check-availability.js — Invited Clubs Multi-Club Availability Dashboard
 *
 * Portal navigation (confirmed from live inspection 2026-05-10):
 *   - HOME screen selectors:
 *       State:  #cc-tt-network-state  (values: "GA", "TX", etc.)
 *       Club:   #cc-tt-network-club   (entity IDs, populated after state select)
 *       Home:   <button id="home_club">Continue to Home Club</button>
 *   - Selecting from #cc-tt-network-club auto-navigates (no submit needed)
 *   - Date tabs: <td id="Tab-YYYYMMDD">
 *   - Forward arrow: last non-Tab td in the tab row
 *   - Tee time rows: [Reserve+][Multigrab][Course][Play Date][Tee Time][Slots Available]
 *
 * Architecture: one browser context per club, all target dates scraped in one pass.
 *
 * Usage:
 *   node check-availability.js               # today + next 6 days
 *   node check-availability.js --days 3      # today + next N days
 *   node check-availability.js --date 2026-05-17   # specific date only
 */

const { chromium } = require('playwright');
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const { pushToPowerBI } = require('./powerbi');

const SESSION_FILE   = path.join(__dirname, 'session.json');
const CONFIG_FILE    = path.join(__dirname, 'config.json');
const DASHBOARD_FILE = path.join(__dirname, 'dashboard.html');

// Session/config only required when running as CLI (not when required as module)
const IS_CLI = require.main === module;

if (IS_CLI && !fs.existsSync(SESSION_FILE)) {
  console.error('❌ session.json not found. Run 1-SETUP.command first.');
  process.exit(1);
}

const session = IS_CLI ? JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) : {};
const config  = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};

const MEMBER_ID  = session.memberId || '1f91ea2ca7949314f2a02ad6046e5b8e';
const BASE_URL   = 'https://apps.invitedclubs.com/portal/pls/portal/!CCTTWEB.controller';
const PORTAL_URL = `${BASE_URL}?ID=${MEMBER_ID}`;

// ── Georgia Invited Clubs ─────────────────────────────────────────────────────
const GA_CLUBS = [
  { name: 'Laurel Springs Golf Club',         home: true           },
  // Bear's Best Atlanta (01682) skipped — not available on portal
  { name: 'Brookfield Country Club',          entity: '02771'      },
  { name: 'The Clubs of Peachtree City',      entity: '02812'      },
  { name: 'Windermere Golf Club',             entity: '02820'      },
  { name: 'Eagle Watch Golf Club',            entity: '02832'      },
  { name: 'Polo Golf & Country Club',         entity: '02845'      },
  { name: 'Atlanta National Golf Club',       entity: '02847'      },
  { name: 'Brookstone Golf & Country Club',   entity: '03181'      },
];

// ── Target dates ─────────────────────────────────────────────────────────────
const cliArgs    = process.argv.slice(2);
const dateArgIdx = cliArgs.indexOf('--date');
const daysArgIdx = cliArgs.indexOf('--days');
const HEADLESS   = cliArgs.includes('--headless');
let targetDates  = [];

if (dateArgIdx !== -1 && cliArgs[dateArgIdx + 1]) {
  targetDates = [cliArgs[dateArgIdx + 1]];
} else {
  const numDays = daysArgIdx !== -1 ? parseInt(cliArgs[daysArgIdx + 1]) || 7 : 7;
  const today   = new Date();
  for (let i = 0; i < numDays; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    targetDates.push(d.toISOString().split('T')[0]);
  }
}

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

function isoToLabel(iso) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Poll until condition is true — resilient to navigation context resets ─────
async function pollUntil(page, condFn, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await condFn()) return true;
    } catch (e) {
      // Ignore context-destroyed / navigation errors and keep polling
      if (!e.message) throw e;
      const msg = e.message.toLowerCase();
      if (!msg.includes('context') && !msg.includes('navigation') && !msg.includes('target closed')) throw e;
    }
    await sleep(200);
  }
  return false;
}

// ── Click via DOM .click() — triggers trusted events including form submit ────
async function jsClick(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) { el.click(); return true; }  // .click() is trusted, submits forms
    return false;
  }, selector);
}

// ── Dismiss the jQuery UI Messages popup ──────────────────────────────────────
// Uses direct DOM dispatch — bypasses any overlay interception.
async function dismissNotice(page) {
  await page.evaluate(() => {
    // Try every button on the page looking for "Dismiss"
    for (const btn of document.querySelectorAll('button, input[type="button"], input[type="submit"]')) {
      const label = (btn.textContent || btn.value || '').trim();
      if (label.includes('Dismiss')) {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return;
      }
    }
    // jQuery UI fallback
    if (typeof $ !== 'undefined') {
      try { $('#popup_message').closest('.ui-dialog').find('button').first().trigger('click'); } catch(e) {}
    }
  });
  // Wait up to 3s for the overlay to disappear
  await pollUntil(page,
    () => page.evaluate(() => !document.querySelector('.ui-widget-overlay')),
    3000
  );
  await sleep(200);
}

// ── Navigate to a club within a live session ─────────────────────────────────
// Uses window.location.href (in-page navigation) — EVENT=HASH only works in
// a continuous live session, not with restored cookies in a new context.
async function goToClub(page, club) {
  const clubPath = club.home
    ? '/portal/pls/portal/!CCTTWEB.controller?EVENT=HASH&ACT=VIEW&LOC=CONT'
    : `/portal/pls/portal/!CCTTWEB.controller?EVENT=HASH&ACT=VIEW&LOC=NTWK&ENTITY=${club.entity}`;

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 25000 }).catch(() => {}),
    page.evaluate((p) => { window.location.href = p; }, clubPath)
  ]);
  await sleep(400);

  const hasTabs = await pollUntil(page,
    () => page.evaluate(() => !!document.querySelector('div[id^="Tab-2"]')).catch(() => false),
    12000
  );
  if (hasTabs) await dismissNotice(page);
  return hasTabs;
}

// ── Detect and clear a portal "system error" popup ───────────────────────────
async function hasSystemError(page) {
  return page.evaluate(() => {
    const txt = document.body?.innerText?.toLowerCase() || '';
    return txt.includes('system error') || txt.includes('please try your request later');
  }).catch(() => false);
}

// ── Scrape one club using the shared live-session page ───────────────────────
async function scrapeClub(page, club) {
  const results = [];
  try {
    let ok = await goToClub(page, club);

    // Retry up to 2 times on system error or nav failure
    for (let retry = 0; retry < 2 && (!ok || await hasSystemError(page)); retry++) {
      log(`    ⚠️  System error or nav failed — retrying (${retry + 1}/2) in 3s...`);
      await sleep(3000);
      ok = await goToClub(page, club);
    }

    if (!ok) {
      fs.writeFileSync(path.join(__dirname, `debug-nav-${club.entity||'home'}.html`), await page.content());
      return targetDates.map(date => ({ clubName: club.name, date, slots: [], error: 'Navigation failed – re-run 1-SETUP.command' }));
    }

    for (const date of targetDates) {
      const found = await navigateToDate(page, date);
      if (!found) {
        results.push({ clubName: club.name, date, slots: [], unavailable: true });
        continue;
      }

      // Detect system error on this date — retry up to 2 times
      for (let retry = 0; retry < 2 && await hasSystemError(page); retry++) {
        log(`    ⚠️  System error on ${date} — retrying (${retry + 1}/2)...`);
        await sleep(2000);
        await goToClub(page, club);
        await navigateToDate(page, date);
      }

      const slots = await parseSlots(page, date);
      results.push({ clubName: club.name, date, slots, error: null });
    }
  } catch (err) {
    const remaining = targetDates.filter(d => !results.find(r => r.date === d));
    remaining.forEach(date => results.push({
      clubName: club.name, date, slots: [], error: err.message.slice(0, 80)
    }));
    fs.writeFileSync(path.join(__dirname, `debug-err-${club.entity||'home'}.html`),
      await page.content().catch(() => ''));
  }
  return results;
}


// ── Dashboard HTML ─────────────────────────────────────────────────────────────
// ── Navigate to a specific date tab ──────────────────────────────────────────
// Tabs: <div id="Tab-YYYYMMDD"> — click via element.click(), triggers jQuery
// After click, AJAX loads content into <div id="Div-YYYYMMDD">
// Forward button: <div id="cc_tab_next">
async function navigateToDate(page, isoDate) {
  const dt   = new Date(isoDate + 'T12:00:00');
  const y    = dt.getFullYear();
  const mo   = String(dt.getMonth() + 1).padStart(2, '0');
  const d    = String(dt.getDate()).padStart(2, '0');
  const tabId = `Tab-${y}${mo}${d}`;
  const divId = `Div-${y}${mo}${d}`;

  for (let attempt = 0; attempt < 8; attempt++) {
    const clicked = await page.evaluate((tabId) => {
      const tab = document.getElementById(tabId);
      if (tab) { tab.click(); return true; }
      return false;
    }, tabId).catch(() => false);

    if (clicked) {
      await sleep(250); // let the AJAX request start
      // Wait for SheetDetails-YYYYMMDD to appear inside the date div
      await pollUntil(page, () => page.evaluate((dateStr) => {
        // SheetDetails-YYYYMMDD appears when the AJAX response has fully loaded
        const details = document.getElementById('SheetDetails-' + dateStr);
        if (details && details.innerHTML.trim().length > 20) return true;
        // Fallback: the whole Div has content
        const div = document.getElementById('Div-' + dateStr);
        return !!(div && div.innerHTML.trim().length > 100);
      }, `${y}${mo}${d}`).catch(() => false), 10000);
      await sleep(100);
      return true;
    }

    // Advance the date strip
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

// ── Parse tee times from the date's content div ───────────────────────────────
// Columns: [Reserve][...][Course][Play Date][Tee Time][Slots Available]
async function parseSlots(page, isoDate) {
  const dt   = new Date(isoDate + 'T12:00:00');
  const y    = dt.getFullYear();
  const mo   = String(dt.getMonth() + 1).padStart(2, '0');
  const d    = String(dt.getDate()).padStart(2, '0');
  const divId = `Div-${y}${mo}${d}`;


  return page.evaluate((divId) => {
    const container = document.getElementById(divId);
    if (!container || container.innerHTML.trim().length < 80) return [];

    const slots = [];
    const seen  = new Set();

    for (const row of container.querySelectorAll('tr')) {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 2) continue;

      // Scan every cell for a time pattern — don't rely on fixed column index
      let timeText = null, slotsAvail = NaN;
      for (let i = 0; i < cells.length; i++) {
        const txt = cells[i].textContent.trim();
        const tm = txt.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
        if (tm) {
          timeText = `${tm[1]}:${tm[2]} ${tm[3].toUpperCase()}`;
          // Slots Available is typically the cell immediately after the Tee Time cell
          for (let j = i + 1; j < cells.length; j++) {
            const raw = cells[j].textContent.trim();
            const n = parseInt(raw);
            if (!isNaN(n) && raw === String(n)) { // pure integer cell
              slotsAvail = n;
              break;
            }
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
    return slots;
  }, divId).catch(() => []);
}

function timeBucket(hour) {
  if (hour < 7)  return 'dawn';
  if (hour < 9)  return 'early';
  if (hour < 11) return 'morning';
  if (hour < 13) return 'midday';
  return 'afternoon';
}

function generateDashboard(results, generatedAt) {
  // Group by date
  const byDate = {};
  for (const d of targetDates) byDate[d] = { label: isoToLabel(d), clubs: [] };
  for (const r of results) if (byDate[r.date]) byDate[r.date].clubs.push(r);

  const allOpenSlots = results.reduce((s, r) => s + r.slots.filter(x => x.slotsAvailable > 0).length, 0);
  const clubsWithSlots = new Set(results.filter(r => r.slots.some(s => s.slotsAvailable > 0)).map(r => r.clubName)).size;

  const cardHtml = (c) => {
    if (c.unavailable) return `
      <div class="card none">
        <div class="cname">${c.clubName}</div>
        <div class="note">Not published for this date</div>
      </div>`;
    if (c.error) return `
      <div class="card err">
        <div class="cname">${c.clubName}</div>
        <div class="note">⚠️ ${c.error}</div>
      </div>`;
    const openSlots = c.slots.filter(s => s.slotsAvailable > 0);
    if (!openSlots.length) return `
      <div class="card none">
        <div class="cname">${c.clubName}</div>
        <div class="note">No available slots</div>
      </div>`;
    const badges = openSlots.map(s => {
      const bucket = timeBucket(s.hour);
      const plural = s.slotsAvailable === 1 ? 'slot' : 'slots';
      return `<span class="badge ${bucket}" data-bucket="${bucket}" data-slots="${s.slotsAvailable}" title="${s.slotsAvailable} player ${plural}">${s.display}<span class="badge-slots">${s.slotsAvailable}</span></span>`;
    }).join('');
    return `
      <div class="card avail">
        <div class="cname">${c.clubName}</div>
        <div class="cnt">${openSlots.length} open slot${openSlots.length !== 1 ? 's' : ''}</div>
        <div class="badges">${badges}</div>
      </div>`;
  };

  const dateNavLinks = Object.entries(byDate).map(([iso, data]) => {
    const d = new Date(iso + 'T12:00:00');
    const dayAbbr = d.toLocaleDateString('en-US', { weekday: 'short' });
    const dayNum  = d.getDate();
    const n = data.clubs.filter(c => c.slots.some(s => s.slotsAvailable > 0)).length;
    return `<a href="#date-${iso}" class="date-link${n > 0 ? ' has-slots' : ''}">
      <span class="dl-day">${dayAbbr}</span>
      <span class="dl-num">${dayNum}</span>
      ${n > 0 ? `<span class="dl-count">${n}</span>` : ''}
    </a>`;
  }).join('');

  const sections = Object.entries(byDate).map(([iso, data]) => {
    const n = data.clubs.filter(c => c.slots.some(s => s.slotsAvailable > 0)).length;
    return `
    <section id="date-${iso}">
      <div class="dheader">
        <h2>${data.label}</h2>
        <span class="dsub">${n} club${n !== 1 ? 's' : ''} with open slots</span>
      </div>
      <div class="grid">${data.clubs.map(cardHtml).join('')}</div>
    </section>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invited Clubs — Tee Times</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1923;color:#e8f0e9;min-height:100vh}

/* Header */
header{background:linear-gradient(135deg,#1a3a1a,#0f2415);border-bottom:2px solid #2d5a2d;padding:18px 28px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;position:sticky;top:0;z-index:50}
.htitle{font-size:20px;font-weight:700;color:#7ec87e}
.hsub{font-size:12px;color:#8a9e8a;margin-top:3px}
.htime{font-size:11px;color:#5a6e5a;margin-top:3px}
.stats{display:flex;gap:12px}
.stat{text-align:center;background:rgba(126,200,126,.08);border:1px solid rgba(126,200,126,.2);border-radius:8px;padding:8px 16px}
.stat-n{font-size:22px;font-weight:700;color:#7ec87e}
.stat-l{font-size:11px;color:#7a8e7a;text-transform:uppercase;letter-spacing:.5px;margin-top:1px}
.refresh-btn{display:flex;flex-direction:column;align-items:center;gap:4px;background:rgba(126,200,126,.1);border:1px solid #3a6a3a;border-radius:10px;color:#7ec87e;padding:10px 18px;cursor:pointer;font-family:inherit;font-size:13px;font-weight:600;transition:all .2s;min-width:110px}
.refresh-btn:hover{background:rgba(126,200,126,.2);border-color:#5a9a5a;color:#a8e8a8}
.refresh-btn:active{transform:scale(.97)}
.refresh-btn svg{width:18px;height:18px}
.refresh-btn.spinning svg{animation:spin 1s linear infinite}
.refresh-btn .rbsub{font-size:10px;color:#5a8a5a;font-weight:400}
.refresh-btn.updated{border-color:#7ec87e;background:rgba(126,200,126,.25)}
@keyframes spin{to{transform:rotate(360deg)}}

/* Date nav strip */
.date-nav{background:#111d11;border-bottom:1px solid #1e3a1e;padding:10px 28px;display:flex;gap:8px;overflow-x:auto}
.date-link{display:flex;flex-direction:column;align-items:center;padding:6px 12px;border-radius:8px;text-decoration:none;color:#5a8a5a;border:1px solid transparent;min-width:52px;position:relative;transition:all .15s}
.date-link:hover{background:rgba(126,200,126,.08);color:#a8d8a8}
.date-link.has-slots{color:#c8e6c8;border-color:#2a4e2a;background:rgba(126,200,126,.06)}
.dl-day{font-size:10px;text-transform:uppercase;letter-spacing:.5px}
.dl-num{font-size:18px;font-weight:700;line-height:1.1}
.dl-count{position:absolute;top:3px;right:3px;background:#7ec87e;color:#0f1923;font-size:9px;font-weight:700;border-radius:8px;padding:1px 4px}

/* Toolbar */
.toolbar{padding:14px 28px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #1a2a1a}
.toolbar input{background:#141f14;border:1px solid #2a4a2a;color:#c8e6c8;padding:6px 14px;border-radius:8px;font-size:13px;width:200px;outline:none}
.toolbar input:focus{border-color:#3a6a3a}
.filter-group{display:flex;gap:6px;flex-wrap:wrap}
.fbtn{padding:5px 14px;border-radius:20px;border:1px solid #2a4a2a;background:transparent;color:#7a9e7a;font-size:12px;cursor:pointer;transition:all .15s}
.fbtn:hover{background:rgba(126,200,126,.08);color:#c8e6c8}
.fbtn.on{background:rgba(126,200,126,.15);color:#c8e6c8;border-color:#3a6a3a}
.filter-label{font-size:12px;color:#5a7a5a;align-self:center}

/* Main grid */
main{padding:20px 28px;max-width:1500px;margin:0 auto}
section{margin-bottom:36px}
.dheader{display:flex;align-items:baseline;gap:12px;margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid #1e3a1e}
.dheader h2{font-size:18px;font-weight:600;color:#c8e6c8}
.dsub{font-size:12px;color:#7ec87e;background:rgba(126,200,126,.1);padding:2px 10px;border-radius:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}

/* Cards */
.card{background:#141f14;border:1px solid #1e3a1e;border-radius:10px;padding:14px;transition:transform .12s}
.card:hover{transform:translateY(-1px)}
.card.avail{border-color:#2a4e2a}
.card.none{opacity:.45}
.card.err{border-color:#4e2a2a;opacity:.55}
.cname{font-size:13px;font-weight:600;color:#c8e6c8;margin-bottom:6px}
.cnt{font-size:11px;color:#7ec87e;margin-bottom:8px}
.note{font-size:11px;color:#4a6a4a}

/* Badges (time slots) */
.badges{display:flex;flex-wrap:wrap;gap:5px}
.badge{font-size:11px;font-weight:600;padding:3px 7px 3px 9px;border-radius:5px;cursor:default;display:inline-flex;align-items:center;gap:5px}
.badge.dawn    {background:#1a1a3a;color:#9090e8;border:1px solid #2a2a5a}
.badge.early   {background:#1a3a1a;color:#7ec87e;border:1px solid #3a6a3a}
.badge.morning {background:#1e3218;color:#a8d898;border:1px solid #2e5228}
.badge.midday  {background:#2a2a18;color:#d8d898;border:1px solid #4a4a28}
.badge.afternoon{background:#1a1a2a;color:#a8a8c8;border:1px solid #2a2a4a}
.badge-slots{background:rgba(255,255,255,.13);border-radius:3px;padding:1px 5px;font-size:10px;font-weight:700;min-width:16px;text-align:center}

footer{text-align:center;padding:20px;color:#3a5a3a;font-size:11px;border-top:1px solid #1a3a1a;margin-top:20px}
</style>
</head>
<body>
<div id="update-banner" style="display:none;background:#2a4e2a;border-bottom:1px solid #3a7a3a;padding:10px 28px;text-align:center;font-size:13px;color:#a8e8a8">
  🔄 New data available — <a href="javascript:window.location.reload()" style="color:#7ec87e;font-weight:700">Click to reload</a>
</div>
<header>
  <div>
    <div class="htitle">⛳ Invited Clubs — Tee Time Dashboard</div>
    <div class="hsub">All Georgia clubs · ${targetDates.length}-day view</div>
    <div class="htime" id="last-updated">Updated: ${generatedAt}</div>
  </div>
  <div style="display:flex;gap:12px;align-items:center">
    <div class="stats">
      <div class="stat"><div class="stat-n">${clubsWithSlots}</div><div class="stat-l">Clubs Open</div></div>
      <div class="stat"><div class="stat-n">${allOpenSlots}</div><div class="stat-l">Total Slots</div></div>
    </div>
    <button class="refresh-btn" id="refreshBtn" onclick="manualRefresh()" title="Reload page to see latest data">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
      Refresh
      <span class="rbsub" id="refresh-status">Auto-checking…</span>
    </button>
  </div>
</header>

<nav class="date-nav">${dateNavLinks}</nav>

<div class="toolbar">
  <input type="text" id="search" placeholder="Search club…" oninput="applyFilters()">
  <span class="filter-label">Time:</span>
  <div class="filter-group" id="timeFilters">
    <button class="fbtn on" data-bucket="all"       onclick="toggleBucket('all',this)">All day</button>
    <button class="fbtn"    data-bucket="dawn"      onclick="toggleBucket('dawn',this)">Before 7am</button>
    <button class="fbtn"    data-bucket="early"     onclick="toggleBucket('early',this)">7–9am</button>
    <button class="fbtn"    data-bucket="morning"   onclick="toggleBucket('morning',this)">9–11am</button>
    <button class="fbtn"    data-bucket="midday"    onclick="toggleBucket('midday',this)">11am–1pm</button>
    <button class="fbtn"    data-bucket="afternoon" onclick="toggleBucket('afternoon',this)">After 1pm</button>
  </div>
  <span class="filter-label">Players:</span>
  <div class="filter-group" id="playerFilters">
    <button class="fbtn on" data-min="1" onclick="togglePlayers(1,this)">Any</button>
    <button class="fbtn"    data-min="2" onclick="togglePlayers(2,this)">2+</button>
    <button class="fbtn"    data-min="3" onclick="togglePlayers(3,this)">3+</button>
    <button class="fbtn"    data-min="4" onclick="togglePlayers(4,this)">4+</button>
  </div>
  <button class="fbtn" id="hideEmptyBtn" onclick="toggleHideEmpty(this)">Hide unavailable</button>
</div>

<main>${sections}</main>
<footer>Run <strong>2-DASHBOARD.command</strong> to fetch fresh tee times · Shows today + ${targetDates.length - 1} days · Page auto-checks for updates every 60s</footer>

<script>
let activeBucket = 'all';
let minPlayers   = 1;
let hideEmpty    = false;

function toggleBucket(bucket, btn) {
  activeBucket = bucket;
  document.querySelectorAll('#timeFilters .fbtn').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  applyFilters();
}

function togglePlayers(min, btn) {
  minPlayers = min;
  document.querySelectorAll('#playerFilters .fbtn').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  applyFilters();
}

function toggleHideEmpty(btn) {
  hideEmpty = !hideEmpty;
  btn.classList.toggle('on');
  applyFilters();
}

function applyFilters() {
  const q = (document.getElementById('search').value || '').toLowerCase();

  document.querySelectorAll('.card').forEach(card => {
    const name = (card.querySelector('.cname')?.textContent || '').toLowerCase();

    // Search filter
    if (q && !name.includes(q)) { card.style.display = 'none'; return; }

    // Hide unavailable
    if (hideEmpty && !card.classList.contains('avail')) { card.style.display = 'none'; return; }

    card.style.display = '';

    // Badge visibility: apply BOTH time bucket AND player count filters
    card.querySelectorAll('.badge').forEach(b => {
      const bucketMatch  = activeBucket === 'all' || b.dataset.bucket === activeBucket;
      const playersMatch = parseInt(b.dataset.slots || '4') >= minPlayers;
      b.style.display = (bucketMatch && playersMatch) ? '' : 'none';
    });

    // Hide avail card if no badges are visible after filtering
    if (card.classList.contains('avail')) {
      const visibleBadges = Array.from(card.querySelectorAll('.badge')).filter(b => b.style.display !== 'none');
      if (visibleBadges.length === 0) card.style.display = 'none';
    }
  });
}

// ── Auto-refresh: poll availability.json every 60s for a newer timestamp ──────
const CURRENT_TS = ${JSON.stringify(generatedAt)};
let lastKnownTs  = CURRENT_TS;
let pollTimer    = null;

function timeSince(ts) {
  // ts is a locale string like "Sun, May 10, 8:42 AM" — just display it
  return ts;
}

function updateRefreshStatus(text) {
  const el = document.getElementById('refresh-status');
  if (el) el.textContent = text;
}

async function checkForUpdates() {
  try {
    // Cache-bust so the browser fetches fresh availability.json each poll
    const res = await fetch('./availability.json?_=' + Date.now());
    if (!res.ok) { updateRefreshStatus('Check failed'); return; }
    const data = await res.json();
    const newTs = data.generatedAt;

    if (newTs && newTs !== lastKnownTs) {
      lastKnownTs = newTs;
      // Show banner + update status
      document.getElementById('update-banner').style.display = '';
      document.getElementById('refreshBtn').classList.add('updated');
      updateRefreshStatus('New data ready!');
      clearInterval(pollTimer); // stop polling once update found
    } else {
      // Format next check time
      const next = new Date(Date.now() + 60000);
      const hh = next.getHours(), mm = String(next.getMinutes()).padStart(2,'0');
      const ampm = hh >= 12 ? 'PM' : 'AM';
      updateRefreshStatus('Next check ' + (hh % 12 || 12) + ':' + mm + ' ' + ampm);
    }
  } catch(e) {
    updateRefreshStatus('Offline');
  }
}

function manualRefresh() {
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('spinning');
  updateRefreshStatus('Checking…');
  // Reload the page to pick up latest dashboard.html
  setTimeout(() => window.location.reload(), 400);
}

// Start polling 5s after load, then every 60s
setTimeout(() => {
  checkForUpdates();
  pollTimer = setInterval(checkForUpdates, 60000);
}, 5000);

// Show initial status
updateRefreshStatus('Checking in 5s…');
</script>
</body></html>`;
}

// ── Main — single live session, optional login prompt ────────────────────────
async function main() {
  log(`⛳  Invited Clubs Availability Check`);
  log(`📅  Dates: ${targetDates[0]} → ${targetDates[targetDates.length - 1]} (${targetDates.length} days)`);
  log(`🏌️  Clubs: ${GA_CLUBS.length}`);

  // In headless mode we still open a visible browser if the session is expired
  let browser = await chromium.launch({
    headless: HEADLESS,
    args: HEADLESS ? ['--no-sandbox'] : ['--start-maximized']
  });
  let context = await browser.newContext({ viewport: HEADLESS ? { width: 1280, height: 900 } : null });
  if (session.cookies?.length) await context.addCookies(session.cookies);
  let page = await context.newPage();

  // Load portal to check session validity
  log(`\nChecking session… (${HEADLESS ? 'headless' : 'visible browser'})`);
  await page.goto(PORTAL_URL, { waitUntil: 'networkidle', timeout: 25000 });

  const sessionOk = await page.evaluate(() => {
    const c = document.getElementById('cc_web_content');
    return !!(c && c.innerHTML.trim().length > 200);
  }).catch(() => false);

  if (!sessionOk || page.url().includes('login')) {
    if (HEADLESS) {
      // Re-launch as visible so the user can log in
      log('Session expired — reopening as visible browser for login...');
      await browser.close();
      browser  = await chromium.launch({ headless: false, args: ['--start-maximized'] });
      context  = await browser.newContext({ viewport: null });
      if (session.cookies?.length) await context.addCookies(session.cookies);
      page     = await context.newPage();
    }
    log('Session expired — please log in in the browser window.');
    log('Navigate to the members portal and log in, then come back and press Enter.\n');
    await page.goto('https://members.invitedclubs.com/club/scripts/login/login.asp');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise(resolve => rl.question('Press Enter once you are logged in... ', () => { rl.close(); resolve(); }));
    await page.goto(PORTAL_URL, { waitUntil: 'networkidle', timeout: 25000 });
  } else {
    log('Session valid ✅');
  }

  // Scrape all clubs in this single live session
  const allResults = [];
  for (const club of GA_CLUBS) {
    log(`\n  → ${club.name}…`);
    const clubResults = await scrapeClub(page, club);
    for (const r of clubResults) {
      const avail = r.slots.filter(s => s.slotsAvailable > 0).length;
      const icon  = avail > 0 ? '✅' : r.error ? '❌' : r.unavailable ? '—' : '·';
      log(`    ${icon}  ${r.date}: ${avail} open`);
      allResults.push(r);
    }
    await sleep(500);
  }

  // Save updated cookies for next run
  const updatedCookies = await context.cookies();
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ ...session, savedAt: new Date().toISOString(), cookies: updatedCookies }, null, 2));

  await browser.close();

  const generatedAt = new Date().toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  });

  fs.writeFileSync(DASHBOARD_FILE, generateDashboard(allResults, generatedAt));
  fs.writeFileSync(
    path.join(__dirname, 'availability.json'),
    JSON.stringify({ generatedAt, targetDates, results: allResults }, null, 2)
  );

  const openSlots = allResults.reduce((s, r) => s + r.slots.filter(x => x.slotsAvailable > 0).length, 0);
  const clubsOpen = new Set(allResults.filter(r => r.slots.some(s => s.slotsAvailable > 0)).map(r => r.clubName)).size;
  log('\n' + '═'.repeat(50));
  log(`  Clubs with open slots: ${clubsOpen}`);
  log(`  Total open slots:      ${openSlots}`);
  log(`  Dashboard:             ${DASHBOARD_FILE}`);
  log('═'.repeat(50));

  // Push to Power BI streaming dataset (if configured in config.json)
  await pushToPowerBI(allResults);
}

// ── Multi-tenant export ───────────────────────────────────────────────────────
// Called by user-runner.js with an injected config object.
// Logs in automatically using credentials, runs headless, returns results array.
async function run(injectedConfig) {
  const { loginToPortal } = require('./lib/login');
  const { chromium } = require('playwright');

  const username = injectedConfig?.credentials?.username;
  const password = injectedConfig?.credentials?.password;
  if (!username || !password) throw new Error('run() requires injectedConfig.credentials.username and .password');

  const { browser, context, page, memberId } = await loginToPortal(chromium, username, password);

  // Build target dates (next 7 days) — set module-level var used by scrapeClub
  const today = new Date();
  targetDates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    targetDates.push(d.toISOString().split('T')[0]);
  }

  const allResults = [];
  for (const club of GA_CLUBS) {
    const clubResults = await scrapeClub(page, club).catch(e => {
      console.error(`[run] Error scraping ${club.name}:`, e.message);
      return [];
    });
    allResults.push(...clubResults);
    await new Promise(r => setTimeout(r, 400));
  }

  await browser.close();
  return allResults;
}

module.exports = { run, GA_CLUBS };

// ── CLI entry point ───────────────────────────────────────────────────────────
if (require.main === module) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
