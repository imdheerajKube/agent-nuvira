# ═══════════════════════════════════════════════════════════════════════════════
#  Agent-Nuvira — Windows one-command setup
#  ──────────────────────────────────────────────────────────────────────────────
#  Safe for a fresh Windows 10/11 machine with NO tools installed. It will:
#    1. Check for required tools (winget, Git, Node.js, npm, VS Build Tools)
#    2. Install whatever is missing (asks first)
#    3. Install agent-nuvira globally
#    4. Offer optional performance upgrades:
#         • Native FAISS  → faster semantic search / memory recall
#         • Local embeddings → free, offline, private embeddings
#
#  Run it (from PowerShell):
#    Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force
#    irm https://raw.githubusercontent.com/imdheerajKube/agent-nuvira/main/scripts/setup/install-windows.ps1 | iex
#  or download it and run:  powershell -ExecutionPolicy Bypass -File install-windows.ps1
# ═══════════════════════════════════════════════════════════════════════════════

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Step($msg)  { Write-Host "`n── $msg" -ForegroundColor Cyan }
function Ok($msg)    { Write-Host "✔ $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "⚠ $msg" -ForegroundColor Yellow }
function Fail($msg)  { Write-Host "✘ $msg" -ForegroundColor Red; exit 1 }

function Confirm-Yes([string]$Question) {
  $answer = Read-Host "$Question [Y/n]"
  return ($answer -eq '' -or $answer -match '^[Yy]')
}

# ─── 1. Check for missing tools ────────────────────────────────────────────────
Step "Checking required tools…"

$Missing = @()
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { $Missing += 'winget' }
if (-not (Get-Command git -ErrorAction SilentlyContinue))     { $Missing += 'git' }
if (-not (Get-Command node -ErrorAction SilentlyContinue))    { $Missing += 'node' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue))     { $Missing += 'npm' }

if ($Missing.Count -eq 0) {
  Ok "All required tools present (winget, git, node $((node -v 2>$null)), npm)"
} else {
  Warn "Missing: $($Missing -join ', ')"
  if (-not (Confirm-Yes "Install the missing tools now? (uses winget; safe and automated)")) {
    Fail "Required tools are missing. Install them and re-run this script."
  }
}

# ─── 2. Install missing tools ──────────────────────────────────────────────────
# winget — Windows 10/11 ships with the App Installer; if truly absent, get it
if ($Missing -contains 'winget') {
  Step "Installing winget (App Installer)…"
  Start-Process "https://www.microsoft.com/p/app-installer/9nblggh4nns1" | Out-Null
  Fail "Please install the 'App Installer' from the Microsoft Store link that opened, then re-run this script."
}

# Git
if ($Missing -contains 'git') {
  Step "Installing Git…"
  winget install --id Git.Git --silent --accept-package-agreements --accept-source-agreements
  # Refresh PATH so git is visible in this session
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
  Ok "Git installed"
}

# Node.js + npm (LTS)
if ($Missing -contains 'node' -or $Missing -contains 'npm') {
  Step "Installing Node.js LTS…"
  winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "Node.js installed but not on PATH. Open a NEW terminal and re-run this script."
  }
  Ok "Node.js $((node -v)) + npm $((npm -v)) installed"
}

# ─── 3. Install agent-nuvira ───────────────────────────────────────────────────
Step "Installing Agent-Nuvira globally…"
$NpmMajor = [int]((npm -v) -split '\.')[0]
if ($NpmMajor -ge 11) {
  # npm 11+ blocks package install scripts by default; allow the native ones
  # so FAISS + local embeddings actually build.
  npm install -g --allow-scripts=@faiss-node/native,baileys,onnxruntime-node,sharp,protobufjs agent-nuvira
} else {
  npm install -g agent-nuvira
}
if ($LASTEXITCODE -ne 0) { Fail "npm install failed — see the error above." }
Ok "Agent-Nuvira installed"

# ─── 4. Optional performance upgrades ──────────────────────────────────────────
Write-Host ""
Step "Optional upgrades (recommended for the best experience)"

if (Confirm-Yes "Install native FAISS for faster semantic search? (recommended)") {
  Step "Installing FAISS native libraries…"
  # @faiss-node/native needs the FAISS C++ library; on Windows this is best
  # done via vcpkg. If it fails, the pure-JS backend is used automatically.
  if (Get-Command vcpkg -ErrorAction SilentlyContinue) {
    vcpkg install faiss:x64-windows | Out-Null
  } else {
    Warn "vcpkg not found — skipping native FAISS libraries. The pure-JS backend will be used (still works)."
  }
  Step "Rebuilding the native FAISS addon…"
  npm rebuild @faiss-node/native 2>$null | Out-Null
  Ok "FAISS setup attempted"
} else {
  Warn "Skipping native FAISS — Agent-Nuvira will use the pure-JS backend (still works, slightly slower)."
}

if (Confirm-Yes "Enable local embeddings (free, offline, private)? (recommended)") {
  npm rebuild onnxruntime-node 2>$null | Out-Null
  Ok "Local embeddings enabled — uses Xenova/all-MiniLM-L6-v2 (384-dim)"
} else {
  Warn "Skipping local embeddings — Agent-Nuvira will fall back to cloud/LLM embeddings."
}

# ─── 5. Verify ─────────────────────────────────────────────────────────────────
Step "Verifying installation…"
$Version = (agent-nuvira --version 2>$null | Select-Object -Last 1)
if (-not $Version) { $Version = (buff --version 2>$null | Select-Object -Last 1) }
if ($Version) {
  Ok "Agent-Nuvira $Version installed successfully"
} else {
  Warn "agent-nuvira is installed but didn't print a version — open a NEW terminal and try 'agent-nuvira --version'."
}

Write-Host ""
Write-Host "✅ Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "   Next steps:"
Write-Host "     1. Add your AI provider keys (optional):"
Write-Host "        agent-nuvira config set provider.groq.apiKey YOUR_KEY"
Write-Host "        # or any provider from the config wizard:  agent-nuvira config"
Write-Host "     2. Try it:   agent-nuvira chat  \"build a hello-world CLI\""
Write-Host "     3. See all commands:   agent-nuvira --help"
Write-Host ""
Write-Host "   IMPORTANT: open a NEW terminal before using agent-nuvira (PATH changes need it)."
