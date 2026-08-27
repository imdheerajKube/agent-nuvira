# Cross Platform Build Reference Guide

## Overview
Build cross-platform applications: shared codebase targeting web, desktop (Electron/Tauri), and mobile (React Native/Flutter). Covers platform detection, shared logic, and platform-specific adaptations. Use when building for multiple platforms from one codebase.

## # cross-platform-build

Build cross-platform applications: shared codebase targeting web, desktop (Electron/Tauri), and mobile (React Native/Flutter). Covers platform detection, shared logic, and platform-specific adaptations. Use when building for multiple platforms from one codebase.

## Goal pattern

cross platform build electron tauri react native flutter shared codebase multi-platform

## Steps

0. [context-gatherer] Map the platforms: what targets (web, desktop, mobile)? What shared business logic? What platform-specific features (camera, GPS, notifications)?

1. [planner] Design the cross-platform architecture:
1. Shared layer: business logic, data models, API clients (TypeScript/Dart/Kotlin)
2. Platform adapters: interfaces for platform-specific code
3. UI: shared components where possible, platform-specific where needed
4. Build system: platform-specific builds from shared source
5. Testing: shared tests for business logic, platform-specific E2E
6. Deployment: platform-specific release pipelines (after: 'step-0')

2. [runner] Implement cross-platform build:
1. Set up shared project structure
2. Extract shared business logic
3. Create platform adapters
4. Implement platform-specific UI
5. Configure build for each platform
6. Test on all target platforms (after: 'step-1')

3. [reviewer] Verify: app builds for all platforms, shared logic works identically, platform features accessible, performance acceptable. (after: 'step-2')

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
