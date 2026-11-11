# Phase 11 — Decision Log

## D1–D15 resolved, with owner, reversibility, and what breaks if wrong

| Field | Value |
|---|---|
| Status | Proposed for sign-off at the Phase 5 review |
| Version | 1.0 |
| Source | [`PHASE11_DISTRIBUTED_AGENT_GRID.md`](./PHASE11_DISTRIBUTED_AGENT_GRID.md) §23–24 |
| Rule | A decision without a named owner and a stated cost of reversal is an opinion |

---

## 0. How to read this

Each decision has: **the call**, **why** (grounded in the code or the arithmetic), **owner**, **reversibility** (`one-way` = expensive to undo, `two-way` = cheap), and **if wrong** — the concrete symptom that would tell us.

`one-way` decisions get more scrutiny. There are five, and they are all about authority: who may merge, who may approve, what a department is, whether there is one control plane, and whether the lifecycle gains stages.

---

## 1. Program lifecycle, not new lifecycle stages

**Call:** Phase 11 adds a *program* state machine above Phase 5. A distributed packet is one Phase 5 run. No new stages are added to the coding lifecycle.

**Why:** Phase 5 declares a protected stage graph. Adding `decompose`/`allocate`/`integrate` mutates the contract every existing gate depends on, and forces every gate to reason about two graphs. The program machine has different states (planned, executing, integrating, released) and different owners; binding them into one graph conflates two lifecycles with different failure semantics.

**Owner:** Runtime lead. **Reversibility:** one-way.
**If wrong:** A packet's failure has no unambiguous home — it appears as both a run failure and a program failure, and operators cannot tell which to act on.

---

## 2. Departments are policy scopes, not runtime objects

**Call:** A department is a policy scope + capability pool + gate set + accountable artifact set. No department process exists.

**Why:** A runtime department is a second authority model beside Phase 5's gates, and the two will drift. Every decision would need checking against both. The company language survives in the DSL, the dashboard, and the buyer conversation; the enforcement stays in one place.

**Owner:** Architecture. **Reversibility:** one-way.
**If wrong:** Operators expect a "QA agent" they can message, and instead find a scope selector. Mitigation is documentation and the dashboard's department view, not a runtime object.

---

## 3. Patch artifacts, not branch pushes

**Call:** Workers submit a patch artifact with a base commit, a diff, test evidence, and a change note. No worker holds a branch-write credential.

**Why:** A branch push is a write to shared state by an unverified actor. Patch artifacts are content-addressed, reviewable, re-appliable, and revocable. They also make the merge coordinator the single writer, which is what makes conflict handling tractable.

**Owner:** Platform. **Reversibility:** two-way (a namespaced-branch mode can be added at 100+ nodes).
**If wrong:** Large binary assets and generated files become awkward. Mitigation: artifact-by-reference for files over the patch threshold (§10.2 of the spec).

---

## 4. Read-only mirror on workers, no write credentials

**Call:** Workers fetch from a bare mirror with a read-only deploy key or anonymous access. The only write credential lives with the merge coordinator.

**Why:** The blast radius of a stolen laptop must be "no repository write", not "one branch". Per-node write keys at 20–30 nodes is 20–30 credentials to rotate and audit, each capable of pushing.

**Owner:** Security. **Reversibility:** one-way.
**If wrong:** A legitimate need to push from a node (e.g. a node that must run a Git hook requiring push) cannot be met. That need should be redesigned, not accommodated.

---

## 5. Docker required only where the work requires it

**Call:** Docker is mandatory for `heavy-cpu`, `gpu`, and `confidential` packets; optional elsewhere.

**Why:** Mandatory Docker excludes the laptops the product is built for. Optional everywhere means a `confidential` packet can run unsandboxed on a machine that also browses the web. The classification decides, not the node's preference.

**Owner:** Platform + security. **Reversibility:** two-way.
**If wrong:** A `standard` packet does something destructive on a shared laptop. Mitigation: worktree isolation plus the path allowlist; escalate that packet class to sandboxed.

---

## 6. One broker in v1

**Call:** A single durable broker process (SQLite-backed, WAL) for v1; sharding is a Stage 5 concern.

**Why:** Sharding a broker before measuring the ceiling adds distributed consensus to a system whose bottleneck is the merge coordinator, not the broker. One broker at 30 nodes is well within SQLite's write throughput with batch commits.

**Owner:** Platform. **Reversibility:** two-way.
**If wrong:** Broker latency appears in packet cycle time at ~40 nodes. The metric to watch is `broker_claim_latency_p95`.

---

## 7. Review independence: different node and different capability

**Call:** A gate that consumes a review requires a different `nodeId` **and** a different capability tag; `high`+ risk also prefers a different model family, recorded when unavailable.

**Why:** Node-only independence is defeated by one node running two capabilities. Capability-only is defeated by two nodes on the same model making the same mistake. The pair is the minimum that is meaningful, and model-family diversity is a preference because a pool may legitimately have one family.

**Owner:** Quality. **Reversibility:** two-way.
**If wrong:** Small pools (3 nodes) cannot satisfy it and stall. Mitigation: a program-scoped `insufficient-diversity` waiver with a named human, which is visible in the evidence bundle rather than silently skipped.

---

## 8. Packet-scoped checkout for confidential and above

**Call:** `confidential` and `restricted` packets receive a sparse checkout of the paths their contract names, not the full repository.

**Why:** Egress and cost. A UI packet has no reason to hold the payroll module. The contract already names its paths, so the scope is derivable, not guessed.

**Owner:** Security + platform. **Reversibility:** two-way.
**If wrong:** A packet needs an unlisted path and fails mid-run. Mitigation: the failure is explicit (`path not in packet scope`), the packet is re-planned, and the contract is corrected — which is the right outcome.

---

## 9. Program-level integration test set

**Call:** The integration suite is defined at plan time from acceptance criteria and the contract, owned by the program, and run by the merge coordinator after every merge.

**Why:** Per-packet tests cannot see cross-packet breakage, which is the dominant failure mode in distributed implementation. The suite must exist before the first merge or the fifth merge is where the program breaks.

**Owner:** Quality. **Reversibility:** two-way.
**If wrong:** The suite is expensive and slows merges. Mitigation: tier it — a 60-second smoke set on every merge, the full set before release.

---

## 10. Latency-first default cost mode

**Call:** Programs default to `latency` cost mode; `cost` mode is a program-level switch.

**Why:** First-run experience decides adoption. A cost-first default makes the demo slow and the product feel worse than a single agent. Enterprises that care flip the switch and get the ledger either way.

**Owner:** Product. **Reversibility:** two-way.
**If wrong:** Spend is higher than expected on first programs. Mitigation: the program envelope is always shown at intake, and the capacity preview includes cost.

---

## 11. Lease TTL = 3× expected, capped at 90 minutes

**Call:** `leaseTtl = min(90m, 3 × expectedPacketMinutes)`, with heartbeat renewal and explicit extension.

**Why:** A fixed 30 minutes kills legitimate builds (a full test suite plus a migration can exceed it). A very long TTL turns a crashed node into a 4-hour stall. Three times expected plus renewal handles both, and the cap bounds the worst case.

**Owner:** Platform. **Reversibility:** two-way.
**If wrong:** Long packets expire mid-run and re-execute. Metric: `lease_expired_while_healthy_total` must stay near zero; if it rises, the multiplier is wrong for that class.

---

## 12. No HA control plane in v1

**Call:** One Prime. Restart and resume; no second control plane, no leader election.

**Why:** HA doubles Stage 3 and introduces split-brain, which needs consensus, which needs a quorum design. At 5–30 nodes the availability requirement is "restart in a minute without losing work", which is a durable broker and idempotent resume — not HA.

**Owner:** Architecture. **Reversibility:** one-way for the schema (it must be written so a future leader epoch is addable).
**If wrong:** A Prime crash during a customer demo costs minutes. Mitigation: supervisor restart, resume, and a documented recovery runbook; the schema carries a `controlEpoch` field from day one so fencing survives a future HA design.

---

## 13. Phase 11 after Phase 5–8

**Call:** Phase 11 follows Phase 5 (lifecycle), 6 (marketplace), 7 (capability intelligence), 8 (enterprise governance). It does not merge into Phase 5.

**Why:** Phase 11's prerequisites are Phase 5 artifacts; its governance inherits Phase 8; its packet selection uses Phase 7's capability signals. Merging it into Phase 5 would put a distributed system inside a lifecycle change, which is two risk classes in one release.

**Owner:** Product. **Reversibility:** two-way.
**If wrong:** A competitor ships distribution first. That is a market risk, not an engineering one, and shipping a gate-less grid first is the worse trade.

---

## 14. Phases 12–15 are horizons, not commitments

**Call:** One paragraph each in the roadmap, no specification, no estimate.

**Why:** A roadmap that commits to five phases at once stops being believed after the second slip. Each of 12–15 needs its own design (departments at scale, autonomous programs, organisational intelligence, inter-company mesh) and its own proof.

**Owner:** Product. **Reversibility:** two-way.
**If wrong:** Buyers ask "what about autonomous departments?" and get a horizon answer. That is a better conversation than a date that will move.

---

## 15. Extend the federation envelope; do not build a new protocol

**Call:** Add `grid/*` payload types and a `grid` capability flag to the existing federation protocol; a v1 peer that does not advertise the flag is never offered a packet.

**Why:** A second protocol means a second authentication path, a second identity model, and two ways to be wrong about who a node is. The existing handshake already supports secret and OIDC, and the A2A surface already provides discovery.

**Owner:** Federation. **Reversibility:** one-way (peers will depend on it).
**If wrong:** The envelope cannot express a future need (e.g. streaming artifacts) and a v2 is required. Mitigation: the envelope carries a version field and unknown payload types are rejected rather than dropped.

---

## 16. Open questions — provisional answers

The eight open questions in §24 need answers before Stage 1. These are the recommended answers; each is marked with what would confirm or refute it.

| # | Question | Provisional answer | Confirmation needed |
|---|---|---|---|
| O1 | Stage seam shape | A `LifecycleSeam[]` injected into the pipeline at `after:plan`, `before:edit`, `after:verify`; fail-closed; recorded in the audit trail | Stage 1 can block a worker at `after:plan` without forking the pipeline |
| O2 | Worktree enforcement | `NUVIRA_ISOLATE` mandatory for every lifecycle run, not only grid packets | A misconfigured run must fail, not write to the live tree |
| O3 | Artifact store location | Prime-local content-addressed store for v1; shared volume is a Stage 3 option | A laptop joins over HTTPS with no VPN |
| O4 | Dedicated DB | Share the engine, separate the file (`grid.db`) | Failure isolation holds: a corrupt grid DB does not block lifecycle reads |
| O5 | Review authority | Reviewer verdict feeds the Phase 5 review gate directly | A model cannot re-interpret a failed review into a pass |
| O6 | Trust tiers | Grid-only concept; `organization` is the ceiling | Phase 5 trust levels need no change |
| O7 | Waiver authority | Program-scoped waiver, named approver, expiring, visible in the bundle | A waiver cannot silently cover a later packet |
| O8 | Model allowlist | Org policy with local-model opt-in | A `byod` node cannot route `confidential` to a cloud provider |

**Owner for all eight:** Runtime lead, with security co-sign on O2, O5, O7, O8.

---

## 17. Sign-off block

| Decision | Owner | Status | Date |
|---|---|---|---|
| D1 program lifecycle | Runtime | proposed | — |
| D2 departments as scopes | Architecture | proposed | — |
| D3 patch artifacts | Platform | proposed | — |
| D4 read-only mirror | Security | proposed | — |
| D5 conditional Docker | Platform | proposed | — |
| D6 one broker | Platform | proposed | — |
| D7 review independence | Quality | proposed | — |
| D8 packet-scoped checkout | Security | proposed | — |
| D9 program integration suite | Quality | proposed | — |
| D10 latency default | Product | proposed | — |
| D11 lease TTL | Platform | proposed | — |
| D12 no HA | Architecture | proposed | — |
| D13 roadmap position | Product | proposed | — |
| D14 horizons | Product | proposed | — |
| D15 protocol extension | Federation | proposed | — |
| D16 ledger timing | Quality | proposed | — |
| O1–O8 | Runtime (+security) | provisional | — |

A decision is `accepted` only when the owner writes their name and a date. Until then it is a proposal with a recommendation, which is what this document is.

---

## 18. Addendum — when the improvement ledger is built (D16)

**Decision:** the M6 improvement ledger is **not** built in Phase 11. Phase 11/Stage 1 ships an append-only **observation stream** (one record per packet: size, file count, attempts, gate outcome, reviewer, cost). The **ledger v1** — hash chain, signatures, authority diff, preregistration refs, promotion gate — is WP2 of the Phase 12 upgrade programme, preceded by WP1 (authority manifest) and accompanied by WP3 (replay corpus).

**Why:** three reasons, in order of weight.

1. The ledger's load-bearing fields (`evalSetHash`, `preregistrationId`, `authorityDiff`, `reviewerNode`) only have referents once WP4 and WP5 exist. Freezing them earlier guarantees a migration, and a migrated ledger is weaker evidence than one that never had to reinterpret its own history.
2. A ledger with no promotion path is a liability disguised as governance: it makes the product look more accountable than it is.
3. The genuinely irreversible thing is **data**, not machinery. Packet-level outcomes that were never recorded cannot be reconstructed; a decision can be reconstructed from a changelog.

**Reversibility:** cheap. Schema v0 is append-only JSONL and a strict subset of the v1 record, so v1 reads v0 without transformation.

**If wrong:** if a promotion can be recorded without any WP4/WP5 artefact, the split was wrong and the ledger must move earlier. That is the confirmation test, and it is checkable rather than arguable.

**Owner:** Quality. **Status:** proposed. **Gate:** the first promotion in Phase 12 must be impossible without a v1 record; if it is possible, D16 is withdrawn.
