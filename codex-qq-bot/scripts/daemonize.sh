#!/usr/bin/env bash
# Fully detach supervisor from current tool shell.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p logs

# Stop previous
if [[ -f logs/bot.pid ]]; then kill "$(cat logs/bot.pid)" 2>/dev/null || true; fi
if [[ -f logs/supervise.pid ]]; then kill "$(cat logs/supervise.pid)" 2>/dev/null || true; fi
# Narrow pkill patterns
pkill -f '/projects/codex-qq-bot/src/index.js' 2>/dev/null || true
pkill -f '/projects/codex-qq-bot/scripts/supervise.sh' 2>/dev/null || true
sleep 1

# Rotate bot log
if [[ -s logs/bot.log ]]; then
  mv logs/bot.log "logs/bot.log.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
fi
: > logs/bot.log
echo "[daemonize] $(date -Is)" >> logs/supervise.log

# Double fork style via setsid + nohup + stdin closed
nohup setsid bash "$ROOT/scripts/supervise.sh" </dev/null >>logs/supervise.log 2>&1 &
echo $! > logs/supervise.pid
# Give it a moment
sleep 3
echo "supervise=$(cat logs/supervise.pid)"
echo "bot=$(cat logs/bot.pid 2>/dev/null || echo none)"
pgrep -af 'codex-qq-bot/src/index.js|codex-qq-bot/scripts/supervise' || true
tail -n 25 logs/bot.log || true
tail -n 15 logs/supervise.log || true
