---
name: github-actions
description: Set up GitHub Actions CI/CD workflows. Use when the goal asks to automate testing, building, or deployment via GitHub Actions.
version: 1.0.0
---

# github-actions

Set up GitHub Actions CI/CD workflows. Use when the goal asks to automate testing, building, or deployment via GitHub Actions.

## Goal pattern

github actions ci cd workflow pipeline automate test build deploy

## Parameters

- language (choice [default: typescript]): Primary language

## Steps

1. [analyst] Define workflow triggers (push, PR, schedule) and job matrix (OS, language versions).

2. [analyst] Add steps: checkout, setup, install, lint, test, build, deploy. Use caching for dependencies. (after: step-0)

3. [analyst] Add secrets management, artifact uploads, and environment-specific deployments. (after: step-1)

4. [analyst] Add status checks, branch protection, and deployment gates. (after: step-2)
