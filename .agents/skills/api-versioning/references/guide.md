# Api Versioning Reference Guide

## Overview
Implement API versioning: URL path, header, or content-type versioning with deprecation notices and migration guides. Use when the goal asks to version an API, handle breaking changes, or add deprecation notices.

## # api-versioning

Implement API versioning: URL path, header, or content-type versioning with deprecation notices and migration guides. Use when the goal asks to version an API, handle breaking changes, or add deprecation notices.

## Goal pattern

api version versioning deprecation breaking change migration url header

## Parameters

- strategy (choice [default: auto]): Versioning strategy

## Steps

1. [analyst] Choose versioning strategy: URL path (/v1/), header (API-Version), or content-type negotiation. Define version lifecycle.

2. [analyst] Restructure routes: move existing endpoints under a version prefix. Set up version-aware middleware. (after: step-0)

3. [analyst] Add deprecation support: implement Sunset header, deprecation warnings in responses, and version negotiation. (after: step-1)

4. [analyst] Write migration guides: document breaking changes between versions, provide code examples for upgrades. (after: step-2)

5. [analyst] Test version coexistence: verify v1 and v2 endpoints work simultaneously, check deprecation headers appear. (after: step-3)

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
