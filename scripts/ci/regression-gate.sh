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
#   2. Surface parity — tests/parity: the surface registry still matches the
#                       real import graph, no new silo bypasses the shared turn
#                       entry, and the capability matrix still separates a
#                       claim from a proof (fast; #22)
#   3. Failover E2E   — tests/e2e/failover-learning.test.ts (the hermetic
#                       mock-429 -> learn -> skip -> recover loop; the single
#                       most important regression test for Nuvira-Router)
#   4. Full root suite — every root test (default; skipped with --fast)
#   5. Dashboard suite — src/web-dashboard typecheck + component tests
#                       (default; --fast)
#   6. Dashboard bundle — the COMMITTED artifact must be the one the source
#                       builds (default; --fast). A committed build artifact
#                       drifts silently: the component suite runs the source, so
#                       it passes whether or not the bundle was rebuilt.
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
step "1/6 Routing guard (bandit / promotion / auto-router / tier0 / hybrid / registry / fallback)"
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

# ── 2. Surface parity (the contract that keeps WS1-WS7 honest) ─────────────
# Cheap, and it fails for three different reasons that all matter: a surface
# stopped reaching the shared turn entry, a new bypass appeared, or a capability
# claims `supported` on a surface nothing can prove (the frozen debt list can
# only shrink). Runs before the E2E guard because a drift here invalidates the
# parity claims every other step is measured against.
step "2/6 Surface parity (registry / anti-silo / capability matrix / scenario parity)"
if npx vitest run tests/parity; then
  ok "surface parity passed"
else
  bad "surface parity FAILED — a surface, a silo rule or a capability claim drifted (#22)"
fi

# ── 3. Failover E2E (canonical no-regression guard) ────────────────────────
step "3/6 Failover-learning E2E"
if npx vitest run tests/e2e/failover-learning.test.ts; then
  ok "failover-learning E2E passed"
else
  bad "failover-learning E2E FAILED — the canonical routing no-regression guard"
fi

if [ "$FAST" = 1 ]; then
  step "(--fast: skipping full root + dashboard suites)"
else
  # ── 4. Full root suite ─────────────────────────────────────────────────────
  step "4/6 Full root suite"
  if npx vitest run; then
    ok "full root suite passed"
  else
    bad "full root suite FAILED"
  fi

  # ── 5. Dashboard component suite (typecheck + jsdom tests) ───────────────
  # `npm test` runs the tree's tsc --noEmit first: the dashboard bundle is built
  # by vite, which strips types without checking them, so this is the only gate
  # that can see a type error there.
  step "5/6 Dashboard typecheck + component suite"
  if (cd src/web-dashboard && npm test); then
    ok "dashboard typecheck + component suite passed"
  else
    bad "dashboard typecheck + component suite FAILED"
  fi

  # ── 6. Committed dashboard bundle vs its source ──────────────────────────
  # The dashboard the operator sees is src/web-dashboard/public, served straight
  # from the repo — so a bundle that was not rebuilt after a source change is a
  # shipped bug that no other step in this gate can see.
  step "6/6 Dashboard bundle matches its source"
  if npm run dashboard:bundle:check -- --rebuild; then
    ok "dashboard bundle matches its source"
  else
    bad "dashboard bundle is STALE — rebuild it: npm run build:dashboard"
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
