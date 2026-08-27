# Monitoring Setup Reference Guide

## Overview
Set up application monitoring: structured logging, metrics collection, alerting rules, and health checks. Use when the goal asks to add logging, monitoring, observability, or alerting.

## # monitoring-setup

Set up application monitoring: structured logging, metrics collection, alerting rules, and health checks. Use when the goal asks to add logging, monitoring, observability, or alerting.

## Goal pattern

monitoring logging metrics alerting observability health check prometheus grafana datadog structured logs

## Parameters

- stack (choice [default: auto]): Monitoring stack

## Steps

1. [analyst] Choose the monitoring stack: logging (Pino, Winston, structured JSON), metrics (Prometheus, OpenTelemetry), and dashboards (Grafana, Datadog).

2. [analyst] Add structured logging: instrument all key code paths with log levels (debug, info, warn, error). Include request ID, user ID, and duration for every request. (after: step-1)

3. [analyst] Add metrics: instrument HTTP requests (latency, status codes), business metrics (signups, orders), and system metrics (memory, CPU, event loop lag). (after: step-2)

4. [analyst] Create alerting rules: define alerts for error rate spikes, latency degradation, high memory usage, and dependency failures. (after: step-3)

5. [analyst] Build a health-check endpoint: verify DB, cache, and external service connectivity. Add readiness and liveness probes. (after: step-4)

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
