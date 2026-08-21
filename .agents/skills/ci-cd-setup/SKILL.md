---
name: ci-cd-setup
description: Set up CI/CD: detect the platform and project stack, write the workflow/pipeline file, configure secrets, trigger a test run, and verify the pipeline passes. Use when the goal asks to set up CI/CD, add GitHub Actions, configure pipelines, automate tests, or set up continuous integration.
version: 1.0.0
---

# ci-cd-setup

Set up CI/CD: detect the platform and project stack, write the workflow/pipeline file, configure secrets, trigger a test run, and verify the pipeline passes. Use when the goal asks to set up CI/CD, add GitHub Actions, configure pipelines, automate tests, or set up continuous integration.

## Goal pattern

CI CD continuous integration GitHub Actions GitLab CI pipeline workflow automate test build deploy

## Parameters

- platform (choice [default: auto]): CI platform (auto-detected from repo if not specified)
- languages (string): Languages/runtimes to test (auto-detected from project if not specified)

## Steps

1. [context-gatherer] Detect the platform and stack:
- Check for `.github/workflows/` (GitHub Actions), `.gitlab-ci.yml` (GitLab CI), `Jenkinsfile` (Jenkins), `bitbucket-pipelines.yml` (Bitbucket)
- Read package.json / pyproject.toml / go.mod for: language, test command, build command, lint command
- Check for existing CI config (may need to extend, not replace)
- Note the Node/Python/Go version, and whether Docker is needed
Produce: platform, language, commands, and the workflow file path.

2. [writer] Write the CI workflow file:
- GitHub Actions: `.github/workflows/ci.yml` with triggers (push to main, PR), jobs (lint, typecheck, test, build), caching (node_modules, pip cache), and matrix (Node versions if needed)
- GitLab CI: `.gitlab-ci.yml` with stages (lint, test, build), cache, and artifacts
- Include: checkout, setup, install deps, lint, typecheck, test, build (in that order)
- Add status badges to README.md
Each job should fail fast (lint before test, test before build) to save CI minutes. (after: step-0)

3. [runner] Configure secrets and variables:
- List required secrets (API keys, tokens, env vars needed for tests)
- Document where to set them (GitHub: Settings → Secrets → Actions; GitLab: Settings → CI/CD → Variables)
- Add any required environment variables to the workflow (NODE_ENV=test, etc.)
Never hardcode secrets in the workflow file — always use secrets/variables. (after: step-1)

4. [runner] Trigger a test run and verify:
- Push the workflow file to a branch: Run `git add .github/workflows/ci.yml && git commit -m "ci: add CI pipeline"`
- Create a PR or push to main to trigger the workflow
- Monitor the run (GitHub: `gh run watch` or GitLab: check the pipeline page)
- If it fails: read the logs, fix the issue, push again
The pipeline must pass before the setup is complete. (after: step-2)
