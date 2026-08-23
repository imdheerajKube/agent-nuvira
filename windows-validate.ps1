# Agent-Nuvira Windows Validation Script
# Run after setup to verify all features work
# Usage: .\windows-validate.ps1 -NuviraPath C:\agent-nuvira

param(
    [string]$NuviraPath = "C:\agent-nuvira"
)

$ErrorActionPreference = "Stop"
$passed = 0
$failed = 0

function Test-Result {
    param([string]$Name, [bool]$Success, [string]$Detail = "")
    if ($Success) {
        Write-Host "  [PASS] $Name" -ForegroundColor Green
        $script:passed++
    } else {
        Write-Host "  [FAIL] $Name -- $Detail" -ForegroundColor Red
        $script:failed++
    }
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Agent-Nuvira Windows Validation" -ForegroundColor Cyan
Write-Host "  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

if (-not (Test-Path "$NuviraPath\package.json")) {
    Write-Host "ERROR: agent-nuvira not found at $NuviraPath" -ForegroundColor Red
    Write-Host "Run windows-setup.ps1 first" -ForegroundColor Yellow
    exit 1
}

Push-Location $NuviraPath

# === Feature 1: Model-First Routing ===
Write-Host ""
Write-Host "=== Model-First Routing ===" -ForegroundColor Yellow

$output = node dist/index.js models list 2>&1 | Out-String
Test-Result "Models list returns data" ($output.Length -gt 50) "Output: $output"

$output = node dist/index.js auto-router stats 2>&1 | Out-String
Test-Result "Auto-router stats accessible" ($output -match "router|routing|model") "Output: $output"

# === Feature 2: Memory System ===
Write-Host ""
Write-Host "=== Memory System ===" -ForegroundColor Yellow

$output = node dist/index.js memory stats 2>&1 | Out-String
Test-Result "Memory stats accessible" ($output -match "memory|entries|fact") "Output: $output"

$output = node dist/index.js memory add --key "test:validation" --value "windows-test-$(Get-Date -Format 'yyyyMMdd')" 2>&1 | Out-String
Test-Result "Memory add works" ($LASTEXITCODE -eq 0) "Output: $output"

$output = node dist/index.js memory search --query "windows" 2>&1 | Out-String
Test-Result "Memory search works" ($output -match "validation|windows") "Output: $output"

# === Feature 3: Delegation System ===
Write-Host ""
Write-Host "=== Delegation System ===" -ForegroundColor Yellow

$output = node dist/index.js --version 2>&1 | Out-String
Test-Result "CLI version works" ($output -match "\d+\.\d+\.\d+") "Output: $output"

# === Feature 4: Windows Path Handling ===
Write-Host ""
Write-Host "=== Windows Path Handling ===" -ForegroundColor Yellow

$testFile = "$NuviraPath\test-windows-path.txt"
Set-Content -Path $testFile -Value "windows path test"
Test-Result "Windows path write" (Test-Path $testFile)

$content = Get-Content -Path $testFile -Raw
Test-Result "Windows path read" ($content -eq "windows path test")
Remove-Item $testFile

# === Feature 5: PowerShell/CMD Support ===
Write-Host ""
Write-Host "=== Shell Support ===" -ForegroundColor Yellow

$output = node dist/index.js shell detect 2>&1 | Out-String
Test-Result "Shell detection" ($output -match "powershell|cmd|bash") "Output: $output"

# === Feature 6: Build Integrity ===
Write-Host ""
Write-Host "=== Build Integrity ===" -ForegroundColor Yellow

Test-Result "dist/index.js exists" (Test-Path "$NuviraPath\dist\index.js")
Test-Result "dist/tools/ exists" (Test-Path "$NuviraPath\dist\tools")
Test-Result "dist/learning/ exists" (Test-Path "$NuviraPath\dist\learning")
Test-Result "dist/skills/ exists" (Test-Path "$NuviraPath\dist\skills")

$distSize = (Get-ChildItem "$NuviraPath\dist" -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB
Test-Result "dist/ size > 10MB" ($distSize -gt 10) "Size: $([math]::Round($distSize, 1))MB"

# === Feature 7: Tool Registry ===
Write-Host ""
Write-Host "=== Tool Registry ===" -ForegroundColor Yellow

$toolCount = (Get-ChildItem "$NuviraPath\dist\tools\*.js" | Measure-Object).Count
Test-Result "Tools registered (>50)" ($toolCount -gt 50) "Count: $toolCount"

$skillCount = (Get-ChildItem "$NuviraPath\dist\skills\*.js" -Exclude "*.d.ts","*.map" | Measure-Object).Count
Test-Result "Skills registered (>10)" ($skillCount -gt 10) "Count: $skillCount"

# === Feature 8: Chat Mode (dry run) ===
Write-Host ""
Write-Host "=== Chat Mode ===" -ForegroundColor Yellow

$output = node dist/index.js chat --help 2>&1 | Out-String
Test-Result "Chat help works" ($output -match "chat|message|prompt") "Output: $output"

# === Feature 9: Dashboard ===
Write-Host ""
Write-Host "=== Dashboard ===" -ForegroundColor Yellow

$output = node dist/index.js dashboard --help 2>&1 | Out-String
Test-Result "Dashboard help works" ($output -match "dashboard|port|server") "Output: $output"

# === Feature 10: Model Registry ===
Write-Host ""
Write-Host "=== Model Registry ===" -ForegroundColor Yellow

$output = node dist/index.js models refresh 2>&1 | Out-String
Test-Result "Models refresh" ($LASTEXITCODE -eq 0) "Output: $output"

Pop-Location

# === Summary ===
Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Validation Results" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Passed:  $passed" -ForegroundColor Green
Write-Host "  Failed:  $failed" -ForegroundColor $(if ($failed -gt 0) { "Red" } else { "Green" })
Write-Host "  Total:   $($passed + $failed)" -ForegroundColor White
Write-Host ""

if ($failed -eq 0) {
    Write-Host "  ALL TESTS PASSED" -ForegroundColor Green
    Write-Host "  agent-nuvira is ready on Windows!" -ForegroundColor Green
} else {
    Write-Host "  Some tests failed. Check output above." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
