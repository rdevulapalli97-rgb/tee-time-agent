#!/bin/bash
# ============================================================
#  Tee Time Agent — Stop Background Auto-Refresh
# ============================================================

cd "$(dirname "$0")"
PID_FILE="auto-run.pid"

echo ""

if [ ! -f "$PID_FILE" ]; then
  echo "ℹ️  Auto-refresh is not running (no PID file found)."
  read -p "Press Enter to close..."
  exit 0
fi

PID=$(cat "$PID_FILE")

if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  rm -f "$PID_FILE"
  echo "✅  Auto-refresh stopped (was PID $PID)."
  echo "    Run 3-AUTO-RUN.command to start it again."
else
  rm -f "$PID_FILE"
  echo "ℹ️  Auto-refresh was not running (PID $PID was stale — cleaned up)."
fi

echo ""
read -p "Press Enter to close..."
