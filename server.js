/**
 * server.js — ClubCompanion API Server
 *
 * Handles:
 *   POST /api/signup          — receives signup form, encrypts creds, writes to Supabase
 *   POST /api/stripe-webhook  — Stripe subscription lifecycle events
 *   GET  /api/health          — health check (also used by Railway)
 *   GET  /signup              — serves signup/index.html with config injected
 *   GET  /admin               — serves admin/index.html with config injected (basic auth protected)
 *
 * Run: node server.js
 * Port: process.env.PORT || 3000
 */

'use strict';

require('dotenv').config();
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const db      = require('./db/client');
const { onboardUser }    = require('./user-runner');
const { handleStripeEvent } = require('./lib/stripe');

const PORT = parseInt(process.env.PORT || '3000', 10);

// ─── Helpers ──────────────────────────────────────────────────

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
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

function serveFile(res, filePath, replacements = {}) {
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  let html = fs.readFileSync(filePath, 'utf8');
  // Inject server-side values into the HTML (safe — service role key never exposed)
  for (const [key, value] of Object.entries(replacements)) {
    html = html.replace(`'${key}'`, `'${value}'`);
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// Basic auth middleware for admin
function checkAdminAuth(req, res) {
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD;
  if (!adminPass) return true; // Skip auth if not configured (dev only)

  const authHeader = req.headers['authorization'] || '';
  const b64 = authHeader.replace('Basic ', '');
  const [u, p] = Buffer.from(b64, 'base64').toString().split(':');
  if (u === adminUser && p === adminPass) return true;

  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ClubCompanion Admin"' });
  res.end('Unauthorized');
  return false;
}

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin',  process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ─── Route handlers ───────────────────────────────────────────

async function handleSignup(req, res) {
  const rawBody = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return json(res, 400, { message: 'Invalid JSON' });
  }

  const { email, name, phone, plan, username, password, config: configData, players } = payload;

  // Basic validation
  if (!email || !username || !password) {
    return json(res, 400, { message: 'email, username, and password are required' });
  }
  if (!email.includes('@')) {
    return json(res, 400, { message: 'Invalid email address' });
  }

  // Check for duplicate email
  const { data: existing } = await db.getUserByEmail(email).catch(() => ({ data: null }));
  if (existing) {
    return json(res, 409, { message: 'An account with this email already exists. Contact support@clubcompanion.ai.' });
  }

  try {
    const user = await onboardUser({
      email, name, phone: phone || null,
      plan: plan || 'member',
      username, password,
      configData: configData || {
        home_club_name:            'Laurel Springs Golf Club',
        home_club_target_day:      'Saturday',
        home_club_days_in_advance: 6,
        home_earliest_hour:        6,
        home_latest_hour:          11,
        aa_enabled:                false,
        aa_earliest_hour:          6,
        aa_latest_hour:            9,
        number_of_players:         2,
        fallback_to_earliest:      true,
      },
      playersData: players || []
    });

    console.log(`[api] New signup: ${email} (${plan})`);

    // Send internal Slack alert
    const { slackAlert } = require('./lib/notify');
    await slackAlert(`🎉 New signup!\n*${name || email}* · ${plan || 'member'} plan\n_${email}_`).catch(() => {});

    return json(res, 201, { success: true, userId: user.id });

  } catch (err) {
    console.error('[api] Signup error:', err.message);
    // Don't leak internal errors to client
    return json(res, 500, { message: 'Signup failed. Please try again or email support@clubcompanion.ai.' });
  }
}

async function handleStripeWebhook(req, res) {
  const rawBody  = await readBody(req);
  const sig      = req.headers['stripe-signature'];
  const secret   = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.warn('[stripe] STRIPE_WEBHOOK_SECRET not set — skipping signature verification');
  } else {
    // Verify Stripe signature to prevent spoofed webhooks
    try {
      verifyStripeSignature(rawBody, sig, secret);
    } catch (err) {
      console.error('[stripe] Invalid signature:', err.message);
      return json(res, 400, { message: 'Invalid signature' });
    }
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return json(res, 400, { message: 'Invalid JSON' });
  }

  try {
    await handleStripeEvent(event);
    return json(res, 200, { received: true });
  } catch (err) {
    console.error('[stripe] Event handling error:', err.message);
    return json(res, 500, { message: 'Webhook handler failed' });
  }
}

// Manual Stripe signature verification (no SDK needed)
function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) throw new Error('Missing stripe-signature header');
  const parts     = sigHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    acc[k] = v;
    return acc;
  }, {});
  const timestamp = parts.t;
  const v1        = parts.v1;
  if (!timestamp || !v1) throw new Error('Malformed stripe-signature header');

  const payload  = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (expected !== v1) throw new Error('Signature mismatch');

  // Reject events older than 5 minutes
  const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
  if (age > 300) throw new Error(`Event too old (${Math.round(age)}s)`);
}

async function handleHealth(res) {
  const { data: users } = await db.getAllActiveUsers().catch(() => ({ data: [] }));
  json(res, 200, {
    status:       'ok',
    service:      'clubcompanion-api',
    active_users: (users || []).length,
    timestamp:    new Date().toISOString()
  });
}

// ─── Router ───────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  corsHeaders(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url?.split('?')[0];

  try {
    // API routes
    if (req.method === 'POST' && url === '/api/signup') {
      return handleSignup(req, res);
    }
    if (req.method === 'POST' && url === '/api/stripe-webhook') {
      return handleStripeWebhook(req, res);
    }
    if (req.method === 'GET' && url === '/api/health') {
      return handleHealth(res);
    }
    if (req.method === 'GET' && url === '/health') {
      return handleHealth(res);
    }

    // Serve signup form (inject Supabase anon key from env — safe to expose)
    if (req.method === 'GET' && (url === '/signup' || url === '/signup/')) {
      return serveFile(res, path.join(__dirname, 'signup/index.html'), {
        'YOUR_SUPABASE_URL':      process.env.SUPABASE_URL      || '',
        'YOUR_SUPABASE_ANON_KEY': process.env.SUPABASE_ANON_KEY || ''
      });
    }

    // Serve admin (protected)
    if (req.method === 'GET' && (url === '/admin' || url === '/admin/')) {
      if (!checkAdminAuth(req, res)) return;
      return serveFile(res, path.join(__dirname, 'admin/index.html'), {
        'YOUR_SUPABASE_URL':      process.env.SUPABASE_URL      || '',
        'YOUR_SUPABASE_ANON_KEY': process.env.SUPABASE_ANON_KEY || ''
      });
    }

    // Serve static assets from public/ if present
    const publicPath = path.join(__dirname, 'public', url);
    if (fs.existsSync(publicPath) && fs.statSync(publicPath).isFile()) {
      const ext = path.extname(publicPath);
      const types = { '.html':'text/html','.css':'text/css','.js':'application/javascript','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      fs.createReadStream(publicPath).pipe(res);
      return;
    }

    // 404
    json(res, 404, { message: `No route for ${req.method} ${url}` });

  } catch (err) {
    console.error('[server] Unhandled error:', err.message);
    json(res, 500, { message: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`\n[server] ClubCompanion API running on port ${PORT}`);
  console.log(`  POST /api/signup`);
  console.log(`  POST /api/stripe-webhook`);
  console.log(`  GET  /health`);
  console.log(`  GET  /signup   → member onboarding form`);
  console.log(`  GET  /admin    → admin dashboard (basic auth)\n`);
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });

module.exports = server; // For testing
