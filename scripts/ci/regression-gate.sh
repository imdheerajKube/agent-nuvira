#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Nuvira-Router M0.1 — Regression Gate (baseline lock)
#
# The canonical no-regression guard for the routing/learning subsystem.
# Any failure in the areas below is a REGRESSION and fails the gate loudly.
#
# Runs, in order:
#   1. Routing guard  — bandit / promotion / auto-router / tier0 / hybrid /
#                       model-registry / provider-fallback (fast, fails fast)
#   2. Failover E2E   — tests/e2e/failover-learning.test.ts (the hermetic
#                       mock-429 -> learn -> skip -> recover loop; the single
#                       most important regression test for Nuvira-Router)
#   3. Full root suite — every root test (default; skipped with --fast)
#   4. Dashboard suite — src/web-dashboard component tests (default; --fast)
#
# Usage:
#   bash scripts/ci/regression-gate.sh          # full gate (CI, ~4 min)
#   bash scripts/ci/regression-gate.sh --fast   # guard + E2E only (~1 min)
#
# Exit code 0 = baseline locked. Anything else = regression, fix before merge.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root

FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

FAIL=0
step() { printf '\n\033[1;34m══ %s ══\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m✔ %s\033[0m\n' "$1"; }
bad()  { printf '\033[1;31m✘ %s\033[0m\n' "$1"; FAIL=1; }

export CI=1
export NODE_OPTIONS=--no-warnings

# ── 1. Routing guard ────────────────────────────────────────────────────────
step "1/4 Routing guard (bandit / promotion / auto-router / tier0 / hybrid / registry / fallback)"
if npx vitest run \
    tests/learning/router-bandit.test.ts \
    tests/learning/router-promotion.test.ts \
    tests/learning/auto-router.test.ts \
    tests/learning/tier0-router.test.ts \
    tests/learning/hybrid-router.test.ts \
    tests/learning/model-registry.test.ts \
    tests/learning/provider-fallback.test.ts; then
  ok "routing guard passed"
else
  bad "routing guard FAILED — a routing/learning regression"
fi

# ── 2. Failover E2E (canonical no-regression guard) ─────────────────────────
step "2/4 Failover-learning E2E"
if npx vitest run tests/e2e/failover-learning.test.ts; then
  ok "failover-learning E2E passed"
else
  bad "failover-learning E2E FAILED — the canonical routing no-regression guard"
fi

if [ "$FAST" = 1 ]; then
  step "(--fast: skipping full root + dashboard suites)"
else
  # ── 3. Full root suite ───────────────────────────────────────────────────
  step "3/4 Full root suite"
  if npx vitest run; then
    ok "full root suite passed"
  else
    bad "full root suite FAILED"
  fi

  # ── 4. Dashboard component suite ─────────────────────────────────────────
  step "4/4 Dashboard component suite"
  if (cd src/web-dashboard && npx vitest run); then
    ok "dashboard component suite passed"
  else
    bad "dashboard component suite FAILED"
  fi
fi

echo
if [ "$FAIL" = 0 ]; then
  printf '\033[1;32m✅ Baseline locked — no regressions detected.\033[0m\n'
  exit 0
else
  printf '\033[1;31m❌ REGRESSION DETECTED — fix before merge.\033[0m\n'
  exit 1
fi
