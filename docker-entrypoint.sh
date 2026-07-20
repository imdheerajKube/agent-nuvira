#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════════
#  docker-entrypoint.sh — Agent-Nuvira container initialization
# ═══════════════════════════════════════════════════════════════════════════════
#
#  Ensures the ~/.buff data directory exists, sets defaults, and runs the CLI.
#  Called by Docker with the CMD as arguments (e.g., "dashboard", "chat ...").
# ═══════════════════════════════════════════════════════════════════════════════

set -e

# ─── Constants ───────────────────────────────────────────────────────────────
BUFF_DIR="${HOME}/.buff"
MEMORY_DIR="${BUFF_DIR}/memory"
SKILLS_DIR="${BUFF_DIR}/skills"
PLUGINS_DIR="${BUFF_DIR}/plugins"

# ─── Ensure data directories exist ──────────────────────────────────────────
echo "🔧 Initializing Agent-Nuvira data directories..."
mkdir -p "${BUFF_DIR}"
mkdir -p "${MEMORY_DIR}"
mkdir -p "${SKILLS_DIR}"
mkdir -p "${PLUGINS_DIR}"

# ─── Log the runtime configuration ──────────────────────────────────────────
echo "   User:   $(whoami)"
echo "   Home:   ${HOME}"
echo "   Data:   ${BUFF_DIR}"
echo "   Node:   $(node --version)"
echo ""

# ─── If OLLAMA_HOST points to the companion container, note it ──────────────
if echo "${OLLAMA_HOST}" | grep -q "ollama"; then
  echo "   🦙 Local inference via: ${OLLAMA_HOST}"
  echo ""
fi

# ─── Count configured API keys (for display) ────────────────────────────────
CONFIGURED=0
[ -n "${GROQ_API_KEY}" ]       && CONFIGURED=$((CONFIGURED + 1))
[ -n "${NVIDIA_NIM_API_KEY}" ] && CONFIGURED=$((CONFIGURED + 1))
[ -n "${GEMINI_API_KEY}" ]     && CONFIGURED=$((CONFIGURED + 1))
[ -n "${OPENROUTER_API_KEY}" ] && CONFIGURED=$((CONFIGURED + 1))

if [ "${CONFIGURED}" -gt 0 ]; then
  echo "   ✅ ${CONFIGURED} API key(s) configured"
else
  echo "   ⚠️  No API keys set. Local providers only."
  echo "      Set keys in .env or pass as -e VAR=value to docker run."
fi
echo ""

# ─── Execute the CLI command ────────────────────────────────────────────────
# CMD is passed as arguments, e.g.:
#   dashboard          → launches the web dashboard
#   chat "hello"       → one-shot chat
#   execute "add auth" → multi-agent pipeline
#   models --all       → list all models
#
exec node /app/dist/index.js "$@"
