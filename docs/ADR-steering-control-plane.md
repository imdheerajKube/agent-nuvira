# ADR: Steering is a control plane, not a chat feature

- **Status:** Implemented (feature flag: `steering.enabled`, default **off**)
- **Date:** 2026-11-09
- **Scope:** mid-run interactive guidance for Agent-Nuvira

## Context

A long autonomous run has no second user message. The main composer is locked while
a turn is in flight, and injecting raw text into the live thread would be a
prompt-injection path with no audit trail. The existing `CHANGE_REQUEST.md` watcher
is a file with no queue, author, classification, approval workflow, plan version,
audit record, backlog, or engine parity. It re-reads the latest content, so two
quick messages overwrite each other and "was this applied?" cannot be answered.

## Decision

Build a **durable Steering Control Plane**:

> The LLM proposes. Deterministic policy disposes. The human approves material
> changes. The executor never approves its own scope change.

The user submits guidance to a durable inbox. A separate Change Steward returns a
structured proposal with no tool access and no authority. A deterministic policy
engine decides what may happen. A versioned plan is changed only by the run
process, only at a safe point, with an audit trail and human approval for material
changes.

### Ownership

| State | Writer | Mutability |
|---|---|---|
| Original task contract | run process | immutable |
| Contract amendments | run process (approved constraints) | append-only |
| Plan versions | run process only | immutable versions, CAS |
| Change ledger | any surface (inbox), run process (status) | append-only record per change |
| Run journal | run process | append-only JSONL |
| Approvals | user surfaces | one record per change |
| Backlog | policy on triage | explicit status only |

### Safe points

A plan is mutated only:

- before the next model call in the loop engine;
- between task batches in the pipeline engine;
- never during a file write, shell command, or model stream.

The loop's pre-model boundary and the orchestrator's batch boundary are the two
hooks. Both call the same scheduler through an engine-neutral `SteeringPlanAdapter`.

### Dimensions, not categories

Instead of Category A–E, every change carries independent dimensions:
`relation`, `kind`, `timing`, `impact`, `confidence`, `conflict`, `authority`,
`disposition`. "Immediate" means **next safe point**. "Conflict" is a field, not a
bucket that hides the kind. "Deferred" is a timing outcome.

### Policy invariants (pinned by tests)

1. A message that tries to change policy, bypass a gate, or extract a secret is
   rejected before any semantic rule.
2. `stop` is immediate; `pause` takes effect at the next safe point.
3. A `new_task` is always backlogged, never absorbed.
4. A question is answered only; no plan change.
5. Confidence below the threshold asks the user to confirm the interpretation.
6. A constraint-only guardrail ("do not touch payments") is accepted as a contract
   amendment — it can only narrow future work.
7. High impact, conflict, superseding an approved requirement, irreversible work,
   or removing completed work requires human approval.
8. An observation with no concrete operation is `answer_only`, not an empty "applied".
9. The model's `requiresApproval` flag is advisory and can only escalate.
10. Every applied change creates an immutable plan version and a visible diff.

### Threat model

| Threat | Mitigation |
|---|---|
| Prompt injection through guidance | Guidance is JSON data in the Steward prompt; a deterministic injection scan rejects policy overrides and credential requests; the Steward has no tools. |
| Executor self-approval | Only `decideApproval` (user surface) moves a change from `needs_approval` to `accepted`. The model cannot call it. |
| Plan corruption mid-tool | Safe-point scheduler; one writer; compare-and-swap on the parent version. |
| Losing guidance on crash | Persist before receipt; journal; atomic writes; lease with expiry. |
| Duplicate submissions | Explicit idempotency key + content hash window. |
| Secret leakage to the evaluator | Shared `redact` before the Steward prompt; bounded context; no repo dump. |
| Two writers on one run | Lease per run; a refused lease writes an event and applies nothing. |
| Run never finishes | Open-change cap, applied-change budget, coalescing, approval for reductions. |
| Engine drift | Shared scheduler/policy; `SteeringPlanAdapter` contract tests for both engines. |

### Event taxonomy

```
run.started, run.stopped, run.paused, run.completed, run.failed
guidance.received, guidance.triaging, guidance.triaged
change.accepted, change.needs_approval, change.approved, change.rejected,
change.deferred, change.backlogged, change.applied, change.failed, change.stale
plan.version_created, plan.change_applied, plan.change_refused
```

Each journal event carries `eventId`, `runId`, `sequence`, `timestamp`, `actor`,
optional `correlationId`/`causationId`, `planVersion`, and `changeId`.

## Storage

File-based per run under the configured memory home:

```
~/.nuvira/memory/steering/runs/<runId>/
  run.json
  contract.json
  events.jsonl
  changes/<changeId>.json
  approvals/<changeId>.json
  plans/v<N>.json
  backlog.json
```

Atomic writes (temp + rename), best-effort reads (a corrupt record is a miss).
SQLite WAL is the documented next step when concurrent writers become real; no
Redis/Kafka/Temporal in this design.

## Rollout and rollback

- `steering.enabled` defaults to **false**.
- `NUVIRA_STEERING=1` enables it per process; `NUVIRA_STEERING=0` disables it even
  when config says on.
- With the flag off, no inbox is read and no plan is mutated: a turn is identical to
  one from before this feature.
- The dashboard guidance lane renders only when the server reports `enabled: true`.

## Consequences

Positive: a real collaboration channel; durable, explainable outcomes; safe
application; both engines share semantics; a new-task backlog instead of lossy
advice.

Costs: one extra model call when guidance arrives; per-run file state; a new
operator concept to document; approvals can be ignored (they expire and become
visible deferrals).
