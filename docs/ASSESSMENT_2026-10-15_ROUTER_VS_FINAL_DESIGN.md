# ASSESSMENT — the router spine vs the external Final_Router_Design (2026-10-15)

**Status: assessment only — no code changed.** This document records the comparison,
the verdict, and the small adopt-list that follows from it. It is referenced from
`NUVIRA_ROUTER_ROADMAP.md` §10 (Decisions Log).

**Subject.** `~/Documents/Design Doc/Final_Router_Design.md` (2,463 lines, 31 sections,
eight consolidation passes v4→v8) against the router that actually ships in this
repository.

**Verdict in one line.** The existing decision layer stays the spine; the external
design is the right architecture for a *different product* (a hosted, multi-tenant
routing service), and the correct response is to harvest ~7 named ideas from it into
the spine — not to adopt it.

---

## 0. Method, and the one fact that frames everything

Read on the code side: the module doctrine and key functions of the routing/
learning files below (`src/learning` is 119 files; `auto-router.ts` alone is 3,586
lines), plus `src/inference/{route-resolver,model-probe,model-entitlement,provider-catalog}.ts`
and `src/context/cache.ts`. Read on the design side: §4, §6–§19 and the closing
sections of the design document.

**The frame.** The external design has never touched this code:

| Search term | Matches in the repo (excluding `node_modules`) |
|---|---|
| `Final_Router_Design` | 0 |
| `entitlement_id` | 0 |
| `catalog_version` | 0 |

So this is not "adopt vs keep" between a spec and its implementation. It is two
independently evolved systems: the document's vocabulary (`entitlement`, `RouteTarget`,
`effective price`, `propensity`, `re-availability`) appears nowhere in the code, and the
code's vocabulary (`pair`, `provider × model`, `registry`, `park`, `acceptance`) appears
nowhere in the document. The repository already has its own spine —
`NUVIRA_ROUTER_ROADMAP.md` with principles N1–N6, a phasewise plan, and the
`tests/e2e/failover-learning.test.ts` regression lock.

---

## 1. What Agent-Nuvira's router is

Four cooperating layers, each with its doctrine written into the file header:

| Layer | Module(s) | Grain |
|---|---|---|
| **Decision** | `auto-router.ts` (`resolve()`, `computeWeights:1138`, `scoreProvider:1332`, floors `:772,791`), `model-first-router.ts`, `hybrid-router.ts`, `ml-router.ts`, `agentic-route-gate.ts` | provider × model **pair** |
| **Availability / state** | `model-registry.ts` (106 KB), `model-probe.ts`, `provider-revival.ts`, `model-reachability.ts`, `credential-fingerprint.ts`, `cold-start-gate.ts` | pair, with key/account subordinate |
| **Budget / health** | `quota-ledger.ts` (windows, provider/model parks, per-account fingerprints), `cost-tracker.ts`, `exhaustion-report.ts` | provider \| model, provider→account |
| **Learning** | `router-bandit.ts`, `router-promotion.ts`, `capability-evidence.ts`, `acceptance-model.ts`, `retry-patience.ts`, `error-repair.ts`, `routing-cache.ts` | intent × complexity × model arms |

Mechanics verified in code (not inferred from comments alone):

- Thompson-sampled Beta priors per intent×complexity and per concrete model; cost-adjusted
  rewards with quality / testPassed / userAccepted / verification sub-signals
  (`router-bandit.ts` `applyReward`); a 7-day staleness guard; and a refusal to label a
  cold `Beta(1,1)` arm as "learned" (`hasLearnedData`) — the P6 fix recorded in that file.
- Deferred user-rejection wiring that never reads silence as acceptance.
- A promotion gate A/B'd only on **diverged** decisions, with three criteria
  (`router-promotion.ts:6-19,108-110`); enforcement opt-in (`resolve-options.ts:53-57`).
- 5-dimension weights + capability fit + context preflight + partial-flakiness penalty
  (`auto-router.ts`), a nominal price table with `COST_REFERENCE_USD = 0.01` and
  `TYPICAL_INPUT_TOKENS = 2000` (`:959,985,988`), measured wire tokens, provider-reported
  cost winning over estimates (`cost-tracker.ts`).
- Pair entitlement classification (`pair-entitlement.ts`) whose doctrine is explicitly
  **per pair, never per model**, with a stable partition that never dead-ends.
- Capability bands from the id + a declared alias table (`model-capability.ts`,
  `model-identity.ts`), and measured capability with prior decay over 10 samples
  (`capability-evidence.ts:1-30`).
- A probe ladder in practice — listModels / one-token spot-check / reasoning probe
  (`model-probe.ts:71,166`) — on a 10-minute unref'd watcher (`:473-541`) with
  event-driven re-verification that ignores its own writes, plus a bounded revival sweep
  (`provider-revival.ts`) and key-set-change re-probing (`credential-fingerprint.ts`).
- A 30-second routing-decision cache keyed on stable inputs **with provider health in the
  key** (`routing-cache.ts:22-45`).
- An exact response cache that refuses to store a turn carrying an unverified claim
  (`context/cache.ts`).

---

## 2. What the external design is

A service-grade router: `Key × Provider × Model × Egress` identity (§6), a continuous
availability engine with a 10-state machine and `recheck_at` clocks plus a hash-chained
state ledger and reconciler (§8), an agent contract with a live menu and error re-query
(§9), a 7-stage pipeline with 16 hard filters and a 12-term utility function (§10),
entitlement resolution with confidence (§11), reserve→commit→release budget (§12),
effective-price + cache + batch + compression (§13), safe learned routing with propensity
logging as a Must and IPS/DR off-policy evaluation (§14), load governance / leases /
deadlines (§15), catalog sync (§16), a benchmark capability index (§17), a failure
taxonomy (§18), multi-key identity (§19), Postgres data model (§20), public API (§21),
policy (§22), SLOs (§23), security and enterprise hardening (§24–§27), a build plan
(§28), risks (§29) and a "Model Market" as best-execution over an order book (§30).

It is a good design — for OpenRouter / LiteLLM / Portkey-class infrastructure (its own
§31 reference list).

---

## 3. Dimension by dimension

| Dimension | Design doc | Agent-Nuvira today | Who serves Nuvira better, and why |
|---|---|---|---|
| **Product shape** | Stateless decision service; Postgres + Redis + Kafka; leader-elected workers (§7, §15.1) | One process, JSON under `~/.nuvira`; deps are commander/express/react only | **Code.** Every doc Must presumes a store plus workers; its "embedded profile" is one paragraph (§7.3) and a stub (§26) |
| **Identity** | `key × provider × model × egress`; entitlement rows; canonical⇄provider-model graph (§6, §19) | `provider × model` pair; key rotation is a ladder rung; each pair's verdict read from its own row (`pair-entitlement.ts` doctrine 1) | **Code** at 1–2 keys/provider. The extra layer buys ranking power only at pool scale, and the code already reached §19.5's insight locally |
| **Egress** | First-class, recoverable dimension (§6.3, §8.8) | **Absent** (`\begress`, proxy agents: 0 matches in `src/`) | **Doc** — but only when proxying ships with the gateway. Not a gap in today's CLI |
| **Availability** | Continuous engine; 10 states; `recheck_at` for every non-live state; tiered scheduler; probe-origin isolation; state ledger + reconciler (§8) | verified/unverified/unavailable + `quotaParkedUntil`/`deadPair`/`lastVerifiedAt`; 7-day staleness; 10-minute watcher + event re-verification; bounded revival sweep; key-set fingerprint re-probe | **Split.** The code has ~70% of the *semantics* at ~15% of the machinery — including two "v5/v8 correctness fixes" in cruder form (self-write exclusion ≈ §8.7; status-before-`lastError` ≈ §8.11). Doc ahead on: a recovery clock for *every* non-live state, and §8.10's "never silently drop a state write" (the registry's writes are best-effort and can vanish) |
| **Feasibility / utility** | 16 hard filters; 12-term `U`; benchmark capability vector; deterministic tie-break `(tier, live-state, price, id)` (§10.4–10.5) | registry/governance filters with recorded `excluded[]`; intent floors; context preflight; flakiness penalty; 5-dimension weights + capability fit + bandit; runtime-stats blending | **Code**, decisively. Its floors and capability scores come from the user's own work (`capability-evidence.ts`, `acceptance-model.ts`) — stronger evidence on a private repo than public benchmarks, which the doc itself calls "a prior, not ground truth" |
| **Fallback ladder** | 9 rungs; anti-waste rules W2 (don't race the platform's own fallback) and W6 (different capacity pool); hedging; batch (§10.6, §18) | key rotation → same model elsewhere → same-class model; evidence-derived wait-vs-fold (`retry-patience.ts`); repair only for repairable classes; a pinned pair is never left; bounded waits; "never fabricate a pair" | **Code** on correctness (the pin contract is a stronger guarantee than W2/W6); **doc** on batch routing and hedging — which only pay on the unattended/deferred path |
| **Cost** | Effective-dated taxonomy (cache read/write, batch discount, long-context tiers, reasoning tokens, modality units); reserve worst case, commit actual (§13.1) | Nominal per-1K table; 2,000-token fallback; measured wire tokens; provider-reported cost wins; per-call cap as a *gate* | **Doc** on effective price and prompt-cache accounting (both verified absent: no `cache_control`, no cached-token fields, no batch endpoints in `src/`). **Code** on honesty: it refuses to call a zero list price "free" (`model-entitlement.ts`) |
| **Cache / compression** | exact + semantic response cache, versioned keys, scope isolation; prompt-cache passthrough + KV affinity + stickiness; compression (§13.2, §13.5, §13.8) | exact response cache keyed on prompt+scope+model; `context-budget.ts`; `compression.ts`; `reasoning-cache.ts`; no prompt-cache passthrough, no semantic answer cache | **Split.** The doc has the two biggest money levers; the code has the honesty guard the doc lacks — a semantic cache replaying a stale answer to a coding agent is a correctness failure, not a saving |
| **Budget** | Atomic reserve→commit→release with a single CAS guard — no overspend under concurrency (§12.2) | windows + parks + a spend ledger, all post-hoc write-through | **Doc** — genuinely. Cheap to adopt locally (in-process lock over the existing ledger) and it matters the moment the dashboard runs parallel tasks against one budget |
| **Learning safety** | propensity logging (Must), IPS/DR OPE, promotion gate, explore budget, auto-rollback (§14) | Thompson (itself an exploration policy); cost-adjusted rewards; deferred rejection; staleness guard; "not learned unless sampled"; 3-criterion A/B promotion gate; `routing.bandit=false` kill switch | **Code for this scale.** §14 is right in principle and over-built here: the propensity log would dwarf the traffic and OPE would be dominated by one user's habits. Its real requirements — guardrails on exploration, evidence before promotion, rollback — are implemented by floors + governance + gate + kill switch |
| **Governance / security** | RBAC/SSO/SCIM, policy-as-code, chargeback, residency, WORM audit, re-authorization on every reroute (§10.10, §24–§27) | `routing.governance` (allow/deny provider+model, admin max-cost, PII patterns + privacy floor) as **hard eliminations** with typed errors and an audit trail; `src/enterprise/` (rbac, audit-chain, vault, secrets, sbom); federation OIDC | **Code** for single-user; **doc** on §10.10 (re-authorizing every target change — see §7 below: not verified either way) |
| **Agent contract** | `discover()` / `route()` / `report()` JSON with a live menu, reasons, exclusions, refreshed menu on error; MCP surface for any agent (§9) | a rich *human* contract (`models explain`, `models excluded`, routing history, dashboard panels, action-telemetry timeline), not a programmatic contract exported for third-party agents | **Doc** — but as an **export of internals the code already computes** (ranked providers, excluded reasons, quota remaining, entitlement chips) |
| **Reproducibility** | `catalog_version` + `policy_hash` on every decision; replayability as a query (§10.8, §16.4, R16) | deterministic tie-breaks; health-in-the-key routing cache; invalidate-on-refresh; hash-chained action log with test-origin tagging; `decision-diff.ts` — but **no version stamp** | **Doc** on the stamp (one field, high value, trivial locally). **Code** on test-origin tagging, which the doc does not have |
| **Scale / load** | admission control, priority classes, fair-share, deadline-aware routing, leases, distributed rate-limit reservation (§15) | none for model calls (agent-subtask admission lives in `fanout-scheduler.ts`; job deadlines in `unattended-job.ts`) | **Doc** — irrelevant to a single-user CLI; relevant only if `nuvira serve` becomes multi-tenant |

---

## 4. Why the verdict falls where it does

1. **The doc's non-goals are this product's requirements.** Never dead-end, never leave a
   pin silently, never claim a dead model works, bound the wait, ask the human, rank
   offline — all implemented here, with the reasoning in the code. None is a section of
   the design document.
2. **The cost of adoption is asymmetric.** The shipping router is ~200 KB of TypeScript
   behind 3,000+ tests and a hermetic failover-learning E2E lock. The doc's Musts imply a
   store, a worker, and a *second* "embedded" implementation of the same spec — against
   this repo's own N1 (zero regression).
3. **The doc's insights are already here in local form** — pin precedence (§19.8) ≈ the pin
   contract; §8.7 ≈ the watcher's own-write exclusion; §19.5 ≈ per-pair entitlement;
   §14.4 ≈ floors + kill switch; §10.6's W2/W6 ≈ `retry-patience` + `error-repair`;
   §17.4 ≈ capability-evidence's prior decay. That convergence says the design is sound
   and the machinery is scale-specific.
4. **Its governance is fiction where it lives.** §31 claims to be "the single source of
   truth … nothing lives outside this document" — but the document sits outside the repo,
   no code cites it, and the repo has a competing spine. Two spines guarantee drift, and
   the doc's own no-drift rule is violated by construction.
5. **§30 (order book, depth, order splitting, settlement, position limits, trading halts)**
   is where the accretion shows: for one user with one key it adds vocabulary, not
   capability.

---

## 5. Adopt into the existing spine

| Pri. | Item | Why it is worth it | Local form |
|---|---|---|---|
| **P0** | Effective price + prompt-cache accounting (§13.1, §13.5) | The largest real-money lever for a long-system-prompt agent; ranking on nominal price mis-ranks tiered models | Table fields + `cache_control` passthrough in the Anthropic/Gemini adapters; cached-token fields in `CostEntry` |
| **P0** | Reserve → commit → release (§12.2) | A "hard cap" must hold when the dashboard/gateway runs concurrent tasks | In-process lock + a `reserved` field in the existing ledger (no Postgres) |
| **P1** | Decision provenance stamp (§16.4, R16) | Makes a decision replayable and a regression attributable | Registry/catalog version + policy hash in the routing trace and `models explain` |
| **P1** | Propensity-lite decision record (§14.2) | Strengthens the existing promotion gate; prerequisite if exploration ever grows | One JSONL row per decision (context hash, chosen arm, alternative, reward) beside `router-promotion.jsonl` |
| **P1** | Programmatic live menu (§9.3, §9.7) | The gateway / MCP / A2A surfaces need it; the data already exists | `route()` / `discover()` JSON exporting ranked pairs, exclusions, quota, entitlement chips, `recheckAt` |
| **P2** | `recheck_at` for every non-live state; no silent state-write loss (§8.2, §8.10) | Turns "parked" into "back in ~14 m" everywhere, and stops a lost `rate-limited` from re-hammering a provider | Extend the registry entry; make the write path observable rather than best-effort |
| **P2** | Batch-API rung for non-interactive work (§13.3) | A pure cost win on the unattended/deferred path, which exists | A ladder rung gated on a batch priority |
| **P3** | Egress identity (§6.3) | Only meaningful once proxying exists | Defer with the gateway |

**Decline for this product:** Postgres/Redis/Kafka, leader-elected workers, the state
ledger + reconciler, the provider platform state machine, IPS/DR OPE, market
microstructure, the multi-tenant enterprise layer, and semantic response caching until
scope isolation is proven (a per-machine cache is fine; the moment it serves a gateway, a
cross-scope replay becomes a Must-not).

---

## 6. The boundary condition that flips the verdict

If `nuvira serve` becomes a genuine multi-host, multi-tenant router product with external
consumers — i.e. when the roadmap's deferred **FW-2 (fleet-wide shared state)** lands —
then the external design's spine becomes the right one, under three conditions: reduce it
to the service profile (drop §26's embedded claim; drop §30 unless proxying and trading
dynamics are real), bring it **into the repository** so its own no-drift rule can be
enforced, and reconcile it against `NUVIRA_ROUTER_ROADMAP.md` rather than leaving two
spines. Until then it is the right design for a product Nuvira is not.

---

## 7. How to falsify this assessment

The repo can measure it. Implement the P0 subset (effective price, prompt-cache
accounting, reserve) behind flags and compare against the current router on the same task
set, using `eval-framework.ts`, `acceptance-model.ts`, `benchmark.ts` and the parity
harness: cost per **accepted** turn, and verification rate.

Predictions that would falsify the verdict if they fail:

1. Effective-price ranking changes the winner on at least one long-context or
   Anthropic/Gemini task per session.
2. Prompt-cache accounting cuts measured cost on repeated-prefix sessions by a
   double-digit percentage.
3. **None** of the service-grade machinery the document adds (state ledger, IPS/DR OPE,
   admission control, fair-share) changes a single pick at this scale.

If (3) fails — if a service-grade mechanism demonstrably changes picks for a single user —
the verdict above is wrong and the design document's spine should be revisited.

---

## 8. What is NOT verified in this document

- `src/learning` is 119 files and `auto-router.ts` is 3,586 lines; this assessment reads
  the doctrine and key functions of the routing-relevant ones, not every line of every
  file.
- **§10.10 re-authorization on every target change is unverified.** Whether a failover or
  repair rung re-runs `governanceVerdict` after the initial feasibility pass was not
  checked, and no claim is made either way. It is a concrete, cheap check worth taking:
  if a rung can bypass the policy gate, that is a real gap the document is right about.
- The adopt-list priorities (P0–P3) are judgements about cost/benefit at this scale, not
  measurements. §7 is the measurement plan.
- The design document is **not** in this repository
  (`~/Documents/Design Doc/Final_Router_Design.md`). Nothing here should be read as an
  endorsement of maintaining a design record outside the repo — §4 (reason 4) criticises
  exactly that, and this assessment is deliberately published *inside* it.
