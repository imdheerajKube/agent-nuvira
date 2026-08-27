# Delegation Live Log Reference Guide

## Overview
Monitor delegated tasks in real-time: live log streaming, progress tracking, and status updates. Use when supervising background tasks or parallel agent operations.

## # delegation-live-log

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
