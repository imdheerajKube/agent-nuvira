# Micro Frontend Reference Guide

## Overview
Set up micro-frontends: module federation, iframes, or Web Components for independent team deployments. Covers routing, shared state, and communication between micro-frontends. Use when scaling frontend development across teams.

## # micro-frontend

Set up micro-frontends: module federation, iframes, or Web Components for independent team deployments. Covers routing, shared state, and communication between micro-frontends. Use when scaling frontend development across teams.

## Goal pattern

micro-frontend module federation iframe web components independent deployment routing shared state

## Steps

0. [context-gatherer] Map the architecture: how many teams? What frameworks? What shared state? What routing strategy? What deployment model?

1. [planner] Design the micro-frontend architecture:
1. Approach: module federation (Webpack 5), single-spa, or iframe isolation
2. Shell app: routing, layout, shared navigation
3. Micro-apps: independent builds, independent deployments
4. Shared state: events bus, shared context, or URL-based
5. Routing: path-based or attribute-based composition
6. Communication: CustomEvents, shared library, or message passing (after: 'step-0')

2. [runner] Implement micro-frontends:
1. Set up shell application
2. Configure module federation or single-spa
3. Create first micro-app
4. Implement routing between micro-apps
5. Add shared state/communication
6. Test independent deployment (after: 'step-1')

3. [reviewer] Verify: micro-apps load independently, routing works, shared state syncs, deployment is independent, performance is acceptable. (after: 'step-2')

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
