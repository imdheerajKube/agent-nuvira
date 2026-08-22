---
name: state-machine
description: Design and implement state machines: order lifecycle, approval workflows, and complex business logic. Use when the goal asks to add state management, workflow automation, or business process logic.
version: 1.0.0
---

# state-machine

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
