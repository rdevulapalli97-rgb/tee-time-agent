#!/bin/bash
# ============================================================
#  Tee Time Agent — Dry Run (Test Booking Flow)
#
#  Navigates to the portal, finds the best available slot,
#  and stops RIGHT BEFORE clicking Reserve.
#
#  Saves debug-booking-form.png so you can verify the flow
#  is working before any real booking happens.
#
#  Safe to run anytime — nothing gets booked.
# ============================================================

cd "$(dirname "$0")"

if [ ! -f "session.json" ]; then
  echo "❌  No login session. Run 1-SETUP.command first."
  read -p "Press Enter to close..."
  exit 1
fi

echo ""
echo "🔍  Dry Run — Testing booking flow..."
echo "    You'll be asked for a guest name (not used for real),"
echo "    then a browser window will open, find the best slot,"
echo "    and STOP without booking anything."
echo ""

node book-tee-time.js --dry-run

echo ""
echo "✅  Dry run complete!"
echo "    Check the output above to see which slot would have been booked."
echo "    Screenshots saved in this folder if the form was reached."
echo ""
read -p "Press Enter to close..."
