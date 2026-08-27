# State Machine Reference Guide

## Overview
Design and implement state machines: order lifecycle, approval workflows, and complex business logic. Use when the goal asks to add state management, workflow automation, or business process logic.

## # state-machine

Design and implement state machines: order lifecycle, approval workflows, and complex business logic. Use when the goal asks to add state management, workflow automation, or business process logic.

## Goal pattern

state machine workflow lifecycle order approval process automation transition

## Parameters

- library (choice [default: auto]): State machine library

## Steps

1. [analyst] Define states and transitions: map all possible states, events that trigger transitions, and guard conditions.

2. [analyst] Choose the library: xstate, robot, or a custom implementation. Define the statechart with context and actions. (after: step-0)

3. [analyst] Implement the machine: create states, transitions, actions, and guards. Add side effects for entry/exit. (after: step-1)

4. [analyst] Integrate with the app: connect the machine to UI components, API calls, and database state. (after: step-2)

5. [analyst] Test: verify all transitions, test guard conditions, check side effects, and handle error states. (after: step-3)

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
