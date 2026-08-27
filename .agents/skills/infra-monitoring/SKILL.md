---
name: infra-monitoring
description: Infrastructure monitoring setup: Prometheus, Grafana, alerting rules, dashboards, and SLI/SLO tracking. Use when setting up observability for production systems.
version: 1.0.0
---

# infra-monitoring

Infrastructure monitoring setup: Prometheus, Grafana, alerting rules, dashboards, and SLI/SLO tracking. Use when setting up observability for production systems.

## Goal pattern

infrastructure monitoring prometheus grafana alerting dashboard SLI SLO observability

## Parameters

(none)

## Steps

1. [context-gatherer] Map the infrastructure: what services need monitoring? What metrics are critical? What alert channels exist? What dashboards are needed?

2. [planner] Design the monitoring stack:
1. Metrics: Prometheus for collection, custom exporters
2. Dashboards: Grafana for visualization
3. Alerting: Alertmanager with routing rules
4. SLIs: availability, latency, error rate, throughput
5. SLOs: target thresholds for each SLI
6. On-call: PagerDuty/OpsGenie integration (after: step-0)

3. [runner] Implement monitoring:
1. Deploy Prometheus with scrape configs
2. Create Grafana dashboards
3. Configure alerting rules
4. Set up SLI/SLO tracking
5. Test alerts with simulated failures
6. Document runbooks (after: step-1)

4. [reviewer] Verify: metrics are collected, dashboards show data, alerts fire on thresholds, SLOs are tracked. (after: step-2)
