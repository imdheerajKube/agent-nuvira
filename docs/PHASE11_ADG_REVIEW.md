# Phase 11 — Review, Comparison, and Verdict

## Copilot draft vs. this plan, validated against the Agent-Nuvira codebase

| Field | Value |
|---|---|
| Status | Review complete; conditional go |
| Version | 1.0 |
| Reviewers | Runtime, platform, security, delivery (CIO / solution-architect lens) |
| Compared against | The Copilot ADG discussion supplied by the operator |
| Plan under review | [`PHASE11_DISTRIBUTED_AGENT_GRID.md`](./PHASE11_DISTRIBUTED_AGENT_GRID.md) |
| Strategy companion | [`PHASE11_ADG_STRATEGY.md`](./PHASE11_ADG_STRATEGY.md) |
| Codebase basis | `main` at time of writing; static inspection only, no runtime tests |

---

## 0. Method

Three passes, in this order.

1. **Read the code first.** Establish what already exists, what is missing, and what would be a reimplementation. Files: `src/federation/*`, `src/agents/orchestrator.ts`, `src/agents/task-execution-pipeline.ts`, `src/agents/fanout-scheduler.ts`, `src/tools/worktree.ts`, `src/team/review.ts`, `src/enterprise/*`, `src/config/workspace.ts`, `src/plugins/agent-plugin.ts`, `src/sandbox/*`, `src/cli/federation.ts`.
2. **Read the Copilot draft as a proposal.** Extract its claims, not its tone. Score each claim against the code.
3. **Write the plan that survives both.** Adopt what is right, correct what is wrong for this codebase, and state the conditions under which the phase should not start.

This order matters. A plan written from the draft first would have inherited its assumptions and then looked for code to justify them.

---

## 1. What the Copilot draft gets right

Credited explicitly, because four of its ideas are load-bearing in the final plan.

| Idea | Why it survives |
|---|---|
| The category shift: assistant → delivery organization | Correct and important. It reframes the product from "better coding" to "governed coordination", which is a defensible position |
| Typed artifacts exchanged between disciplines, never raw context | Exactly right, and it aligns with Phase 5's artifact contract |
| Workers never merge, deploy, waive gates, or review their own output | The correct set of hard invariants. This plan enforces all four structurally |
| Capability advertisement and capability-based routing | Necessary, and the existing `FederationConfig.capabilities` is the seed for it |
| Node classification (research, engineering, QA, security, ops) | Useful as tags and policy scopes, and the final plan keeps it in that form |
| Program-level dashboard tracking status, cost, risk, velocity | Correct scope; velocity and cost are what operators actually watch |
| Do not put this inside Phase 5 implementation | Correct sequencing call, and this plan honors it |
| Organizational learning as a later phase | Correct deferral; it needs data this phase produces |

The draft's instinct on governance is good. Its mechanism is where it diverges.

---

## 2. What the draft assumes that is false for this codebase

Each row is a claim in the draft, the reality in the repository, and the consequence.

### 2.1 "Build a node registry and a task broker" — the transport already exists

The draft proposes node registration, capability advertisement, and task delegation as new components. `src/federation/` already implements:

- `POST /federation/handshake` with pre-shared secret **or** OIDC (JWT RS256 via `oidc-adapter.ts`), constant-time comparison, session tokens with 24h expiry;
- `POST /federation/task` with SSE progress events and a 15s heartbeat;
- `POST /federation/cancel`, `GET /federation/health`;
- a client with `connect()`, `delegateTask()`, `cancelTask()`, `getHealth()`;
- `FederationConfig` carrying `nodeId`, `capabilities[]`, `maxConcurrentTasks`, `taskTimeoutMs`;
- an A2A v1.0 surface (`/.well-known/agent-card`, `/a2a/task`, `/a2a/task/:id`) with a typed `AgentCard` including per-skill JSON schemas.

Building a second registry and broker protocol would create two authentication paths, two identity models, and two ways to be wrong about who a node is. The final plan **extends** the federation envelope with `grid/*` payload types and a `grid` capability flag, so a v1 peer is simply never offered a packet.

### 2.2 "Departments, teams, agents as first-class objects" — that creates a second authority model

The draft's hierarchy is `Organization → Division → Team → Agent → Capability`, presented as runtime structure.

The codebase already has one authority model: Phase 5's stages, gates, artifacts, and trust. Adding a second hierarchy of runtime objects means every decision must be checked against two structures, and they will drift.

The final plan keeps the vocabulary and collapses the objects into three enforceable things: **policy scope**, **capability pool**, **accountability record**. A "QA department" creates no new process; it creates a gate set, a reviewer pool, and a node tag. This preserves the value of the analogy while leaving exactly one place where authority lives.

### 2.3 In-memory registries are presented as durable

The draft's node registry and task broker are described with no durability requirement. The existing federation server shows why that is a problem: `sessions`, `runningTasks`, and `sseClients` are module-level `Map`s, and counters are plain integers. A restart loses every in-flight task.

A 6-hour program with 80 packets cannot run on process memory. The final plan mandates a durable broker with leases, attempts, fencing, and resume — and explicitly reuses the `node:sqlite` + JSON fallback pattern that `src/config/workspace.ts` already uses, in a dedicated `grid.db`.

### 2.4 "Distributed worktrees" — the primitive exists, the base-commit rule does not

`src/tools/worktree.ts` already creates a real `git worktree add -b nuvira/<name> <dir> HEAD`, measures the dirty source tree, computes a per-file unified diff, excludes the symlinked `node_modules` via pathspec, and refuses rather than degrading when isolation is impossible.

What the draft does not address is the trap this creates: a worktree is a checkout of `HEAD`, so a node with stale code produces a patch against the wrong base. The final plan requires the worktree base to equal the packet's recorded `baseCommit`, created from a bare mirror, with `NUVIRA_ISOLATE` mandatory for grid packets.

### 2.5 "PM controls Git" without a mechanism

The draft asserts PM-only merge, which is correct as intent and empty as design. The codebase's closest thing, `src/team/review.ts::mergeReview()`, writes file contents into `cwd` with `writeFileSync`. It is a local review convenience, not a Git merge, and it has no identity binding.

The final plan makes the invariant structural: workers hold a read-only mirror and submit **patch artifacts**; only the merge coordinator holds a branch-write deploy key; every merge is fenced so a stale attempt cannot land.

### 2.6 "500+ nodes" with no topology

The draft lists "10, 50, 100, 500+" as a scale ladder. Scale is not a scalar: 500 nodes requires a highly available control plane, sharded brokers, a different merge strategy than serialized rebase, and a Git server that can serve hundreds of simultaneous fetches.

The final plan commits to 5–30 nodes, explains why (the merge coordinator serializes at 2–6 minutes per packet, capping theoretical throughput at 10–30 packets/hour), and defers 100+ to an uncommitted Stage 5 with its own specification.

---

## 3. Gaps in the draft that would have caused production incidents

These are the differences between a plausible architecture diagram and a system that survives a Tuesday.

| # | Gap | Incident it causes | Where the final plan closes it |
|---|---|---|---|
| G1 | No lease or fencing model | Two workers both believe they hold a packet after a partition; both patches merge. Silent duplicate delivery | §9.3, §12.2 |
| G2 | No idempotency keys | Retried artifact writes create divergent copies; cost records double-count | §15.3 |
| G3 | No admission control | A node advertising 4 slots accepts 40 tasks and thrashes its model quota | §9.6 (and existing defect F2) |
| G4 | No artifact classification or egress rule | A `confidential` packet executes on a `byod` laptop and calls a cloud model | §8.4, §11.3 |
| G5 | No review independence mechanism | The same node, or the same model, reviews its own patch; review becomes a formality | §13.3 G4, §13.2 tokens |
| G6 | No patch size bound | 1,400-line patches get a 40-second "LGTM"; the review gate is theater | §7.2 R7 |
| G7 | No conflict prediction | Ten workers edit `shared/types.ts`; the merge queue collapses | §7.2 R3, §10.3 path locks |
| G8 | No integration test set | Each packet is green alone; the program is broken after the fifth merge | §10.4 step 8, D9 |
| G9 | No split-brain handling | Two Prime instances both merge | §12.1, D12 |
| G10 | No cost attribution | Program spend is unknowable until the invoice | §15, §20 |
| G11 | No degraded-state semantics | Losing four laptops fails the program instead of slowing it | §4.3, §12.5 |
| G12 | No honest scale claim | Enterprise pilot benchmarks against "20×" and finds "3×" | §19, §21 |

G1, G5, and G8 are the three that would be discovered only after a customer had been told the system works. They are the reason this review recommends conditions rather than an unconditional go.

---

## 4. Two live defects found during validation

These are not hypotheticals from the draft; they are in the current tree and they matter more once a grid exists.

### F1 — Polling fallback can report success without a result

`src/federation/client.ts::delegateWithPolling` posts the task, then loops on `getHealth()`. When `health.activeTasks === 0` it returns:

```ts
{ taskId, success: true, summary: `Task ${taskId} completed`, durationMs }
```

It never fetches the task result. With concurrent tasks, or after a failure, this returns a false success. In a grid this is the worst class of bug: the control plane believes a packet delivered, the ledger records it, and nothing was built.

**Required fix (Phase 5 hardening):** poll a task-status endpoint that returns a terminal result, and treat "no active tasks" as `unknown`, never `success`.

### F2 — Advertised capacity is not enforced

`src/federation/server.ts::handleTaskDelegation(req, res, _config)` ignores the config parameter. `config.maxConcurrentTasks` is never compared to `runningTasks.size`. A node advertising 4 slots accepts unlimited work.

**Required fix:** reject with `429` and a retry hint at the node, and treat the rejection as a placement signal in the broker.

**Status: both fixed (2026-11-11).** F1 — the server now records a terminal result per task id (`GET /federation/task/:id`), and the polling client returns that verdict or throws `unknown outcome`; "not active" is never read as success. F2 — `handleTaskDelegation` enforces `maxConcurrentTasks` and answers `429` with `Retry-After`. Regression tests: `tests/federation/client-polling.test.ts` (4 cases). F2 also has a deterministic test now: the server accepts an injected executor (`FederationConfig.executor`), so a held-open task can be asserted to produce `429` with `Retry-After` (`tests/federation/server-capacity.test.ts`, 3 cases).

Both were small. Both had to land before Stage 1, because a grid multiplies each by the number of packets.

---

## 5. Phase numbering collision

The draft proposes Phases 11–15 (`Distributed Agent Grid`, `Autonomous Departments`, `Autonomous Programs`, `Organizational Intelligence`, `Enterprise Delivery Mesh`). A second Copilot message proposes a different set (`Phase 9 Distributed Agent Mesh`, and elsewhere `Phase 6 Marketplace`, `Phase 7 Capability Intelligence`, `Phase 8 Enterprise Governance`).

Both collide with work the parent roadmap already contains: **Phase 9 (capability quality and method catalog)** and **Phase 10 (semantic discovery and marketplace analytics)** are already written into `ENHANCE_CUSTOM_CAPABILITY.md` as proposals.

Resolution adopted:

| Phase | Status |
|---|---|
| 9 | Capability quality and method catalog (existing proposal) |
| 10 | Semantic discovery and marketplace analytics (existing proposal, evidence-gated) |
| **11** | **Distributed Agent Grid — this document** |
| 12 | Autonomous departments at scale — horizon, not committed |
| 13 | Autonomous programs — horizon, not committed |
| 14 | Organizational intelligence — horizon, not committed |
| 15 | Inter-organization delivery mesh — horizon, not committed |

Phases 12–15 get one paragraph each in the roadmap and no specification. Committing to five phases at once is how a roadmap stops being believed.

---

## 6. Claim-by-claim verdict

| Copilot claim | Verdict | Evidence | Final plan's position |
|---|---|---|---|
| One instance orchestrates 10–500 nodes | **Not supported at 500** | No HA control plane, no sharded broker, serialized merge coordinator | Commit 5–30; defer 100+ |
| Node registry stores machines, capabilities, models, trust, health | **Partially supported** | `FederationConfig` has `nodeId` + `capabilities[]`; no health/trust/slots | Extend descriptor (§8.1) |
| Task broker handles routing, scheduling, retry, priority | **Not supported** | `runningTasks` is a `Map`; no retry, priority, or fairness | New durable broker (§9) |
| Distributed worktrees, never a shared working copy | **Supported, already built** | `src/tools/worktree.ts` | Reuse, add base-commit rule (§10.1) |
| Artifact mesh exchanges typed artifacts, never raw context | **Supported in principle, unbuilt** | Phase 5 envelope exists; federation returns inline base64 `outputFiles` | Content-addressed, by-reference (§11) |
| Review federation: workers cannot approve themselves | **Concept right, no mechanism** | `team/review.ts` has no node identity binding | Token scopes + independence check (§13.2–13.3) |
| Workers never merge; only Prime | **Right, needs enforcement** | `mergeReview()` writes files to `cwd` | Sole deploy key + fencing (§10.5) |
| Workers never deploy | **Right** | No deploy credential exists in the grid | Out of scope entirely (§21.2) |
| Workers never waive gates | **Right, unspecified** | RBAC has no waiver action | Human approver + waiver artifact (§13.3) |
| Every decision has evidence | **Right, matches Phase 5** | `GateResult.evidence[]` in Phase 5 | Reuse directly (§13.3 G5) |
| Departments/teams as runtime objects | **Rejected** | Would duplicate Phase 5 authority | Policy scopes and selectors (§6) |
| Capability-based assignment | **Supported** | `capabilities[]` exists as strings | Structured descriptor + deterministic scoring (§8.3) |
| Lifecycle gains `decompose`/`allocate`/`integrate` stages | **Rejected** | Phase 5 declares protected stages; adding stages breaks the contract | Separate program state machine (§4.2–4.3) |
| Program dashboard with cost, risk, velocity | **Supported** | No program records exist yet | Five views, evidence-first (§16.2) |
| Organizational intelligence learns best teams/nodes | **Deferred** | Needs Stage 4 data | Phase 14 horizon |
| "Biggest moat is organizational execution" | **Supported** | Consistent with the codebase's actual strength (gates, ledger) | Kept as the strategic claim |
| Do not put this in Phase 5 implementation | **Supported** | Different risk class, different prerequisites | Phase 11, gated on Phase 5 |

Nine claims supported or partially supported, four rejected or materially corrected, one deferred.

---

## 7. What the merged plan changed relative to the first draft of this review

Recorded for transparency, because a review that only ever confirms itself is not a review.

| Change | Reason |
|---|---|
| Added §3.5 (F1, F2 defects) | Found in code during validation; both are prerequisites, not nice-to-haves |
| Reduced scale claim from "100+" to "5–30 committed, 100+ deferred" | The merge coordinator is the bottleneck; the arithmetic did not support more |
| Added §19 capacity model and §20 cost model | Without numbers, the 3–5× claim is marketing |
| Added patch size cap (R7) | Review independence is worthless if the patch cannot be reviewed |
| Added integration test set as a program artifact (D9) | Per-packet green does not imply program green |
| Added `degraded` as a first-class program state | Laptop churn is the normal case, not an exception |
| Split the deliverable into three documents | The spec, the strategy, and the review answer different questions and have different audiences |
| Kept Copilot's program/dashboard framing | It is genuinely better than a task-list UI |

---

## 8. Conditions for approval

**Conditional GO.** The direction is right, the sequencing is right, and the plan is now grounded in the actual codebase. It should not start until all of the following hold.

| # | Condition | Owner | Blocking |
|---|---|---|---|
| C1 | Phase 5 stage seam exists for `after:plan` and `after:implement`, blockable | Runtime | **Yes** |
| C2 | Worktree isolation is mandatory for lifecycle runs, not opt-in | Runtime | **Yes** |
| C3 | Durable run store survives a crash and resumes | Runtime | **Yes** |
| C4 | Artifact envelopes are signed and content-addressed | Platform | **Yes** |
| C5 | F1 (false-success polling) and F2 (capacity not enforced) fixed | Federation | **Yes** |
| C6 | `grid.db` schema and migration path approved | Platform | **Yes** |
| C7 | Merge coordinator credential model reviewed by security | Security | **Yes** |
| C8 | Classification/egress matrix approved by the data owner | Security / legal | **Yes** |
| C9 | Decision D1–D15 answered (§23 of the spec) | Product + platform | **Yes** |
| C10 | Stage 1 demo (12 packets, one machine, two processes) accepted before any network work | Delivery | **Yes** |
| C11 | Reviewer calibration plan (seeded defects) defined | Quality | No |
| C12 | Cost envelope per program agreed with finance | Product | No |

C10 is deliberately placed before multi-machine work. The contracts are the risk, not the network.

---

## 9. Verdict

**As a CIO / solution architect: conditional go, 10–14 engineer-weeks for Stages 1–4, plus the 6–8 weeks of Phase 5 prerequisites.**

Why go:

- The codebase already contains the expensive, hard-to-retrofit pieces: authenticated federation with OIDC, A2A interop, real worktree isolation with diff measurement, a bounded live fan-out scheduler, a hash-chained audit log, and a sandbox. The plan extends them instead of replacing them.
- The category is defensible and not crowded: coordination with evidence, not another coding assistant.
- The decomposition into a program lifecycle with Phase 5 runs as leaves preserves every gate guarantee already specified.
- The plan refuses the four things that would make it unauditable: runtime departments, worker merge rights, unbounded scale claims, and self-review.

Why conditional, not unconditional:

- Four hard prerequisites are Phase 5 work that does not exist yet. Starting Stage 1 early produces a distributed system with no gates — the exact failure mode the strategy warns about.
- Two live defects (F1, F2) turn a grid into a system that can report delivery of work that never happened.
- The merge coordinator's serialization sets the ceiling at 6–12 packets/hour, which is a real product constraint that sales must know before promising anything.

Why the Copilot draft is not adopted wholesale:

- It solves a generic distributed-agent problem, not this codebase's. It would have rebuilt transport, identity, and worktree isolation that already exist, while omitting leases, fencing, classification, review independence, and integration testing — the five things that decide whether the grid is trustworthy.
- Its organizational runtime is a second authority model beside Phase 5's, which is the one architectural mistake that would be expensive to reverse.

**The plan is an upgrade, not a reimplementation.** Every claim above maps to a file that exists or a contract Phase 5 already defines. The work is real, and so is the gap.

---

## 10. Recommended next actions

1. Answer C1–C5 in the Phase 5 review; they are the gate.
2. Resolve D1–D15; D1, D3, and D7 shape the architecture most.
3. Build Stage 1 on one machine with two worker processes, and refuse to start Stage 2 until its 12-packet demo passes.
4. Instrument from day one: packet cycle time, lease expiry, review latency, conflict rate, false-pass rate.
5. Re-review this document after Stage 2 with measured numbers; expect the scale claim and the capacity model to change.
