#!/usr/bin/env bash
# Runs the Chiqq performance comparison and writes results.md next to this script.
# Extra args are passed to run.js, e.g. ./run.sh --runtimes node --scenarios sync-c1
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
	if command -v bun >/dev/null 2>&1; then bun install; else npm install; fi
fi

node run.js "$@"
