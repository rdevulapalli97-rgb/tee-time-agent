/**
 * diagnose.js — Step-by-step portal diagnostic
 * Run: node diagnose.js
 * Shows exactly what the page looks like at each step.
 */
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const session = JSON.parse(fs.readFileSync(path.join(__dirname, 'session.json'), 'utf8'));
const MEMBER_ID = session.memberId || '1f91ea2ca7949314f2a02ad6046e5b8e';
const PORTAL_URL = `https://apps.invitedclubs.com/portal/pls/portal/!CCTTWEB.controller?ID=${MEMBER_ID}`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('\n=== PORTAL DIAGNOSTIC ===\n');

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }
  });
  if (session.cookies?.length) await context.addCookies(session.cookies);
  const page = await context.newPage();

  // ── Step 1: Load portal ──────────────────────────────────────────────────
  console.log('Step 1: Loading portal...');
  await page.goto(PORTAL_URL, { waitUntil: 'networkidle', timeout: 30000 });
  console.log('  URL after load:', page.url());

  // Snapshot what's in the DOM
  const step1 = await page.evaluate(() => ({
    hasHomeCluBtn:   !!document.getElementById('home_club'),
    hasStateDropdown: !!document.getElementById('cc-tt-network-state'),
    hasTabDivs:       !!document.querySelector('div[id^="Tab-2"]'),
    hasTabTds:        !!document.querySelector('td[id^="Tab-"]'),
    hasModal:         !!document.getElementById('modalFormContainer'),
    hasUIDialog:      !!document.querySelector('.ui-dialog'),
    hasOverlay:       !!document.querySelector('.ui-widget-overlay'),
    allTabIds:        Array.from(document.querySelectorAll('[id^="Tab-"]')).map(e => e.id).slice(0, 10),
    dialogText:       document.querySelector('.ui-dialog')?.textContent?.trim().slice(0, 100) || 'none',
    bodyText:         document.body.innerText.slice(0, 300),
  }));
  console.log('  Step 1 snapshot:', JSON.stringify(step1, null, 4));

  fs.writeFileSync(path.join(__dirname, 'diag-step1.html'), await page.content());
  console.log('  Saved: diag-step1.html\n');

  // ── Step 2: Dismiss dialog if present ───────────────────────────────────
  if (step1.hasUIDialog) {
    console.log('Step 2: Dismissing Messages dialog...');
    try {
      // Try jQuery click (bypasses overlay interception)
      const dismissed = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.ui-dialog button'));
        const dismissBtn = btns.find(b => b.textContent.includes('Dismiss'));
        if (dismissBtn) { dismissBtn.click(); return true; }
        // fallback: close the dialog via jQuery UI
        if (typeof $ !== 'undefined') {
          const dlg = $('#popup_message');
          if (dlg.length) { dlg.dialog('close'); return 'jquery-close'; }
        }
        return false;
      });
      console.log('  Dismiss result:', dismissed);
      await sleep(800);
      const overlayGone = await page.evaluate(() => !document.querySelector('.ui-widget-overlay'));
      console.log('  Overlay gone:', overlayGone);
    } catch(e) {
      console.log('  Error dismissing:', e.message);
    }
  } else {
    console.log('Step 2: No dialog found — skipping dismiss.\n');
  }

  // ── Step 3: Look for home_club button or tabs ────────────────────────────
  console.log('Step 3: Looking for home_club button or date tabs...');
  await sleep(500);
  const step3 = await page.evaluate(() => ({
    hasHomeCluBtn:  !!document.getElementById('home_club'),
    hasTabDivs:     !!document.querySelector('div[id^="Tab-2"]'),
    tabDivIds:      Array.from(document.querySelectorAll('div[id^="Tab-2"]')).map(e => e.id),
    hasOverlay:     !!document.querySelector('.ui-widget-overlay'),
    ccWebContent:   document.getElementById('cc_web_content')?.innerHTML.slice(0, 200) || 'empty',
  }));
  console.log('  Step 3 snapshot:', JSON.stringify(step3, null, 4));

  // ── Step 4: Click home_club button if present ────────────────────────────
  if (step3.hasHomeCluBtn) {
    console.log('\nStep 4: Clicking #home_club button...');
    await page.evaluate(() => document.getElementById('home_club').click());
    await sleep(3000);
    const step4 = await page.evaluate(() => ({
      hasTabDivs:  !!document.querySelector('div[id^="Tab-2"]'),
      tabDivIds:   Array.from(document.querySelectorAll('div[id^="Tab-2"]')).map(e => e.id),
    }));
    console.log('  After click:', JSON.stringify(step4, null, 4));
    fs.writeFileSync(path.join(__dirname, 'diag-step4.html'), await page.content());
    console.log('  Saved: diag-step4.html');
  } else if (step3.hasTabDivs) {
    console.log('\nStep 4: Already on tee time view (no home_club button needed).');
  } else {
    console.log('\nStep 4: PROBLEM — no home_club button AND no date tabs!');
  }

  // ── Step 5: Try clicking the first date tab ──────────────────────────────
  console.log('\nStep 5: Trying to click Tab-20260511 (Monday)...');
  await sleep(500);
  const tabResult = await page.evaluate(() => {
    const tab = document.getElementById('Tab-20260511');
    if (!tab) return { found: false };
    tab.click();
    return { found: true, tabId: tab.id, classes: tab.className };
  });
  console.log('  Tab click result:', tabResult);

  if (tabResult.found) {
    await sleep(3000);
    const divContent = await page.evaluate(() => {
      const div = document.getElementById('Div-20260511');
      return {
        found: !!div,
        visible: div?.style.display !== 'none',
        htmlLength: div?.innerHTML.length || 0,
        preview: div?.innerHTML.slice(0, 300) || 'empty',
      };
    });
    console.log('  Div-20260511 after click:', JSON.stringify(divContent, null, 4));
    fs.writeFileSync(path.join(__dirname, 'diag-step5.html'), await page.content());
    console.log('  Saved: diag-step5.html');
  }

  console.log('\n=== DIAGNOSTIC COMPLETE ===');
  await browser.close();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
