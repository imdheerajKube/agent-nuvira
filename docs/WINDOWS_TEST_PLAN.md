# Agent-Nuvira Windows Test Plan

## Overview

This document contains test scripts to verify agent-nuvira works correctly on Windows.
Run these commands on the remote Windows machine via PowerShell.

## Prerequisites

1. Node.js 18+ installed on Windows
2. OpenSSH Server running (for remote execution)
3. agent-nuvira cloned or installed

## Test Script

Run the following in PowerShell on the Windows machine:

```powershell
# ═══════════════════════════════════════════════════════════════
# Agent-Nuvira Windows Test Suite
# Run this script in PowerShell on the Windows machine
# ═══════════════════════════════════════════════════════════════

Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Agent-Nuvira Windows Test Suite" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan

$pass = 0
$fail = 0

function Test-Step {
    param([string]$Name, [scriptblock]$Test)
    Write-Host "`n▶ $Name" -ForegroundColor Yellow
    try {
        $result = & $Test
        if ($result) {
            Write-Host "  ✅ PASS" -ForegroundColor Green
            $script:pass++
        } else {
            Write-Host "  ❌ FAIL" -ForegroundColor Red
            $script:fail++
        }
    } catch {
        Write-Host "  ❌ FAIL: $_" -ForegroundColor Red
        $script:fail++
    }
}

# ── Test 1: Node.js Available ─────────────────────────────────
Test-Step "Node.js available" {
    $node = node --version 2>&1
    Write-Host "    Version: $node"
    $node -match "v\d+\.\d+"
}

# ── Test 2: npm Available ─────────────────────────────────────
Test-Step "npm available" {
    $npm = npm --version 2>&1
    Write-Host "    Version: $npm"
    $npm -match "\d+\.\d+"
}

# ── Test 3: Clone/Install agent-nuvira ────────────────────────
Test-Step "agent-nuvira available" {
    $cwd = Get-Location
    $nuviraPath = Join-Path $cwd "agent-nuvira"
    if (Test-Path $nuviraPath) {
        Write-Host "    Found at: $nuviraPath"
        $true
    } else {
        Write-Host "    Cloning agent-nuvira..."
        git clone https://github.com/your-repo/agent-nuvira.git $nuviraPath 2>&1
        Test-Path $nuviraPath
    }
}

# ── Test 4: Install Dependencies ──────────────────────────────
Test-Step "npm install succeeds" {
    Push-Location (Join-Path (Get-Location) "agent-nuvira")
    npm install 2>&1 | Out-Null
    $result = $LASTEXITCODE -eq 0
    Pop-Location
    $result
}

# ── Test 5: Build ─────────────────────────────────────────────
Test-Step "npm run build succeeds" {
    Push-Location (Join-Path (Get-Location) "agent-nuvira")
    npm run build 2>&1 | Out-Null
    $result = $LASTEXITCODE -eq 0
    Pop-Location
    $result
}

# ── Test 6: Windows Path Handling ─────────────────────────────
Test-Step "Windows paths work (C:\Users, D:\projects)" {
    $testPaths = @("C:\Users", "C:\Windows", "C:\")
    $allExist = $true
    foreach ($p in $testPaths) {
        if (-not (Test-Path $p)) {
            Write-Host "    Missing: $p"
            $allExist = $false
        }
    }
    $allExist
}

# ── Test 7: PowerShell Available ──────────────────────────────
Test-Step "PowerShell available" {
    $ps = $PSVersionTable.PSVersion
    Write-Host "    Version: $ps"
    $ps.Major -ge 5
}

# ── Test 8: CMD Available ─────────────────────────────────────
Test-Step "cmd.exe available" {
    $cmd = Get-Command cmd.exe -ErrorAction SilentlyContinue
    $null -ne $cmd
}

# ── Test 9: Git Available ─────────────────────────────────────
Test-Step "Git available" {
    $git = git --version 2>&1
    Write-Host "    $git"
    $git -match "git version"
}

# ── Test 10: SSH Available ────────────────────────────────────
Test-Step "OpenSSH Server running" {
    $service = Get-Service sshd -ErrorAction SilentlyContinue
    if ($service) {
        Write-Host "    Status: $($service.Status)"
        $service.Status -eq "Running"
    } else {
        Write-Host "    sshd service not found"
        $false
    }
}

# ── Test 11: Create Test Directory ────────────────────────────
Test-Step "Can create test directory" {
    $testDir = Join-Path $env:TEMP "nuvira-test-$(Get-Random)"
    New-Item -ItemType Directory -Path $testDir -Force | Out-Null
    $exists = Test-Path $testDir
    Remove-Item $testDir -Recurse -Force -ErrorAction SilentlyContinue
    $exists
}

# ── Test 12: Create Test File ─────────────────────────────────
Test-Step "Can create and read test file" {
    $testFile = Join-Path $env:TEMP "nuvira-test-$(Get-Random).txt"
    "Hello from Windows" | Out-File $testFile
    $content = Get-Content $testFile -Raw
    Remove-Item $testFile -Force -ErrorAction SilentlyContinue
    $content.Trim() -eq "Hello from Windows"
}

# ── Test 13: Run Tests ────────────────────────────────────────
Test-Step "npm test passes" {
    Push-Location (Join-Path (Get-Location) "agent-nuvira")
    $output = npm test 2>&1
    $result = $LASTEXITCODE -eq 0
    if (-not $result) {
        Write-Host "    Test output (last 20 lines):"
        $output | Select-Object -Last 20 | ForEach-Object { Write-Host "    $_" }
    }
    Pop-Location
    $result
}

# ── Summary ───────────────────────────────────────────────────
Write-Host "`n═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Results: $pass passed, $fail failed" -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Red" })
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan

if ($fail -gt 0) {
    Write-Host "`n  ⚠️  Some tests failed. Check the output above." -ForegroundColor Yellow
} else {
    Write-Host "`n  ✅  All tests passed!" -ForegroundColor Green
}
```

## What This Tests

| # | Test | Why It Matters |
|---|------|----------------|
| 1 | Node.js | Runtime dependency |
| 2 | npm | Package manager |
| 3 | agent-nuvira available | Source code present |
| 4 | npm install | Dependencies install on Windows |
| 5 | npm run build | TypeScript compiles on Windows |
| 6 | Windows paths | Path handling (C:\, D:\, etc.) |
| 7 | PowerShell | Shell availability |
| 8 | cmd.exe | Alternative shell |
| 9 | Git | Version control |
| 10 | OpenSSH | Remote access |
| 11 | Directory creation | File system operations |
| 12 | File I/O | Read/write operations |
| 13 | Tests pass | Full test suite |

## Expected Issues on Windows

1. **Path separators**: `\` vs `/` — agent-nuvira uses `node:path` which handles both
2. **Shell commands**: `ls`, `cat`, `grep` don't exist — use `Get-ChildItem`, `Get-Content`, `Select-String`
3. **Line endings**: CRLF vs LF — `.gitattributes` should handle this
4. **Permissions**: No chmod — use `icacls` or ACLs instead
5. **Docker**: May not be available on Windows — tests should skip gracefully

## Running Tests Remotely

If you have SSH access to the Windows machine:

```bash
# Copy test script to Windows
scp windows-test.ps1 user@windows-ip:C:\Users\user\

# Run via SSH
ssh user@windows-ip "powershell -ExecutionPolicy Bypass -File C:\Users\user\windows-test.ps1"
```

## After Tests Pass

1. Verify `nuvira --version` works
2. Verify `nuvira memory stats` works
3. Verify `nuvira model list` works
4. Verify `nuvira chat "hello"` works (with a configured provider)
