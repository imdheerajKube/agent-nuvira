---
name: container-supervision
description: Monitor and supervise Docker container health: check health status, configure restart policies, set up health checks, auto-restart unhealthy containers, and log container events. Use when the goal is to ensure containers stay running and recover from failures.
version: 2.0.0
---

# container-supervision

Monitor and supervise Docker container health: check health status, configure restart policies, set up health checks, auto-restart unhealthy containers, and log container events. Use when the goal is to ensure containers stay running and recover from failures.

## Goal pattern

docker container health supervision monitoring restart policy auto-restart unhealthy healthcheck events logging

## Parameters

- action (choice (required)): Supervision action: check-health | set-restart-policy | auto-restart | monitor-events
- container (string): Container name (required for most actions)

## Steps

1. [context-gatherer] ## Step 1: Check Container Health Status

Before configuring supervision, check current health status:

```bash
# Check all containers health
docker ps --format "{{.Names}}: {{.Status}}"

# Inspect health check details
docker inspect web --format="{{json .State.Health}}" | jq

# Check restart count
docker inspect web --format="{{.State.RestartCount}}"

# Check restart policy
docker inspect web --format="{{.HostConfig.RestartPolicy.Name}}"
```

Identify containers that need supervision:
- Containers with health checks configured
- Containers with restart policy
- Containers that have restarted multiple times
- Containers with high resource usage

2. [runner] ## Step 2: Configure Container Supervision

### 2.1 Health Check Configuration

```bash
# Add health check to running container
docker update --health-cmd="curl -f http://localhost/ || exit 1" \
  --health-interval=30s \
  --health-timeout=5s \
  --health-retries=3 \
  --health-start-period=10s \
  web

# In Dockerfile:
# HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
#   CMD curl -f http://localhost/ || exit 1
```

### 2.2 Restart Policies

```bash
# Set restart policy
docker update --restart=unless-stopped web

# Policies:
# no          - Never restart (default)
# on-failure  - Restart only on non-zero exit code
# always      - Always restart
# unless-stopped - Always restart unless manually stopped
```

### 2.3 Auto-Restart Unhealthy Containers

```bash
# Check for unhealthy containers and restart them
docker ps --filter "health=unhealthy" --format "{{.Names}}" | \
  xargs -I {} docker restart {}

# Continuous monitoring script
while true; do
  unhealthy=$(docker ps --filter "health=unhealthy" --format "{{.Names}}")
  for c in $unhealthy; do
    echo "$(date): Restarting unhealthy container: $c"
    docker restart "$c"
  done
  sleep 60
done
```

### 2.4 Container Event Logging

```bash
# View container events
docker events --filter container=web

# View events for last hour
docker events --since 1h --filter container=web

# Log to file
docker events --format "{{json .}}" > container-events.jsonl
``` (after: step-0)

3. [reviewer] ## Step 3: Verify Container Supervision

### 3.1 Health Check Verification

```bash
# Verify health check is configured
docker inspect web --format="{{.Config.Healthcheck}}"

# Check current health status
docker inspect web --format="{{.State.Health.Status}}"
# Expected: healthy

# View health check logs
docker inspect web --format="{{range .State.Health.Log}}{{.Output}}{{end}}"
```

### 3.2 Restart Policy Verification

```bash
# Verify restart policy is set
docker inspect web --format="{{.HostConfig.RestartPolicy.Name}}"
# Expected: unless-stopped

# Check restart count
docker inspect web --format="{{.State.RestartCount}}"
# Expected: 0 (or low number)
```

### 3.3 Overall Health

```bash
# List all containers with health status
docker ps --format "{{.Names}}: {{.Status}}"

# Check for any unhealthy containers
docker ps --filter "health=unhealthy"
# Expected: (empty - no unhealthy containers)
``` (after: step-1)
