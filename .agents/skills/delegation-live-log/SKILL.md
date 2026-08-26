---
name: delegation-live-log
description: Monitor delegated tasks in real-time: live log streaming, progress tracking, and status updates. Use when supervising background tasks or parallel agent operations.
version: 1.0.0
---

# delegation-live-log

Monitor delegated tasks in real-time: live log streaming, progress tracking, and status updates. Use when supervising background tasks or parallel agent operations.

## Goal pattern

delegation live log real-time monitoring progress tracking status background tasks parallel agents

## Steps

0. [context-gatherer] Map the delegation: what tasks are being delegated? What progress indicators? What log format? What refresh rate?

1. [planner] Design the live log system:
1. Log streaming: real-time log output from delegated tasks
2. Progress tracking: percentage complete, step indicators
3. Status dashboard: task status, elapsed time, errors
4. Filtering: filter by task, log level, timestamp
5. Alerting: notify on errors or completion
6. History: retain logs for debugging (after: 'step-0')

2. [runner] Implement live log monitoring:
1. Set up log streaming from tasks
2. Create progress tracking
3. Build status dashboard
4. Add log filtering
5. Implement alerting
6. Test with sample delegated tasks (after: 'step-1')

3. [reviewer] Verify: logs stream in real-time, progress updates accurately, alerts work on errors, history is retained. (after: 'step-2')
