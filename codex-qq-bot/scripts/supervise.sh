#!/usr/bin/env bash
# Persistent supervisor for codex-qq-bot under Android/PRoot.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p logs

# Ignore hangup; keep running after parent shells die.
trap '' HUP
trap 'echo "[supervise] got SIGTERM at $(date -Is)" >> logs/supervise.log; exit 0' TERM
trap 'echo "[supervise] got SIGINT at $(date -Is)" >> logs/supervise.log; exit 0' INT

backoff=1
max_backoff=20
echo "[supervise] start $(date -Is) pid=$$ ppid=$PPID root=$ROOT" >> logs/supervise.log

while true; do
  echo "[supervise] launching bot $(date -Is)" >> logs/supervise.log
  # Run bot in its own session; capture exit
  setsid node src/index.js >> logs/bot.log 2>&1 &
  child=$!
  echo "$child" > logs/bot.pid
  echo "[supervise] bot pid=$child" >> logs/supervise.log

  # Wait and also refresh a supervise heartbeat
  while kill -0 "$child" 2>/dev/null; do
    date -u +%Y-%m-%dT%H:%M:%S.%3NZ > logs/supervise.heartbeat 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ > logs/supervise.heartbeat
    sleep 5
  done
  wait "$child" 2>/dev/null
  code=$?
  echo "[supervise] bot exited code=$code at $(date -Is)" >> logs/supervise.log
  echo "[supervise] bot exited code=$code at $(date -Is)" >> logs/bot.log

  sleep "$backoff"
  if (( backoff < max_backoff )); then
    backoff=$(( backoff + 2 ))
  fi
done
