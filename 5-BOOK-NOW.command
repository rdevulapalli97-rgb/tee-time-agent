#!/bin/bash
# ============================================================
#  Tee Time Agent — Book Now
#
#  Manually trigger a booking attempt right now.
#  Checks Laurel Springs first, then fallback clubs.
#
#  Optional: edit TARGET_DATE below to book a specific date.
#  Leave blank to auto-calculate (6 days from today).
# ============================================================

cd "$(dirname "$0")"
TARGET_DATE=""   # e.g. "2026-05-16" — leave blank for auto

if [ ! -f "session.json" ]; then
  echo "❌  No login session. Run 1-SETUP.command first."
  read -p "Press Enter to close..."
  exit 1
fi

echo ""
echo "🏌️  Manual Booking"
echo "    You'll be asked for your guest's name, then the browser"
echo "    will open and book automatically."
echo ""

if [ -n "$TARGET_DATE" ]; then
  node book-tee-time.js --date "$TARGET_DATE"
else
  node book-tee-time.js
fi

EXIT=$?
echo ""
if [ $EXIT -eq 0 ]; then
  echo "✅  Done — check the terminal output above for result."
  echo "    Screenshots saved as debug-confirmation.png (if booked)"
else
  echo "❌  Booking encountered an issue — check output above."
  echo "    Debug files saved in this folder."
fi

read -p "Press Enter to close..."
