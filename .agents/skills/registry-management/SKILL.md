---
name: registry-management
description: Manage the Windows Registry: reading, writing, exporting, importing, and backup of registry keys. Covers reg.exe, PowerShell registry cmdlets, and .reg files. Use when configuring Windows settings via the registry.
version: 1.0.0
---

# registry-management

Manage the Windows Registry: reading, writing, exporting, importing, and backup of registry keys. Covers reg.exe, PowerShell registry cmdlets, and .reg files. Use when configuring Windows settings via the registry.

## Goal pattern

windows registry management reg.exe powershell backup export import configure settings

## Parameters

(none)

## Steps

1. [context-gatherer] Map the registry task: what keys need modification? What values? Backup needed? Import/export format?

2. [planner] Design the registry operation:
1. Read: Get-ItemProperty, reg query
2. Write: Set-ItemProperty, reg add
3. Backup: reg export, backup .reg files
4. Import: reg import, .reg file merge
5. Permissions: RunAs administrator when needed
6. Safety: always backup before modifying (after: step-0)

3. [runner] Execute registry operations:
1. Backup target registry keys
2. Verify backup file
3. Apply registry changes
4. Verify changes took effect
5. Restart affected services if needed
6. Document all changes (after: step-1)

4. [reviewer] Verify: backup exists, registry changes applied, system behaves as expected, rollback works. (after: step-2)
