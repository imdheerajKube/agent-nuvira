# Mid-Run Steering

A second input channel for a run that is already in progress. The main composer
stays locked: the original task remains stable and the agent cannot be silently
reprogrammed mid-write. Guidance goes through a governed change process instead.

Enable it first (it is off by default):

```bash
nuvira config set steering.enabled true
# or per process:
NUVIRA_STEERING=1 nuvira chat "build the auth service"
```

## Dashboard

While a turn is running, the **Guidance** lane appears under the composer:

- **Send guidance** — a change to the current task. Triaged, then applied at the
  next safe point.
- **Ask a question** — answered from the run's durable state; the plan is unchanged.
- **New task** — captured in the backlog with a **Create task** action; it never
  enters the active run.
- **Approve / Reject / Defer** — required for high-impact, conflicting,
  superseding, irreversible, or completed-work changes.

Every item shows what it was understood as, why policy decided that, which steps
are affected, and (once applied) the plan diff. Rejections are never silent.

## CLI

```bash
nuvira steer                          # prompt for guidance on the active run
nuvira steer <runId> --text "use Postgres instead of SQLite"
nuvira steer --new-task "also build a mobile app"
nuvira steer --question "what is still missing?"
nuvira steer --discuss "why is step 4 blocked?"   # read-only
nuvira steer --list                    # runs with steering state
nuvira steer --status                  # queue + plan + backlog
nuvira steer --approve G-abc123
nuvira steer --reject G-abc123 --note "not this release"
nuvira steer --defer G-abc123
nuvira steer --withdraw G-abc123
```

The CLI works against a detached run: it writes to the same per-run inbox the run
process reads at its next safe point.

## What happens to your input

1. **Receipt** — persisted before acknowledgement; survives a reload or restart.
2. **Triage** — a constrained Change Steward classifies relation, kind, timing,
   impact, confidence, conflicts, and proposes typed plan operations. It has no
   tools and cannot approve or apply anything.
3. **Policy** — deterministic rules decide: apply, defer, answer, backlog, require
   approval, pause/stop, or reject. The model's approval hint can only raise the bar.
4. **Safe point** — accepted changes commit an immutable plan version and reach the
   executor as a bounded directive (never the raw message).
5. **Outcome** — applied with a diff, deferred with a reason, rejected with a
   reason, backlogged with a task action, or stale if the plan moved first.

## Rules you can rely on

- A request to change approval policy, bypass a gate, or extract a secret is
  rejected and logged as a policy-override attempt.
- `stop` ends the run immediately; `pause` ends it at the next safe point.
- A new task is never absorbed into the current run.
- Completed work is never silently deleted. Scope reduction cancels future work;
  invalidating completed work requires approval.
- Low/medium additive work inside the contract applies automatically. High impact,
  conflicts, replacements, and removals need you.
- Every applied change has a version and a diff; every rejection has a reason.

## State and recovery

State lives under `~/.nuvira/memory/steering/runs/<runId>/`. Guidance is durable
before it is acknowledged, so a crashed process resumes with its queue intact. A
lease prevents two processes from writing the same plan; a stale lease expires.
Approval requests expire after 24 hours and become visible deferrals.

Inspect raw state:

```bash
nuvira steer --list
nuvira steer <runId> --status
```

## Rollback

Turn the flag off. No new inbox is read and no plan is mutated. Existing state is
left on disk for inspection; delete a run's directory to remove it.

## Revalidation against the assessment plan (2026-11-09)

The implementation was re-audited against `docs/ASSESSMENT_AND_PLAN_mid-run-steering.md` and the gaps found in the first pass were closed:

- **Crash-interrupted triage** is returned to `received` after five minutes and retried; it no longer stays invisible in `triaging`.
- **Apply is idempotent across a crash.** The plan version records the `changeId`; if the process died between committing the version and marking the change applied, the next safe point adopts that version instead of adding the step twice.
- **Running and completed work are immutable.** `update_step`, `remove_step`, `reorder`, and `set_priority` refuse a running step; reorder/priority accept only pending/blocked steps; completed steps cannot be rewritten or un-completed.
- **High-impact changes are workspace-checkpointed before the plan write.** If the snapshot cannot be taken, the change fails closed instead of applying an irreversible change with no rollback point.
- **Contract amendments are real.** Approved constraints and approved scope changes are appended to the immutable contract, and each new plan version records the current contract version.
- **The Steward sees the contract and recent run events**, not just the plan. Guidance, contract text, and events are redacted before the model call.
- **The executor directive carries acceptance criteria**, so a steering-added step is not just a description.
- **A rejected, stale, or failed item can be sent to the backlog** from the dashboard; no rejection is a dead end.
- **The projection exposes operational metrics**: triage p95, submission-to-apply average, stale rate, approval latency, abandoned approvals, low-confidence count, replans per applied change, and high-impact false accepts.

### Deliberately not built in this pass

These are Phase 4/5 or deployment decisions, not missing control-plane behavior:

- Gateway exposure (the dashboard and CLI are wired; `gateway` is a surface value only).
- SQLite WAL, multi-process query support, or multi-user ownership/RBAC beyond the dashboard's `routing.operate` gate.
- A 100–200 example labeled evaluation set and the no-steering-vs-steering A/B benchmark.
- Token/cost accounting per guidance item (the Steward call does not expose usage to this layer).
- Rate limiting and retention policy beyond the bounded open/applied-change budgets and capped journal/backlog reads.
