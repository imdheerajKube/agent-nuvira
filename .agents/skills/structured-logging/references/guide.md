# Structured Logging Reference Guide

## Overview
Implement structured logging with JSON output. Use when the goal asks to add logging, log aggregation, or log-based debugging.

## # structured-logging

Implement structured logging with JSON output. Use when the goal asks to add logging, log aggregation, or log-based debugging.

## Goal pattern

logging structured json log aggregation elk loki Winston pino

## Parameters

- library (choice [default: pino]): Logging library

## Steps

1. [analyst] Choose logging library (Winston, Pino, bunyan). Define log levels and structured fields.

2. [analyst] Implement request context logging (request ID, user ID, trace ID) for correlation. (after: step-0)

3. [analyst] Add log transport: stdout for dev, file/ELK/Loki for production. (after: step-1)

4. [analyst] Add log-based alerting and debugging dashboards. (after: step-2)

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
