# Phase 11 — Distributed Agent Grid (ADG)

## Implementation Specification

| Field | Value |
|---|---|
| Status | Design draft for Phase 5 review; code-validated against `main`; no code changed |
| Version | 1.0 |
| Depends on | Phase 5 lifecycle runner, artifact store, gate engine, deliver stage |
| Hard prerequisites | Stage seam, worktree-enforced writes, durable run store, signed artifact envelopes |
| Parent plan | [`ENHANCE_CUSTOM_CAPABILITY.md`](./ENHANCE_CUSTOM_CAPABILITY.md) |
| Strategy companion | [`PHASE11_ADG_STRATEGY.md`](./PHASE11_ADG_STRATEGY.md) |
| Review and comparison | [`PHASE11_ADG_REVIEW.md`](./PHASE11_ADG_REVIEW.md) |
| Company model (departments, node management, CIO layer) | [`PHASE11_ENTERPRISE_COMPANY_MODEL.md`](./PHASE11_ENTERPRISE_COMPANY_MODEL.md) |
| Self-improvement feasibility | [`PHASE11_SELF_IMPROVEMENT.md`](./PHASE11_SELF_IMPROVEMENT.md) |
| Decision log (D1–D15, O1–O8) | [`PHASE11_DECISIONS.md`](./PHASE11_DECISIONS.md) |
| Stage 1 build plan and seam design | [`PHASE11_STAGE1_PLAN.md`](./PHASE11_STAGE1_PLAN.md) |
| Audience | Runtime, platform, security, Git/delivery, dashboard, enterprise engineering |
| Scope | Specification only. This document changes no runtime code. |

---

## 0. Document contract

This document specifies how one Agent-Nuvira instance (the **Prime**) plans a program of work, decomposes it into contract-bound packets, leases those packets to other machines (the **Grid**), reviews and integrates the returned patches, and keeps every governance invariant that Phase 5 establishes for a single run.

It is deliberately narrower than the Copilot draft in scope and stricter in mechanism. Three rules govern it:

1. **The coding lifecycle is not extended.** Phase 5 owns `intake → inspect → plan → implement → test → review → verify → deliver`. Phase 11 does not add `decompose`, `allocate` or `integrate` to that graph. It adds a *separate program-level state machine* whose leaves are Phase 5 runs. A distributed packet is one lifecycle run on another machine, not a new stage vocabulary.
2. **No second organizational runtime.** Department, team, and role are policy scopes and capability selectors. They resolve into packet *requirements*. They are not new execution objects with their own authority semantics.
3. **Authority is structural, not prompted.** "Workers never merge" is a property of which credential exists on which machine and which process can advance the integration branch — not an instruction in a system prompt.

Where this document conflicts with the parent plan, this document wins for Phase 11. Where it conflicts with the Phase 5 spec on lifecycle semantics, Phase 5 wins.

### 0.1 What this document is not

- Not a claim that 500-node operation is ready. §21 sets the v1 target at 20–30 nodes and shows why.
- Not a replacement for Phase 5. §3 lists the four Phase 5 capabilities this phase cannot start without.
- Not an approval to write code. §24 lists the decisions that must be made first.

---

## 1. Objective

Let a single operator turn 20–30 heterogeneous machines — each with its own providers, models, and tool availability — into a governed delivery grid that completes a multi-week program of work with:

- a plan produced and owned by Prime;
- work decomposed into independently integrable packets;
- execution outsourced to nodes with the right capabilities;
- review performed by someone other than the producer;
- merge, tag, and release authority retained by Prime;
- an auditable record that a CIO can read without trusting any model's summary.

The measurable objective: **a 3-workstream program delivered in one-third the wall-clock time of serial execution on Prime alone, with zero governance-invariant violations and zero silent false-successes.**

"Silent false-success" is called out because the current codebase has a path that can produce one (§3.5). A grid that is fast and lies is worse than a slow one.

---

## 2. Success definition

Phase 11 is successful when all of the following are demonstrable, not asserted.

| # | Criterion | Measurement |
|---|---|---|
| S1 | Program planning | A 40–80 packet program is planned, dependency-validated, and costed before any node executes |
| S2 | Deterministic decomposition | The same program spec produces the same packet DAG (stable ids, stable order) across two runs |
| S3 | Capability routing | ≥95% of packets land on a node that satisfies every hard requirement on first attempt |
| S4 | Concurrency | ≥12 packets execute concurrently across 20 nodes without corrupting any worktree |
| S5 | Throughput | ≥6 merged packets/hour sustained over a 4-hour window at 20 nodes |
| S6 | Integration integrity | Every merged packet has a passing test artifact and a review artifact from a non-producing node |
| S7 | Conflict containment | Merge-conflict rate <10% of packets; every conflict is detectable *before* merge |
| S8 | Failure containment | Killing 5 of 20 nodes mid-program costs <15% of remaining wall-clock and no data loss |
| S9 | Duplicate-effect safety | Lease expiry + fencing prevents a double merge or double release under induced partition |
| S10 | Authority | No worker credential can push to the protected branch, tag, or release |
| S11 | Audit | Every packet decision replays from the ledger alone, with evidence hashes |
| S12 | Cost | Program cost is attributable per packet, per node, per model, within 5% of provider billing |
| S13 | Resume | A Prime restart resumes an in-flight program without re-running completed packets |
| S14 | Honest status | No packet reports `delivered` without a delivery artifact and a merge commit sha |

S5 and S8 are the two that cannot be faked. They are the acceptance tests for the entire phase.

---

## 3. Baseline: what exists today, verified in code

This section is the reason this plan is an upgrade rather than a reimplementation. Each row is a file that already exists and works. The "gap" column is what Phase 11 must add — not replace.

### 3.1 Reusable as-is

| Capability | Where | Why it is sufficient |
|---|---|---|
| Authenticated node transport | `src/federation/server.ts`, `client.ts` | HTTP + SSE, pre-shared secret or OIDC, session tokens, constant-time compare, cancel, health |
| Node identity and capability list | `FederationConfig` in `src/federation/protocol.ts` | `nodeId`, `capabilities[]`, `host`, `port`, `maxConcurrentTasks`, `taskTimeoutMs` |
| External interop card | `src/federation/a2a-types.ts` | `AgentCard` with capabilities, skills, JSON schemas, endpoints; A2A v1.0 |
| OIDC identity seam | `src/enterprise/rbac.ts` (`OidcAdapter`), `src/federation/oidc-adapter.ts` | Verified `sub`/`groups`; already wired into federation handshake |
| Isolated worktree | `src/tools/worktree.ts` | Real `git worktree add`, base sha, branch, dirty-source measurement, diff, teardown, refusal instead of degradation |
| In-process bounded fan-out | `src/agents/fanout-scheduler.ts` | Live promotion as lanes free; exclusive tasks never admitted |
| Hash-chained audit | `src/enterprise/audit-chain.ts` | Append, verify, rotation-safe re-chain, CEF export for SIEM |
| Durable project registry pattern | `src/config/workspace.ts` | `node:sqlite` `DatabaseSync` with JSON fallback to copy |
| Container execution | `src/sandbox/manager.ts`, `images.ts` | Docker-based sandbox lifecycle |
| CLI surface | `src/cli/federation.ts`, `cli-program.ts` | `federation start/connect/run/health`, `a2a start/discover/run` |

### 3.2 Reusable with extension

| Capability | Where | What must change |
|---|---|---|
| Task delegation | `server.ts::handleTaskDelegation` | Currently takes `goal` + `agentType` and runs a whole orchestration. Must accept a `WorkPacket` with artifact refs, budget, and expected output contract |
| Task status | `a2a-server.ts` task map | In-memory `Map`; must become durable and survive restart |
| Capability advertisement | `FederationConfig.capabilities: string[]` | Flat string list; must become a structured descriptor (models, tools, slots, cost class, trust tier, health) |
| Review workflow | `src/team/review.ts` | Bundles are local JSON; `mergeReview()` writes files into `cwd`. Must become node-attributed review artifacts and a real Git merge |
| Event stream | `src/observability/event-bus.ts` | In-memory capped history; must feed a durable program event log |

### 3.3 Must be built new

| Capability | Why it cannot be reused |
|---|---|
| Program planner and packet DAG | Nothing today decomposes beyond `stepPlan`'s 2–8 flat tasks for one run |
| Durable broker with leases | `runningTasks` is a `Map`; no lease, no retry, no dead-letter, no fairness |
| Merge queue with fencing | No merge authority exists; `team/review.ts` applies file contents directly |
| Node registry with health | No heartbeat beyond a synchronous health request |
| Artifact exchange with classification | Federation returns `outputFiles` base64 in a task result; no content addressing, no policy |
| Review federation | Review exists locally with no independence guarantee |
| Program ledger and dashboard | No program, packet, attempt, or lease records anywhere |

### 3.4 Structural gaps that block Phase 11

These are Phase 5 obligations. Phase 11 cannot ship without them.

| Gap | Evidence | Consequence for a grid |
|---|---|---|
| No stage seam | `Orchestrator.execute()` is whole-run; `executePipeline` is private | Cannot gate `after:plan` before implementation on a worker |
| Writes hit the live tree | `TaskExecutionPipeline.applyChanges()` writes to `workingDirectory` | A remote worker would edit whatever tree it was pointed at |
| No durable run store | `checkpoint-store.ts` is best-effort JSON | Cannot resume a 6-hour packet after a crash |
| Gate is scoring, not policy | `verify-module.ts` returns thresholded `VerificationResult` | A worker's "passed" cannot be trusted as a delivery gate |

### 3.5 Two defects to fix before any grid work

**F1 — The polling fallback can report success without a result.** In `client.ts::delegateWithPolling`, after posting a task that was accepted, the loop calls `getHealth()` and returns `{ success: true, summary: 'Task ... completed' }` when `health.activeTasks === 0`. It never fetches the task result. With more than one task in flight, or a task that failed, this returns a false success. A grid amplifies this: 20 nodes × 50 packets is 1,000 chances to claim delivery of work that never happened.

**F2 — `maxConcurrentTasks` is advertised but not enforced.** `handleTaskDelegation(req, res, _config)` undoes the parameter and never compares `runningTasks.size` to `config.maxConcurrentTasks`. A node that advertises 4 slots will happily accept 40 tasks and thrash its own memory and model rate limits. §9.3 makes admission control a broker responsibility and a node-side hard limit.

Both are small fixes with large governance value, and both belong in the Phase 5 hardening pass, not in Phase 11.

---

## 4. Architecture

### 4.1 Four planes

```text
┌──────────────────────────── CONTROL PLANE (Prime) ────────────────────────────┐
│  Program Planner   →  Packet DAG  →  Broker/Scheduler  →  Merge Coordinator   │
│  Node Registry        Policy       Lease Manager          Release Authority    │
└───────────┬───────────────────────────────┬───────────────────────────┬───────┘
            │ work packets (federated)      │ evidence                  │ merges
            ▼                               ▼                           ▼
┌──────────────────── EXECUTION PLANE ────────────────┐   ┌────── EVIDENCE PLANE ──────┐
│  Node A (laptop, qwen)    Node B (laptop, claude)   │   │ Content-addressed artifacts│
│   worktree → Phase 5 run → patch artifact           │   │ Hash-chained ledger        │
│  Node C (GPU, local 70B)  Node D (cloud burst)      │   │ Cost records, CEF export   │
└─────────────────────────────────────────────────────┘   └────────────────────────────┘
            │
            ▼
┌──────────────────────────── GOVERNANCE PLANE ─────────────────────────────────┐
│  Authority lattice · scoped capability tokens · policy bundles · approvals    │
│  Review independence · gate enforcement · waiver registry · retention         │
└───────────────────────────────────────────────────────────────────────────────┘
```

The four planes are a description of responsibility, not four deployables. Prime runs the control, evidence, and governance planes. Nodes run the execution plane plus a thin reporter.

### 4.2 Object model

```text
Program            one outcome with a deadline and a budget
 └ Project         one deliverable inside the program (may map 1:1 to a repo)
    └ Workstream   a capability pool's slice (backend, frontend, QA, security)
       └ WorkPacket    the unit of lease, review, and merge
          └ Attempt     one execution of a packet on one node
             └ LifecycleRun   Phase 5 run (unchanged contract)
```

The critical structural decision: **`WorkPacket` is the unit of distribution, and it maps to exactly one Phase 5 lifecycle run.** Not a stage, not a whole program. That keeps Phase 5's protected graph intact and gives every distributed unit the same gate semantics as a local run.

### 4.3 Program state machine

```text
draft → planned → approved → executing → integrating → verifying → delivered
                      │           │            │
                      │           ├→ degraded  (nodes lost, still deliverable)
                      │           └→ blocked   (gate or dependency)
                      └→ cancelled
```

`degraded` is a first-class state, not an error path. A 20-laptop grid on home Wi-Fi will lose nodes; the program must say so and continue rather than fail the run.

### 4.4 Deployment topologies

| Topology | Nodes | Transport | Notes |
|---|---|---|---|
| LAN / same office | 5–30 | Federation over private IP, shared secret rotated per program | The primary v1 target |
| Tailscale / overlay | 5–50 | Federation over overlay network | No inbound port exposure; recommended for remote teams |
| Hybrid burst | 20 + N cloud | Federation to cloud workers, egress-only | Cloud workers get `public` classification packets only |
| Air-gapped | 5–30 | Federation on isolated subnet, local model providers, local Git mirror | Requires offline policy bundle and artifact mirror |
| Federated orgs | 2+ Primes | A2A between Primes | Phase 15 horizon; only the AgentCard contract is committed here |

---

## 5. Terminology

Terms are chosen to avoid collision with Phase 5 and with the Copilot draft.

| Term | Definition | Not to be confused with |
|---|---|---|
| Prime | The control-plane instance. Plans, schedules, reviews, merges, releases | A "manager agent" persona |
| Node | A machine running the node runtime and advertising capabilities | A specific model or provider |
| Worker | A node currently holding a lease | A permanent role |
| WorkPacket | Contract-bound unit of work: inputs, outputs, acceptance, budget | A Phase 5 task or stage |
| Attempt | One execution of a packet; retries create new attempts | A retry of a merge |
| Lease | Time-bounded exclusive right to execute a packet, with a fencing token | A lock on a file |
| Fencing token | Monotonic integer; stale holders are rejected at the merge boundary | A session token |
| Patch artifact | Immutable diff + base sha + manifest produced by an attempt | A Git branch |
| Integration branch | Prime-owned branch where accepted patches land | A worker branch |
| Department | A policy scope that groups capabilities, standards, and reviewers | A runtime process |
| Authority | A named right (review, integrate, release) held by a principal | A role string in a prompt |
| Program ledger | Append-only, hash-chained record of every program decision | The event bus |

---

## 6. Organizational model, correctly scoped

The Copilot draft proposes `Organization → Division → Team → Agent → Capability` as runtime abstractions. That is the single largest architectural mistake in it, because it creates a second authority model beside Phase 5's artifact and gate model.

This plan keeps the organizational *language* — it is genuinely useful for operators and buyers — and maps it onto existing or already-planned primitives.

| Organizational concept | Runtime reality | Where it lives |
|---|---|---|
| Organization | Tenant boundary: policy bundle, trust roots, artifact namespace | Governance plane |
| Division | Program grouping and budget envelope | Program record |
| Department | A policy scope + a capability pool + a reviewer pool | `department` record referenced by packets |
| Team | A named subset of a department used for scheduling affinity | Tag on node and packet |
| Role | A capability selector plus a review obligation | Packet `requiredCapabilities` |
| Agent | A Phase 5 capability binding (existing `module-registry`, plugin, or built-in) | Phase 5 |
| Capability | Existing capability descriptor | Phase 5 |

Consequences:

- Creating a "QA Department" creates **no new agent type**. It creates a policy scope with: required test evidence, reviewer pool, gate set, and node tag `qa`.
- "Security Department owns threat models" is enforced by a gate on `implement` packets that require a `threat-model` artifact when the packet's `riskClass` is `high`. Not by a separate security agent process.
- Department membership is data, not code. An operator can define a department in a policy file without a release.

This is what makes the model enterprise-grade rather than a metaphor: every organizational noun resolves to an enforceable artifact, gate, or selector.

---

## 7. Work decomposition

Decomposition quality decides whether the grid works. Twenty nodes running a bad decomposition produce twenty conflicting patches faster than one node produces a good one.

### 7.1 WorkPacket contract

```jsonc
{
  "schemaVersion": 1,
  "id": "pkt_01J8Z3K4Q7",
  "programId": "prg_01J8Z",
  "projectId": "github:acme/erp",
  "workstream": "backend/inventory",
  "department": "engineering",
  "objective": "Implement stock reservation endpoint with optimistic locking",
  "riskClass": "medium",              // low | medium | high | critical
  "inputs": [
    { "artifact": "artifact://sha256/ab12…", "type": "plan", "required": true },
    { "artifact": "artifact://sha256/cd34…", "type": "inspection", "required": true }
  ],
  "outputContract": {
    "type": "patch",
    "requiredPaths": ["src/inventory/**", "tests/inventory/**"],
    "forbiddenPaths": ["src/shared/types.ts", "package.json", "*.lock"],
    "mustInclude": ["test-result"],
    "interfaceFreeze": ["openapi/inventory.yaml"]
  },
  "acceptanceCriteria": [
    "POST /inventory/reserve returns 409 on version conflict",
    "reservation is idempotent for the same Idempotency-Key",
    "unit tests cover concurrent reserve race"
  ],
  "requiredCapabilities": ["typescript", "node", "postgres", "test-runner"],
  "preferredModels": ["claude-sonnet", "qwen3-coder"],
  "resourceClass": "standard",        // standard | heavy-cpu | gpu | network-restricted
  "budget": { "maxUsd": 4.00, "maxWallClockMin": 90, "maxAttempts": 3 },
  "dependencies": ["pkt_01J8Z3K4P1"],
  "exclusivity": { "paths": ["src/inventory/schema.ts"], "mode": "write" },
  "review": { "independent": true, "minReviewers": 1, "diversity": "different-model-family" },
  "merge": { "strategy": "squash", "requiresGreenCi": true },
  "classification": "internal"        // public | internal | confidential | restricted
}
```

Field rules that matter:

- `outputContract.forbiddenPaths` is enforced **after** the patch returns, and a violation is a `block`, not a warning. This is what prevents ten workers from editing `shared/types.ts`.
- `interfaceFreeze` lists contract files that may be *read* but not *modified* by the packet. If a packet genuinely needs to change a frozen interface, the planner must create a separate `interface` packet that lands first.
- `exclusivity.paths` creates advisory path locks (§10.3).
- `budget.maxAttempts` bounds cost amplification from a failing node.
- `classification` drives egress policy (§8.4).

### 7.2 Decomposition rules

The planner must produce packets that satisfy all of the following. The compiler rejects a DAG that violates any of them.

| Rule | Statement | Failure it prevents |
|---|---|---|
| R1 | Every packet has exactly one primary deliverable | Vague packets that never finish |
| R2 | Every packet's output is independently integrable | Monolithic patches that cannot be merged alone |
| R3 | No two packets write the same path without an ordering edge | Merge explosion |
| R4 | No packet depends on more than 4 upstream artifacts | Context explosion at the worker |
| R5 | Every packet fits one lifecycle run | Stage-seam violation |
| R6 | Total packets ≤ 120 per program; larger programs split into projects | Control-plane overload |
| R7 | Every packet is reviewable in under 400 changed lines | Unreviewable patches |
| R8 | Dependency depth ≤ 6 | Long serial chains that erase parallelism |
| R9 | Critical-path packets are identified and scheduled first | Latency |
| R10 | Each packet names concrete acceptance criteria | Gate ambiguity |

R7 is the one Copilot's plan omits entirely, and it is the difference between a review that means something and a rubber stamp. A 1,200-line patch reviewed by another model in 40 seconds is not a review.

### 7.3 Decomposition procedure

```text
1  intake program intent, constraints, deadline, budget
2  produce capability map: what the codebase must gain
3  derive interface boundaries first (APIs, schemas, events, shared types)
4  emit interface-freeze packets for every boundary change
5  emit implementation packets behind each boundary
6  emit test packets derived from acceptance criteria, not from implementation
7  emit review/security packets scoped to risk class
8  emit integration packets for cross-cutting wiring
9  compute DAG, critical path, cost estimate, and node-hour demand
10 validate against R1–R10; reject with reasons, never silently repair
```

Step 6 is deliberate: tests are derived from the acceptance criteria *before* implementation packets exist, so a worker cannot write a test that merely mirrors its own implementation.

Step 10 rejects rather than repairs. A planner that silently "fixes" a bad decomposition hides the one signal that says the program is not ready.

### 7.4 Anti-patterns the planner must refuse

| Anti-pattern | Why it fails | Required response |
|---|---|---|
| "Build the frontend" as one packet | Unreviewable, unmergeable | Split by route/feature with frozen API contract |
| Packets that each need the whole repo | Context explosion, cost blowup | Add an inspection artifact shared as input |
| Parallel packets touching one migration file | Guaranteed conflict | Serialize with an ordering edge |
| Test packets that import implementation | Tests mirror bugs | Derive from acceptance criteria |
| A packet with no acceptance criteria | Gate cannot decide | Reject at plan time |
| Ten packets depending on one unbuilt foundation | Idle grid | Foundation packet first, then fan out |

---

## 8. Node model

### 8.1 Node descriptor

Extends `FederationConfig` rather than replacing it, so an existing federation node can join the grid by advertising more.

```jsonc
{
  "schemaVersion": 1,
  "nodeId": "laptop-07",
  "displayName": "Dheeraj's M3 Max",
  "primeUrl": "https://prime.lan:8375",
  "identity": { "org": "acme", "owner": "dheeraj", "trustTier": "managed" },
  "hardware": { "cpuCores": 14, "memoryGb": 36, "gpu": "m3-max-40c", "diskFreeGb": 220 },
  "models": [
    { "provider": "anthropic", "model": "claude-sonnet", "contextTokens": 200000, "costClass": "high" },
    { "provider": "ollama",   "model": "qwen3-coder",  "contextTokens": 128000, "costClass": "free" }
  ],
  "capabilities": ["typescript", "node", "react", "test-runner", "playwright"],
  "tools": { "git": true, "docker": true, "node": "22.11.0", "python": "3.12" },
  "slots": { "maxConcurrent": 3, "maxHeavyConcurrent": 1 },
  "network": { "canReachGit": true, "canReachProviders": ["anthropic", "ollama"], "egressPolicy": "restricted" },
  "classificationCeiling": "confidential",
  "labels": ["department:engineering", "team:frontend", "shift:night"],
  "policyVersion": "pol_2026_11_01",
  "runtimeVersion": "1.59.0"
}
```

`trustTier` is the load-bearing field:

| Tier | Meaning | Allowed packets |
|---|---|---|
| `managed` | Org-controlled machine, policy enforced at boot | All classifications up to ceiling |
| `byod` | Operator's personal laptop, enrolled with consent | `public`, `internal` only |
| `ephemeral` | Cloud burst, destroyed after program | `public` only |
| `quarantined` | Failed health or policy drift | No new leases; in-flight drained |

### 8.2 Advertisement and heartbeat

```text
node → prime   POST /grid/node/register   descriptor + signed enrollment token
prime → node   201 { nodeId, policyVersion, leasePublicKey }
node → prime   POST /grid/node/heartbeat  every 10s: load, slotsFree, activeLeases, diskFree
prime → node   200 { leases: [...], policyVersion }
```

Heartbeat reuses the existing federation auth (secret or OIDC) and adds a signed body. Three consecutive missed heartbeats (30s) mark the node `suspect`; six (60s) mark it `unreachable` and release its leases after the grace window in §12.4.

Health is not a boolean. A node with 0 free slots is healthy but not schedulable; a node at 98% disk is schedulable for read-only packets only.

### 8.3 Capability matching

A packet is schedulable on a node when all hard constraints hold:

```text
hard:  requiredCapabilities ⊆ node.capabilities
hard:  classification ≤ min(node.classificationCeiling, org policy)
hard:  node.trustTier permits packet.classification
hard:  node.tools satisfies packet tool requirements
hard:  packet.resourceClass ≤ node capacity class
hard:  node.policyVersion == prime.policyVersion  (or explicitly compatible)
soft:  preferredModels ∩ node.models
soft:  locality (same LAN, warm caches)
soft:  cost class (free local > metered cloud, when quality allows)
soft:  current queue depth
soft:  historical success rate for this capability tag
```

Scoring is deterministic and auditable:

```text
score = 100
      - 20 * (queueDepth / maxConcurrent)
      - 15 * (1 - successRateForTag)
      - 10 * costRank
      -  5 * (1 - modelPreferenceMatch)
      +  5 * localityBonus
tie-break: nodeId ascending (stable, reproducible)
```

The tie-break is not cosmetic. Non-deterministic placement makes incident replay impossible; a stable tie-break means "why did packet X go to node 7" always has the same answer.

### 8.4 Classification and egress

The single most under-specified area in the Copilot draft.

| Classification | May execute on | Artifact egress | Model providers allowed |
|---|---|---|---|
| `public` | Any tier including ephemeral | Full artifact | Any |
| `internal` | `managed`, `byod` | Redacted metadata only on `byod` | Org-approved list |
| `confidential` | `managed` only | Encrypted, reference-only | Local models + approved cloud |
| `restricted` | `managed` + dedicated pool | Reference-only, no payload egress | Local models only |

Rules:

- A packet's classification is `max(inputs.classification, outputContract.classification, project.default)`.
- Artifacts crossing a node boundary are re-classified at the boundary; a worker cannot downgrade.
- Credentials never cross. Each packet gets a scoped token minted by Prime (§13.2) with a TTL equal to the lease plus 60 seconds.
- Provider selection is constrained by classification *before* cost optimization. A `restricted` packet never routes to a cloud model because it was cheaper.

---

## 9. Broker and scheduler

### 9.1 Why the broker is new

`federation/server.ts` tracks work in `const runningTasks = new Map()`. That is correct for a demo and wrong for a program: a restart loses every in-flight task, there is no retry, no priority, no fairness, and no way to ask "what is queued" from a second process.

The broker is a durable component in Prime backed by the lifecycle database pattern Phase 5 already establishes.

### 9.2 Packet lifecycle

```text
queued → leased → running → submitted → reviewing → accepted → integrating
   │        │         │          │           │           │           │
   │        │         │          │           │           │           └→ merged
   │        │         │          │           │           └→ changes-requested → queued (new attempt)
   │        │         │          │           └→ rejected → queued (new attempt)
   │        │         │          └→ invalid (contract violation) → blocked
   │        │         └→ failed / lease-expired → queued (attempt++) or dead-letter
   │        └→ lease-revoked → queued
   └→ cancelled
```

State transitions are persisted with the reason, actor, and evidence hash. No transition is inferred from a log line.

### 9.3 Lease protocol

```text
broker:   SELECT packet WHERE state='queued' AND deps_satisfied
          FOR UPDATE SKIP LOCKED  (single writer)
          UPDATE packet SET state='leased', node=?, leaseId=?, fencing=next_fencing()
          WHERE id=? AND state='queued' AND fencing=expected
node:     POST /grid/packet/:id/accept  { leaseId, fencing }
broker:   verify leaseId + fencing matches; start TTL timer
node:     POST /grid/packet/:id/heartbeat  every 20s
broker:   extend TTL; if missed for TTL → revoke, increment fencing, requeue
```

Invariants:

- **L1** A packet has at most one active lease.
- **L2** Fencing tokens are strictly increasing per packet.
- **L3** Any write to the integration branch is rejected unless the fencing token is the current head for that packet.
- **L4** Lease TTL is at least 3× the packet's expected duration, capped at 90 minutes.
- **L5** Revoking a lease never deletes an artifact the attempt produced; it marks it `orphaned` and retains it for audit.

L3 is the bug that kills naive distributed systems: two workers both believe they hold packet X after a partition, both produce valid patches, both get merged. Fencing at the merge boundary is the only reliable fix.

### 9.4 Scheduling policy

```text
priority(packet) = criticalPathWeight * 50
                 + dependencyFanout  * 20
                 + riskClassWeight   * 10
                 - ageBonus          * 0.5/min      (anti-starvation)
```

Two modes:

- **Latency mode** (default): critical-path-first, maximize parallel width, allow more nodes than the DAG's width.
- **Cost mode**: prefer free local models, batch small packets together, accept longer wall clock.

Mode is a program-level setting, not a per-packet decision, so the operator can reason about spend.

### 9.5 Fairness

With multiple programs on one grid, a naive priority scheduler starves the small program. Required: per-program weighted fair queuing with a floor of one slot per active program, and a hard cap of 70% of nodes for any single program.

### 9.6 Admission control at the node

F2 from §3.5 is fixed here as well as in the broker. A node rejects a lease when `activeLeases >= slots.maxConcurrent` with a `429` and a retry hint. The broker treats a rejection as a placement signal, not a failure. Advertised capacity that is not enforced is a lie the scheduler will believe.

---

## 10. Distributed worktrees and Git control

### 10.1 Per-packet worktree

Every attempt runs in its own worktree created by the existing primitive:

```ts
createIsolatedWorktree({ repoCwd, label: `pkt-${packet.id}-a${attempt}` })
```

Properties already guaranteed by `src/tools/worktree.ts` and relied on here:

- real second checkout of the same repository;
- base pinned to a commit sha, recorded in the patch artifact;
- `sourceDirty` measured and reported, so a worker knows the source tree had uncommitted work it cannot see;
- refusal rather than silent degradation when isolation is impossible;
- `MEASURE_SCOPE` excludes the symlinked `node_modules` so a one-file change does not report two.

New requirements on top:

| Requirement | Reason |
|---|---|
| Base sha must equal the packet's `baseCommit`, not the node's `HEAD` | A node with stale code would produce unmergeable patches |
| The worktree must be created from a **bare mirror** fetched by the node, not from a local dev clone | Prevents a worker from inheriting a developer's uncommitted state |
| `NUVIRA_ISOLATE=1` must be mandatory, not optional, for grid packets | A packet that runs in the live tree is unauditable |
| Worktree is always discarded after patch extraction, even on failure | Disk exhaustion across 20 laptops |
| Patch is extracted *before* teardown | Teardown destroys the evidence; this order is not a detail |

### 10.2 What a worker returns

Workers do not push branches. They return a **patch artifact**:

```jsonc
{
  "type": "patch",
  "baseCommit": "9f2c…",
  "branch": "nuvira/prg-01J8/pkt-01J8Z/a1",
  "changedFiles": [{ "path": "src/inventory/reserve.ts", "status": "created", "additions": 84 }],
  "diffUri": "artifact://sha256/77aa…",
  "testRef": "artifact://sha256/91bc…",
  "producer": { "nodeId": "laptop-07", "capabilityId": "builtin/implementer", "model": "qwen3-coder" },
  "fencing": 3,
  "leaseId": "lease_01J8…",
  "startedAt": "…", "endedAt": "…",
  "cost": { "usd": 0.42, "tokensIn": 184000, "tokensOut": 9200 }
}
```

Why patch artifacts and not branches:

| Branch push | Patch artifact |
|---|---|
| Requires write credentials on every node | Node needs no repo write access |
| Conflict discovered at merge time, after CI ran on a stale base | Conflict detectable at submit time against the recorded base |
| Branch namespace pollution across 1,000 attempts | Namespaced, garbage-collected |
| Hard to bind a branch to a lease/fencing token | Fencing is a field in the artifact |
| A compromised node can push anything | A compromised node can only submit a patch for review |

The tradeoff: patches must be applied by Prime, so Prime does the CPU work of integration. At 20 nodes and ~10 packets/hour this is negligible. At 200 nodes it becomes the bottleneck, which is one reason §21 stops at 30 for v1.

### 10.3 Path locks

```text
lock = { paths: [...], packetId, mode: 'read' | 'write', leaseId, expiresAt }
```

- A `write` lock is exclusive across the program.
- A `read` lock is shared.
- Locks are **advisory at scheduling time** and **enforced at merge time**. A packet that acquires a conflicting write lock is not scheduled until the holder releases.
- Locks are not Git locks. They are program-level, in the broker, and they prevent the conflict rather than resolving it.
- Deadlock prevention: locks are requested in sorted path order and a packet may hold at most 3 locks.

### 10.4 Merge coordinator

The merge coordinator is the only component with write access to the protected branch.

```text
for each accepted packet in integration order:
  1 verify fencing token is current
  2 verify review artifact exists, reviewer != producer, verdict != block
  3 verify test artifact exists and is green on the recorded base
  4 re-fetch integration branch head
  5 if head != packet.baseCommit → rebase patch; re-run affected tests
  6 if rebase conflicts → mark 'conflict', return to author node with conflict artifact
  7 apply patch to a scratch worktree on the integration branch
  8 run the program's integration test set (not the packet's own tests only)
  9 if green → merge with declared strategy, record merge sha
 10 else → revert scratch, mark 'integration-failed', requeue with evidence
```

Step 8 is where most naive designs fail: a packet's own tests passing says nothing about whether it broke a sibling packet that merged five minutes earlier. The integration test set is the program's real gate.

Step 5's re-run requirement means rebases are expensive. That is why R3 (ordering edges) and path locks exist: to make rebases rare rather than to make them fast.

### 10.5 Release authority

| Action | Who | Mechanism |
|---|---|---|
| Commit to integration branch | Merge coordinator | Sole holder of a deploy key with write access |
| Tag a release | Release authority | Separate credential, requires program approval artifact |
| Push to protected branch | Nobody automated | Branch protection; human approval required |
| Deploy | Out of scope for Phase 11 | Phase 5 `deliver` + existing CI |

The worker credential is a read-only token plus the ability to POST a patch. That is the entire enforcement of "workers never merge".

---

## 11. Artifact mesh

### 11.1 Reuse the Phase 5 envelope

Artifacts crossing nodes are the same `ArtifactEnvelope` Phase 5 defines, with two added fields:

```jsonc
{
  "transport": { "originNode": "laptop-07", "classification": "internal", "egress": "redacted" },
  "retention": { "until": "2027-05-01", "policy": "program" }
}
```

No new artifact type is required except `patch` (already in Phase 5) and `program-plan`, `packet-result`, `merge-record`.

### 11.2 By reference, not by value

The current federation `TaskResult.outputFiles` is base64 file content inline. At grid scale that is wrong: it doubles memory, defeats content addressing, and makes redaction impossible.

Rules:

| Artifact size | Transport |
|---|---|
| < 64 KB | Inline in the result envelope |
| 64 KB – 8 MB | Upload to Prime artifact endpoint, return URI |
| > 8 MB | Chunked upload, resumable, URI only |
| Any size, `confidential`+ | URI + encrypted payload, key held by Prime |

### 11.3 What may cross a node boundary

| May cross | Must never cross |
|---|---|
| Patch diffs, test results, review findings | `.env`, provider keys, SSH keys, tokens |
| Plan and inspection artifacts (redacted) | Raw prompt transcripts containing secrets |
| Build logs (scrubbed) | Full repository clones beyond the packet scope |
| Cost records | Other programs' artifacts |
| Node capability descriptors | Customer PII not required by the packet |

Scrubbing reuses the existing `safeLine` redaction from `src/enterprise/secrets.ts` before any artifact is persisted.

### 11.4 Integrity

- Every artifact is content-addressed by sha256 of canonical JSON (reuse `canonicalJson`).
- The patch artifact hash is recorded in the ledger before the merge coordinator reads it.
- A hash mismatch at merge time is a `block`, never a warning. This catches both corruption and tampering.
- Artifact availability is checked at submit time; a merge never fails because an artifact was garbage-collected.

---

## 12. Reliability and failure

### 12.1 Failure taxonomy

| Failure | Detection | Response | Invariant preserved |
|---|---|---|---|
| Node crash | Missed heartbeats | Lease expires, requeue, fencing++ | No duplicate merge |
| Node network partition | Heartbeat gap | Same, after grace window | Same |
| Prime crash | Process supervision | Restart, resume from ledger | No re-run of completed packets |
| Model provider outage | Error rate spike | Retry on alternate node/model, then requeue | Budget respected |
| Tool failure (git, docker) | Attempt error | Node marked degraded for that capability | Placement avoids it |
| Corrupt patch | Hash mismatch | Reject, requeue, alert | Nothing corrupt merges |
| Merge conflict | Rebase step | Conflict artifact returned to author | No force-push |
| Split-brain Prime | Two leaders | Fencing at DB; second leader refuses to merge | Single writer |
| Clock skew | Heartbeat timestamps | Use Prime time for all TTLs | Lease validity |
| Artifact store full | Write failure | Backpressure: stop leasing | No silent loss |
| Queue poisoning | Repeated identical failure | Dead-letter after `maxAttempts`, page operator | Cost bound |
| Review collusion | Seeded-defect calibration misses | Reviewer removed from pool, re-review | Quality |

### 12.2 Delivery semantics

The grid provides **at-least-once execution with effectively-once effects.**

- Execution may happen twice (lease expiry during a slow attempt).
- Effects are made once by: content-addressed artifacts (identical output dedupes), fencing at merge (stale attempt rejected), and idempotent merge (already-merged sha is a no-op).
- A packet's `attempt` counter is incremented on every lease grant, so duplicates are visible, never silent.

### 12.3 Resume

Program state is durable per packet, not per program:

```text
Prime restart → load program → load packets
             → for each packet: state, attempt, artifacts, lease
             → running + lease valid?  wait
             → running + lease expired? revoke, requeue
             → queued? schedule
             → merged? skip
```

Nothing is re-executed that has a merge record. Nothing is assumed complete because a log line said so.

### 12.4 Grace windows

| Event | Grace | Rationale |
|---|---|---|
| Heartbeat missed | 30s | Transient Wi-Fi |
| Node suspect | 60s | No new leases |
| Node unreachable | 120s | Release leases, requeue |
| Lease TTL | 3× expected, max 90 min | Long builds |
| Merge lock | 10 min | Prevents stuck coordinator |

### 12.5 Degraded operation

When available nodes drop below the DAG's critical width:

- continue with the packets that can run;
- report `degraded` with the lost capacity and the projected slip;
- never re-plan silently;
- if the program's deadline becomes infeasible, emit a decision request to the operator with three options: extend deadline, cut scope, add nodes.

---

## 13. Governance and authority

### 13.1 Authority lattice

```text
Human Approver
   └ Release Authority      (tag, release, protected branch)
        └ Integrator        (integration branch, merge)
             └ Reviewer     (verdict on a packet)
                  └ Worker  (produce a patch)
```

A principal may hold multiple authorities but never the same authority over its own output.

### 13.2 Scoped credentials

| Principal | Credential | Scope | TTL |
|---|---|---|---|
| Node | Enrollment token | Register, heartbeat, accept lease | Program |
| Worker attempt | Capability token | Read packet inputs, write own artifacts, no repo write | Lease + 60s |
| Reviewer | Review token | Read patch + tests, write review artifact | Review TTL |
| Integrator | Deploy key | Write integration branch only | Program |
| Release | Release key | Tag + push tags | Single release |

The capability token is the mechanism behind "workers cannot review their own outputs": a worker token has no `review.write` scope for its own packet id. That is a check in the token's claims, not a policy sentence.

### 13.3 The five invariants

Restated as enforceable properties, each with its enforcement point.

| # | Invariant | Enforcement point | Failure mode if violated |
|---|---|---|---|
| G1 | Workers never merge | Integrator is the only holder of a branch-write key; merge coordinator verifies token | Unreviewed code in main |
| G2 | Workers never deploy | Deploy is outside the grid; no deploy credential is ever minted to a node | Unauthorized release |
| G3 | Workers never waive gates | Waivers require a Human Approver token and produce a waiver artifact | Silence becomes approval |
| G4 | Workers never review their own output | Reviewer token check: `reviewer.nodeId != producer.nodeId` and `capabilityId != producer.capabilityId` | Rubber stamp |
| G5 | Every decision has evidence | Gate result with `evidence[]`; empty evidence on a required gate is `block` | Unauditable delivery |

G4's second clause matters: same node, different capability is still self-review, because the same model and context produced both.

### 13.4 Policy distribution

- Policy is a signed bundle: gate set, classification rules, reviewer pools, model allowlist, budgets.
- Nodes verify the signature at boot and refuse to run on an unsigned or expired bundle.
- `policyVersion` drift is detected at heartbeat; a drifted node gets no new leases.
- Emergency policy changes propagate within one heartbeat interval; enforcement never depends on a node voluntarily cooperating, because the broker stops leasing to it.

---

## 14. Security and threat model

### 14.1 Threat actors

| Actor | Capability | Motivation |
|---|---|---|
| Compromised node | Runs arbitrary code, controls its own model calls | Exfiltrate code, inject a backdoor |
| Malicious artifact | Payload arrives in a plan or patch | Prompt injection, path traversal |
| Curious insider | Valid credentials, read access | Read another program's code |
| Rogue model output | Prose that claims success | Bypass a gate |
| Supply-chain attacker | Dependency installed by a worker | Arbitrary code on 20 machines |

### 14.2 Threats and controls

| # | Threat | Control |
|---|---|---|
| T1 | Node submits a backdoored patch that passes its own tests | Independent review + integration test set + diff allowlist per packet |
| T2 | Prompt injection inside a plan artifact | Artifact content is data, never instructions; worker prompt separates trusted policy from untrusted artifact text; injection scanner on artifact ingest |
| T3 | Path traversal in a patch (`../../.ssh/authorized_keys`) | Patch apply restricted to the worktree root; path validation rejects `..`; `forbiddenPaths` enforced |
| T4 | Secret exfiltration through a model provider | Classification ceiling per provider; local-only routing for `restricted`; egress logging |
| T5 | Node replays an old successful patch | Fencing token + `baseCommit` must match current integration head |
| T6 | Worker escalates to reviewer or integrator | Token scopes; no scope intersection; tokens minted server-side |
| T7 | Malicious plugin imported in-process on a node | Grid packets never load dynamically imported plugins; capability bindings are restricted to signed, sandboxed packs |
| T8 | Rogue node floods the broker | Per-node rate limit, enrollment revocation, quarantine tier |
| T9 | Dependency confusion in a worker's install | Lockfile-only installs, registry allowlist, no network installs on `restricted` |
| T10 | Ledger tampering to hide a violation | Hash-chained ledger with sidecar head (existing `audit-chain`) |
| T11 | Cross-program artifact read | Artifact access scoped to program + classification; URI resolution checks both |
| T12 | Split-brain double merge | DB single-writer + fencing; second leader is read-only |

### 14.3 Why the existing plugin loader is not a node runtime

`src/plugins/agent-plugin.ts` performs a dynamic `import()` of code from `~/.nuvira/agents/`. That is acceptable when the operator installs it on their own machine. It is not acceptable for grid packets for three reasons: no signature, no sandbox, and the imported code runs in the same process that holds the node's lease tokens.

Grid workers therefore run **only** built-in or signed, sandboxed capabilities. A third-party pack may run on a node only inside the container sandbox with a capability token that has no access to lease credentials.

### 14.4 Sandbox requirement

| Packet resourceClass | Sandbox |
|---|---|
| `standard` | Worktree isolation required; container optional |
| `heavy-cpu` | Container required (resource limits) |
| `gpu` | Container required |
| `network-restricted` | Container with egress disabled |
| Any `confidential`+ | Container required, egress allowlist, no host mount except worktree |

---

## 15. Data model

### 15.1 Dedicated grid database

Consistent with the Phase 5 decision to use a dedicated lifecycle DB rather than extend `workspaces.db` (which is a project registry with a single `projects` table), Phase 11 uses a `grid.db` with its own schema.

```text
grid_programs        id, name, state, deadline, budget_usd, mode, created_at
grid_projects        id, program_id, repo, default_branch, integration_branch
grid_packets         id, program_id, objective, state, risk_class, classification,
                     base_commit, output_contract_json, budget_json, attempt, fencing
grid_packet_deps     packet_id, depends_on_id
grid_attempts        id, packet_id, node_id, lease_id, started_at, ended_at,
                     outcome, cost_usd, tokens_in, tokens_out, error_code
grid_leases          id, packet_id, node_id, fencing, granted_at, expires_at, state
grid_nodes           id, descriptor_json, trust_tier, status, last_heartbeat,
                     policy_version, runtime_version
grid_locks           program_id, paths_json, packet_id, mode, lease_id, expires_at
grid_reviews         id, packet_id, reviewer_node, reviewer_capability, verdict,
                     findings_json, artifact_hash, created_at
grid_merges          id, packet_id, integration_branch, base_commit, merge_commit,
                     fencing, strategy, ci_artifact_hash, created_at
grid_costs           id, program_id, packet_id, node_id, provider, model, usd, at
grid_events          id, program_id, packet_id, node_id, type, payload_json,
                     prev_hash, hash, at
grid_policies        version, bundle_json, signature, active_from, supersedes
```

`grid_events` is hash-chained using `appendChainedRecord` and verified with `verifyAuditFile`. One chain per program, so a single program's tamper check is independent of other programs.

### 15.2 State is not derived from events at read time

Events are the audit record; tables are the operational truth. Recomputing state by replaying events on every dashboard load would make a 1,000-packet program unreadable. The two are reconciled by a consistency check (§15.4).

### 15.3 Idempotency keys

| Operation | Key |
|---|---|
| Lease grant | `packet_id + fencing` |
| Artifact write | sha256 of canonical payload |
| Merge | `packet_id + fencing + base_commit` |
| Review | `packet_id + reviewer_node + review_round` |
| Cost record | `attempt_id + provider + model` |

### 15.4 Consistency checks

A nightly (or on-demand) check verifies:

- every `merged` packet has a `grid_merges` row and a merge commit that exists in the repo;
- every merge commit's patch hash matches the accepted patch artifact;
- no packet is `merged` without a review artifact from a non-producing node;
- the event chain verifies;
- sum of `grid_costs` matches provider-reported spend within 5%.

Any failure is a `block` on the program's delivery, not a warning.

---

## 16. Observability

### 16.1 Metrics that decide whether the grid works

| Metric | Definition | Target (20 nodes) |
|---|---|---|
| Packet cycle time | lease grant → merge | p50 < 22 min, p95 < 60 min |
| Queue wait | queued → leased | p50 < 4 min |
| Lease expiry rate | expired / granted | < 3% |
| Requeue rate | requeues / packets | < 15% |
| Review latency | submit → verdict | p50 < 8 min |
| Merge conflict rate | conflicts / packets | < 10% |
| Integration failure rate | red after merge | < 5% |
| Rework rate | attempts > 1 | < 20% |
| False-pass rate | merged then reverted | < 2% |
| Cost per merged packet | total / merged | program-defined |
| Node utilization | busy slots / total | 60–80% |
| Authority violations | blocked attempts | 0 |

False-pass rate is the honesty metric. A grid that merges fast and reverts often is not delivering.

### 16.2 Program dashboard

Five views, each answering one question:

| View | Question |
|---|---|
| Program board | What is the state of every packet, by workstream? |
| Critical path | What is blocking the deadline? |
| Node fleet | Which machines are healthy, idle, saturated, or drifted? |
| Merge queue | What is waiting to land, and why? |
| Evidence | Show me the artifact behind any green status |

The Evidence view is non-negotiable for enterprise sale: every green cell must be clickable through to the artifact hash that justifies it.

### 16.3 Audit export

Reuse `exportCefLines` for SIEM, with program and packet ids in every record. Export must be possible without the dashboard, from the CLI, on an air-gapped machine.

---

## 17. Interfaces

### 17.1 CLI

```text
nuvira grid node start --prime <url> --enroll <token>
nuvira grid node status
nuvira grid fleet
nuvira grid doctor [--node <id>]

nuvira program create <name> --repo <url> --deadline <date> --budget <usd>
nuvira program plan <id>
nuvira program approve <id>
nuvira program run <id> [--mode latency|cost] [--max-nodes N]
nuvira program status <id> [--json]
nuvira program pause|resume|cancel <id>

nuvira grid queue
nuvira grid approve <packet-id>
nuvira grid merge <packet-id>
nuvira grid waive <gate-id> --reason <text> --approver <id>
nuvira grid evidence <packet-id>
```

`nuvira grid doctor` extends the existing `doctor` command to answer the four questions that matter before a program starts: can every node reach Git, can every node reach its providers, is policy in sync, and is the artifact store writable.

### 17.2 Protocol extension

Extend the federation envelope with new payload types rather than a second protocol:

```text
grid/node/register        descriptor → enrollment result
grid/node/heartbeat       load + lease ack
grid/packet/offer         packet + lease + capability token
grid/packet/accept        ack or 429
grid/packet/reject        reason code
grid/packet/submit        patch artifact ref + test ref
grid/packet/progress      phase + percent
grid/artifact/put         chunked upload
grid/artifact/get         scoped fetch
```

Backward compatibility: a node that does not advertise `grid` in `capabilities` is a v1 federation peer and never receives a packet offer. No existing federation behavior changes.

### 17.3 A2A interop

The existing `AgentCard` remains the external card for other ecosystems. The grid descriptor is internal and richer; Prime publishes an `AgentCard` that advertises `program-delivery` as a skill so an external A2A agent can delegate a program, but it cannot join the internal grid.

---

## 18. Phased delivery

Each stage is independently useful and independently demoable. No stage requires the next.

### Stage 0 — Prerequisites (Phase 5 work, not Phase 11)

- stage seam for `after:plan`, `after:implement`, `before:merge`;
- worktree-enforced writes for every run;
- durable run store;
- signed artifact envelopes;
- fix F1 and F2 from §3.5.

**Exit:** a single local run produces patch + test + review + verification artifacts with hashes, and can be resumed after a crash.

### Stage 1 — Single-machine multi-process (2–3 weeks)

- program record, packet DAG, planner;
- broker with leases, one node (localhost);
- patch artifact transport over federation;
- merge coordinator with manual approval.

**Exit:** a 12-packet program completes on one machine with two worker processes, every packet gated and merged by the coordinator, and no false successes.

This stage is deliberately unimpressive and is the most important one: it proves the contracts before the network is involved.

### Stage 2 — Three nodes, one workstream (2–3 weeks)

- node enrollment and heartbeat;
- capability matching;
- path locks;
- review federation with independence check;
- degraded-state handling.

**Exit:** three laptops deliver a 20-packet workstream; killing one mid-flight costs <15% wall clock and nothing is lost.

### Stage 3 — Twenty nodes, full program (3–4 weeks)

- admission control, fairness, priority modes;
- conflict prediction and rebase-on-advance;
- integration test set;
- cost ledger;
- program dashboard, fleet view, evidence view.

**Exit:** S1–S14 from §2 pass at 20 nodes.

### Stage 4 — Enterprise controls (3–4 weeks)

- signed policy bundles, drift detection;
- trust tiers, classification ceilings, egress enforcement;
- scoped capability tokens;
- reviewer calibration with seeded defects;
- SIEM export, retention, waiver workflow.

**Exit:** a security review with the threat table in §14 passes, including an attempted-insider test.

### Stage 5 — Scale and federation (not committed)

- HA Prime (leader election, fencing);
- 100+ nodes with sharded brokers;
- multi-program fairness at scale;
- inter-org A2A delivery (Phase 15 horizon).

**Exit:** undefined by design. This stage needs its own specification after Stage 4 measurements.

### Effort

| Stage | Engineer-weeks | Confidence |
|---|---|---|
| 0 (Phase 5 prereqs) | 6–8 (already scoped) | Medium |
| 1 | 2–3 | High |
| 2 | 2–3 | Medium |
| 3 | 3–4 | Medium |
| 4 | 3–4 | Low–medium |
| **Phase 11 total (1–4)** | **10–14** | Medium |
| Thin vertical slice (Stage 0 subset + Stage 1) | 4–6 | Medium |

The Copilot draft implies this is a single feature. It is 10–14 engineer-weeks on top of a 6–8 week prerequisite, and that is the honest number.

---

## 19. Capacity and throughput model

The arithmetic that keeps the plan honest.

Assume 20 nodes, 3 slots each = 60 concurrent lanes.

| Stage | Time | Notes |
|---|---|---|
| Model generation | 6–18 min | Packet-size dependent, 400-line cap |
| Local tests | 1–4 min | Node CPU |
| Submit + artifact upload | 20–60 s | LAN |
| Review | 4–10 min | Independent node, parallel with other work |
| Rebase + integration tests | 2–6 min | **Serialized at the coordinator** |
| Merge | <10 s | |

The coordinator is the bottleneck: 2–6 minutes of serialized time per packet caps throughput at **10–30 packets/hour** in theory.

Realistic sustained rate: **6–12 merged packets/hour** at 20 nodes, because:

- not every packet is ready at once (DAG width);
- review capacity limits submit-to-accept;
- some packets conflict and rework;
- laptop sleep, Wi-Fi, and model rate limits are real.

For an 80-packet program: 8–13 hours of grid time, versus roughly 40–60 hours serial on one machine. That is the 3–5× the objective claims — not 20×. Claiming 20× would be the kind of number that collapses in the first enterprise pilot.

### 19.1 What breaks first, in order

1. **Merge coordinator serialization** — fix with batched integration and parallel scratch worktrees.
2. **Review capacity** — fix with more reviewer nodes and a findings quota.
3. **Model provider rate limits** — fix with local-model fallback per capability.
4. **Git server throughput** on 20 simultaneous fetches — fix with a local mirror on Prime.
5. **Prime's memory** holding artifact metadata — fix with pagination and a real DB.

Knowing this order is what makes Stage 3 scoping possible.

---

## 20. Cost model

| Cost driver | Control |
|---|---|
| Cloud model tokens | Per-packet budget, per-program envelope, cost-mode routing |
| Local model electricity | Tracked, not billed; affects node preference |
| Review tokens | Bounded by patch size cap (R7) |
| Integration test compute | Batched, cached by patch hash |
| Operator time | The real cost: dashboard + approvals should be <15 min/hour of grid time |

Per-packet cost estimate at 400 changed lines: 120k–250k input tokens, 6k–12k output tokens. On a mid-tier cloud model that is roughly $0.40–$1.20; on a local model it is effectively free but slower. Cost mode can cut a program's bill by 50–70% at the cost of 1.5–2× wall clock.

---

## 21. Scope boundaries

### 21.1 Committed in Phase 11

- 5–30 nodes on a LAN or overlay network;
- one Prime, no HA;
- program planning, packet decomposition, brokered execution;
- patch artifacts, independent review, merge coordinator;
- trust tiers, classification, scoped tokens, signed policy;
- program dashboard, audit export, cost ledger.

### 21.2 Explicitly not committed

| Not committed | Why |
|---|---|
| 100+ nodes | Needs HA Prime, sharded broker, different merge strategy |
| Multi-org federation | Requires contract, identity federation, and legal model (Phase 15) |
| Autonomous department creation | Departments are operator-defined policy scopes, not self-spawning |
| Self-modifying grid policy | Policy changes are human-approved |
| Agents hiring agents | Unbounded cost and authority; no design that survives audit |
| Deploy authority | Stays with existing CI and human release |
| 500-node claims | No design, no measurements, no HA story |

The last row is a direct correction to the Copilot draft, which states "10, 50, 100, 500+ worker nodes" as if topology were a scalar.

---

## 22. Risks

| # | Risk | Likelihood | Impact | Mitigation | Early signal |
|---|---|---|---|---|---|
| R1 | Bad decomposition produces unmergeable work | High | High | R1–R10 validation, reject-don't-repair, interface packets first | Conflict rate >20% in Stage 2 |
| R2 | Review becomes a rubber stamp | High | High | Patch size cap, seeded defects, diversity policy | Seeded-defect miss rate >30% |
| R3 | Merge coordinator bottleneck | Medium | Medium | Batching, parallel scratch trees | Queue wait p95 > 15 min |
| R4 | Heterogeneous model quality drift | High | Medium | Capability-level success rates, model pinning per packet type | Rework rate >30% |
| R5 | Cost overrun | Medium | High | Budgets, cost mode, hard stop at envelope | Spend at 70% with <50% packets merged |
| R6 | Laptop churn (sleep, lid close) | High | Medium | Heartbeat, requeue, prefer always-on nodes for critical path | Lease expiry >10% |
| R7 | Secret leakage to a provider | Low | Critical | Classification ceilings, local-only routing, egress logs | Any `restricted` packet on a cloud model |
| R8 | Duplicate merge under partition | Low | Critical | Fencing at merge boundary, single writer | Two merges for one packet id |
| R9 | Operator cannot read the dashboard | Medium | High | Evidence-first design, one question per view | Time-to-answer > 60s in usability test |
| R10 | Phase 5 slips, Phase 11 starts early | High | High | Hard gate: no Stage 1 before Stage 0 exit | Stage 0 exit criteria unmet |
| R11 | "Autonomous organization" narrative outruns the product | High | Medium | §21 scope table, honest 3–5× claim | Sales deck says 20× |
| R12 | Artifact store fills a laptop disk | Medium | Low | Retention, GC, pre-flight disk check | Disk <10% on any node |

R10 is the risk most likely to actually happen. The temptation to start building the grid while Phase 5 is unfinished is strong, and it produces a distributed system with no gates — which is the exact chaos the strategy document warns about.

---

## 23. Decisions required

Each needs an owner and an answer before Stage 1.

| # | Decision | Recommendation | Alternative |
|---|---|---|---|
| D1 | Does Phase 11 extend the coding lifecycle or add a program lifecycle? | **Program lifecycle**; leaves are Phase 5 runs | Extend stages (rejected: breaks protected graph) |
| D2 | Are departments runtime objects? | **No**; policy scopes and selectors | Runtime departments (rejected: second authority model) |
| D3 | Patch artifacts or branch pushes? | **Patch artifacts** for v1 | Namespaced branch pushes (revisit at 100+ nodes) |
| D4 | Where do workers get repo access? | **Read-only mirror + no write credentials** | Per-node deploy keys (rejected: too much blast radius) |
| D5 | Is Docker mandatory on nodes? | **Required for `heavy-cpu`/`gpu`/`confidential`**, optional otherwise | Mandatory everywhere (rejected: excludes laptops) |
| D6 | One broker or per-workstream brokers? | **One broker** for v1, shard later | Per-workstream (premature) |
| D7 | Reviewer diversity rule | **Different node + different capability**; different model family for `high`+ risk | Node-only (too weak) |
| D8 | Does a worker see the whole repo? | **Packet-scoped checkout**, not full clone, for `confidential`+ | Full clone (rejected: egress + cost) |
| D9 | Integration test set owner | **Program-level**, defined at plan time | Per-packet only (rejected: misses cross-packet breakage) |
| D10 | Cost mode default | **Latency**, with a program-level switch | Cost (rejected: slower first-run experience) |
| D11 | Lease TTL default | **3× expected, max 90 min** | Fixed 30 min (rejected: kills long builds) |
| D12 | HA Prime in v1? | **No** | Yes (rejected: doubles Stage 3) |
| D13 | Roadmap position | **Phase 11**, after Phase 5–8 | Merge into Phase 5 (rejected: different risk class) |
| D14 | Phases 12–15 | **Uncommitted horizons**, one paragraph each in the roadmap | Commit to them now (rejected: roadmap inflation) |
| D15 | Grid protocol | **Extend federation envelope**, grid capability flag | New protocol (rejected: second auth path) |

---

## 24. Open questions for the Phase 5 review

These are genuine unknowns, not rhetorical.

1. **Stage seam shape.** Does Phase 5 expose a plan-only run, a task-batch run, and a review boundary — or a `LifecycleStageHost`? Phase 11 needs `after:plan` and `after:implement` to be blockable on a worker before Stage 1 starts.
2. **Worktree enforcement.** Is `NUVIRA_ISOLATE` mandatory for all lifecycle runs, or only grid packets? If only grid, a worker can be misconfigured into the live tree.
3. **Artifact store location.** Prime-local, shared network volume, or replicated? This decides whether a laptop can join without a VPN.
4. **Dedicated DB confirmation.** Phase 5 proposes a dedicated lifecycle DB. Does Phase 11 share it (simplest) or get `grid.db` (cleaner failure isolation)? Recommendation: share the engine, separate the file.
5. **Review artifact authority.** Does a reviewer's verdict feed Phase 5's `review` stage gate directly, or is it an input the merge coordinator interprets? Recommendation: direct gate input, so review cannot be re-interpreted by a model.
6. **Trust tier mapping.** Does `byod` map to Phase 5's trust levels, or is it a grid-only concept? Recommendation: grid-only, with `organization` trust as the ceiling.
7. **Waiver authority.** Can a program-level waiver apply to a packet gate, or only a human per instance? Recommendation: program-scoped waiver with named approver, expiring.
8. **Model allowlist ownership.** Org policy or per-node operator choice? Recommendation: org policy with local-model opt-in.

---

## 25. Traceability

| User requirement | Section |
|---|---|
| Main machine acts as project manager | §4.1, §13.1 |
| Leverage 20–30 configured machines | §8, §19 |
| Uses their installed models/providers | §8.1, §8.3 |
| Major task developed as a plan | §7 |
| Plug-and-play smaller chunks | §7.1, §7.2 (R2, R3, R7) |
| Other systems develop the chunks | §9, §10.1 |
| Prime reviews and approves decisions | §13, §10.4 |
| Full source control via Git | §10, §10.5 |
| End-to-end delivery / lifecycle | §4.3, §10.4, Phase 5 dependency |
| Faster delivery for enterprises/community | §19 |
| Enterprise grade, not mediocre | §13, §14, §15, §22 |

---

## 26. Acceptance criteria

Phase 11 is accepted when a reviewer can run the following without trusting any summary.

1. Create a 40-packet program against a real repository.
2. Enroll 20 nodes, three of which lack a required capability and two of which are `byod`.
3. Verify no `byod` node receives a `confidential` packet.
4. Start the program, kill 5 nodes at 30% completion.
5. Confirm: program reaches `degraded`, then `delivered`; wall clock slip <15%.
6. Confirm: no packet merged without a review artifact from a different node and capability.
7. Confirm: no duplicate merge for any packet id.
8. Confirm: every merged packet's merge commit contains exactly its accepted patch.
9. Confirm: the ledger verifies end to end; tampering with one line breaks verification.
10. Confirm: no worker credential can push to the protected branch (attempt and observe rejection).
11. Confirm: total cost is within 5% of provider billing.
12. Restart Prime mid-program and confirm no completed packet re-executes.

If any of these fail, the phase is not done, regardless of dashboard appearance.

---

## 27. Process, signal, and teardown policy

### 27.1 Why this is in the grid specification

A grid is a process supervisor at scale. Twenty nodes, three slots each, means up to sixty concurrent runs, each with a process tree: the model call, the test runner, a dev server, a watcher. How those processes are stopped decides whether the system is coherent or merely busy.

The observed problem: the agent reaches for `kill -9` on ordinary occasions — restarting a stale dev server, freeing a port, clearing an old test run. The policy says `kill -9` is denied, and the behaviour happens anyway. That gap is not a model flaw. It is a policy-design flaw, and this section diagnoses it in code.

### 27.2 What the code actually does (verified)

| Location | Behaviour | Verdict |
|---|---|---|
| `src/tools/run-terminal.ts` (DENY_PATTERNS) | `{ rule: 'forced kill', re: /kill\s+-9\b/ }` | Blocks one spelling only |
| `src/tools/run-terminal.ts` (same list) | `killall` denied wholesale under `system-level destruction` | Over-blocks graceful mass stop |
| `src/tools/run-terminal.ts` (`killProcessTree`) | `SIGTERM`, 5 s grace, then `SIGKILL` | Correct escalation |
| `src/cli/process-control.ts` (`stopProcess`) | `SIGTERM`, `graceMs` (3 s), then `SIGKILL`; `taskkill /F` on Windows | Correct |
| `src/sandbox/manager.ts` | Container `SIGTERM`, 2 s, then `SIGKILL` | Correct |
| `src/tools/terminal-tool.ts` (timeout) | Immediate `child.kill('SIGKILL')` | **Inconsistent**: no grace |
| `src/tools/subagent-spawner.ts` (`kill`) | `SIGTERM` only, status set to `killed` immediately | **State can lie**: process may ignore TERM |
| `src/tools/process-registry.ts` (`kill`) | `SIGTERM`, status `stopped` immediately, no liveness check | Same |

The runtime mostly does the right thing. The **agent-facing rule** does not, and the two disagree.

### 27.3 Why a string blocklist cannot work

Five bypasses of the current rule, all trivially reachable:

| Bypass | Why it passes |
|---|---|
| `pkill -9 node` | Rule matches `kill`, not `pkill` |
| `kill -s KILL 1234` | Rule requires the literal `-9` |
| `kill -KILL 1234` | Same |
| `kill --signal=9 1234` | Same |
| `bash -c 'kill -9 …'` / a script file | The deny regex scans the command string, not the script's contents |

And one over-block that causes the behaviour: `killall node` — a graceful mass stop — is denied as "system-level destruction". An agent that needs to restart a dev server and cannot use `killall` has exactly two options left: escalate to a human, or find a spelling the regex misses. It picks the second, because the first blocks the task. Blocklists create workarounds; intent models create compliance.

### 27.4 The model: classify intent, scope the target

A signal operation has four attributes: **signal** (default `TERM`), **target** (pid, pattern, port, name), **scope** (single, bounded set, all), and **force** (whether a hard kill is requested). Policy applies to the tuple, not the string.

| Intent | Example | Policy |
|---|---|---|
| Graceful stop of an owned process | `kill 4412`, `kill -TERM 4412` | Allow |
| Graceful stop of an owned tree | `nuvira gateway stop`, `nuvira dashboard stop` | Allow (blessed path) |
| Graceful stop of an unowned process | `kill 3311` (pid not in this run's ownership set) | Confirm, with the owning command shown |
| Forced stop of a process this run owns | `kill -9 4412` where 4412 is this run's child | Allow (the supervisor is allowed to reap its own) |
| Forced stop of an unowned process | `kill -9 3311` | Confirm, reason required, logged |
| Forced stop by pattern/port | `pkill -9 -f vite`, `killall -9 node` | Deny |
| Graceful stop by pattern, bounded | `pkill -TERM -f 'vite --port 5173'` | Confirm |
| Mass stop, any signal | `killall node`, `pkill -9 node` | Deny unless a human runs it outside the agent |

Two rules make this enforceable rather than advisory:

1. **Ownership set.** Every process the agent spawns is registered with `{ownerRunId, ownerPacketId, pid, tree, ports, startedAt}`. A signal to a pid in that set is a supervisor action; a signal to anything else is an operator action. The distinction is data, not text.
2. **No signal without an owner or an approval.** If a pid cannot be attributed, the operation needs confirmation, and the record says `owner: unknown`. At twenty nodes, an unattributed `kill -9` is how one worker destroys another worker's test run.

### 27.5 The blessed path the agent should have

The reason `kill -9` looks attractive is that there is no trusted way to answer "what is holding port 5173, and can I stop it cleanly?". Provide one:

```text
nuvira workspace process list            # pid, owner, tree, ports, age, command
nuvira workspace process stop --port 5173  # resolve owner -> SIGTERM -> wait grace -> verify exit
nuvira workspace process stop --pid 4412   # same, by pid
nuvira grid worker drain <id>              # stop accepting, finish in-flight, then exit
```

`stop --port` must: resolve the pid, verify it belongs to this workspace or run, send `SIGTERM`, wait up to a class-appropriate grace (dev server 5 s, test run 10 s, build 30 s), verify exit, and only then report. If the process is unowned, it refuses and names the owner of the port. That single command removes most legitimate uses of `kill -9`.

### 27.6 Grid rules (non-negotiable)

| # | Rule |
|---|---|
| T1 | The coordinator never signals a worker process. It revokes a lease; the node's own supervisor stops the work |
| T2 | The node supervisor stops a packet with `SIGTERM`, waits the packet's declared grace, then `SIGKILL` |
| T3 | `SIGKILL` on a packet is recorded as a **forced termination**, with the reason and the owner; it is a metric and an incident input, not routine |
| T4 | Artifacts from a forcibly terminated packet are `unverified` and cannot satisfy a gate |
| T5 | Reaping is owner-scoped: a node may only signal pids in its own ownership registry |
| T6 | A `SIGKILL` with no owner record is a **security event**, not a cleanup |
| T7 | Draining is the only supported way to remove a worker from a program mid-flight |
| T8 | Ports are owned, not discovered at kill time: the supervisor records the bind, and releases it on teardown |

T3 and T6 are the ones that would have prevented the observed behaviour from being invisible: a forced kill would show up in the program report with its owner and reason, so the operator could see the pattern rather than discover it as an anecdote.

### 27.7 Metrics

| Metric | Healthy | Meaning when it moves |
|---|---|---|
| `forced_kill_total` | 0 for graceful paths | Grace windows too short, or packets ignoring SIGTERM |
| `kill_unowned_total` | 0 | Ownership registry gap; security review |
| `drain_timeout_total` | low | Grace too short for the packet class |
| `orphan_process_total` | 0 after teardown | Teardown is not walking the tree |
| `lease_expired_while_healthy_total` | ~0 | TTL too short for the class (D11) |

### 27.8 Recommended change list (Phase 5 hardening, not Phase 11 code)

1. Replace the `forced kill` regex with an intent parser over `{signal, target, scope, force}`.
2. Add `pkill`/`killall` to the parser; deny forced or mass scope, confirm bounded graceful scope.
3. Integrate the ownership registry; allow forced stop only for owned pids without confirmation.
4. Add the `workspace process` commands above as the blessed path.
5. Make `terminal-tool.ts` timeout escalate `SIGTERM` first, matching `killProcessTree`.
6. Make `subagent-spawner.kill` and `process-registry.kill` verify exit before reporting `killed`/`stopped`.
7. Add tests: each bypass spelling, each intent row, ownership attribution, and the "state must not lie" cases.

None of these is large. All of them are cheaper than explaining to an enterprise why the agent force-killed a process it did not own.

**Implementation status (2026-11-11).** Items 1–4 and 7 are done: `src/tools/signal-intent.ts` parses `{signal, target, scope, force}`, the floor calls it instead of the `kill -9` regex, `killall` was removed from the system-destruction pattern so its precise rule names it, ownership is registered on spawn and dropped on exit, and `nuvira workspace process list|stop --port|--pid` is the blessed path. Tests: `tests/tools/signal-intent.test.ts` (21 cases, including every bypass spelling). Items 5–6 are done too: `terminal-tool.ts` sends SIGTERM and escalates to SIGKILL only after a 2s grace window; `subagent-spawner.kill` escalates the same way and records `failed` if the child survives both signals; `process-registry.kill` no longer set `stopped` when it had merely *sent* SIGTERM — it updates status from observed liveness (SIGTERM → 3s → SIGKILL → confirm).

---

## 28. Summary

Phase 11 turns Agent-Nuvira from a single-machine agent into a governed delivery grid by adding four things it does not have: a program planner, a durable broker with leases and fencing, a patch-artifact review-and-merge pipeline, and a trust-tiered node fleet. It reuses the transport, worktree isolation, fan-out scheduler, audit chain, and sandbox that already exist, and it inherits gates, artifacts, and run records from Phase 5 rather than reinventing them.

It does not add organizational runtime primitives, does not extend the coding lifecycle, does not claim 500 nodes, and does not let a worker merge, tag, or deploy. Those four omissions are what make the rest credible.
