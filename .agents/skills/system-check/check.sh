#!/bin/bash
# System Check Skill — Demonstrates shell script execution.
# 
# This script is executed by the skill-executor.ts module when the agent
# calls: skill tool → execute: { skill: "system-check", args: { check: "all" } }
# 
# The executor:
# 1. Detects runtime: shell (from shebang or frontmatter)
# 2. Spawns: bash /tmp/skill-exec/abc123/check.sh
# 3. Captures stdout/stderr/exit code

set -e

# Default values
CHECK_TYPE="all"
THRESHOLD=80

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --check|-c)
      CHECK_TYPE="$2"
      shift 2
      ;;
    --threshold|-t)
      THRESHOLD="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

echo "=== System Health Check ==="
echo "Check type: $CHECK_TYPE"
echo "Threshold: $THRESHOLD%"
echo ""

# Function to check disk space
check_disk() {
  echo "--- Disk Space ---"
  df -h / | awk 'NR==2{printf "Usage: %s/%s (%s)\n", $3, $2, $5}'
  
  # Get usage percentage
  USAGE=$(df / | awk 'NR==2{print $5}' | sed 's/%//')
  
  if [ "$USAGE" -ge "$THRESHOLD" ]; then
    echo "⚠️  WARNING: Disk usage is above ${THRESHOLD}%"
    return 1
  else
    echo "✅ Disk usage is normal"
    return 0
  fi
}

# Function to check memory
check_memory() {
  echo "--- Memory ---"
  if command -v vm_stat &> /dev/null; then
    # macOS
    vm_stat | head -5
  else
    # Linux
    free -h | head -2
  fi
  echo "✅ Memory check complete"
}

# Function to check CPU
check_cpu() {
  echo "--- CPU ---"
  if command -v top &> /dev/null; then
    # macOS
    top -l 1 | head -10 | grep "CPU usage"
  else
    # Linux
    top -bn1 | grep "Cpu(s)" | awk '{print $2}' | xargs -I {} echo "CPU usage: {}%"
  fi
  echo "✅ CPU check complete"
}

# Function to check running processes
check_processes() {
  echo "--- Running Processes ---"
  echo "Top 5 processes by CPU:"
  ps aux --sort=-%cpu | head -6
  echo ""
  echo "Top 5 processes by memory:"
  ps aux --sort=-%mem | head -6
  echo "✅ Process check complete"
}

# Main execution
ERRORS=0

case $CHECK_TYPE in
  disk)
    check_disk || ((ERRORS++))
    ;;
  memory)
    check_memory
    ;;
  cpu)
    check_cpu
    ;;
  processes)
    check_processes
    ;;
  all)
    check_disk || ((ERRORS++))
    echo ""
    check_memory
    echo ""
    check_cpu
    echo ""
    check_processes
    ;;
  *)
    echo "Error: Unknown check type: $CHECK_TYPE"
    echo "Valid types: disk, memory, cpu, processes, all"
    exit 1
    ;;
esac

echo ""
echo "=== Summary ==="
if [ "$ERRORS" -gt 0 ]; then
  echo "⚠️  $ERRORS warning(s) detected"
  exit 1
else
  echo "✅ All checks passed"
  exit 0
fi
