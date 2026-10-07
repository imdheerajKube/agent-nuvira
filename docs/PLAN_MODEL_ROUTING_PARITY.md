# PLAN — Model routing & harness parity

**Status: OPEN program. Landing in bundles. Nothing in this file is closed unless its row says LANDED + the gate ran.**

This file exists because a live, measured investigation of agent-nuvira found defects that no
existing tracker owned. Every item below has **reproducible evidence from disk or a real run** — no
item is speculative, and no item is closed on "it looks right now".

## How this programme was measured

| Run | Directory | Mode | Result |
|---|---|---|---|
| A | `/tmp/test` | Max, auto | delivered, **11m54s / 82 steps / 1,192,115 input tokens** |
| B | `/tmp/test2` | Max, auto | delivered, **8m30s / 51 steps / 419,045 input tokens** |
| C | `/tmp/test3` | Max, auto, + fixes | delivered, **5m53s / 54 steps** |
| D | `/tmp/test4` | Max, **strict pin** `openrouter/deepseek-v4.1-flash` | **failed in 6s** — `402 Insufficient credits` |

The single most important measurement: **runs A, B and C were all served by
`deepseek/deepseek-flash`** — the same model this investigation ran on. **Same model, materially
worse outcome. The model is therefore not the variable; the harness is.** Every fix in this file is
a harness fix, and none of them may be "solved" by changing the model.

## Corrections to the investigation itself (read this first)

Two findings in the original report were **wrong**, and both are recorded here because the same
mistakes are the ones the product makes:

- **C-1 — the OpenRouter detour was the investigator's error.** The pin
  `-p openrouter -m deepseek/deepseek-v4.1-flash` was chosen because that id appears in the registry
  **under `openrouter`**. It is the wrong provider for that model. *The system defect is not the pin
  — it is that the pin was accepted for a `never-verified` pair and answered with a 402 (A2/A3).*
- **C-2 — "flash ⇒ weak" is a name-based judgement, and the report made it.** The original P3 said a
  "flash-tier model" was the wrong pick for a complex build. It judged capability **from the model's
  name** — the exact defect it was reporting (B1). DeepSeek V4.1 Flash is a strong model; the
  product must measure capability, not read it off an id.

## Severity

- **S1** — silently wrong outcome or unauditable behaviour. Fix before release.
- **S2** — wrong choice/cost, visible but not lying.
- **S3** — polish/consistency.

---

## Cluster A — Model identity & routability (S1, blocking)

Nothing else can be trusted until a model can be *named* and its *reachability* is consulted.

| # | Sev | Issue | Evidence | Fix | Acceptance |
|---|---|---|---|---|---|
| A1 | S1 | **The same model exists as unrelated registry rows.** `deepseek/deepseek-v4.1-flash` (openrouter, `unverified`) and `deepseek/deepseek-flash` (deepseek, `verified`) share no identity. | Registry dump, this session | A model-identity layer above the pair; per-provider reachability beneath it | Given the two rows, the system can answer "these are the same model" and pick the routable one |
| A2 | S1 | **A pin is not pre-flighted for routability.** A `never-verified`/`proven-dead` pair is attempted, and the failure surfaces as a provider error. | Run D: 402 after the pin was accepted | Consult the reachability verdict before the first call; refuse with the reason | **MET for a `proven-dead` pair** (Bundle 1c): the strict pin logs 0 × 402 and refuses before any request. A `never-verified` pair is still attempted on purpose — "nothing tried yet" is not a failure. |
| A3 | S1 | **`routable` is a dashboard view, not a gate.** `model-reachability.ts` mirrors `isUsable()` but routing/pins never ask it. | Module header states this | Make it the ONE consulted gate for auto *and* pinned runs | A unit test proves a `never-verified` pair cannot reach a provider call |
| A4 | S1 | **Definitive provider failures are never written back.** OpenRouter's dead credits are recorded nowhere, so reachability cannot learn. | Registry: no 402/credit error on any openrouter row | Classify 402/`insufficient credits` as a provider **entitlement** state (definitive, not a cooldown) and persist it | After one 402, the provider's pair reads non-routable and stops being ranked/offered |
| A5 | S1 | **Identity is reported per component, not per pair.** One turn reported 3 different models. | Run A: explain `gemini-3.1-flash-lite` / trace summary `groq` / debug header `deepseek-flash` | **LANDED** — the debug header was fixed by F2, the trace summary names the served PAIR (Bundle 2d), and the pipeline's housekeeping steps are now NAMED and no longer double-recorded (Bundle 2f) | A run's reported model is byte-identical across all three surfaces |
| A6 | S1 | **The auto chat path records no routing decision at all.** | Runs A/B/C: **0 rows** in `routing-history.json`; reproduced live with `-t` (Bundle 1c) | **LANDED** — the CLI was not auto-routing at all (F1). `execute` now honours `defaultProvider: "auto"`, so the turn goes through `routeMessageAuto` | A completed auto turn appends rows naming the served pair (2–3 genuine decision points per headless turn; 0 before) |

## Cluster B — Capability understanding (S1, root cause)

| # | Sev | Issue | Evidence | Fix | Acceptance |
|---|---|---|---|---|---|
| B1 | S1 | **Capability is inferred from id substrings** (`flash`/`lite`/`mini` penalised; `pro`/`70b` boosted). | `auto-router.ts` `getModelCapabilities()` | Measure capability; keep the name as a weak hint at most | A model whose id contains `flash` is not penalised for it |
| B2 | S1 | **Static provider baselines outrank real evidence** (`openrouter: 0.95`, `gemini: 0.85`, `local: 0.30`). | Baseline table | Derive from measured per-pair outcomes; decay the statics | Ranking changes when measurements change; two providers with equal measurements rank equally |
| B3 | S1 | **No measured quality exists anywhere.** The registry tracks latency, tokens, error rate — never capability. | `ModelRegistryEntry`; and re-measured: the bandit ALREADY defines a quality reward (`BanditOutcomeData`) that the real path passes as `undefined` | **DESIGN WRITTEN — see `docs/DESIGN_CAPABILITY_BY_MEASUREMENT.md`; awaiting the option choice.** The scaffold exists (`BanditOutcomeData`, per-model arms, the TurnReport verdicts); the fix is wiring it, not inventing a scale. | A pair that consistently fails is demoted by measurement, not by name |
| B4 | S1 | **Max mode's reasoning floor is name-driven**, so it excludes real models and admits others arbitrarily. | `MAX_CAPABILITY_MIN_REASONING = 0.7` vs `flash`+`lite` = 0.65 | Floor on measured capability | Documented: which models pass/are excluded, and why, from measurements |
| B5 | S2 | **Complexity is under-rated**: a 4-component full-stack app classifies as `moderate`. | `model explain` baseline | Recalibrate; require an agentic floor for build asks at every complexity | That prompt classifies ≥ `complex` |

## Cluster C — Context & execution discipline (S1/S2 — where the 2.85× gap lives)

| # | Sev | Issue | Evidence | Fix | Acceptance |
|---|---|---|---|---|---|
| C1 | S1 | **Context grows unbounded.** 128,482 chars / **1,192,115 input tokens** in one turn. | Run A trace | **RE-MEASURED — see the note below; the reading is wrong in the same way D5's was.** Deterministic compaction and a work digest already exist; neither ever FIRED in run A. The open item is the budget *policy*, not a missing mechanism. | A run of the same task stays within a stated input-token budget (measured baseline: a 82-step run peaked at 31,189 input tokens per step) |
| C2 | S1 | **Definitive failures are retried.** 3 Planner attempts against a 402. | Run D log | **LANDED** (see below) | A 402 consumes zero repair attempts |
| C3 | S2 | **Redundant rediscovery.** Version probes 3–4×; two `venv`s created (`/tmp/test/.venv` *and* `/tmp/test/backend/.venv`). | Run A log + filesystem | Reuse probe results; verify the write landed before redoing it | One probe per fact per run |
| C4 | S2 | **Plan durability across continuations.** 4 continuations; the plan is re-derived rather than carried. | Run A | Continuations resume the plan | Continuation N re-reads the plan rather than re-planning |
| C5 | S2 | **No context fit on model handoff** — the whole thread is handed over, which would overflow a smaller model. | `tool-loop.ts` handoff | Fit-to-window by dropping the oldest turns; never rewrite | Handoff to a small-window model never overflows |
| C6 | S3 | **Cost is not attributed per step in the user-facing output.** Total token burn is invisible until the trace is read. | Run A/B comparison | Surface per-turn cost | A turn reports its own token spend |

### Re-measurement — C1 (the "unbounded context" reading) 

Measured from the recorded trace `trace-1791300903944-upblb7`, per-step `inputTokens` for all 82 steps:
**2,587 → 31,189, monotone**, sum **1,192,115**, output sum **2,462** (input:output ≈ **484:1**). Three
corrections follow, and they change what the fix is:

1. **The 1,192,115 figure is a SUM over 82 steps, not one prompt.** Every step resends the thread, so
   the average step carried ~14.5K input tokens. Reading the total as "one context" is what made the
   growth look unbounded.
2. **Compaction exists and is deterministic — it simply never fired.** `trimThreadBudget`
   (`DEFAULT_THREAD_BUDGET_CHARS = 200_000` ≈ 44K tokens) collapses the OLDEST tool results to a
   500-char stub, then to a bare stub, and never touches the system prompt, the first user message or
   the last 6 messages; `buildWorkDigest` keeps the facts that matter (files changed, commands with
   their verdicts) in a single digest refreshed in place. In run A the thread peaked at **31,189
   tokens ≈ 140K chars — ~70% of the budget**, so the trim was never reached.
3. **The thread persists across continuations, which is why the curve is monotone.** One tool-loop
   turn may run `maxSteps + 4 × continuationSteps` ≈ **80** steps (82 observed) and it is ONE thread
   growing — so the shape to bound is a single long thread, not a summarisation failure.

The real open question is therefore the budget **policy**, not a missing mechanism:
`resolveThreadBudgetChars` is wired into both loops (`chat.ts`, `loop-executor.ts`) and is
model-window-aware, but `THREAD_BUDGET_FLOOR_CHARS = 200_000` means it can only ever RAISE a budget,
so a run may grow to ~44K input tokens before the first trim fires — and that trim is oldest-first
truncation, not plan-preserving compaction. Whether to lower the floor, compact proactively, or
compact against the PLAN is a product decision (see "Next bundles").

## Cluster D — Truthfulness of what the system says (S1)

| # | Sev | Issue | Evidence | Fix | Acceptance |
|---|---|---|---|---|---|
| D1 | S1 | **Stale final answer at budget exhaustion.** Run A claimed FAISS "never executed" after its own trace verified it (seq 68) and after it corrected the claim (seq 80–82). | Run A trace `trace-1791300903944-upblb7` (delivered 4,024 chars, seq 65) | **LANDED** (Bundle 2c): `lastContent` is replaced by a later answer when real work SUCCEEDED since the stored one — not only when the new text is longer | The delivered answer is the run's own last word after real work |
| D2 | S1 | **A useless response is recorded `success: true`.** `local/deepseek-coder:latest` returned a generic non-answer; the step logged success. | Run A seq 14 | **PARTIAL** (Bundle 2d): the DETOUR is now recorded; an empty response is already a failure (G10). The *generic non-answer* half is not detectable without a measured-quality signal (B3) | A mid-turn model detour is visible in the trace as a detour |
| D3 | S1 | **The trace summary `provider` is wrong** (`groq` while all 81 steps say `deepseek`). | Runs A & B | **LANDED** (Bundle 2d): the summary derives the provider×model PAIR that served the most steps — the provider half was landed earlier but the model was left as requested, so the printed pair could never have run | Summary == the pair that served the most steps |
| D4 | S2 | **`model explain` does not predict the runtime.** | `gemini-3.1-flash-lite` vs `deepseek-flash`; and, measured in code, the explain path passed **neither** option `chat.ts` layers on the shared assembly (`circuitBreakerStatus`, the NLU `taskIntentHint`) | **LANDED** (Bundle 2g): `explain` resolves through the same option assembly the runtime does — one `resolveExplainDecision` that reads the shared circuit breaker and the same NLU intent seed. Bundle 1c had already made the runtime *call the auto router at all*; this closes the option divergence that remained. | explain's winner == the model a real turn uses, for the same input text — including when a provider is cooling down and when the NLU intent overrides the text classification |
| D5 | S3 | **`model explain`'s ranks are not sorted by its own scores.** | `0.351, 0.465, 0.397, 0.396` | **CAUSE FOUND — not the original reading.** `ranked` IS sorted (and a test asserts descending score). The sort key is *availability first*: cooldown rows sink, then quota-parked, then score — so a cooling-down provider with a HIGHER raw score renders BELOW a healthy lower-scored one, under a header that says "Ranked providers" with only `score` beside each row. Run A had cooldowns from its own failed calls, which is exactly that shape. | **LANDED** (Bundle 2e): the header names the availability-first key, and a quota-parked row is labelled (it had no note at all) | The displayed order is explained by the header; the ranking itself was already correct |
| D6 | S2 | **The fallback chain offers non-routable pairs.** `groq/allam-2-7b` (verified but `lastError=rate-limit`) and `~`-prefixed OpenRouter alias ids (all `unverified`) appear as fallbacks. | `model explain` output + registry | **LANDED** — the offered chain now obeys the same gate the pick does: a proven-dead (`unavailable`) pair is dropped, an unproven one is labelled. | No offered pair is `unavailable`; every offered pair with no proof says so |

## Cluster E — Autonomy & decisions (S2)

| # | Sev | Issue | Evidence | Fix | Acceptance |
|---|---|---|---|---|---|
| E1 | S2 | **An unattended `ask_user` silently picks option 1** on a real architectural fork and never discloses it. | Run A ×3, Run B ×2 (FAISS vs Milvus); measured: the pick was filed as a SHOWN ask WITH an answer, byte-identical to a real reply | **LANDED** (Bundle 5a): an unattended pick is now an ASSUMPTION — recorded separately from an answer, emitted as `autonomy:assumed-default`, disclosed in the turn report, and never handed back as "the answer you have" | The run's report lists each decision taken on the user's behalf, and no surface can read it as the user's answer |
| E2 | S2 | **A pinned chat ask is re-routed into the multi-agent pipeline** by NLU (85% "create"). | Run D | **LANDED** (Bundle 5b): the no-model pipeline fallback still fires (it is a legitimate fallback), but it now SAYS the execution model changed and that the pin is the pair carried over, on both CLI paths. | A pinned chat ask runs the pinned path, or says why it did not |
| E3 | S2 | **Provider inventory disagrees.** `model list` omits `deepseek` and reports NIM as missing a key, while the router ranks both. | Baseline | **LANDED** — the cause was a hand-written array: `const builtinTypes = ['local','groq','nim','gemini','openrouter']`, while the router derives its set from the catalog + configured ids. Both now read the same source. | `model list` and the router agree on which providers exist and their availability |

---

## Cross-reference: the original gap list (nothing dropped)

| Original | Canonical | Original | Canonical |
|---|---|---|---|
| P1 model identity unauditable | **A5 + A6** | P8 silent unattended decisions | **E1** |
| P2 explain ≠ runtime | **D4** | P9 definitive failures retried | **C2** |
| P3 Max floor admits flash-tier | **B1 + B4** (reframed; see C-2) | P10 provider inventory disagrees | **E3** |
| P4 complexity under-rated | **B5** | P11 RC6 junk in fallback chain | **D6** |
| P5 bad model's garbage = success | **D2** | P12 explain ranks unsorted | **D5** |
| P6 unbounded context growth | **C1** | P13 pin rerouted into pipeline | **E2** |
| P7 stale answer at budget end | **D1** | | |

## Bundle 5a/5b — disclosed engine changes and assumptions (E1 + E2 LANDED)

**E1 — an unattended auto-pick was recorded as the user's own answer.** `ask_user` renders a
question; with no TTY (a piped run, CI, a headless turn) `renderAskUser` falls back to choice 1 so the
agent can proceed. The tool then did `runTrace.recordAsk(question, true, picked)` — a **shown ask WITH
an answer**, byte-identical to a real reply — and returned `User answered: <choice>`. So a decision
nobody made was indistinguishable from one they made, on every surface derived from it, and the only
disclosure was a `custom` note ASKING the model to mention it (which the measured runs did not).

**The fix — an assumption is its own kind of fact.**

| Change | Why it is the real cause |
|---|---|
| `AskUserAnswer.unattended?: boolean`; `renderAskUser`'s no-TTY branch sets it (the injected dashboard/gateway renderers can too). | The information existed at the one place that knew it and was thrown away immediately. |
| The tool files an unattended answer with **`runTrace.recordAssumption()`**, not `recordAsk`, emits **`autonomy:assumed-default`**, and words the result "…was ASSUMED — it is NOT their answer…". | The record is what every downstream surface reads; making it a different record is what makes "the user decided" and "the harness decided" separable at all. |
| `RunTrace` gains `assumptions` + `assumptionLines()`; an assumption is NEVER counted as a shown ask and `priorAnswer()` never returns it. | Otherwise the loop's repeat-nudge would hand it back as "the answer you have" — the exact mechanism that turned a default into a decision. |
| `TurnReport.assumptions` + a `🤝 decided for you` block in `formatTurnReport`, and the summary is non-null whenever one exists. | The report is rendered only when it has a summary, so an assumption on an otherwise-quiet turn would have stayed invisible — the silence the defect was about. |

**E2 — a pinned ask silently changed its execution model.** When the chat tool loop generated nothing,
`answerOnce` re-dispatched the ask into the multi-agent pipeline (a legitimate fallback) without
saying so, so a pinned turn could be reported against a run that was no longer the engine the user
chose. Both CLI paths now disclose it, naming the pin that is carried over:
`⤵️ the chat turn produced no answer on <provider> / <model> — running this ask in the multi-agent
pipeline instead (a different execution model, on the same pinned pair)`. The fallback itself is
unchanged — the defect was the silence, not the fallback.

**Measured after.** `tests/learning/run-trace.test.ts` (+2), `tests/learning/turn-report.test.ts`
(+3), `tests/tools/registry.test.ts` (+2), `tests/tools/ask-user-non-interactive.test.ts` (+3
assertions), `tests/cli/chat-answer-once-auto-parity.test.ts` (+1). `tests/tools` + `tests/learning`
**155 files / 2,844 tests**; `tests/cli` **62 files / 769 tests**.

**Honest residual.** The pipeline fallback on the CLI's `prompt` branch discloses via `logger.info`
(the branch is console-driven) while `answerOnce` uses `onProgress`; a caller that renders neither
still would not see it. And nothing yet REPLACES the model's own wording — the report is printed
beside the answer, so a model that claims "you chose X" is contradicted by the report rather than
prevented. Both are deliberate: the fix makes the fact recorded and visible, which is the part the
harness can guarantee.

## Bundle 2g — `explain` resolves through the runtime's own assembly (D4 LANDED)

**D4. `model explain` could name a provider the runtime would never serve.** Bundle 1c closed the
large half — `execute` did not engage the auto router at all, so the runtime and `explain` were two
different rankers. What remained was subtler, and only visible when the two call sites are read side
by side: **`chat.ts` layers two options on the shared `buildAutoResolveOptions` assembly, and
`explain` passed neither.**

- **`circuitBreakerStatus`.** The runtime reads the shared circuit breaker
  (`getProviderFallback(configManager).getCircuitBreakerStatus()`) and hands it to the router, whose
  sort **SINKS** a cooling-down provider. `explain` called `router.resolve(agent, task,
  buildAutoResolveOptions(...))` with no status, so *every* row looked healthy and explain could
  print a winner the walk would have deprioritised — and, before Bundle 2e, could not even show the
  `(circuit-breaker cooldown)` tag, because nothing set `inCooldown`.
- **The NLU `taskIntentHint`.** The runtime parses the same text (`parseRequestSync` →
  `resolveDispatch`) and seeds the router's task intent, which overrides the profile's own text
  classification. `explain` seeded nothing, so for a task where the two disagree it ranked a
  different provider set. This is not hypothetical: measured on `"repair the broken import in
  loop.ts"`, the router's own analysis reads `coding` while the NLU reads `debugging`, and the hint
  drops `local` from the ranking (`gemini:0.4384, bedrock:0.4125, deepseek:0.4096, groq:0.3992,
  openrouter:0.3022` vs the unhinted list which also carries `local:0.3396`).

**The fix.** One private `resolveExplainDecision(router, agentType, task)` — the resolution path is
shared instead of restated. It reads the breaker best-effort (in a `try/catch`, so a breaker read can
never break `explain`), derives the NLU intent seed from the same text, and merges both into
`buildAutoResolveOptions`. All three explain call sites go through it: `buildExplainJSON` (the
`--json` scripting surface), `renderRoutingDecisionDiff`, and `renderRoutingDecision`.

**Measured after — and both halves proven NON-VACUOUS, not asserted.**
`tests/cli/model.test.ts` (+2):

- the circuit-breaker test drives `recordFailure('groq')` three times (into cooldown) and asserts the
  explain output contains `(circuit-breaker cooldown)`. **Removing `circuitBreakerStatus` fails it**
  verbatim: `expected '… Auto Model Routing — Explain …' to contain '(circuit-breaker cooldown)'`.
- the NLU test asserts the explain decision equals the runtime assembly **including** the hint, and —
  so the assertion cannot pass by accident — first asserts the hinted and unhinted rankings
  **differ** for the fixture prompt. **Removing the intent seed fails it** verbatim:
  `expected '{"t":"default","c":"moderate","p":"gemini/gemini-2.0-flash","r":["gemini:0.4384",
  "bedrock:0.4125","deepseek:0.4096","groq:0.3992","openrouter:0.3022"]}' to be '…,"groq:0.3992",
  "local:0.3396","openrouter:0.3022"]}'`.

**Honest residual.** `explain` now shares the runtime's *option assembly*, which is what made the two
disagree; it still answers a hypothetical (`model explain <task>`) and so cannot see the pieces of a
real turn's routing input that only exist at runtime — a continuation's `routingText` (the prior
software ask), `contextHintTokens`, and the session's failed-provider set. The acceptance criterion
is met for the same input text: given one task string, `explain`'s winner is the winner the walk
would take, including cooldown and NLU-intent effects.

## Bundle 2f — the pipeline's housekeeping steps are named, not `unknown` (A5 LANDED)

**A5.** The pipeline's housekeeping calls — the planner, memory retrieval, trajectory summarization,
self-improvement — all run through `defaultCallLLM`, and each was wrapped for the trace at its use site
with NO provider/model. Two defects fell out of one omission:

- On the explicit path the step recorded **`unknown/unknown`** even though `options.provider/model` were
  known, so the trace — and, since Bundle 2d, the summary derived from it — could not say which model ran.
- In AUTO mode `defaultCallLLM` is ALREADY traced by `createAutoRoutedLLM`, so the extra wrap logged
  every housekeeping call **twice** (once routed, once `unknown/unknown`). The planner had a guard against
  exactly this; memory/trajectory/self-improver did not.

**The fix.** One `housekeepingCallLLM(agentType, description)` helper generalises the planner's guard: in
auto mode it reuses the already-traced LLM (no second wrap), otherwise it wraps once and attributes the
step to `resolveAuditRoute(options)`. The decision is extracted to `housekeepingTraceContext()` so it is
testable without driving the orchestrator.

**Measured before / after — the same `nuvira phase execute` on an isolated `NUVIRA_MEMORY_DIR`:**

| | Old build | New build |
|---|---|---|
| Orchestrator trace summary | `unknown / unknown` | `groq / default` |
| Steps reading `unknown` | 5 of 5 (all `planner`) | **0** |

**Tests.** `tests/agents/orchestrator.test.ts` (+3): no re-wrap in auto mode, one wrap naming the pinned
pair on the explicit path, and the pair omitted (not guessed) when nothing is known. All five docs guards
green; **453 files / 8307 tests** + dashboard **50 / 1052**.

**Honest limit.** When the pipeline is UNPINNED the audit route resolves the configured model *sentinel*
(`default`), because the concrete model is chosen by the adapter below the trace layer and is not knowable
at the record site. The three surfaces now AGREE, which is what A5 asked for; naming the concrete adapter
default there is a separate, larger change.

## Bundle 2e — `model explain`'s ranking key is stated, not implied (D5 LANDED)

**D5.** The "Ranked providers" list printed `score` beside every row but was NOT sorted by score: the
sort key is *availability first* — a cooling-down provider sinks, then a quota-parked one, then score
within each group — because that IS the routing precedence. Measured on a real run the scores read
`0.351, 0.465, 0.397, 0.396`, which looked unsorted; the ranking was correct and the header was silent
about its own key. A quota-parked row was also unlabelled (only `inCooldown` got a note), so a parked
provider dropping below a lower-scored healthy one had no explanation at all.

The header now names the key (`ordered availability-first — cooling-down, then quota-parked, then score
within each group`) and a quota-parked row is tagged `(quota-parked)`. The routing order is unchanged —
this is a display fix over a ranking that was already right.

**Measured after.** `tests/cli/model.test.ts` (+1). All five docs guards green; **237 files / 4064 tests**.

## Bundle 2d — the trace names the pair that served (D3 model half / A5 + D2 LANDED)

**D3 / A5. The summary named a REQUEST, and only half of it was derived.** `beginTrace` stores the
provider×model the caller had configured — read before routing — so a failover, handoff or
substitution leaves it describing a pair that may have served nothing. A previous increment derived
the summary *provider* from the steps (the one that served the most) but left the *model* as
requested. `nuvira trace` prints both (`Provider: …` / `Model: …`), so a run could be reported as e.g.
`deepseek/<requested-openrouter-id>` — a pair the run never ran, and exactly the A5 "three accounts of
one turn" shape. Both halves are now one vote: the **provider×model pair that served the most steps**.
No steps → the requested pair is left alone (nothing tried is not evidence).

**D2. A mid-turn detour was invisible.** Measured: seq 14 of the 82-step run was served by
`local/deepseek-coder:latest` while the summary, the header and the report named something else. A
detour is not a failure — a failover is legitimate — but a reader auditing "why does step 14 read like
that?" had no answer in the artefact. `endTrace` now also emits **one bounded `decision` event** listing
every pair other than the run's own and the number of steps it served (`model detour — 1 of 3 step(s)
ran on a pair other than the run's own (deepseek/deepseek-flash): local/deepseek-coder:latest ×1`).
Honest limit: this makes the detour *visible and attributable*; it does not judge its *quality*. A
non-empty generic non-answer (the other half of D2) is not detectable without a measured-quality
signal (B3), and guessing one from prose is the kind of name-driven heuristic this programme removes.

**Measured after.** `tests/learning/reasoning-trace.test.ts` (+3): the served MODEL is reported, the
detour lands as one `decision` event, and a single-pair run records none. Live: a headless `-t` turn on
an isolated `NUVIRA_MEMORY_DIR` reported `provider=gemini model=gemini-3.1-flash-lite`, identical to
the run's only step pair. All five docs guards green; **237 files / 4063 tests**.

## Bundle 2c — the delivered answer must be the run's own last word (D1 LANDED)

**D1. The answer a turn delivered was the LONGEST text of the turn, not its last substantive one.**
In `trace-1791300903944-upblb7` (the 82-step max/auto run this programme is measured against), the
longest step was **seq 65 — 4,024 chars** — the "Built and verified. Here's the rundown." draft.
seq 80 (155 chars) and seq 82 (165 chars) were the run's OWN corrections of that draft ("My README
claim was **wrong** — torch-2.14.1 and sentence-transformers-6.1.0 *do* resolve…"). Because
`tool-loop.ts` replaced `lastContent` only when the new text was `>=` the stored length, neither
correction could ever take over: the turn ended `bounded: true` with `contentChars: 4024` — it handed
the user a claim the run had already disproved itself.

**Why the length rule existed — and why length is the wrong proxy.** It was written to stop a trailing
WRAPPER (a short closing paragraph, common when a model repeats `suggest_followups`) from clobbering
the full answer (the "where is the essay?" bug, S1). But a correction is *also* short, so length
cannot separate the two. What actually separates them is whether the turn DID something in between:
**text written after real work is an account of a LATER state and supersedes; a closing paragraph
written with no work since is presentation.**

**The fix.** A later answer now replaces the stored one when it is at least as long (the old path,
unchanged) **or** when real work SUCCEEDED since the stored one was written. "Real work" is the
cardinality of the same predicate `hasProductiveAction` answers — `progress.successfulToolCalls` minus
`NON_PRODUCTIVE_TOOLS` — read from the loop's own success record, so a refused or failed call is never
mistaken for work and the two definitions cannot drift. The capture is stamped at the TOP of the next
iteration (with that step's own tool calls counted) so a step's OWN tool call can never make its own
answer look superseded by the next step's wrapper — the essay step that also wrote a file must not
lose to the closing paragraph.

**Measured after.** `tests/tools/tool-loop.test.ts` (+2). Both were proven to FAIL under the old
length-only rule (the run delivered the draft: `expected 'My earlier claim was wrong…' to be 'Built and
verified…'`) and pass under the new one:

- a long draft → real tool work → a SHORTER corrective answer is delivered (the D1 case);
- a short closing wrapper written with NO work since the essay does NOT displace it (S1 held).

All five docs guards green; **237 files / 4060 tests** (4058 + 2). The field evidence is the run-A
trace above — the shape is not reproducible in a short headless run, so the trace is the proof and the
unit tests pin the rule.

**Honest residual.** The rule keys on *work since*, not on retraction language, so it cannot tell a
correction from a genuinely-terse final paragraph when the two have the same shape. That is
deliberate: the alternative — pattern-matching words like "wrong"/"actually" — is exactly the kind of
name-driven heuristic this programme exists to remove. If a future measured run shows it, it is a
candidate for a measured-quality rule (B3), not a phrase list.

## Bundle 2b — `model list` must describe the same world routing does (E3 LANDED)

**E3.** `model list`'s provider set was a literal array —
`['local','groq','nim','gemini','openrouter']` — while the router builds its candidates from
`CATALOG_PROVIDER_IDS` plus whatever the user configured (`rankAvailableProviders`). So the one
command whose entire job is "what can I use?" omitted every catalog provider: measured live on the
machine this programme ran on, `deepseek` **served the turns** (the debug header and the trace both
named it, and the router ranked it) while `model list` did not show it at all.

Both surfaces now read the same source, which is what the acceptance criterion asked for — and it
is the only way they can agree, since "is this provider configured?" is answered by
`hasRequiredCredentials` in one place.

Because the table now carries the whole catalog, it is ordered **usable first** (available →
configured-but-unreachable → needs-key), stable within each group so the familiar five keep their
place. Without that, the answer to "what can I use?" sat below a dozen `Needs key` rows.

Measured after: `deepseek` renders as `⚙️ Ready / ✅ / deepseek-flash` (it previously reported
`default` for every provider it did show). All five docs guards and **237 files / 4058 tests** green.

Honest note: E3's other half — NIM reported as "Needs key" while the router was said to rank it — is
now *consistent by construction* (one predicate), but whether this machine's NIM key is *detected*
is a credentials/env-var question this bundle does not answer.

## Bundle 2a — the offered chain must obey the gate the pick does (D6 LANDED, D5 re-diagnosed)

**D6. `model explain`'s chain offered pairs the pick would have refused.** Measured on a live
`model explain`: `openrouter/~deepseek/deepseek-pro-latest` and
`openrouter/~deepseek/deepseek-flash-latest` — both `unverified` alias ids — were printed with the
same confident `Fallback (alternate model on openrouter)` wording as a proven model.
`fallbackModelsFor` deliberately keeps registry-unusable models as a last resort, and passes 1–3
never re-checked them. Two verdicts, two treatments, and the distinction is the product's own
doctrine:

- `unavailable` is a **no** — dropped from the offered chain. Recommending a pair a real call
already rejected tells the operator to walk into a wall, and `model explain` is where they decide
what to pin next.
- `unverified` is an **unknown, not a failure** — it stays (a weak candidate beats no candidate)
but is **labelled** as unproven, so the confidence in the wording matches the evidence.

The reserve passes already labelled themselves this way; this applies the same rule to passes 1–3,
at the one choke point (`pushFallback`). Verified live: the two alias pairs now read
`(unverified — not yet proven, alternate model on openrouter)`.

**D5 — corrected, and it is a real defect with a different cause than the report gave.** I could
not reproduce "ranks are not sorted by their own scores": `ranked` *is* sorted by score, and a test
in `tests/learning/auto-router.test.ts` asserts exactly that. The mechanism behind the observed
`0.351, 0.465, 0.397, 0.396` is the **sort key**: the router ranks by *availability first* —
circuit-breaker-cooldown rows sink, then quota-parked, then score. A cooling-down provider with a
higher raw score therefore renders BELOW a healthy lower-scored one, in a table whose header says
"Ranked providers" and whose only quantitative column is `score`. Run A had cooldowns from its own
failed calls, which is exactly that shape — so the original reading was wrong about *why* and right
that the output misleads. Left **OPEN** (S3): it is display-only, and the honest fix is to state the
grouping (or make the displayed order the displayed metric) rather than to change the ranking,
which the selection logic depends on.

| | Before | After |
|---|---|---|
| `~`-prefixed alias pairs in the chain | printed as confident alternatives | labelled `(unverified — not yet proven …)` |
| Proven-dead (`unavailable`) pairs in the chain | offered as fallbacks | dropped; the chain is never emptied |
| Tests | — | `tests/learning/auto-router.test.ts` (+2); **237 files / 4058 tests**; tsc; `build:cli`; all five docs guards |

## Bundle 1c — the CLI was not auto-routing at all (A5/A6/D3/D4 + A2 residual, CLOSED)

Bundle 1b left one gap: "the auto chat path resolves its model elsewhere". Instrumenting a live
`-t` turn (`NUVIRA_TRACE_ROUTE=1`) produced **one line that explains five findings at once**:

```
[TRACE] execute {"autoMode":false,"type":"groq"}      # no -p/-m; config defaultProvider is "auto"
[TRACE] tryGenerate {"typ":"groq","effectiveModel":"deepseek-flash"}
[TRACE] nonAutoFallback:try {"fbType":"gemini"}
```

**Cause 1 — `ChatCommand.execute` never honoured the configured `defaultProvider: "auto"`.**
`answerOnce` (dashboard/gateway) has since 2026-09-20; `execute` — the whole CLI (`-t/--task`,
`chat "<task>"`, the REPL) — is a *separate implementation* and computed `autoMode` only from
`-p/-m` or `model switch`. So `autoMode` was `false` and `resolveProvider(config, undefined)`
resolved `defaultProvider: "auto"` through a **third ranker** (`rankAvailableProviders`) to one
concrete provider. Everything downstream of the auto router was skipped on the product's most
common entry point:

- no `routeMessageAuto` → **no routing-history row** (A6), no routing cache, no capability gate,
  no pin pre-flight;
- `model explain` (the auto router) ≠ the runtime (that other ranker) → **D4**;
- the non-auto walk served the fallback and left `session` naming the provider that had *failed*.

**Cause 2 — that mis-attribution poisoned the registry, and the poison ranked first.**
`resolveEffectiveModel(provider, undefined)` = `preferredModelsFor(provider)[0]`. The live registry
held `groq|deepseek-flash` and `groq|gemini-3.1-flash-lite` as **`verified`, `source: telemetry`** —
written by `recordRegistrySuccess(session.type, session.model)` after a fallback had served the turn,
so a *DeepSeek/Gemini id was recorded as a Groq model*. `SOURCE_CONFIDENCE.telemetry` (0) outranks
`spot-check` (1), so those bogus rows sorted FIRST, became groq's adapter default, sent a foreign id
where goq cannot serve it, 404'd into the same fallback, and wrote another bogus row. Measured:
the next probe had groq calling `gemini-3.1-flash-lite`.

**One turn had three accounts of itself** — `turn.start {"provider":"groq"}`, header
`backend.provider: deepseek`, `model explain: gemini-3.1-flash-lite` — which is **A5/D3** exactly,
now with a mechanism and a fix.

### LANDED in this bundle

| Fix | What changed | Why it is the real cause |
|---|---|---|
| **F1** | `chat.ts` `execute`: when neither `-p/-m` nor `model switch` state is present, the config's `defaultProvider` decides — and `auto` engages the auto router. An explicit pin is checked FIRST, so a pin can never be re-routed. | This is the missing entry point. One flag turns off the route audit, the capability gate, the pin pre-flight and `explain` parity for the CLI. |
| **F2** | `chat.ts` non-auto fallback walk **installs the pair that answered** on `session` (type/provider/model) and says so on the console. | One defect with four faces: the debug log's `turn.start` vs its own header, `servedRoute()` telling the model the wrong name, the cache storing `provider: groq` beside `model: deepseek-flash`, and `recordRegistrySuccess` writing a **pair that cannot exist** as `verified`. |
| **F5** | `route-resolver.ts` exports **`strictPinRefusal()`** (one implementation, one wording); `resolveRoute` uses it, and chat's pinned path (`buildToolCallModel`) consults it before the first network call. Strict-only, matching `resolveRoute`. | After Bundle 1b the same strict-pin run logged BOTH behaviours: the pipeline refused the pair, the chat tool loop still sent it and got a raw 402. One gate, two call sites, and one of them was missing. |
| **F4** | `model-selection.ts` `preferredModelsFor`: never rank a row whose OWN `lastError` says the model does not exist (404/not-found), whatever its `status` claims. | `status: verified` is a latch and telemetry outranks spot-check, so a mis-attributed row wins forever. Narrow: a `rate-limit`/5xx row stays. |
| **F6** | `model-registry.ts`: an **account-level refusal survives** (a) a catalogue listing (`markListed`) and (b) `pruneAbsentModels`. Availability (does the provider serve it) and ENTITLEMENT (may this account use it) are separate axes — the same distinction `errorRate`/`partialRate` already draw. | Measured: the `credit-exhausted` verdict on the pinned pair was gone after a refresh, so the strict pre-flight stopped firing and the run sent the request. A listing is evidence about the CATALOGUE, never about the account. |

### MEASURED AFTER (not inferred)

| | Before | After |
|---|---|---|
| `-t "<pong>"` routing rows | **0** | 2–3, every one naming the served pair |
| Runtime model vs `routeMessageAuto`'s pick | different | the same pair |
| Strict pin, isolated registry: `402 Insufficient credits` bodies | **1** | **0** |
| Strict pin: "Refusing to call …" | 0 before the call | 2 (chat tool loop + pipeline), before any request |
| Gates | — | tsc clean; **237 files / 4056 tests**; `build:cli`; all five docs guards |

### Residuals — still OPEN (do not read this bundle as "closed")

- **A1 proper is open.** `verifiedEquivalent()` is an exact **bare-id** match; the measured pair
  (`deepseek/deepseek-v4.1-flash` vs the verified `deepseek-flash`) still shares no bare id, so it
  honestly suggests nothing. A real identity layer is still the fix; family guessing is not.
- **A6's acceptance wording was too strong.** It said "exactly one row". A headless turn makes
  **2–3 genuine decisions** (the initial route for the header, then the message route), so it
  appends 2–3 rows — all naming the same served pair. Left as-is rather than invent a dedupe that
  would break routing-history's documented per-message intent.
- **The registry has no cross-process locking.** Measured while verifying this bundle: other
  long-lived `nuvira` processes on this machine (a dashboard, a gateway, an `eval run`) rewrite
  `~/.nuvira/memory/model-registry.json` concurrently, and the strict-pin verdict on the *shared*
  file flipped to `unverified` between runs — which is why the deterministic verification seeds an
  isolated `NUVIRA_MEMORY_DIR`. F6 closes the two in-code paths that did it; the shared-file race
  itself is NOT fixed and is a candidate for its own bundle.
- **A5 residual**: CLOSED in Bundle 2f — pipeline housekeeping steps are named and no longer double-recorded.
- The bogus rows already on disk (`groq|wire-stub-model`) are not migrated; F2 stops new ones and F4
  stops the not-found ones being ranked. A one-shot registry hygiene pass is not implemented.

## Bundle 1b — identity & pin pre-flight (PARTIAL, honestly)

| # | What changed | What it does |
|---|---|---|
| **A2** | `route-resolver.ts`: before resolving, a **strict** pin to a pair the registry marks `unavailable` is refused, naming the reason. Guarded by a test that asserts the provider's `listModels` is **never called**. | Fails fast with the cause instead of after a provider round trip. Wording deliberately retains `strict model mode` / `forbids substituting`, because `error-repair.ts` classifies on those phrases. |
| **A1 (minimal)** | `model-registry.ts` `getAllUsablePairs()` + `verifiedEquivalent()`: an exact **bare-id** match on another provider is named as the alternative. | Answers "the same model works over there". Deliberately NO family guessing: the measured pair (`deepseek/deepseek-v4.1-flash` vs the verified `deepseek-flash`) does **not** share a bare id, so it honestly suggests nothing rather than asserting they are the same model. A real identity layer is still A1 proper and stays open. |
| **A3 (partial)** | The pre-flight reads the **same** `isUsable()` gate routing uses, via the registry. | The reachability verdict is now consulted on this path, not only displayed. |

### MEASURED RESIDUAL — the chat path bypasses the pre-flight (still open)

Re-running the strict pin after the fix shows **both** behaviours in one log:

- ✅ line 42: `Refusing to call openrouter/deepseek/deepseek-v4.1-flash without trying it: credit-exhausted …` — the **pipeline/executor** path is now pre-flighted.
- ❌ line 2: `Tool-loop generation failed: Tool-calling API error (402): …` — the **chat tool loop** still went to the network.

So A2 is landed for every caller of `resolveRoute` (executor, orchestrator, pipeline tool,
release-preflight, NLU) but **NOT** for the chat tool loop's own model call, which resolves its
model elsewhere. This is the **same layer gap as A6**, and the two should be fixed together: one
missing chat-path resolution point explains *both* the absent audit row and the un-pre-flighted pin.

Acceptance for closing it: the same strict-pin run logs **no** 402 body at all.

## Bundle 1 — identity, routability & definitive failures (LANDED)

Verified end-to-end, not just by unit test. Re-running the exact failing command
(`NUVIRA_STRICT_MODEL=1 ... chat -p openrouter -m deepseek/deepseek-v4.1-flash`) produced:

| | Before | After |
|---|---|---|
| Registry entry for the pinned pair | `status: unverified`, no error | `status: **unavailable**`, `lastError: credit-exhausted (that provider account cannot pay for this call)` |
| Park timer | — | `quotaParkedUntil: 0` — definitive, not a cooldown that expires |
| Planner outcome | `Repair budget exhausted after 2 attempt(s)` | `**Non-repairable error (pin-unavailable)**` — **zero** wasted attempts |

| # | What changed | Why it was the real cause |
|---|---|---|
| **C2** (was P9) | `error-repair.ts` + `provider-fallback.ts`: `credit-exhausted` and `pin-unavailable` are definitive — refused by `isRepairable()`, short-circuited in `selectStrategy()`, and (credit) absent from `TRANSIENT_RETRY_TYPES` so the same provider is never re-tried. | **Two causes, found by re-measuring.** (1) The live 402 matched *no* branch, fell to `unknown` (repairable) and burned the budget — and the branch must precede `context-limit`, because the real message contains `max_tokens` and would otherwise have been "fixed" by shrinking the ask. (2) After fixing (1), the budget was **still** exhausted: the error that actually reaches the repair loop is the **strict-mode refusal sentence**, not the 402. Fixing only the obvious one would have looked right and changed nothing. |
| **A4** | `model-registry.ts` `recordCall`: `credit-exhausted` demotes the pair to `unavailable`, with a message naming the **account** (not the model). | An unfunded account was invisible to the registry, so the pool kept offering the pair. |
| **A5/D3** | `reasoning-trace.ts` `endTrace`: the summary `provider` is derived from the **served** steps, not the value configured at `beginTrace`. | A 12-minute turn summarised as `groq` while all 81 steps were `deepseek/deepseek-flash`. Steps now win; no steps ⇒ the requested value is left alone rather than guessed. |

**Known residual from Bundle 1 (honest):** on the pipeline path the *steps themselves* record
`provider: unknown`, so the corrected summary legitimately reads `unknown`. The derivation is right;
the pipeline simply does not populate the step provider. That belongs to A5 and stays open.

## LANDED

| Item | What changed | Tests | Status |
|---|---|---|---|
| **C2** (was P9) | `error-repair.ts`: a 402 / "insufficient credits" now classifies as **`credit-exhausted`**, which `isRepairable()` refuses and `selectStrategy()` short-circuits to `skip-step`. Before: the live OpenRouter 402 matched **no** branch, fell to `unknown` (repairable), and burned the whole Planner repair budget. The branch is deliberately placed **before** `context-limit`, because the real message contains `max_tokens` and would otherwise have been "fixed" by shrinking the ask. | `tests/learning/error-repair.test.ts` (+4, live rejection text reproduced verbatim; plus a guard that genuine `provider-error`/429 still repairs) | **LANDED**, gate run |
| **D2 (handoff half)** | `tool-loop.ts`: on a model handoff, the failed model's `reasoningContent` is stripped so a stranger's chain-of-thought is never replayed to the replacement model. Kept on a same-model retry, where some providers require it. | `tests/tools/tool-loop.test.ts` (+1) | **LANDED**, gate run |
| **A6 (partial)** | `route-resolver.ts`: the **happy path** now records a routing row (previously only substitutions were recorded). | `tests/inference/route-resolver.test.ts` (+3) | superseded by A6/F1 below |
| **E3 (Bundle 2b)** | `cli/model.ts` `listProviders`: the provider set comes from `CATALOG_PROVIDER_IDS` + configured ids — the same source `rankAvailableProviders` uses — instead of a literal five-provider array; rows are ordered usable-first. | **LANDED**, live-verified: `deepseek` now appears as `Ready / ✅ / deepseek-flash` where it was invisible |
| **D6 (Bundle 2a)** | `auto-router.ts` `pushFallback`: a pair the registry has proven dead (`unavailable`) is dropped from the offered chain; one with no proof is labelled `unverified`. The `unverified` distinction is the doctrine — an unknown is not a failure. | `tests/learning/auto-router.test.ts` (+2) | **LANDED**, live-verified in `model explain` |
| **D1 (Bundle 2c)** | `tool-loop.ts`: `lastContent` is replaced by a later answer when real work SUCCEEDED since the stored one (the same predicate as `hasProductiveAction`, so they cannot drift), not only when the new text is longer; the stamp is deferred to the next iteration so a step's own tool call cannot expose its answer to the next step's closing wrapper. | `tests/tools/tool-loop.test.ts` (+2, both proven to fail under the old length-only rule) | **LANDED**, field evidence `trace-1791300903944-upblb7` (seq 65 draft vs seq 80/82 corrections) |
| **D3 (model half) / A5 / D2 (Bundle 2d)** | `reasoning-trace.ts` `endTrace`: the summary names the provider×model PAIR that served the most steps (previously only the provider was derived, beside a requested model), and a `decision` event records any mid-turn detour with per-pair step counts. | `tests/learning/reasoning-trace.test.ts` (+3) | **LANDED**, live-verified (the summary pair equals the run's step pair) |
| **D5 (Bundle 2e)** | `cli/model.ts` explain: the "Ranked providers" header states the availability-first sort key and quota-parked rows are labelled — the order was already the routing precedence; only the display hid its key. | `tests/cli/model.test.ts` (+1) | **LANDED** |
| **E1 / E2 (Bundle 5a/5b)** | `tools/registry.ts` + `tools/ask-user.ts` + `learning/run-trace.ts` + `learning/turn-report.ts` + `cli/chat.ts`: an unattended `ask_user` default is recorded as an ASSUMPTION (never a shown answer), emitted as `autonomy:assumed-default`, and disclosed in a `🤝 decided for you` turn-report block; a pinned ask re-dispatched into the pipeline announces the execution-model change and the pin it carries. | `run-trace` (+2), `turn-report` (+3), `registry` (+2), `ask-user-non-interactive` (+3 assertions), `chat-answer-once-auto-parity` (+1) | **LANDED** |
| **D4 (Bundle 2g)** | `cli/model.ts`: one `resolveExplainDecision` used by all three explain call sites resolves through the SAME option assembly the runtime uses — it reads the shared circuit breaker and seeds the same NLU `taskIntentHint` (`parseRequestSync` → `resolveDispatch`). Before: explain passed neither, so it could name a provider the runtime would sink or rank a task with a different intent. | `tests/cli/model.test.ts` (+2, both proven to fail when the option is removed) | **LANDED** |
| **A5 (Bundle 2f)** | `agents/orchestrator.ts`: one `housekeepingCallLLM` helper (planner + memory + trajectory + self-improver) reuses the already-traced LLM in auto mode (no double-record) and wraps once WITH the audit route otherwise (no more `unknown/unknown`); `housekeepingTraceContext()` is the extracted, unit-tested decision. | `tests/agents/orchestrator.test.ts` (+3) | **LANDED**, measured before/after on `nuvira phase execute` (5/5 `unknown` steps → 0) |
| **A6 / A2 (Bundle 1c; A5/D3/D4 completed in Bundles 2f/2d/2g)** | `chat.ts` `execute` honours `defaultProvider: "auto"`; the non-auto fallback installs the served pair on `session`; the pinned path consults `strictPinRefusal`; `preferredModelsFor` drops a "verified" row whose own error says the model does not exist; entitlement failures survive a listing and a prune. | `tests/cli/chat-answer-once-auto-parity.test.ts` (+2, the CLI entry), `tests/learning/model-registry.test.ts` (+2), `tests/learning/model-selection.test.ts` (+1) | **LANDED + live-verified**: routing rows 0→2–3 on `-t`; strict pin 402 bodies 1→0. See "Bundle 1c". |

## Non-goals

- No fix may be "which model we route to". The model is held constant on purpose (see top).
- No fix may weaken a safety invariant (deny-first commands, workspace boundary, git gates,
  effect verification).
- No guessed value may be written into an audit record. `complexity: 'unknown'` is correct where
  the layer genuinely cannot know; a plausible-looking bucket is not.

## Verification doctrine (per bundle)

1. `npx tsc --noEmit` clean.
2. Focused suites for every touched area green.
3. `npm run build:cli` before any docs gate.
4. `docs:commands:check`, `docs:wire:check`, `docs:citations:check`, `verify:commands`,
   `dashboard:bundle:check`.
5. Full root suite + dashboard suite.
6. **A live re-run of the parity task** where the item is observable — with the served pair read
   from the trace, not from the report.

## Next bundles (in order)

1. **Bundle 1 — identity & routability** (A1–A4): the release blocker. Until a pinned/model choice
   is pre-flighted and named, every routing number in the product is unverifiable.
2. **Bundle 2 — truthful reporting** (**CLOSED: D1/D3/D4/D5/A5 landed in Bundles 2c–2g**): make the system's account of itself true.
3. **Bundle 3 — capability by measurement** (B1–B5): the root cause. **Blocked on a decision, not on analysis:** the design (data sources, three options, failure modes, acceptance tests) is written in `docs/DESIGN_CAPABILITY_BY_MEASUREMENT.md` and the recommended option is B (measured outcomes over a decaying static prior, with the id-substring terms REMOVED rather than capped).
4. **Bundle 4 — context discipline** (C1, C3–C6): the 2.85× gap. **Begins with a policy decision, not a patch:** C1's re-measurement (above) shows compaction already exists and never fired, so the question is the budget policy (lower the 200K-char floor / compact proactively / compact against the plan), and C5's fit-to-window conflict with the deliberate `THREAD_BUDGET_FLOOR_CHARS` never-shrink rule must be resolved the same way.
5. **Bundle 5 — autonomy & inventory** (**PARTIAL: E1/E2 landed in Bundle 5a/5b; E3 + D6 landed in Bundles 2a/2b; B5 is part of Bundle 3**).
