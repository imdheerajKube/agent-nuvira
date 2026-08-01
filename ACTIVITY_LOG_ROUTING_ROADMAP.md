# Routing Roadmap Activity Log

This file is a handoff artifact for the next developer agent working on the routing stack.
It captures what has been implemented, what remains to be done, and where the next changes should land.

## Purpose

The goal is to evolve Agent-Nuvira’s routing from a heuristic provider picker into a more intent-aware, verification-aware, and learning-driven router inspired by Ruflo-style orchestration patterns.

## Completed Work

### 1. Routing architecture foundation
- Reviewed the existing routing implementation in:
  - [src/learning/auto-router.ts](src/learning/auto-router.ts)
  - [src/learning/hybrid-router.ts](src/learning/hybrid-router.ts)
  - [src/learning/model-router.ts](src/learning/model-router.ts)
  - [src/learning/router-bandit.ts](src/learning/router-bandit.ts)
  - [src/learning/tier0-router.ts](src/learning/tier0-router.ts)
- Identified the current strengths:
  - multi-dimensional scoring
  - hard constraints
  - rules-based overrides
  - Thompson-sampling bandit
  - tier-0 deterministic fallback for simple edits

### 2. Intent-aware routing scaffold
- Added a lightweight task-profile layer to the auto router.
- The router now classifies tasks into intents such as planning, coding, debugging, security, and verification.
- Verification-heavy tasks now shift the weight mix toward reasoning and reliability.
- The explanation output now exposes a verification marker for these decisions.

### 3. Regression tests for the new behavior
- Added tests covering:
  - task-profile analysis for verification-heavy tasks
  - planning tasks staying lightweight by default
  - verification-aware escalation behavior in routing decisions
  - explicit escalation metadata on routing results
- File: [tests/learning/auto-router.test.ts](tests/learning/auto-router.test.ts)

### 4. Verification-aware escalation patch
- The router now records an `escalationApplied` flag on each routing result.
- For verification-heavy tasks, the router reorders provider candidates so the escalation target is considered first when available.
- This provides a concrete foundation for future multi-pass verification workflows.

### 5. Richer task-intent classification
- Expanded the task-profile classifier to recognize architecture and migration intents alongside the existing planning, debugging, verification, and security categories.
- Architecture- and migration-related prompts now trigger stronger reasoning/reliability-oriented routing behavior.
- The classifier is intentionally conservative so planning prompts that are not truly architecture-heavy remain lightweight.

### 6. Richer bandit rewards from outcome data
- Extended the bandit reward model to consider richer outcome telemetry such as quality score, verification pass/fail, and user acceptance.
- Successful outcomes can now receive a stronger reward when they are high quality and verified, while negative outcomes apply a stronger penalty when verification fails.
- The bandit history now persists these richer signals for observability and future tuning.

### 7. Changelog entry
- Added a repo-local changelog section documenting the routing roadmap work.
- File: [CHANGELOG.md](CHANGELOG.md)

## Implementation Notes

### Router entry points
- Primary routing logic lives in [src/learning/auto-router.ts](src/learning/auto-router.ts).
- Task complexity still comes from [src/learning/hybrid-router.ts](src/learning/hybrid-router.ts).
- The learning bandit remains in [src/learning/router-bandit.ts](src/learning/router-bandit.ts).

### Current behavior
- Auto routing now uses a simple task-profile classifier before scoring.
- For verification-like tasks, the router boosts reasoning and reliability in the effective weights.
- This is a first step toward intent-aware routing and will be expanded with richer task classification and stronger escalation logic.

## Suggested Next Steps

A follow-up implementation plan has been added at [FOLLOW_UP_IMPLEMENTATION_PLAN.md](FOLLOW_UP_IMPLEMENTATION_PLAN.md) with phased milestones, scope, and acceptance criteria for the routing upgrade.

### Phase 1 — Improve task understanding
- Replace the current keyword-based task classifier with a richer intent classifier.
- Add more task categories such as:
  - architecture
  - migration
  - security audit
  - test generation
  - documentation
- Keep the output structure compatible with the existing TaskProfile interface.

### Phase 2 — Stronger escalation
- Add a second-pass strategy for verification-heavy or high-risk tasks.
- Examples:
  - choose a stronger provider if the initial provider is weak for verification
  - allow a two-pass workflow: quick draft → verification pass
  - use fallback chains more aggressively for critical tasks

### Phase 3 — Outcome-driven learning
- Expand bandit rewards beyond simple success/failure to include:
  - latency
  - cost efficiency
  - test pass rate
  - edit correctness
  - user acceptance
- Persist richer signal data for future route tuning.

### Phase 4 — Planner integration
- Make routing a first-class part of the orchestrator/planner flow.
- Route not just the provider/model, but the execution strategy itself:
  - single-pass
  - verify-pass
  - consensus-style review
  - local-private workflow

## Validation Status

Verified by running:

```bash
npx vitest run tests/learning/auto-router.test.ts
```

Result: 79 tests passed.

## Handoff Guidance

When continuing this work, keep these principles in mind:
- Preserve backward compatibility with existing routing interfaces.
- Keep explanations human-readable and auditable.
- Make changes incrementally and validate with targeted tests.
- Prefer small, well-scoped patches over large rewrites.
