/**
 * debug-ajax.js — test the WEBTEETIME AJAX endpoint directly
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const session = JSON.parse(fs.readFileSync(path.join(__dirname, 'session.json')));
const MEMBER_ID = session.memberId || '1f91ea2ca7949314f2a02ad6046e5b8e';

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });
  await context.addCookies(session.cookies);
  const page = await context.newPage();

  // Navigate to Bear's Best to set club context
  const shellUrl = `https://apps.invitedclubs.com/portal/pls/portal/!CCTTWEB.controller?EVENT=HASH&ACT=VIEW&LOC=NTWK&ENTITY=01682&ID=${MEMBER_ID}`;
  console.log('Navigating to:', shellUrl);
  await page.goto(shellUrl, { waitUntil: 'networkidle', timeout: 30000 });
  console.log('After nav URL:', page.url());

  // Check what cookies look like now
  const cookies = await context.cookies('https://apps.invitedclubs.com');
  const entity = cookies.find(c => c.name === 'ENTITY');
  console.log('ENTITY cookie after nav:', entity?.value?.substring(0, 20) + '...');

  // Try calling the AJAX endpoint
  const result = await page.evaluate(async () => {
    const resp = await fetch('/portal/pls/portal/!ccttweb.controller?EVENT=WEBTEETIME&ACT=VIEW', {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'text/html' }
    });
    const text = await resp.text();
    return { status: resp.status, length: text.length, preview: text.substring(0, 500) };
  });

  console.log('\nAJAX Response:');
  console.log('  Status:', result.status);
  console.log('  Length:', result.length);
  console.log('  Preview:', result.preview);

  await browser.close();
}

main().catch(console.error);
