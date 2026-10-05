#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Nuvira-Router M0.1 — Regression Gate (baseline lock)
#
# The canonical no-regression guard for the routing/learning subsystem.
# Any failure in the areas below is a REGRESSION and fails the gate loudly.
#
# Runs, in order:
#   1. Agent contracts — prompt budget + skill-catalog opt-in + the toolchain
#                       clause + the routing-policy check (fast, fails fastest)
#   2. Routing guard  — bandit / promotion / auto-router / tier0 / hybrid /
#                       model-registry / provider-fallback (fast, fails fast)
#   3. Surface parity — tests/parity: the surface registry still matches the
#                       real import graph, no new silo bypasses the shared turn
#                       entry, and the capability matrix still separates a
#                       claim from a proof (fast; #22)
#   4. Parity CLI     — the same parity checks through the BUILT binary rather
#                       than through `src/`: `nuvira parity surfaces|debt|matrix|
#                       run`. Builds the CLI first (which also typechecks the
#                       tree — no other step here does), because `dist/` is
#                       gitignored and the artifact is the only thing a user
#                       ever runs.
#   5. Failover E2E   — tests/e2e/failover-learning.test.ts (the hermetic
#                       mock-429 -> learn -> skip -> recover loop; the single
#                       most important regression test for Nuvira-Router)
#   6. Full root suite — every root test (default; skipped with --fast)
#   7. Dashboard suite — src/web-dashboard typecheck + component tests
#                       (default; --fast)
#   8. Dashboard bundle — the COMMITTED artifact must be the one the source
#                       builds (default; --fast). A committed build artifact
#                       drifts silently: the component suite runs the source, so
#                       it passes whether or not the bundle was rebuilt.
#
# Usage:
#   bash scripts/ci/regression-gate.sh          # full gate (CI, ~4 min)
#   bash scripts/ci/regression-gate.sh --fast   # guard + parity CLI + E2E (~1.5 min)
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

# ── 1. Agent behaviour contracts (prompt budget + routing policy) ───────────
# The gate that would have caught v3.3.11: the skill CATALOG (24.5K chars) was
# injected into the chat system prompt on EVERY turn, taking it from 7,653 to
# 32,809 chars, and NOTHING asserted the prompt's size. These are cheap,
# deterministic contracts — prompt budget, the catalog staying opt-in, the
# toolchain-install clause, and the software-intent policy — so this class of
# regression cannot ship silently again. First, because it is the fastest and
# the most direct statement of "the agent still behaves".
step "1/8 Agent contracts (prompt budget / catalog opt-in / routing policy)"
if npx vitest run tests/release/agent-contracts.test.ts; then
  ok "agent contracts passed"
else
  bad "agent contracts FAILED — a prompt-budget or routing-policy regression"
fi

# ── 2. Routing guard ────────────────────────────────────────────────────────
step "2/8 Routing guard (bandit / promotion / auto-router / tier0 / hybrid / registry / fallback)"
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
step "3/8 Surface parity (registry / anti-silo / capability matrix / scenario parity)"
if npx vitest run tests/parity; then
  ok "surface parity passed"
else
  bad "surface parity FAILED — a surface, a silo rule or a capability claim drifted (#22)"
fi

# ── 3. Surface parity, from the built CLI ──────────────────────────────────
# Step 2 proves the harness works as SOURCE: vitest imports `src/`, so it never
# loads `dist/`. That leaves the shipped artifact unchecked — a command that is
# registered in `src/cli/cli-program.ts` but does not survive the build, or one
# whose import throws only when loaded through it, passes every source-level
# check and fails for the first user who types it. Same blind spot step 7
# guards for the committed dashboard bundle, and worse: `dist/` is gitignored,
# so nothing else in this gate would ever notice (step 8).
#
# `build:cli`, NOT `build` — the full build also rewrites the COMMITTED
# dashboard bundle, which would make step 7 pass by construction and leave the
# working tree dirty. It costs a few seconds and buys the only root typecheck
# in the gate.
step "4/8 Surface parity from the built CLI (nuvira parity …)"

# Each subcommand sets exit code 1 on a real drift, so this is a gate rather
# than a smoke test. `parity run` is the one that matters most: it drives all
# five real surfaces (chat, execute, dashboard, gateway, subagent) against a
# loopback stub provider, from the binary an install would ship.
parity_cli() {
  local name="$1"
  shift
  local out
  if out=$(node dist/index.js parity "$name" "$@" 2>&1); then
    ok "nuvira parity $name"
  else
    bad "nuvira parity $name FAILED — the built CLI disagrees with the harness"
    printf '%s\n' "$out" | sed 's/^/    /'
  fi
}

if npm run build:cli; then
  ok "built dist/cli"
  for sub in surfaces debt matrix run; do
    parity_cli "$sub"
  done
else
  bad "npm run build:cli FAILED — the parity CLI cannot be checked at all"
fi

# ── 4. Failover E2E (canonical no-regression guard) ────────────────────────
step "5/8 Failover-learning E2E"
if npx vitest run tests/e2e/failover-learning.test.ts; then
  ok "failover-learning E2E passed"
else
  bad "failover-learning E2E FAILED — the canonical routing no-regression guard"
fi

if [ "$FAST" = 1 ]; then
  step "(--fast: skipping steps 6-8 — full root + dashboard suites)"
else
  # ── 5. Full root suite ─────────────────────────────────────────────────────
  step "6/8 Full root suite"
  if npx vitest run; then
    ok "full root suite passed"
  else
    bad "full root suite FAILED"
  fi

  # ── 6. Dashboard component suite (typecheck + jsdom tests) ───────────────
  # `npm test` runs the tree's tsc --noEmit first: the dashboard bundle is built
  # by vite, which strips types without checking them, so this is the only gate
  # that can see a type error there.
  step "7/8 Dashboard typecheck + component suite"
  if (cd src/web-dashboard && npm test); then
    ok "dashboard typecheck + component suite passed"
  else
    bad "dashboard typecheck + component suite FAILED"
  fi

  # ── 7. Committed dashboard bundle vs its source ──────────────────────────
  # The dashboard the operator sees is src/web-dashboard/public, served straight
  # from the repo — so a bundle that was not rebuilt after a source change is a
  # shipped bug that no other step in this gate can see.
  step "8/8 Dashboard bundle matches its source"
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
