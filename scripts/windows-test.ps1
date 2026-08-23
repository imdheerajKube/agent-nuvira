# ═══════════════════════════════════════════════════════════════
# Agent-Nuvira Windows Test Execution Script
# Run this on the remote Windows machine via PowerShell
# ═══════════════════════════════════════════════════════════════

param(
    [string]$NuviraPath = "C:\agent-nuvira",
    [switch]$SkipTests,
    [switch]$Verbose
)

$ErrorActionPreference = "Continue"
$pass = 0
$fail = 0
$skip = 0

function Write-Status {
    param([string]$Message, [string]$Status)
    switch ($Status) {
        "PASS" { Write-Host "  ✅ $Message" -ForegroundColor Green }
        "FAIL" { Write-Host "  ❌ $Message" -ForegroundColor Red }
        "SKIP" { Write-Host "  ⏭️  $Message" -ForegroundColor Yellow }
        "INFO" { Write-Host "  ℹ️  $Message" -ForegroundColor Cyan }
    }
}

function Test-Command {
    param([string]$Name, [scriptblock]$Test, [switch]$Critical)
    Write-Host "`n▶ $Name" -ForegroundColor Yellow
    try {
        $result = & $Test
        if ($result) {
            Write-Status "$Name" "PASS"
            $script:pass++
        } else {
            Write-Status "$Name" "FAIL"
            $script:fail++
        }
    } catch {
        Write-Status "$Name — $_" "FAIL"
        $script:fail++
    }
}

# ═══════════════════════════════════════════════════════════════
# Header
# ═══════════════════════════════════════════════════════════════
Write-Host "`n═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Agent-Nuvira Windows Test Suite" -ForegroundColor Cyan
Write-Host "  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Gray
Write-Host "═══════════════════════════════════════════════════════════`n" -ForegroundColor Cyan

# ═══════════════════════════════════════════════════════════════
# Phase 1: Environment Checks
# ═══════════════════════════════════════════════════════════════
Write-Host "═══ Phase 1: Environment Checks ═══" -ForegroundColor Magenta

Test-Command "Node.js available" {
    $v = node --version 2>&1
    Write-Host "    Version: $v"
    $v -match "v\d+\.\d+"
}

Test-Command "npm available" {
    $v = npm --version 2>&1
    Write-Host "    Version: $v"
    $v -match "\d+\.\d+"
}

Test-Command "Git available" {
    $v = git --version 2>&1
    Write-Host "    $v"
    $v -match "git version"
}

Test-Command "PowerShell version" {
    $v = $PSVersionTable.PSVersion
    Write-Host "    Version: $v"
    $v.Major -ge 5
}

Test-Command "OpenSSH Server running" {
    $svc = Get-Service sshd -ErrorAction SilentlyContinue
    if ($svc) {
        Write-Host "    Status: $($svc.Status)"
        $svc.Status -eq "Running"
    } else {
        Write-Host "    sshd service not found"
        $false
    }
}

# ═══════════════════════════════════════════════════════════════
# Phase 2: File System Checks
# ═══════════════════════════════════════════════════════════════
Write-Host "`n═══ Phase 2: File System Checks ═══" -ForegroundColor Magenta

Test-Command "Windows paths accessible" {
    $paths = @("C:\Users", "C:\Windows", "C:\")
    $all = $true
    foreach ($p in $paths) {
        if (-not (Test-Path $p)) {
            Write-Host "    Missing: $p"
            $all = $false
        }
    }
    $all
}

Test-Command "Can create temp directory" {
    $dir = Join-Path $env:TEMP "nuvira-test-$(Get-Random)"
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $exists = Test-Path $dir
    Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
    $exists
}

Test-Command "Can create and read temp file" {
    $file = Join-Path $env:TEMP "nuvira-test-$(Get-Random).txt"
    "Hello from Windows" | Out-File $file
    $content = Get-Content $file -Raw
    Remove-Item $file -Force -ErrorAction SilentlyContinue
    $content.Trim() -eq "Hello from Windows"
}

# ═══════════════════════════════════════════════════════════════
# Phase 3: agent-nuvira Setup
# ═══════════════════════════════════════════════════════════════
Write-Host "`n═══ Phase 3: agent-nuvira Setup ═══" -ForegroundColor Magenta

Test-Command "agent-nuvira directory exists" {
    if (Test-Path $NuviraPath) {
        Write-Host "    Found at: $NuviraPath"
        $true
    } else {
        Write-Host "    Not found at: $NuviraPath"
        Write-Host "    Cloning..."
        git clone https://github.com/your-repo/agent-nuvira.git $NuviraPath 2>&1
        Test-Path $NuviraPath
    }
}

Test-Command "npm install succeeds" {
    Push-Location $NuviraPath
    $output = npm install 2>&1
    $result = $LASTEXITCODE -eq 0
    if (-not $result -and $Verbose) {
        $output | Select-Object -Last 10 | ForEach-Object { Write-Host "    $_" }
    }
    Pop-Location
    $result
}

Test-Command "npm run build succeeds" {
    Push-Location $NuviraPath
    $output = npm run build 2>&1
    $result = $LASTEXITCODE -eq 0
    if (-not $result -and $Verbose) {
        $output | Select-Object -Last 10 | ForEach-Object { Write-Host "    $_" }
    }
    Pop-Location
    $result
}

# ═══════════════════════════════════════════════════════════════
# Phase 4: agent-nuvira Commands
# ═══════════════════════════════════════════════════════════════
Write-Host "`n═══ Phase 4: agent-nuvira Commands ═══" -ForegroundColor Magenta

Test-Command "nuvira --version works" {
    Push-Location $NuviraPath
    $output = node dist/index.js --version 2>&1
    Pop-Location
    $output -match "\d+\.\d+"
}

Test-Command "nuvira memory stats works" {
    Push-Location $NuviraPath
    $output = node dist/index.js memory stats 2>&1
    Pop-Location
    $output -match "Memory|memory|stats"
}

Test-Command "nuvira model list works" {
    Push-Location $NuviraPath
    $output = node dist/index.js model list 2>&1
    Pop-Location
    $LASTEXITCODE -eq 0
}

# ═══════════════════════════════════════════════════════════════
# Phase 5: Test Suite (optional)
# ═══════════════════════════════════════════════════════════════
if (-not $SkipTests) {
    Write-Host "`n═══ Phase 5: Test Suite ═══" -ForegroundColor Magenta

    Test-Command "npm test passes" {
        Push-Location $NuviraPath
        $output = npm test 2>&1
        $result = $LASTEXITCODE -eq 0
        if (-not $result -and $Verbose) {
            Write-Host "    Test output (last 20 lines):"
            $output | Select-Object -Last 20 | ForEach-Object { Write-Host "    $_" }
        }
        Pop-Location
        $result
    }
}

# ═══════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════
Write-Host "`n═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Test Results" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Passed:  $pass" -ForegroundColor Green
Write-Host "  Failed:  $fail" -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Red" })
Write-Host "  Skipped: $skip" -ForegroundColor Yellow
Write-Host ""

if ($fail -eq 0) {
    Write-Host "  ✅ All tests passed!" -ForegroundColor Green
} else {
    Write-Host "  ⚠️  Some tests failed. Check output above." -ForegroundColor Yellow
}

Write-Host "`n═══════════════════════════════════════════════════════════`n" -ForegroundColor Cyan
