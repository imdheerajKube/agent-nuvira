#!/bin/bash
# Enterprise benchmark — run ONE arm.
#
# Both arms get the same treatment: a fresh copy of the pristine repository, the same
# TASK.md, the same services, the same incident schedule, and no time-based cut-off. The
# only thing that differs is the agent command, which is passed in.
#
# WHY THE ACTIVE TREE IS MIRRORED OUTSIDE THE WORKSPACE. On the 2026-10-26 round the patched
# arm deleted its own `run.log` during a cleanup step, and the tool-usage score had to be
# rebuilt from the CLI's session log. Transcripts, git state and the task file are written
# under $OUT, which the agent is never told about and never works in.
#
# Usage:
#   run-arm.sh --name nuvira --out /tmp/edx/arms/nuvira --src /tmp/edx/edx-platform \
#              --cmd 'nuvira chat "$(cat TASK.md)" -p deepseek -m deepseek-flash'
#
# Incidents: 1..6 are injected at INCIDENT_AT seconds (default 30/50/70/90/110/130 min,
# i.e. one after each phase has plausibly finished). Set INCIDENT_AT="" to disable.
set -u

NAME=""; OUT=""; SRC=""; CMD=""
INCIDENT_AT="${INCIDENT_AT:-1800 3000 4200 5400 6600 7800}"
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# Not a budget: a guard against a hung process writing into the workspace forever. The task
# itself has no time limit, and an arm that finishes in 40 minutes or in 5 hours is scored on
# what it delivered — this only stops a wedged run.
SAFETY_HOURS="${SAFETY_HOURS:-8}"

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --src) SRC="$2"; shift 2 ;;
    --cmd) CMD="$2"; shift 2 ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done
[ -z "$NAME" ] || [ -z "$OUT" ] || [ -z "$SRC" ] || [ -z "$CMD" ] && {
  echo "usage: run-arm.sh --name <arm> --out <dir> --src <pristine repo> --cmd '<agent command>'"
  exit 2
}

REPO="$OUT/repo"
mkdir -p "$OUT/logs"
[ -d "$REPO" ] || rsync -a --exclude .git "$SRC"/ "$REPO"/
cp "$REPO_ROOT/scripts/bench/enterprise/TASK.md" "$REPO/TASK.md"

# The environment contract, written where the agent will find it.
cat > "$REPO/ENVIRONMENT.md" <<'EOF'
# Environment for this task (provided, not built by you)

| Service | Endpoint | Credentials |
|---|---|---|
| MySQL 8 | 127.0.0.1:3307, db `edx` | root / edxroot |
| Oracle 23ai Free | 127.0.0.1:1521, service `FREEPDB1` | edx / EdxPass123 |
| Redis | 127.0.0.1:6380 | none |
| MongoDB | 127.0.0.1:27018 | none |
| Kubernetes | `kubectl` context `kind-enterprise` | cluster-admin |
| Ollama | 127.0.0.1:11434 (qwen2.5:0.5b, deepseek-coder:latest, gemma4:e4b) | none |

Python 3.12 and MySQL client headers are installed (`python3.12`, `pkg-config`,
`/opt/homebrew/opt/mysql-client`). Export these before building the venv:

```
export MYSQLCLIENT_CFLAGS="-I/opt/homebrew/opt/mysql-client/include/mysql"
export MYSQLCLIENT_LDFLAGS="-L/opt/homebrew/opt/mysql-client/lib -lmysqlclient"
```
EOF

echo "START $NAME $(date -u +%FT%TZ) model=deepseek-flash" >> "$OUT/status"
T0=$(date +%s)
echo "$CMD" > "$OUT/logs/command.txt"

# Incident schedule: one real failure per phase, written as INCIDENT_<n>.md in the repo.
if [ -n "$INCIDENT_AT" ]; then
  (
    prev=0; i=1
    for at in $INCIDENT_AT; do
      sleep $(( at - prev )); prev=$at
      node "$REPO_ROOT/scripts/bench/enterprise/inject-incident.mjs" \
        --dir "$REPO" --incident "$i" >> "$OUT/logs/incidents.log" 2>&1
      i=$(( i + 1 ))
    done
  ) &
  INJECTOR=$!
fi

( cd "$REPO" && eval "$CMD" ) 2>&1 | tee "$OUT/logs/console.log" &
RUNNER=$!
(
  sleep $(( SAFETY_HOURS * 3600 ))
  echo "safety ceiling reached (${SAFETY_HOURS}h) — killing" >> "$OUT/logs/console.log"
  pkill -TERM -P "$RUNNER" 2>/dev/null; kill -TERM "$RUNNER" 2>/dev/null
) &
GUARD=$!
wait "$RUNNER"; EXIT=$?
kill "$GUARD" 2>/dev/null
wait "$RUNNER" 2>/dev/null
echo "exit=$EXIT" > "$OUT/exit"

[ -n "${INJECTOR:-}" ] && kill "$INJECTOR" 2>/dev/null
node "$REPO_ROOT/scripts/bench/enterprise/inject-incident.mjs" --dir "$REPO" --restore >> "$OUT/logs/incidents.log" 2>&1
( cd "$REPO" && git init -q 2>/dev/null; git add -A 2>/dev/null; git -c user.email=bench@local -c user.name=bench commit -qm "arm result" 2>/dev/null )

T1=$(date +%s)
echo $(( T1 - T0 )) > "$OUT/seconds"
echo "END $NAME $(date -u +%FT%TZ) wall=$(( T1 - T0 ))s" >> "$OUT/status"
echo "DONE" > "$OUT/done"
