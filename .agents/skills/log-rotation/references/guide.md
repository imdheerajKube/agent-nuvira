# Log Rotation Reference Guide

## Overview
Set up log rotation and management. Use when the goal asks to configure log rotation, manage log files, or prevent disk filling.

## # log-rotation

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
