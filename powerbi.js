/**
 * powerbi.js — Push tee time availability data to a Power BI Streaming Dataset
 *
 * Setup (one-time, ~2 minutes):
 *   1. Go to app.powerbi.com → New → Streaming dataset → API → Next
 *   2. Name it "Tee Time Availability"
 *   3. Add these fields exactly:
 *        ClubName           Text
 *        Date               Text
 *        DayOfWeek          Text
 *        Time               Text
 *        Hour               Number
 *        SlotsAvailable     Number
 *        InPreferredWindow  True/False
 *        ScrapedAt          DateTime
 *   4. Toggle "Historic data analysis" ON (lets you build charts over time)
 *   5. Click Create → copy the Push URL
 *   6. Paste it into config.json → powerbi.pushUrl
 *   7. Set powerbi.enabled to true
 *
 * After each scrape, check-availability.js calls pushToPowerBI(allResults).
 * Every open slot becomes one row in Power BI — you can then build:
 *   - A card showing total open slots right now
 *   - A bar chart of slots per club
 *   - A line chart of slot availability over the day
 *   - A table filtered to your preferred time window
 *   - All of it refreshing automatically in the Power BI mobile app
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

function configured() {
  const pbi = loadConfig().powerbi;
  return !!(pbi?.enabled && pbi?.pushUrl && !pbi.pushUrl.startsWith('YOUR'));
}

/**
 * Convert raw scrape results into flat Power BI rows.
 * One row per open slot — makes filtering/charting in Power BI straightforward.
 */
function buildRows(allResults, config) {
  const rows       = [];
  const scrapedAt  = new Date().toISOString();
  const timeRange  = config?.booking?.homeClub?.preferredTimeRange || {};
  const earliest   = timeRange.earliestHour ?? 6;
  const latest     = timeRange.latestHour   ?? 11;

  for (const result of allResults) {
    if (result.error || result.unavailable) continue;

    const dayOfWeek = new Date(result.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
    const openSlots = (result.slots || []).filter(s => s.slotsAvailable > 0);

    for (const slot of openSlots) {
      rows.push({
        ClubName:          result.clubName,
        Date:              result.date,
        DayOfWeek:         dayOfWeek,
        Time:              slot.display,
        Hour:              slot.hour,
        SlotsAvailable:    slot.slotsAvailable,
        InPreferredWindow: slot.hour >= earliest && slot.hour <= latest,
        ScrapedAt:         scrapedAt
      });
    }
  }

  return rows;
}

/**
 * POST rows to the Power BI streaming dataset push URL.
 * Uses Node's built-in https — no npm packages needed.
 */
async function pushToPowerBI(allResults) {
  if (!configured()) {
    console.log('[powerbi] Skipped — set powerbi.enabled=true and add pushUrl to config.json');
    return { skipped: true };
  }

  const config = loadConfig();
  const rows   = buildRows(allResults, config);

  if (rows.length === 0) {
    console.log('[powerbi] No open slots to push');
    return { skipped: true, reason: 'no open slots' };
  }

  const pushUrl = config.powerbi.pushUrl;
  const url     = new URL(pushUrl);
  const body    = JSON.stringify(rows);

  return new Promise((resolve) => {
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[powerbi] ✅ Pushed ${rows.length} rows (${new Set(rows.map(r => r.ClubName)).size} clubs)`);
          resolve({ success: true, rowsPushed: rows.length });
        } else {
          console.error(`[powerbi] ❌ Push failed — HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
          resolve({ error: `HTTP ${res.statusCode}`, body: data.slice(0, 200) });
        }
      });
    });

    req.on('error', err => {
      console.error('[powerbi] ❌ Request error:', err.message);
      resolve({ error: err.message });
    });

    req.write(body);
    req.end();
  });
}

module.exports = { pushToPowerBI, configured, buildRows };
