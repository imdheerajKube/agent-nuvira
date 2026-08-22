---
name: log-rotation
description: Set up log rotation and management. Use when the goal asks to configure log rotation, manage log files, or prevent disk filling.
version: 1.0.0
---

# log-rotation

Set up log rotation and management. Use when the goal asks to configure log rotation, manage log files, or prevent disk filling.

## Goal pattern

log rotation compress archive truncate syslog journald

## Parameters

- strategy (choice [default: time]): Rotation strategy

## Steps

1. [analyst] Identify log sources and estimate daily volume. Choose rotation strategy (size, time, count).

2. [analyst] Configure logrotate for system logs, application logs, and access logs. (after: step-0)

3. [analyst] Set up compression, archival, and deletion policies. Configure remote shipping. (after: step-1)

4. [analyst] Monitor disk usage and set up alerts for unusual log volume. (after: step-2)
