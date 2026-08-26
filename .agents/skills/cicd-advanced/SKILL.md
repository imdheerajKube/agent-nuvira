---
name: cicd-advanced
description: Advanced CI/CD pipelines: multi-stage builds, canary deployments, rollback strategies, artifact management, and pipeline optimization. Use when building sophisticated deployment pipelines.
version: 1.0.0
---

# cicd-advanced

Advanced CI/CD pipelines: multi-stage builds, canary deployments, rollback strategies, artifact management, and pipeline optimization. Use when building sophisticated deployment pipelines.

## Goal pattern

CI CD pipeline advanced canary deployment rollback artifact optimization multi-stage

## Steps

0. [context-gatherer] Map the pipeline requirements: what CI system (GitHub Actions, GitLab CI, Jenkins)? What deployment targets? What rollback strategy? What artifact storage?

1. [planner] Design the advanced pipeline:
1. Multi-stage: build → test → stage → canary → production
2. Canary: deploy to small percentage, monitor, gradually increase
3. Rollback: automatic on failure, manual override
4. Artifacts: versioned builds, signed releases
5. Optimization: parallel jobs, caching, matrix builds
6. Security: SAST, DAST, dependency scanning (after: 'step-0')

2. [runner] Implement the pipeline:
1. Create multi-stage workflow
2. Add canary deployment logic
3. Implement rollback triggers
4. Configure artifact storage
5. Add security scanning
6. Test with dry-run deployments (after: 'step-1')

3. [reviewer] Verify: pipeline stages execute in order, canary works, rollback triggers on failure, artifacts are stored correctly. (after: 'step-2')
