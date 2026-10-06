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
| A5 | S1 | **Identity is reported per component, not per pair.** One turn reported 3 different models. | Run A: explain `gemini-3.1-flash-lite` / trace summary `groq` / debug header `deepseek-flash` | One pair recorded once; trace, dashboard and explain all read it | A run's reported model is byte-identical across all three surfaces |
| A6 | S1 | **The auto chat path records no routing decision at all.** | Runs A/B/C: **0 rows** in `routing-history.json`; reproduced live with `-t` (Bundle 1c) | **LANDED** — the CLI was not auto-routing at all (F1). `execute` now honours `defaultProvider: "auto"`, so the turn goes through `routeMessageAuto` | A completed auto turn appends rows naming the served pair (2–3 genuine decision points per headless turn; 0 before) |

## Cluster B — Capability understanding (S1, root cause)

| # | Sev | Issue | Evidence | Fix | Acceptance |
|---|---|---|---|---|---|
| B1 | S1 | **Capability is inferred from id substrings** (`flash`/`lite`/`mini` penalised; `pro`/`70b` boosted). | `auto-router.ts` `getModelCapabilities()` | Measure capability; keep the name as a weak hint at most | A model whose id contains `flash` is not penalised for it |
| B2 | S1 | **Static provider baselines outrank real evidence** (`openrouter: 0.95`, `gemini: 0.85`, `local: 0.30`). | Baseline table | Derive from measured per-pair outcomes; decay the statics | Ranking changes when measurements change; two providers with equal measurements rank equally |
| B3 | S1 | **No measured quality exists anywhere.** The registry tracks latency, tokens, error rate — never capability. | `ModelRegistryEntry` | Record per-pair outcome quality (delivered? verified? retried? user-corrected?) | A pair that consistently fails is demoted by measurement, not by name |
| B4 | S1 | **Max mode's reasoning floor is name-driven**, so it excludes real models and admits others arbitrarily. | `MAX_CAPABILITY_MIN_REASONING = 0.7` vs `flash`+`lite` = 0.65 | Floor on measured capability | Documented: which models pass/are excluded, and why, from measurements |
| B5 | S2 | **Complexity is under-rated**: a 4-component full-stack app classifies as `moderate`. | `model explain` baseline | Recalibrate; require an agentic floor for build asks at every complexity | That prompt classifies ≥ `complex` |

## Cluster C — Context & execution discipline (S1/S2 — where the 2.85× gap lives)

| # | Sev | Issue | Evidence | Fix | Acceptance |
|---|---|---|---|---|---|
| C1 | S1 | **Context grows unbounded.** 128,482 chars / **1,192,115 input tokens** in one turn. | Run A trace | Compaction with an explicit budget; keep the plan, drop the transcript | A run of the same task stays within a stated input-token budget |
| C2 | S1 | **Definitive failures are retried.** 3 Planner attempts against a 402. | Run D log | **LANDED** (see below) | A 402 consumes zero repair attempts |
| C3 | S2 | **Redundant rediscovery.** Version probes 3–4×; two `venv`s created (`/tmp/test/.venv` *and* `/tmp/test/backend/.venv`). | Run A log + filesystem | Reuse probe results; verify the write landed before redoing it | One probe per fact per run |
| C4 | S2 | **Plan durability across continuations.** 4 continuations; the plan is re-derived rather than carried. | Run A | Continuations resume the plan | Continuation N re-reads the plan rather than re-planning |
| C5 | S2 | **No context fit on model handoff** — the whole thread is handed over, which would overflow a smaller model. | `tool-loop.ts` handoff | Fit-to-window by dropping the oldest turns; never rewrite | Handoff to a small-window model never overflows |
| C6 | S3 | **Cost is not attributed per step in the user-facing output.** Total token burn is invisible until the trace is read. | Run A/B comparison | Surface per-turn cost | A turn reports its own token spend |

## Cluster D — Truthfulness of what the system says (S1)

| # | Sev | Issue | Evidence | Fix | Acceptance |
|---|---|---|---|---|---|
| D1 | S1 | **Stale final answer at budget exhaustion.** Run A claimed FAISS "never executed" after its own trace verified it (seq 68) and after it corrected the claim (seq 80–82). | Run A | Compose the final answer from the recorded findings at exit, not from an earlier draft | The final answer never contradicts the run's own findings |
| D2 | S1 | **A useless response is recorded `success: true`.** `local/deepseek-coder:latest` returned a generic non-answer; the step logged success. | Run A seq 14 | Mark a step served by an unexpected model, and record the detour | A mid-turn model detour is visible in the trace as a detour |
| D3 | S1 | **The trace summary `provider` is wrong** (`groq` while all 81 steps say `deepseek`). | Runs A & B | Derive the summary from the steps | Summary == the model that served the most steps |
| D4 | S2 | **`model explain` does not predict the runtime.** | `gemini-3.1-flash-lite` vs `deepseek-flash` | Share the resolution path | explain's winner == the model a real turn uses, for the same input |
| D5 | S3 | **`model explain`'s ranks are not sorted by its own scores.** | `0.351, 0.465, 0.397, 0.396` | Sort, or label the columns honestly | Displayed order is the displayed metric |
| D6 | S2 | **The fallback chain offers non-routable pairs.** `groq/allam-2-7b` (verified but `lastError=rate-limit`, flagged in RC6) and `~`-prefixed OpenRouter alias ids (all `unverified`) appear as fallbacks. | `model explain` output + registry | Filter the offered chain by reachability | Every pair offered as a fallback is routable, or is labelled as unproven |

## Cluster E — Autonomy & decisions (S2)

| # | Sev | Issue | Evidence | Fix | Acceptance |
|---|---|---|---|---|---|
| E1 | S2 | **An unattended `ask_user` silently picks option 1** on a real architectural fork and never discloses it. | Run A ×3, Run B ×2 (FAISS vs Milvus) | Disclose every auto-picked decision in the final answer | The answer lists each decision taken on the user's behalf |
| E2 | S2 | **A pinned chat ask is re-routed into the multi-agent pipeline** by NLU (85% "create"). | Run D | A pin must not silently change the execution model | A pinned chat ask runs the pinned path, or says why it did not |
| E3 | S2 | **Provider inventory disagrees.** `model list` omits `deepseek` and reports NIM as missing a key, while the router ranks both. | Baseline | One credential source for both | `model list` and the router agree on provider availability |

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
- **A5 residual**: pipeline steps still record `provider: unknown`.
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
| **A6 / A2 / A5 / D3 / D4 (Bundle 1c)** | `chat.ts` `execute` honours `defaultProvider: "auto"`; the non-auto fallback installs the served pair on `session`; the pinned path consults `strictPinRefusal`; `preferredModelsFor` drops a "verified" row whose own error says the model does not exist; entitlement failures survive a listing and a prune. | `tests/cli/chat-answer-once-auto-parity.test.ts` (+2, the CLI entry), `tests/learning/model-registry.test.ts` (+2), `tests/learning/model-selection.test.ts` (+1) | **LANDED + live-verified**: routing rows 0→2–3 on `-t`; strict pin 402 bodies 1→0. See "Bundle 1c". |

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
2. **Bundle 2 — truthful reporting** (D1, D3, A5, D5): make the system's account of itself true.
3. **Bundle 3 — capability by measurement** (B1–B4): the root cause.
4. **Bundle 4 — context discipline** (C1, C3–C5): the 2.85× gap.
5. **Bundle 5 — autonomy & inventory** (E1–E3, B5, D6).
