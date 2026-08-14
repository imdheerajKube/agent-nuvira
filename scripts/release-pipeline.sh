#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# release-pipeline.sh — build + test + (optionally) publish Agent-Nuvira
# OUTSIDE the Freebuff session, writing a clean, timestamped, analyzable log
# you can paste back to the AI for diagnosis.
#
# Why this exists: running the full build/test/publish inside a chat session
# burns 10+ minutes of session time. This script runs the same pipeline
# locally and produces a log whose LAST ~120 LINES are a self-contained
# summary — paste those into the chat and the AI can diagnose without
# re-running anything.
#
# Run it from anywhere:
#   bash scripts/release-pipeline.sh                          # VERIFY: build + test (safe default)
#   bash scripts/release-pipeline.sh --publish                # full: bump → git push → npm publish
#   bash scripts/release-pipeline.sh --dir /path/to/repo      # explicit project dir
#   bash /path/to/repo/scripts/release-pipeline.sh            # from any cwd (auto-detects repo)
#
# Options:
#   --publish                 Run the full publish pipeline (version bump, git
#                             commit/tag/push, npm publish). Without it the
#                             script only builds + tests + snapshots env.
#   --bump patch|minor|major  Version bump for --publish (default: patch)
#   --changelog "<title>"     Consolidate CHANGELOG.md via scripts/release-prep.mjs
#                             before the version bump (commit msg: "vX.Y.Z: <title>")
#   --skip-hooks              With --publish: `npm publish --ignore-scripts`.
#                             Trusts the pipeline's own build+test and skips npm's
#                             prepack/prepublishOnly re-runs (saves minutes).
#   --dry-run                 With --publish: `npm publish --dry-run` only — no
#                             version bump, no git push, no registry write.
#   --skip-tests              Skip the test step
#   --skip-build              Skip all build steps
#   --install                 Run `npm ci` first (fresh dependency install)
#   --dir <path>              Project directory (also accepted as positional arg)
#   -h, --help                Show this help
#
# Exit code 0 = every step passed. 1 = at least one step failed.
# ═══════════════════════════════════════════════════════════════════════════

set -u

# ── Options ─────────────────────────────────────────────────────────────────
PUBLISH=0
BUMP="patch"
CHANGELOG_TITLE=""
SKIP_HOOKS=0
DRY_RUN=0
SKIP_TESTS=0
SKIP_BUILD=0
INSTALL=0
PROJECT_DIR=""

usage() {
  sed -n '2,38p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --publish)    PUBLISH=1 ;;
    --bump)       shift; BUMP="${1:-patch}" ;;
    --changelog)  shift; CHANGELOG_TITLE="${1:-}" ;;
    --skip-hooks) SKIP_HOOKS=1 ;;
    --dry-run)    DRY_RUN=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --install)    INSTALL=1 ;;
    --dir)        shift; PROJECT_DIR="${1:-}" ;;
    -h|--help)    usage ;;
    -*)
      echo "✘ Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [ -n "$PROJECT_DIR" ]; then
        echo "✘ Unexpected argument: $1" >&2
        usage >&2
        exit 1
      fi
      PROJECT_DIR="$1"
      ;;
  esac
  shift
done

case "$BUMP" in
  patch|minor|major) ;;
  *) echo "✘ --bump must be patch, minor or major (got '$BUMP')" >&2; exit 1 ;;
esac

# ── Colors + log helpers ────────────────────────────────────────────────────
GREEN='\033[1;32m'; RED='\033[1;31m'; YELLOW='\033[1;33m'
BLUE='\033[1;34m'; RESET='\033[0m'

banner() { printf "${BLUE}══ %s ══${RESET}\n" "$1"; }
ok()     { printf "${GREEN}✔ %s${RESET}\n" "$1"; }
fail()   { printf "${RED}✘ %s${RESET}\n" "$1"; }
warn()   { printf "${YELLOW}! %s${RESET}\n" "$1"; }

# Strip ANSI colors + carriage returns (spinner noise) so the log is clean
# when pasted into chat.
strip_ansi() { sed -E 's/\x1B\[[0-9;]*[mK]//g' | tr -d '\r'; }

# ── Locate the project ──────────────────────────────────────────────────────
# Order: --dir / positional → directory of this script (repo root) → walk up
# from cwd looking for a package.json named "agent-nuvira".
resolve_project_dir() {
  if [ -n "$PROJECT_DIR" ]; then
    PROJECT_DIR="$(cd "$PROJECT_DIR" 2>/dev/null && pwd)" || {
      fail "Cannot cd into --dir '$PROJECT_DIR'"; exit 1;
    }
    return 0
  fi
  local script_dir root dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  root="$(dirname "$script_dir")"
  if [ -f "$root/package.json" ] && grep -q '"name"[[:space:]]*:[[:space:]]*"agent-nuvira"' "$root/package.json"; then
    PROJECT_DIR="$root"; return 0
  fi
  dir="$(pwd)"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/package.json" ] && grep -q '"name"[[:space:]]*:[[:space:]]*"agent-nuvira"' "$dir/package.json"; then
      PROJECT_DIR="$dir"; return 0
    fi
    dir="$(dirname "$dir")"
  done
  fail "Could not locate the agent-nuvira project from '$(pwd)' — pass --dir <path>."
  exit 1
}

resolve_project_dir
cd "$PROJECT_DIR" || exit 1

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  fail "node/npm not found in PATH — install Node >= 18.18 first."
  exit 1
fi

# ── Log file ────────────────────────────────────────────────────────────────
mkdir -p "$PROJECT_DIR/release-logs"
LOG_FILE="$PROJECT_DIR/release-logs/release-$(date +%Y%m%d-%H%M%S).log"
: > "$LOG_FILE"

declare -a STEP_NAMES=()
declare -a STEP_STATUS=()   # OK / FAIL / SKIP
declare -a STEP_DUR=()
declare -a STEP_TMPS=()     # per-step temp captures (for failure tails)
TOTAL_START="$(date +%s)"
FAILED_STEPS=()

# run_step <name> <cmd...> — runs, tees live output (ANSI-stripped) to both the
# log and a per-step temp file, records status/duration.
run_step() {
  local name="$1"; shift
  local step_tmp start end rc
  step_tmp="$(mktemp "${TMPDIR:-/tmp}/relstep.XXXXXX")"
  STEP_TMPS+=("$step_tmp")
  start="$(date +%s)"
  banner "$name"
  printf '    cmd: %s\n' "$*"
  {
    printf '\n──── %s ────\n    cmd: %s\n' "$name" "$*"
  } >> "$LOG_FILE"

  "$@" 2>&1 | strip_ansi | tee -a "$LOG_FILE" "$step_tmp"
  rc="${PIPESTATUS[0]}"
  end="$(date +%s)"

  STEP_NAMES+=("$name")
  STEP_DUR+=("$((end - start))")
  if [ "$rc" -eq 0 ]; then
    STEP_STATUS+=("OK")
    ok "$name — OK ($((end - start))s)"
  else
    STEP_STATUS+=("FAIL")
    FAILED_STEPS+=("$name")
    fail "$name — FAILED (exit $rc, $((end - start))s)"
    echo
    warn "── last 30 lines of the failed step:"
    tail -n 30 "$step_tmp" | sed 's/^/    /'
    echo
  fi
  return "$rc"
}

skip_step() {
  STEP_NAMES+=("$1")
  STEP_STATUS+=("SKIP")
  STEP_DUR+=("0")
  warn "Skipped: $1"
}

# ── 0. Environment snapshot ─────────────────────────────────────────────────
{
  echo "════════════════════════════════════════════════════════"
  echo "Agent-Nuvira release pipeline — $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  if [ "$PUBLISH" = 1 ]; then
    echo "mode:   PUBLISH ($([ "$DRY_RUN" = 1 ] && echo 'dry-run — no writes' || echo "bump=$BUMP"))"
  else
    echo "mode:   VERIFY (build + test only — no git/npm writes)"
  fi
  echo "node:   $(node -v)   npm: $(npm -v)"
  echo "os:     $(uname -srm 2>/dev/null)"
  echo "branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'not a git repo')"
  echo "commit: $(git log -1 --format='%h %s' 2>/dev/null || echo '-')"
  echo "dirty:  $(git status --porcelain 2>/dev/null | wc -l | tr -d ' ') file(s) changed"
  echo "pkg:    agent-nuvira@$(node -p "require('./package.json').version" 2>/dev/null)"
  echo "════════════════════════════════════════════════════════"
} | tee -a "$LOG_FILE"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  warn "node < 18 — package.json engines requires >=18.18.0"
fi
if [ "$PUBLISH" = 1 ] && [ "$DRY_RUN" = 0 ]; then
  DIRTY_COUNT="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${DIRTY_COUNT:-0}" -gt 0 ]; then
    warn "Working tree has $DIRTY_COUNT changed file(s). The release commit will include"
    warn "only package/lockfile + staged CHANGELOG changes; other uncommitted work stays local."
  fi
fi

# ── 1. Install (optional) ───────────────────────────────────────────────────
FAIL_TOTAL=0
if [ "$INSTALL" = 1 ]; then
  run_step "Install dependencies (npm ci)" npm ci || FAIL_TOTAL=1
fi

# ── 2. Build ────────────────────────────────────────────────────────────────
if [ "$SKIP_BUILD" = 1 ]; then
  skip_step "Build (npm run build + dashboard + sdk)"
else
  run_step "Build (npm run build)" npm run build || FAIL_TOTAL=1
  run_step "Dashboard build (npm run build:dashboard)" npm run build:dashboard || FAIL_TOTAL=1
  run_step "Agent SDK build (npm run build:sdk)" npm run build:sdk || FAIL_TOTAL=1
fi

# ── 3. Tests ────────────────────────────────────────────────────────────────
if [ "$SKIP_TESTS" = 1 ]; then
  skip_step "Test suite (npm test)"
else
  export CI=1
  export NODE_OPTIONS=--no-warnings
  run_step "Test suite (npm test)" npm test || FAIL_TOTAL=1
fi

# ── 4. Publish (only with --publish and only if build/test passed) ─────────
if [ "$PUBLISH" = 1 ]; then
  if [ "$FAIL_TOTAL" = 1 ]; then
    fail "Skipping publish — build/test steps failed. Fix, then re-run."
  elif [ "$DRY_RUN" = 1 ]; then
    run_step "npm publish --dry-run" npm publish --dry-run || FAIL_TOTAL=1
  else
    if [ -n "$CHANGELOG_TITLE" ]; then
      NEW_VERSION="$(node -p "require('./package.json').version" 2>/dev/null)"
      run_step "Changelog prep (release-prep.mjs $NEW_VERSION)" \
        node scripts/release-prep.mjs "$NEW_VERSION" "$CHANGELOG_TITLE" || FAIL_TOTAL=1
      git add CHANGELOG.md 2>/dev/null
    fi
    bump_msg="v%s: release"
    [ -n "$CHANGELOG_TITLE" ] && bump_msg="v%s: $CHANGELOG_TITLE"
    run_step "Version bump (npm version $BUMP)" \
      npm version "$BUMP" -m "$bump_msg" || FAIL_TOTAL=1
    if [ "$FAIL_TOTAL" = 0 ]; then
      run_step "Git push (branch)" git push origin HEAD || FAIL_TOTAL=1
      run_step "Git push (tags — triggers CI publish + GitHub release)" git push origin --tags || FAIL_TOTAL=1
      if [ "$SKIP_HOOKS" = 1 ]; then
        warn "npm publish --ignore-scripts — trusting the pipeline's build+test (saves minutes)."
        run_step "npm publish (--ignore-scripts)" npm publish --ignore-scripts || FAIL_TOTAL=1
      else
        warn "npm publish re-runs build+test via prepack/prepublishOnly hooks — this is the slow part;"
        warn "add --skip-hooks to skip it (the pipeline already verified build+test above)."
        run_step "npm publish" npm publish || FAIL_TOTAL=1
      fi
    else
      fail "Skipping git push / npm publish — version bump failed."
    fi
  fi
fi

# ── 5. Summary ──────────────────────────────────────────────────────────────
TOTAL_END="$(date +%s)"
{
  echo
  echo "════════════════════════════════════════════════════════"
  echo "SUMMARY — agent-nuvira release pipeline"
  echo "════════════════════════════════════════════════════════"
  for i in "${!STEP_NAMES[@]}"; do
    printf '  %-4s %-42s %8ss\n' "${STEP_STATUS[$i]}" "${STEP_NAMES[$i]}" "${STEP_DUR[$i]}"
  done
  printf '  %-4s %-42s %8ss\n' "" "TOTAL" "$((TOTAL_END - TOTAL_START))"
  echo
  if [ "$FAIL_TOTAL" = 0 ] && [ ${#FAILED_STEPS[@]} -eq 0 ]; then
    echo "  ✅ ALL STEPS PASSED"
    if [ "$PUBLISH" = 1 ] && [ "$DRY_RUN" = 0 ]; then
      echo "  published: agent-nuvira@$(node -p "require('./package.json').version" 2>/dev/null)"
      echo "  (tag push also triggered CI: tests → npm → GitHub Packages → GitHub Release)"
    fi
  else
    echo "  ❌ FAILURES PRESENT:"
    for s in "${FAILED_STEPS[@]}"; do
      echo "     - $s"
    done
  fi
  echo
  echo "  log file: $LOG_FILE"
  echo "════════════════════════════════════════════════════════"
  echo
  echo "  📋 To hand this run to the AI for analysis, paste the last ~120 lines:"
  echo "     tail -n 120 '$LOG_FILE'"
} | tee -a "$LOG_FILE"

# cleanup per-step temp captures
for t in "${STEP_TMPS[@]:-}"; do
  [ -n "$t" ] && rm -f "$t"
done

[ "$FAIL_TOTAL" = 0 ] && [ ${#FAILED_STEPS[@]} -eq 0 ]
