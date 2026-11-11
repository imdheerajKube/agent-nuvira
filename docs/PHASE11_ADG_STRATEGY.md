# Phase 11 — Autonomous Delivery Grid

## Strategy Document (Plain English)

| Field | Value |
|---|---|
| Status | Draft 1.0 for Phase 5 review |
| Audience | Founders, product, engineering leadership, enterprise buyers, and the reviewing agent |
| Companion | [`PHASE11_DISTRIBUTED_AGENT_GRID.md`](./PHASE11_DISTRIBUTED_AGENT_GRID.md) (implementation contract) |
| Review | [`PHASE11_ADG_REVIEW.md`](./PHASE11_ADG_REVIEW.md) (comparison and verdict) |
| Scope | Reasoning and intent. No specification, no code. |

---

## 1. What we are trying to achieve, in one page

Today, Agent-Nuvira runs on one machine. That machine has one model pool, one context budget, and one operator. It is very good at a task. It is structurally incapable of a program.

We want the opposite arrangement:

- **One machine plans.** It behaves like a technical program manager: it takes a goal, breaks it into packages of work, decides what depends on what, decides which machine should do each piece, reviews what comes back, and owns the merge, the tag, and the release.
- **Many machines build.** The other 20–30 laptops already sitting in the room each have their own models, providers, and tools. They become workers. They receive a small, well-defined package, build it in an isolated copy of the repository, and send back a patch with tests.
- **Nothing is trusted on arrival.** A package only lands after a different machine reviewed it, the integration tests pass, and the control plane approved it.
- **Everything is recorded.** Every package, decision, review, merge, and cost is in a ledger that can be verified without believing any model's summary.

The point is not to make code generation faster in the abstract. The point is that a **larger class of work becomes possible**: work that is too big for one context window, too big for one machine's queue, and too risky to hand to a single unreviewed agent.

### 1.1 The honest speed claim

Twenty machines do not make work twenty times faster. In a realistic model — 400-line packages, independent review, serialized integration — the measured ceiling is 6–12 merged packages per hour, roughly **3–5× the wall-clock throughput of one machine** on an 80-package program.

That is still the difference between a two-week delivery and a four-day one. But the number matters: a plan built on "20× because 20 laptops" will collapse in the first enterprise pilot, and the credibility lost there is much more expensive than the three weeks saved by not building review and integration properly.

---

## 2. Why the current shape does not scale

Most AI coding tools, including ours, follow this shape:

```text
Human → Agent → Tools → Code
```

It works until the work exceeds what one session can hold. Then four things happen at once, and they compound:

**Context explosion.** A large program does not fit in one context window. The agent starts forgetting earlier decisions, re-reading files it already read, and contradicting itself.

**Knowledge mixing.** Architecture, implementation, compliance, and testing all live in the same conversation. The agent cannot tell which hat it is wearing, so a security concern gets answered with an implementation shortcut.

**Review bias.** The same agent that wrote the code reviews it. It is not lying; it genuinely cannot see its own assumption. Any review performed by the producer is a formality.

**Single-machine throughput.** One queue, one model rate limit, one disk. Everything waits behind everything else.

The fix humans discovered decades ago is not a better individual. It is **structure**: separate the planning from the doing, the doing from the reviewing, and the reviewing from the releasing. Give each part a boundary, a contract, and an owner.

We are applying that structure to agents.

---

## 3. What changes, concretely

### 3.1 Before

```text
You: "Build inventory management for the ERP."
Nuvira: one long run, one context, one machine, one unreviewed result.
```

### 3.2 After

```text
You: "Build inventory management for the ERP."
Nuvira Prime:
  → produces a program with 43 work packages
  → freezes the API and schema contracts first
  → assigns backend packages to two backend laptops
  → assigns UI packages to three frontend laptops
  → assigns test packages to the QA laptop (derived from acceptance criteria, not from the code)
  → assigns a security review to the security laptop because risk is "high"
  → reviews every returned patch on a different machine from the one that wrote it
  → rebases and merges in dependency order, running integration tests each time
  → produces a release candidate with an evidence bundle
You: see 43 packages, their state, their cost, and the exact artifact behind every green tick.
```

The human's role does not disappear. It moves up: you approve the plan, you approve the release, you handle the decisions the system deliberately escalates. The system does not pretend to be autonomous where autonomy would mean "unaccountable".

---

## 4. The company analogy, and where it breaks

The intuitive framing is a software company:

| Company | Grid |
|---|---|
| Program manager | Prime control plane |
| Engineering department | Engineering capability pool |
| Frontend team | Nodes tagged `team:frontend` |
| Individual engineer | Worker node executing one package |
| Pull request | Patch artifact |
| Code review | Independent review on another node |
| CI | Program integration test set |
| Release manager | Release authority |
| Audit trail | Program ledger |

This analogy is useful for explaining the product, and dangerous if taken literally.

**Where it breaks:** a human organization has trust, judgement, and accountability that emerge from people. An agent organization has none of those by default. If we build "departments" as runtime objects, we have created the *appearance* of structure without the enforcement. A department that can approve its own work is not a department; it is a chat room with a name.

So the organizational language stays, but it resolves into three enforceable things:

- **policy scope** — which gates, standards, and reviewers apply;
- **capability pool** — which nodes and models can take the work;
- **accountability record** — who produced, who reviewed, who approved, with evidence.

That is why the strategy and the specification must be read together. The strategy explains why departments matter. The specification explains that a department is a policy record, not a process.

---

## 5. Why the lifecycle work has to come first

This is the part that is easy to skip and fatal to skip.

```text
20 agents without a lifecycle  = 20 independent opinions
20 agents with a lifecycle     = a delivery system
```

Phase 5 gives us:

- **typed artifacts** — a plan is a plan, not a paragraph;
- **gates** — a decision with evidence, not a compliment;
- **lineage** — every artifact knows what it was built from;
- **run records** — resumable, auditable execution;
- **delivery contract** — a run is not "done" because a model said so.

Without those, a grid has no common language. Two workers would return two incompatible notions of "finished", and the control plane would have no basis to prefer one. The result is not a factory; it is 20 agents arguing.

This is the single strongest argument for sequencing Phase 11 after Phase 5 rather than beside it. It is also why Phase 11 does **not** add new lifecycle stages. A distributed package *is* a Phase 5 run, on a different machine. The lifecycle stays the same; only the location of execution changes.

---

## 6. What makes this defensible

Not the models. Models are rented and will commoditize.

Not the coding agent. There are many, and they are converging.

The defensible asset is **organizational execution**:

- the ability to decompose a large outcome into contract-bound packages;
- the ability to route each package to the machine best suited to it;
- the ability to prove that the result was reviewed by someone independent;
- the ability to reconstruct every decision months later;
- the ability to do all of that inside an enterprise's own network, with its own models, under its own policy.

That is a different category from "AI coding assistant". It is closer to a delivery operating system. The moat is not intelligence; it is **coordination with evidence**.

---

## 7. What we are deliberately not claiming

A strategy document is judged by what it refuses to claim.

| We are not claiming | Why |
|---|---|
| Fully autonomous software delivery | Humans approve plans and releases; the system escalates rather than guesses |
| 500-node scale | No design, no measurements, no high-availability control plane. v1 is 5–30 nodes |
| That more agents means better quality | Quality comes from review independence, patch size limits, and gates — not from headcount |
| That any model can do any package | Capability routing exists because they cannot |
| That this replaces engineers | It replaces coordination overhead, not judgement |
| That a department is a runtime entity | It is a policy scope; treating it as a process is the mistake we are avoiding |
| That cost falls | Cost per delivered feature may fall; total spend can rise because more work becomes possible |

The last row is the one enterprises discover on their own if we do not say it first. Being early with it is a feature.

---

## 8. The twenty-laptop story

This is the concrete scenario the design targets, because it is real and it is the hardest realistic case.

**Setup.** One main workstation runs Prime. Twenty laptops are enrolled. They are not identical: some have a local 70B model, some have a Claude subscription, some have only a small local model and a fast CPU, two are on Wi-Fi that drops, one is a gaming laptop with a GPU.

**What the operator does.**

1. Creates a program with a repository, a deadline, and a budget.
2. Reviews the generated plan — 43 packages, dependency graph, cost estimate, critical path.
3. Approves it.
4. Watches the board. Answers perhaps three escalated decisions over two days.
5. Approves the release candidate, which arrives with an evidence bundle.

**What the system does that a single agent cannot.**

- freezes the schema before any UI package starts, so five frontend laptops do not invent five data models;
- sends the `high`-risk payment package only to `managed` nodes with approved providers, and never to the two `byod` laptops;
- notices laptop 12 stopped heartbeating, expires its lease, and reissues the package to laptop 4 without duplicating the merge;
- refuses to merge a package whose review came from the same node that produced it;
- reports `degraded` when four nodes drop, with a projected two-hour slip, instead of silently re-planning;
- shows, for every green cell on the board, the artifact hash that justifies it.

**What goes wrong, and is designed for.** Laptops sleep. Wi-Fi drops. One model produces code that passes its own tests and breaks a sibling package. Two packages touch the same migration file. A worker's patch is 1,400 lines and cannot be meaningfully reviewed. A local model writes plausible prose claiming success with no evidence.

Every one of those has a named control in the specification. None of them is solved by hoping the model behaves.

---

## 9. The buyer's questions

An enterprise buyer will ask these in roughly this order. The answers are the product.

| Question | Answer |
|---|---|
| Can a worker merge code? | No. Workers hold no branch-write credential. Only the integration coordinator has one. |
| Can a worker approve its own work? | No. Review requires a different node and a different capability; token scopes enforce it. |
| Can a worker waive a security gate? | No. Waivers require a named human approver and produce a waiver artifact. |
| What happens if a laptop is stolen? | Its token is scoped to one program, expires with the lease, and grants no repository write access. Revocation is immediate. |
| Does our code leave the network? | Only according to classification: `restricted` runs on local models only; `confidential` on managed nodes only. |
| Can we prove what happened? | Yes: hash-chained ledger, artifact hashes, and SIEM export, verifiable without the dashboard. |
| What if the control plane dies? | Restart and resume. No completed package re-executes. There is no second control plane in v1, and we say so. |
| How much does it cost? | Per-package budgets and a program envelope, with a cost ledger reconciled to provider billing within 5%. |
| Can we use our own models? | Yes, including local models. Capability routing is model-agnostic. |
| What is the failure mode we should fear? | Bad decomposition. It is why planning is validated, rejects rather than repairs, and caps packages at 400 changed lines. |

The last answer is unusual in a sales context, which is exactly why it is credible.

---

## 10. The success test

The question we should ask of every future design decision is not:

> Does this make the coding agent better?

It is:

> Does this let us coordinate and prove the delivery of a complex outcome across many machines, without losing governance?

Both questions are legitimate. Only the second one leads to a category the market does not already have ten of.

Applied to this phase, the test produces a clear boundary:

- Adding a better implementer model: improves the agent, not the grid.
- Adding leases and fencing: improves the grid.
- Adding a dashboard page: improves the experience of the grid, but only if it answers a delivery question.
- Adding "autonomous departments": sounds like the grid, but without policy scopes and gates it is decoration.

---

## 11. What success looks like in twelve months

Not "we shipped a distributed agent feature." Rather:

1. An operator with 20 mixed laptops delivers an 80-package program in a day, with a review on every package and an evidence bundle at the end.
2. A regulated enterprise runs the same grid entirely on local models, with `confidential` packages never touching a cloud provider, and passes an internal audit using the ledger alone.
3. A community user with three old laptops and free models gets a usable, if slower, grid — because the protocol does not require a data center.
4. The phrase "workers never merge" is enforced by a credential, not a prompt, and a security reviewer can verify that in ten minutes.

If we get those four, the category claim — autonomous delivery, not assisted coding — is earned rather than asserted.

---

## 12. Summary

Agent-Nuvira today is a strong single-machine agent. The ambition is to make it the **control plane for governed delivery across many machines**: one planner, many workers, independent review, centralized merge authority, and a ledger that makes the whole thing auditable.

The strategy is not "more agents". It is **structure plus evidence**:

- structure: contracts, dependency graphs, capability routing, review independence;
- evidence: typed artifacts, gates, lineage, a hash-chained ledger.

Phase 5 provides the structure and evidence for one run. Phase 11 extends the same structure across machines. Phases 12–15 — departments at scale, autonomous programs, organizational learning, inter-company mesh — remain horizons, not commitments, because each needs its own design and its own proof.

The reason to build it in this order is simple: a distributed system without gates is chaos with better marketing. A distributed system with gates is a delivery organization. The difference is not the number of machines. It is whether every green tick can be traced to an artifact that a human can check.
