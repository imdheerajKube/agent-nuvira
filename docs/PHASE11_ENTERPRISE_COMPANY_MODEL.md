# Phase 11 — The Company Model

## Departments, node pool management, selection, and CIO-level delivery governance

| Field | Value |
|---|---|
| Status | Draft 1.0 for Phase 5 review |
| Version | 1.0 |
| Extends | [`PHASE11_DISTRIBUTED_AGENT_GRID.md`](./PHASE11_DISTRIBUTED_AGENT_GRID.md) §6, §8, §9, §16 |
| Strategy | [`PHASE11_ADG_STRATEGY.md`](./PHASE11_ADG_STRATEGY.md) |
| Review | [`PHASE11_ADG_REVIEW.md`](./PHASE11_ADG_REVIEW.md) |
| Decisions | [`PHASE11_DECISIONS.md`](./PHASE11_DECISIONS.md) |

---

## 1. The claim this document has to make honest

The ask is not "distribute coding across laptops". It is:

> A complete software company, where development, testing, security, operations, documentation, and release are distributed across the connected nodes; the agent acts as CIO/CTO; and there is real node management and selection — which nodes out of all connected nodes get leveraged for a given program, and why.

That is a stronger claim than Phase 11's specification made. This document is the honest version of it, and it has one rule:

> **Every department must reduce to something enforceable, or it is decoration.**

The specification's §6 already establishes the shape: a department is a **policy scope**, a **capability pool**, and an **accountability record**. It is not a process, a thread, or a runtime object. This document fills that shape in completely — eleven departments, the handoff contract between each pair, the node pool that supplies them, the selection algorithm that picks nodes, and the CIO layer that reports on delivery.

---

## 2. Why the company analogy is the right frame — and its exact limit

A company works because of four separations that agents do not have by default:

| Separation | What it prevents | The agent equivalent |
|---|---|---|
| Plan vs. build | Building the wrong thing confidently | Program plan → packets, gated before execution |
| Build vs. test | Testing what you built instead of what was asked | Test packets derived from acceptance criteria, not from the diff |
| Build vs. review | Approving your own assumption | Review on a different node with a different capability |
| Build vs. release | Shipping whatever passed locally | Sole-writer merge coordinator + integration suite |

The limit: a company also has **accountability** — a person whose name is on the failure. An agent organization has none unless we manufacture it. We manufacture it with three artifacts: the **decision record**, the **evidence bundle**, and the **named approver**. Every gate that matters produces all three.

Consequence: we do not build "departments that talk to each other". We build **typed handoffs with gates**, and we *label* the resulting pools with department names because operators and buyers think in those terms.

---

## 3. The eleven departments

Each row is a policy scope. The `scopes` column is the concrete selector that resolves to nodes; `owns` is the gate set that scope may fail or pass; `produces` is the artifact type the scope must emit.

| # | Department | Capability tag | Consumes | Produces (typed) | Owns gates | Default model profile |
|---|---|---|---|---|---|---|
| 1 | Product / Portfolio | `product` | Goal, market constraints, budget | `ProgramBrief`, `AcceptanceCriteria`, `ScopeBoundary` | G0 intake | reasoning, high context |
| 2 | Architecture | `architecture` | ProgramBrief, repo map | `ArchitectureDecision`, `InterfaceContract`, `SchemaContract`, `DependencyOrder` | G1 contract freeze | reasoning, long context |
| 3 | Design / UX | `design` | AcceptanceCriteria, design system | `UXFlow`, `ComponentSpec`, `A11yChecklist` | G2 design review | multimodal preferred |
| 4 | Implementation | `impl:backend`, `impl:frontend`, `impl:data`, `impl:mobile` | InterfaceContract, packets | `PatchArtifact`, `UnitTests`, `ChangeNote` | none (gated downstream) | code-strong, fast |
| 5 | Test engineering | `qa` | AcceptanceCriteria, InterfaceContract (**not** the patch) | `TestPlan`, `TestSuite`, `CoverageDelta`, `DefectReport` | G3 test adequacy | code-strong, adversarial |
| 6 | Security / AppSec | `security` | InterfaceContract, PatchArtifact, threat model | `ThreatModel`, `SecurityReview`, `Finding[]` | G4 security | reasoning, low temperature |
| 7 | SRE / Platform / Ops | `sre` | ArchitectureDecision, runtime config | `Runbook`, `InfraChange`, `RollbackPlan`, `SLOSpec` | G5 operability | reasoning + tool-strong |
| 8 | Documentation | `docs` | InterfaceContract, PatchArtifact, Runbook | `UserDoc`, `APIDoc`, `Changelog` | G6 docs completeness | long context, cheap |
| 9 | Data / Analytics | `data` | SchemaContract, events | `MigrationScript`, `MetricSpec`, `DataQualityCheck` | G7 data safety | code + reasoning |
| 10 | Release / Delivery | `release` | All evidence artifacts | `ReleaseCandidate`, `EvidenceBundle`, `ReleaseNote` | G8 release readiness | low creativity, strict |
| 11 | Support / Incidental | `support` | DefectReport, telemetry | `TriageNote`, `FixPacket` | none (re-enters at 4) | balanced |

### 3.1 What each department is *not*

| Anti-pattern | Why it fails |
|---|---|
| A department as a long-running agent process | It accumulates context, drifts from its scope, and becomes a second source of truth. Departments are selectors, not processes |
| A department that can pass its own gate | Test engineering that consumes the patch approves the patch. That is the review-bias failure at organisational scale |
| A department defined by a model | Departments outlive models. `security` is a gate set, not "the Claude laptop" |
| A department with unlimited authority | Every department is bounded by the authority lattice (§13 of the spec); none can waive another's gate |

### 3.2 The one rule that makes this a company and not a swarm

> **No department may produce the evidence for its own gate.**

Implementation: gate evaluation requires `producerNode != evaluatorNode` **and** `producerCapability != evaluatorCapability`, both enforced by scoped tokens (§13.2), not by prompt text. Test packets are generated from `AcceptanceCriteria` and `InterfaceContract`, never from the diff — so QA cannot be captured by the implementation.

---

## 4. Handoff contracts

The company is only as good as its handoffs. Each edge below is a typed artifact with a schema, an owner, and a rejection reason.

```text
Goal
 └─[1 Product]→ ProgramBrief + AcceptanceCriteria
      └─[2 Architecture]→ InterfaceContract + SchemaContract + DependencyOrder
           ├─[3 Design]→ ComponentSpec ──────────────┐
           ├─[4 Implementation]→ PatchArtifact ──────┤
           │     ├─[5 QA]→ TestSuite + DefectReport  │
           │     ├─[6 Security]→ SecurityReview      │
           │     ├─[7 SRE]→ Runbook + RollbackPlan   │
           │     ├─[8 Docs]→ UserDoc + Changelog     │
           │     └─[9 Data]→ MigrationScript         │
           └──────────────[10 Release]→ ReleaseCandidate + EvidenceBundle
                                   └─[11 Support]→ TriageNote (re-entry)
```

### 4.1 Handoff rules

| Rule | Statement | Enforcement |
|---|---|---|
| H1 | A consumer may not start until the producer's artifact is `accepted` | Scheduler dependency edge on artifact state, not on task state |
| H2 | A handoff carries a schema version; mismatch is a hard reject | JSON Schema validation at the broker |
| H3 | A handoff may not exceed a size bound (2,000 tokens of prose, 50KB structured) | Broker rejects; forces normalisation, not truncation |
| H4 | A rejection names the failed field and the expected shape | Rejection schema; free-text rejections are invalid |
| H5 | Every handoff is content-addressed and ledgered | §11 of the spec |

H1 is the one that prevents the classic multi-agent failure: four workers start from a half-written contract and produce four incompatible systems. The contract is frozen by G1 before any implementation packet is admitted.

---

## 5. Node pool management

This is the part the ask names explicitly: **all connected nodes are not the same as the nodes leveraged.** The pool is managed in five layers.

### 5.1 Enrollment (never automatic)

1. Operator issues a one-time join token scoped to one tenant and one program class, TTL 30 min.
2. Node generates a keypair; private key never leaves the machine.
3. Handshake presents node id, public key, descriptor, and a signed capability claim.
4. Control plane verifies the claim where it can (`git --version`, model endpoint reachability, disk free) — **a claim it cannot verify is recorded as `unverified`, not trusted**.
5. Node receives a scoped capability token, a policy bundle, and its lease budget.

Revocation is immediate and does not require the node's cooperation: token expiry + lease revocation + mirror credential rotation.

### 5.2 The descriptor (what selection actually reads)

```jsonc
{
  "nodeId": "laptop-04",
  "tenant": "acme",
  "trust": "managed",              // managed | byod | untrusted
  "capabilities": ["impl:backend", "qa", "docs"],
  "models": [
    { "id": "qwen3-coder-30b", "where": "local", "ctx": 65536, "tps": 42, "costPerMTok": 0 },
    { "id": "claude-sonnet", "where": "cloud", "ctx": 200000, "costPerMTok": 3.0 }
  ],
  "tools": ["git", "node", "npm", "docker"],
  "resources": { "cpu": 8, "ramGb": 32, "diskFreeGb": 120 },
  "slots": 3,                      // concurrent packets, enforced (F2)
  "availability": { "window": "09:00-19:00", "timezone": "Asia/Kolkata" },
  "dataCeiling": "confidential",   // cannot receive restricted
  "reliability": { "ewmaSuccess": 0.94, "p50PacketMin": 22, "samples": 140 }
}
```

`reliability` is **measured, never declared**. A node that advertises `0.99` and delivers `0.7` is corrected by the ledger.

### 5.3 Lifecycle states

```text
enrolled → healthy → degraded → draining → quarantined → revoked
                ↑         │          │
                └─────────┴──────────┘   (recovery requires a passing probe)
```

| State | Accepts new packets | Runs existing | Trigger |
|---|---|---|---|
| `healthy` | yes | yes | heartbeat + probe pass |
| `degraded` | only if `degradedPolicy=allow` | yes | success EWMA < 0.85 or latency p50 > 2× baseline |
| `draining` | no | yes, with a deadline | operator action or program wind-down |
| `quarantined` | no | no (leases revoked, artifacts marked `unverified`) | trust violation, failed verification, or 3 consecutive false successes |
| `revoked` | no | no | operator or security |

`quarantined` is the state the Copilot-style design lacks, and it is the one that matters: a node that lies about success must not simply be retried.

### 5.4 Quotas, reservations, and fairness

| Control | Purpose | Default |
|---|---|---|
| Per-node slot quota | Stop one node starving the program (F2) | descriptor `slots` |
| Per-program reservation | A critical program keeps capacity when a batch program floods | 0 unless set |
| Per-tenant ceiling | Multi-tenant safety | configured |
| Per-node packet budget | Cost containment on metered models | program envelope ÷ nodes |
| Fair-share between programs | Two programs do not deadlock each other | weighted round-robin |

### 5.5 Pool views the operator needs

| View | Question answered |
|---|---|
| Fleet | Which nodes are healthy, what they can do, what they cost, what they are running |
| Capacity | If I start this program now, how many packets/hour, at what cost, finishing when |
| Coverage | Which required capability has zero healthy nodes (the blocker view) |
| Provenance | Which node produced each artifact, and what its reliability was at the time |
| Trust | Which nodes can receive which classification (the compliance view) |

---

## 6. Node selection: the algorithm

Selection is where "which nodes out of all connected nodes" is answered. It is a **hard filter followed by a deterministic score**, never a model's judgement.

### 6.1 Phase A — hard filters (non-negotiable)

A node is eligible only if all hold:

1. `trust` tier ≥ the packet's required tier;
2. `dataCeiling` ≥ packet classification (and no egress if `restricted`);
3. capability tag present (or an explicitly allowed compatible tag);
4. required model capability present (context ≥ packet estimate, tool support);
5. `slots - inFlight > 0`;
6. availability window covers the expected finish, not just the start;
7. no path-lock conflict with an in-flight packet (§10.3 of the spec);
8. not `quarantined`/`revoked`.

If no node passes, the packet waits — it does **not** downgrade. A `restricted` packet with no eligible node is an escalation to the operator, never a silent reroute to a cloud model.

### 6.2 Phase B — scoring

```text
score = 0.30 · capabilityFit
      + 0.20 · modelFit
      + 0.15 · reliabilityEWMA
      + 0.15 · loadHeadroom
      + 0.10 · costEfficiency
      - 0.10 · latencyPenalty
```

| Term | Definition |
|---|---|
| `capabilityFit` | exact tag 1.0, compatible tag 0.6, adjacent 0.3 |
| `modelFit` | 1.0 if the packet's required context and tool use are satisfied at ≤70% of the model's limit, else 0.5 |
| `reliabilityEWMA` | measured success rate, windowed, with a cold-start prior of 0.8 and `samples` reported |
| `loadHeadroom` | `(slots - inFlight) / slots` |
| `costEfficiency` | 1 − normalised expected cost versus the cheapest eligible node |
| `latencyPenalty` | normalised recent p50 packet time |

Deterministic tie-break: `(score, -reliability, nodeId)` — so the same pool always produces the same assignment, which makes incidents reproducible.

### 6.3 Deliberate diversity

Review assignment uses the same filter with **two extra constraints**: `nodeId` must differ from the producer, and `modelFamily` must differ where a second family exists. If it does not exist, the review is recorded as `same-family`, and that fact appears in the evidence bundle rather than being hidden.

### 6.4 Operator overrides

| Override | Effect | Audit |
|---|---|---|
| `pin <node>` | Packet must run there or wait | recorded with reason |
| `exclude <node>` | Never for this program | recorded |
| `reserve <node> <program>` | Node only serves that program | recorded |
| `trust <node> <tier>` | Raise/lower tier | requires named approver |
| `drain <node>` | Finish current, accept none | recorded |

Overrides are the operator's authority, not the planner's. A planner proposing an override is a security event.

### 6.5 The selection anti-patterns we explicitly reject

| Anti-pattern | Failure |
|---|---|
| "Send to all nodes" | Duplicate work, conflicting patches, cost multiplication |
| Round-robin | Ignores capability and trust; sends `restricted` work to a `byod` laptop |
| Biggest-model-first | Starves the pool and ignores cost |
| Model decides the assignment | Unreproducible, unexplainable, unauditable |
| Silent fallback to a weaker node | Passes a gate with lower evidence quality and no record |

---

## 7. Program formation: the operator workflow

This is the concrete answer to "select what all nodes are going to be leveraged".

```text
1. Program intake        goal, repo, deadline, budget, classification ceiling
2. Draft plan            packages + dependency graph + critical path  (no execution)
3. Pool preview          eligible nodes after hard filters, with the reason each excluded node failed
4. Reserve               pin / exclude / reserve nodes; set per-node budget
5. Capacity preview      packets/hour, P50/P80 finish, cost range   ← the honest 3–5×
6. Approve               named human; plan frozen
7. Execute               broker + leases + review + merge
8. Review board          escalate 3–5 decisions, approve release
9. Evidence bundle       artifacts, hashes, gates, waivers, cost reconciliation
```

Step 3 is the one that earns trust: **every excluded node gets a reason** (`trust below packet tier`, `no security capability`, `dataCeiling=public`, `slots full until 14:20`). An operator who cannot see why a laptop was left out will assume the system is arbitrary.

Step 5 is deliberately unromantic. The preview computes from measured node throughput and the merge coordinator's serialization, so it usually shows something like:

```text
20 eligible nodes · 41 slots · 47 packets
critical path: 9 packets
projected: 6.8–9.4 h (P50–P80)  ·  cost: $41–$58  ·  merge-bound after packet 31
```

`merge-bound` is the phrase that prevents the "20×" expectation. It is a feature.

---

## 8. The CIO / CTO layer

The agent acting as CIO is not a persona. It is a **reporting and authority contract**.

### 8.1 What the CIO layer owns

| Function | Artifact | Cadence |
|---|---|---|
| Portfolio intake and prioritisation | `PortfolioDecision` | per program |
| Business case and budget envelope | `ProgramBudget` | per program |
| Delivery forecast | `Forecast` (P50/P80, critical path, assumptions) | daily |
| Risk register | `RiskEntry[]` with owner, trigger, mitigation | continuous |
| Quality bar | `QualityReport` (defect escape, false-pass, review depth) | per release |
| Change control | `ChangeRequest` + impact analysis | per scope change |
| Escalation | `Escalation` to a named human with a decision deadline | as needed |
| Board report | `DeliveryReport` | weekly |

### 8.2 Delegated authority matrix

The CIO agent may decide **within** these bounds without asking. Outside them, it escalates.

| Decision | Agent may decide | Requires human |
|---|---|---|
| Reorder non-critical packets | yes | — |
| Reassign a packet to another eligible node | yes | — |
| Extend a program by ≤10% of budget | yes, logged | — |
| Change an interface contract after freeze | no | yes (architect) |
| Waive any gate | no | yes (named approver, waiver artifact) |
| Merge to the release branch | coordinator executes | human approves the release candidate |
| Change a node's trust tier | no | yes (security) |
| Add a node to a `restricted` program | no | yes (data owner) |
| Declare the program `delivered` | no | human signature on the evidence bundle |

The last row is the one that keeps the product honest. The system can *recommend* delivery; it cannot *decide* it.

### 8.3 The five weekly questions, and the metric that answers each

A CTO does not ask for a status colour. They ask:

| Question | Metric | Source |
|---|---|---|
| Will it land? | Forecast P80 vs deadline, with the assumption that changed | critical path + measured throughput |
| Is it any good? | Defect escape rate; false-pass rate; review depth (lines reviewed, findings per 100 lines) | ledger + review records |
| What is at risk? | Top 3 risks by expected impact, each with a trigger already observed or not | risk register |
| What does it cost? | Spend vs envelope, cost per merged packet, cost per accepted requirement | cost ledger |
| What did we learn? | Lessons promoted, regressions caught, nodes quarantined | experience store |

Every one of those is computable from Phase 11's ledger. None of them is a model's summary. That distinction is the product.

### 8.4 Delivery assurance gates (program level)

```text
P0 intake      goal is testable; acceptance criteria exist; budget set
P1 contract    interface + schema frozen; dependency order acyclic
P2 capacity    eligible nodes cover every required capability at the forecast
P3 mid-flight  forecast within tolerance OR a re-plan approved
P4 pre-release all packet gates green; integration suite green; zero open blockers
P5 release     human signature; evidence bundle complete; rollback rehearsed
```

A program that cannot pass P2 does not start. That single rule prevents most multi-node failures, because it catches "we have no security node" before 40 packets are in flight.

---

## 9. Governance across departments

| Control | Statement | Mechanism |
|---|---|---|
| Segregation of duties | Producer ≠ reviewer ≠ releaser | Token scopes; the three actions need three distinct node identities |
| Four-eyes on waivers | Any gate waiver needs a human and a reason | Waiver artifact with approver id and expiry |
| Least privilege | A node holds only the tokens its current packet needs | Per-lease token minting, TTL = lease |
| Data classification | Department cannot raise a packet's ceiling | `dataCeiling` checked at admission and at egress |
| Tenant isolation | One tenant's nodes never serve another's packets | Broker partition + token audience |
| Change control | Contract changes after freeze are versioned | `InterfaceContract.v2`, dependents re-gated |
| Audit | Every decision reconstructable without the dashboard | Hash-chained ledger + CEF export |

---

## 10. What this adds to the specification, in one table

| Specification section | What this document adds |
|---|---|
| §6 Organizational model | The eleven departments with inputs, outputs, gates, and model profiles |
| §8 Node model | Enrollment ceremony, lifecycle states including `quarantined`, measured reliability, `dataCeiling` |
| §9 Scheduling | The two-phase selection algorithm, diversity constraint, operator overrides |
| §16 Dashboard | Fleet, capacity, coverage, provenance, trust views; the program-formation workflow |
| §13 Governance | Delegated authority matrix and the P0–P5 delivery gates |
| (new) | The CIO reporting contract: eight artifacts, five weekly questions |

It does **not** add new lifecycle stages. Departments still resolve to packets; packets are still Phase 5 runs.

---

## 11. Committed vs deferred

| Committed in Phase 11 | Deferred |
|---|---|
| Eleven department scopes as selectors | Autonomous department heads |
| Node enrollment, lifecycle, quarantine | Cross-tenant node sharing |
| Two-phase selection with measured reliability | Predictive scheduling from historical patterns |
| Program formation workflow + capacity preview | Automatic budget reallocation between programs |
| CIO reporting artifacts and P0–P5 gates | Portfolio-level optimisation across programs |
| Delegated authority matrix | Agent-initiated contract changes |

The deferred column is mostly Phase 12–14. It is listed so that "we will add it later" is a plan, not a hope.

---

## 12. Acceptance criteria for the company model

| # | Criterion |
|---|---|
| CM1 | Every department resolves to at least one capability tag and one gate; a department with no gate is rejected by the schema |
| CM2 | A packet cannot be admitted to a scope whose gate set it cannot satisfy |
| CM3 | No gate can be evaluated by the producer's node or capability |
| CM4 | Every excluded node in the pool preview shows a machine-readable reason |
| CM5 | Selection is deterministic for an unchanged pool; two runs produce the same assignment |
| CM6 | A `quarantined` node's in-flight artifacts are marked `unverified` and cannot satisfy a gate |
| CM7 | The forecast shows P50 and P80 and names the assumption most likely to break it |
| CM8 | The CIO layer cannot declare delivery, waive a gate, or change a trust tier |
| CM9 | Every weekly-question metric is computable from the ledger without a model call |
| CM10 | A program that fails P2 (capacity coverage) cannot be started without an explicit, logged override |
