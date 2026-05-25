# Twilio SMS Setup Guide

This guide gets the Club Concierge SMS agent working in about 10 minutes.
After setup, you can text your Twilio number things like:

> "What tee times are available at Atlanta National this weekend?"
> "Morning times at Laurel Springs Saturday"
> "All clubs Sunday"

---

## Step 1 — Create a Twilio account

1. Go to **[twilio.com](https://www.twilio.com)** and click **Sign up**
2. Verify your email and phone number
3. When asked what you're building, select **SMS**
4. Twilio gives you a free trial with ~$15 credit — more than enough

---

## Step 2 — Get a phone number

1. In the Twilio Console, go to **Phone Numbers → Manage → Buy a number**
2. Search for a number in area code `470` or `678` (Georgia)
3. Make sure **SMS** capability is checked
4. Click **Buy** — it costs ~$1.15/month (covered by trial credit)
5. Note the number — this is the number you'll text

---

## Step 3 — Get your credentials

In the Twilio Console, on the main dashboard page:
- Copy your **Account SID** — starts with `AC...`
- Copy your **Auth Token** — click the eye icon to reveal

---

## Step 4 — Add credentials to Railway

In your Railway project's **Variables** tab, add:

| Variable | Value |
|---|---|
| `TWILIO_AUTH_TOKEN` | your auth token from Step 3 |
| `ANTHROPIC_API_KEY` | your Claude API key (from console.anthropic.com) |
| `INVITED_USERNAME` | your Invited Clubs login email |
| `INVITED_PASSWORD` | your Invited Clubs password |

(TWILIO_ACCOUNT_SID and TWILIO_FROM_NUMBER are not needed by the server —
they're only used if you want the server to *send* outbound messages, which
the SMS webhook doesn't need.)

---

## Step 5 — Point Twilio at your Railway URL

1. In Railway, find your deployment URL (e.g. `https://club-concierge.up.railway.app`)
2. In Twilio Console, go to **Phone Numbers → Manage → Active numbers**
3. Click your number
4. Under **Messaging Configuration**, find **"A message comes in"**
5. Set it to:
   - **Webhook**
   - URL: `https://YOUR-RAILWAY-URL.up.railway.app/sms`
   - Method: **HTTP POST**
6. Click **Save**

---

## Step 6 — Test it

Text your Twilio number:

```
Atlanta National this weekend
```

You should get back a list of available tee times within a few seconds.

Other things to try:
- `help` — see example queries
- `Laurel Springs Saturday morning`
- `all clubs this weekend`
- `Eagle Watch Sunday`
- `what times are available tomorrow?`

---

## Troubleshooting

**No response at all:**
- Check that the webhook URL in Twilio is correct (must be `https://`, not `http://`)
- Check Railway logs for errors

**"Tee time data is refreshing" message:**
- The server refreshes data every 30 min. Wait a minute and try again
- Check that `INVITED_USERNAME` and `INVITED_PASSWORD` are set in Railway

**"Something went wrong" message:**
- Check that `ANTHROPIC_API_KEY` is set in Railway
- Check Railway logs for the specific error

**Twilio error in logs: "Invalid signature":**
- Make sure `TWILIO_AUTH_TOKEN` in Railway matches your Twilio console
- Make sure the webhook URL in Twilio exactly matches your Railway URL (no trailing slash)

---

## Cost estimate

| Service | Cost |
|---|---|
| Twilio phone number | ~$1.15/month |
| Twilio SMS (inbound) | $0.0075/message |
| Twilio SMS (outbound) | $0.0075/message |
| Claude Haiku (NL parsing) | ~$0.001 per message |
| **Total per month** | **~$2–3/month** for typical use |
