# Container Supervision Reference Guide

## Overview
Monitor and supervise Docker container health: check health status, configure restart policies, set up health checks, auto-restart unhealthy containers, and log container events. Use when the goal is to ensure containers stay running and recover from failures.

## # container-supervision

Monitor and supervise Docker container health: check health status, configure restart policies, set up health checks, auto-restart unhealthy containers, and log container events. Use when the goal is to ensure containers stay running and recover from failures.

## Goal pattern

docker container health supervision monitoring restart policy auto-restart unhealthy healthcheck events logging

## Parameters

- action: Supervision action: check-health | set-restart-policy | auto-restart | monitor-events
- container: Container name (required for most actions)

## Steps

0. [context-gatherer] No description

1. [runner] No description (after: 'step-0')

2. [reviewer] Supervision action: check-health | set-restart-policy | auto-restart | monitor-events (after: 'step-1')

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
