# Cron Setup Reference Guide

## Overview
Set up scheduled tasks and cron jobs: periodic reports, cleanup jobs, data sync, and monitoring probes. Use when the goal asks to schedule tasks, set up cron jobs, or automate periodic work.

## # cron-setup

Set up scheduled tasks and cron jobs: periodic reports, cleanup jobs, data sync, and monitoring probes. Use when the goal asks to schedule tasks, set up cron jobs, or automate periodic work.

## Goal pattern

cron schedule task periodic timer interval report cleanup sync automation scheduled

## Parameters

- scheduler (choice [default: auto]): Scheduler

## Steps

1. [analyst] Define the schedule: determine frequency (every minute, hourly, daily, weekly), timezone, and whether the job needs to run on a specific server or distributed.

2. [analyst] Choose the scheduler: node-cron, bull/bullmq, system crontab, or cloud scheduler (Cloud Functions, Lambda, GitHub Actions). (after: step-1)

3. [analyst] Implement the job: write the task logic with proper error handling, idempotency (safe to re-run), and logging. Include a heartbeat. (after: step-2)

4. [analyst] Add monitoring: log start/end, duration, and outcome. Set up alerts for missed runs or excessive duration. (after: step-3)

5. [analyst] Test the schedule: run the job manually, verify it handles failures gracefully, and document the job for future maintainers. (after: step-4)

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
