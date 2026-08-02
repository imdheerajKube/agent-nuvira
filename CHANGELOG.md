# Changelog

All notable changes to **Agent-Nuvira** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [1.45.4] - 2026-08-02

### Added

- **Real-time quota events over SSE** — the dashboard server now watches
  `quota-events.jsonl` / `quota-ledger.json` in the memory dir and pushes a
  dedicated `quota` SSE event the moment a failover, park, or window reset is
  written (from the CLI, chat failover, or any process sharing `BUFF_MEMORY_DIR`)
  — the Failover Timeline updates instantly instead of waiting for the next 10s
  refresh tick. The watcher is armed only while a dashboard client is connected
  and disarmed when the last one disconnects; debounced so rapid append bursts
  coalesce into a single push
- **Frontend `quota` SSE handler** — `api.ts` merges the pushed quota payload
  into `routing.quota` and notifies subscribers, so the Quota card + Failover
  Timeline re-render in real time (mirrors the existing `dag` event pattern)

## [1.45.3] - 2026-08-02

### Added

- **Quota failover timeline** — a persistent event log (`~/.buff/memory/quota-events.jsonl`, capped at 200 events) records when providers are **parked**, **re-enabled** (window reset), **released** (manual), or **failed over** mid-session (auth/rate-limit). Chat's auto-mode failover bookkeeping writes `failover` events directly; the ledger's park/release/window-roll paths write the rest (assessment item #7: "show which models were used and when failover occurred")
- **Dashboard Failover Timeline card** — the 📒 Quota Ledger panel now renders the recent event timeline (type, provider, reason, time) from `/api/routing` (`quota.events`, newest first, max 50, corrupt-line-safe)
- **CLI failover timeline** — `buff model quota` shows the last 20 events in the human output and includes them as `events` in `--json` — and renders them even when the ledger has no usage entries yet (failovers can precede any successful call)

### Fixed

- **Empty-ledger dashboard timeline** — `readQuotaData()` previously returned without the `events` field when no `quota-ledger.json` existed, hiding the failover timeline; it now always includes events

## [1.45.2] - 2026-08-02

### Added

- **`buff model quota` cost summary** — the quota CLI now renders a free/local-first
  cost section (free tokens/requests vs paid tokens/requests + an estimated $ saved
  figure) and includes the same `costSummary` in `--json` output, mirroring the
  dashboard's Quota card (assessment item #7 transparency: tokens saved / paid usage
  triggered)
- **QuotaLedger.getCostSummary()** — the ledger now exposes a shared free/paid
  classification + savings estimate (local + Gemini free tier = free; everything
  else = paid; conservative $0.0005/1K blended paid rate), window-rotated so the CLI
  summary always agrees with the status table rendered above it
- **Checkpoint CLI smoke tests** — `--checkpoint` / `--resume [id]` /
  `--checkpoint-list` option mapping is now covered in `tests/cli/execute.test.ts`
  (empty-list hint, listing with progress %, `--checkpoint-list` routing, resume-id
  round-trip, and the four `checkpointOptions()` flag combinations)

### Changed

- `src/cli/execute.ts` — checkpoint flag mapping extracted into an exported pure
  helper `checkpointOptions(checkpoint, resume)` so the option wiring is
  unit-testable and the `checkpoint: options.checkpoint || !!options.resume`
  semantics are preserved exactly (plain runs never checkpoint by default)
- `src/agents/test-module.ts` — sandboxed test runs now **skip `npm install` when
  the project declares zero dependencies**, fixing a flaky CI test caused by a
  network-bound npm install on dep-less temp projects; sandboxing is faster and
  hermetic for offline/CI environments

### Tests

- `tests/learning/quota-ledger.test.ts` — 3 new `getCostSummary()` tests (free/paid
  classification + savings math, zeroed empty ledger, unknown providers = paid)
- `tests/cli/execute.test.ts` — 5 new checkpoint CLI smoke tests

---

## [1.45.1] - 2026-08-02

### Fixed

- **`--checkpoint` no longer silently resumes a stale checkpoint** — plain
  `buff execute "<goal>" --checkpoint` (no resume intent) previously loaded any
  prior checkpoint at the auto id (goal + cwd) — including a previously
  **completed** run — and re-entered it, skipping every task and reporting
  success without doing work. The checkpoint LOAD is now gated strictly on
  resume intent (`--resume` / `resumeRequested` / explicit id); `--checkpoint`
  always starts fresh while still saving forward. A resumed run (including
  direct API callers that only set `resumeRequested`) keeps checkpointing
  forward. Regression test covers the stale-checkpoint case

## [1.45.0] - 2026-08-02

### Added

- **Checkpoint / resume** — `buff execute "<goal>" --checkpoint` saves a
  resume-able snapshot after every task batch (task plan with per-step
  statuses, artifacts, file changes, metadata) to `~/.buff/memory/checkpoints/`
  (honors `BUFF_MEMORY_DIR`). A crash / quota kill / token expiry mid-pipeline
  no longer restarts the whole plan: `buff execute "<goal>" --resume [id]`
  rehydrates the vault and continues from the first pending step, skipping
  completed steps and the planner entirely (assessment item #6: continuity
  across models). Bare `--resume` auto-finds the id for the current goal + cwd;
  `--checkpoint-list` shows saved checkpoints
- **Quota cost-transparency card** — the dashboard's 📒 Quota Ledger panel now
  splits tracked usage into **free/local tokens** (local + Gemini free tier —
  $0) vs **paid tokens** (actual spend triggered), shows the free-tier share of
  usage, and an **estimated $ saved** figure (free tokens × conservative paid
  rate). Assessment item #7: show users which models were used and how
  free/local-first routing saved money

### Tests

- New `tests/agents/checkpoint-store.test.ts` (save/load round-trip,
  deterministic auto id, listing, corrupt-file handling, function-field
  stripping)
- Orchestrator checkpoint-resume regression tests (resume skips completed steps
  + planner; fresh pipeline on missing id)

## [1.44.0] - 2026-08-02

### Added

- **Central quota ledger** — `QuotaLedger` tracks tokens/requests per provider ×
  model with calendar-aware reset windows (daily/hourly free-tier limits).
  Exhausted providers are **parked** (excluded from Auto routing) until the
  window rolls — automatic re-enable at the exact reset boundary, no timers.
  Every LLM call write-throughs usage via `CostTracker.recordCall`. Persists to
  `~/.buff/memory/quota-ledger.json` (honors `BUFF_MEMORY_DIR`); all writes
  best-effort
- **Predictive quota-aware routing** — Auto routing sinks quota-parked providers
  below healthy candidates BEFORE a call is made (previously only reactive
  failover). Wired into the AutoModelRouter, chat, and orchestrator
- **Free/local-first gate** — `routing.allowPaid: false` excludes PAID providers
  for non-complex tasks (trivial/simple/moderate) so free/local models win unless
  complexity demands otherwise; complex/critical tasks may still use paid
  high-capacity models. Falls back safely if the gate would eliminate everyone
- **Per-subtask complexity labels** — the Planner now emits a `complexity` label
  per `TaskStep` (trivial → critical); the orchestrator labels any step lacking
  a valid label and threads the label into routing as `complexityHint`, so each
  subtask routes by its OWN complexity, not the whole goal's
- **`buff model quota` CLI** — inspect the ledger (tokens/requests per
  provider × model, resets in, parked state), `--json` for scripting, and
  `reset` to clear
- **`routing.quota` config** — per-provider `tokensPerWindow` /
  `requestsPerWindow` / `windowMs` limits via `buff config set routing.quota.<provider>.*`
- **Mid-session failover persistence** — rate-limit failures now park the
  provider in the central ledger, so the exclusion survives across chat sessions
  (auth failures stay permanent, never re-enabled by a window roll)
- **Dashboard quota card + DAG complexity badges** — the web dashboard's
  🤖 Routing panel shows live quota status; DAG nodes display their complexity
  label
- **Assessment-gap roadmap** — [ASSESSMENT_OPPORTUNITIES.md](ASSESSMENT_OPPORTUNITIES.md)
  maps the coding-assessment recommendations (cost-efficient tier routing,
  quota ledger, graceful failover, cost transparency) to implementation status

### Tests

- New `tests/learning/quota-ledger.test.ts` (usage recording, window rotation
  auto re-enable, exhaustion parking, `getBestAvailable` never-empty, persistence)
- New `tests/learning/quota-routing.test.ts` (complexityHint, allowPaid gate,
  quota-sink ranking)
- Orchestrator regression test for per-step complexity labeling

## [1.43.0] - 2026-08-02

### Added

- **Startup progress feedback (first-run UX)** — `agent-nuvira` now shows a live
  spinner with phase text while starting up (`⚙️ Loading plugins…`,
  `⚙️ Initializing history & search…`, `📦 Building semantic search index…`) so a
  cold start never looks like a silent hang. Ora auto-suppresses when stdout is
  not a TTY, keeping piped output clean
- **Model-picker loading progress** — provider availability checks now show a
  spinner, print per-provider loading progress, and each `isAvailable()` /
  `listModels()` call is wrapped in a timeout so one hanging provider can't
  stall first run or `model switch`
- **Live model-list cache (60s TTL)** — `model-validator.ts` caches
  `listModels()` results for 60 seconds (was: re-fetched on every auto-routed
  chat message, a real per-message latency cost). Failures are not cached.
  `buff config set providers.*` clears the cache immediately so a new
  key/model/baseURL takes effect right away

### Fixed

- **Auto-mode failover on token expiry** — when Auto routing picked a provider
  whose API key/token expires mid-session (Gemini token-limit errors, OpenRouter
  401s, quota exhaustion), chat used to get stuck re-failing on the same
  provider. Now the session **remembers failed providers** and Auto routing
  routes around them: auth failures (expired key) exclude the provider for the
  whole session, rate-limit failures for a 120s cooldown (aligned with the
  circuit breaker), and 5xx/network errors flow through the circuit breaker
  only. In-cooldown providers are deprioritized by router scoring, the final
  fallback always prefers a non-failed provider, and the failover is
  crash-proof — a throwing re-route can't kill the interactive loop
- **Broader rate-limit classification** — `classifyFallbackError` (and the chat
  error handler) now recognize `token limit`, `resource has been exhausted`,
  and `insufficient_quota`, so these are labeled "Rate limit" (retryable)
  instead of falling through as unknown

---

## [1.42.1] - 2026-08-02

### Fixed

- **Pre-existing CI test failures (hermetic + cross-platform)** — fixed the five
  environment-dependent test failures that had kept `test-linux.yml` red since
  v1.41.1: `model.test.ts` seeds API keys so the explain JSON has a non-empty
  fallback chain in a fresh-HOME CI; `safe-execution-layer.test.ts` uses a
  hermetic `SandboxManager` stub (Docker-enabled runners);
  `inspect-module.test.ts` skips the unreadable-dir assertion on Windows (no
  POSIX chmod read bits); `history.test.ts` uses `TMPDIR || TEMP || '/tmp'`
  instead of a hardcoded `/tmp`; and the dashboard server tests pin
  `BUFF_MEMORY_DIR` before module import so the suite stays hermetic even when a
  developer exports it in their shell
- **Dashboard memory-dir consistency** — the dashboard server now honors
  `BUFF_MEMORY_DIR` (`MEMORY_DIR = BUFF_MEMORY_DIR || ~/.buff/memory`), so the
  bandit card and the promotion-gate card always read from the same directory as
  the CLI and the learning router

### Added

- **Promotion-gate verdict in the dashboard** — the 🤖 Routing panel now renders a
  live 🎖️ Promotion Gate card (ruflo ADR-150 mirror): promoted / not-promoted /
  collecting-data verdict, sufficiency progress (diverged vs. min decisions), and
  the three criteria — quality >+2%, cost <+1%, latency <+5% — with pass/fail
  chips. Unmeasured latency honestly renders a `○ neutral` chip instead of a
  misleading green pass. Backed by `readPromotionData()` on `/api/routing`
  (also wired into `/api/all` and SSE)
- **CI routing regression guard** — `test-linux.yml` runs the four learning-router
  test files (bandit / promotion gate / auto-router / tier-0) in a dedicated step
  before the full suite, so routing regressions fail fast with a clearly-labeled
  step
- **Dashboard component tests** — first frontend unit tests: the dashboard's own
  vitest + jsdom + Testing Library setup (`src/web-dashboard/vitest.config.ts`,
  `npm test`) covering `PromotionGateSection` rendering states (promoted,
  collecting-data, not-promoted, neutral latency, hidden-empty, absent data), wired
  into CI as a dedicated `Dashboard component tests` step

---

## [1.42.0] - 2026-08-02

### Added

- **Uncertainty-driven escalation (ruflo model-router mirror)** — when the
  bandit's winner has almost no accumulated samples (α+β <
  `routing.escalationMinSamples`, default 8), Auto routing **escalates to the
  next-ranked provider that HAS learned data** instead of committing to a
  cold-start guess — a strictly better cold-start policy. A sanity bound
  (`ESCALATION_WIN_RATE_FLOOR = 0.55`) ensures a learned-but-failing provider
  can never steal routing from a strong cold-start winner. Decisions record a
  `banditEscalation` flag + `| escalated: winner unlearned` explanation marker
- **Per-modelId bandit priors (ruflo ADR-149 mirror)** — the learning router now
  learns per **concrete model**, not just per provider: `modelPriors[complexity]
  [modelId] = Beta(α, β)` shadow state updated alongside provider priors
  (`recordModelOutcome`), so `llama-3.3-70b-versatile` ≠ `openai/gpt-oss-20b`
  within the SAME provider. `resolveModelWithLearning()` keeps the configured
  pin on cold start (deterministic) and picks the best Thompson-sampled
  LEARNED model once data accumulates — the model choice learns too. State file
  bumped to v2 (`router-bandit.json`), CLI shows per-model α/β heatmap
- **Promotion gate / A/B validation (ruflo router-parallel mirror)** — new
  `src/learning/router-promotion.ts` answers "is the bandit actually better than
  the heuristic?" on real trajectories. Every auto-routed task records BOTH the
  deterministic pick and the bandit pick (keyed by agentType+task, bounded at
  64 pending), and `recordOutcome()` finalizes it with the real result to
  `~/.buff/memory/router-promotion.jsonl`. `evaluate()` applies ruflo's THREE
  promotion criteria — quality ↑ > 2%, cost regression < 1%, p95 latency
  regression < 5% — over diverged decisions only, with `sufficient`/`promoted`
  verdicts. Config: `routing.promotionMinDecisions` (default 20). `buff model
  bandit` now renders the gate (human + `--json`); `bandit reset` clears the
  trajectory too

---

## [1.41.2] - 2026-08-01

### Fixed
- **Auto routing only uses working models — no more 401/404 surprises**
  - Picking **Auto** in the model picker now enables per-message routing instead of handing a literal `'auto'` to `resolveProvider()` (which silently fell back to an unconfigured default like OpenRouter with no key → 401)
  - Auto routing **only scores providers that have credentials** configured (`getDefaultAllowedProviders()` filters by `hasRequiredCredentials`), so it never picks a provider that would 401
  - `resolveProvider('auto')` now falls back to the **first provider with credentials** (groq → nim → gemini → openrouter → local) instead of the unconfigured default
- **Model health validation** — Auto routing validates the resolved model against the provider's **live model list** and repairs stale/deprecated/placeholder pins (e.g. Gemini's retired `gemini-2.0-flash-exp` → 404, NIM's `new-nim-model`) to a curated known-working default before sending a request
- **Runtime failover** — if a routed provider still fails at generate time (quota exhausted 429, deprecated model 404 — Gemini's model list can list models a key can't actually use), chat **automatically walks the ranked candidates and answers from the first working provider** instead of crashing; the orchestrator and `benchmark --routing` apply the same model-health validation

### Added
- `src/inference/model-validator.ts` — live-list model validation + curated per-provider working defaults (`resolveWorkingModel`)
- Regression tests: `tests/inference/model-validator.test.ts` (12 tests), `tests/cli/router.test.ts` (4 tests), deterministic auto-routing tests in `tests/cli/chat.test.ts`, credential-filtering tests in `tests/learning/auto-router.test.ts`

> **Note:** this release bundles the previously-unreleased routing work
> (learning bandit, tier-0 deterministic routing, routing rules/hard
> constraints, dashboard routing panels, per-provider model drill-down, VS Code
> extension updates) — everything that shipped in this published tarball.

---

## [1.41.0] - 2026-07-31

### Added
- **`buff model list --json`** — structured JSON output (`{ active, providers: [...] }`)
  for provider/status/availability listing, powering reliable parsing in the VS Code
  extension's model & provider switcher
- **`buff models --json`** — machine-readable per-provider model listing
  (`{ models: [{ provider, providerType, name, id, owner, description }] }`) with pure
  JSON on stdout (no spinner/log decoration). `providerType` is included so consumers can
  switch directly with `buff model switch <provider>/<model>`. Honors `-p` and `-s` filters

### Changed
- `src/cli/models.ts` — new `-j/--json` flag; human output (ora spinner, logger lines,
  results table) is gated behind non-JSON mode so scripting stays parseable
- `src/cli/model.ts` — `model list` gained `-j/--json` output

### Tests
- `tests/cli/models.test.ts` (7 tests) — JSON shape, `providerType` presence, `-p`/`-s`
  filters, pure-JSON stdout, empty-list and fetch-error fallbacks

---

## [1.40.0] - 2026-07-31

### Added
- **`buff eval --routing`** — evaluates the exact provider/model pairs the Auto router
  picks for each eval task (via `getAutoRouter().resolve` with runtime stats), dedupes
  distinct picks with task counts, records each decision to the routing-history store,
  runs the full Agent Evaluation framework against every pick (skipping unavailable
  providers), then ranks the picks by composite score with a 🏆 best-pick summary —
  closing the routing → **reliability** loop (not just response quality). Warns when
  `--provider`/`--model`/`--format` are ignored in routing mode
- **Routing History Store** — `src/learning/routing-history.ts`: records every Auto
  router decision (`recordRoutingDecision`) to `~/.buff/memory/routing-history.json`
  (capped at 500, best-effort writes, `BUFF_MEMORY_DIR` override for tests). Query with
  `getRoutingHistory()` / `getRoutingUsageStats()` / `clearRoutingHistory()`. Sources:
  chat (per message), orchestrator (per auto-routed task), explain (human + `--json`
  snapshots), benchmark `--routing`, eval `--routing`
- **Dashboard Routing Usage + Audit Trail** — the 🤖 Routing panel now shows:
  - **Routing Usage — actual picks over time** — totals, last-24h, per-provider pick
    counts, per-source breakdown (chat/orchestrator/explain/benchmark/eval), and most-
    picked models
  - **Audit Trail — routing decision timeline** — the 30 most recent decisions with
    source badge, winner provider/model, complexity, task, and relative time
  Backed by `readRoutingUsage()` + `readRoutingHistory()` in the `/api/routing` payload
  (also wired into `/api/all` and SSE)

### Changed
- `eval.ts` — `--routing` flag + `runEvalRouting()` (mirrors `runRoutingBenchmark`)
- `chat.ts` / `orchestrator.ts` / `benchmark.ts` / `model.ts` — record routing decisions
  to the history store (sources: chat, orchestrator, benchmark, explain)
- Dashboard frontend — `RoutingInsightsPanel` usage + audit sections; `types.ts` extended
  with `RoutingUsage` / `RoutingHistoryEntry`
- Docs — README (`eval --routing` example), User_Manual (Auto Model Routing §), Product_Guide
  (feature inventory rows 73–75 + Key Upgrades rows)

### Tests
- `tests/learning/routing-history.test.ts` (10 tests) — record/get/usage aggregation,
  clear, 500-entry cap, corruption resilience
- `tests/cli/eval.test.ts` (5 tests) — routing mode dispatch, pick dedupe, per-pick suite
  run, comparison table + best pick, unavailable-provider skip, history recording
- `tests/web-dashboard/server.test.ts` — `/api/routing` usage aggregation + audit-timeline
  ordering + missing-file grace (3 new tests)

---

## [1.39.3] - 2026-07-31

### Added
- **`buff benchmark --routing`** — benchmarks the exact provider/model pairs the Auto router
  picks for each benchmark task (via `getAutoRouter().resolve` with runtime stats), dedupes
  distinct picks with task counts, runs the filtered suite against every pick (skipping
  unavailable providers), then ranks them by measured quality with a 🏆 best-pick summary.
  Closes the routing → quality loop: results feed the router's runtime stats. Warns when
  `--provider`/`--model`/`--format` are ignored in routing mode
- **`buff model explain --json`** — machine-readable explain output for scripting and CI.
  Single task → one decision object; no task → all 5 sample complexities. Payload includes
  task, agentType, complexity, taskType, weights, winner, ranked providers (score, reason,
  dimensions, cooldown), fallback chain, and effective per-provider pricing with override flags
- **Explain command now matches production routing** — `renderRoutingDecision` resolves with
  `useRuntimeStats: true` (same as chat/orchestrator) so the displayed decision reflects
  benchmark- and agent-stats-adjusted scores
- **Tests (6)** — `tests/cli/model.test.ts`: detailed render, 5-complexity walk, single-task
  JSON, sample-array JSON, `--agent` routing, ranked best-first ordering

### Changed
- `benchmark.ts` — `--routing` flag + `runRoutingBenchmark()`; `BenchmarkRun` type import
- `model.ts` — `-j, --json` option + `buildExplainJSON()`
- Docs — README (explain `--json` + `benchmark --routing` examples), User_Manual (Auto Model
  Routing § + benchmark options), Product_Guide Key Upgrades rows

---

## [1.39.2] - 2026-07-31

### Added
- **Configurable routing pricing** — `buff config set pricing.<provider>.inputPer1K|outputPer1K`
  overrides any provider's per-1K-token cost used by the Auto router's cost dimension
  (deep-merged per provider so both fields survive sequential sets; free tiers default to $0)
- **`buff model explain [task]`** — transparency command showing why Auto routing picks a
  provider/model: detected complexity, task type, dimension weight bars, ranked provider table
  with reasons, winner, and fallback chain. With no task it walks all 5 complexity levels;
  `--agent <type>` routes for a specific agent. Powered by the new `weights` field on
  `AutoRouteResult`
- **Dashboard Routing Insights** — new `GET /api/routing` endpoint + 🤖 Routing dashboard panel
  (nav item, `/routing` route): per-provider benchmark quality (avg quality, pass rate, cost),
  best model per agent type from agent stats, and Auto-router preference across complexity
  levels. Wired into `/api/all` and SSE init/refresh payloads

### Changed
- `auto-router.ts` — `getProviderPricing()` resolves config override ?? built-in table;
  `estimateCallCostUsd` / `computeCostScore` accept optional pricing overrides
- `config/manager.ts` — `pricing` config section loaded, deep-merged, and saved
- `config.ts` — `buff config set pricing.*` + `buff config list` pricing section
- `model.ts` — `explain` subcommand registered
- `web-dashboard/server.ts` + React frontend — routing insights API, `RoutingInsightsPanel`,
  rebuilt dashboard assets
- Docs — README, User_Manual (Auto Model Routing §), Product_Guide Key Upgrades rows

### Tests
- config manager: pricing default/load/merge/save + sequential-save regression (5 tests)
- auto-router: pricing overrides (5) + result weights (2)
- dashboard server: `/api/routing` empty/fixture/malformed + `/api/all` routing field (4 tests)

---

## [1.39.1] - 2026-07-31

### Added
- **Real provider pricing in Auto routing** — `PROVIDER_PRICING_PER_1K` table with actual
  per-1K-token list prices (input/output) per provider; the cost dimension score is now derived
  from real pricing via `estimateCallCostUsd()` / `computeCostScore()` instead of static profiles.
  Free tiers (local, Gemini) score 1.0; OpenRouter priced at GPT-4o-class pass-through. Opt out
  per call with `useRealPricing: false`.
- **Runtime-stats-driven routing** — `useRuntimeStats` option blends real benchmark quality
  scores into the reasoning dimension (70% static / 30% measured) and boosts reliability + reasoning
  for the proven best model of the agent type (from agent-stats). Now enabled by default in
  `buff chat` (`routeMessageAuto`) and the orchestrator's per-task `createAutoRoutedLLM()`.

### Changed
- `auto-router.ts` — pricing table + runtime adjustment pipeline (`loadRuntimeAdjustments`,
  `adjustCapabilitiesForRuntime`)
- `chat.ts` / `orchestrator.ts` — `useRuntimeStats: true` wired into production routing calls
- `Product_Guide.md` — feature inventory row 72 + Key Upgrades entry for Auto Model Routing
- `website/index.html` — 3 new feature cards (Auto Model Routing, Real Provider Pricing,
  Benchmark-Driven Learning); providers card mentions Auto

### Tests
- `tests/learning/auto-router.test.ts` — new pricing suite (7 tests) + runtime-stats suite
  (4 tests), trivial-task expectation updated for real pricing (Gemini free tier wins)

---

## [1.39.0] - 2026-07-31

### Added
- **Auto Model Routing (`AutoModelRouter`)** — "Use the right model for the right task."
  A first-class `auto` model selection option that routes every task to the optimal
  provider/model based on **complexity, cost, latency, privacy, and reliability**:
  - **5-dimension scoring engine** — per-provider capability profiles (reasoning, speed,
    cost, privacy, reliability) weighted by detected task complexity (trivial → cost+speed
    dominate; critical → reasoning+reliability dominate)
  - **Preference modes** — balanced, `performance-first`, `cost-first`, `privacy-first`
    (routes private tasks to the local provider)
  - **Circuit-breaker awareness** — providers in cooldown are deprioritized (excluded unless
    all are in cooldown); fallback chains keep the pipeline running
  - **`buff model switch auto`** — selectable as option 1 in the model picker or via CLI;
    `buff chat` routes every message, `buff execute "<goal>" -m auto` / `--auto-route` routes
    each agent task independently, explicit `--model` always wins
  - **Exports** — `AutoModelRouter`, `getAutoRouter`, `resetAutoRouter`, `isAutoModel`,
    `isAutoProvider`, `computeWeights`, `scoreProvider` from the package index
- **Tests (55)** — `tests/learning/auto-router.test.ts` (44 tests: weights, scoring,
  complexity routing, circuit-breaker, fallback chains, model resolution, singleton) +
  `tests/cli/model-picker.test.ts` updated for the Auto option index shift (12 tests)

### Changed
- `model-picker.ts` — "Auto — Agent decides" is now option 1; model choices shift to 2+
- `chat.ts` — per-message auto routing; `/model` and error-recovery picker selections of Auto
  re-enable auto mode (with inline re-resolution so the retried message uses the routed provider)
- `orchestrator.ts` — per-task `createAutoRoutedLLM()`; `--auto-route` now uses the new engine
  instead of the legacy static agent-model map
- `execute.ts` — new `--auto-route` flag
- `README.md` + `User_Manual.md` — Auto model routing feature bullets, examples, and usage guide

---

## [1.38.1] - 2026-07-31

### Added
- **Documentation: dependency installer** — README feature bullet and User_Manual §7.9
  "Automatic Dependency Installation" (manifest detection, tool-bootstrap table, retry,
  command-based fallback, `autoInstallTools:false` opt-out, telemetry)
- **Runner tool-install tests (20)** — `installTool()` bootstrap paths for npm (no-reinstall,
  Node bootstrap, failure propagation, not-on-PATH), yarn/pnpm, pip (ensurepip, Python-first,
  failure), brew, bundler (gem/Ruby-first/failure), cargo (rustup), go (darwin/winget), dart
  (brew/apt/winget), and unknown-tool error — with `process.platform` override/restore
- **Product_Guide §3.1 rows 70–71 + §7.9 Phase 11** — Cross-Platform Execution & Dependency
  Automation feature inventory and roadmap table
- **Website feature card** — "Auto Dependency Install" added to the features grid (9 cards)

---

## [1.38.0] - 2026-07-31

### Added
- **Cross-platform dependency installer (Runner)** — `RunnerAgent` now auto-installs missing
  project dependencies and bootstrap-installs missing package managers:
  - **11 manifest types detected** — `package.json`/`pnpm-lock.yaml`/`yarn.lock` (lockfiles win),
    `requirements.txt`, `pyproject.toml`, `setup.py`, `Gemfile`, `Cargo.toml`, `go.mod`,
    `composer.json`, `pubspec.yaml`
  - **Tool bootstrapping on all platforms** — npm via brew/apt/dnf/yum/NodeSource/winget/choco/MSI;
    pip via `ensurepip` + Python install; Homebrew via official `NONINTERACTIVE=1` script;
    bundler via gem + Ruby; cargo via rustup; go via brew/apt/winget; composer via getcomposer.org
    into user-writable `$HOME/.local/bin` (no sudo, quoted, `USERPROFILE` fallback); dart via
    Homebrew / Google apt repo / winget
  - **Command-based tool detection** — when no manifest exists, missing interpreters referenced by
    the failing command (`python3`, `node`, `go`, `cargo`, etc.) are installed automatically
  - **Telemetry** — `dependencyInstallTool` / `dependencyInstallToolInstalled` on `RunResult`,
    feeding the eval framework's dependency-install success metric
- **Dashboard: Deps Installed stat** — Agent Evaluation section now shows dependency-install
  success rate alongside tests / composite / recovery / rollbacks; stat grid switched to
  `auto-fit` so both the 4-card benchmark and 5-card eval sections lay out evenly
- **Runner tests** — composer install paths ($HOME/.local/bin, PHP bootstrap, PHP-failure
  short-circuit), interpreter→tool mapping, and failed-command auto-install flow

---

## [1.37.1] - 2026-10-05

### Fixed
- **Provider crash in `buff plan`** — Running `agent-nuvira plan` with an unconfigured default
  provider (e.g., OpenRouter with no API key) crashed with a raw 401 JSON error. Now:
  - Auto-fallback via `getProviderFallback.callWithFallback()` for retryable errors
  - Interactive model picker when provider is unavailable or auth fails
  - Helpful error messages with actionable steps (set API key, run `buff model switch`, use local)
  - Correct env var names per provider (e.g., `nim` → `NVIDIA_NIM_API_KEY`)
- **Provider crash in `buff skill compile`** — Added auto-fallback to `callLLM` in `compileSkills()`
  so skill compilation doesn't crash with raw provider errors
- **Provider crash in `buff learn patterns --extract`** — Added auto-fallback to `callLLM` in
  `showPatterns()` so pattern extraction handles provider failures gracefully

### Security
- `plan.ts` now detects auth errors (401/403) and shows environment variable configuration hints
  instead of exposing raw API error JSON to the user

---

## [1.37.0] - 2026-10-05

### Added
- **Branch Automation Hooks (Pillar A4)** — Automated branch workflow with 4 trigger sources:
  - **Issue → Branch** — Auto-creates `feat/PROJ-123-description` branches from issue keys with
    configurable branch type (feat/fix/chore) and sanitized naming
  - **PR Label → Update** — Auto-commits changes and pushes to PR branch when labels like `wip`
    or `needs-work` are detected
  - **File Watch → Commit** — Background file-watch script with configurable polling interval
    (default: 60s) that auto-commits with conventional commit messages on change detection
  - **CI Status → Fix** — Analyzes CI failures from git context (recent commits, changed files)
    with LLM-powered diagnosis and actionable fix suggestions
- **Git hooks installer** — Installable post-checkout and pre-commit hooks that detect issue-based
  branches and enforce conventional commit format; hooks are self-identifying (contain 'Agent-Nuvira'
  marker) for clean removal
- **Conventional commit generator** — Rule-based commit type detection from changed files
  (test→test, docs→docs, fix→fix, feat→feat) with LLM fallback for contextual messages
- **`--auto-branch` flag** — New CLI flag for `buff execute` enabling branch automation workflows
- **Module registry** — `branch-automation` agent type registered in ModuleRegistry

### Files
| File | Change |
|---|---|
| `src/agents/agents/branch-automation-agent.ts` | **NEW** — BranchAutomationAgent (400+ lines)
| `src/agents/agents/branch-automation-hooks.ts` | **NEW** — Git hooks manager (250 lines)
| `src/agents/module-registry.ts` | **MODIFIED** — Added agent registration
| `src/cli/execute.ts` | **MODIFIED** — Added `--auto-branch` flag + `ExecuteOptions.autoBranch`

---

## [1.36.0] - 2026-10-04

### Added
- **Real-Time Token Streaming in AgentPanel (Pillar B2)** — Live streaming output with
  typewriter effect in the agent progress panel:
  - **Streaming display** — Streaming container with blinking cursor, animated live dot,
    and monospace output area appears below phase indicators when tasks run
  - **Real-time chunk emission** — `CLIManager` now emits `onStreamChunk` callbacks for
    every stdout data event, enabling token-by-token display
  - **Code block detection** — Chunks containing ``` markers are styled with specialized
    token coloring (`.token-code`, `.token-keyword`, `.token-string`, `.token-comment`,
    `.token-error`, `.token-emphasis`)
  - **Auto-scroll** — Output area auto-scrolls to show latest tokens as they arrive
  - **Completed indicator** — After streaming ends, the header label changes from
    "streaming" to "completed" in green, and content stays visible until next task
  - **Clean lifecycle** — `startStreaming()` before each task, `completeStreaming()`
    after both success and error paths, `clearAll()` resets streaming state

### Changed
- `vscode-extension/src/cliManager.ts` — Added `onStreamChunk` callback, emits chunks
  with code block detection on every stdout data event
- `vscode-extension/src/agentPanel.ts` — Added streaming container HTML/CSS/JS,
  `startStreaming()`, `updateStreaming()`, `completeStreaming()` methods
- `vscode-extension/src/commands.ts` — Wired streaming lifecycle: CLI → panel → webview

---

## [1.35.1] - 2026-10-04

### Fixed
- **Missing runtime dependency** — Moved `typescript` from `devDependencies` to `dependencies`
  in `package.json`. The `ts-adapter.ts` and `transform.ts` modules import the TypeScript
  Compiler API at runtime (`import * as ts from 'typescript'`), but it was only listed as a
  devDependency. When installed globally via `npm install -g`, devDependencies are skipped,
  causing `ERR_MODULE_NOT_FOUND`. Now correctly installed as a regular dependency.

### Dependency Audit
- Cross-referenced all `src/` imports against `package.json` — only `typescript` was
  misclassified; all other packages (commander, ora, inquirer, chalk, @huggingface/transformers)
  were correctly categorized.

---

## [1.35.0] - 2026-10-04

### Added
- **Chat Panel v2 — DAG Pipeline Visualization (Pillar B6)** — Live multi-agent pipeline
  visualization inline in chat messages for slash commands:
  - **SVG DAG renderer** — Standalone `dagRenderer.ts` ported from React DAGView to vanilla JS;
    renders colored agent nodes with icons, status badges, edge curves, step details table, and legend
  - **16 agent types** — Planned, gatherers, writers, reviewers, testers, debuggers, security, git,
    packages, releases, triage, PR review, GitLab, skills, MCP with distinct icons/colors
  - **Real-time pipeline detection** — Parses CLI output for agent markers (📋 planner, ✏️ writer,
    👁️ reviewer, 🧪 tester, ✅/❌ complete/fail) and builds DAG state incrementally
  - **Live indicator** — Animated glow for running nodes, pulsing LIVE badge, status summary bar
  - **Fade-in animations** — Smooth entry for pipeline container and node updates
  - **Empty state** — Helpful placeholder when no pipeline is active, with command suggestions
- **Issue Triage Engine (Pillar A3)** — Automated issue classification, prioritization, and labeling
  across GitHub and GitLab:
  - **LLM-based classification** — Classifies issues as bug, feature, question, docs, or chore using
    a structured JSON prompt with configurable temperature (0.2) and explicit classification guidelines
  - **Priority assignment** — Assigns critical, high, medium, or low priority with emoji indicators
  - **Difficulty estimation** — Estimates issue complexity: easy, medium, or hard
  - **Label management** — Suggests and auto-applies labels (creates missing labels on GitHub repos)
  - **Triage comments** — Posts structured markdown table comments with classification, priority,
    difficulty, reasoning, and suggested action
  - **Git blame expertise heuristic** — Infers suggested assignee from git blame on files mentioned
    in the issue body (extracts file paths from backtick references)
  - **Multiple operations**: `triage-all` (all unlabeled), `triage-specific` (#N), `classify` (#N),
    `list-unlabeled`
  - **Auto-source detection** — Detects GitHub vs GitLab from keywords, tokens, or git remote;
    auto mode tries both platforms with clear error messages
  - **Robust LLM response parsing** — Supports valid JSON, markdown-wrapped code blocks, and
    malformed responses with validation fallbacks for all classification fields
- **Module registration** — `issue-triage` agent type registered in ModuleRegistry with metadata

### Files
| File | Change |
|---|---|
| `src/agents/agents/issue-triage-agent.ts` | **NEW** — IssueTriageAgent (550 lines)
| `src/agents/module-registry.ts` | **MODIFIED** — Added agent registration
| `tests/agents/issue-triage-agent.test.ts` | **NEW** — 46 unit tests

---

## [1.34.0] - 2026-10-03

### Added
- **Code Lens Actions (Pillar B5)** — Clickable `$(sparkle) AI: <name>` lenses above functions and classes
  in VS Code. Click opens a quick pick menu with 4 agent actions:
  - **Test** — Generate unit tests for the function/class
  - **Review** — Review for bugs, security, and style issues
  - **Explain** — Explain the code in detail
  - **Quick Fix** — Fix issues in the code
- **Language support** — TypeScript, JavaScript, Python, Go, Rust, Java — with regex-based declaration
  detection and brace-counting body range extraction
- **Quick pick UX** — Single lens per declaration, menu-based action selection with descriptions
- **Error handling** — Try/catch wrapper with user-facing notification on CLI failures

### Changed
- `vscode-extension/src/extension.ts` — Registered CodeLensProvider, single `lensCommandId` handler
- `vscode-extension/package.json` — No menu additions (all interactions via CodeLens click)

### Files
| File | Change |
|---|---|
| `vscode-extension/src/codeLensProvider.ts` | **NEW** — CodeLensProvider with quick pick menu (1,243 lines)

---

## [1.33.0] - 2026-10-02

### Added
- **VS Code Chat Panel (Pillar B1)** — Multi-turn AI chat panel directly in VS Code:
  - Streaming responses via `agent-nuvira chat --stream --no-color` CLI subprocess
  - 6 slash commands: `/fix`, `/review`, `/test`, `/explain`, `/workflow`, `/help`
  - File context: "Add File" button attaches active editor content as context
  - Code block rendering with "Apply to File" button
  - Conversation history sidebar with session management (new, switch, delete)
  - Sessions persisted across restarts via `workspaceState`
  - Slash command autocomplete with arrow key navigation
  - Welcome screen with quick command buttons
  - Keybinding: `Ctrl+Shift+A C` (mac: `Cmd+Shift+A C`)
- **Diagnostic → AI Fix (Pillar B3)** — "Fix with Agent-Nuvira" in VS Code lightbulb menu:
  - Detects diagnostics (red squiggles) and groups by line
  - Captures error message, affected code range, and 3-line surrounding context
  - Sends targeted fix prompt to CLI
  - Shows diff preview with Apply/Reject workflow
  - Falls back to showing raw output as new editor document
  - Retry on failure with error notification

### Changed
- `vscode-extension/src/extension.ts` — Registered ChatPanel, DiagnosticFixProvider, CodeLensProvider
- `vscode-extension/package.json` — Added `openChat` command, `Ctrl+Shift+A C` keybinding, chat activity bar view
- Status bar now opens Chat Panel instead of old Agent Panel

### Files
| File | Change |
|---|---|
| `vscode-extension/src/chatPanel.ts` | **NEW** — Chat webview panel controller (280 lines)
| `vscode-extension/src/chatPanel.html` | **NEW** — Chat webview HTML+CSS+JS template (520 lines)
| `vscode-extension/src/chatProvider.ts` | **NEW** — Chat history provider with workspaceState persistence (260 lines)
| `vscode-extension/src/diagnosticFixer.ts` | **NEW** — Diagnostic fix CodeActionProvider (280 lines)
| `vscode-extension/src/extension.ts` | **MODIFIED** — Registered all B1+B3 components
| `vscode-extension/package.json` | **MODIFIED** — Commands, keybindings, views

---

## [1.31.0] - 2026-09-30

### Added
- **TS Compiler API Wrapper (Phase 11)** — `src/editing/ts-adapter.ts` — Proper TypeScript Compiler API
  integration with `parseSourceFile()`, `findStructuralNodes()`, `findNodeByName()`, `findNodeAtPosition()`,
  `nodeToRange()`, `getBodyRange()`, `validateTSSyntax()` (uses `parseDiagnostics`), `replaceNodeText()`, and
  `insertAt()` — provides parser-level accuracy for all TS/JS editing operations
- **Structural Transformations (Phase 11)** — `src/editing/transform.ts` — Real code transformations:
  `renameSymbol()` (regex word-boundary replacement), `extractFunction()`, `inlineFunction()`,
  `addParameter()`, `changeSignature()`, and `detectTransformType()` NLP heuristic mapper
- **Two-Tier Editing Engine (Phase 11)** — `src/editing/edit.ts` rewritten with `tryFindNodeTS()` helper:
  all 7 operations (replaceFunctionBody, addMethodToClass, insertBefore, insertAfter, deleteNode,
  performEdit, buildStructuralContext) try the TS Compiler API first, fall back to regex — giving
  TS/JS files parser-level accuracy while supporting Python/Go/Rust via regex
- **Phase 11 Unit Tests** — 66 new tests across two suites:
  - `tests/editing/ts-adapter.test.ts` (40 tests) — parsing, node finding, body ranges, validation, text manipulation
  - `tests/editing/transform.test.ts` (26 tests) — all 5 transformation operations + NLP detection

### Changed
- `src/editing/edit.ts` — Replaced all `await import()` dynamic imports with clean static imports;
  replaced fragile regex-based structural analysis with TS Compiler API tier (for TS/JS) + regex fallback
  (for Python/Go/Rust)
- Marked unused imports cleanup (nodeToRange, replaceNodeText, insertAt) in transform.ts

### Tests
- 66 new Phase 11 tests — all passing ✅
- Total module tests: ts-adapter (40) + transform (26) = **66 Phase 11 tests**

---

## [1.30.0] - 2026-09-30

### Added
- **Unit tests: CredentialStore** — 357-line test suite covering constructor auto-detection, canPush/canPublish getters, collectAll() flow, setupGitCredentials() (GIT_ASKPASS, SSH agent), setupNpmAuth() (.npmrc injection), cleanup(), and module-level helper functions
- **Unit tests: PhaseExecutionEngine** — 560-line test suite covering createScope(), getNextPhase(), getProgress(), saveScope()/loadScope(), listSavedScopes()/deleteScope(), executePhase() (success/failure/exception/edge cases), executeScope() (sequential/resume/failure/credential collection)
- **Phase 10 documentation** — README roadmap table (10.1-10.4), version history (v1.29.0), Phase-Wise Feature Summary (4 new entries)
- **Product_Guide Phase 10** — Feature inventory items 66-69, section 7.8 with detailed phase table
- **Website stats update** — Architecture highlights: 10/10 Phases Complete, 10/10 Modules Extracted

### Changed
- Updated README, Product_Guide, and website to reflect Phase 10 (Autonomous Publish & Phase-Wise Execution) progress

### Tests
- 80 new tests: 357 lines credential-store, 560 lines phase-engine — all passing ✅

---

## [1.29.0] - 2026-09-30

### Added
- **CredentialStore** — Interactive Git/npm credential collection with GIT_ASKPASS setup, SSH key passphrase handling, .npmrc token injection, and auto-detection from env vars | `src/agents/credential-store.ts`
- **PhaseExecutionEngine** — Multi-goal project scope execution with save/resume across restarts | `src/agents/phase-engine.ts`
- **Publish command** — `buff publish` — 5-phase autonomous pipeline: test verification → version bump → git commit/tag/push → npm build/publish → GitHub release | `src/cli/publish.ts`
- **Phase command** — `buff phase create/execute/resume/status/list/delete` — phase-wise project execution | `src/cli/phase.ts`
- **GitAgent: git push + tag push** — `pushToRemote()`, `createAndPushTag()`, `pushTagToRemote()`, `autoPush()` with credential-aware error messages (auth failures, missing remote, network errors)
- **PackageAgent: fullPublish pipeline** — `fullPublish()` chains version bump → build → publish with auto npm auth detection from env vars or .npmrc

### Changed
- GitAgent now supports `git push`, `git tag -a`, and `git push --tags` operations — previously only local commit was supported, no remote push capability
- PackageAgent now auto-detects npm auth via `NPM_TOKEN` env var or `.npmrc` before publishing, with clear error messages for auth failures
- CLI router registered `PublishCommand` and `PhaseCommand` as new top-level commands
- All new modules exported from `src/index.ts` for SDK access

---

## [1.28.0] - 2026-09-29

### Added
- **Phase 9 documentation** — README, Product_Guide, and User_Manual updated with SafeExecutionLayer entries
- **README roadmap table** — Added Phase 9: Safe Execution Layer (9.1 SafeExecutionLayer, 9.2 VerifyModule EventBus tests)
- **README version history** — v1.26.0 (Phase 9 SafeExecutionLayer + 32 tests) and v1.27.0 (website/SVG updates)
- **README Phase-Wise Feature Summary** — SafeExecutionLayer (Phase 9) entry with 3-domain safety system description
- **Product_Guide feature inventory** — Item 65 for SafeExecutionLayer, new section 7.7 with detailed module table
- **User_Manual Phase 6 table** — SafeExecutionLayer (Phase 9) entry added with full description

### Changed
- Product_Guide.md migration summary updated from "8 modules" to "9 modules"
- All 3 docs now consistently reference Phase 9 / SafeExecutionLayer across all section types

---

## [1.27.0] - 2026-09-29

### Added
- **Website v1.26.0 updates** — Phase progress updated to "9/9" phases and modules extracted; test count to 2,207; architecture header from Phase 1→8 to Phase 1→9
- **Migration roadmap SVG** — Added Phase 9 (SafeExecutionLayer) timeline circle, card with 3 capabilities, Row 11 comparison entry, extended metrics/footer
- OG/twitter meta descriptions updated to 2,207+ tests

---

## [1.26.0] - 2026-09-29

### Added
- **SafeExecutionLayer (Phase 9)** — `DefaultSafeExecutionLayer` unifying three safety domains:
  - **File validation** — file size guard (default: 100KB), .gitignore compliance detection, AST syntax
    validation (TS/JS/Python/Go/Rust), security scan of file content via `runAllScans()`
  - **Sandboxed execution** — Docker container isolation via `SandboxManager`, resource limits
    (CPU/memory), timeout enforcement, automatic container lifecycle (create/copy/exec/destroy)
  - **Safe LLM calls** — prompt injection guardrail (blocks injection patterns before sending),
    configurable prompt length cap (default: 128K chars), exponential backoff retry (up to 3),
    circuit breaker for auth errors (401/403), response length cap
- **EventBus events (10 new)** — `SAFE_EXEC_FILE_VALIDATED`, `SAFE_EXEC_SANDBOX_STARTING`/`CREATED`/
  `COMPLETED`/`FAILED`, `SAFE_EXEC_LLM_STARTING`/`BLOCKED`/`RETRY`/`COMPLETED`/`FAILED`
- **VerifyModule EventBus tests** — 9 new tests verifying `VERIFY_STARTING`, `VERIFY_CHECK` (all 4
  check types), and `VERIFY_COMPLETED` emissions

### Changed
- Response truncation in `DefaultSafeExecutionLayer.safeLLMCall()` now uses the `maxPromptLength`
  parameter consistently for both prompt and response capping

### Tests
- SafeExecutionLayer: 23 tests — 11 validateFile (size, gitignore, syntax, security, edge cases,
  events), 10 safeLLMCall (injection, retry, auth skip, truncation, events), 2 executeInSandbox
  (Docker unavailable, events)
- VerifyModule EventBus: 9 tests — event emissions for all verification check types

---

## [1.25.0] - 2026-09-29

### Added
- **Website v1.24.0 updates** — Hero metrics updated to 2,184 tests; Architecture section upgraded from "Phase 1→6" to "Phase 1→8", highlights updated to "8/8" phases, "8/8" modules extracted, "2,184" tests
- **README.md** — Added Phase 6 (Architecture Migration) to roadmap table with 8 sub-phases (6.1–6.8); added Phase 6 section to phase-wise feature summary with 10 module entries
- **Product_Guide.md** — Added feature inventory items 57–64 for all architecture modules; added section 7.6 with detailed 8-module migration table
- **User_Manual.md** — Added Phase 6: Architecture Migration section with 10 module entries (RecoverModule through TestModule)

### Changed
- All documentation now consistently references v1.24.0 release and 2,184+ test count

---

## [1.24.0] - 2026-09-29

### Added
- **ExecuteModule tests** — 24 new unit tests for `DefaultExecuteModule`: execute() with callLLM (happy path,
  npm test validation, command inference), execute() without callLLM (fallback), inferCommand (backtick,
  `Run:` prefix, `run <file>`, npm patterns, file extension), EventBus emissions
  (`EXECUTE_STARTING`/`EXECUTE_COMPLETED`/`EXECUTE_FAILED`)
- **TestModule tests** — 27 new unit tests for `DefaultTestModule`: runTests() with callLLM (vitest,
  jest, generic output formats), runTests() without callLLM (fallback), parseTestOutput (vitest,
  jest, generic, malformed/no match), detectFramework, detectTestCommand, EventBus emissions
  (`TEST_STARTED`/`TEST_COMPLETED`/`TEST_FAILURE`)
- **Migration roadmap SVG** — Updated to Phase 1-8 with Phase 7 (Plan+EditModule) and Phase 8
  (Execute+TestModule) timeline nodes and detail cards in second row; 10-row comparison table;
  updated metrics (8/8 phases, 150+ tests, 8 modules extracted)

### Changed
- Phase 5 badge in migration-roadmap.svg corrected from "IN PROG" to "DONE"

### Tests
- Total module tests: PlanModule (41) + EditModule (34) + ExecuteModule (24) + TestModule (27) = **126 module tests**

---

## [1.23.0] - 2026-09-29

### Added
- **ExecuteModule (Phase 8)** — `DefaultExecuteModule` extracted from `RunnerAgent`: pluggable command
  execution with 5-strategy command inference (backtick, `Run:` prefix, `run <file>`, npm patterns, file
  extension), npm test validation against `package.json`, structured `ExecuteResult` output (stdout, stderr,
  exit code, duration), EventBus integration with `EXECUTE_STARTING`/`EXECUTE_COMPLETED`/`EXECUTE_FAILED` events
- **TestModule (Phase 8)** — `DefaultTestModule` extracted from `TesterAgent`: pluggable sandboxed test
  execution with temp directory creation, project file copying (excluding `node_modules`/`.git`/etc.),
  file change application, dependency installation (npm install), multi-framework test output parsing
  (vitest, jest, generic), `TEST_STARTED`/`TEST_COMPLETED`/`TEST_FAILURE` events

### Changed
- `website/index.html` — Architecture section: `6/6` → `7/8` Phases Complete, `8 Modules Designed` →
  `5/8 Modules Extracted`, test count `2,058` → `2,133`

---

## [1.22.0] - 2026-09-28

### Added
- **PlanModule (Phase 7)** — `DefaultPlanModule` extracted from `PlannerAgent`: pluggable goal decomposition
  with prompt building (goal + file tree + memory context), 3-LLM-response parsing strategies (direct JSON,
  code block, array extraction), step normalization (numeric IDs, null dependsOn, missing fields),
  fallback plan when no `callLLM` provided, and `PLAN_STARTED`/`PLAN_STEP_CREATED`/`PLAN_COMPLETED` events
- **EditModule (Phase 7)** — `DefaultEditModule` extracted from `WriterAgent`: pluggable file change
  generation with prompt building (artifacts + goal + MCP tools), `filepath:` code block parsing,
  AST syntax validation, token-budget-aware file selection (prioritizes smaller files, max 10 files,
  16K char budget), 2-attempt retry loop with rate-limit handling (skip/abort/switch-model/retry),
  mutable `currentCallLLM` for model-switch support, and `EDIT_GENERATING`/`EDIT_WRITTEN`/`EDIT_SKIPPED` events

### Tests
- **PlanModule: 41 new tests** — plan() with/without callLLM, parsePlan (direct JSON/code block/array extraction/
  malformed responses), normalizeSteps (numeric IDs, null dependsOn, missing fields, step filtering),
  EventBus emissions (3 event types, source verification)
- **EditModule: 34 new tests** — edit() happy path (multi-file, new file, unchanged file),
  empty results, LLM errors, rate-limit handling (skip/abort/switch-model), parseFileChanges
  (filepath prefix, spaces, empty blocks), addFileChange (modified/created/identical content),
  validateChanges (valid syntax, syntax warnings, non-source files), token budget, EventBus emissions

---

## [1.21.0] - 2026-09-27

### Added
- **VerifyModule (Phase 6)** — Explicit verification pipeline with `security`, `goal-alignment`, `tests`,
  and `code-quality` check types; low/medium/high strictness levels; pass/fail scoring with configurable
  pass thresholds (0.5/0.7/0.9)
- **LLM-based file classification** — `DefaultInspectModule.classifyWithLLM()` dispatches files to
  specialized agents (debugger, reviewer, tester, mcp-agent, security-agent) based on file content analysis
- **EventBus LoggerConsumer** — Handlers for `VERIFY_STARTING`, `VERIFY_CHECK`, `VERIFY_COMPLETED` events
- **Pipeline PR summary SVG** — 14-agent pipeline flow diagram for the website
- `ROADMAP_TODO.md`, `spec.md`, `spec_roadmap.md`, `spec_upgrade.md` — roadmap and spec documentation

### Changed
- `DefaultInspectModule.scanByKeywords()` — improved walkAndScore with additive keyword scoring,
  depth-5 limit, directory-name matching, symlink skipping
- `DefaultInspectModule.parseClassifyResponse()` — robust JSON extraction with markdown-wrapped,
  malformed, and empty response fallbacks
- **Architecture migration (Phase 6)** — 8-module architecture designed (InspectModule, ReportModule,
  VerifyModule, PlanModule, EditModule, ExecuteModule, TestModule, RecoverModule) with 3 extracted;
  remaining 5 modules scheduled for future phases
- `.gitignore` — added `.DS_Store` to prevent macOS metadata clutter

### Fixed
- **Followup first-letter truncation** — broken regex `\U` (treated as literal `U`, creating range `0-U`
  that stripped letters `A`–`U`) → fixed with `\u{XXXX}` + `u` flag for proper emoji stripping
- **Followup auto-continue** — removed duplicate "What next?" prompt after followup execution;
  followup result now falls through cleanly to the main goal loop
- Redundant `printOrchestrationResult` call in followup dispatch handler (already handled by `runSingleGoal`)

### Tests
- InspectModule tests expanded from **41 → 74 tests** (event spy emissions, walkAndScore scoring,
  parseClassifyResponse edge cases, inspect error handling, symlink/symlink-permission scenarios)
- VerifyModule: **28 new tests** (all 4 check types, strictness levels, dedup, scoring)

---

## [1.20.0] - 2026-09-20

### Added
- **InspectModule (Phase 5)** — codebase scanning wrapper around ContextGathererAgent with keyword
  scoring (+3 name match, +1 path match), depth limiting (5), `.buffignore` pattern support,
  binary/symlink skipping, and LLM-based file classification
- **ReportModule (Phase 4)** — Pluggable report formatters (markdown, JSON, summary, verbose) with
  EventBus integration and 4 structured event types
- **Architecture roadmap SVG** — Visual migration timeline (Phase 1→6) for the website
- **Website provider showcase SVG** — Visual logo grid of 17+ supported AI providers

### Changed
- `DefaultInspectModule` — scanByKeywords now respects `.buffignore` patterns, depth limit (5),
  and skips binary/symlink files
- `website/index.html` — added Architecture Migration section with roadmap SVG and metric highlights
- `website/styles.css` — architecture-visual section with glow hover effects, responsive grid

### Tests
- InspectModule: 41 tests covering inspect(), scanByKeywords(), walkAndScore(),
  parseClassifyResponse(), and keyword-based file discovery

---

## [1.19.0] - 2026-09-15

### Added
- **EventBus** — Structured observability system with 37 typed events and 4 built-in consumers
  (LoggerConsumer, MetricsConsumer, AuditConsumer, MetricsBufferConsumer)
- **Architecture documentation** — `ARCHITECTURE.md` with full 8-module design, extensibility hooks,
  plug-and-play agent lifecycle, and event-driven observability
- **Mermaid architecture diagrams** — `ARCHITECTURE_DIAGRAMS.md` with 5 visual diagrams:
  Module Architecture, Extensibility, Execution Flow, Event Bus Data Flow, Migration Timeline

### Changed
- `DefaultOrchestrator` — wired to EventBus; emits 14 pipeline lifecycle events
- A2A tests — increased timeout to accommodate real Orchestrator initialization
- Documentation expanded with cross-references between ARCHITECTURE.md and all strategic docs

---

## [1.18.0] - 2026-08-29

### Added
- `PRODUCT_STRATEGY.md` — comprehensive product strategy with product thesis, competitive landscape (pricing matrix, 22-dimension feature comparison, positioning map, target user match, competitive advantages), OKR framework (5 objectives, 19 key results), and risk register
- `PITCH_DECK.md` — 10-slide investor presentation outline with talking points, architecture diagrams, traction timeline, business model (3-tier + marketplace), quarterly OKR roadmap, and partnership/investment ask
- `CONTRIBUTING.md` — quick-reference contributor guide with documentation map (12 linked docs), development setup, testing commands, contribution workflow, and area-idea table
- Cross-references to strategic docs in `README.md` (Roadmap callout box) and `Product_Guide.md` (§9 Strategy & Pitch Deck + TOC entry)
- PITCH_DECK.md references to both `README.md` and `Product_Guide.md` alongside existing PRODUCT_STRATEGY.md links

### Changed
- `README.md` — added strategic docs callout box in Roadmap section, extended with PITCH_DECK.md reference
- `Product_Guide.md` — added §9 Strategy & Pitch Deck with docs table and competitive highlights, updated TOC
- `Product_Guide.md` — fixed TOC anchor link for §9 (`strategy-pitch-deck`)

---

## [1.17.0] - 2026-08-28

### Added
- `CHANGELOG.md` — comprehensive version history from v1.0.0 to v1.17.0 following Keep a Changelog format
- Comprehensive Phase-Wise Feature Summary in README, Product Guide, and User Manual
- Version History table in README (v1.0.0 through v1.17.0)
- Agent Catalog table — 13 agent roles with type, description, and version introduced
- Release Phases overview mapping version ranges to development phases

### Changed
- **Product_Guide.md** — updated to v1.16.1 → v1.17.0 alignment, Phase 4 & 5 roadmap completed, version history extended, test counts updated (1620→1830+)
- **User_Manual.md** — updated to v1.16.1 → v1.17.0 alignment, added Phase-Wise Feature Summary, updated key concepts and glossary
- **README.md** — Phase 4 marked complete (6 items), new Phase 5 added (5 items), Version History extended through v1.17.0
- Architecture diagram updated to show all 14 agent roles
- Multi-agent pipeline section enhanced with table format and interactive dev mode documentation

### Fixed
- Product_Guide.md footer version (v1.14.6 → v1.17.0)
- Agent count consistency across all docs (10+ → 15 agent roles & management)

---

## [1.16.1] - 2026-08-27

### Added
- Interactive dev mode enhancements — failure analysis with per-agent-type recovery actions
- Follow-up suggestions — LLM-powered contextual next-step recommendations after goal execution
- `/fix` command — retry last failed goal with failure context, shows post-execution analysis
- 35 new unit tests for failure analysis, follow-up suggestions, and handlePostExecution methods
- Enhanced post-execution UX with dynamic choices (continue, switch model, history, exit, retry-fix, followup)

### Changed
- `/fix` command now shows post-execution actions (consistent with `retry-fix` behavior)
- Session history tracking via shared `handlePostExecution` method
- Comprehensive README update with Phase-Wise Feature Summary, Version History, and Agent Catalog

### Fixed
- ESM module mocking in tests — replaced `vi.spyOn` with `getProviderConfig` throw strategy
- Input validation test — fixed test data that was exceeding the 3-suggestion limit in fallback logic

---

## [1.16.0] - 2026-08-26

### Added
- Comprehensive MCP README documentation with stdio and SSE transport examples
- SSE header support for MCP — Bearer auth and custom headers for remote MCP connections

### Changed
- Firecrawl integration for web search via MCP

---

## [1.15.6] - 2026-08-25

### Added
- Firecrawl integration for web search and scraping

---

## [1.15.5] - 2026-08-24

### Added
- SSE (Server-Sent Events) header support for MCP transport
- Bearer token authentication for remote MCP servers

---

## [1.15.4] - 2026-08-23

### Added
- Search/filter bar for model discovery
- Column count toggle (3/4/5 columns) for model display
- Speech provider section in model picker

---

## [1.15.3] - 2026-08-22

### Fixed
- Accessibility fix — replaced `window.open` with native `<a>` tags in SpeechProviderSection

---

## [1.15.2] - 2026-08-21

### Fixed
- Windows compatibility fixes for runner and sandbox agents

---

## [1.15.1] - 2026-08-20

### Added
- Interactive development mode — `buff execute` without a goal launches a guided loop
- Model picker — interactive provider/model selection at dev mode start
- Session tracking — full goal history within a development session
- `/save <name>` — save development session state to disk
- `/resume <name>` — restore a previously saved session with full history
- `/suggest` — search past trajectories for similar goals

---

## [1.15.0] - 2026-08-19

### Added
- npm publishing — `npx agent-nuvira` / `npx buff` live on npm (1.3 MB package)
- Zero-setup onboarding for new users

---

## [1.14.6] - 2026-07-28

### Added
- Skill Compiler — auto-extracts reusable patterns from successful trajectories into parameterized skill scripts
- Context-Window Memory Pruner — 5 strategies (metadata strip, file collapse, conversation truncation, artifact summarize, aggressive fallback)
- Context-Preserving Model Switching — `buff model switch` changes providers mid-session without losing agent state
- Docker Compose Setup — 5-minute onboarding with multi-stage Dockerfile, health checks, persistent volume
- Project Scaffolding — `buff init` with 5 built-in templates and interactive provider selection wizard

### Technical
- Skill Store with decay scoring, garbage collection, and keyword search
- Token estimation heuristic with 1-token-per-4.5-char ratio
- 156 new tests (84 skill system + 72 context pruner), 1479 total

---

## [1.14.5] - 2026-07-22

### Fixed
- `/exit` command now actually terminates the process (no lingering "You:" prompt)
- Ctrl+C double-press logic moved from process-level to readline handler (first press shows warning, second press exits)
- Process-level SIGINT simplified to immediate exit (appropriate for API-call interruptions)

---

## [1.14.4] - 2026-07-20

### Added
- Rate-limit header parsing across all cloud providers (7+ header naming conventions)
- Green/Amber status based on real quota data (>20% = Green, ≤20% = Amber)
- New "Quota" column in dashboard models table

### Fixed
- OpenRouter models now correctly reflect rate-limit status

---

## [1.14.3] - 2026-07-18

### Added
- Interactive error recovery on API failures (retry, switch provider, cancel, exit)
- Seamless provider switching preserves all conversation history

### Fixed
- Ctrl+C single press now shows warning, second press exits

---

## [1.14.2] - 2026-07-16

### Added
- Web dashboard `/api/models` endpoint with provider health data
- Color-coded model table (Green = working, Amber = limited, Red = unavailable)
- Provider card headers with overall status
- Quota remaining indicator

---

## [1.14.1] - 2026-07-14

### Fixed
- Rename "Agent-Baba-D" to "Agent-Nuvira" in dashboard
- Windows `spawn start ENOENT` error on dashboard launch
- Cross-platform browser opening logic

---

## [1.14.0] - 2026-07-12

### Added
- Full Windows CI test suite (GitHub Actions)
- Multi-line input in interactive chat

### Fixed
- Cross-platform echo commands in runner tests

### Changed
- Published to npm as `agent-nuvira`

---

## [1.13.0] - 2026-07-10

### Added
- Hybrid model routing — complexity-based model selection with cost optimization
- Team collaboration — Git-synced shared config, memory, and review pipelines
- Agent SDK — `@agent-nuvira/sdk` npm package with scaffolding CLI
- Provider fallback routing — auto-failover with circuit breaker and configurable chain
- Security scan CLI — `buff security scan` for PII, injection, and dangerous code detection
- Feedback & rating system — `buff feedback record/list/stats/clear`
- Marketplace unified CLI — `buff marketplace browse/search/install/info`

---

## [1.12.0] - 2026-07-08

### Added
- VS Code extension — 9 commands, inline suggestions, diff viewer, agent progress panel
- Remote agent federation — multi-machine collaboration via TCP protocol
- Web UI dashboard — React dashboard with DAG, health, cost, history, benchmarks
- Shared model picker, spinner UX, model-picker tests

---

## [1.11.0] - 2026-07-06

### Added
- Skill compiler — auto-extracts reusable patterns from trajectories into runnable skills
- Context-window memory pruner — token-aware compression for long agent chains
- Context-preserving model switching — `buff model switch`
- Speech model labeling in model picker

---

## [1.10.0] - 2026-07-04

### Added
- Docker sandbox isolation — resource-limited, network-isolated containers, 8 base images
- Provider health dashboard — `buff doctor` with color-coded status and watch mode
- Human-readable model names in picker
- Categorized model selection (chat, code, vision)

---

## [1.9.0] - 2026-07-02

### Added
- Workflow template marketplace — 10 built-in templates + GitHub registry with install/publish
- Model benchmarking — 21 standardized coding tasks with scoring and A/B comparison
- Model categorization + smart picker

---

## [1.8.0] - 2026-06-30

### Added
- Native embedding support — 3-tier embedder (Xenova/Python/LLM) with LRU cache
- Vector store — cosine similarity search over embedded trajectories
- Trajectory store — few-shot example storage with quality scoring
- Memory integration — context retrieval + storage orchestration

---

## [1.7.1] - 2026-06-29

### Changed
- Rate-limit UX improvements with smart retry logic
- Better error messages for rate-limit errors

---

## [1.7.0] - 2026-06-28

### Added
- Groq LPU integration for fastest open-source model inference
- Streaming support — token-by-token output (Groq, NIM, OpenRouter)
- Plugin system — programmatic API + auto-discovery from `~/.buff/plugins/`
- Cost tracking — per-provider, per-session, monthly cost dashboards

---

## [1.6.0] - 2026-06-25

### Added
- Agent retry logic with exponential backoff (3 attempts)
- Format validation — auto-retry on malformed agent output
- Git integration — branch creation, commit with LLM-generated messages
- PR description generation from git diff

---

## [1.5.1] - 2026-06-20

### Fixed
- Windows CI pipeline fixes

---

## [1.5.0] - 2026-06-18

### Added
- TesterAgent — sandboxed test execution in isolated temp directory
- RunnerAgent — shell command execution with output capture
- DebuggerAgent — iterative test-fix loop using LLM (up to 3 iterations)
- SecurityAgent — prompt injection + secret/PII scanning

---

## [1.4.1] - 2026-06-15

### Fixed
- Bug fixes, Windows compatibility improvements

---

## [1.4.0] - 2026-06-12

### Added
- Multi-agent pipeline (`buff execute` command)
- PlannerAgent — goal decomposition and task planning
- WriterAgent — code implementation with retry logic
- ContextGathererAgent — codebase scanning and file discovery
- ReviewerAgent — code review, bug detection, style checks

---

## [1.3.0] - 2026-06-10

### Added
- Implementation plans (`buff plan` command)
- Codebase-aware plan generation with architecture impact analysis
- Structured plan output (summary, files, architecture, steps, risks, testing)

---

## [1.2.0] - 2026-06-08

### Added
- AI-assisted file editing (`buff edit` command)
- Dry-run mode for safe previews
- File context support

---

## [1.1.0] - 2026-06-05

### Added
- Model discovery — `buff models` with search/filter across all providers
- Provider-specific model listing (Groq, NIM, Gemini, OpenRouter)

---

## [1.0.0] - 2026-06-01

### Added
- Initial release
- Core CLI with 25+ commands via Commander.js
- 5 built-in inference providers (expandable to 17+ via env vars + plugin system): Groq, NVIDIA NIM, Google Gemini, OpenRouter, Local (Ollama/HuggingFace/GGML)
- Interactive chat with conversation history and `/` commands
- Configuration system — JSON config file + env vars + CLI flags priority chain
- SQLite-backed response caching with configurable TTL
- Plugin system foundation
- MIT License

---

## Agent Catalog

### Agent Roles (16)

| Agent | Type | Description | Version |
|-------|------|-------------|---------|
| **PlannerAgent** | Core | Goal decomposition, dependency-aware task planning | v1.4.0 |
| **ContextGathererAgent** | Core | Codebase scanning, file discovery, artifact identification | v1.4.0 |
| **WriterAgent** | Core | Code implementation with retry + format validation | v1.4.0 |
| **ReviewerAgent** | Core | Code review, bug detection, security + style checks | v1.4.0 |
| **RunnerAgent** | Execution | Shell command execution with output capture | v1.5.0 |
| **TesterAgent** | Testing | Sandboxed test execution (temp dir / Docker) | v1.5.0 |
| **DebuggerAgent** | Testing | Iterative test-fix loop via LLM (3 iterations) | v1.5.0 |
| **SecurityAgent** | Safety | Prompt injection, secret/PII, dangerous code scanning | v1.5.0 |
| **GitAgent** | Publishing | Branch creation, LLM commit messages, PR descriptions | v1.6.0 |
| **PackageAgent** | Publishing | Version bump, npm build, publish, changelog generation | v1.6.0 |
| **GitHubReleaseAgent** | Publishing | Tag creation, release notes, GitHub releases | v1.6.0 |
| **SkillRunnerAgent** | Learning | Execute compiled skill scripts as pre-built task plans | v1.11.0 |
| **MCPAgent** | Integration | Invoke MCP tools from connected servers (stdio/SSE) | v1.16.0 |
| **GitLabAgent** | Integration | GitLab MR management, issues, pipelines | v1.32.0 |
| **PRReviewAgent** | Review | GitHub PR review with inline comments + security scans | v1.32.0 |
| **IssueTriageAgent** | Management | Issue classification, prioritization, auto-labeling | v1.32.0 |

### Release Phases

| Phase | Versions | Description |
|-------|----------|-------------|
| **Phase 0: Foundation** | v1.0.0 – v1.3.0 | Core CLI, chat, edit, plan, 5 built-in providers (expandable to 17+) |
| **Phase 1: Quick Wins** | v1.4.0 – v1.7.0 | Multi-agent pipeline, plugins, streaming, cost tracking |
| **Phase 2: Structural Changes** | v1.8.0 – v1.10.0 | Memory system, workflows, benchmarks, Docker sandbox |
| **Phase 3: Major Upgrades** | v1.11.0 – v1.14.6 | Skills, pruner, VS Code, federation, dashboard, SDK |
| **Phase 4: Industry Standards** | v1.15.0 – v1.16.0 | MCP, A2A, CI/CD, npm publishing, error-repair |
| **Phase 5: Interactive UX** | v1.16.1 | Interactive dev mode, failure analysis, follow-up suggestions, /fix |
