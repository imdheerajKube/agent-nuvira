# Agent-Nuvira Windows Setup Script
# Run this FIRST in an elevated (Admin) PowerShell prompt
# Usage: .\windows-setup.ps1

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Agent-Nuvira Windows Setup" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Install Node.js via winget
Write-Host "=== Step 1: Installing Node.js ===" -ForegroundColor Magenta
$nodeInstalled = $false
try {
    $nv = node --version 2>$null
    if ($nv) {
        Write-Host "  Node.js already installed: $nv" -ForegroundColor Green
        $nodeInstalled = $true
    }
} catch {}

if (-not $nodeInstalled) {
    Write-Host "  Installing Node.js via winget..." -ForegroundColor Yellow
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    
    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    
    try {
        $nv = node --version 2>$null
        Write-Host "  Node.js installed: $nv" -ForegroundColor Green
    } catch {
        Write-Host "  WARNING: Node.js may need a new PowerShell window to appear in PATH" -ForegroundColor Yellow
        Write-Host "  If node is not found, close and reopen PowerShell, then re-run this script" -ForegroundColor Yellow
    }
}

# Step 2: Verify npm
Write-Host ""
Write-Host "=== Step 2: Verify npm ===" -ForegroundColor Magenta
try {
    $npmv = npm --version 2>$null
    Write-Host "  npm version: $npmv" -ForegroundColor Green
} catch {
    Write-Host "  npm not found. Node.js install may need PATH refresh." -ForegroundColor Yellow
    Write-Host "  Try closing and reopening PowerShell." -ForegroundColor Yellow
    exit 1
}

# Step 3: Install Git if needed
Write-Host ""
Write-Host "=== Step 3: Verify Git ===" -ForegroundColor Magenta
$gitInstalled = $false
try {
    $gv = git --version 2>$null
    if ($gv) {
        Write-Host "  Git installed: $gv" -ForegroundColor Green
        $gitInstalled = $true
    }
} catch {}

if (-not $gitInstalled) {
    Write-Host "  Installing Git via winget..." -ForegroundColor Yellow
    winget install Git.Git --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}

# Step 4: Clone or update agent-nuvira
Write-Host ""
Write-Host "=== Step 4: Setup agent-nuvira ===" -ForegroundColor Magenta
$NuviraPath = "C:\agent-nuvira"

if (Test-Path "$NuviraPath\package.json") {
    Write-Host "  agent-nuvira already exists at $NuviraPath" -ForegroundColor Green
    Write-Host "  Running git pull..." -ForegroundColor Yellow
    Push-Location $NuviraPath
    git pull 2>&1
    Pop-Location
} else {
    Write-Host "  Cloning agent-nuvira to $NuviraPath..." -ForegroundColor Yellow
    
    # Try SSH first, fall back to HTTPS
    try {
        git clone git@github.com:dheeraj010/agent-nuvira.git $NuviraPath 2>&1
    } catch {
        Write-Host "  SSH clone failed, trying HTTPS..." -ForegroundColor Yellow
        git clone https://github.com/dheeraj010/agent-nuvira.git $NuviraPath 2>&1
    }
}

# Step 5: npm install
Write-Host ""
Write-Host "=== Step 5: npm install ===" -ForegroundColor Magenta
Push-Location $NuviraPath
Write-Host "  Running npm install (this may take a minute)..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "  npm install failed!" -ForegroundColor Red
    Pop-Location
    exit 1
}
Write-Host "  npm install complete" -ForegroundColor Green
Pop-Location

# Step 6: Build
Write-Host ""
Write-Host "=== Step 6: Build ===" -ForegroundColor Magenta
Push-Location $NuviraPath
Write-Host "  Running npm run build..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Build failed!" -ForegroundColor Red
    Pop-Location
    exit 1
}
Write-Host "  Build complete" -ForegroundColor Green
Pop-Location

# Step 7: Verify
Write-Host ""
Write-Host "=== Step 7: Verify ===" -ForegroundColor Magenta
Push-Location $NuviraPath
$ver = node dist/index.js --version 2>&1
Write-Host "  agent-nuvira version: $ver" -ForegroundColor Green
Pop-Location

# Done
Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  Setup Complete!" -ForegroundColor Green
Write-Host "  agent-nuvira installed at: $NuviraPath" -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Cyan
Write-Host "    1. Run tests:  .\windows-test.ps1 -NuviraPath C:\agent-nuvira -Verbose" -ForegroundColor White
Write-Host "    2. Or skip tests: .\windows-test.ps1 -SkipTests" -ForegroundColor White
Write-Host "==========================================================" -ForegroundColor Green
Write-Host ""
