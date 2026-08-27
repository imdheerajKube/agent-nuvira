# Dockerfile Best Practices

## Multi-Stage Builds

Multi-stage builds reduce final image size by only copying artifacts from builder stages.

```dockerfile
# Stage 1: Build
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build

# Stage 2: Production
FROM node:18-alpine AS production
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

## Layer Optimization

- Order layers from least to most frequently changing
- Combine RUN commands to reduce layers
- Use `.dockerignore` to exclude unnecessary files

```dockerfile
# Bad: 3 layers
RUN apt-get update
RUN apt-get install -y curl
RUN rm -rf /var/lib/apt/lists/*

# Good: 1 layer
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*
```

## Security Best Practices

```dockerfile
# Run as non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup
USER appuser

# Use specific version tags (not :latest)
FROM node:18.17.0-alpine

# Scan for vulnerabilities
# docker scan <image>
```

## Health Checks

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
```

## Environment Variables

```dockerfile
# Use ARG for build-time, ENV for runtime
ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}

# Don't store secrets in ENV (use Docker secrets or mounted files)
# BAD: ENV DB_PASSWORD=secret123
# GOOD: Mount secret file or use Docker secrets
```

## Common Patterns

### Node.js
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

### Python
```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["python", "app.py"]
```

### Go
```dockerfile
FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY . .
RUN CGO_ENABLED=0 go build -o main .

FROM alpine:3.18
COPY --from=builder /app/main /main
EXPOSE 8080
CMD ["/main"]
```
