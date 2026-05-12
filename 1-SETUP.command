#!/bin/bash
# ============================================================
#  Tee Time Agent — One-Time Setup
# ============================================================

cd "$(dirname "$0")"

echo ""
echo "============================================================"
echo "  Tee Time Agent — Setup"
echo "============================================================"
echo ""

# ── 1. Check for Node.js ─────────────────────────────────────
echo "Checking for Node.js..."
if ! command -v node &>/dev/null; then
  echo ""
  echo "❌  Node.js is not installed."
  echo ""
  echo "Please install it from: https://nodejs.org"
  echo "(Download the LTS version, run the installer, then re-run this script)"
  echo ""
  read -p "Press Enter to close..."
  exit 1
fi
echo "✅  Node.js $(node --version) found"
echo ""

# ── 2. Install npm packages ───────────────────────────────────
echo "Installing npm packages..."
npm install
if [ $? -ne 0 ]; then
  echo "❌  npm install failed. Check the error above."
  read -p "Press Enter to close..."
  exit 1
fi
echo "✅  npm packages installed"
echo ""

# ── 3. Install Playwright browser ────────────────────────────
echo "Installing Chromium for Playwright (~200MB, may take a minute)..."
npx playwright install chromium
if [ $? -ne 0 ]; then
  echo "❌  Playwright install failed. Check the error above."
  read -p "Press Enter to close..."
  exit 1
fi
echo "✅  Chromium installed"
echo ""

# ── 4. Save login session ─────────────────────────────────────
echo "============================================================"
echo "  LAST STEP: Log in to Invited Clubs"
echo "============================================================"
echo ""
echo "  1. A browser window will open"
echo "  2. Log in to your Invited Clubs account"
echo "  3. Wait until you reach the HOME PAGE"
echo "  4. Come back to THIS window and press Enter"
echo ""
read -p "Press Enter to open the browser..."

node setup-login.js

if [ ! -f "session.json" ]; then
  echo ""
  echo "❌  Login session was not saved."
  echo "    Run this setup again and press Enter AFTER you see the home page."
  read -p "Press Enter to close..."
  exit 1
fi

echo ""
echo "============================================================"
echo "  ✅  All done! You can now use the other scripts."
echo "============================================================"
echo ""
read -p "Press Enter to close..."
