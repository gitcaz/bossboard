#!/usr/bin/env bash
# Runs every test suite. Needs python3 (3.8+), node 20+, git; the smoke test also needs playwright-core + Chrome:
#   PLAYWRIGHT_CORE=/tmp/pw/node_modules/playwright-core CHROME=/usr/bin/google-chrome tests/run_all.sh
set -euo pipefail
cd "$(dirname "$0")"
echo "== python: merge + core";   python3 -m unittest -v test_merge 2>&1 | tail -3
echo "== python: CLI (git + REST backends, conflicts, migration)"; python3 -m unittest -v test_cli 2>&1 | tail -3
echo "== node: core.js + cross-language"; node --test core.test.mjs | grep -E "^# (pass|fail)"
echo "== node: e2e sync (2 offline web clients + CLI)"; node --test sync_e2e.test.mjs | grep -E "^# (pass|fail)"
if [ "${SKIP_SMOKE:-}" != "1" ]; then echo "== playwright smoke (mobile + desktop)"; node smoke.playwright.mjs; fi
