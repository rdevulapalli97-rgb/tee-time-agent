/**
 * notify.js — SMS notifications via Twilio
 *
 * Uses Node's built-in https — no npm packages required.
 * Reads credentials from config.json twilio section.
 *
 * Usage:
 *   const { sendSMS, notifyConfigured } = require('./notify');
 *   await sendSMS('⛳ Booking confirmed!');
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadTwilioConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return config.twilio || null;
  } catch {
    return null;
  }
}

function notifyConfigured() {
  const t = loadTwilioConfig();
  return !!(
    t &&
    t.accountSid && !t.accountSid.startsWith('YOUR') &&
    t.authToken  && !t.authToken.startsWith('YOUR') &&
    t.fromNumber && !t.fromNumber.startsWith('+1XXXX') &&
    t.toNumber   && !t.toNumber.startsWith('+1XXXX')
  );
}

async function sendSMS(message) {
  const t = loadTwilioConfig();

  if (!notifyConfigured()) {
    console.log(`[notify] SMS skipped (Twilio not configured): ${message}`);
    return { skipped: true };
  }

  const body = new URLSearchParams({
    To:   t.toNumber,
    From: t.fromNumber,
    Body: message
  }).toString();

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.twilio.com',
      path:     `/2010-04-01/Accounts/${t.accountSid}/Messages.json`,
      method:   'POST',
      auth:     `${t.accountSid}:${t.authToken}`,
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`[notify] SMS sent: ${message.slice(0, 60)}`);
            resolve(parsed);
          } else {
            console.error(`[notify] Twilio error ${res.statusCode}: ${parsed.message || data}`);
            resolve({ error: parsed.message });
          }
        } catch (e) {
          resolve({ error: e.message });
        }
      });
    });

    req.on('error', err => {
      console.error('[notify] SMS send failed:', err.message);
      resolve({ error: err.message });
    });

    req.write(body);
    req.end();
  });
}

module.exports = { sendSMS, notifyConfigured };
