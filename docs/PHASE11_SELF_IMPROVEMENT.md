# Phase 11 — Self-Improvement and Self-Correction

## Can the agent improve its own working and correct its own mistakes?

| Field | Value |
|---|---|
| Status | Feasibility evaluation, not a commitment |
| Extends | [`PHASE11_DISTRIBUTED_AGENT_GRID.md`](./PHASE11_DISTRIBUTED_AGENT_GRID.md) §12, §16 |
| Company model | [`PHASE11_ENTERPRISE_COMPANY_MODEL.md`](./PHASE11_ENTERPRISE_COMPANY_MODEL.md) |
| Verdict | Levels 1–2 are buildable now; Level 3 is buildable with an eval gate; Level 4 is not |

---

## 1. The question, stated precisely

> Can the agent enhance its own working and correct its own mistakes — evaluated honestly, because an AI agent should be smart, not an `if/else` controller?

The question contains three distinct claims, and conflating them is how this becomes marketing:

| Claim | Meaning | Answerable? |
|---|---|---|
| **Self-correction** | Detects that its own output is wrong and fixes it before claiming success | **Yes, today** — with an execution oracle |
| **Self-improvement** | Changes how it works based on experience, and gets measurably better | **Partly** — for bounded surfaces, with an eval gate |
| **Self-modification** | Rewrites its own code, gates, or objectives | **No** — and should not, in this product |

The rest of this document separates them, says what each requires, and gives a buildable path.

---

## 2. Why "if/else controller" is the wrong criticism — and the right one

A rule engine is deterministic. That is not its flaw. Its flaw is that its **rules were written by someone who already knew the answer**, so it cannot handle a situation the author did not anticipate.

The right criticism of a rule-only agent is:

- it cannot notice that its own rule was wrong;
- it cannot generalise a fix from one failure to a similar one;
- it cannot tell the difference between "the command failed" and "the command succeeded and produced nothing";
- it cannot change its strategy after three identical failures.

Those four are exactly the capabilities we can add without pretending the model is conscious. They are all **evidence-driven loops**, not vibes.

> The intelligence is not in replacing rules with a model. It is in **closing the loop between an action, its measured effect, and the next decision** — and in refusing to let the model be the judge of its own effect.

---

## 3. Five levels, with evidence requirements

| Level | Name | What changes | Oracle | Status |
|---|---|---|---|---|
| **L0** | Static policy | Nothing | None | Today's baseline |
| **L1** | In-run reflection | The next action within one run | Execution: tests, exit codes, files, schemas | **Buildable now** |
| **L2** | Cross-run learning | Retrieved lessons, routing, thresholds | Labelled outcomes from the ledger | **Buildable now** |
| **L3** | Evidence-gated adaptation | Prompts, decomposition heuristics, selection weights | Held-out eval set + no regression | **Buildable, gated** |
| **L4** | Self-modification | Its own code, gates, authority, objectives | None trustworthy | **Rejected** |

### 3.1 L1 — in-run reflection (buildable now)

The loop:

```text
act → observe effect → compare to the packet's stated acceptance →
  if mismatch: form ONE hypothesis → change ONE thing → re-observe
  if three hypotheses fail: stop, report, escalate — do not thrash
```

Three properties make this real rather than theatrical:

1. **Effect, not narrative.** `src/utils/effect-verification.ts` already signals children and measures effect; the pattern generalises: a claim of "tests pass" is only accepted if the test runner's own output says so.
2. **One variable at a time.** Changing three things and succeeding teaches nothing.
3. **A stop rule.** Bounded attempts, then escalate with the evidence collected. Unbounded self-repair is how agents burn a budget proving they are stuck.

The existing failure this fixes is already documented in the codebase: commands killed mid-run whose partial output was reported as failure, and a success claimed from an exit code while the artifact was empty (`gateway/heartbeat.ts`, `steering/store.ts`, and the false-success RCA all record variants).

### 3.2 L2 — cross-run learning (buildable now)

The loop:

```text
run → outcome label (hard evidence: gate result, test result, human verdict)
    → lesson extracted in a BOUNDED schema
    → stored with applicability conditions
    → retrieved at plan time when conditions match
    → measured: did applying it change the outcome?
```

The repository already contains the seed: `src/learning/failure-lessons.ts` stores lessons with `applicableDomains` and a description; `src/learning/model-registry.ts` already decays `errorRate` and records partial deaths per provider/model; `src/agents/checkpoint-store.ts` already resumes after a crash.

What is missing is the **feedback edge**: nothing currently measures whether a lesson, once applied, improved the outcome. Without that edge, "learning" is a growing pile of plausible advice — which is worse than none, because it consumes context and can be wrong.

Lesson schema (bounded on purpose):

```jsonc
{
  "id": "L-0142",
  "trigger": { "capability": "impl:backend", "errorClass": "schema-mismatch", "framework": "express" },
  "claim": "When a migration adds a NOT NULL column, existing rows fail; add the column nullable, backfill, then constrain.",
  "evidence": { "runs": 4, "successAfter": 4, "successBefore": 0 },
  "cost": 180,
  "status": "candidate" | "promoted" | "retired",
  "scope": "org" | "tenant" | "program"
}
```

Retirement matters as much as promotion. A lesson that stops working must leave the retrieval set, or the agent becomes confidently obsolete.

### 3.3 L3 — evidence-gated adaptation (buildable, gated)

Allowed surfaces, in order of safety:

| Surface | Change | Gate |
|---|---|---|
| Retrieval weights | How much a lesson counts | Eval set, no regression |
| Model routing | Which model gets which packet class | Cost + quality parity on held-out tasks |
| Decomposition heuristics | Preferred packet size, split rules | Replay 10 historical programs; no new rejections |
| Prompt fragments | Wording of a step instruction | Held-out eval, blind judge or execution oracle |
| Selection weights | Capability/reliability/cost balance | Replay assignment quality on the ledger |

Forbidden surfaces, permanently:

- gate definitions and pass thresholds;
- security policy, egress rules, trust tiers;
- its own eval set or judge;
- authority: what it may do without a human;
- the ledger and audit chain.

### 3.4 L4 — self-modification (rejected)

Not because it is impossible, but because **the oracle problem is unsolved**. An agent that can edit its own gates will eventually edit the gate that was catching its mistake, and it will have a plausible reason. Every real system that allows this (continuous deployment, auto-tuning) either keeps the oracle outside the system or pays for it with periodic, human-visible failures.

In this product the oracle is the customer's acceptance criteria and the release gate. Those are exactly what must stay outside the agent's reach.

---

## 4. Mistake taxonomy and the correction that actually works

Generic "reflect on your mistake" fails because different mistakes need different oracles.

| Class | Example | Detection | Correction |
|---|---|---|---|
| **Tool error** | Command not found, wrong flag | Non-zero exit + stderr classification | Retry with a corrected invocation; never retry the same string twice |
| **Missing evidence** | "Done" with no artifact | Effect verification: artifact hash, file exists, test output | Block the success claim; re-run the check |
| **Wrong assumption** | Assumed an API shape that is not in the repo | Preflight read of the real definition | Re-read, then revise the plan step |
| **Wrong plan** | Correct code, wrong decomposition | Contract check at packet boundaries | Reject the packet at the seam; re-plan that subtree |
| **Wrong scope** | Built something not asked | Acceptance-criteria trace | Gate failure with the unmet criterion named |
| **False success** | Claimed pass, produced nothing | Independent re-execution on another node | Quarantine the node; mark artifact `unverified` |
| **Regression** | New packet breaks another | Program integration suite | Block the merge; bisect by packet |

Two observations that matter:

1. **Five of the seven are detectable without a better model.** They need measurement, not intelligence. That is why self-correction is a Phase 11 deliverable and not a Phase 14 research bet.
2. **The most dangerous class is false success**, because every other class eventually surfaces as a failure, while false success surfaces as a green tick. Defect F1 in `src/federation/client.ts` is precisely this class, and a false-success detector is the clearest example of the agent correcting itself rather than being told.

---

## 5. The honest limits

| Limit | Consequence | Mitigation |
|---|---|---|
| A model cannot reliably judge its own output | Self-review is weak evidence | Use execution or a different model family; never accept self-judgement as a gate |
| Reflection can rationalise | Confident, wrong explanations | Require that a lesson cite an observable; reject lessons with no evidence pointer |
| Small samples mislead | A lesson promoted on 2 runs is noise | Minimum sample size; confidence interval; cold-start prior |
| Eval sets leak | Adaptation overfits the test | Held-out set, rotated; never visible to the adapting surface |
| Local models are weaker at introspection | Self-correction quality varies by node | Capability-gate the repair loop to models that pass a calibration probe |
| Learning can regress silently | Quality drifts down | Degradation alarm; automatic rollback of the last promoted change |

The fifth row is why L3 is per-node capability, not global: a 7B local model attempting metacognitive repair will produce plausible nonsense, and the system must know that about itself.

---

## 6. What the grid adds: organisational learning

The grid produces something no single agent has: **statistics**. That enables improvements that are not introspection at all:

| Signal | What it improves | Phase |
|---|---|---|
| Packet size vs. rework rate | Decomposition heuristics | 12 |
| Reviewer assignment vs. defect escape | Selection weights | 12 |
| Node reliability over time | Quarantine thresholds, routing | 11 (measurement), 12 (action) |
| Contract-freeze timing vs. conflict rate | Plan sequencing | 12 |
| Model family vs. defect class | Routing | 12 |

This is the legitimate form of "the company learns": not the agent philosophising, but the ledger revealing which arrangement of work produced fewer defects. It is boring, and it is the only version that survives scrutiny.

A concrete example of a promotion decision:

```text
Observation: packets with >6 files had 3.1× the rework rate of packets with ≤6 files (n=412).
Candidate: change the split rule from "≤400 lines" to "≤400 lines AND ≤6 files".
Gate: replay the last 20 programs; compare rework rate and total packets.
Result: rework −34%, packets +9%, wall clock −11%.
Decision: promote, scoped to `impl:*`, with the evidence attached.
```

That is a system improving its own working on evidence. It is not consciousness, and it is not `if/else` — the threshold moved because the ledger said so, and a human can audit the move.

---

## 7. Safety invariants for any self-improvement

| # | Invariant | Why |
|---|---|---|
| S1 | The agent may never change its own gates, thresholds for security, or authority | Otherwise the gate that catches its mistake is the first thing it edits |
| S2 | The oracle is never the agent's own judgement | Execution evidence or an independent evaluator only |
| S3 | Every adaptation is attributed, versioned, and reversible in one action | An unexplained behaviour change is an incident |
| S4 | No adaptation ships without a measured comparison on held-out work | "It feels better" is not a result |
| S5 | Degradation triggers automatic rollback and a quarantine of the adaptation | Learning must not be able to make the product worse quietly |
| S6 | Adaptations never cross a tenant boundary | One customer's lessons are not another's |
| S7 | The ledger records the adaptation that produced each decision | Reconstructability applies to learning too |

S1 and S2 are the pair that separates this from the "self-modifying agent" genre.

---

## 8. Verdict

| Capability | Verdict | Evidence needed | Risk |
|---|---|---|---|
| Detect its own failed command and retry differently | **Yes, build in Phase 11** | Exit code + stderr class + observed effect | Low |
| Detect false success (claimed pass, no artifact) | **Yes, build in Phase 11** | Artifact existence/hash + independent re-run | Low, high value |
| Reflect once with a stated hypothesis, then stop | **Yes, build in Phase 11** | Bounded attempts + recorded hypothesis | Low |
| Learn lessons across runs and retrieve them | **Yes, build in Phase 11/12** | Outcome labels + measured application | Medium (noise) |
| Adapt prompts/routing/weights on evidence | **Yes, Phase 12, gated** | Held-out eval + no-regression | Medium |
| Improve decomposition from program statistics | **Yes, Phase 12** | Replay of historical programs | Medium |
| Rewrite its own gates or authority | **No, never** | — | Unacceptable |
| Open-ended self-modification of core code | **No** | — | Unacceptable |

**Bottom line:** the agent can genuinely get better at its own work — measurably, auditably, and without self-granted authority — provided every improvement has an oracle outside the model. What it cannot do is decide what "better" means for the customer. That boundary is not a limitation of the current models. It is the product.

---

## 9. What to instrument in Phase 11 so Phase 12 is possible

Without these, organisational learning has no data:

1. Every packet's size, file count, duration, attempt count, and gate outcome.
2. Every review: reviewer node, model family, findings, and whether the finding was later confirmed by a test.
3. Every repair loop: hypothesis, change, effect, success.
4. Every lesson applied, and the outcome delta attributed to it.
5. Every node quarantine with the triggering evidence.
6. Every false-success detection, with the artifact that was missing.

The last one is the single most valuable metric in the product. It is also the one no competitor will publish.

---

## 10. How L4 could actually be fixed

The rejection of L4 is not "self-modification is impossible". It is narrower and more useful:

> **The agent cannot be the judge of its own change, and it cannot own the evaluator.**

That is the oracle problem, and it has been solved before — not inside the system being changed, but around it. Continuous deployment solved it with canaries and rollback; compiler optimisation solved it with benchmark suites; safety-critical software solved it with independent verification and a frozen requirements baseline. The pattern is always the same: **move the judgement outside the thing being judged, and make the judgement hard to move.**

So L4 is fixable. What is not fixable is L4 as originally stated — an agent that may rewrite the gate that catches its mistake. The distinction gives us a buildable target.

### 10.1 Five mechanisms that make self-modification safe

| # | Mechanism | What it fixes | What it costs |
|---|---|---|---|
| M1 | **Oracle externalisation** — the evaluator runs outside the agent's process, on a different node, from a hash-pinned copy | Agent cannot edit what judges it | One more service; the seam already exists for review |
| M2 | **Frozen, escrowed eval set** — criteria and corpus are immutable per period; changes need a human and a version | Goalpost moving, eval leakage | Periodic re-baselining is manual |
| M3 | **Authority monotonicity** — a change may never increase the agent's authority set (tools, scopes, gates it can pass, network egress) | The catastrophic class of change | Requires an explicit authority manifest |
| M4 | **Bounded modification surface** — only declared data (prompts, thresholds, weights, heuristics) is modifiable; code, gates, and policy are not | Arbitrary self-rewriting | Less exciting than "the agent edits itself" |
| M5 | **Two-key promotion** — the agent proposes; an independent reviewer node and a named human approve | Self-approval | Human time on each promotion |
| M6 | **Improvement ledger** — every proposal, measurement, promotion and rollback is an append-only, hash-chained record | Forgotten/rewritten history; unattributable behaviour change | Small write path; must be built before the first promotion |

M1 and M2 are the actual fix for the oracle problem. M3 is the safety proof. M4 keeps the blast radius small enough that M1–M3 can be verified. M5 preserves accountability, which is the thing an enterprise is buying.

### 10.2 L4′ — governed self-modification

Define the target precisely so it can be built and tested:

```text
L4′  The agent may propose, measure, and promote changes to its own WORKING
     METHODS (prompts, routing, thresholds, decomposition heuristics), and may
     never change its GATES, its AUTHORITY, its OBJECTIVES, or the EVALUATOR.
```

That is not a downgrade of the ambition; it is the only version with a proof. It is also where most of the value is: the working methods are what make the agent slow, noisy, or expensive. The gates are what make it trustworthy, and they are precisely the part that must not learn.

### 10.3 The pipeline

```text
observe ──► propose ──► replay ──► gate ──► canary ──► promote ──► watch ──► rollback?
  ledger     diff        corpus    stats   5% packets   ledger     drift      one action
```

| Stage | Requirement | Refusal condition |
|---|---|---|
| Observe | A measured deficiency with n and effect size | Anecdote, or n < 30 |
| Propose | A patch artifact touching only the declared surface | Any change to gates, authority, objectives, evaluator |
| Replay | Runs the historical corpus (≥ 50 programs) offline | Any regression on a safety invariant |
| Gate | Non-inferiority on a held-out set, pre-registered metric | Post-hoc metric selection |
| Canary | 5% of packets, one tenant, one program class | Any false-success or gate violation |
| Promote | Two-key: independent reviewer + named human | Missing either key |
| Watch | Drift and regression alarm for 14 days | Alarm → automatic rollback |
| Rollback | One command, restores the prior version and invalidates derived lessons | — |

### 10.4 What would still be impossible — and why that is correct

| Still refused | Reason |
|---|---|
| Changing a gate's threshold or definition | The gate is the customer's acceptance, not the agent's preference |
| Adding a tool, scope, or egress path | Authority must be monotone non-increasing; expansion is a human decision |
| Editing the evaluator or its corpus | The oracle must be outside the optimisation loop |
| Self-approval, or reviewing its own proposal | Producer ≠ reviewer is the whole reason the grid exists |
| Unbounded recursive self-modification | Each change consumes measurement budget; a chain needs a new full evaluation per link |
| Choosing what "better" means | Values are an input, not an output, of the system |

The last row is the boundary that makes the product sellable. An agent that can decide its own success criteria is not autonomous; it is unaccountable.

### 10.5 Statistics that must be pre-registered

Without pre-registration, any result can be called an improvement after the fact.

| Field | Rule |
|---|---|
| Primary metric | exactly one, declared before the run |
| Guardrail metrics | safety invariants and false-success rate; any regression fails |
| Sample | ≥ 30 programs or ≥ 200 packets, whichever comes first |
| Test | non-inferiority at a stated margin, not "looks better" |
| Stopping rule | fixed; no optional stopping |
| Analysis | the same script for every candidate, versioned |

### 10.6 What to build, and when

| Component | Phase | Effort |
|---|---|---|
| Authority manifest + monotonicity check | 12 | 1 week |
| Replay corpus from the ledger | 12 | 1–2 weeks |
| Frozen evaluator service + escrow | 12 | 1–2 weeks |
| Proposal pipeline as patch artifacts | 12 | 1 week |
| Canary + drift watchdog + auto-rollback | 13 | 2 weeks |
| Two-key promotion UI and ledger | 13 | 1 week |

Total: **6–9 engineer-weeks**, and only after L3 has run for a quarter with measured lift. Building the promotion machinery before there is anything worth promoting is how teams end up with a sophisticated process and no improvement.

### 10.7 Acceptance criteria for L4′

| # | Criterion |
|---|---|
| SM1 | A proposal touching a gate, an authority scope, or the evaluator is rejected by schema, not by review |
| SM2 | The authority manifest is diffed on every proposal; any expansion is denied automatically |
| SM3 | The evaluator runs from a hash-pinned copy the agent cannot write |
| SM4 | Promotion requires an independent reviewer node and a named human, both recorded |
| SM5 | Every promotion has a pre-registered metric, sample size, and stopping rule |
| SM6 | A canary regression triggers automatic rollback within one program cycle |
| SM7 | Rollback invalidates lessons derived from the reverted change |
| SM8 | The ledger records proposal → measurement → promotion → rollback as one chain |
| SM9 | A promoted change can be replayed and reproduced from its artifacts |
| SM10 | No self-modification path exists that the agent can invoke without the two keys |

### 10.8 The short answer

You fix L4 by **not letting the agent fix itself**. You give it a bounded, declared surface it may improve; an evaluator it cannot touch, run by something else; a statistical gate fixed before the attempt; a canary; a rollback; and two keys it does not hold. Inside that box, self-improvement is real, measurable, and reversible.

Outside the box, it is an agent editing the test that was catching its bug — and the more capable it is, the more convincing its reason will be.

---

## 11. M6 — the improvement ledger

This section exists because a review of the L4 plan named the missing mechanism, correctly: **every improvement must leave a permanent record**, and the record must be queryable years later by someone who was not there. Without it, self-improvement is a series of undocumented behaviour changes, and "why is routing different from last quarter?" has no answer that is not a guess.

The useful analogy is **git history for the system's own behaviour**. Use that analogy to decide what to copy — content addressing, an append-only chain, a diff between any two states — and where it stops being enough.

### 11.1 What the proposed record lacks

The review's JSON is a summary, not a ledger:

```json
{"proposal":"routing-v11","baseline":"routing-v10","author":"agent",
 "evaluator":"node17","result":"approved","lift":"+8.2%",
 "canary":"successful","rollbackAvailable":true}
```

| Missing | Why the record is unauditable without it |
|---|---|
| `prevHash` / chain | Entries can be edited or deleted after the fact; the ledger becomes a claim, not evidence |
| `proposalDigest`, `baselineDigest` | "routing-v11" is a label. A year later the artifact it named is gone or has moved |
| `evaluatorVersion`, `evalSetHash` | If the oracle changed, the lift number means nothing |
| `datasetHash`, `sample`, `strata` | n and the population are part of the claim; +8.2% on 12 packets is noise |
| `metricDefinition`, `preregistrationId` | Without pre-registration, any result can be called an improvement afterwards |
| `guardrails` | Safety and false-success metrics are pass/fail, not something to average away |
| `cost` | A lift that costs 10× tokens or 3× review load is a regression with a nicer number |
| `scope` | Tenant, department, program class — an improvement in one is not one in another |
| `authorityDiff` | The proof that the change did not expand what the agent may do |
| `reviewers[]`, `approver` | Two keys, named. "author: agent" plus "result: approved" is self-approval with extra steps |
| `status` lifecycle | `approved` is not a state. Proposed → evaluated → canary → promoted → rolled_back / quarantined |
| `rollbackTo`, rollback event | A rollback is a first-class entry, not a deletion of the earlier one |
| `signature` | Attribution, not assertion |

### 11.2 The canonical record

```json
{
  "schema": "nuvira.improvement/1",
  "id": "imp-2026-11-11-0042",
  "prevHash": "sha256:9f2c…",
  "createdAt": "2026-11-11T09:14:02Z",
  "author": { "kind": "agent", "id": "prime@node01", "runId": "run-7f3a" },
  "proposal": {
    "title": "split packets at 6 files as well as 400 lines",
    "surface": "decomposition.thresholds",
    "diff": "sha256:41ab…",
    "baseline": "sha256:0d77…",
    "authorityDiff": { "added": [], "removed": [] }
  },
  "scope": { "tenant": "acme", "department": "impl", "packetClasses": ["impl:api"] },
  "evaluation": {
    "oracle": { "node": "node17", "version": "eval-2026.11.1", "evalSetHash": "sha256:be90…" },
    "dataset": { "hash": "sha256:77c1…", "n": 412, "strata": ["impl:api", "impl:ui"] },
    "preregistrationId": "pre-2026-11-04-003",
    "primaryMetric": { "name": "rework_rate", "delta": -0.34, "ci95": [-0.41, -0.27] },
    "guardrails": { "defectEscapeRate": 0.0, "falseSuccessRate": 0.0, "costPerMergedPacketUsd": -0.02 },
    "cost": { "tokens": 184000, "wallClockMin": 96, "reviewMinutes": 41 }
  },
  "canary": { "cohort": "acme/impl:api", "programs": 4, "verdict": "pass", "alarms": 0 },
  "promotion": {
    "status": "promoted",
    "reviewerNode": "node09",
    "approver": "human:dheeraj",
    "promotedAt": "2026-11-11T11:02:00Z",
    "rollbackTo": "sha256:0d77…"
  },
  "signature": "ed25519:…"
}
```

Two design choices are deliberate:

1. **The record names the oracle, not only the result.** A lift is a statement about a specific evaluator on a specific dataset. Storing the result without both is storing an unfalsifiable claim.
2. **Rollback is an entry, not a rollback of the file.** The chain never shortens. The history of a mistake is an asset.

### 11.3 Storage and write path

| Layer | Holds | Mutability |
|---|---|---|
| Artifacts | proposal and baseline payloads, addressed by digest | content-addressed, immutable |
| Ledger | one JSON record per change, `prevHash` chained | append-only |
| Index | derived SQLite built from the ledger | rebuildable at any time |
| Git | the human-readable diff of code/policy changes | normal git history, linked by digest |

**Only the promotion service writes.** The agent has read access and proposes through the pipeline; it cannot append a `promoted` record to itself. That single rule is what makes the ledger evidence rather than a diary, and it is enforceable with filesystem permissions on the node that hosts it.

### 11.4 Invariants

| # | Invariant |
|---|---|
| L1 | Every promotion has a ledger record; a promotion without one is reverted automatically |
| L2 | Records are append-only and hash-chained; a broken chain quarantines the ledger and blocks promotion |
| L3 | Every record names the oracle version and dataset hash that produced its numbers |
| L4 | A rollback appends a new record and never deletes the original |
| L5 | Records are scoped to a tenant; no cross-tenant consolidation, including for "global" learning |
| L6 | The ledger outlives the model, the provider, and the prompt format — it is the company's memory, not the runtime's |
| L7 | Any promoted change can be replayed from its record alone |

L6 is the one that gets forgotten. Models change every few months; a ledger tied to one model's artefacts becomes unreadable exactly when it becomes valuable.

### 11.5 Query surface

A ledger nobody can query is a log file. The product surface is five questions:

| Command | Question it answers |
|---|---|
| `nuvira ledger show <id>` | What exactly changed, who approved it, on what evidence? |
| `nuvira ledger why <decision-id>` | Which improvement (if any) shaped this decision? |
| `nuvira ledger diff <a> <b>` | What is different in behaviour between these two versions? |
| `nuvira ledger stats --metric false_success_rate --since 90d` | Is the system actually getting better? |
| `nuvira ledger rollback <id>` | Undo it, with a record of the undo |

`why` is the one that changes how the product feels in an audit. Every gate verdict, every routing decision, and every review finding can point at the ledger entry that influenced it; "the agent did it" is never the answer.

### 11.6 What M6 unlocks

- **Cohort analysis** — which packet classes improved, which silently regressed.
- **Attribution** — lift by node, model family, reviewer, and department shape.
- **Capacity planning** — the calibration data for §12's structural changes.
- **Audit in one command** — the enterprise question "prove this change was supervised" has a record, not a narrative.
- **Model migration** — when the model changes, replay the ledger and see which improvements survive.

Cost: roughly **one engineer-week** for schema, chain, write path, and the `show`/`stats`/`rollback` commands — and it must exist before the first promotion, not after. Retrofitting a ledger means reconstructing history from logs, which is exactly the archaeology it is meant to prevent.

---

## 12. Organisational self-improvement

The review's second point is the more important one, and it is a genuine extension rather than a refinement:

```text
Agent improves itself            →  Organization improves itself
prompt / routing / thresholds       lifecycle, structure, composition, review flow
```

That is the larger lever. Prompt optimisation moves a number by a few percent; getting the *shape* of the delivery organisation right can move it by tens of percent, because it changes how much work is in flight, how often packets collide, and how long review waits. The reason to build it carefully is that it is also where measurement becomes much harder.

### 12.1 Why structural changes are harder to prove

| Problem | Consequence |
|---|---|
| Small n | A program is one observation; a handful of programs gives confidence intervals wider than the effect |
| Non-stationary workload | Repos, customers and models change; last quarter is not a control group |
| Interference | Adding workers to one department changes every other department's queue and review load |
| Goodhart | Throughput is trivially gamed by splitting packets; review depth is deferrable; the metric that rises may be the one that is easiest to move |
| Slow reversal | Unlike a prompt, headcount and concurrency touch leases, budgets and human expectations |
| Confounded cost | More nodes usually means faster wall clock and more token spend, merge contention and review load |

A prompt change can be A/B tested in an afternoon on 400 packets. A department-shape change cannot. Pretending otherwise is how "organisational optimisation" becomes a dashboard with a narrative attached.

### 12.2 The O-levels

| Level | What may change | Oracle | Gate |
|---|---|---|---|
| **O1 — Routing** | which node/packet class pairing is preferred | ledger replay + canary | non-inferior cost and merge time; no rise in conflict rate |
| **O2 — Composition** | one reviewer vs two, writer+debugger pairing, reviewer model family | replay on paired packet sets | defect escape rate must not rise |
| **O3 — Department shape** | capability pool size, gate set, WIP limit, review flow | stepped rollout across programs | cost per merged packet, with guardrails |
| **O4 — Lifecycle policy** | promotion rules, escalation thresholds, program admission | human-approved pilot only | no change to acceptance gates |

O1 and O2 are Phase 12–13 work with the same machinery as §10. O3 and O4 are Phase 14, and O4 is explicitly **not** self-modifiable: lifecycle policy determines what counts as done, which is the customer's acceptance, not the agent's preference.

### 12.3 Department shape is policy data, not a reorganisation

The enterprise model already defines a department as **policy scope + capability pool + gate set + accountability record** — deliberately not a runtime object. That decision pays off here: changing a department's shape is editing a versioned document, which means it can be diffed, replayed, canaried and rolled back like any other improvement.

```text
Engineering Department
  current:  capability pool = 4 workers, gates = [unit, integration, review], WIP = 3
  proposal: capability pool = 6 workers, WIP = 4
  authority diff: +2 leased nodes, +1 human reviewer slot   → HUMAN KEY REQUIRED
```

The `authorityDiff` is not decoration. Growing a pool spends money and consumes nodes other programs may need; under M3 that is an authority expansion, and the agent cannot grant it to itself. The agent may **propose** a shape and prove it; it may not acquire the capacity.

### 12.4 The "4 → 6 workers, 23% faster" example, examined

That claim is the kind that gets a reorganisation approved and then quietly fails. What it must show:

| Question | Required evidence |
|---|---|
| Faster at what? | Lead time per merged packet, not packets started |
| At what cost? | Tokens + review minutes + coordination overhead, per merged packet |
| Did quality hold? | Defect escape rate and false-success rate non-inferior |
| Was it the workers? | Paired replay on the same packet set, or stepped rollout with a control cohort |
| Does it hold up? | 14-day drift watch; revert if the effect decays |
| Did it hurt anyone else? | Other departments' queue time and conflict rate |

A 23% wall-clock gain that doubles review load and raises conflicts by 40% is a loss, and the ledger in §11 is what makes that visible instead of arguable.

### 12.5 Method

1. **Stratify** — never compare a mixed basket. Packet class, repo, and complexity tier are the minimum strata.
2. **Pair** — replay the same packet set under both shapes. This is the only way to remove workload as a confounder, and it is why the replay corpus is built before any promotion machinery.
3. **Simulate first** — calibrate a queueing model from the ledger (arrival rate, service-time distribution per class, retry and conflict probabilities) and test the proposed shape offline. Simulation is not evidence, but it is a cheap filter that kills most bad ideas before they cost a week of canary.
4. **Pre-register** — one primary metric, guardrails, sample size, stopping rule.
5. **Step** — one program class, then one department, then default. No big-bang reorganisation.
6. **Watch** — 14 days, with automatic rollback on guardrail breach.

### 12.6 Acceptance criteria

| # | Criterion |
|---|---|
| O1 | A structural proposal is a versioned policy document, diffable and replayable |
| O2 | Any capacity or budget expansion requires a human key and appears in `authorityDiff` |
| O3 | Replay uses paired packet sets, stratified by class and repo |
| O4 | Primary metric and guardrails are pre-registered before the first canary program |
| O5 | Cost per merged packet is recorded, not inferred |
| O6 | Rollout is stepped by cohort and stops automatically on guardrail breach |
| O7 | Every structural change has a ledger record whose `scope` names the cohorts it touched |
| O8 | A reverted shape leaves its measurement in the ledger |

### 12.7 What this is not

The system does not reorganise people, reassign humans, or negotiate budgets. It optimises the *machine* half of the organisation: which nodes, how many, in what composition, under what review flow. The human half stays a human decision — and that is not a limitation to apologise for. It is the reason an enterprise can adopt it.

---

## 13. L4′ — Phase 12 build plan

§10 defines what is allowed. This is the order to build it in, with exit tests, so the machinery does not arrive before there is anything worth promoting.

### 13.1 Prerequisites

| Prerequisite | Why it blocks |
|---|---|
| L3 running for one quarter, with measured lift | Otherwise there is no baseline to be non-inferior to |
| Ledger instrumented (§9) with ≥ 30 programs of packet-level data | Replay and simulation both need it |
| A named human approver and a second reviewer node | Two keys cannot be invented at promotion time |
| Gate definitions frozen for the period | A moving oracle makes every measurement void |

### 13.2 Work packages

| WP | Deliverable | Exit test | Effort | Depends on |
|---|---|---|---|---|
| WP1 | Authority manifest: declared tools, scopes, egress, gates, budgets | Diffing a manifest that adds a scope fails closed | 1 wk | — |
| WP2 | Improvement ledger (§11): schema, chain, write path, `show`/`stats`/`rollback` | Tampering with an entry breaks the chain and blocks promotion | 1 wk | — |
| WP3 | Replay corpus from the ledger: ≥ 50 programs, stratified | Same input reproduces the same verdict twice | 1–2 wk | WP2 |
| WP4 | Frozen evaluator service + escrow + hash pinning | Agent-writable path cannot reach the evaluator; hash mismatch refuses to run | 1–2 wk | WP3 |
| WP5 | Proposal pipeline: schema, surface allowlist, pre-registration record | A patch touching a gate or authority is rejected by schema | 1 wk | WP1, WP2 |
| WP6 | Canary, drift watchdog, one-command rollback | Injected regression rolls back within one program cycle | 2 wk | WP4, WP5 |
| WP7 | Two-key promotion UI + ledger linkage | Promotion without both keys is impossible, not merely discouraged | 1 wk | WP6 |
| WP8 | O1/O2 structural changes on top of the same pipeline | A composition change is promoted, watched, and reverted on guardrail breach | 1–2 wk | WP7 |

**Total: 9–12 engineer-weeks**, slightly above §10.6's 6–9 because that estimate assumed the ledger and replay corpus already existed. It did not.

### 13.3 Sequence and kill criteria

```text
WP1 ─┬─► WP5 ─┐
WP2 ─┴─► WP3 ─┴─► WP4 ─► WP6 ─► WP7 ─► WP8
```

Stop the programme, and say so, if any of these is true at the end of WP4:

| Kill criterion | Meaning |
|---|---|
| Replay verdicts are not reproducible | The oracle is not deterministic enough to be an oracle |
| The corpus cannot be stratified (n too small per class) | Structural claims will be unfalsifiable |
| Escrow cannot be enforced technically | The oracle is still inside the agent's reach |
| The measured lift of L3 is inside the noise band | There is nothing to protect yet; go back to product work |

### 13.4 What not to build

- A general-purpose self-modifying runtime. The surface is an allowlist, not a sandbox for arbitrary patches.
- A learned evaluator. Learning the judge is how the oracle moves inside the loop.
- Automatic approval for "small" changes. Small is where authority creep starts.
- A dashboard before a ledger. The chart is the least valuable part of the record.

### 13.5 Definition of done

L4′ is done when a change to working method can travel proposal → replay → gate → canary → promotion → drift → rollback with **no step that the agent can perform alone**, and a year later someone can reconstruct why it happened from the ledger without asking a model.
