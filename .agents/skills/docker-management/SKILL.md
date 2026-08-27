---
name: docker-management
description: Manage Docker containers, images, volumes, networks, and Compose stacks. Use when the goal is to run, stop, restart, inspect, or debug Docker containers; build, pull, push, or clean up images; manage Docker Compose services; work with volumes or networks; check disk usage; or debug container issues. Also use for Dockerfile optimization and container health monitoring.
version: 2.0.0
---

# docker-management

Manage Docker containers, images, volumes, networks, and Compose stacks. Use when the goal is to run, stop, restart, inspect, or debug Docker containers; build, pull, push, or clean up images; manage Docker Compose services; work with volumes or networks; check disk usage; or debug container issues. Also use for Dockerfile optimization and container health monitoring.

## Goal pattern

docker container image compose volume network build pull push run stop start restart exec logs inspect stats cleanup prune disk debug dockerfile optimization health

## Parameters

- action (choice (required)): Docker action to perform: run | stop | start | restart | exec | logs | build | pull | compose-up | compose-down | compose-ps | disk-usage | cleanup | health
- target (string (required)): Container name, image name, or compose project directory
- command (string): Command to execute in container (for exec action)

## Steps

1. [context-gatherer] ## Step 1: Verify Docker Installation

Before any Docker operation, verify Docker is installed and running:

```bash
# Check Docker version
docker --version
# Expected: Docker version 24.0.7, build afdd53b

# Check Docker Compose version
docker compose version
# Expected: Docker Compose version v2.21.0

# Check Docker daemon status
docker info --format "{{.ServerVersion}}"
# Expected: 24.0.7

# If Docker is not running, start it:
# macOS: open -a Docker
# Linux: sudo systemctl start docker
```

## Step 2: Identify the Request Domain

Classify what the user wants to do:

| Domain | Commands | Example |
|--------|----------|---------|
| Container lifecycle | run, stop, start, restart, rm | "Start an nginx container" |
| Container interaction | exec, logs, inspect, stats | "Shell into my container" |
| Image management | build, pull, push, tag, rmi | "Build my Docker image" |
| Docker Compose | up, down, ps, logs, exec | "Start my compose services" |
| Volumes & networks | create, inspect, rm, prune | "Create a persistent volume" |
| Troubleshooting | logs, inspect, events, top | "Why is my container crashing?" |
| Disk usage | df, prune, cleanup | "Free up Docker disk space" |

## Step 3: Gather Context

Check existing Docker resources:
```bash
# List running containers
docker ps

# List all containers (including stopped)
docker ps -a

# List images
docker images

# Check disk usage
docker system df
```

2. [runner] ## Step 4: Execute Docker Operations

Based on the domain identified in Step 2, execute the appropriate commands.

### 4.1 Container Lifecycle

```bash
# Run a new container (detached)
docker run -d --name web -p 8080:80 nginx
# Expected: 1a2b3c4d5e6f7g8h9i0j

# Run with environment variables
docker run -d -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=mydb --name db postgres:16

# Run with persistent data (named volume)
docker run -d -v mydata:/var/lib/postgresql/data --name db postgres:16

# Run interactively
docker run -it --rm ubuntu:22.04 /bin/bash

# Stop container
docker stop web
# Expected: web

# Start stopped container
docker start web

# Restart container
docker restart web

# Remove container
docker rm web

# Force remove (even if running)
docker rm -f web
```

### 4.2 Container Interaction

```bash
# Shell into container
docker exec -it web /bin/sh

# View logs (follow)
docker logs --tail 50 -f web

# Inspect container details
docker inspect web

# Resource stats
docker stats --no-stream

# Copy files to/from container
docker cp web:/etc/nginx/nginx.conf ./nginx.conf
docker cp ./app.conf web:/etc/nginx/conf.d/
```

### 4.3 Image Management

```bash
# Build image from Dockerfile
docker build -t myapp:latest .

# Build with no cache
docker build --no-cache -t myapp:latest .

# Pull image from registry
docker pull node:20-slim

# List images
docker images

# Remove image
docker rmi myapp:latest

# Remove dangling images
docker image prune -f
```

### 4.4 Docker Compose

```bash
# Start services (detached)
docker compose up -d

# Start with rebuild
docker compose up -d --build

# Stop and remove
docker compose down

# Stop and remove volumes
docker compose down -v

# View status
docker compose ps

# View logs
docker compose logs -f web

# Execute in service
docker compose exec web sh

# Build specific service
docker compose build web

# Validate compose file
docker compose config
```

### 4.5 Volumes & Networks

```bash
# List volumes
docker volume ls

# Create volume
docker volume create mydata

# Inspect volume
docker volume inspect mydata

# Remove volume
docker volume rm mydata

# Prune unused volumes
docker volume prune -f

# List networks
docker network ls

# Create network
docker network create mynet

# Connect container to network
docker network connect mynet web

# Disconnect from network
docker network disconnect mynet web
```

### 4.6 Disk Usage & Cleanup

```bash
# Check disk usage
docker system df

# Detailed disk usage
docker system df -v

# Full cleanup (dangling images + stopped containers + unused volumes)
docker system prune -af --volumes

# Remove stopped containers
docker container prune -f

# Remove unused images
docker image prune -af

# Remove build cache
docker builder prune -f
```

### 4.7 Dockerfile Optimization

```dockerfile
# Multi-stage build example
FROM node:20 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

Best practices:
- Order layers from least to most frequently changing
- Use .dockerignore to exclude node_modules, .git, etc.
- Pin base image versions for reproducibility
- Use COPY instead of ADD (unless you need tar extraction)
- Combine RUN commands to reduce layers (after: step-0)

3. [reviewer] ## Step 5: Verify Docker Operations

### 5.1 Container State

```bash
# Verify container is running
docker ps --filter "name=web" --format "{{.Names}}: {{.Status}}"
# Expected: web: Up 5 minutes

# Check container health
docker inspect web --format="{{.State.Health.Status}}"
# Expected: healthy

# Check container logs for errors
docker logs web --tail 20 2>&1 | grep -i error
```

### 5.2 Image State

```bash
# Verify image was built
docker images myapp:latest
# Expected: myapp   latest   abc123def456   5 minutes ago   150MB

# Test image runs correctly
docker run --rm myapp:latest echo "Hello"
# Expected: Hello
```

### 5.3 Compose State

```bash
# Verify all services are running
docker compose ps
# Expected: All services Up

# Check service logs for errors
docker compose logs web --tail 20 2>&1 | grep -i error

# Test connectivity between services
docker compose exec web curl -s http://db:5432
```

### 5.4 Disk Usage

```bash
# Check disk usage is acceptable
docker system df
# Expected: TYPE   TOTAL   ACTIVE   SIZE   RECLAIMABLE

# If usage is high, clean up
docker system prune -f
``` (after: step-1)
