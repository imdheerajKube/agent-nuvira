# Infra Monitoring Reference Guide

## Overview
Infrastructure monitoring setup: Prometheus, Grafana, alerting rules, dashboards, and SLI/SLO tracking. Use when setting up observability for production systems.

## # infra-monitoring

Infrastructure monitoring setup: Prometheus, Grafana, alerting rules, dashboards, and SLI/SLO tracking. Use when setting up observability for production systems.

## Goal pattern

infrastructure monitoring prometheus grafana alerting dashboard SLI SLO observability

## Steps

0. [context-gatherer] Map the infrastructure: what services need monitoring? What metrics are critical? What alert channels exist? What dashboards are needed?

1. [planner] Design the monitoring stack:
1. Metrics: Prometheus for collection, custom exporters
2. Dashboards: Grafana for visualization
3. Alerting: Alertmanager with routing rules
4. SLIs: availability, latency, error rate, throughput
5. SLOs: target thresholds for each SLI
6. On-call: PagerDuty/OpsGenie integration (after: 'step-0')

2. [runner] Implement monitoring:
1. Deploy Prometheus with scrape configs
2. Create Grafana dashboards
3. Configure alerting rules
4. Set up SLI/SLO tracking
5. Test alerts with simulated failures
6. Document runbooks (after: 'step-1')

3. [reviewer] Verify: metrics are collected, dashboards show data, alerts fire on thresholds, SLOs are tracked. (after: 'step-2')

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
