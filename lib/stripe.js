/**
 * lib/stripe.js — Stripe subscription lifecycle handler
 *
 * No Stripe SDK needed — we only handle webhooks (inbound events).
 * The webhook signature is verified in server.js before this is called.
 *
 * Events handled:
 *   checkout.session.completed    → activate user (new subscription)
 *   customer.subscription.updated → plan change (upgrade/downgrade)
 *   customer.subscription.deleted → deactivate user (cancelled/expired)
 *   invoice.payment_failed        → alert user + internal Slack
 *
 * Setup:
 *   1. Go to stripe.com → Developers → Webhooks → Add endpoint
 *   2. Endpoint URL: https://your-domain.com/api/stripe-webhook
 *   3. Select events: checkout.session.completed, customer.subscription.*,
 *      invoice.payment_failed
 *   4. Copy Signing secret → STRIPE_WEBHOOK_SECRET in .env
 *   5. Add STRIPE_SECRET_KEY to .env (for the Stripe API calls we make back)
 *
 * Pricing tier mapping (update these to match your actual Stripe Price IDs):
 *   STRIPE_PRICE_STARTER    = price_xxx  → 'starter'
 *   STRIPE_PRICE_MEMBER     = price_yyy  → 'member'
 *   STRIPE_PRICE_CONCIERGE  = price_zzz  → 'concierge'
 */

'use strict';

const https  = require('https');
require('dotenv').config();
const db     = require('../db/client');
const { sendEmail, slackAlert } = require('./notify');

// ─── Stripe API helper (no SDK) ────────────────────────────────

async function stripeGet(path) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not set');

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.stripe.com',
      path,
      method:  'GET',
      headers: { 'Authorization': `Bearer ${key}` }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from Stripe')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Plan lookup ───────────────────────────────────────────────

function planFromPriceId(priceId) {
  const map = {
    [process.env.STRIPE_PRICE_STARTER]:   'starter',
    [process.env.STRIPE_PRICE_MEMBER]:    'member',
    [process.env.STRIPE_PRICE_CONCIERGE]: 'concierge',
  };
  return map[priceId] || 'member'; // default to member if unknown
}

// ─── Event handlers ────────────────────────────────────────────

/**
 * New subscription completed — create or activate the user.
 * The customer's email is the join key between Stripe and Supabase.
 */
async function onCheckoutCompleted(event) {
  const session = event.data.object;
  const email   = session.customer_details?.email || session.customer_email;
  const stripeCustomerId     = session.customer;
  const stripeSubscriptionId = session.subscription;

  if (!email) {
    console.error('[stripe] checkout.session.completed — no email in session');
    return;
  }

  console.log(`[stripe] New checkout: ${email} (${stripeCustomerId})`);

  // Fetch the subscription to get the plan (price ID)
  let plan = 'member';
  if (stripeSubscriptionId) {
    try {
      const sub  = await stripeGet(`/v1/subscriptions/${stripeSubscriptionId}`);
      const priceId = sub.items?.data?.[0]?.price?.id;
      if (priceId) plan = planFromPriceId(priceId);
    } catch (e) {
      console.warn('[stripe] Could not fetch subscription details:', e.message);
    }
  }

  // Find existing user or create new one
  const { data: existing } = await db.getUserByEmail(email).catch(() => ({ data: null }));

  if (existing) {
    // Reactivate / upgrade existing user
    await db.updateUser(existing.id, {
      active: true,
      plan,
      stripe_customer_id:      stripeCustomerId,
      stripe_subscription_id:  stripeSubscriptionId,
    });
    console.log(`[stripe] ✅ Reactivated user: ${email} → ${plan}`);
  } else {
    // Create new user record (they may have come from direct Stripe link, not signup form)
    await db.createUser({ email, plan });
    const { data: newUser } = await db.getUserByEmail(email);
    if (newUser) {
      await db.updateUser(newUser.id, {
        stripe_customer_id:     stripeCustomerId,
        stripe_subscription_id: stripeSubscriptionId,
      });
    }
    console.log(`[stripe] ✅ Created user from checkout: ${email} → ${plan}`);
    // Notify them they need to complete setup
    await sendEmail({
      to:      email,
      subject: 'Welcome to Club Concierge — complete your setup',
      html:    welcomeSetupEmail(email, plan)
    }).catch(() => {});
  }

  await slackAlert(`💳 New subscription!\n*${email}* · ${plan} plan`).catch(() => {});
}

/**
 * Subscription updated — handle plan changes and renewals.
 */
async function onSubscriptionUpdated(event) {
  const sub     = event.data.object;
  const custId  = sub.customer;
  const status  = sub.status; // active, past_due, canceled, etc.
  const priceId = sub.items?.data?.[0]?.price?.id;
  const plan    = priceId ? planFromPriceId(priceId) : null;

  // Find user by Stripe customer ID
  const { data: users } = await db.supabase
    .from('users')
    .select('*')
    .eq('stripe_customer_id', custId)
    .limit(1);

  const user = users?.[0];
  if (!user) {
    console.warn(`[stripe] subscription.updated — no user found for customer ${custId}`);
    return;
  }

  const updates = { stripe_subscription_id: sub.id };
  if (plan) updates.plan = plan;

  if (status === 'active') {
    updates.active = true;
    console.log(`[stripe] ✅ Subscription active: ${user.email} → ${plan || 'same plan'}`);
  } else if (status === 'past_due') {
    console.warn(`[stripe] ⚠️  Payment past due: ${user.email}`);
    await slackAlert(`⚠️ Payment past due\n*${user.email}*`).catch(() => {});
  }

  await db.updateUser(user.id, updates);
}

/**
 * Subscription deleted/cancelled — deactivate the user.
 */
async function onSubscriptionDeleted(event) {
  const sub    = event.data.object;
  const custId = sub.customer;

  const { data: users } = await db.supabase
    .from('users')
    .select('*')
    .eq('stripe_customer_id', custId)
    .limit(1);

  const user = users?.[0];
  if (!user) {
    console.warn(`[stripe] subscription.deleted — no user for customer ${custId}`);
    return;
  }

  await db.updateUser(user.id, { active: false });
  console.log(`[stripe] ❌ Deactivated user: ${user.email}`);
  await slackAlert(`❌ Subscription cancelled\n*${user.email}*`).catch(() => {});

  // Cancellation email
  await sendEmail({
    to:      user.email,
    subject: 'Your Club Concierge subscription has been cancelled',
    html:    cancellationEmail(user.name || user.email)
  }).catch(() => {});
}

/**
 * Payment failed — warn the user before we deactivate.
 */
async function onPaymentFailed(event) {
  const invoice = event.data.object;
  const custId  = invoice.customer;

  const { data: users } = await db.supabase
    .from('users')
    .select('*')
    .eq('stripe_customer_id', custId)
    .limit(1);

  const user = users?.[0];
  if (!user) return;

  console.warn(`[stripe] ⚠️  Payment failed for ${user.email}`);
  await slackAlert(`💳 Payment failed\n*${user.email}*\nAmount: $${(invoice.amount_due / 100).toFixed(2)}`).catch(() => {});

  await sendEmail({
    to:      user.email,
    subject: '⚠️ Payment issue — action required',
    html:    paymentFailedEmail(user.name || user.email)
  }).catch(() => {});
}

// ─── Main dispatcher ───────────────────────────────────────────

async function handleStripeEvent(event) {
  console.log(`[stripe] Event: ${event.type}`);
  switch (event.type) {
    case 'checkout.session.completed':    return onCheckoutCompleted(event);
    case 'customer.subscription.updated': return onSubscriptionUpdated(event);
    case 'customer.subscription.deleted': return onSubscriptionDeleted(event);
    case 'invoice.payment_failed':        return onPaymentFailed(event);
    default:
      console.log(`[stripe] Unhandled event type: ${event.type}`);
  }
}

// ─── Email templates ───────────────────────────────────────────

function welcomeSetupEmail(email, plan) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
    <div style="background:#1f3b2d;padding:32px;text-align:center;">
      <h1 style="color:#c89b3c;margin:0;font-size:24px;">⛳ Welcome to Club Concierge</h1>
    </div>
    <div style="padding:32px;background:#faf7f2;">
      <p>Thanks for subscribing to the <strong>${plan}</strong> plan!</p>
      <p style="color:#555;">Your agent is almost ready. To complete setup and activate your automated booking, you need to connect your Invited Clubs login:</p>
      <div style="text-align:center;margin:32px 0;">
        <a href="https://clubconcierge.com/signup" style="background:#1f3b2d;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;">Complete Setup →</a>
      </div>
      <p style="color:#888;font-size:13px;">Takes about 5 minutes. Questions? Reply to this email.</p>
    </div>
  </div>`;
}

function cancellationEmail(name) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
    <div style="background:#1f3b2d;padding:32px;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:22px;">We'll miss you on the course</h1>
    </div>
    <div style="padding:32px;background:#faf7f2;">
      <p>Hi ${name},</p>
      <p style="color:#555;">Your Club Concierge subscription has been cancelled. Your agent will stop running at the end of your current billing period.</p>
      <p>If you cancelled by mistake or want to re-subscribe, you can do so any time at <a href="https://clubconcierge.com/#pricing" style="color:#1f3b2d;">clubconcierge.com</a>.</p>
      <p style="color:#888;font-size:13px;">Thanks for being a member. If there's anything we could have done better, we'd genuinely love to hear it — reply to this email.</p>
    </div>
  </div>`;
}

function paymentFailedEmail(name) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
    <div style="background:#c0392b;padding:32px;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:22px;">⚠️ Payment issue — action needed</h1>
    </div>
    <div style="padding:32px;background:#faf7f2;">
      <p>Hi ${name},</p>
      <p style="color:#555;">We were unable to process your Club Concierge payment. Your agent is still active for now, but will be paused if payment is not received within 5 days.</p>
      <div style="text-align:center;margin:28px 0;">
        <a href="https://billing.stripe.com/p/login/YOUR_PORTAL_LINK" style="background:#c0392b;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;">Update Payment Method →</a>
      </div>
      <p style="color:#888;font-size:13px;">Questions? Reply to this email or text support.</p>
    </div>
  </div>`;
}

module.exports = { handleStripeEvent };
