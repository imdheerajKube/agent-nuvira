# Follow-Up Implementation Plan: Routing Upgrade

## Goal

Evolve Agent-Nuvira’s routing from a heuristic provider picker into a more intent-aware, verification-aware, and self-improving router inspired by Ruflo-style orchestration patterns.

## Milestone 1 — Improve task understanding

### Objective
Make routing decisions more accurate by understanding task intent beyond simple keyword matching.

### Scope
- Extend the existing task-profile classifier in [src/learning/auto-router.ts](src/learning/auto-router.ts).
- Add support for more task categories:
  - architecture
  - migration
  - security audit
  - test generation
  - documentation
  - debugging
  - rollout/verification

### Acceptance criteria
- The router can classify at least 6 distinct task intents.
- The classification output is used to adjust routing weights and explanation text.
- Unit tests cover at least 3 new task categories.
- Existing auto-router tests continue to pass.

### Deliverables
- Updated task-profile analysis logic.
- New unit tests in [tests/learning/auto-router.test.ts](tests/learning/auto-router.test.ts).

---

## Milestone 2 — Strengthen verification and escalation behavior

### Objective
Make high-risk and verification-heavy tasks route more conservatively and more effectively.

### Scope
- Improve the current verification-aware escalation logic.
- Introduce a stronger strategy for:
  - deployment/rollout tasks
  - security-sensitive work
  - production-critical changes
- Allow multi-pass behavior where appropriate, such as:
  - quick draft pass
  - verification pass
  - fallback to stronger provider if confidence is low

### Acceptance criteria
- Verification-heavy tasks preferentially route to stronger providers when available.
- The router exposes escalation metadata clearly in the result object and explanation.
- At least one end-to-end or unit test confirms the escalation path.
- The behavior is documented in the handoff notes and changelog.

### Deliverables
- Updated escalation logic in [src/learning/auto-router.ts](src/learning/auto-router.ts).
- Tests covering escalation behavior and metadata.

---

## Milestone 3 — Improve learning from outcomes

### Objective
Move from static heuristics toward feedback-driven routing.

### Scope
- Expand the bandit reward model in [src/learning/router-bandit.ts](src/learning/router-bandit.ts).
- Track richer signals such as:
  - latency
  - token cost
  - success/failure
  - test pass rate
  - edit correctness
  - user acceptance

### Acceptance criteria
- The bandit can consume richer reward signals beyond a binary success/failure.
- Outcome recording remains backward compatible with existing routing flows.
- Unit tests verify that richer outcome data is accepted and persisted.
- Existing bandit tests still pass.

### Deliverables
- Expanded outcome schema and reward logic.
- Updated tests in [tests/learning/router-bandit.test.ts](tests/learning/router-bandit.test.ts).

---

## Milestone 4 — Integrate routing into orchestration

### Objective
Make routing part of the broader agent execution strategy rather than only a provider picker.

### Scope
- Wire routing outcomes into the orchestrator/planner flow.
- Route not only the model/provider, but also the execution strategy:
  - single-pass
  - verify-pass
  - consensus-style review
  - privacy-preserving path

### Acceptance criteria
- The orchestrator can consume routing metadata from the router.
- A task can trigger a different execution strategy based on the routing profile.
- At least one integration-style test proves the orchestrator uses the routing metadata.
- The behavior is documented in the routing handoff artifacts.

### Deliverables
- Orchestrator updates in the relevant agent execution path.
- Integration tests and documentation updates.

---

## Milestone 5 — Improve observability and explainability

### Objective
Make routing decisions visible, debuggable, and trustworthy.

### Scope
- Improve the explanation output with more detailed reasons.
- Surface the task profile, selected provider, fallback chain, and escalation reason.
- Keep explanations concise enough for CLI and dashboard use.

### Acceptance criteria
- Each routing decision includes a human-readable explanation with enough detail to debug the choice.
- The explanation includes the task intent and escalation status where relevant.
- Dashboard/CLI output remains readable and not overly verbose.

### Deliverables
- Updated explanation and debug formatting.
- Tests for explanation content.

---

## Suggested implementation order

1. Milestone 1 — Improve task understanding
2. Milestone 2 — Strengthen verification and escalation
3. Milestone 3 — Improve learning from outcomes
4. Milestone 4 — Integrate routing into orchestration
5. Milestone 5 — Improve observability and explainability

---

## Validation checklist

Before marking work complete, the next agent should verify:
- [ ] Auto-router unit tests pass
- [ ] Bandit tests pass
- [ ] Relevant integration tests pass
- [ ] Changelog and handoff notes reflect the changes
- [ ] Routing explanations remain clear and useful

## Verification command

```bash
npx vitest run tests/learning/auto-router.test.ts tests/learning/router-bandit.test.ts
```
