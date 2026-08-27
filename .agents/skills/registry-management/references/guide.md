# Registry Management Reference Guide

## Overview
Manage the Windows Registry: reading, writing, exporting, importing, and backup of registry keys. Covers reg.exe, PowerShell registry cmdlets, and .reg files. Use when configuring Windows settings via the registry.

## # registry-management

Manage the Windows Registry: reading, writing, exporting, importing, and backup of registry keys. Covers reg.exe, PowerShell registry cmdlets, and .reg files. Use when configuring Windows settings via the registry.

## Goal pattern

windows registry management reg.exe powershell backup export import configure settings

## Steps

0. [context-gatherer] Map the registry task: what keys need modification? What values? Backup needed? Import/export format?

1. [planner] Design the registry operation:
1. Read: Get-ItemProperty, reg query
2. Write: Set-ItemProperty, reg add
3. Backup: reg export, backup .reg files
4. Import: reg import, .reg file merge
5. Permissions: RunAs administrator when needed
6. Safety: always backup before modifying (after: 'step-0')

2. [runner] Execute registry operations:
1. Backup target registry keys
2. Verify backup file
3. Apply registry changes
4. Verify changes took effect
5. Restart affected services if needed
6. Document all changes (after: 'step-1')

3. [reviewer] Verify: backup exists, registry changes applied, system behaves as expected, rollback works. (after: 'step-2')

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
