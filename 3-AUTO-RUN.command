#!/bin/bash
# ============================================================
#  Tee Time Agent — Start Smart Agent
#
#  Runs the full agent in the background:
#    • Updates the dashboard every 15 minutes (normal days)
#    • Switches to 3-minute surge mode on booking days (Sun/Mon)
#    • Auto-books Laurel Springs (then fallbacks) on booking day
#    • Sends SMS alerts when slots appear or booking is confirmed
#
#  Double-click to start. Close this window after setup —
#  the agent keeps running until you stop it.
# ============================================================

cd "$(dirname "$0")"
PID_FILE="auto-run.pid"
LOG_FILE="agent.log"

if [ ! -f "session.json" ]; then
  echo "❌  No login session. Run 1-SETUP.command first."
  read -p "Press Enter to close..."
  exit 1
fi

# ── Check if already running ──────────────────────────────────
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "⚠️  Agent is already running (PID $OLD_PID)."
    echo "    Run 4-STOP-AUTO.command to stop it first."
    read -p "Press Enter to close..."
    exit 0
  else
    rm -f "$PID_FILE"
  fi
fi

echo ""
echo "🏌️  Tee Time Agent — Starting"
echo ""
echo "    Running first availability check (visible browser)…"
echo "    Takes ~2 minutes."
echo ""

# ── First run: visible browser (handles login if needed) ─────
node check-availability.js
echo ""
echo "✅  First run complete — opening dashboard…"
open dashboard.html
echo ""

# ── Start agent in background ─────────────────────────────────
echo "    Starting smart agent loop…"
(node agent.js >> "$LOG_FILE" 2>&1) &

AGENT_PID=$!
echo "$AGENT_PID" > "$PID_FILE"

echo ""
echo "══════════════════════════════════════════════════════"
echo "  ✅  Agent is running! (PID $AGENT_PID)"
echo ""
echo "  📊  Dashboard:   updates every 15 min (or 3 min on"
echo "                   Sundays/Mondays — booking days)"
echo "  📱  SMS alerts:  new slots + booking confirmations"
echo "                   (configure Twilio in config.json)"
echo "  🗓️   Auto-book:   Sundays 7am → books next Saturday"
echo "                   Mondays 7am → books next Sunday"
echo "  🛑  To stop:     double-click 4-STOP-AUTO.command"
echo "  ✋  Cancel book: double-click 5-CANCEL-BOOKING.command"
echo "  📋  Log file:    agent.log"
echo "══════════════════════════════════════════════════════"
echo ""
echo "You can close this window — the agent keeps running."
echo ""
read -p "Press Enter to close..."
