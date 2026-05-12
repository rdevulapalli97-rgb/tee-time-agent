#!/bin/bash
# ============================================================
#  Tee Time Agent — Book Saturday Tee Time
#  Books the earliest available slot 6 days from today.
# ============================================================

cd "$(dirname "$0")"

if [ ! -f "session.json" ]; then
  echo "❌  No login session found. Please run 1-SETUP.command first."
  read -p "Press Enter to close..."
  exit 1
fi

echo ""
echo "🏌️  Booking Saturday tee time at Laurel Springs..."
echo ""

node book-tee-time.js

echo ""
read -p "Press Enter to close..."
