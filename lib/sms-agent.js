/**
 * lib/sms-agent.js — Natural Language SMS Tee Time Agent
 *
 * Receives a text message like:
 *   "what tee times are available at Atlanta National this weekend?"
 *   "show me morning times at Laurel Springs Saturday"
 *   "any times at Eagle Watch this week?"
 *
 * Uses Claude Haiku to parse the query into structured intent, then
 * filters the local availability.json cache and returns a TwiML response.
 *
 * No SDK needed for Twilio — we just return TwiML XML.
 * Requires: ANTHROPIC_API_KEY in environment.
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const AVAILABILITY_FILE = path.join(__dirname, '..', 'availability.json');

// ── Claude Haiku API call (raw HTTPS, no SDK) ────────────────────────────────

function callClaude(systemPrompt, userMessage) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userMessage }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'Content-Length':    Buffer.byteLength(body),
        'x-api-key':         process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
    }, res => {
      let buf = '';
      res.on('data', chunk => buf += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(buf);
          const text = parsed?.content?.[0]?.text || '';
          resolve(text);
        } catch {
          reject(new Error(`Claude API invalid JSON: ${buf.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Returns an array of ISO date strings (YYYY-MM-DD) for the current week
 * Saturday and Sunday, and next weekend's Saturday and Sunday.
 */
function getUpcomingWeekendDates() {
  const today = new Date();
  const dow = today.getDay(); // 0=Sun, 6=Sat
  const dates = [];

  // This Saturday
  const thisSat = new Date(today);
  thisSat.setDate(today.getDate() + ((6 - dow + 7) % 7));
  dates.push(toISO(thisSat));

  // This Sunday
  const thisSun = new Date(thisSat);
  thisSun.setDate(thisSat.getDate() + 1);
  dates.push(toISO(thisSun));

  // Next Saturday
  const nextSat = new Date(thisSat);
  nextSat.setDate(thisSat.getDate() + 7);
  dates.push(toISO(nextSat));

  // Next Sunday
  const nextSun = new Date(thisSun);
  nextSun.setDate(thisSun.getDate() + 7);
  dates.push(toISO(nextSun));

  return dates;
}

function getThisWeekDates() {
  const today = new Date();
  const dates = [];
  for (let i = 0; i <= 6; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    dates.push(toISO(d));
  }
  return dates;
}

function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDate(isoStr) {
  const [y, m, d] = isoStr.split('-');
  const date = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// ── Club name fuzzy match ────────────────────────────────────────────────────

function findMatchingClubs(availabilityResults, clubQuery) {
  if (!clubQuery || clubQuery.toLowerCase() === 'all') return availabilityResults;

  const q = clubQuery.toLowerCase();
  return availabilityResults.filter(r => r.clubName.toLowerCase().includes(q));
}

// ── Load availability ────────────────────────────────────────────────────────

function loadAvailability() {
  try {
    if (!fs.existsSync(AVAILABILITY_FILE)) return null;
    return JSON.parse(fs.readFileSync(AVAILABILITY_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// ── Format tee time results into SMS-friendly text ───────────────────────────

function formatResults(matchingResults, maxSlots = 8) {
  if (!matchingResults || matchingResults.length === 0) {
    return 'No tee times found for your search. Try a different date or club.';
  }

  // Group by club
  const byClub = {};
  for (const r of matchingResults) {
    if (!r.slots || r.slots.length === 0) continue;
    const key = r.clubName;
    if (!byClub[key]) byClub[key] = [];
    byClub[key].push({ date: r.date, slots: r.slots });
  }

  if (Object.keys(byClub).length === 0) {
    return 'No open tee times found for that search.';
  }

  const lines = [];
  let totalShown = 0;

  for (const [club, dateEntries] of Object.entries(byClub)) {
    // Shorten club name: "Laurel Springs Golf Club" → "Laurel Springs"
    const shortName = club.replace(/ Golf Club| Golf & Country Club| Country Club| Golf$/i, '').trim();
    lines.push(`\n⛳ ${shortName}:`);

    for (const { date, slots } of dateEntries) {
      const dateLabel = formatDate(date);
      const slotParts = slots
        .slice(0, 4)
        .map(s => `${s.display}(${s.slotsAvailable})`);

      lines.push(`  ${dateLabel}: ${slotParts.join(', ')}`);
      totalShown += slots.length;
      if (totalShown >= maxSlots) break;
    }
    if (totalShown >= maxSlots) break;
  }

  lines.push('\nReply with a club name for more details.');
  return lines.join('\n').trim();
}

// ── Parse intent with Claude ─────────────────────────────────────────────────

async function parseQueryIntent(userMessage) {
  const today = toISO(new Date());
  const todayDay = new Date().toLocaleDateString('en-US', { weekday: 'long' });

  const systemPrompt = `You are a golf tee time assistant. Parse the user's SMS message into a JSON object with these fields:
- clubs: array of club name fragments to search (e.g. ["Atlanta National", "Laurel Springs"]), or ["all"] if no specific club mentioned
- dateScope: one of "this_weekend", "next_weekend", "this_week", "today", "tomorrow", "saturday", "sunday", or "specific"
- specificDate: ISO date string (YYYY-MM-DD) only when dateScope is "specific", otherwise null
- timePreference: "morning" (before noon), "afternoon" (noon+), "any"
- maxResults: number of time slots to return (default 8)

Today is ${todayDay}, ${today}.

Respond ONLY with valid JSON. No explanation. Example:
{"clubs":["Atlanta National"],"dateScope":"this_weekend","specificDate":null,"timePreference":"morning","maxResults":8}`;

  const raw = await callClaude(systemPrompt, userMessage);

  // Extract JSON from the response
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Claude returned no JSON: ${raw}`);
  return JSON.parse(match[0]);
}

// ── Resolve dates from intent ────────────────────────────────────────────────

function resolveDates(intent) {
  const { dateScope, specificDate } = intent;

  switch (dateScope) {
    case 'this_weekend':
    case 'next_weekend': {
      const weekendDates = getUpcomingWeekendDates();
      return dateScope === 'this_weekend' ? weekendDates.slice(0, 2) : weekendDates.slice(2, 4);
    }
    case 'this_week':
      return getThisWeekDates();
    case 'today':
      return [toISO(new Date())];
    case 'tomorrow': {
      const t = new Date();
      t.setDate(t.getDate() + 1);
      return [toISO(t)];
    }
    case 'saturday': {
      const today = new Date();
      const sat = new Date(today);
      sat.setDate(today.getDate() + ((6 - today.getDay() + 7) % 7));
      return [toISO(sat)];
    }
    case 'sunday': {
      const today = new Date();
      const sun = new Date(today);
      sun.setDate(today.getDate() + ((0 - today.getDay() + 7) % 7 || 7));
      return [toISO(sun)];
    }
    case 'specific':
      return specificDate ? [specificDate] : getUpcomingWeekendDates().slice(0, 2);
    default:
      return getUpcomingWeekendDates().slice(0, 2);
  }
}

// ── Filter availability by intent ────────────────────────────────────────────

function filterByIntent(availability, intent) {
  const targetDates = new Set(resolveDates(intent));
  let results = availability.results || [];

  // Filter to target dates
  results = results.filter(r => targetDates.has(r.date));

  // Filter by club
  if (intent.clubs && !intent.clubs.includes('all')) {
    const filtered = [];
    for (const clubQuery of intent.clubs) {
      filtered.push(...findMatchingClubs(results, clubQuery));
    }
    // Deduplicate
    const seen = new Set();
    results = filtered.filter(r => {
      const k = `${r.clubName}:${r.date}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // Filter by time preference
  if (intent.timePreference === 'morning') {
    results = results.map(r => ({
      ...r,
      slots: (r.slots || []).filter(s => s.hour < 12),
    })).filter(r => r.slots.length > 0);
  } else if (intent.timePreference === 'afternoon') {
    results = results.map(r => ({
      ...r,
      slots: (r.slots || []).filter(s => s.hour >= 12),
    })).filter(r => r.slots.length > 0);
  }

  return results;
}

// ── Build TwiML response ─────────────────────────────────────────────────────

function buildTwiML(message) {
  // Escape XML special chars
  const safe = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}

// ── Main handler (called from server-v1.js) ──────────────────────────────────

/**
 * Handle an inbound SMS from Twilio.
 * @param {string} body  The raw text of the SMS (Twilio `Body` field)
 * @returns {string}     TwiML XML to return to Twilio
 */
async function handleSMS(body) {
  const trimmed = (body || '').trim();

  if (!trimmed) {
    return buildTwiML(
      'Hi! Ask me about tee times:\n• "What times are at Atlanta National this weekend?"\n• "Morning tee times Saturday"\n• "All clubs Sunday"'
    );
  }

  // Help commands
  const lower = trimmed.toLowerCase();
  if (['help', 'hi', 'hello', 'hey'].includes(lower)) {
    return buildTwiML(
      '⛳ ClubCompanion\n\nAsk me things like:\n• "Atlanta National this weekend"\n• "Morning times at Laurel Springs Saturday"\n• "All clubs Sunday"\n\nReply with any question about tee times!'
    );
  }

  // Load availability
  const availability = loadAvailability();
  if (!availability) {
    return buildTwiML(
      'Tee time data is refreshing. Try again in a minute! ⛳'
    );
  }

  // Check if data is stale (>2 hours old)
  const generatedAt = availability.generatedAt;
  if (generatedAt) {
    const age = Date.now() - new Date(generatedAt).getTime();
    if (age > 2 * 60 * 60 * 1000) {
      console.warn('[sms-agent] Availability data is stale:', generatedAt);
    }
  }

  try {
    // Parse intent with Claude
    const intent = await parseQueryIntent(trimmed);
    console.log('[sms-agent] Intent:', JSON.stringify(intent));

    // Filter availability
    const results = filterByIntent(availability, intent);

    // Format response
    const text = formatResults(results, intent.maxResults || 8);

    // Prepend the query date range for context
    const dates = resolveDates(intent);
    const dateRange = dates.length === 1
      ? formatDate(dates[0])
      : `${formatDate(dates[0])} – ${formatDate(dates[dates.length - 1])}`;

    const response = `Tee times for ${dateRange}:\n\n${text}`;
    return buildTwiML(response);

  } catch (err) {
    console.error('[sms-agent] Error:', err.message);

    // Fallback: show all weekend times without AI parsing
    const weekendDates = new Set(getUpcomingWeekendDates().slice(0, 2));
    const results = (availability.results || []).filter(r => weekendDates.has(r.date));
    const text = formatResults(results);
    return buildTwiML(`This weekend's tee times:\n\n${text}`);
  }
}

module.exports = { handleSMS, buildTwiML };
