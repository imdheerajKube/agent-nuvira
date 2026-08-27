# Prometheus Reference Guide

## Overview
Set up Prometheus monitoring and alerting. Use when the goal asks to add metrics collection, dashboards, or alerting rules.

## # prometheus

Set up Prometheus monitoring and alerting. Use when the goal asks to add metrics collection, dashboards, or alerting rules.

## Goal pattern

prometheus monitoring metrics alert grafana dashboard promql

## Parameters

- alertChannel (choice [default: slack]): Alert notification channel

## Steps

1. [analyst] Define key metrics: request rate, error rate, latency percentiles, resource utilization.

2. [analyst] Instrument application with Prometheus client library (counters, histograms, gauges). (after: step-0)

3. [analyst] Configure Prometheus scrape targets, retention, and storage. (after: step-1)

4. [analyst] Create Grafana dashboards and alerting rules ( PagerDuty, Slack, email). (after: step-2)

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
