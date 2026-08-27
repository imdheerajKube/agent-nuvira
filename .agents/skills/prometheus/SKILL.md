---
name: prometheus
description: Set up Prometheus monitoring and alerting. Use when the goal asks to add metrics collection, dashboards, or alerting rules.
version: 2.0.0
whenToUse: Metrics collection, alerting rules, Grafana dashboards, SLI/SLO tracking, capacity monitoring
whenNotToUse: Log aggregation (use Loki/ELK), distributed tracing (use Jaeger), error tracking (use Sentry)
---

# Prometheus Monitoring

Set up Prometheus monitoring and alerting with production patterns.

## Goal pattern

prometheus monitoring metrics alert grafana dashboard promql

## Parameters

- alertChannel (choice [default: slack]): Alert notification channel
- retention (choice [default: 30d]): Data retention period
- haMode (boolean [default: false]): High availability with Thanos

## Steps

### Step 1: [analyst] — Define monitoring requirements

```bash
# Check if Prometheus is already running
curl -s http://localhost:9090/api/v1/status/config 2>/dev/null | head -5

# Check available exporters
ls /etc/prometheus/exporters/ 2>/dev/null

# Check Grafana
curl -s http://localhost:3000/api/health 2>/dev/null
```

- What services need monitoring? (APIs, databases, workers)
- What metrics are critical? (request rate, error rate, latency)
- What alert channels? (Slack, PagerDuty, email)
- What dashboards needed? (overview, service-specific, infrastructure)

### Step 2: [analyst] — Configure Prometheus and alerting

**Prometheus config:**
```yaml
# prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  scrape_timeout: 10s

rule_files:
  - /etc/prometheus/alerts/*.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']

scrape_configs:
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  - job_name: 'node-exporter'
    static_configs:
      - targets: ['node-exporter:9100']

  - job_name: 'app-metrics'
    metrics_path: /metrics
    static_configs:
      - targets: ['app:8080']
    relabel_configs:
      - source_labels: [__address__]
        target_label: instance

  - job_name: 'postgres-exporter'
    static_configs:
      - targets: ['postgres-exporter:9187']
```

**Alerting rules:**
```yaml
# /etc/prometheus/alerts/app-alerts.yml
groups:
  - name: application
    rules:
      - alert: HighErrorRate
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m]))
          / sum(rate(http_requests_total[5m])) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High error rate (>5%)"
          description: "Error rate is {{ $value | humanizePercentage }}"

      - alert: HighLatency
        expr: |
          histogram_quantile(0.99, 
            sum(rate(http_request_duration_seconds_bucket[5m])) by (le)
          ) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High p99 latency (>1s)"

      - alert: HighMemoryUsage
        expr: |
          (node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes)
          / node_memory_MemTotal_bytes > 0.85
        for: 10m
        labels:
          severity: warning

      - alert: DiskSpaceLow
        expr: |
          (node_filesystem_avail_bytes / node_filesystem_size_bytes) < 0.15
        for: 5m
        labels:
          severity: critical

  - name: slo
    rules:
      - record: slo:error_ratio:rate5m
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m]))
          / sum(rate(http_requests_total[5m]))
      
      - alert: SLOBudgetBurn
        expr: |
          slo:error_ratio:rate5m > (14.4 * 0.001)
        for: 1h
        labels:
          severity: critical
        annotations:
          summary: "SLO budget burning too fast"
```

**Alertmanager config:**
```yaml
# alertmanager.yml
global:
  resolve_timeout: 5m

route:
  group_by: ['alertname', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  receiver: 'slack-notifications'
  routes:
    - match:
        severity: critical
      receiver: 'pagerduty-critical'

receivers:
  - name: 'slack-notifications'
    slack_configs:
      - api_url: '{{ .SLACK_WEBHOOK_URL }}'
        channel: '#alerts'
        title: '{{ .GroupLabels.alertname }}'
        text: '{{ .CommonAnnotations.summary }}'

  - name: 'pagerduty-critical'
    pagerduty_configs:
      - service_key: '{{ .PAGERDUTY_KEY }}'

inhibit_rules:
  - source_match:
      severity: 'critical'
    target_match:
      severity: 'warning'
    equal: ['alertname', 'instance']
```

### Step 3: [analyst] — Deploy monitoring stack

```bash
# Deploy with Docker Compose
docker-compose up -d prometheus alertmanager grafana

# Verify Prometheus is scraping
curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, health: .health}'

# Test alerting rules
curl -s http://localhost:9090/api/v1/rules | jq '.data.groups[].rules[] | {name: .name, state: .state}'

# Create Grafana dashboards
curl -X POST http://localhost:3000/api/dashboards/db \
  -H "Content-Type: application/json" \
  -d @grafana-dashboard.json
```

### Step 4: [analyst] — Verify monitoring works

```bash
# Verify metrics are being collected
curl -s 'http://localhost:9090/api/v1/query?query=up' | jq '.data.result'

# Verify alerts are configured
curl -s http://localhost:9090/api/v1/rules | jq '.data.groups | length'

# Test alert fires (simulate high error rate)
curl -X POST http://localhost:9090/api/v1/admin/tsdb/delete_series \
  -d 'match[]={__name__="http_requests_total"}'

# Check Grafana dashboards
curl -s http://localhost:3000/api/search | jq '.[].title'
```

**Verification checklist:**
- [ ] Prometheus scraping all targets (all targets healthy)
- [ ] Alerting rules loaded (no errors in /api/v1/rules)
- [ ] Alertmanager receives alerts
- [ ] Grafana dashboards show data
- [ ] SLI/SLO metrics calculated
- [ ] Alerts fire on threshold breach
- [ ] Alerts resolve when condition clears
- [ ] No alert storms (grouping works)

## Reference Documents

Load deep-dive content with `skill_view('prometheus', 'references/guide.md')`.
