# Agent-Nuvira vs. Ruflo — Model Selection & Router Strategy Comparison

> **Date:** 2026-08-01
> **Scope:** Comparison of the model-selection / auto-routing strategies of
> **Agent-Nuvira** (this repo — `src/learning/auto-router.ts`,
> `router-bandit.ts`, `hybrid-router.ts`, `model-router.ts`, `tier0-router.ts`,
> `inference/model-validator.ts`, `cli/model.ts`) and **Ruflo** (the
> `claude-flow` v3 codebase, cloned at `/tmp/ruflo`, commit `4ac1ab9` —
> `v3/@claude-flow/cli/src/ruvector/model-router.ts`,
> `enhanced-model-router.ts`, `neural-router.ts`,
> `v3/@claude-flow/integration/src/multi-model-router.ts`).

This document was produced by reading both codebases directly. Line counts and
mechanisms are accurate as of the dates above.

---

## 1. What each router actually is

### Agent-Nuvira — a multi-provider weighted scorer with a working-model guarantee

Agent-Nuvira routes across **five independent providers** (`local · groq · nim ·
gemini · openrouter`) with real per-provider pricing. The core is a weighted
scorer, not a tier picker:

- **5 routing dimensions** — `reasoning / speed / cost / privacy / reliability`
  (each scored 0–1 per provider), combined into a weighted composite score.
- **Complexity-shaped weights** — task complexity (`trivial → critical`) shifts
  the dimension weights so simple tasks weight cost+speed and complex tasks
  weight reasoning+reliability. Preference modes (`balanced`, `cost-first`,
  `performance-first`, `privacy-first`) add further adjustment.
- **Task intent profile** — regex-derived intent (`planning / coding /
  verification / security / debugging / architecture / migration`) boosts
  reasoning+reliability for verification-heavy work and can escalate to a
  targeted provider (`gemini` for migration/architecture, `openrouter` for
  verification/security).
- **Hard constraints** — `routing.maxCostUsd`, `routing.minSpeed`,
  `routing.minReasoning` **eliminate** violating providers (not just score them
  lower), with a safe fallback when constraints would drop everything.
- **Routing rules** — regex/string task-pattern overrides that force a
  provider/model before scoring (first match wins).
- **Credential-aware** — providers without configured API keys are **never
  scored** (`getDefaultAllowedProviders`), so Auto routing cannot pick a
  provider that will 401.
- **Model-health validation** (`model-validator.ts`) — the resolved model is
  validated against the provider's **live `listModels()`** and repaired to a
  curated known-good default (`resolveWorkingModel`), covering stale/deprecated
  pins and the `'default'` case.
- **Runtime failover** (`cli/chat.ts`) — if a provider still fails at generate
  time (404/429 — e.g. a key whose models are all dead even though listed),
  chat **walks the ranked candidates** and answers from the first working one.
  The orchestrator and `benchmark --routing` get the same protection.
- **Thompson-sampling bandit** (`router-bandit.ts`) — each provider keeps a
  `Beta(α, β)` prior **per complexity bucket** (5 buckets); final score =
  deterministic score × θ where θ ~ Beta(α, β). Cold start `Beta(1,1)` behaves
  like the deterministic router until outcomes accumulate. Rewards are
  **cost-adjusted** (a cheap provider's success is worth the most). State
  persists to `~/.buff/memory/router-bandit.json`.
- **Tier-0 deterministic routing** (`tier0-router.ts`) — mechanical edits
  (remove `console.*`, rename symbol across references, dedupe imports)
  short-circuit the LLM entirely: **$0, <1ms**, AST-validated before apply,
  graceful fallthrough to the LLM otherwise.
- **Runtime stats blend** — benchmark quality and per-agent best-model stats
  adjust capability scores (`useRuntimeStats`).

### Ruflo — a 3-tier single-vendor bandit with a neural upgrade path

Ruflo's shipped router (`v3/@claude-flow/cli/src/ruvector/model-router.ts`,
1,490 lines) routes to **three Claude tiers** (`haiku / sonnet / opus`):

- **Lexical complexity heuristic** — keyword lists (high/medium/low) →
  complexity score 0–1 → tier thresholds (haiku ≤ 0.4, sonnet ≤ 0.7, opus above).
- **Thompson-sampling bandit** — `Beta(α, β)` priors per **3 complexity
  buckets** (`low/med/high`), with a hard-coded cost-adjusted reward table:
  `haiku-success 1.0 > sonnet-success 0.7 > opus-success 0.4` (a cheap model
  succeeding on an easy task is the most efficient outcome).
- **Uncertainty quantification + escalation** — when bandit confidence is low
  or downstream failures are observed, the router **escalates a tier** (tries a
  harder model), rather than switching providers.
- **Circuit breaker** — failure counts and cooldowns gate tier choice.
- **Per-modelId shadow priors** (ADR-149) — the bandit accumulates
  `priorsById` so it can eventually distinguish concrete model ids
  (`inclusionai/ling-2.6-flash` vs `claude-haiku-4-5`) within a tier. Shadow
  state — selection still uses tier priors.
- **Neural router option** (`neural-router.ts`, 961 lines) — KNN/KRR/FastGRNN
  learned routing, gated behind `CLAUDE_FLOW_ROUTER_NEURAL=1` + embedding +
  corpus; `routedBy: 'hybrid' | 'bandit-fallback' | 'heuristic'`.
- **Promotion gates** (`router-parallel-analyze.mjs`) — a router change is only
  promoted if it measurably improves quality (>2%) without regressing cost
  (<+1%) or p95 latency (<+5%) on real trajectory comparisons.
- **Enhanced router** (`enhanced-model-router.ts`) — **Tier-1 Agent Booster
  WASM codemods** (6 intents: var→const, add-types, add-error-handling,
  async-await, add-logging, remove-console) run at $0 / <1ms before the LLM
  tiers (Tier-2 haiku, Tier-3 sonnet/opus).
- **Multi-model-router** (`integration/src/multi-model-router.ts`) — a separate,
  broader cost-optimized router across 8 provider types (anthropic, openai,
  openrouter, ollama, litellm, onnx, gemini, custom) with routing modes
  (manual/cost/performance/quality/rule-based), budgets, caching, and a circuit
  breaker. This is the multi-provider cousin; the *core* shipped loop uses the
  3-tier Claude router above (as determined from the router module headers,
  README, and ADR docs).

---

## 2. Head-to-head comparison

| Criterion | Agent-Nuvira | Ruflo |
|---|---|---|
| **Vendor diversity** | ✅ 5 independent providers + local; real cost arbitrage | ⚠️ 3 tiers of one vendor (OpenRouter used only as provider alternate); broader `multi-model-router` exists but isn't the core loop |
| **Cost optimization** | ✅ real pricing, cost-adjusted bandit rewards, per-call `maxCostUsd` | ✅ per-tier cost multipliers, budget periods, cost-optimized mode |
| **"Only working models" guarantee** | ✅ **credential filter + live model-list validation + runtime failover** — proven end-to-end (broken Gemini key 404 → answered from Groq, no crash) | ❌ assumes a valid Anthropic key + tier→model map; no live validation or generate-time failover in the router itself |
| **Bandit sophistication** | ⚠️ multiplier on deterministic score; no confidence-based escalation | ✅ native Beta-Bernoulli selection + **uncertainty-driven escalation** + per-modelId shadow priors |
| **ML-based routing** | ❌ none | ✅ optional neural router (KNN/KRR/FastGRNN) with promotion gates |
| **Privacy / offline** | ✅ explicit privacy dimension + local provider | ⚠️ Anthropic cloud default; offline only via the separate multi-model-router's ollama/onnx |
| **Deterministic $0 tier** | ✅ Tier-0 router (console-log strip, symbol rename, import dedupe) | ✅ Tier-1 Agent Booster WASM codemods (6 intents) |
| **Hard constraints** | ✅ `maxCostUsd` / `minSpeed` / `minReasoning` eliminate providers | ⚠️ `maxCost` / `maxLatency` / `minQuality` on the multi-model-router request interface |
| **Explainability / UX** | ✅ `buff model explain --json`, ranked lists, fallback chains, bandit heatmap CLI + dashboard | ⚠️ reasoning string only; ADR/benchmark docs internally |
| **Learning-loop maturity** | ⚠️ young (bandit shipped recently; full repo suite 2,738 tests green) | ✅ heavily benchmarked, ADR-gated evolution, parallel-decision A/B |

---

## 3. Architectural differences that matter

### 3.1 Selection unit: provider vs. tier

Agent-Nuvira scores **providers** and then resolves the model *within* the
winner (pinned config model, validated live, or curated default). Ruflo scores
**tiers of one vendor** and maps the tier to a concrete model. This is the
single biggest philosophical difference:

- Agent-Nuvira can express "Groq's llama-3.3-70b at ≈$0 vs OpenRouter's
  GPT-4-class at ~25× the price" — real cross-vendor arbitrage.
- Ruflo's core loop expresses "cheap fast model vs expensive smart model" —
  but only within Claude's family (OpenRouter enters only as a fallback
  provider alternate per tier).

### 3.2 Failure handling: validation + failover vs. escalation

Agent-Nuvira's recent work added a **three-layer failure shield** that ruflo
lacks in its router:

1. **Credential filter** — unconfigured providers are never scored (kills
   "Auto → OpenRouter 401").
2. **Live model validation** — `resolveWorkingModel` repairs deprecated /
   placeholder / `'default'` model pins against `listModels()`.
3. **Runtime failover** — if a provider still fails at generate time (its list
   endpoint lies, e.g. a dead Gemini key), chat walks the ranked candidates and
   answers from the next working provider instead of crashing.

Ruflo instead escalates **tier** on low bandit confidence or observed failure —
which assumes the provider is fundamentally healthy. Within the router module
itself it cannot repair a broken model pin or skip a dead provider (ruflo's
broader harness — e.g. `agent-execute-core` fallback logic — may catch some
failures downstream, but not via the router).

### 3.3 Learning: multiplier vs. native selection

- Agent-Nuvira: `final score = deterministicScore × θ`, θ ~ Beta(α, β) per
  provider × complexity bucket. Deterministic ranking stays the backbone;
  learning *perturbs* it. Cold start = deterministic behavior.
- Ruflo: the bandit **is** the selector (with the complexity heuristic feeding
  the bucket), and its uncertainty signal drives escalation. More
  self-contained, but a bigger cold-start leap of faith.

### 3.4 Governance: ADR-gated promotion vs. feature-shipped

Ruflo treats the router as a **measured artifact**: every change has an ADR,
benchmark runs are committed under `docs/benchmarks/runs/`, and a
parallel-decision recorder A/Bs the proposed router against the incumbent with
hard promotion criteria (quality ↑, cost ~, latency ~). Agent-Nuvira ships the
bandit as a feature flag (`routing.bandit`) with observability (CLI heatmap +
dashboard timeline) but no formal gate proving the bandit beats the heuristic.

---

## 4. Which is better, and why

**For Agent-Nuvira's use case, Agent-Nuvira's strategy is the better *model
selector* — and the recent session proved why.** The exact failure modes the
two strategies divide on are the ones that bit: ruflo's router would happily
return `haiku` and let a missing/broken key 401 or 404. Agent-Nuvira now
*cannot* route to an unconfigured provider, *validates* the pinned model
against the live list, and *fails over at runtime* to the next ranked
candidate. The user's exact command went from a fatal 404 to "answered from
Groq, exit 0". That's the difference between a routing *suggestion* (ruflo) and
a routing *guarantee* (Agent-Nuvira). It also optimizes across genuinely
different price/quality points, which a 3-tier single-vendor router can't
express.

**But ruflo's bandit and router *discipline* are ahead.** Three ideas are
worth borrowing:

1. **Uncertainty-driven escalation** — Agent-Nuvira escalates on *intent
   keywords* ("verify", "security"); ruflo escalates when the *bandit is
   unsure* (prior near `Beta(1,1)`, expected win rate near 0.5). Escalating to
   the next-ranked provider when confidence is low is a strictly better
   cold-start policy.
2. **Per-modelId bandit priors** (ruflo ADR-149) — Agent-Nuvira learns per
   *provider*; ruflo's shadow `priorsById` learns that
   `llama-3.3-70b-versatile` ≠ `openai/gpt-oss-20b` *within* the same provider.
   Agent-Nuvira's `pickModelFromCatalog` is a static pick; per-model learning
   would let the *model* choice learn too.
3. **Promotion gates / A/B validation** — ruflo won't promote a router change
   unless quality improves without cost/latency regressions (measured on real
   trajectories). Agent-Nuvira's bandit has observability but no formal "is the
   bandit actually better than heuristic?" gate — exactly the kind of check
   that would have caught the OpenRouter-default bug before it shipped.

**Verdict in one line:** Agent-Nuvira has the better *provider selector*
(multi-vendor, working-model guarantee, runtime failover); ruflo has the better
*learning machinery* (confidence-aware escalation, per-model learning,
measured promotion gates). The right target is Agent-Nuvira's robustness +
ruflo's bandit discipline. Agent-Nuvira's code comments already credit ruflo as
the inspiration for the bandit, hard constraints, routing rules, and Tier-0
codemods; the remaining gap is the *escalation + per-model + gated promotion*
layer, not the fundamentals.

---

## 5. Suggested follow-up work (ranked)

> **Status 2026-08-01:** items 1–3 below are now **implemented** (this session),
> validated with tsc + full suite (2,768 tests) + code review. See the
> CHANGELOG [Unreleased] section.

1. ✅ **Uncertainty-driven escalation** — implemented in `auto-router.ts`:
   when the bandit's winner has fewer than `escalationMinSamples` (default 8)
   accumulated samples, routing escalates to the next-ranked provider with
   learned data, guarded by a `ESCALATION_WIN_RATE_FLOOR = 0.55` sanity bound.
2. ✅ **Per-modelId Beta priors** (ruflo ADR-149 mirror) — implemented in
   `router-bandit.ts` (`modelPriors` v2 state + `recordModelOutcome`) and
   consumed by `resolveModelWithLearning()` in `auto-router.ts`.
3. ✅ **Bandit-vs-heuristic promotion gate** — implemented in
   `src/learning/router-promotion.ts` with ruflo's three criteria (quality ↑
   > 2%, cost < +1%, p95 latency < +5%) over diverged A/B decisions, surfaced
   via `buff model bandit`.
4. **Wire `resolveWorkingModel` deeper**: the chat/orchestrator/benchmark paths
   are covered; the VS Code extension's model picker could surface the same
   live validation before switching.

---

## 6. Reference file map

| Concern | Agent-Nuvira | Ruflo |
|---|---|---|
| Core scorer | `src/learning/auto-router.ts` (941 lines) | `v3/@claude-flow/cli/src/ruvector/model-router.ts` (1,490 lines) |
| Bandit | `src/learning/router-bandit.ts` (343 lines) | same file (Beta sampling core) |
| Complexity | `src/learning/hybrid-router.ts` (`analyzeComplexity`) | same file (`computeLexicalComplexity`, keyword lists) |
| Static mapping | `src/learning/model-router.ts` | — |
| Deterministic $0 tier | `src/learning/tier0-router.ts` (246 lines) | `v3/@claude-flow/cli/src/ruvector/enhanced-model-router.ts` (736 lines) |
| Model health | `src/inference/model-validator.ts` (128 lines) | — |
| Neural routing | — | `v3/@claude-flow/cli/src/ruvector/neural-router.ts` (961 lines) |
| Multi-provider broad router | AutoModelRouter (this repo's core) | `v3/@claude-flow/integration/src/multi-model-router.ts` |
| CLI surface | `src/cli/model.ts` (`explain`/`bandit`/`switch`) | `v3/@claude-flow/cli/src/commands/neural.ts` |

---

*Comparison grounded in direct code reads of both repos; no code was changed to
produce this document.*
