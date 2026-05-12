# ⛳ Club Concierge Agent

Automated tee time booking for Invited Clubs members. The agent watches the member portal 24/7, books your preferred Saturday (and optionally Sunday Access Advantage) tee times the moment they open — for every paying subscriber.

---

## Architecture Overview

```
multi-user-scheduler.js   ← Production entry point (cron + health check)
│
├── user-runner.js         ← Per-user orchestrator (loads DB config, runs booking)
│   ├── check-availability.js   ← Playwright scraper
│   └── book-tee-time.js        ← Playwright booker
│
├── server.js              ← HTTP API (signup form, Stripe webhooks, admin)
│
├── db/
│   ├── schema.sql         ← Run once in Supabase SQL Editor
│   ├── client.js          ← Supabase typed helpers
│   └── seed.js            ← Seeds your account for local testing
│
└── lib/
    ├── encrypt.js         ← AES-256-GCM credential encryption
    ├── notify.js          ← Per-user SMS (Twilio) + email (Resend)
    └── stripe.js          ← Subscription lifecycle webhook handler
```

---

## Prerequisites

- Node.js >= 20 (`node --version`)
- A Supabase project (free tier works): https://supabase.com
- A Railway account for cloud hosting: https://railway.app
- Optional: Twilio (SMS), Resend (email), Stripe (payments)

---

## Setup: Local Development

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Create your Supabase project

1. Go to supabase.com → New Project
2. Name: club-concierge · Region: US East · Generate a strong password
3. Wait ~2 minutes for provisioning
4. Go to SQL Editor → New Query → paste entire contents of db/schema.sql → Run
5. Go to Settings → API → copy Project URL and service_role key

### 3. Configure environment

```bash
cp .env.example .env
# Open .env and fill in all values — see .env.example for guidance
```

### 4. Verify encryption

```bash
npm run encrypt-test
# Should print: [encrypt] ✅ Self-test passed
```

### 5. Seed your account

```bash
node db/seed.js
# Then update your real credentials:
node scripts/onboard-user.js
```

### 6. Run locally

```bash
node server.js              # API server (port 3000)
node multi-user-scheduler.js # Scheduler (separate terminal)
```

Visit:
- http://localhost:3000/signup  — member onboarding form
- http://localhost:3000/admin   — admin dashboard
- http://localhost:3000/health  — health check

---

## Setup: Production (Railway)

### 1. Push to GitHub (private repo)

```bash
git init && git add . && git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/club-concierge-agent.git
git push -u origin main
```

### 2. Deploy on Railway

1. railway.app → New Project → Deploy from GitHub
2. Select your repository
3. Go to Variables tab → add all values from your .env
4. Deploy — takes ~90 seconds
5. Railway uses railway.toml automatically (start command: node multi-user-scheduler.js)

### 3. Set up Stripe webhook

1. stripe.com → Developers → Webhooks → Add endpoint
2. URL: https://your-railway-url.railway.app/api/stripe-webhook
3. Events: checkout.session.completed, customer.subscription.updated,
   customer.subscription.deleted, invoice.payment_failed
4. Copy signing secret → STRIPE_WEBHOOK_SECRET in Railway Variables

### 4. Point domain at Railway

In Cloudflare DNS: add CNAME api.clubconcierge.com → your Railway URL

---

## Key Commands

| Command | What it does |
|---|---|
| npm start | Start production scheduler |
| node server.js | Start API + admin server |
| node check-availability.js | One-off availability scan |
| node book-tee-time.js --dry-run | Simulate booking (no confirmation) |
| node db/seed.js | Seed your account into Supabase |
| node scripts/onboard-user.js | Add a new user interactively |
| npm run encrypt-test | Verify ENCRYPTION_KEY is working |

---

## Security

- Credentials encrypted with AES-256-GCM before DB storage
- ENCRYPTION_KEY lives only in environment variables
- Supabase service role key never exposed to the browser
- Admin dashboard requires HTTP Basic Auth
- Stripe webhooks signature-verified
- Row-level security enabled on all tables
- .gitignore excludes all secrets

---

## File Structure

```
├── multi-user-scheduler.js  Production scheduler
├── server.js                API server
├── user-runner.js           Per-user booking logic
├── check-availability.js    Playwright scraper
├── book-tee-time.js         Playwright booker
├── db/schema.sql            Run once in Supabase
├── db/client.js             Database helpers
├── db/seed.js               Test data seeder
├── lib/encrypt.js           AES-256-GCM
├── lib/notify.js            SMS + email
├── lib/stripe.js            Stripe events
├── admin/index.html         Admin dashboard
├── signup/index.html        Member onboarding form
├── scripts/onboard-user.js  CLI user creation
├── .env.example             Env var reference
└── railway.toml             Railway deployment config
```

---

Club Concierge · rdevulapalli97@gmail.com · clubconcierge.com
