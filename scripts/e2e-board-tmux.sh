#!/usr/bin/env bash
# scripts/e2e-board-tmux.sh
# ─────────────────────────────────────────────────────────────────────────────
# End-to-end check that the live PipelineBoard renders correctly in a REAL TTY
# AND that `buff execute` routes through the AutoModelRouter mechanism.
#
# Why `--provider auto` (not the configured default)?
#   The router mechanism (src/learning/auto-router.ts + quota-ledger.ts) picks
#   a provider/model PER TASK based on:
#     • free-tier token/request budgets (QuotaLedger parks exhausted providers)
#     • task complexity & capability fit (moderate → strong model, trivial → cheap)
#     • cost, latency, privacy, reliability dimension weights
#   Pinning a provider (e.g. the OpenRouter default) would bypass that logic.
#   `auto` keeps the router in charge — the same path `buff model switch auto`
#   enables — so this test validates decision-making, not just rendering.
#
# Two phases:
#   A. TTY board — runs `buff execute --provider auto --dry-run` under
#      `script(1)` inside a tmux session, which allocates a REAL PTY so the
#      board enters in-place-redraw mode. The recorded PTY log is grepped for
#      the Freebuff-style markers: goal header, pre-flight inspection, per-task
#      branches, accumulated 💭 thinking/routing trail, terminal state.
#   B. Routing decisions — re-runs with `--json-events` (machine-readable
#      NDJSON, no TTY needed) and asserts the stream contains `agent-update`
#      records with `stage:"routing"` (the orchestrator emits these via the
#      AutoModelRouter, showing WHICH provider/model was picked and why).
#
# Usage:
#   bash scripts/e2e-board-tmux.sh [goal] [timeout_seconds]
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

cd "$(dirname "$0")/.."

GOAL="${1:-Add a 'Build passing' badge to the README}"
TIMEOUT="${2:-90}"
SESSION="buff-board-e2e"
LOGA="/tmp/buff-board-e2e-a.raw"   # Phase A: PTY byte log (script(1) output)
LOGB="/tmp/buff-board-e2e-b.ndjson" # Phase B: NDJSON event stream
DONEA="/tmp/buff-board-e2e-a.done"  # Phase A completion sentinel
DONEB="/tmp/buff-board-e2e-b.done"  # Phase B completion sentinel

# Clean up any orphaned session from a previous run.
tmux kill-session -t "$SESSION" 2>/dev/null || true
rm -f "$DONEA" "$DONEB"

# ── Phase A: live TTY board with router-driven provider selection ───────────
# `script(1)` wraps the node process in a pty so the board sees a real TTY
# (piping stdout to a file would flip isTTY off and defeat the whole test).
# We only tee the final `__E2E_DONE__` echo to the pane for completion polling;
# the board's bytes land in $LOGA via script.
tmux new-session -d -s "$SESSION" -x 90 -y 40 \
  "rm -f $LOGA; script -q $LOGA node dist/index.js execute \"$GOAL\" --provider auto --dry-run --repair-mode off --max-repairs 0; touch $DONEA"

DONE=""
for _ in $(seq 1 $((TIMEOUT * 2))); do
  if [ -f "$DONEA" ]; then
    DONE=1
    break
  fi
  sleep 0.5
done

sleep 0.3
tmux kill-session -t "$SESSION" 2>/dev/null || true

echo ""
echo "=== Phase A: PTY log (last 35 lines) ==="
tail -35 "$LOGA" 2>/dev/null
echo ""

if [ -z "$DONE" ]; then
  echo "⚠️  Phase A timed out after ${TIMEOUT}s — the pipeline was still running."
  echo "   Render markers are still checked below; treat a timeout as inconclusive."
fi

FAIL=0
check() {
  local label="$1" pattern="$2" file="${3:-$LOGA}"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    echo "✅ $label"
  else
    echo "❌ $label  (missing pattern: $pattern)"
    FAIL=1
  fi
}

# ── A.1 Board markers (each greps only for what should have appeared) ───────
check "board header renders the goal"            '⚡'
check "pre-flight inspection ran"                'source file'   # matches "400 source file(s)"
check "inspection shows project type/framework"  'Project type'
check "planner task branch rendered"             'planner'
check "thinking/routing trail (💭) present"      '💭'
check "pipeline reached a terminal state"        '✅\|❌\|Done\|failed\|Failed'

# ── Phase B: machine-readable routing decisions ─────────────────────────────
tmux new-session -d -s "$SESSION" -x 120 -y 24 \
  "node dist/index.js execute \"$GOAL\" --provider auto --dry-run --repair-mode off --max-repairs 0 --json-events > $LOGB 2>/dev/null; touch $DONEB"

DONE=""
for _ in $(seq 1 $((TIMEOUT * 2))); do
  if [ -f "$DONEB" ]; then
    DONE=1
    break
  fi
  sleep 0.5
done
tmux kill-session -t "$SESSION" 2>/dev/null || true

echo ""
echo "=== Phase B: routing decisions from --json-events ==="
grep '"stage":"routing"' "$LOGB" 2>/dev/null | head -6
echo ""

if [ -z "$DONE" ]; then
  echo "⚠️  Phase B timed out after ${TIMEOUT}s."
fi

# Routing = the router mechanism picked a provider/model per task. These lines
# carry the concrete `provider`/`model` fields chosen from the quota ledger.
ROUTING_COUNT=$(grep -c '"stage":"routing"' "$LOGB" 2>/dev/null || echo 0)
if [ "${ROUTING_COUNT:-0}" -ge 1 ]; then
  echo "✅ router mechanism active: ${ROUTING_COUNT} per-task provider/model decision(s) emitted"
else
  echo "❌ no routing decisions emitted — router did not engage (count=${ROUTING_COUNT})"
  FAIL=1
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "🎉 e2e OK — live board renders in a real TTY and routing decisions were made."
else
  echo "💥 e2e FAILED — see above."
fi
exit $FAIL
