# Monorepo Setup Reference Guide

## Overview
Set up a monorepo with Turborepo, Nx, or Lerna: workspace configuration, build caching, dependency management, and CI optimization. Use when organizing multiple packages in a single repository.

## # monorepo-setup

Set up a monorepo with Turborepo, Nx, or Lerna: workspace configuration, build caching, dependency management, and CI optimization. Use when organizing multiple packages in a single repository.

## Goal pattern

monorepo turborepo nx lerna workspace build caching dependency management CI optimization

## Steps

0. [context-gatherer] Map the monorepo: how many packages? What languages? What build tools? What CI system? What shared code between packages?

1. [planner] Design the monorepo:
1. Tool: Turborepo (fast, simple), Nx (powerful, opinionated), or Lerna (npm-focused)
2. Workspaces: configure package manager workspaces
3. Build: topological build order, parallel execution, caching
4. Dependencies: shared dependencies, version management
5. CI: affected-only builds, cache restoration
6. Code sharing: shared configs, utilities, types (after: 'step-0')

2. [runner] Set up the monorepo:
1. Initialize workspace configuration
2. Configure build tool (Turbo/Nx/Lerna)
3. Move packages into workspace structure
4. Set up shared configurations
5. Configure build caching
6. Update CI pipeline (after: 'step-1')

3. [reviewer] Verify: builds work, caching works (verify second build is faster), dependency graph is correct, CI runs affected-only. (after: 'step-2')

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
