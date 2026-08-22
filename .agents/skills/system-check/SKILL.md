---
name: system-check
description: Check system health, disk space, memory, CPU, and running processes
runtime: shell
tags:
  - system
  - health
  - monitoring
parameters:
  - name: check
    description: What to check (disk, memory, cpu, processes, all)
    required: false
    type: string
    default: all
  - name: threshold
    description: Alert threshold percentage (e.g., 80 for 80%)
    required: false
    type: string
    default: 80
---

# System Check Skill

Check system health, disk space, memory, CPU, and running processes. This skill demonstrates the execution engine's ability to run shell scripts.

## How It Works

1. Receives check type and threshold parameters
2. Executes system commands to gather metrics
3. Compares against thresholds
4. Returns structured health report

## Usage

When the user wants to check system health, execute this skill with the check type.

## Security

- No API keys required (system-level checks only)
- Read-only operations (no modifications to system)
- Timeout protection prevents hanging
