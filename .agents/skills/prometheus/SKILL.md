---
name: prometheus
description: Set up Prometheus monitoring and alerting. Use when the goal asks to add metrics collection, dashboards, or alerting rules.
version: 1.0.0
---

# prometheus

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
