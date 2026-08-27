---
name: cloud-deploy
description: Deploy applications to AWS, GCP, or Azure. Use when the goal asks to deploy, host, or infrastructure-as-code for cloud platforms.
version: 2.0.0
whenToUse: Cloud deployment, serverless functions, container orchestration, static site hosting, API deployment
whenNotToUse: Local development (use Docker Compose), Kubernetes-only (use kubernetes skill), on-premise
---

# Cloud Deploy

Deploy applications to cloud platforms with production patterns.

## Goal pattern

cloud deploy AWS GCP Azure serverless lambda function app engine kubernetes

## Parameters

- provider (choice [default: aws]): Cloud provider
- strategy (choice [default: containers]): Deployment strategy
- monitoring (boolean [default: true]): Set up monitoring

## Steps

### Step 1: [context-gatherer] — Analyze deployment requirements

```bash
# Check cloud CLI
aws --version 2>/dev/null
gcloud --version 2>/dev/null
az --version 2>/dev/null

# Check Docker
docker --version
docker ps

# Check existing deployments
aws ecs list-clusters 2>/dev/null | head -5
gcloud run services list 2>/dev/null | head -5
```

- What application? (web app, API, worker, static site)
- What cloud provider? (AWS, GCP, Azure)
- What deployment target? (ECS, Cloud Run, App Service, Lambda)
- What environment variables? (secrets, config)
- What domain/SSL? (custom domain, certificates)

### Step 2: [writer] — Create deployment configuration

**AWS ECS deployment:**
```yaml
# Dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]

---
# ECS Task Definition
{
  "family": "myapp",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "containerDefinitions": [
    {
      "name": "myapp",
      "image": "123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:latest",
      "portMappings": [
        { "containerPort": 3000, "protocol": "tcp" }
      ],
      "environment": [
        { "name": "NODE_ENV", "value": "production" }
      ],
      "secrets": [
        { "name": "DATABASE_URL", "valueFrom": "arn:aws:ssm:us-east-1:123456789:parameter/myapp/db-url" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/myapp",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3
      }
    }
  ]
}
```

**GCP Cloud Run:**
```yaml
# cloudbuild.yaml
steps:
  - name: 'gcr.io/cloud-builders/docker'
    args: ['build', '-t', 'gcr.io/$PROJECT_ID/myapp:$COMMIT_SHA', '.']
  
  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', 'gcr.io/$PROJECT_ID/myapp:$COMMIT_SHA']
  
  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    args:
      - gcloud
      - run
      - deploy
      - myapp
      - --image=gcr.io/$PROJECT_ID/myapp:$COMMIT_SHA
      - --region=us-central1
      - --platform=managed
      - --allow-unauthenticated

images:
  - 'gcr.io/$PROJECT_ID/myapp:$COMMIT_SHA'
```

### Step 3: [runner] — Deploy application

```bash
# Build and push Docker image
docker build -t myapp:latest .
docker tag myapp:latest 123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:latest
docker push 123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:latest

# Deploy to ECS
aws ecs update-service \
  --cluster myapp-cluster \
  --service myapp-service \
  --force-new-deployment

# Wait for deployment
aws ecs wait services-stable \
  --cluster myapp-cluster \
  --services myapp-service

# Verify deployment
aws ecs describe-services \
  --cluster myapp-cluster \
  --services myapp-service \
  --query 'services[0].{status:status,desired:desiredCount,running:runningCount}'
```

### Step 4: [reviewer] — Verify deployment

```bash
# Health check
curl -f https://myapp.example.com/health

# Check logs
aws logs tail /ecs/myapp --follow

# Verify SSL
openssl s_client -connect myapp.example.com:443 -servername myapp.example.com

# Load test
ab -n 100 -c 10 https://myapp.example.com/
```

**Verification checklist:**
- [ ] Application responds to health checks
- [ ] SSL certificate valid
- [ ] Environment variables set correctly
- [ ] Logs flowing to CloudWatch/Cloud Logging
- [ ] Auto-scaling configured
- [ ] Database connections working
- [ ] No errors in deployment logs

## Reference Documents

Load deep-dive content with `skill_view('cloud-deploy', 'references/aws-services.md')`.
