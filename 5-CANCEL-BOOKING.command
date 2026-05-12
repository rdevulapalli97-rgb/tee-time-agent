#!/bin/bash
# ============================================================
#  Tee Time Agent — Cancel Pending Booking
#
#  Run this within the 5-minute window after receiving the
#  "Auto-booking in 5 min" SMS to cancel the booking.
# ============================================================

cd "$(dirname "$0")"

PENDING_FILE="pending-booking.json"
CANCEL_FLAG="cancel-booking.flag"

echo ""

if [ ! -f "$PENDING_FILE" ]; then
  echo "ℹ️  No pending booking found."
  echo "    Either the booking already went through, or nothing was scheduled."
else
  # Show what was about to be booked
  echo "📋  Pending booking details:"
  cat "$PENDING_FILE" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f\"   Club: {d.get('club','?')}\")
print(f\"   Date: {d.get('targetDate','?')}\")
print(f\"   Time: {d.get('time','?')}\")
print(f\"   Slots: {d.get('slots','?')}\")
" 2>/dev/null || cat "$PENDING_FILE"
  echo ""
fi

# Create cancel flag regardless
touch "$CANCEL_FLAG"
echo "🛑  Cancel signal sent."
echo ""
echo "    The agent will see this and skip the booking."
echo "    Run 3-AUTO-RUN.command to restart the agent."
echo ""
read -p "Press Enter to close..."
