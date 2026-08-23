# Agent-Nuvira Windows Setup Script
# Run this in an elevated (Admin) PowerShell prompt
# Usage: .\windows-setup.ps1

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Agent-Nuvira Windows Setup" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

# Phase 1: Check prerequisites
Write-Host "=== Phase 1: Prerequisites ===" -ForegroundColor Yellow

# Check Node.js
try {
    $nodeVersion = node --version 2>&1
    Write-Host "[PASS] Node.js: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "[FAIL] Node.js not found. Installing via winget..." -ForegroundColor Red
    winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    Write-Host "[INSTALLED] Node.js" -ForegroundColor Green
}

# Check npm
try {
    $npmVersion = npm --version 2>&1
    Write-Host "[PASS] npm: $npmVersion" -ForegroundColor Green
} catch {
    Write-Host "[FAIL] npm not found" -ForegroundColor Red
    exit 1
}

# Check git
try {
    $gitVersion = git --version 2>&1
    Write-Host "[PASS] Git: $gitVersion" -ForegroundColor Green
} catch {
    Write-Host "[FAIL] Git not found. Installing via winget..." -ForegroundColor Red
    winget install Git.Git --accept-source-agreements --accept-package-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    Write-Host "[INSTALLED] Git" -ForegroundColor Green
}

# Phase 2: Clone or update agent-nuvira
Write-Host ""
Write-Host "=== Phase 2: agent-nuvira ===" -ForegroundColor Yellow

$NuviraPath = "C:\agent-nuvira"

if (Test-Path "$NuviraPath\package.json") {
    Write-Host "[EXISTS] agent-nuvira already at $NuviraPath" -ForegroundColor Green
    Write-Host "Pulling latest..." -ForegroundColor Cyan
    Push-Location $NuviraPath
    git pull
    Pop-Location
} else {
    Write-Host "[CLONE] Cloning agent-nuvira..." -ForegroundColor Cyan
    git clone https://github.com/your-org/agent-nuvira.git $NuviraPath
}

Push-Location $NuviraPath

# Phase 3: Install dependencies
Write-Host ""
Write-Host "=== Phase 3: Install Dependencies ===" -ForegroundColor Yellow

Write-Host "[INSTALL] Running npm install..." -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "[FAIL] npm install failed" -ForegroundColor Red
    Pop-Location
    exit 1
}
Write-Host "[PASS] npm install completed" -ForegroundColor Green

# Phase 4: Build
Write-Host ""
Write-Host "=== Phase 4: Build ===" -ForegroundColor Yellow

Write-Host "[BUILD] Running npm run build..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[FAIL] Build failed" -ForegroundColor Red
    Pop-Location
    exit 1
}
Write-Host "[PASS] Build completed" -ForegroundColor Green

# Phase 5: Tests
Write-Host ""
Write-Host "=== Phase 5: Test Suite ===" -ForegroundColor Yellow

Write-Host "[TEST] Running tests..." -ForegroundColor Cyan
npm test 2>&1 | Select-Object -Last 20
if ($LASTEXITCODE -eq 0) {
    Write-Host "[PASS] All tests passed" -ForegroundColor Green
} else {
    Write-Host "[WARN] Some tests failed (check output above)" -ForegroundColor Yellow
}

# Phase 6: Verify CLI
Write-Host ""
Write-Host "=== Phase 6: CLI Verification ===" -ForegroundColor Yellow

Write-Host "[TEST] nuvira --version" -ForegroundColor Cyan
node dist/index.js --version 2>&1

Write-Host "[TEST] nuvira models list" -ForegroundColor Cyan
node dist/index.js models list 2>&1 | Select-Object -First 10

Write-Host "[TEST] nuvira memory stats" -ForegroundColor Cyan
node dist/index.js memory stats 2>&1

Pop-Location

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Setup Complete!" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Usage:" -ForegroundColor Yellow
Write-Host "  cd $NuviraPath" -ForegroundColor White
Write-Host "  nuvira chat              # Start interactive chat" -ForegroundColor White
Write-Host "  nuvira dashboard         # Start web dashboard" -ForegroundColor White
Write-Host "  nuvira models list       # List available models" -ForegroundColor White
Write-Host "  nuvira memory stats      # Memory system stats" -ForegroundColor White
Write-Host ""
Write-Host "Remote SSH access:" -ForegroundColor Yellow
Write-Host "  From Mac: ssh dheeraj@<windows-ip>" -ForegroundColor White
Write-Host ""
