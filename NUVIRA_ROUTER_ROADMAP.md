# Nuvira-Router — Phasewise Roadmap & Milestone Tracker

**Status:** Living plan (authoritative reference for the Nuvira-Router program)
**Version:** 1.0 — 2026-08-05
**Owner:** Agent-Nuvira core team
**Style:** World-class delivery over speed. Every phase is independently shippable, **zero-regression**, fully tested, and documented. Smallest requirements (edge cases, failure modes, backward compatibility) are factored in at design time, not patched later.

---

## 1. Purpose & Guiding Principles

**Nuvira-Router** is the program that turns Agent-Nuvira's already-strong learned routing into an **enterprise-grade, presentation-rich, transport-agnostic routing platform** — without compromising a single existing feature.

### 1.1 Non-Negotiable Principles

| # | Principle | How it's enforced |
|---|---|---|
| N1 | **Zero regression** — no existing feature, flag, config key, telemetry field, or test may silently break | Every phase ships a "Non-Regression Guarantee" checklist: full suite green (3,032+ → grows only), E2E failover-learning test stays green, config schema backward-compatible (additive only), CLI flags additive only, dashboard panels degrade gracefully |
| N2 | **Smallest requirement factored in** — edge cases, failure modes, and boundary conditions are designed before implementation | Each phase has an explicit "Edge cases & failure modes" subsection that must be resolved (with tests) before the phase closes |
| N3 | **Selection criteria and presentation are enhanced, never diminished** | Each phase declares its Selection-Criteria enhancements and Presentation enhancements explicitly |
| N4 | **Backward compatibility is additive** — new provider types, config keys, and telemetry fields never break old state files | Schema migration strategy defined per phase; old state files always load |
| N5 | **Everything is observable** — every decision, failure, and retry is explainable and visible | `models explain`, dashboard panels, and structured telemetry cover every new behavior |
| N6 | **Security and privacy by default** — secrets never logged, gateways never exposed, compression never lossy on code | Security checklist per phase; off-by-default for anything risky |

### 1.2 Naming & Terminology

The external gateway project analyzed for inspiration (diegosouzapw/OmniRoute) is referenced **only** in the clearly-labeled external appendix (§11). All product naming uses our own terms:

| Term | Meaning |
|---|---|
| **Nuvira-Router** | The program / strategy umbrella (this roadmap) |
| **Nuvira Gateway Adapter** | New `InferenceProvider` implementation speaking OpenAI-compatible REST to any gateway endpoint |
| **Nuvira Gateway** | Our optional central/enterprise gateway mode (`buff nuvira serve`) — headless server exposing our routing as an OpenAI-compatible endpoint |
| **Nuvira sidecar mode** | Opt-in interop profile for running an external OpenAI-compatible gateway alongside us (pinned, security-locked) |
| **Provider type** | `nuvira` (built-in) — resolves through `ProviderFactory` like every other provider |
| **Decision layer** | `auto-router.ts` + `model-registry.ts` + `quota-ledger.ts` + `provider-fallback.ts` (ours, kept authoritative) |
| **Transport layer** | The adapters (`src/inference/*`) that actually talk to providers — now including `nuvira-adapter.ts` |

---

## 2. Current-State Baseline (what must never break)

Verified as of 2026-08-05 (v1.57.0, 3,032 root tests + 42 dashboard component tests + 213 extension tests):

| Area | Existing capability | File(s) |
|---|---|---|
| Learned routing | Thompson-sampling bandit, uncertainty escalation, per-model learning, promotion gate A/B, routing rules, hard constraints, credential filtering, quota-ledger integration, runtime stats blending, verification escalation, free/local-first gate | `src/learning/auto-router.ts`, `router-bandit.ts`, `hybrid-router.ts`, `router-promotion.ts`, `tier0-router.ts` |
| Availability telemetry | FAISS-backed Model Availability Registry; per-action "learned from real usage" verified/killed chips; `getUsableProviders`/`getBlockedProviders`; recovery loop; `models unblock` escape hatch | `src/learning/model-registry.ts` (+ FAISS backends), `src/cli/models.ts` |
| Failover | Error classification (auth/rate-limit/server/network/timeout/unknown), circuit breaker, session exclusions, predictive registry skips, per-action write-through | `src/learning/provider-fallback.ts`, `src/cli/chat.ts` + action CLIs |
| Quota | Free/local-first gate, quota ledger, parking, reset windows, failover timeline | `src/learning/quota-ledger.ts`, dashboard Quota panel |
| Inference | Unified `InferenceProvider` interface; 5 built-in adapters (nim/gemini/openrouter/groq/local) + plugin providers; streaming + non-streaming | `src/inference/{interface,factory,*-adapter}.ts` |
| Observability | Event bus, routing history/audit, DAG, cost/benchmarks/memory/health dashboard panels, per-action telemetry timeline (scrubbable) | `src/observability/event-bus.ts`, `src/web-dashboard/` |
| Multi-surface | CLI, web dashboard, VS Code extension (IDE telemetry attribution), MCP/A2A, federation | `src/cli/`, `src/web-dashboard/`, `vscode-extension/` |

**Regression lock:** the hermetic E2E `tests/e2e/failover-learning.test.ts` (mock 429 → registry learns → next pick skips → flipped mock recovers) is the canonical no-regression guard and **must pass in every phase**.

---

## 3. Target Architecture (decision layer ⇄ transport layer)

```
                    ┌────────────────────────────────────────────────┐
                    │            Nuvira-Router  (ours)              │
                    │                                                │
  User intent ────► │  DECISION LAYER (unchanged, enhanced)          │
 (action tag)       │   auto-router → registry → ledger → fallback   │
                    │         │                                      │
                    │         ▼                                      │
                    │  TRANSPORT LAYER (new adapter joins existing)  │
                    │   nim | gemini | openrouter | groq | local     │
                    │        |    nuvira-adapter (OpenAI-compat)     │
                    └─────────┼──────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┬──────────────────┐
              ▼               ▼               ▼                  ▼
       Upstream providers  Nuvira Gateway  External gateway   (future)
       (direct, today)    (P6, enterprise)  (sidecar, opt-in)
```

- The decision layer stays the single source of truth for *which* provider×model serves *which* task.
- The transport layer grows one more adapter — that's the entire "unified endpoint" story; no existing adapter is rewritten.
- P6's `buff nuvira serve` reverses the adapter: our routing becomes an OpenAI-compatible endpoint other tools can consume.

---

## 4. Phasewise Plan

> Legend — 🛡️ = Non-Regression Guarantee · 🎯 = Selection-Criteria enhancement · 📊 = Presentation enhancement · ⚠️ = Edge cases & failure modes · ✅ = Acceptance criteria. Effort in team-days (est.). Dependencies listed per phase.

---

### Phase 0 — Foundation & No-Regression Baselines

**Goal:** make the current routing layer provably correct and observable before adding any new surface. **Theme:** "Do no harm, then measure."

**Rationale:** Every later phase builds on this; a shared failover path prevents the duplicated-loop drift that already exists across `chat.ts` / `execute.ts` / `plan.ts`.

**Milestones**

- **M0.1 — Baseline lock.** Capture the full suite + E2E failover-learning + dashboard suites as the regression gate (script `scripts/ci/regression-gate.sh`). ✅ Script exists; CI job added; documented.
- **M0.2 — Shared failover runner.** Extract the duplicated candidate loop + telemetry write-through from `chat.ts`/`execute.ts`/`plan.ts` into `src/learning/failover-runner.ts` (single `runWithFailover(action, prompt, options, exclude)`). Behavior-identical refactor. ✅ All 5 action CLIs call it; E2E identical; no logic delta.
- **M0.3 — Telemetry schema v2 (additive).** `recordCall` gains optional `outcome: 'full' | 'partial' | 'none'`, `attempt`, `correlationId` — old records still load. ✅ Old JSONL/registry state files parse unchanged.
- **M0.4 — Mid-stream failure classification.** `classifyFallbackError` gains a streaming-abort path (`partial` outcome) so telemetry records *partial* generations instead of treating them as opaque failures. ✅ Unit + mock-SSE tests.

🛡️ **Non-Regression Guarantee:** suite count never decreases; `failover-learning.test.ts` green; CLI flags unchanged; registry file format backward-compatible (schema v2 is additive).
🎯 **Selection-criteria:** none yet (foundation).
📊 **Presentation:** none yet (foundation).
⚠️ **Edge cases:** empty candidate list; all-excluded session; partial-stream + auth-failure ambiguity; failover-runner re-entrancy during Ctrl+C.
**Tests:** ~12 new. **Effort:** 5–7 team-days. **Deps:** none.

---

### Phase 1 — Nuvira Gateway Adapter (unified transport endpoint)

**Goal:** any OpenAI-compatible endpoint (self-hosted gateway, enterprise gateway later, or a provider like vLLM/LiteLLM) becomes a first-class provider via one adapter. This is the "unified endpoints" requirement — done safely.

**Milestones**

- **M1.1 — `src/inference/nuvira-adapter.ts`.** Implements `InferenceProvider`:
  - Config: `baseUrl` (default `http://127.0.0.1:20128/v1`), `apiKey?`, `defaultModel?`, `extraHeaders?`, `timeoutMs`, `wireTokenMetering: boolean`.
  - `generate` / `generateStream` (SSE, `onToken` passthrough, final-chunk `usage` capture).
  - `isAvailable()` → GET `{baseUrl}/models` (short timeout); `listModels()` → `ModelDescriptor[]` with `model-catalog` tagging.
  - Error mapping to existing `classifyFallbackError` buckets (401→auth, 429→rate-limit, 5xx→server, aborted→timeout/partial).
- **M1.2 — Factory + config.** `ProviderType` union gains `'nuvira'`; `ProviderFactory.createProvider` case added; `ProviderConfig` gains optional `baseUrl`/`extraHeaders`. `buff config set provider.nuvira.baseUrl …` documented.
- **M1.3 — Registry + ledger write-through.** All gateway calls flow through the existing per-action `recordCall` telemetry; wire-token `usage` (when enabled) lands in the quota ledger (reporting UI in P3).
- **M1.4 — Parity test harness.** Mock OpenAI-compatible HTTP server (chat + SSE + 401/429/500 + mid-stream abort) asserting adapter parity with `groq-adapter` behavior.

🛡️ **Guarantee:** built-in adapters untouched; `--provider` values unchanged; new provider only adds a new valid value.
🎯 **Selection-criteria:** gateway-hosted models enter the same registry/bandit learning — selection quality applies to them identically.
📊 **Presentation:** `models status` shows `nuvira` rows with learned verified/killed chips (no UI change needed — existing pipeline).
⚠️ **Edge cases:** empty `/models` response; non-OpenAI error body shapes; baseUrl trailing slash; header injection; SSE heartbeat stalls (idle timeout); `usage` absent in some responses (treat as estimate, mark `estimated`).
**Tests:** ~15 new (incl. mock-server parity). **Effort:** 6–8 team-days. **Deps:** P0.

---

### Phase 2 — Selection-Criteria Enhancement (capability-aware, cost-aware, governed)

**Goal:** materially improve *what* the router picks, using richer signals — without touching the decision layer's proven learning core.

**Milestones**

- **M2.1 — Capability-aware scoring.** Extend `model-catalog` tags (`code`, `reasoning`, `vision`, `fast`, `cheap`, `multimodal`) to feed a new soft signal in `auto-router` scoring (task-type → capability fit). Task-type inference already exists (`writer`/`coder`/`researcher` etc.); wire it to capability weights. ✅ `models explain` shows the capability-fit dimension.
  - ✅ DONE (`a34e58c`): soft clamped multiplier `min(1, score·(0.9+0.2·fit))`; fit = matched-required/required tags; tags = static catalog ∪ derived-from-real-profile (custom/gateway providers score by REAL capability, e.g. reasoning≥0.75 derives `reasoning`); unknown providers stay fully neutral (fallback profile 0.5s derives nothing) until real data exists; **reversible gate `routing.capabilityFit`** (default ON, set false to revert to pure dimension weights); fit surfaced per-ranked-provider in `models explain` text + JSON; fit only on healthy candidates (quota-parked reasons stay definitive, no chip); `capabilityFit` added to `RoutingConfig`. 13 tests (neutral-unknown incl. production fallback, caps-derived, clamp invariants, close-score preference, gate off/on, parked no-fit, explain presentation). Gate is **auto-router-scoped in M2.1** — `hybrid-router`/`tier0-router` don't apply the signal yet (by design; extend if P2 needs it).
- **M2.2 — Wire-token cost inputs.** When gateway `usage` or provider-reported usage is available, replace estimate-based cost scoring with measured cost where present (fallback to estimates otherwise, flagged). ✅ Cost panel + `models explain` show measured-vs-estimated.
  - ✅ DONE (): `streamCompletion` gains an `onUsage` callback capturing the endpoint-reported `usage` from any SSE chunk (include_usage convention); the Nuvira gateway, Groq and NIM adapters record EXACT tokens via the new `recordCallMeasured` (`CostEntry.measured` persisted BEFORE write — dashboard split reads it from disk) and write through to the registry (`recordMeasuredUsage` per-model token EMAs, `getMeasuredUsage` sample-weighted per-provider aggregate). Auto routing's `estimateCallCostUsd`/`computeCostScore` take an optional `MeasuredCost` and replace the TYPICAL 2,000/500 tokens when real usage exists; `ScoredProvider` gains `costSource: measured|estimated` + `costBasis`; the allowPaid + maxCostUsd gates judge by measured cost. `models explain` shows `📏 measured N→M tok` (text) + `costSource`/`costBasis` (JSON). Dashboard cost panel splits 📏 measured vs 📐 estimated spend per call + provider (`byProviderMeasured`, `measuredCalls/estimatedCalls`, `measuredCost/estimatedCost`). Hermetic E2E `tests/e2e/gateway-measured-cost.test.ts` (3 tests) proves the full loop against a real mock OpenAI-compatible /v1 gateway: measured usage → registry → verified → measured-cost resolve. 10 new tests; full gate 3,093 root + 42 dashboard.
- **M2.3 — Multi-account / key rotation.** Quota-ledger gains per-account key state; failover runner can rotate keys of the same provider before switching providers (mirrors quota-aware account selection).
  - ✅ DONE (`9703a78`): `ProviderConfig.apiKeys: string[]` beside the primary `apiKey`; the shared failover walk (`runSingleShotAuto`) tries every NON-PARKED key of a candidate BEFORE switching providers — on rate-limit/auth the dead ACCOUNT is parked in the quota ledger (`parkAccount`/`isAccountParked`/`getParkedAccounts`/`releaseAccount`, FNV-1a fingerprint via `accountIdForKey`, raw keys never persisted) and rotation continues (`🔑 key#N` logging; primary-provider rotation logs `answered via key#N`); the next run SKIPS parked accounts predictively; `options.apiKey` overrides the configured key at the adapter level (Groq/NIM/Nuvira gateway, generate + generateStream); `releaseProvider` clears accounts; `getState()` exposes accounts with stable `{}` shape; account parks act as a FLOOR (the config-aware `routing.quota.windowMs` park from `recordActionFailure` wins via `Math.max`). Single-key and keyless behavior unchanged. Hermetic E2E `tests/e2e/key-rotation.test.ts` (2 tests, order-independent hit counters) drives the REAL adapter + runner against a mock OpenAI-compatible gateway keyed on the Authorization header: key-1 → 429 parks that account, key-2 → 200 answers, the next run skips key-1 predictively. Presentation: `models explain` per-ranked-provider cost-source marker; dashboard Models panel 📏 measured-token chip. 39/39 affected suites pass; full gate green.
- **M2.4 — Governance constraints (schema, admin-first).** Extend the existing hard-constraints slot: allow/deny model lists, max-cost-per-task, PII-domain block, admin-override of registry blocks. Config additive; enforcement inside `auto-router` constraints (already exists). ✅ Constraint tests; `models unblock` still wins over soft blocks but not admin hard-denies.
  - ✅ DONE (`dfccd81`): `GovernanceConfig` added to `RoutingConfig` (`allowProviders`/`denyProviders`/`allowModels`/`denyModels`/`maxCostUsd`/`piiPatterns`/`minPrivacyForPii`/`allowUnblock`). Enforced as HARD eliminations in the router's constraint slot — provider allow/deny lists, model lists gated on the SERVED model (configured pin, else curated defaults; a pinned violator dies even when a curated default would pass), the admin max-cost cap joins the per-call cap via stricter-wins, and the PII block keeps only providers with privacy ≥ `minPrivacyForPii` (default 1.0 = local-only). **Hard-gate guarantees:** a rule that eliminates EVERY candidate throws `PIIPolicyError` (privacy) / `GovernancePolicyError` (lists/cap) with the full `governanceBlocked` audit trail — only per-call SOFT options (`maxCostUsd`/`minSpeed`/`minReasoning`, which never populate the audit) retain the benign fallback-to-ranking. `models explain` renders policy blocks cleanly (human audit trail + JSON error object); `buff plan` rethrows policy blocks instead of degrading around them; chat/orchestrator surface the message. `buff models unblock` honors `allowUnblock: false` (admin-hard escape-hatch gate) and warns when the provider sits on an admin deny list (unblock alone can't restore it). Dashboard Quota panel shows parked key-accounts (`parkedAccounts`); `buff config set` supports `providers.<name>.apiKeys` and `routing.governance.*`. 126 auto-router + 204 affected suites pass; full gate green.
- **M2.5 — Context-length preflight (the genuine gap Copilot identified).** Optional pre-execution estimation (reuse `context-pruner` sizing) that scores models against the task's estimated prompt size before picking — **estimation only, never a hard block** (models may exceed nominal windows). ✅ Estimation unit tests; `models explain` shows estimated-utilization.
  - ✅ DONE (`abb282d`): per-model/per-provider nominal window tables (`MODEL_CONTEXT_WINDOWS`, `PROVIDER_CONTEXT_WINDOWS`, `DEFAULT_CONTEXT_WINDOW`) with `routing.contextWindows` overrides (model or provider key, string values coerced to numbers); the prompt estimate comes from the caller's `contextHintTokens` when the REAL payload is known — chat passes the growing conversation history (interactive loop) and the built full prompt (single-shot `generateAutoWithFailover`) — else `estimateTokens(task)` via the canonical cost-tracker heuristic. `computeContextFit` is a SOFT, estimation-only score: neutral below 50% utilization (normal-size tasks never shift a ranking — verified by the full pre-existing suite passing), linear ramp, 35% penalty cap even when the prompt EXCEEDS the window (never a hard block, unknown/zero windows neutral). Applied as `finalScore = fitScore × (contextFit ?? 1)` inside the scored map (healthy candidates only; quota-parked reasons stay definitive); gate `routing.contextFit` (default ON) fully reverses the signal like capability-fit. Presentation: per-ranked-row `⏳ ctx N%` chip, `── Context preflight ──` human section (estimated tokens, basis task|hint, per-provider window/utilization/fit, n/a for parked), JSON `context` block in `models explain`; `ModelCandidate.contextWindowTokens` in fallback chains; `buff config set routing.contextWindows.<model|provider> <tokens>` (validated integer). Chat wiring means long conversations naturally route toward big-window providers (a 500K-token payload flips privacy-first local → gemini 1M). 135 auto-router + 17 explain + 13 config tests (10 new M2.5); 264 affected suites pass; gate green. **Followup DONE**: plan + orchestrator now pass real payload estimates — `buff plan` resolves with `contextHintTokens: estimateTokens(prompt)` (the actual built prompt incl. parsed codebase context); the orchestrator computes `estimateTaskPayloadTokens(vault, description, contextFiles)` (goal + task + stat-sized workspace files, best-effort) per task and forwards it through `resolveAutoRoutingDecision`, so multi-agent pipelines (execute/plan) get the same long-context awareness chat already had (planner decision intentionally omits the hint — its payload isn't known at resolve time; a goal-only hint would equal the router default). 3 new tests; 288 affected + gate green.

🛡️ **Guarantee:** default behavior bit-identical when new features are off (feature flags default to legacy behavior); existing `routing.*` config keys keep meaning.
🎯 **Selection-criteria:** capability fit, measured cost, key rotation, governance, context fit — five new dimensions, all visible in `models explain`.
📊 **Presentation:** `models explain` (and `--json`) now prints a dimension breakdown; dashboard Routing panel shows the same breakdown.
⚠️ **Edge cases:** catalog gaps (unknown tags → neutral weight); measured-cost absent; rotation when only one key; governance overrides interacting with bandit exploration; estimation vs actual drift (bounded, flagged).
**Tests:** ~25 new. **Effort:** 10–14 team-days. **Deps:** P0 (P1 for measured cost).

---

### Phase 3 — Presentation Enhancement (decisions, requests, and rationale)

**Goal:** make every routing decision and every request visible, explainable, and comparable — the "presentation" upgrade.

**Milestones**

- **M3.1 — Routing decision rationale.** `buff models explain --deep <task>` and dashboard Routing panel: per-candidate scored-dimension table (capability / cost / latency / learned-verification / quota / constraints) + "why this pick beat the runner-up". ✅ JSON output stable; panel renders from existing `/api/routing`.
- **M3.2 — Requests panel.** New dashboard panel fed by telemetry JSONL (same pipeline as Models panel): per provider×model×action — requests, p50/p95/p99 latency, error rate, measured cost, correlation IDs. ✅ Dashboard tests for the new aggregate endpoint.
- **M3.3 — Decision diff.** `models explain` gains `--since <ref>` showing what changed vs a previous decision (bandit shift, new verification, constraint added). ✅ Diff unit tests.
- **M3.4 — Timeline enrichment.** Per-action telemetry timeline (existing scrubbable chart) gains outcome chips (`full`/`partial`/`none` from P0 schema) and reasoning/cost overlays. ✅ No regression on existing timeline tests.

🛡️ **Guarantee:** all existing panels untouched (new panels/endpoints additive); degraded server responses hide sections (existing `jsonOrNull` guard pattern reused).
🎯 **Selection-criteria:** indirect — visibility drives tuning; nothing here changes selection.
📊 **Presentation:** the flagship presentation milestone: rationale tables, Requests latency/cost panel, decision diffs, richer timeline.
⚠️ **Edge cases:** empty history; JSONL file rotation mid-read; p95 with <10 samples (show `—`); large diffs (cap output); panel degradation on stale server (established pattern).
**Tests:** ~20 new (dashboard + CLI). **Effort:** 10–12 team-days. **Deps:** P0 (telemetry schema), P1.

---

### Phase 4 — Mid-Stream Resilience & Continuity

**Goal:** never lose a generation to a mid-stream failure, and preserve continuity across retries/rotation — the highest-value *patterns* from the external reference, implemented natively.

**Milestones**

- **M4.1 — Buffered streaming + continuation retry.** Gateway adapter (and, opt-in, all adapters) buffer tokens; on mid-stream failure, classify `partial` and retry the next candidate with **continuation**: full prompt + partial output appended as a bounded `continue` note (budget cap: max 1 continuation per task; registry learns the partial). ✅ Mock-SSE-abort E2E: complete answer despite mid-stream death; cost cap enforced.
- **M4.2 — Reasoning-replay cache.** For reasoning models, cache last `reasoning_content` per (conversation, model); on retry to the same provider, re-inject it to satisfy strict providers that 400 on missing prior reasoning. Persisted like other registry state. ✅ Unit + provider-mock tests (400-with-reasoning-demand → success after replay).
- **M4.3 — Context-relay summaries for rotation.** On provider/key rotation mid-task, attach a compact "session so far" summary (reuse `src/learning/context-pruner.ts` / `src/agents/context/`) so the next provider has continuity. ✅ Rotation E2E asserts summary presence in the retry prompt.
- **M4.4 — Conservative opt-in compression.** A **lossless-for-code** mode using our own pruner (system-prompt/tool-output trimming only; never strips identifiers/strings); off by default, documented with a warning. ✅ Property test: identifiers/symbols always survive compression.

🛡️ **Guarantee:** non-streaming path unchanged; streaming default behavior unchanged when features off; registry schema additive (`partial` already added in P0).
🎯 **Selection-criteria:** partial-failure learning (P0 outcome field) makes the router avoid flaky mid-stream providers — a new learned signal.
📊 **Presentation:** timeline shows `partial` chips (M3.4); continuation attempts visible in rationale.
⚠️ **Edge cases:** token budget overrun on continuation; reasoning cache key collisions; relay summary size bounds; compression on non-code tasks (detect + skip); abort-during-continuation (bounded retries).
**Tests:** ~22 new. **Effort:** 12–16 team-days. **Deps:** P0, P1.

---

### Phase 5 — Optional External-Gateway Interop (Nuvira sidecar mode)

**Goal:** opt-in breadth for teams that want hundreds of providers / free tiers / multi-account rotation *today*, while our decision layer stays authoritative and security stays locked down.

**Milestones**

- **M5.1 — Sidecar profile.** `docker-compose.nuvira.yml` (pinned external-gateway image; `base` profile; healthcheck) + `buff doctor --nuvira` probe (GET `/v1/models`, report version). ✅ Doctor test with mock endpoint.
- **M5.2 — Config & docs.** `provider.nuvira.baseUrl` documented; security defaults: bind 127.0.0.1, require auth token, never expose publicly; upgrade guide + Product_Guide + README rows. ✅ Docs review checklist.
- **M5.3 — E2E through the gateway.** Hermetic test with a mock gateway-shaped server: `/v1/models` + chat + one model 429 → registry learns block → next pick skips (mirrors `failover-learning.test.ts`). ✅ E2E green.
- **M5.4 — Version pinning & upgrade policy.** Pin image/tag; document upgrade cadence; feature-flag `routing.nuviraSidecar.enabled` default **false**.

🛡️ **Guarantee:** everything disabled by default; no new runtime deps when unused; existing `local` free-first gate unaffected.
🎯 **Selection-criteria:** sidecar-hosted models join the same registry/bandit learning (P1 adapter already ensures this).
📊 **Presentation:** `doctor` + dashboard show sidecar health as a provider row (existing patterns).
⚠️ **Edge cases:** sidecar down (adapter reports `unavailable`, router skips — existing `isAvailable` path); image registry unreachable; token leakage in logs (redaction, N6); sidecar version drift.
**Tests:** ~8 new. **Effort:** 6–8 team-days. **Deps:** P1. **Explicitly optional** — can ship any time after P1.

---

### Phase 6 — Enterprise Hardening (authn/z, secrets, audit, governance, HA, supply chain)

**Goal:** procurement-ready enterprise posture. Product-shaped; largest phase; split into sub-milestones that each ship independently.

**Milestones**

- **M6.1 — AuthN/AuthZ.** RBAC layer over `src/agents/credential-store.ts` / team config: roles (admin/operator/viewer), scoped permissions; optional OIDC/SAML via `src/enterprise/auth/` adapter interface (local default). ✅ RBAC matrix tests.
- **M6.2 — Secrets management.** ✅ v1.59.0: central `src/enterprise/secrets.ts` redaction scrubber wired into EVERY logger method + both JSONL audit writers; 12 scrubber tests; nothing sensitive in any log/audit. (Vault/keychain backends behind the interface — future work.)
- **M6.3 — Tamper-evident audit log.** ✅ v1.59.0: `src/enterprise/audit-chain.ts` SHA-256 hash-chained records + sidecar head state + `verifyChain` tamper-line detection + CEF/SIEM export + `buff audit verify/export`; `doctor --enterprise` chain verification; 13 chain + 8 CLI + 4 doctor tests.
- **M6.4 — Nuvira Gateway (central mode).** `buff nuvira serve`: headless OpenAI-compatible server exposing our decision layer (the P1 adapter in reverse); optional shared state (Redis or SQLite+file-lock) so a fleet shares registry/ledger. ✅ Gateway E2E (curl through it); concurrency tests.
- **M6.5 — Model governance enforcement.** Admin allow/deny + policy rules enforced in `auto-router` hard constraints (schema from M2.4 promoted to admin API). ✅ Governance tests.
- **M6.6 — Supply chain.** SBOM (cyclonedx), SLSA provenance on releases, signed VSIX/tarball, license audit. ✅ `npm sbom` output validated.

🛡️ **Guarantee:** single-user local mode remains the default and is fully functional (enterprise features are layered, never required); all existing CLI flows unchanged.
🎯 **Selection-criteria:** governance constraints (M2.4) become admin-enforced — selection now respects org policy.
📊 **Presentation:** dashboard gains an admin/audit view (existing panels untouched).
⚠️ **Edge cases:** RBAC default-deny; key rotation mid-session; audit store full (rotation policy); gateway concurrent key access (locking); SIEM export size limits.
**Tests:** ~35 new. **Effort:** 25–35 team-days (sub-milestones ship independently). **Deps:** P2 (governance schema), P3 (observability).

---

### Phase 7 — Rollout, Documentation & Adoption

**Goal:** everything is discoverable, upgradeable, and measurable; the roadmap becomes the product narrative.

**Milestones**

- **M7.1 — `buff doctor --enterprise`** self-check (gateway health, secrets backend, audit integrity, RBAC config). ✅ Doctor tests.
- **M7.2 — Upgrade guide + migration notes** in `UPGRADE_ROADMAP.md` (new section) + CHANGELOG per release. ✅ Doc review.
- **M7.3 — Website + Product_Guide + tests/README** updated per phase (test counts, feature rows). ✅ Consistency sweep script (no stale counts).
- **M7.4 — Telemetry/usage health** for gateway traffic (opt-in, privacy-preserving, off by default). ✅ v1.58.9: `routing.gatewayTelemetry.enabled` / `healthFlags` + `doctor --enterprise` Telemetry Health check + flag tests.
- **M7.5 — Milestone tracker hygiene** — this roadmap's tracking matrix kept current each release.

🛡️ **Guarantee:** docs never claim unshipped features (feature rows only after phase closes).
🎯/📊 **Selection & presentation:** consolidated — new capabilities documented with worked examples (`models explain --deep` sample outputs in docs).
⚠️ **Edge cases:** doc drift; stale test counts (sweep script); disabled-feature confusion (clear "off by default" callouts).
**Tests:** ~6 new. **Effort:** 5–8 team-days (continuous after). **Deps:** all.

---

## 5. Milestone Tracking Matrix

> Update after each release. ✅ = done · 🚧 = in progress · ⬜ = not started.

| Phase | Milestone | Issue | Status | Released in |
|---|---|---|---|
| P0 | M0.1 Baseline lock | [#1](https://github.com/imdheerajKube/agent-nuvira/issues/1) | ✅ | `af1f931` |
| P0 | M0.2 Shared failover runner | [#1](https://github.com/imdheerajKube/agent-nuvira/issues/1) | ✅ | Stages A/B/C shipped |
| P0 | M0.3 Orchestrator resolve consultation | [#1](https://github.com/imdheerajKube/agent-nuvira/issues/1) | ✅ | Session-excluded provider never wins a task; fallbackChain filtered; all-excluded degrades gracefully |
| P0 | M0.3 Telemetry schema v2 | [#1](https://github.com/imdheerajKube/agent-nuvira/issues/1) | ⬜ | — |
| P0 | M0.4 Mid-stream classification | [#1](https://github.com/imdheerajKube/agent-nuvira/issues/1) | ⬜ | — |
| P1 | M1.1 Nuvira adapter | [#2](https://github.com/imdheerajKube/agent-nuvira/issues/2) | ✅ | `src/inference/nuvira-adapter.ts` |
| P1 | M1.2 Factory + config | [#2](https://github.com/imdheerajKube/agent-nuvira/issues/2) | ✅ | factory case + ProviderType + headers/timeoutMs + picker/doctor/router lists |
| P1 | M1.3 Registry/ledger write-through | [#2](https://github.com/imdheerajKube/agent-nuvira/issues/2) | ✅ | Free — adapter implements InferenceProvider, all telemetry applies |
| P1 | M1.4 Parity harness | [#2](https://github.com/imdheerajKube/agent-nuvira/issues/2) | ✅ | 14 mock-server parity tests |
| P2 | M2.1 Capability-aware scoring | [#3](https://github.com/imdheerajKube/agent-nuvira/issues/3) | ✅ | `a34e58c` |
| P2 | M2.2 Wire-token cost inputs | [#3](https://github.com/imdheerajKube/agent-nuvira/issues/3) | ✅ | `e6a554b` |
| P2 | M2.3 Multi-account rotation | [#3](https://github.com/imdheerajKube/agent-nuvira/issues/3) | ✅ | `9703a78` |
| P2 | M2.4 Governance constraints | [#3](https://github.com/imdheerajKube/agent-nuvira/issues/3) | ✅ | `dfccd81` |
| P2 | M2.5 Context-length preflight | [#3](https://github.com/imdheerajKube/agent-nuvira/issues/3) | ✅ | `abb282d` |
| P3 | M3.1 Decision rationale | [#4](https://github.com/imdheerajKube/agent-nuvira/issues/4) | ⬜ | — |
| P3 | M3.2 Requests panel | [#4](https://github.com/imdheerajKube/agent-nuvira/issues/4) | ⬜ | — |
| P3 | M3.3 Decision diff | [#4](https://github.com/imdheerajKube/agent-nuvira/issues/4) | ⬜ | — |
| P3 | M3.4 Timeline enrichment | [#4](https://github.com/imdheerajKube/agent-nuvira/issues/4) | ⬜ | — |
| P4 | M4.1 Continuation retry | [#5](https://github.com/imdheerajKube/agent-nuvira/issues/5) | ✅ | v1.58.4 |
| P4 | M4.2 Reasoning-replay cache | [#5](https://github.com/imdheerajKube/agent-nuvira/issues/5) | ✅ | v1.58.4 |
| P4 | M4.3 Context-relay summaries | [#5](https://github.com/imdheerajKube/agent-nuvira/issues/5) | ✅ | v1.58.4 |
| P4 | M4.4 Conservative compression | [#5](https://github.com/imdheerajKube/agent-nuvira/issues/5) | ✅ | v1.58.7 |
| P5 | M5.1 Sidecar profile + doctor | [#6](https://github.com/imdheerajKube/agent-nuvira/issues/6) | ✅ | v1.58.4 |
| P5 | M5.2 Config & docs | [#6](https://github.com/imdheerajKube/agent-nuvira/issues/6) | ✅ | v1.58.4 |
| P5 | M5.3 E2E through gateway | [#6](https://github.com/imdheerajKube/agent-nuvira/issues/6) | ✅ | v1.58.4 |
| P5 | M5.4 Pinning & upgrade policy | [#6](https://github.com/imdheerajKube/agent-nuvira/issues/6) | ✅ | v1.58.4 |
| P6 | M6.1 AuthN/AuthZ (RBAC) | [#7](https://github.com/imdheerajKube/agent-nuvira/issues/7) | ⬜ | — |
| P6 | M6.2 Secrets management | [#7](https://github.com/imdheerajKube/agent-nuvira/issues/7) | ✅ | v1.59.0 |
| P6 | M6.3 Tamper-evident audit | [#7](https://github.com/imdheerajKube/agent-nuvira/issues/7) | ✅ | v1.59.0 |
| P6 | M6.4 Nuvira Gateway (central) | [#7](https://github.com/imdheerajKube/agent-nuvira/issues/7) | ⬜ | — |
| P6 | M6.5 Governance enforcement | [#7](https://github.com/imdheerajKube/agent-nuvira/issues/7) | ✅ v1.59.6 | `buff admin policy/allow/deny/allow-model/deny-model/max-cost/pii-min/unblock/clear` |
| P6 | M6.6 Supply chain (SBOM) | [#7](https://github.com/imdheerajKube/agent-nuvira/issues/7) | ✅ | v1.59.4 |
| P7 | M7.1 doctor --enterprise | [#8](https://github.com/imdheerajKube/agent-nuvira/issues/8) | ✅ | v1.58.7 |
| P7 | M7.2 Upgrade guide | [#8](https://github.com/imdheerajKube/agent-nuvira/issues/8) | ✅ | v1.58.7 |
| P7 | M7.3 Website/docs sync | [#8](https://github.com/imdheerajKube/agent-nuvira/issues/8) | ⬜ | — |
| P7 | M7.4 Telemetry health flags | [#8](https://github.com/imdheerajKube/agent-nuvira/issues/8) | ✅ | v1.58.9 |
| P7 | M7.5 Tracker hygiene | [#8](https://github.com/imdheerajKube/agent-nuvira/issues/8) | ⬜ | — |

---

## 6. Cross-Cutting Requirements (apply to every phase)

1. **Testing:** every milestone lands with unit + integration tests; regression gate (`failover-learning.test.ts` + full suite) runs in CI per PR.
2. **Config:** additive-only keys; old state files always load; `buff config` schema docs updated.
3. **Telemetry:** every new behavior emits structured events; per-action tags preserved; `correlationId` propagated (P3).
4. **Docs:** CHANGELOG entry, Product_Guide + README rows, tests/README counts, website — same release as the code.
5. **Versioning:** semver; feature-flag off-by-default for anything risky; release notes per milestone.
6. **Security:** secrets never logged; gateways bind localhost by default; compression never lossy on code; prompt-injection guard respected (existing `security/scanner`).

## 7. Success Criteria & KPIs

- **P1:** any OpenAI-compatible endpoint usable via `--provider nuvira`, parity-tested.
- **P2:** `models explain` shows 5+ scored dimensions; governance constraints enforced; context preflight estimated.
- **P3:** 100% of routing decisions explainable (`--deep`); Requests panel live; p95 shown ≥10 samples.
- **P4:** tasks completing despite ≥1 mid-stream failure: **target >95%** (from ~0% continuity today); wire-exact cost for gateway traffic.
- **P5:** opt-in sidecar: `doctor` healthy, failover learned E2E, all security defaults verified.
- **P6:** RBAC/audit/governance suites green; SBOM shipped; `buff nuvira serve` operational.
- **Overall:** 3,032 → ~3,200+ tests, zero regressions, per-phase CHANGELOG.

## 8. Risk Register

| Risk | L | I | Mitigation |
|---|---|---|---|
| Refactor drift in failover-runner (P0) breaks a subtle path | M | H | Behavior-identical extraction with E2E golden tests; review |
| Measured-cost inputs skew selection when provider under-reports | M | M | Estimate fallback + `estimated` flag; never trust blindly |
| Compression ever touches code semantics | M | H | Off by default; own conservative pruner; property test |
| External gateway upstream fragility | M | M | Optional + pinned; our adapters stay canonical |
| Gateway exposure leaks keys | M | H | localhost bind, token auth, docs, redaction |
| Enterprise scope creep | M | M | Sub-milestones ship independently; enterprise track separate after P4 |
| Sidecar image unavailable offline | L | M | Graceful `unavailable` → skip (existing path) |

## 9. Suggested Execution Order (with sequencing rationale)

1. **P0 → P1** (foundation + adapter): small, safe, unlocks everything.
2. **P2 → P3** (selection + presentation): the visible "enhancement" the user asked for.
3. **P4** (resilience): the highest-value patterns; can interleave with P2/P3.
4. **P5** (optional sidecar): any time after P1 — do it only if breadth is a priority.
5. **P6** (enterprise): after P2/P3; sub-milestones ship independently.
6. **P7** (rollout): continuous.

## 10. Review & Governance

- Each phase closes with: code review, full-suite regression gate, docs sweep, and a status update to this tracker (§5).
- No phase is "done" until its Non-Regression Guarantee and Edge-cases checklists are empty.
- Major deviations (scope, naming, dependencies) recorded here under "Decisions Log".

### Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-08-05 | Feature named **Nuvira-Router**; external project referenced only in §11 | Product branding; no third-party name in agent-nuvira |
| 2026-08-05 | Gateway adopted as **adapter + optional sidecar**, never a hard dependency | Zero-regression + footprint discipline |

---

## 11. Appendix — External Inspiration Reference (do not use in product naming/docs)

For traceability, the analysis that informed this roadmap cloned **diegosouzapw/OmniRoute** (v3.8.50, MIT, self-hosted, local-only; `http://localhost:20128/v1`, OpenAI-compatible; combo/account fallback, policy engine, circuit breakers, reasoning-replay cache, context relay, compression pipeline, 290 providers/19 strategies; clone at `/tmp/omniroute-analysis`). Its *patterns* (reasoning replay, context relay, wire-token metering, account rotation) are ported natively in P4/P2 with our own conservative defaults. Its weaknesses (lossy compression, MITM cert friction, upstream fragility, heavy footprint) are explicitly avoided by this roadmap (N6, P4.4, P5 pinning).

*End of roadmap.*
