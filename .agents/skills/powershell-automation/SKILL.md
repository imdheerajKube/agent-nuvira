---
name: powershell-automation
description: Automate Windows tasks with PowerShell: scripts, modules, DSC (Desired State Configuration), scheduled tasks, and Windows service management. Use when automating Windows system administration.
version: 1.0.0
---

# powershell-automation

Automate Windows tasks with PowerShell: scripts, modules, DSC (Desired State Configuration), scheduled tasks, and Windows service management. Use when automating Windows system administration.

## Goal pattern

powershell automation script module DSC windows scheduled task service management administration

## Steps

0. [context-gatherer] Map the automation: what Windows task needs automating? What PowerShell version? What modules needed? Scheduling requirements?

1. [planner] Design the PowerShell automation:
1. Script structure: functions, error handling, logging
2. Parameters: mandatory/optional, validation, pipeline input
3. DSC: desired state configuration for server setup
4. Scheduling: Task Scheduler for recurring tasks
5. Services: install/start/stop Windows services
6. Output: structured objects, CSV/JSON export (after: 'step-0')

2. [runner] Implement the automation:
1. Write PowerShell script with proper error handling
2. Add parameter validation
3. Implement logging
4. Create scheduled task if needed
5. Test on Windows
6. Document usage (after: 'step-1')

3. [reviewer] Verify: script runs without errors, handles edge cases, logging works, scheduled task triggers correctly. (after: 'step-2')
