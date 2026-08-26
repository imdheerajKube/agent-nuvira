---
name: container-supervision
description: Monitor and supervise Docker container health: check health status, configure restart policies, set up health checks, auto-restart unhealthy containers, and log container events. Use when the goal is to ensure containers stay running and recover from failures.
version: 1.0.0
---

# container-supervision

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
