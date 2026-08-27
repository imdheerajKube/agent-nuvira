# Provider-Specific Deployment Guide

## Cloudflare Pages

```bash
# Install Wrangler CLI
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Build your project
npm run build

# Deploy to Cloudflare Pages
wrangler pages deploy dist --project-name=my-project

# Custom domain
wrangler pages domain add my-domain.com
```

**Configuration (wrangler.toml):**
```toml
name = "my-project"
compatibility_date = "2024-01-01"

[site]
bucket = "./dist"
```

## Netlify

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Login to Netlify
netlify login

# Build your project
npm run build

# Deploy to Netlify
netlify deploy --dir=dist --prod

# Or use the drag-and-drop UI at app.netlify.com
```

**Configuration (netlify.toml):**
```toml
[build]
  command = "npm run build"
  publish = "dist"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

## Vercel

```bash
# Install Vercel CLI
npm install -g vercel

# Login to Vercel
vercel login

# Deploy to Vercel
vercel --prod

# Or use the web UI at vercel.com
```

**Configuration (vercel.json):**
```json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "framework": "nextjs",
  "rewrites": [
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

## GitHub Pages

```bash
# Build your project
npm run build

# Install gh-pages
npm install -g gh-pages

# Deploy to GitHub Pages
gh-pages -d dist

# Or use GitHub Actions
```

**GitHub Actions (.github/workflows/deploy.yml):**
```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 18
      - run: npm ci
      - run: npm run build
      - uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./dist
```

## AWS S3 + CloudFront

```bash
# Create S3 bucket
aws s3 mb s3://my-bucket --region us-east-1

# Enable static website hosting
aws s3 website s3://my-bucket \
  --index-document index.html \
  --error-document index.html

# Build and sync
npm run build
aws s3 sync dist s3://my-bucket --delete

# Create CloudFront distribution
aws cloudfront create-distribution \
  --origin-domain-name my-bucket.s3.amazonaws.com \
  --default-root-object index.html
```

## Firebase Hosting

```bash
# Install Firebase CLI
npm install -g firebase-tools

# Login to Firebase
firebase login

# Initialize Firebase Hosting
firebase init hosting

# Build your project
npm run build

# Deploy to Firebase
firebase deploy --only hosting
```

**Configuration (firebase.json):**
```json
{
  "hosting": {
    "public": "dist",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "rewrites": [
      {
        "source": "**",
        "destination": "/index.html"
      }
    ],
    "headers": [
      {
        "source": "**/*.@(js|css)",
        "headers": [
          {
            "key": "Cache-Control",
            "value": "public, max-age=31536000, immutable"
          }
        ]
      }
    ]
  }
}
```

## Azure Static Web Apps

```bash
# Install Azure CLI
npm install -g azure-cli

# Login to Azure
az login

# Create static web app
az staticwebapp create \
  --name my-app \
  --resource-group myResourceGroup \
  --source https://github.com/user/repo \
  --branch main \
  --app-location "/" \
  --output-location "dist"
```

## Docker + Nginx

```dockerfile
# Build stage
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

**nginx.conf:**
```nginx
server {
    listen 80;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```
