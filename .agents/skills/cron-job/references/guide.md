# Cron Job Reference Guide

## Overview
Set up scheduled tasks and cron jobs. Use when the goal asks to automate recurring tasks, schedule jobs, or set up crons.

## # cron-job

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
