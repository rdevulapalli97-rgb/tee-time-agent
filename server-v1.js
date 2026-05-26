/**
 * server-v1.js — ClubCompanion MVP Server
 *
 * Lightweight single-user server. No Supabase. No Stripe. Just:
 *   GET  /              → dashboard.html (tee time UI)
 *   GET  /availability.json  → cached tee time data
 *   POST /sms           → Twilio webhook → Claude SMS agent → TwiML
 *   GET  /health        → health check (required by Railway)
 *
 * Background: node-cron refreshes availability.json every 30 minutes by
 * running check-availability.js as a child process.
 *
 * Required env vars:
 *   INVITED_USERNAME    — Invited Clubs login username
 *   INVITED_PASSWORD    — Invited Clubs login password
 *   ANTHROPIC_API_KEY   — Claude API key (for SMS natural language parsing)
 *   TWILIO_AUTH_TOKEN   — Used to validate inbound webhook signatures (optional but recommended)
 *   PORT                — HTTP port (Railway sets this automatically)
 *
 * Run: node server-v1.js
 */

'use strict';

require('dotenv').config();

const http        = require('http');
const fs          = require('fs');
const path        = require('path');
const crypto      = require('crypto');
const cron        = require('node-cron');
const { handleSMS } = require('./lib/sms-agent');

const PORT             = parseInt(process.env.PORT || '3000', 10);
const AVAILABILITY_FILE = path.join(__dirname, 'availability.json');
const DASHBOARD_FILE   = path.join(__dirname, 'dashboard.html');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse application/x-www-form-urlencoded into an object */
function parseFormBody(raw) {
  const params = {};
  for (const pair of raw.toString('utf8').split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const k = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '));
    const v = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    params[k] = v;
  }
  return params;
}

/**
 * Validate Twilio webhook signature.
 * If TWILIO_AUTH_TOKEN is not set, skips validation (dev mode).
 * Returns true if valid (or skipped), false if invalid.
 */
function validateTwilioSignature(req, rawBody, host) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.warn('[sms] TWILIO_AUTH_TOKEN not set — skipping signature check');
    return true;
  }

  const twilioSig = req.headers['x-twilio-signature'];
  if (!twilioSig) return false;

  // Build the URL Twilio signed (https scheme on Railway)
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const url = `${protocol}://${host}/sms`;

  // Sort POST params and append to URL
  const params = parseFormBody(rawBody);
  const sortedKeys = Object.keys(params).sort();
  let toSign = url;
  for (const k of sortedKeys) toSign += k + params[k];

  const expected = crypto
    .createHmac('sha1', authToken)
    .update(toSign)
    .digest('base64');

  return expected === twilioSig;
}

// ─── Availability refresh ─────────────────────────────────────────────────────

let refreshRunning = false;

async function refreshAvailability() {
  if (refreshRunning) {
    console.log('[refresh] Already running — skipping');
    return;
  }

  const username = process.env.INVITED_USERNAME;
  const password = process.env.INVITED_PASSWORD;

  if (!username || !password) {
    console.warn('[refresh] INVITED_USERNAME / INVITED_PASSWORD not set — skipping refresh');
    return;
  }

  refreshRunning = true;
  console.log('[refresh] Starting availability check...');

  try {
    // Use check-availability's run() — logs in via loginToPortal and scrapes all clubs
    const { run } = require('./check-availability');
    const results = await run({
      credentials: { username, password },
    });

    const generatedAt = new Date().toISOString();
    const today = new Date();
    const targetDates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      targetDates.push(d.toISOString().split('T')[0]);
    }

    fs.writeFileSync(
      AVAILABILITY_FILE,
      JSON.stringify({ generatedAt, targetDates, results }, null, 2)
    );

    const openSlots = results.reduce((n, r) => n + (r.slots || []).filter(s => s.slotsAvailable > 0).length, 0);
    console.log(`[refresh] ✅ availability.json updated — ${results.length} entries, ${openSlots} open slots`);

  } catch (err) {
    console.error('[refresh] Error:', err.message);
  } finally {
    refreshRunning = false;
  }
}

// ─── Route handlers ───────────────────────────────────────────────────────────

function handleDashboard(res) {
  if (!fs.existsSync(DASHBOARD_FILE)) {
    res.writeHead(404);
    res.end('dashboard.html not found');
    return;
  }
  const html = fs.readFileSync(DASHBOARD_FILE, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function handleAvailabilityJson(res) {
  if (!fs.existsSync(AVAILABILITY_FILE)) {
    json(res, 200, {
      generatedAt:  null,
      targetDates:  [],
      results:      [],
      _note:        'No availability data yet. Server is warming up.',
    });
    return;
  }

  const data = fs.readFileSync(AVAILABILITY_FILE);
  res.writeHead(200, {
    'Content-Type':  'application/json',
    'Cache-Control': 'no-cache',
    'Content-Length': data.length,
  });
  res.end(data);
}

async function handleSMSWebhook(req, res) {
  const rawBody = await readBody(req);
  const host = req.headers['host'] || 'localhost';

  // Validate Twilio signature
  if (!validateTwilioSignature(req, rawBody, host)) {
    console.warn('[sms] Invalid Twilio signature — rejecting request');
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const params  = parseFormBody(rawBody);
  const smsBody = params['Body'] || '';
  const from    = params['From'] || 'unknown';

  console.log(`[sms] Inbound from ${from}: "${smsBody}"`);

  try {
    const twiml = await handleSMS(smsBody);
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
    res.end(twiml);
  } catch (err) {
    console.error('[sms] Agent error:', err.message);
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
    res.end('<?xml version="1.0" encoding="UTF-8"?><Response><Message>Sorry, something went wrong. Try again in a moment! ⛳</Message></Response>');
  }
}

async function handleHealth(res) {
  const hasData    = fs.existsSync(AVAILABILITY_FILE);
  let   dataAge    = null;
  let   slotCount  = 0;

  if (hasData) {
    try {
      const data = JSON.parse(fs.readFileSync(AVAILABILITY_FILE, 'utf8'));
      dataAge   = data.generatedAt || null;
      slotCount = (data.results || []).reduce((n, r) => n + (r.slots || []).length, 0);
    } catch { /* ignore */ }
  }

  json(res, 200, {
    status:       'ok',
    service:      'clubcompanion-v1',
    hasData,
    dataAge,
    slotCount,
    refreshRunning,
    timestamp:    new Date().toISOString(),
  });
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS headers (for dashboard polling from any origin)
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url?.split('?')[0];

  try {
    // Dashboard
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      return handleDashboard(res);
    }

    // Availability data
    if (req.method === 'GET' && url === '/availability.json') {
      return handleAvailabilityJson(res);
    }

    // Twilio SMS webhook
    if (req.method === 'POST' && url === '/sms') {
      return handleSMSWebhook(req, res);
    }

    // Health check (Railway pings this)
    if (req.method === 'GET' && (url === '/health' || url === '/api/health')) {
      return handleHealth(res);
    }

    // Trigger manual refresh (useful for testing)
    if (req.method === 'POST' && url === '/api/refresh') {
      refreshAvailability().catch(e => console.error('[refresh] Error:', e.message));
      return json(res, 202, { message: 'Refresh triggered' });
    }

    // 404
    json(res, 404, { message: `No route: ${req.method} ${url}` });

  } catch (err) {
    console.error('[server] Unhandled error:', err.message, err.stack);
    json(res, 500, { message: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`\n[server] ClubCompanion v1 running on port ${PORT}`);
  console.log(`  GET  /                → dashboard`);
  console.log(`  GET  /availability.json  → tee time data`);
  console.log(`  POST /sms             → Twilio SMS webhook`);
  console.log(`  GET  /health          → health check`);
  console.log(`  POST /api/refresh     → trigger manual refresh\n`);
});

// ─── Background cron: refresh availability every 30 minutes ──────────────────
// Also run once immediately at startup so data is ready right away.

cron.schedule('*/30 * * * *', () => {
  console.log('[cron] Scheduled availability refresh');
  refreshAvailability().catch(e => console.error('[cron] Refresh error:', e.message));
});

// Kick off initial refresh after a short delay (let server fully start first)
setTimeout(() => {
  console.log('[startup] Running initial availability refresh...');
  refreshAvailability().catch(e => console.error('[startup] Refresh error:', e.message));
}, 5000);

process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received — shutting down');
  server.close(() => process.exit(0));
});

module.exports = server;
