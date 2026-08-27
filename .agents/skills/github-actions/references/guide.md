# Github Actions Reference Guide

## Overview
Set up GitHub Actions CI/CD workflows. Use when the goal asks to automate testing, building, or deployment via GitHub Actions.

## # github-actions

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

## Best Practices

- Follow the skill's methodology step by step
- Verify each step before proceeding to the next
- Use the appropriate tools for each task
- Document any deviations from the standard approach

## Common Patterns

- Start with context gathering to understand the current state
- Plan the implementation before writing code
- Test changes before committing
- Review for security and performance implications

## Troubleshooting

- If the skill fails, check the prerequisites first
- Verify environment variables are set correctly
- Check for conflicting configurations
- Review logs for detailed error messages

## Further Reading

- Refer to the main SKILL.md for complete methodology
- Check official documentation for the specific technology
- Review related skills in the registry for complementary approaches
