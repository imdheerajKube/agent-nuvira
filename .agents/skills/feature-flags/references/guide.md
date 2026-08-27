# Feature Flags Reference Guide

## Overview
Implement feature flags: LaunchDarkly, Unleash, or custom flags for gradual rollouts, A/B testing, and kill switches. Use when the goal asks to add feature flags, gradual rollouts, or toggle features.

## # feature-flags

Implement feature flags: LaunchDarkly, Unleash, or custom flags for gradual rollouts, A/B testing, and kill switches. Use when the goal asks to add feature flags, gradual rollouts, or toggle features.

## Goal pattern

feature flag toggle rollout ab testing kill switch launchdarkly unleash

## Parameters

- provider (choice [default: auto]): Feature flag provider

## Steps

1. [analyst] Choose the feature flag system: LaunchDarkly, Unleash, Flipt, or a custom in-memory store. Install and configure.

2. [analyst] Define flags: create flag definitions with types (boolean, string, number), default values, and targeting rules. (after: step-0)

3. [analyst] Integrate in code: wrap feature checks in flag evaluation functions. Add server-side and client-side SDKs. (after: step-1)

4. [analyst] Set up gradual rollout: percentage-based rollouts, user segmentation, and environment-specific overrides. (after: step-2)

5. [analyst] Monitor and clean up: track flag usage, remove stale flags, and document the flag lifecycle process. (after: step-3)

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
