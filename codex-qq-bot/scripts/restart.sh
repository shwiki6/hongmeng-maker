#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$ROOT/scripts/daemonize.sh"
