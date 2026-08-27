# Powershell Automation Reference Guide

## Overview
Automate Windows tasks with PowerShell: scripts, modules, DSC (Desired State Configuration), scheduled tasks, and Windows service management. Use when automating Windows system administration.

## # powershell-automation

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

## Best Practices

- Follow the skill's methodology step by step
- Verify each step before proceeding to the next
- Use the appropriate tools for each task
- Document any deviations from the standard approach

## Common Patterns

- Start with context gathering to understand the current state
- Plan the implementation before writing code
- Test changes before committing
- Review for security and performance implications

## Troubleshooting

- If the skill fails, check the prerequisites first
- Verify environment variables are set correctly
- Check for conflicting configurations
- Review logs for detailed error messages

## Further Reading

- Refer to the main SKILL.md for complete methodology
- Check official documentation for the specific technology
- Review related skills in the registry for complementary approaches
