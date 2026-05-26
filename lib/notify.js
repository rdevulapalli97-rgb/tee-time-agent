/**
 * lib/notify.js — Per-user SMS and email notifications
 *
 * Supports two channels:
 *   SMS   → Twilio (same credentials as the original single-user setup)
 *   Email → Resend (resend.com — 3,000 free emails/month)
 *
 * Both are optional. A user can have SMS, email, both, or neither.
 * Missing credentials are handled gracefully — notifications are skipped
 * with a log message rather than throwing.
 *
 * Setup:
 *   Twilio: Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER to .env
 *   Resend: Add RESEND_API_KEY to .env (get it at resend.com — free)
 */

'use strict';

const https = require('https');
require('dotenv').config();

// ─── TWILIO SMS ───────────────────────────────────────────────

function twilioConfigured() {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    !process.env.TWILIO_ACCOUNT_SID.startsWith('YOUR') &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER
  );
}

async function sendSMS(toNumber, message) {
  if (!twilioConfigured()) {
    console.log('[notify] SMS skipped — Twilio not configured');
    return { skipped: true };
  }
  if (!toNumber) {
    console.log('[notify] SMS skipped — no phone number for user');
    return { skipped: true };
  }

  const sid  = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  const body = new URLSearchParams({ To: toNumber, From: from, Body: message }).toString();
  const authHeader = 'Basic ' + Buffer.from(`${sid}:${auth}`).toString('base64');

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.twilio.com',
      path:     `/2010-04-01/Accounts/${sid}/Messages.json`,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  authHeader
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[notify] ✅ SMS sent to ${toNumber.slice(0, -4)}****`);
          resolve({ success: true });
        } else {
          console.error(`[notify] ❌ SMS failed — ${res.statusCode}: ${data.slice(0, 200)}`);
          resolve({ error: `HTTP ${res.statusCode}` });
        }
      });
    });
    req.on('error', err => resolve({ error: err.message }));
    req.write(body);
    req.end();
  });
}

// ─── RESEND EMAIL ─────────────────────────────────────────────

function resendConfigured() {
  return !!(process.env.RESEND_API_KEY && !process.env.RESEND_API_KEY.startsWith('YOUR'));
}

async function sendEmail({ to, subject, html }) {
  if (!resendConfigured()) {
    console.log('[notify] Email skipped — Resend not configured');
    return { skipped: true };
  }

  const from = process.env.NOTIFY_FROM_EMAIL || 'bookings@clubcompanion.ai';
  const payload = JSON.stringify({ from, to, subject, html });

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization':  `Bearer ${process.env.RESEND_API_KEY}`
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[notify] ✅ Email sent to ${to}`);
          resolve({ success: true });
        } else {
          console.error(`[notify] ❌ Email failed — ${res.statusCode}: ${data.slice(0, 200)}`);
          resolve({ error: `HTTP ${res.statusCode}` });
        }
      });
    });
    req.on('error', err => resolve({ error: err.message }));
    req.write(payload);
    req.end();
  });
}

// ─── SLACK ALERT (internal — errors & ops) ───────────────────

async function slackAlert(message) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl || webhookUrl.startsWith('YOUR')) return;

  const payload = JSON.stringify({ text: message });
  const url = new URL(webhookUrl);

  return new Promise((resolve) => {
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    };
    const req = https.request(options, res => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', err => resolve({ error: err.message }));
    req.write(payload);
    req.end();
  });
}

// ─── FORMATTED MESSAGES ───────────────────────────────────────

/**
 * Send a booking success notification to the user via SMS + email.
 */
async function notifyBookingSuccess(user, { clubName, date, teeTime, numPlayers, inPreferredWindow }) {
  const windowNote = inPreferredWindow ? '' : '\n⚠️ Note: No slots in your preferred window — earliest available was booked.';
  const smsText = [
    `⛳ ClubCompanion booked your tee time!`,
    `Club: ${clubName}`,
    `Date: ${date}  Time: ${teeTime}`,
    `Players: ${numPlayers}`,
    windowNote
  ].filter(Boolean).join('\n');

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1f3b2d; padding: 24px; text-align: center;">
        <h1 style="color: #c89b3c; font-size: 22px; margin: 0;">⛳ Tee Time Booked</h1>
      </div>
      <div style="padding: 32px; background: #faf7f2;">
        <p style="font-size: 16px; color: #1a1a1a;">Hi ${user.name || user.email.split('@')[0]},</p>
        <p style="color: #555;">Your ClubCompanion agent secured a tee time:</p>
        <table style="width:100%; border-collapse:collapse; margin: 24px 0;">
          <tr><td style="padding:12px; background:#f0ece4; font-weight:bold; width:40%;">Club</td>
              <td style="padding:12px; background:#f0ece4;">${clubName}</td></tr>
          <tr><td style="padding:12px; font-weight:bold;">Date</td>
              <td style="padding:12px;">${date}</td></tr>
          <tr><td style="padding:12px; background:#f0ece4; font-weight:bold;">Time</td>
              <td style="padding:12px; background:#f0ece4;">${teeTime}</td></tr>
          <tr><td style="padding:12px; font-weight:bold;">Players</td>
              <td style="padding:12px;">${numPlayers}</td></tr>
        </table>
        ${!inPreferredWindow ? `<p style="color:#c89b3c; font-size:14px;">⚠️ No slots were available in your preferred time window. The earliest available time was booked instead.</p>` : ''}
        <p style="color:#888; font-size:13px; margin-top:32px;">Questions? Reply to this email or text support.</p>
      </div>
      <div style="padding: 16px; text-align:center; color:#aaa; font-size:12px; background:#f0ece4;">
        ClubCompanion · <a href="https://clubcompanion.ai" style="color:#1f3b2d;">clubcompanion.ai</a>
      </div>
    </div>`;

  const [smsResult, emailResult] = await Promise.all([
    sendSMS(user.phone, smsText),
    sendEmail({ to: user.email, subject: `⛳ Tee time booked — ${clubName} on ${date}`, html: emailHtml })
  ]);

  return { sms: smsResult, email: emailResult };
}

/**
 * Send a booking failure alert to the user.
 */
async function notifyBookingFailed(user, { reason, date }) {
  const smsText = `⚠️ ClubCompanion could not book your tee time for ${date}.\nReason: ${reason}\n\nWe'll keep checking and alert you when a slot opens.`;

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1f3b2d; padding: 24px; text-align: center;">
        <h1 style="color: #e08080; font-size: 22px; margin: 0;">⚠️ Booking Unavailable</h1>
      </div>
      <div style="padding: 32px; background: #faf7f2;">
        <p>Hi ${user.name || user.email.split('@')[0]},</p>
        <p>We were unable to book a tee time for <strong>${date}</strong>.</p>
        <p style="color:#888;">Reason: ${reason}</p>
        <p>Your agent is still monitoring the portal and will automatically book the moment a slot opens.</p>
      </div>
    </div>`;

  return Promise.all([
    sendSMS(user.phone, smsText),
    sendEmail({ to: user.email, subject: `⚠️ No tee time available for ${date}`, html: emailHtml })
  ]);
}

/**
 * Alert internal Slack when a user's agent throws an unexpected error.
 */
async function alertInternalError(user, error) {
  const message = `🚨 *Agent error* for user ${user.email} (${user.id})\n\`${error?.message || error}\``;
  return slackAlert(message);
}

module.exports = {
  sendSMS, sendEmail, slackAlert,
  notifyBookingSuccess, notifyBookingFailed, alertInternalError,
  twilioConfigured, resendConfigured
};
