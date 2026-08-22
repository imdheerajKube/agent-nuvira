---
name: cron-job
description: Set up scheduled tasks and cron jobs. Use when the goal asks to automate recurring tasks, schedule jobs, or set up crons.
version: 1.0.0
---

# cron-job

Set up scheduled tasks and cron jobs. Use when the goal asks to automate recurring tasks, schedule jobs, or set up crons.

## Goal pattern

cron schedule job recurring task automated periodic timer

## Parameters

- scheduler (choice [default: cron]): Scheduling tool

## Steps

1. [analyst] Define task schedule (cron expression, interval). Identify task dependencies and retry logic.

2. [analyst] Implement task with idempotency, timeout handling, and distributed locking. (after: step-0)

3. [analyst] Add logging, metrics, and alerting for job failures. (after: step-1)

4. [analyst] Set up monitoring dashboard showing job history, success rate, and duration. (after: step-2)
