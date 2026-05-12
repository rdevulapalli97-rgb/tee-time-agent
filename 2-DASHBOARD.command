#!/bin/bash
# ============================================================
#  Tee Time Agent — Live Availability Dashboard
#  Double-click to check all GA Invited Club tee times now.
# ============================================================

cd "$(dirname "$0")"

if [ ! -f "session.json" ]; then
  echo "❌  No login session found. Please run 1-SETUP.command first."
  read -p "Press Enter to close..."
  exit 1
fi

echo ""
echo "🏌️  Checking tee times across all Georgia clubs..."
echo "    A browser window will open. If your session is expired,"
echo "    log in when prompted, then come back and press Enter."
echo "    (takes ~3-4 minutes total)"
echo ""

node check-availability.js

echo ""
echo "✅  Done! Opening dashboard in your browser..."
open dashboard.html

read -p "Press Enter to close..."
