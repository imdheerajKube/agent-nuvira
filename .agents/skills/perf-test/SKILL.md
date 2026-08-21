---
name: perf-test
description: Load test and benchmark web applications or APIs: measure throughput, latency percentiles (p50/p95/p99), and error rates under concurrent load. Use when the goal asks to load test, stress test, or benchmark performance.
version: 1.0.0
---

# perf-test

Load test and benchmark web applications or APIs: measure throughput, latency percentiles (p50/p95/p99), and error rates under concurrent load. Use when the goal asks to load test, stress test, or benchmark performance.

## Goal pattern

load test stress test benchmark performance throughput latency concurrent users k6 wrk ab artillery

## Parameters

- tool (choice [default: auto]): Load-testing tool

## Steps

1. [analyst] Define test scenarios: identify critical endpoints, expected concurrent users, test duration, and pass/fail thresholds (e.g. p95 < 200ms, error rate < 1%).

2. [analyst] Set up the load-testing tool (k6, Artillery, autocannon, wrk). Write the test script with configurable VUs, ramp-up, and think-time. (after: step-1)

3. [analyst] Run the baseline test (warm-up + measurement). Capture metrics: requests/sec, latency distribution, error counts, and resource usage. (after: step-2)

4. [analyst] Analyze results: identify bottlenecks (slow queries, connection pool exhaustion, memory leaks). Compare against thresholds. (after: step-3)

5. [analyst] Write a report with charts (latency over time, throughput vs VUs), bottleneck analysis, and optimization recommendations. Save the test script for CI regression. (after: step-4)
