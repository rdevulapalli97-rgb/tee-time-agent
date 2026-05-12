/**
 * history.js — Club availability pattern tracking
 *
 * Aggregates scrape results over time to learn:
 *   - Which clubs reliably have slots on which days of the week
 *   - Which time windows are typically available per club
 *   - Whether to skip a club on a given day (saves ~15-30s per club)
 *
 * history.json schema:
 * {
 *   version: 2,
 *   lastUpdated: ISO string,
 *   clubs: {
 *     "Club Name": {
 *       byDayOfWeek: {           // 0=Sun, 1=Mon, ..., 6=Sat
 *         "6": { runs: 12, withSlots: 10, score: 0.83, slots: ["8:10 AM", "7:30 AM"] }
 *       }
 *     }
 *   },
 *   recentRuns: [ { timestamp, date, clubName, slotsFound } ]   // last 50
 * }
 */

const fs   = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, 'history.json');
const MAX_RECENT   = 50;

function load() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      if (h.version === 2) return h;
    }
  } catch {}
  return { version: 2, lastUpdated: null, clubs: {}, recentRuns: [] };
}

function save(history) {
  history.lastUpdated = new Date().toISOString();
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

/**
 * Record a full scrape run into history.
 * @param {Array} results — array of { clubName, date, slots: [{display, slotsAvailable}] }
 */
function recordRun(results) {
  const history = load();
  const now     = new Date().toISOString();

  for (const r of results) {
    if (!r.clubName || r.error) continue;

    const date = new Date(r.date + 'T12:00:00');
    const dow  = String(date.getDay()); // 0=Sun … 6=Sat

    // Ensure structure
    if (!history.clubs[r.clubName]) history.clubs[r.clubName] = { byDayOfWeek: {} };
    if (!history.clubs[r.clubName].byDayOfWeek[dow]) {
      history.clubs[r.clubName].byDayOfWeek[dow] = { runs: 0, withSlots: 0, score: 0, topSlots: [] };
    }

    const stat = history.clubs[r.clubName].byDayOfWeek[dow];
    const openSlots = (r.slots || []).filter(s => s.slotsAvailable > 0);
    stat.runs++;
    if (openSlots.length > 0) stat.withSlots++;
    stat.score = parseFloat((stat.withSlots / stat.runs).toFixed(3));

    // Track most common slot times (top 5 by frequency)
    for (const slot of openSlots) {
      const existing = stat.topSlots.find(s => s.time === slot.display);
      if (existing) existing.count++;
      else stat.topSlots.push({ time: slot.display, count: 1 });
    }
    stat.topSlots.sort((a, b) => b.count - a.count);
    stat.topSlots = stat.topSlots.slice(0, 5);

    // Recent runs log
    history.recentRuns.unshift({ timestamp: now, date: r.date, clubName: r.clubName, slotsFound: openSlots.length });
  }

  history.recentRuns = history.recentRuns.slice(0, MAX_RECENT);
  save(history);
}

/**
 * Get reliability score (0–1) for a club on a specific day of week.
 * Returns null if not enough data yet (< 3 runs).
 */
function getClubScore(clubName, dayOfWeek) {
  const history = load();
  const stat = history.clubs?.[clubName]?.byDayOfWeek?.[String(dayOfWeek)];
  if (!stat || stat.runs < 3) return null; // not enough data
  return stat.score;
}

/**
 * Should we skip this club on a given date?
 * Skips if score < threshold AND not a booking day for that date.
 */
function shouldSkipClub(clubName, isoDate, minScore = 0.2) {
  const date = new Date(isoDate + 'T12:00:00');
  const dow  = date.getDay();
  const score = getClubScore(clubName, dow);
  if (score === null) return false; // no data → always check
  return score < minScore;
}

/**
 * Return clubs ordered by reliability score for the given date's day-of-week.
 * Clubs with no history sort to the middle (score = 0.5 assumed).
 */
function rankClubs(clubNames, isoDate) {
  const date = new Date(isoDate + 'T12:00:00');
  const dow  = date.getDay();
  return [...clubNames].sort((a, b) => {
    const sa = getClubScore(a, dow) ?? 0.5;
    const sb = getClubScore(b, dow) ?? 0.5;
    return sb - sa; // descending
  });
}

/**
 * Return a human-readable summary of learned patterns.
 */
function getSummary() {
  const history = load();
  const lines   = [];
  const days    = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (const [club, data] of Object.entries(history.clubs)) {
    const scores = Object.entries(data.byDayOfWeek)
      .map(([d, s]) => `${days[d]}:${Math.round(s.score * 100)}%(${s.runs})`)
      .join(' ');
    lines.push(`${club}: ${scores}`);
  }
  return lines.join('\n') || '(no history yet)';
}

module.exports = { recordRun, getClubScore, shouldSkipClub, rankClubs, getSummary };
