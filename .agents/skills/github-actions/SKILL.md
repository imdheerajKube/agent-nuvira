---
name: github-actions
description: Set up GitHub Actions CI/CD workflows. Use when the goal asks to automate testing, building, or deployment via GitHub Actions.
version: 2.0.0
whenToUse: CI/CD pipelines, automated testing, build automation, deployment workflows, release management
whenNotToUse: Local dev scripts (use Makefile), cron jobs (use system cron), one-off tasks
---

# GitHub Actions

Set up GitHub Actions CI/CD workflows with enterprise patterns.

## Goal pattern

github actions ci cd workflow pipeline automate test build deploy

## Parameters

- language (choice [default:typescript]): Primary language
- deployTarget (choice [default: docker]): Deployment target
- matrix (boolean [default: true]): Multi-OS/version testing

## Steps

### Step 1: [context-gatherer] — Analyze CI/CD requirements

```bash
# Check existing workflows
ls -la .github/workflows/ 2>/dev/null

# Check package.json scripts
cat package.json | jq '.scripts' 2>/dev/null

# Check existing CI config
ls .github/ 2>/dev/null
cat .github/CODEOWNERS 2>/dev/null
```

- What triggers? (push, PR, schedule, manual)
- What tests? (unit, integration, e2e, security)
- What build targets? (Docker, npm, binary, deploy)
- What environments? (dev, staging, prod)
- What secrets needed? (API keys, deploy tokens)

### Step 2: [writer] — Create workflow files

**CI Workflow:**
```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck

  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'
      - run: npm ci
      - run: npm test -- --coverage
      - uses: actions/upload-artifact@v4
        with:
          name: coverage-${{ matrix.node-version }}
          path: coverage/

  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm audit --audit-level=high
      - uses: aquasecurity/trivy-action@master
        with:
          scan-type: 'fs'
          severity: 'HIGH,CRITICAL'
```

**CD Workflow:**
```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      environment:
        description: 'Deploy target'
        required: true
        default: 'staging'
        type: choice
        options:
          - staging
          - production

jobs:
  deploy-staging:
    if: github.event.inputs.environment == 'staging' || github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to staging
        run: |
          echo "Deploying to staging..."
          # Your deploy commands here
      - name: Run smoke tests
        run: |
          curl -f https://staging.example.com/health || exit 1

  deploy-production:
    needs: deploy-staging
    if: github.event.inputs.environment == 'production'
    runs-on: ubuntu-latest
    environment: 
      name: production
      url: https://example.com
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to production
        run: |
          echo "Deploying to production..."
      - name: Verify deployment
        run: |
          curl -f https://example.com/health || exit 1
```

### Step 3: [runner] — Push and verify workflows

```bash
# Create workflow directory
mkdir -p .github/workflows

# Copy workflow files
# (files created in step 2)

# Commit and push
git add .github/workflows/
git commit -m "ci: add GitHub Actions workflows"
git push

# Check workflow runs
gh run list --limit=5
gh run view <run-id>
```

### Step 4: [reviewer] — Verify CI/CD works

```bash
# Check workflow status
gh run list --status=failed

# Verify secrets are set
gh secret list

# Test manual trigger
gh workflow run deploy.yml -f environment=staging

# Check deployment environment protection
gh api repos/{owner}/{repo}/environments
```

**Verification checklist:**
- [ ] CI runs on every PR
- [ ] Tests pass on all matrix combinations
- [ ] Security scan runs and passes
- [ ] Deploy workflow has environment protection
- [ ] Secrets are configured (not hardcoded)
- [ ] Caching reduces build times
- [ ] Artifacts uploaded for coverage
- [ ] Branch protection requires CI pass

## Reference Documents

Load deep-dive content with `skill_view('github-actions', 'references/ci-cd-patterns.md')`.
