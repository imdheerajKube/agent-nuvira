---
name: docker-config
description: Configure Docker for a project: analyze dependencies, write a multi-stage Dockerfile, optimize layer caching, test the build, and optionally add docker-compose. Use when the goal asks to containerize, add Docker, create a Dockerfile, or set up docker-compose for local development.
version: 1.0.0
---

# docker-config

Configure Docker for a project: analyze dependencies, write a multi-stage Dockerfile, optimize layer caching, test the build, and optionally add docker-compose. Use when the goal asks to containerize, add Docker, create a Dockerfile, or set up docker-compose for local development.

## Goal pattern

Docker Dockerfile containerize docker-compose multi-stage build image layer optimize

## Parameters

- baseImage (string): Base Docker image (auto-detected from project language if not specified)
- multiStage (choice [default: yes]): Use multi-stage build (default: yes)

## Steps

1. [context-gatherer] Analyze the project dependencies:
- Read package.json / pyproject.toml / go.mod for: language, runtime version, build command, start command
- Check for existing Dockerfile or docker-compose.yml
- Identify the build output (dist/, build/, .next/, etc.)
- Note any native dependencies (node-gyp, system libs) that need build tools in the image
Produce: language, runtime version, build command, start command, and native deps list.

2. [writer] Write a multi-stage Dockerfile:
- Stage 1 (builder): install deps + build — include devDependencies for the build
- Stage 2 (runtime): copy only the build output + production deps — minimal final image
- Use official base images (node:20-alpine, python:3.12-slim, golang:1.22-alpine)
- Order layers by change frequency: OS deps → project deps → source code (rarely changes → often changes)
- Add .dockerignore (node_modules, .git, dist, *.md)
The multi-stage pattern keeps the final image small (no dev tools, no source code). (after: step-0)

3. [runner] Test the Docker build:
- Build: Run `docker build -t <project> .`
- Verify the image runs: Run `docker run --rm -p 3000:3000 <project>`
- Check the image size: Run `docker images <project>` — aim for < 200MB for Node.js, < 100MB for Go
- Verify the app works inside the container (curl the health endpoint)
If the build fails: read the error, fix the Dockerfile, rebuild. (after: step-1)

4. [writer] Write docker-compose.yml for local development (if needed):
- Define services (app + any dependencies: database, cache, queue)
- Mount source code as a volume for hot-reload during dev
- Set environment variables (DATABASE_URL, REDIS_URL, etc.)
- Add health checks for dependent services
Test: Run `docker-compose up` and verify all services start and communicate. (after: step-2)
