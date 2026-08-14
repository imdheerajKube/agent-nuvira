#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  Agent-Nuvira — Linux one-command setup
#  ──────────────────────────────────────────────────────────────────────────────
#  Safe for a fresh Linux machine (Ubuntu/Debian, Fedora/RHEL, Arch, Alpine)
#  with NO tools installed. It will:
#    1. Detect your package manager (apt / dnf / yum / pacman / apk)
#    2. Check for required tools (curl, git, build tools, Node.js, npm)
#    3. Install whatever is missing (asks first; uses sudo when needed)
#    4. Install agent-nuvira globally
#    5. Offer optional performance upgrades:
#         • Native FAISS  → faster semantic search / memory recall
#         • Local embeddings → free, offline, private embeddings
#  Run it with:  bash <(curl -fsSL https://raw.githubusercontent.com/imdheerajKube/agent-nuvira/main/scripts/setup/install-linux.sh)
#  or download it and run:  bash install-linux.sh
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

# ─── 1. Detect package manager ─────────────────────────────────────────────────
PM=""
PM_INSTALL=""
if   command -v apt-get >/dev/null 2>&1; then PM=apt;  PM_INSTALL="sudo apt-get update -y && sudo apt-get install -y"
elif command -v dnf     >/dev/null 2>&1; then PM=dnf;  PM_INSTALL="sudo dnf install -y"
elif command -v yum     >/dev/null 2>&1; then PM=yum;  PM_INSTALL="sudo yum install -y"
elif command -v pacman  >/dev/null 2>&1; then PM=pacman; PM_INSTALL="sudo pacman -S --noconfirm"
elif command -v apk     >/dev/null 2>&1; then PM=apk;  PM_INSTALL="sudo apk add --no-cache"
else fail "No supported package manager found (apt/dnf/yum/pacman/apk)."
fi
ok "Package manager detected: $PM"

pm_install() { # $@ = packages to install via the detected manager
  case "$PM" in
    apt)    sudo apt-get update -y >/dev/null 2>&1; sudo apt-get install -y "$@" ;;
    dnf)    sudo dnf install -y "$@" ;;
    yum)    sudo yum install -y "$@" ;;
    pacman) sudo pacman -S --noconfirm "$@" ;;
    apk)    sudo apk add --no-cache "$@" ;;
  esac
}

# ─── 2. Check for missing tools ────────────────────────────────────────────────
step "Checking required tools…"

MISSING=()
command -v curl >/dev/null 2>&1 || MISSING+=(curl)
command -v git  >/dev/null 2>&1 || MISSING+=(git)
command -v node >/dev/null 2>&1 || MISSING+=(node)
command -v npm  >/dev/null 2>&1 || MISSING+=(npm)
# Native builds (node-gyp) need a C/C++ toolchain + make
command -v gcc >/dev/null 2>&1 || MISSING+=(build-tools)

if [[ ${#MISSING[@]} -eq 0 ]]; then
  ok "All required tools present (curl, git, node $(node -v 2>/dev/null || echo '?'), npm, build tools)"
else
  warn "Missing: ${MISSING[*]}"
  if ! confirm "Install the missing tools now? (uses sudo; safe and automated)"; then
    fail "Required tools are missing. Install them and re-run this script."
  fi
fi

# ─── 3. Install missing tools ──────────────────────────────────────────────────
if [[ " ${MISSING[*]} " == *" build-tools "* ]]; then
  step "Installing build tools (gcc/g++/make)…"
  case "$PM" in
    apt)    pm_install build-essential make ;;
    dnf|yum) pm_install gcc gcc-c++ make ;;
    pacman) pm_install base-devel make ;;
    apk)    pm_install build-base make ;;
  esac
  ok "Build tools installed"
fi

if [[ " ${MISSING[*]} " == *" curl "* ]]; then pm_install curl && ok "curl installed"; fi
if [[ " ${MISSING[*]} " == *" git "* ]]; then pm_install git && ok "Git installed"; fi

# Node.js + npm — prefer the distro package (works everywhere), fall back to nvm
if [[ " ${MISSING[*]} " == *" node "* || " ${MISSING[*]} " == *" npm "* ]]; then
  step "Installing Node.js + npm…"
  case "$PM" in
    apt)  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1 && pm_install nodejs || pm_install nodejs npm ;;
    dnf|yum) curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1 && pm_install nodejs || pm_install nodejs npm ;;
    pacman) pm_install nodejs npm ;;
    apk)  pm_install nodejs npm ;;
  esac
  # Final fallback: nvm (user-level, no sudo needed)
  if ! command -v node >/dev/null 2>&1; then
    warn "Distro Node.js install failed — falling back to nvm…"
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1091
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    nvm install --lts >/dev/null 2>&1
  fi
  command -v node >/dev/null 2>&1 || fail "Node.js install failed. Install Node 20+ manually and re-run."
  ok "Node.js $(node -v) + npm $(npm -v) installed"
fi

# ─── 4. Install agent-nuvira ───────────────────────────────────────────────────
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

# ─── 5. Optional performance upgrades ─────────────────────────────────────────
echo ""
step "Optional upgrades (recommended for the best experience)"

if confirm "Install native FAISS for faster semantic search? (recommended)"; then
  step "Installing FAISS native libraries…"
  case "$PM" in
    apt)    pm_install libfaiss-dev libomp-dev || warn "libfaiss-dev not available in your distro — pure-JS backend will be used" ;;
    dnf|yum) pm_install faiss-devel openmp-devel || warn "faiss-devel not available — pure-JS backend will be used" ;;
    pacman) pm_install faiss openmp || warn "faiss not available — pure-JS backend will be used" ;;
    apk)    warn "Alpine: FAISS native package unavailable — pure-JS backend will be used" ;;
  esac
  step "Rebuilding the native FAISS addon…"
  npm rebuild @faiss-node/native 2>/dev/null || warn "Native FAISS rebuild failed — the pure-JS backend will be used automatically"
  ok "FAISS setup attempted"
else
  warn "Skipping native FAISS — Agent-Nuvira will use the pure-JS backend (still works, slightly slower)."
fi

if confirm "Enable local embeddings (free, offline, private)? (recommended)"; then
  npm rebuild onnxruntime-node >/dev/null 2>&1 || true
  ok "Local embeddings enabled — uses Xenova/all-MiniLM-L6-v2 (384-dim)"
else
  warn "Skipping local embeddings — Agent-Nuvira will fall back to cloud/LLM embeddings."
fi

# ─── 6. Verify ─────────────────────────────────────────────────────────────────
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
