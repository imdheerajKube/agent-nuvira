#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  Agent-Nuvira — macOS one-command setup
#  ──────────────────────────────────────────────────────────────────────────────
#  Safe for a brand-new Mac with NO tools installed. It will:
#    1. Check for required tools (brew, Node.js, npm, git, Xcode CLT)
#    2. Install whatever is missing (asks before installing)
#    3. Install agent-nuvira globally
#    4. Offer optional performance upgrades:
#         • Native FAISS  → faster semantic search / memory recall
#         • Local embeddings → free, offline, private embeddings
#  Run it with:  bash <(curl -fsSL https://raw.githubusercontent.com/imdheerajKube/agent-nuvira/main/scripts/setup/install-macos.sh)
#  or download it and run:  bash install-macos.sh
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Pretty output helpers ─────────────────────────────────────────────────────
GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RED=$'\033[31m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
step()  { echo "${BOLD}${CYAN}── $*${RESET}"; }
ok()    { echo "${GREEN}✔ $*${RESET}"; }
warn()  { echo "${YELLOW}⚠ $*${RESET}"; }
fail()  { echo "${RED}✘ $*${RESET}"; exit 1; }

confirm() { # $1 = question; returns 0 for yes / 1 for no (default yes)
  local answer
  printf "%s [Y/n] " "$1"
  read -r answer
  [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}

# ─── 1. Check for missing tools ────────────────────────────────────────────────
step "Checking required tools…"

MISSING=()
command -v brew >/dev/null 2>&1 || MISSING+=(brew)
command -v node  >/dev/null 2>&1 || MISSING+=(node)
command -v npm   >/dev/null 2>&1 || MISSING+=(npm)
command -v git   >/dev/null 2>&1 || MISSING+=(git)
command -v xcode-select >/dev/null 2>&1 && xcode-select -p >/dev/null 2>&1 || MISSING+=(xcode-clt)

if [[ ${#MISSING[@]} -eq 0 ]]; then
  ok "All required tools present (brew, node $(node -v 2>/dev/null || echo '?'), npm, git, Xcode CLT)"
else
  warn "Missing: ${MISSING[*]}"
  if ! confirm "Install the missing tools now? (This is safe and automated)"; then
    fail "Required tools are missing. Install them and re-run this script."
  fi
fi

# ─── 2. Install missing tools ──────────────────────────────────────────────────
# Xcode Command Line Tools (needed by node-gyp / native builds) — GUI prompt
if [[ " ${MISSING[*]} " == *" xcode-clt "* ]]; then
  step "Installing Xcode Command Line Tools (a system dialog will appear)…"
  xcode-select --install >/dev/null 2>&1 || true
  echo "   Waiting for the Xcode CLT installation to finish — press Enter once it completes."
  read -r
  xcode-select -p >/dev/null 2>&1 || fail "Xcode Command Line Tools not detected. Re-run after installing them."
  ok "Xcode Command Line Tools installed"
fi

# Homebrew
if [[ " ${MISSING[*]} " == *" brew "* ]]; then
  step "Installing Homebrew (macOS package manager)…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ -f /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -f /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  else
    fail "Homebrew install didn't produce a usable 'brew' command. Add it to PATH and re-run."
  fi
  ok "Homebrew installed"
fi
command -v brew >/dev/null 2>&1 || eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null)"

# Node.js + npm
if [[ " ${MISSING[*]} " == *" node "* || " ${MISSING[*]} " == *" npm "* ]]; then
  step "Installing Node.js (via Homebrew)…"
  brew install node
  ok "Node.js $(node -v) + npm $(npm -v) installed"
fi

# Git
if [[ " ${MISSING[*]} " == *" git "* ]]; then
  step "Installing Git…"
  brew install git
  ok "Git installed"
fi

# ─── 3. Install agent-nuvira ───────────────────────────────────────────────────
step "Installing Agent-Nuvira globally…"
NPM_MAJOR=$(npm -v | cut -d. -f1)
if [[ "$NPM_MAJOR" -ge 11 ]]; then
  # npm 11+ blocks package install scripts by default; allow the native ones
  # so FAISS + local embeddings actually build.
  npm install -g --allow-scripts=@faiss-node/native,baileys,onnxruntime-node,sharp,protobufjs agent-nuvira
else
  npm install -g agent-nuvira
fi
ok "Agent-Nuvira installed"

# ─── 4. Optional performance upgrades ─────────────────────────────────────────
echo ""
step "Optional upgrades (recommended for the best experience)"

if confirm "Install native FAISS for faster semantic search? (recommended)"; then
  step "Installing FAISS native libraries (faiss, libomp, openblas)…"
  brew install faiss libomp openblas
  ok "FAISS libraries installed"
  step "Rebuilding the native FAISS addon…"
  npm rebuild @faiss-node/native
  ok "Native FAISS addon rebuilt"
else
  warn "Skipping native FAISS — Agent-Nuvira will use the pure-JS backend (still works, slightly slower)."
fi

if confirm "Enable local embeddings (free, offline, private)? (recommended)"; then
  # @huggingface/transformers + onnxruntime-node are dependencies; ensure their
  # install scripts ran so the onnxruntime binary is present.
  npm rebuild onnxruntime-node >/dev/null 2>&1 || true
  ok "Local embeddings enabled — uses Xenova/all-MiniLM-L6-v2 (384-dim)"
else
  warn "Skipping local embeddings — Agent-Nuvira will fall back to cloud/LLM embeddings."
fi

# ─── 5. Verify ─────────────────────────────────────────────────────────────────
step "Verifying installation…"
VERSION=$(agent-nuvira --version 2>/dev/null | tail -1 || buff --version 2>/dev/null | tail -1 || true)
if [[ -n "$VERSION" ]]; then
  ok "Agent-Nuvira $VERSION installed successfully"
else
  warn "agent-nuvira is installed but didn't print a version — check PATH and try 'agent-nuvira --version'."
fi
agent-nuvira memory stats >/dev/null 2>&1 && ok "Memory backend initialized" || warn "Memory stats unavailable until first run"

echo ""
echo "${GREEN}${BOLD}✅ Setup complete!${RESET}"
echo ""
echo "   Next steps:"
echo "     1. Add your AI provider keys (optional):"
echo "        agent-nuvira config set provider.groq.apiKey YOUR_KEY"
echo "        # or any provider from the config wizard:  agent-nuvira config"
echo "     2. Try it:   agent-nuvira chat  \"build a hello-world CLI\""
echo "     3. See all commands:   agent-nuvira --help"
echo ""
echo "   To reconfigure later:  agent-nuvira config"
