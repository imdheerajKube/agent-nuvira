# fix_model_routing — pick right, explain why, hand off, never quit early

**Status:** P1–P8 IMPLEMENTED, VERIFIED, and **uncommitted** (the P8 gate re-run
is recorded in §9: root suite 453 files / 8269 tests, dashboard 50 / 1052, both
`tsc`, the four docs guards, `verify:commands` 336/336, bundle check). Nothing has
been committed since `d58ee163`; this lands when the user asks.
Release-blocking: the agent is to be released publicly and this class of failure
is a product-killer.

**Coverage:** every root cause below is mapped to a landed fix, its test and its
evidence in §7 — including the ones that were found *while implementing* (the
routing cache defeating the handoff, the chat path never writing the failure down,
the bandit never hearing about a step-level failure, the tail claiming a budget
that was never reached, and the single-shot walk sharing RC1). §8 records the
deliberate deviations and the residual this work does NOT close, so nothing here
reads as "covered" when it is not.

**Trigger.** A real user task ("build a knowledge base web app") was run three
times from the dashboard chat with defaults (auto routing, balanced mode). Run 1
"worked" in 320 s. Run 2 (`resume`) **died in 29 s with zero tool calls** while
the user could see several healthy models configured. Run 3 (retry) worked. The
user's expectation, verbatim: *"even if a model is incorrect on failure it
automatically supposed to switch to higher model"*, and *"don't quit till product
is delivered or there are no models available which can handle the task's
complexity"*, and when nothing is left: *"a clear decent communication that i
tried xyz models all have exhausted their capacity / budget, ask could be more
intelligent — please recharge these models, or should i wait that capable model
will be free in so and so time."*

This document is the charter. Each phase is independently shippable and
independently verifiable.

---

## 1. Evidence (all reproducible from disk)

### 1.1 The three traces (`~/.nuvira/memory/reasoning-traces.json`)

| Run | Trace | Goal | Routed pick (score) | Actually served | Outcome |
|---|---|---|---|---|---|
| 1 | `…mb4yse` | build KB app | `gemini/gemini-3.1-flash-lite` (0.247) | same | success, 320 s, 11 tools |
| 2 | `…6v7osw` | `resume` | `gemini/gemma-4-26b-a4b-it` (**0.591**) | **`local/gpt-oss:120b-cloud`** | **incomplete, 29 s, 0 tools** |
| 3 | `…qa4i0y` | Continue | `gemini/gemini-3.1-flash-lite` (0.329) | same | progressing |

`~/.nuvira/memory/routing-history.json` for the window:

```
1791280810009  gemini/gemma-4-26b-a4b-it    score=0.5906  chat  "resume"
1791280827104  local/gpt-oss:120b-cloud     score=0.5906  chat  "resume"   ← mid-turn failover, 17 s in
1791280859708  gemini/gemini-3.1-flash-lite score=0.3294  chat  "Continue…"
```

Run 2's trace events, in order:

```
[1] routing: gemini/gemma-4-26b-a4b-it (bandit-learned, agenticCapable=true)
[3] the provider returned an empty response — no answer text and no tool call; the step was retried
[4] … same                                                                          (retried)
[5] … same                                                                          (retried)
[6] the provider returned an empty response 4 times — one bounded escalation for a real step
[7] the provider returned 5 consecutive empty responses — the turn ended
[9] turn report — 1/4 steps done · 3 file(s) changed · verification: unverified
```

Outcome object: `{kind: 'incomplete', tools: [], undeliveredArtifact: true}`.

### 1.2 The session debug logs (`~/.nuvira/debug-logs/`)

Run 1 (`…1791280415803.log`) — the run that "succeeded":

```
09:54:29.816 tool.start run_terminal
09:56:29.882 tool.end   run_terminal ok:false      ← 120.07 s
09:56:33.880 tool.start run_terminal
09:56:46.871 tool.end   run_terminal ok:false
09:56:52.892 tool.start run_terminal
09:58:52.904 tool.end   run_terminal ok:false      ← 120.01 s
09:58:55.727 tool.start suggest_followups          ← gave up
```

Run 2 (`…1791280810326.log`):

```
# backend.provider: local
# backend.model: gpt-oss:120b-cloud
# backend.transport: json
turn.start {"provider":"gemini"}
turn.end   {"generationFailed":false,"cancelled":false,"bounded":true,"contentChars":41,"toolCalls":0}
```

### 1.3 The pool the router actually considered (live probe, this machine)

```
countEligibleModels(): {"models":538,"providers":23}
top candidates: gemini/gemma-4-26b-a4b-it#0.87, gemini/gemini-3.1-flash-lite#0.83,
                gemini/gemma-4-31b-it#0.81, local/gpt-oss:120b-cloud#0.81, …
by provider:    openrouter 471, gemini 33, groq 10, local 4, deepseek 2,
                openai 1, anthropic 1, xai 1, perplexity 1, bedrock 1, omniroute 1, …
registry:       565 entries — 517 unverified, 31 unavailable, 17 verified
```

Two things are wrong in that output alone:

1. **The count is not a capability count.** 23 "providers" include ones with **no
   credential configured at all** (`openai`, `anthropic`, `xai`, `perplexity`,
   `bedrock`, `omniroute`, `azure`, …). The pool is dominated by 471 untested
   OpenRouter models. Only **17 pairs** are verified. A report that can say
   "538 models are available" cannot be trusted to say "no model can do this".
2. **The ranking is wrong.** `gemma-4-26b-a4b-it` (a 26B MoE with ~4B active) is
   ranked **#1 at 0.87** for a moderate general task, above `gemini-3.1-flash-lite`
   (0.83) and `gemini-3.6-flash` (0.75). The broken local model ranks **#4**.

### 1.4 The bandit's learning store is stale

`~/.nuvira/memory/router-bandit.json` (the store behind the `bandit-learned`
label): last write **2026-09-25**, `priors` empty, **no `modelPriors` entry for
any of the models in play** — while the decision under test is dated 2026-10-06.
The score that flipped a working run to a failing one is not backed by recent
evidence, yet it is presented to the user as learned.

---

## 2. Root causes

| # | Cause | Where | Effect |
|---|---|---|---|
| **RC1** | A resolved-but-**empty** model response is treated as success by the provider walk | `src/learning/resilient-call.ts` (`await adapter.generate()` → unconditional `recordRegistrySuccess`, no content check) | The walk never advances on an empty response — only a **thrown** error moves it. The tiered escalation that exists (`model-first-router.ts`) never fires. |
| **RC2** | The tool loop routes empty responses into the "model is reasoning" branch and retries the **same** model | `src/tools/tool-loop.ts` (`isThinkOnlyResponse('') === true`), `MAX_THINK_CONTINUES = 3` | 5 consecutive empties → `bounded = true`, turn ends. No model change at any point. |
| **RC3** | Empties are never recorded as model failures | `resilient-call.ts` (records success on empty); `chat.ts` (records nothing when content is empty) | `local|gpt-oss:120b-cloud` stays `verified`, `errorRate 0`. The system cannot learn a model returns nothing. |
| **RC4** | The bandit score is stale/ungrounded but labelled as learned | `router-bandit.json`, `auto-router.ts` explanation builder | A working model choice is silently replaced by a worse one on the next turn of the same task. |
| **RC5** | Candidate pool includes uncredentialed / unverified models | `model-first-router.ts` `buildModelCandidates` / `countEligibleModels` | Over-reports capacity; both "there are models" and "no model fits" become untrustworthy. |
| **RC6** | Ranking puts a weak/broken model first | `model-scoring.ts` / capability fit | Wrong model chosen even when a good one is present. |
| **RC7** | No task-level model continuity | `chat.ts` routing per turn; `failover` candidates inherit the parent's score | `resume` degraded from the working model to a broken one; telemetry cannot tell a routed pick from a fallback. |
| **RC8** | `run_terminal` burns 120 s per attempt and the agent retries near-identical commands | `src/tools/run-terminal.ts` (`DEFAULT_TIMEOUT_MS = 120_000`) | ~4 minutes wasted in the *successful* run; the agent then gives up rather than adapting. |

Cross-reference: `docs/rca_false_success_and_no_resume.md` §8.5 already lists
"the 31 empty model responses are untouched" as unresolved — this plan closes it.

---

## 3. Invariants this work establishes

1. **A model response is only a SUCCESS if it is USABLE** — it carries assistant
   text or at least one tool call. Anything else is a *provider failure*: it
   advances the candidate and is recorded as a failure.
2. **A failure is never silent.** Every attempt records provider, model, failure
   kind and the next candidate; the user-visible result names them.
3. **A turn hands off, it does not quit.** The unit of retry is (model,
   attempt). While a capable candidate remains, the system keeps going — across
   models, not just steps.
4. **The turn stops only for a real reason**, and says which: delivered; user
   cancelled; or **no capable candidate exists** (an evidenced claim, with
   actionable options). "Steps exhausted" is not one of them.
5. **Capability is evidence-based**, not name-based: repeated unusable responses
   or failed tool loops on agentic tasks demote a model for agentic work.
6. **Capacity claims are credentialed and current.** "No model available" may
   only be said when the pool it is computed from excludes uncredentialed,
   dead and parked pairs — and it names the reset windows it knows about.
7. **The user is never asked to say "retry".** Doing what a competent operator
   would do (switch provider, switch model, wait for a window, ask for credit)
   is the system's job; the user is informed, not tasked.

---

## 4. Phases

Each phase: code + tests + docs, verified before the next.

### P1 — An empty response is a provider failure (RC1, RC3) ✅ LANDED
- New `src/learning/response-usability.ts`: `classifyModelResponse(response)` →
  `{ usable: boolean; kind: 'empty' | 'empty-with-tools' | 'malformed' | null; detail }`.
  Single definition used by the failover walk, the tool loop and telemetry.
- `resilient-call.ts`: validate the resolved result **before** recording success;
  on unusable → treat exactly like a thrown error (record `empty-response`,
  exclude/park per policy, advance candidate).
- `model-registry.ts`: add the `empty-response` failure kind — bump `errorRate`,
  park after N consecutive empties on the same pair.
- Acceptance: a provider that returns `''` N times causes the walk to reach a
  *different* provider; the empty pair's `errorRate` rises; no success recorded.
- Tests: `tests/learning/response-usability.test.ts`, extend
  `tests/learning/resilient-call*`, `tests/learning/model-registry.test.ts`.

### P2 — Mid-turn model handoff (RC2) ✅ LANDED
- `tool-loop.ts`: on the **first** unusable response, ask the caller for a new
  candidate (new dep hook, e.g. `deps.requestModelSwitch(reason)`), instead of
  re-calling the same model. Cap same-model retries at 1. Keep the bounded
  escalation as the fallback when no switch hook is supplied (tests/mocks).
- The caller (`src/cli/chat.ts`) supplies the hook and advances the deep pool;
  the route feed (`loop-route-feed.ts`) must reflect the new model.
- Acceptance: with a stub that returns empty for model A and a real answer for
  model B, the turn **completes on B** with no user action.
- Tests: extend `tests/tools/tool-loop.test.ts`, `tests/cli/chat-*.test.ts`.

### P3 — Delivery persistence (RC7 + invariant 3/4) ✅ LANDED
- Introduce an explicit per-turn **attempt budget** over (model, attempt) pairs,
  separate from the step budget, so hand-offs cannot be cut short by step
  accounting.
- Termination reasons become an explicit enum: `delivered` | `cancelled` |
  `no-capable-candidate` | `budget-with-candidates-remaining` (the last is a BUG
  signal, logged loudly).
- Task-level continuity: prefer the model that already produced usable output
  for this task/session when re-routing a continuation/resume.
- Acceptance: a turn whose first 3 picks are unusable still delivers on the 4th;
  a turn with candidates remaining never reports `bounded` as its ending.

### P4 — The honest exhaustion report (invariant 2, 4, 7) ✅ LANDED
- New `src/learning/exhaustion-report.ts` — deterministic, LLM-free. Input: the
  attempt list (provider, model, failure kind, when), plus quota-ledger state.
  Output: a plain-language report:
  - what was tried, per model, with the reason (rate-limit / auth / empty /
    timeout / model-not-found),
  - which providers are *exhausted* vs *dead* vs *cooling down*, and **when each
    reset window lapses** (from the quota ledger),
  - concrete options: recharge/replace key X; wait until `<time>` when `<model>`
    is free; allow a weak model and accept degraded quality; narrow the ask.
- Wired to chat, the tool loop's terminal path and the gateway, so the user is
  told *what happened* instead of "the turn ended".
- Acceptance: with a synthetic all-parked ledger the report names each provider
  and its reset time, and offers the wait/recharge options; no such text is
  emitted when a delivery succeeded.
- Tests: `tests/learning/exhaustion-report.test.ts` + surface wiring tests.

### P5 — Truthful pool accounting (RC5, and re-evaluating the gate the user distrusts) ✅ LANDED
- `buildModelCandidates` / `countEligibleModels` must consider only
  **credentialed** providers and reflect **dead / parked** state, so the count
  matches what routing would actually try.
- Re-derive the "no capable model" signal from that honest pool. The weak-model
  gate (`agentic-route-gate.ts`) keeps its consent semantics but its INPUT
  (`agenticCapable`) must be evidenced.
- Acceptance: on a machine with N credentialed providers, the count equals the
  credentialed, non-dead, non-parked candidate count; a unit test asserts the
  uncredentialed providers are absent.
- Tests: `tests/learning/model-eligibility.test.ts`, extend `auto-router` tests.

### P6 — Correct selection (RC4, RC6) ✅ LANDED
- **Capability fit:** the scoring must not rank a ≤4B-active / failing model above
  a proven one for a moderate agentic task; add an evidence term (observed
  unusable rate) to capability scoring.
- **Bandit honesty:** refuse the `bandit-learned` label when the store has no
  samples for the arms (or is stale); add a staleness guard; record a **negative
  reward** for unusable/failed attempts so the bandit learns.
- **Pool hygiene:** prune false `verified` pairs (`gemini|allam-2-7b`,
  `gemini|qwen2.5:0.5b`, `groq|wire-stub-model`) via model-id ↔ provider
  ownership, so "verified" means something.
- Acceptance: replaying the run-2 decision with run 1's history picks the working
  model; a stale bandit store yields no `bandit-learned` claim.
- Tests: `tests/learning/router-scoring-truthfulness.test.ts`,
  `tests/learning/router-bandit-*`.

### P7 — Terminal hygiene (RC8) ✅ LANDED
- Surface a timeout as a **specific** signal to the model ("timed out after
  120 s — likely X; try Y or a shorter command"), forbid an identical retry
  storm (cap consecutive identical commands), and use a shorter effective
  timeout for interactive turns.
- Acceptance: the run-1 pattern (three near-identical 120 s failures) is
  impossible — the third identical failure at the same timeout is refused, so a
  command keeps exactly **one** blind retry. The streak key includes the
  effective timeout, so the remedy this tool advertises on a timeout ("re-call
  with an explicit `timeout_ms`") is a genuinely new attempt and is never
  blocked by the guard that recommends it — and an applied **write** clears the
  streak, so a repaired project can re-run its own check (see §7.3).
- Tests: `tests/tools/run-terminal-timeout.test.ts`.

### P8 — Observability, docs, verification ✅ LANDED (gate log in §9)
- **Attempt chain on the reasoning trace.** A handoff emits
  `kind: 'gate', gate: 'handoff'` naming the cause and the attempt index
  (`tool-loop.ts`); the replacement is routed with `fallbackFrom` set, so the
  routing-history entry records it as a handoff rather than an ordinary pick
  (`chat.ts`); and an exhausted turn emits a trace event carrying the rendered
  report. A user can see why a turn moved and why it stopped, across all three
  surfaces the trace already serves.
- **Docs:** `docs/USER_MANUAL.md` gained the section *"When a model fails
  mid-task — what the agent does, and what it will ask you"* (remedy order, a
  verbatim sample report, reset times, terminal-timeout rules); `README.md`'s
  routing bullets were corrected to what the system actually guarantees and two
  new bullets added (mid-turn handoff; honest `bandit-learned` + timeout
  meaning); `CHANGELOG.md` gained six sections. `docs/COMMANDS.md` needed **no**
  change — no command surface moved, which `docs:commands:check` proves rather
  than assumes.
- **Full gates re-run:** both `tsc` clean, root suite, dashboard suite, the four
  docs guards, `verify:commands`, `build:cli` (so the guards read a fresh
  `dist`, not a stale one) and `dashboard:bundle:check`. Numbers in §9.

---

## 5. Non-goals

- Not a redesign of the router's scoring maths beyond P6's correctness fixes.
- Not changing the weak-model **consent** semantics (ask once per session) — only
  what feeds the verdict, and what happens *after* a denial.
- Not adding new providers; P5 only stops counting the ones that cannot be used.

## 6. Verification doctrine

Every phase lands with tests that fail before it and pass after, run with
`NPM_CONFIG_USERCONFIG=/dev/null npx vitest run <paths>`. No phase is "done" on a
green focused test alone: P8 re-runs the whole suite plus the docs guards. Any
claim in the completion report must be reproducible from a command in this repo.

## 7. Coverage matrix — every finding, against the landed fix

Legend: **✅ landed** · **⚠️ landed with a documented deviation (§8)** ·
**↩︎ deliberately not done (§8)**

### 7.1 The six root causes from the investigation

| # | Finding (as investigated) | Fix | Where | Status |
|---|---|---|---|---|
| **RC1** | An empty response is never a provider failure, so it never fails over: `await adapter.generate(...)` → unconditional success. Only a THROWN error advances the walk. `isThinkOnlyResponse('')` is `true`, so the loop retried the SAME model 3×, escalated once to the same dead model, then ended. | Validate the resolved result BEFORE recording success; an unusable result is classified (`empty-response`) and advances the candidate. The loop asks the CALLER for a different model instead of re-asking the same one. | `response-usability.ts` (new); `resilient-call.ts`; `tool-loop.ts` (`requestModelSwitch`, `MAX_SAME_MODEL_EMPTY_RETRIES`); `loop-executor.ts`; `chat.ts`; **`failover-runner.ts`** (single-shot walk — found uncovered while implementing) | ✅ landed |
| **RC2** | The router never LEARNS an empty-returning model is broken: `recordRegistrySuccess` on any resolved call heals `errorRate` and keeps the entry `verified`; on the chat path a fully-empty turn recorded nothing at all. | `recordCall` gained an `empty-response` branch (lastError, model-scoped park for `EMPTY_RESPONSE_PARK_MS`); `recordActionFailure` gained an `empty-response` branch (model-scoped session exclusion, registry write-through, quota event, and NO provider breaker trip); chat's handoff now runs that full composition instead of only a session-local exclusion. | `model-registry.ts`; `failure-bookkeeping.ts`; `provider-fallback.ts`; `chat.ts` (`recordAutoProviderFailure`) | ✅ landed |
| **RC3** | The `bandit-learned` score that chose the broken model is stale and ungrounded: store last written 11 days earlier, `priors` empty, no `modelPriors` entry for any model in play — yet the decision read `bandit-learned` and ranked a 4B-active MoE (0.591) above the model that had just worked (0.247). | The label is now a claim about EVIDENCE: `hasLearnedData` (Beta(1,1) = untouched) + a 7-day staleness guard; a cold or stale store is described as what it is. Empty responses are recorded as NEGATIVE reward in the arm the router samples. | `router-bandit.ts` (`hasLearnedData`, `ageMs`, `isStale`, `penalizeModel`); `auto-router.ts` (`banditInformed`) | ✅ landed |
| **RC4** | No task-level model continuity: run 1 built on flash-lite, run 2 re-routed the same task to gemma→local, run 3 back to flash-lite; and the fallback candidate inherited the parent's score, so telemetry cannot tell a routed pick from a fallback. | A per-session memory of "the pair that DELIVERED this task" is offered FIRST for a continuation (through the same credential/exclusion gates, so a dead pair costs one check); handoffs pass `fallbackFrom` so the history distinguishes them. | `task-model-continuity.ts` (new); `chat.ts` (`routeMessageAuto`, success path) | ✅ landed |
| **RC5** | `run_terminal` burns exactly 120 s per failure and the agent retries the identical command (~4 minutes of the successful run, then it gave up). | A timeout is a SPECIFIC signal with what to do instead; a command keeps ONE blind retry and the third identical failure at that timeout is refused in milliseconds with the required change (a longer `timeout_ms` or an applied write is a new attempt); the DEFAULT timeout is shorter (60 s) in front of a person, explicit `timeout_ms` still honoured. | `run-terminal.ts`; `registry.ts` (`ToolContext.interactive`); `chat.ts` | ✅ landed |
| **RC6** | The `verified` list is polluted with impossible pairs (`gemini\|allam-2-7b`, `gemini\|qwen2.5:0.5b`, `groq\|wire-stub-model`), so "verified" is a weak capability signal. | Pool hygiene: an Ollama-tagged id on a hosted provider and a fixture/stub id are no longer candidates, and a CREDENTIAL gate stops counting providers this machine cannot call (the live over-report: 538 "models" across 23 "providers", 17 pairs ever verified). | `model-first-router.ts` (`isPairPlausible`, credential gate, `countEligibleModels(…, configManager)`); `resilient-call.ts` | ⚠️ landed — `allam-2-7b` is NOT pruned (§8.2) |
| *(minor)* | Run 2 logged "the step budget (17) was reached" after only 5 model calls — a step-accounting inconsistency, not a cause. | The shared tail now names the ending it actually had (`no-capable-candidate` / `reasoning-spin` / budget) instead of always claiming the budget, both in the log and on the trace. | `tool-loop.ts` (tail), `termination` | ✅ landed |

### 7.2 The eight recommended fixes (dependency order)

| # | Recommendation | Where | Status |
|---|---|---|---|
| 1 | Treat an empty response as a retryable provider failure at the transport boundary | `resilient-call.ts`, `loop-executor.ts`, `failover-runner.ts`; for chat the boundary is the loop's validation + handoff (see §8.1) | ✅ landed |
| 2 | Record empties as failures in the registry; stop recording success on a resolved-but-empty result | `model-registry.ts`, `provider-fallback.ts`, `failure-bookkeeping.ts` | ✅ landed (parks on the FIRST empty, not after N — §8.3) |
| 3 | The loop's escalation must SWITCH MODELS, not re-prompt the same one | `tool-loop.ts` (`requestModelSwitch`), `chat.ts`, `loop-executor.ts` | ✅ landed |
| 4 | Cap repeated empties per model (not 5) | `MAX_SAME_MODEL_EMPTY_RETRIES = 1` → at most 2 calls per model, and `MAX_MODEL_HANDOFFS_PER_TURN = 5` overall | ✅ landed (one same-model retry before the switch — §8.3) |
| 5 | Ground or drop the bandit claim; persist real outcomes; empties as negative reward; staleness guard | `router-bandit.ts`, `auto-router.ts` | ✅ landed |
| 6 | Prefer the model that already worked this task/session on retry/resume | `task-model-continuity.ts` | ✅ landed |
| 7 | `run_terminal`: specific timeout signal, no 3 identical 120 s retries, shorter interactive timeout | `run-terminal.ts` | ✅ one blind retry, then the third identical attempt at that timeout is refused (§7.3); interactive default 60 s |
| 8 | Prune the false-`verified` pairs | `model-first-router.ts` | ⚠️ 2 of 3 named pairs (§8.2) |

### 7.3 Found while implementing (not in the original list)

| Finding | Why it mattered | Where |
|---|---|---|
| **The routing cache could defeat the handoff.** The 30 s decision cache is keyed on intent/complexity/health/session exclusions — NOT on the model-scoped pair just excluded — so a handoff inside the TTL could be handed back the very model it was escaping, silently making the switch a no-op. | It would have made P2 fail exactly in the situation it exists for (a handoff seconds after the initial route). | `chat.ts` (`routeMessageAuto.noCache`) — pinned by a test |
| **The chat path never wrote the failure down.** P1's registry learning was reached by the gateway/orchestrator walk and by `execute`, but chat's own walk recorded only a session-local exclusion — so a model that returned nothing stayed `verified` across sessions (RC2, on the surface that actually failed). | Without it the fix lasted one turn. | `chat.ts` → `recordAutoProviderFailure` |
| **The bandit never heard about step-level failures.** Its reward is per TASK outcome; a handoff does not fail the turn, so nothing was learned and the dead arm kept being sampled up. | This is the mechanism behind RC3's ungrounded score. | `RouterBandit.penalizeModel`, wired in `chat.ts` + `loop-executor.ts` |
| **The empty-response park must not trip the PROVIDER breaker.** An empty completion is a model property: the provider answered on time with HTTP 200. Tripping its breaker would deprioritize healthy siblings on that provider — the same mis-attribution the harness-fault guard exists to prevent. | Prevents "fixing" one bug into another. | `failure-bookkeeping.ts` |
| **The `countEligibleModels` number was the one a shortage claim rests on.** It has to be credentialed, or "no model can do this" is computed from models the machine has no key for. | It is the evidence behind the weak-model gate the user does not trust. | `model-first-router.ts` |
| **P7's guard contradicted the remedy it advertised, and would have deadlocked a repaired project.** (a) The timeout note tells the model to re-call with a longer `timeout_ms` when the work is genuinely long, but the streak was keyed on `${cwd}|${command}` — so a model that followed the tool's own advice could be refused for "repeating" a command it had deliberately re-scoped. (b) Tightening the cap to 2 (recommendation 7, "no 3 identical 120 s retries") surfaced a second defect: with no third call permitted, a FIXED project could never re-run its own check, so its success could never clear the streak — the guard would hold the repair against the repair. Found on the recheck, not while writing P7. | (a) The streak key now includes the effective timeout, so the advertised escape hatch is a new attempt while a blind repeat at the same timeout still counts. (b) The loop drops the streak when a WRITE is applied (`autonomy:write-applied`, excluding `run_terminal`'s own autonomy notice — that is a statement about its own command, not a change to the world, and letting it invalidate the streak would mean the guard never accumulates on the commands it exists for). Both are pinned by integration tests that run the loop with the real tools. | `run-terminal.ts`; `tool-loop.ts` (context emit); `tests/tools/run-terminal-timeout.test.ts` |

## 8. Deviations and residual (what this does NOT claim)

**8.1 Chat's transport boundary is the loop, not `callModel`.** The recommendation
named `chat's callModel`; the validation instead sits in the two walks that own a
candidate pool (`loop-executor`, `failover-runner`) plus the tool loop, and chat's
`buildToolCallModel` deliberately does NOT throw on an empty completion. Reason:
throwing there falls into chat's own failover walk, which excludes the whole
PROVIDER — so a broken model on a healthy provider would abandon its servable
siblings, precisely the per-model (RPD/TPM) mistake the model-scoped exclusion set
exists to avoid. The loop's handoff excludes the PAIR, so the pool is deeper, not
shallower. Chat's single-shot path IS covered directly (`failover-runner`, fix 1).

**8.2 Two of the three named polluted pairs are pruned; `gemini|allam-2-7b` is
not.** `isPairPlausible` decides from the id alone (an Ollama-style `:tag` on a
hosted provider; a fixture id). `allam-2-7b` needs a catalog to adjudicate whether
a provider serves that family, and a wrong exclusion silently removes a WORKING
model — the more expensive mistake. The honest route for that class is the one the
registry already has: `verified` should be earned from telemetry, and the empty/
failure write-through now actually records what the pair does. Left open on purpose,
with the reason visible rather than guessed at.

**8.3 One same-model retry is kept, and an empty parks the pair immediately.**
The recommendation said "switching on the first"; the loop retries the same model
ONCE and switches on the second consecutive empty. Rationale: a single empty
completion can be a transient blip at a shared endpoint, and the retry makes the
switch decision evidence-based rather than a coin flip — while the cap still bounds
the waste at one extra call per model (never 5). Park-on-first-empty is the same
trade at the registry: 120 s is the shortest window in the park table, it is
model-scoped, and a genuinely transient empty self-heals with no user action.

**8.4 The exhaustion report is wired on the chat surface only.** Chat (CLI,
dashboard and gateway, since all three run through `ChatCommand`) now ends a
failed turn with the measured report: models tried by name, absolute reset times,
the routing-gap-or-shortage verdict, and the levers only the user can pull — and
never a question. The gateway's own failure path still composes
`renderModelBreadthReport` (which names tried models, the parked ones with wait
lengths, and QUEUES an automatic retry, so it does not ask the user to retry
either). Unifying those two renderers is the next step, not part of this change.**8.5 Not done:** the score-inheritance detail of RC4 (a routing-history entry
records the DECISION's score, so a failover candidate's score reads like the
parent's) is mitigated by `fallbackFrom` being recorded on handoffs, but the
score
itself is still the decision's. A per-candidate score on the history entry is a
schema change with dashboard consumers, so it is left for a follow-up rather than
smuggled in.

---

## 9. P8 verification record (run 2026-10-06, on the uncommitted tree)

Order matters: `build:cli` runs BEFORE the docs guards, because a stale `dist`
makes a guard pass for the wrong reason.

| Gate | Command | Result |
|---|---|---|
| Root typecheck | `npx tsc --noEmit` | clean (no output) |
| Dashboard typecheck | `cd src/web-dashboard && npx tsc --noEmit` | clean |
| CLI build (fresh `dist`) | `npm run build:cli` | ok — `fix-esm-extensions: 505 files, 91 imports` |
| Root suite | `NPM_CONFIG_USERCONFIG=/dev/null npx vitest run` | **453 passed / 2 skipped files · 8269 passed / 19 skipped tests** (220 s) |
| Dashboard suite | `cd src/web-dashboard && npx vitest run` | **50 files · 1052 tests passed** |
| Command surface | `npm run docs:commands:check` | in sync |
| Provider wire | `npm run docs:wire:check` | 4/4 fixtures match the live loop |
| Doc citations | `npm run docs:citations:check` | 14 cited docs exist and are tracked |
| Command help | `npm run verify:commands` | **336/336** commands resolve |
| Dashboard bundle | `npm run dashboard:bundle:check` | inputs/outputs in the same commit |

The two skipped files are the live/network suites (`tests/live/*`), which skip by
design without credentials. Nothing in this change is verified by a skipped test:
every P1–P7 behaviour has a passing unit test named in §7.
