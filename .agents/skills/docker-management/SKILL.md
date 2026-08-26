---
name: docker-management
description: Manage Docker containers, images, volumes, networks, and Compose stacks. Use when the goal is to run, stop, restart, inspect, or debug Docker containers; build, pull, push, or clean up images; manage Docker Compose services; work with volumes or networks; check disk usage; or debug container issues. Also use for Dockerfile optimization and container health monitoring.
version: 1.0.0
---

# docker-management

Manage Docker containers, images, volumes, networks, and Compose stacks. Use when the goal is to run, stop, restart, inspect, or debug Docker containers; build, pull, push, or clean up images; manage Docker Compose services; work with volumes or networks; check disk usage; or debug container issues. Also use for Dockerfile optimization and container health monitoring.

## Goal pattern

docker container image compose volume network build pull push run stop start restart exec logs inspect stats cleanup prune disk debug dockerfile optimization health

## Parameters

- action: Docker action to perform: run | stop | start | restart | exec | logs | build | pull | compose-up | compose-down | compose-ps | disk-usage | cleanup | health
- target: Container name, image name, or compose project directory
- command: Command to execute in container (for exec action)

## Steps

0. [context-gatherer] No description

1. [runner] No description (after: 'step-0')

2. [reviewer] Docker action to perform: run | stop | start | restart | exec | logs | build | pull | compose-up | compose-down | compose-ps | disk-usage | cleanup | health (after: 'step-1')
