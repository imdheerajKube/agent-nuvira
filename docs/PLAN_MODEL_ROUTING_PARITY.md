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

Three findings in the original report were **wrong**, and all are recorded here because the same
mistakes are the ones the product makes:

- **C-1 — the OpenRouter detour was the investigator's error.** The pin
  `-p openrouter -m deepseek/deepseek-v4.1-flash` was chosen because that id appears in the registry
  **under `openrouter`**. It is the wrong provider for that model. *The system defect is not the pin
  — it is that the pin was accepted for a `never-verified` pair and answered with a 402 (A2/A3).*
- **C-2 — "flash ⇒ weak" is a name-based judgement, and the report made it.** The original P3 said a
  "flash-tier model" was the wrong pick for a complex build. It judged capability **from the model's
  name** — the exact defect it was reporting (B1). DeepSeek V4.1 Flash is a strong model; the
  product must measure capability, not read it off an id.
- **C-3 — one of the programme's OWN tests was measuring the developer's config (found 2026-10-07).**
  The D4 test asserted that the NLU `taskIntentHint` is load-bearing, and it passed on this machine
  only because the ambient capability mode was `balanced`. The hint reaches the ranking through a
  reasoning FLOOR, so under `max` — which already applies the same 0.7 floor — the hint's floor adds
  nothing, the two rankings are identical, and the test failed. It was not a routing regression and not
  a hint regression: the test never isolated its input. `tests/cli/model.test.ts` now pins
  `NUVIRA_CAPABILITY_MODE=balanced` in `beforeAll` and says why. Same trap the file already documents
  for the registry, one layer up.

## Severity

- **S1** — silently wrong outcome or unauditable behaviour. Fix before release.
- **S2** — wrong choice/cost, visible but not lying.
- **S3** — polish/consistency.

---

## Cluster A — Model identity & routability (S1, blocking)

Nothing else can be trusted until a model can be *named* and its *reachability* is consulted.

| # | Sev | Issue | Evidence | Fix | Acceptance |
|---|---|---|---|---|---|
| A1 | S1 | **The same model exists as unrelated registry rows.** `deepseek/deepseek-v4.1-flash` (openrouter, `unverified`) and `deepseek/deepseek-flash` (deepseek, `verified`) share no identity. | Registry dump, this session | **LANDED (Bundle 3d, option A — the declared alias table)** — `learning/model-identity.ts`: `identityKey`/`sameModel` widen the exact/bare-id rule by DECLARATION only (never by similarity), each entry carrying `declaredAt` + its evidence; wired into the funded-twin grouping, the pin-refusal sentence, `model explain` and `model list`. Identity still groups CAPABILITY only, never ROUTABILITY (two accounts, two truths — sharing health is what F6 exists to stop). | **MET**: the two rows are one model; `strictPinRefusal` names the funded twin (`deepseek/deepseek-flash`) for a dead `deepseek/deepseek-v4.1-flash` pin, and `model list` prints the opposite-verdict pair. `deepseek-v4-flash` vs `deepseek-v4.1-flash` stay separate — proven by test. |
| A2 | S1 | **A pin is not pre-flighted for routability.** A `never-verified`/`proven-dead` pair is attempted, and the failure surfaces as a provider error. | Run D: 402 after the pin was accepted | Consult the reachability verdict before the first call; refuse with the reason | **MET for a `proven-dead` pair** (Bundle 1c): the strict pin logs 0 × 402 and refuses before any request. A `never-verified` pair is still attempted on purpose — "nothing tried yet" is not a failure. |
| A3 | S1 | **`routable` is a dashboard view, not a gate.** `model-reachability.ts` mirrors `isUsable()` but routing/pins never ask it. | Module header states this | **LANDED for every pair the doctrine calls non-routable** (Bundle 1b/1c): auto routing filters its candidate pool through the registry (`getDefaultAllowedProviders`: blocked/degraded providers never scored) and the pinned paths consult `strictPinRefusal()` before the first call, so `deadPair`/`unavailable` verdicts are now gates, not displays. | A unit test proves an `unavailable` pair cannot reach a provider call — **MET**. The `never-verified` case is deliberately NOT gated ("nothing tried yet is not a failure" — see A2), so this acceptance's literal wording was too strong — it was corrected here rather than satisfied by gating a pair nobody has tried. |
| A4 | S1 | **Definitive provider failures are never written back.** OpenRouter's dead credits are recorded nowhere, so reachability cannot learn. | Registry: no 402/credit error on any openrouter row (before the fix) | **LANDED** (Bundle 1): `classifyFallbackError` buckets the live 402 body as `credit-exhausted` (before `auth`/rate-limit, because the real message also contains `max_tokens`), and `model-registry.recordCall` persists it as a **definitive, non-cooldown** state — `status: unavailable`, an error sentence naming the ACCOUNT not the model, `quotaParkedUntil: 0` — and `isEntitlementFailure` keeps that verdict through a catalogue listing (`markListed`) and a prune (`pruneAbsentModels`) (F6). | **MET**, live: after the observed 402 the pair reads non-routable; it is dropped from the ranked set (registry filter) and from the offered fallback chain (D6/Bundle 2a). |
| A5 | S1 | **Identity is reported per component, not per pair.** One turn reported 3 different models. | Run A: explain `gemini-3.1-flash-lite` / trace summary `groq` / debug header `deepseek-flash` | **LANDED** — the debug header was fixed by F2, the trace summary names the served PAIR (Bundle 2d), and the pipeline's housekeeping steps are now NAMED and no longer double-recorded (Bundle 2f) | A run's reported model is byte-identical across all three surfaces |
| A6 | S1 | **The auto chat path records no routing decision at all.** | Runs A/B/C: **0 rows** in `routing-history.json`; reproduced live with `-t` (Bundle 1c) | **LANDED** — the CLI was not auto-routing at all (F1). `execute` now honours `defaultProvider: "auto"`, so the turn goes through `routeMessageAuto` | A completed auto turn appends rows naming the served pair (2–3 genuine decision points per headless turn; 0 before) |

## Cluster B — Capability understanding (S1, root cause)

| # | Sev | Issue | Evidence | Fix | Acceptance |
|---|---|---|---|---|---|
| B1 | S1 | **Capability is inferred from id substrings** (`flash`/`lite`/`mini` penalised; `pro`/`70b` boosted). | `auto-router.ts` `getModelCapabilities()` | **LANDED (Bundle 3b)**: the id-substring block is DELETED, not capped — a capped name hint is still a name judgement. `getModelCapabilities` reads the measured scorecard (`learning/capability-evidence.ts`) with the provider baseline as the cold-start prior. | **MET**: `getModelCapabilities` returns the provider baseline for every id at zero samples (`flash` vs `flash-lite`, `72b` vs `1b`, unknown ids all object-equal). |
| B2 | S1 | **Static provider baselines outrank real evidence** (`openrouter: 0.95`, `gemini: 0.85`, `local: 0.30`). | Baseline table | Derive from measured per-pair outcomes; decay the statics | Ranking changes when measurements change; two providers with equal measurements rank equally |
| B2 (the MEASURED cause, found by the Bundle 8 live run) | S1 | **The reasoning tier was read from a SUBSTRING.** `estimateTaskRequirements` decided `reasoningNeed` with `desc.includes('hi')` — a substring of **this**/which/anything/nothing/crashing/architecture — so a `complex` ask containing the word "this" was rated as needing LOW reasoning, which set the weights to cost 0.30 / capabilityFit 0.15 and inverted `capabilityFit` to PREFER small models (a ~4B-active model scored **1.0**, cancelling the P6 active-width fix one line later). | `dist/`: the parity ask → `reasoningNeed 'low'`; **81 of 160** distinct tasks in `routing-history.json` rated `low`, **2** rated `high`, and **77** matched only the substring. Ranking: `gemini/gemma-4-26b-a4b-it` #1 at 0.9206. | **LANDED (Bundle 9)** — one exported `isSmallTalk` predicate in `hybrid-router.ts`, shared by both `estimateTaskRequirements` copies: whole-word greeting match, then the remainder must be punctuation and filler only. | **MET** (measured before/after on a rebuilt `dist/`): `low` **81/160 → 17/160**, `high` 2 → 5, substring-only matches 77 → 0; the live ask's #1 becomes `local/gpt-oss:120b-cloud` (cap 1.0) and the ~4B MoE falls to 0.6506 with cap **0.2**. |
| B2-a | S2 | **The audit trail's `score` does not describe the pair it is written against.** `cli/chat.ts` writes `score: decision.score` (provider-level) on EVERY row of a failover walk, so three different pairs share one number that matches no candidate's own score. | `routing-history.json`: gemini/`gemma-4-26b-a4b-it`, openrouter/`cohere/command-r7b-12-2024` and deepseek/`deepseek-flash` all `0.43836864406779663` — and NO candidate in the 431-model pool scores that. | **OPEN** — the field must carry the PAIR's measured score, or be absent. This is what misled Bundle 8's inference, so it is a correctness problem in the audit record, not cosmetics. | Ranking read from `routing-history.json` alone must agree with the pair that served |
| B3 | S1 | **No measured quality exists anywhere.** The registry tracks latency, tokens, error rate — never capability. | `ModelRegistryEntry`; and re-measured: the bandit ALREADY defines a quality reward (`BanditOutcomeData`) that the real path passes as `undefined` | **LANDED for the scorecard (Bundle 3b)**: `ModelRegistryEntry.capability` holds the five parameters with per-parameter sample counts, folded from real turns and calls, and the router reads them. Bundle 3a had already restored the bandit's quality reward (`recordOutcome` no longer discards its payload; the chat path feeds `verificationPassed`). **Still absent:** `testPassed`, `userAccepted`, a real `qualityScore`, and a measured feed for `cost`/`ecosystem`. **External ranking feeds assessed (§6):** the retired HF Open LLM Leaderboard, the shut-down Papers With Code and the unrelated Graphify repo are unusable, "DeepSeek Hermes" does not exist, and the one genuinely fitting feed is the keyless provider catalogue (`GET openrouter.ai/api/v1/models`) — external values may only ever be a labelled PRIOR for `accuracy`/`cost`/`ecosystem`, never the measured truth. | **MET**: a pair that consistently fails is demoted by measurement, not by name — `PRIOR_FULL_SAMPLES` unverified turns move `getModelCapabilities` below the floor. |
| B4 | S1 | **Max mode's reasoning floor is name-driven**, so it excludes real models and admits others arbitrarily. | `MAX_CAPABILITY_MIN_REASONING = 0.7` vs `flash`+`lite` = 0.65 | **LANDED (Bundle 3b)**: the floor is applied to measured accuracy; a cold pair is judged by its provider baseline (no name), and `PRIOR_FULL_SAMPLES` failing turns demote it. | **MET**: the `flash-lite`/`72b` fixtures that used to be floored by NAME are now eligible cold and floored by MEASUREMENT — asserted in both directions. |
| B5 | S2 | **Complexity is under-rated**: a 4-component full-stack app classifies as `moderate`. | **MEASURED directly** (not from `model explain`): the run-A parity ask against the built `dist/` rated `moderate` — its only matching keyword was `build`, a `moderate` word, because nobody writes "architect" when they write a requirements list. | **LANDED (Bundle 3e)** — `analyzeComplexity` now takes the HIGHER of two signals: the keyword ladder (vocabulary) and a measured BREADTH floor (shape: ≥ 3 enumerated requirement units spanning ≥ 3 distinct areas of work). | That prompt classifies ≥ `complex` — **MET** (measured `moderate` → `complex`), with four false-positive shapes pinned as unchanged |

## Cluster C — Context & execution discipline (S1/S2 — where the 2.85× gap lives)

| # | Sev | Issue | Evidence | Fix | Acceptance |
|---|---|---|---|---|---|
| C1 | S1 | **Context grows unbounded.** 128,482 chars / **1,192,115 input tokens** in one turn. | Run A trace | **RE-MEASURED — see the note below; the reading is wrong in the same way D5's was.** Deterministic compaction and a work digest already exist; neither ever FIRED in run A. The open item is the budget *policy*, not a missing mechanism. | A run of the same task stays within a stated input-token budget (measured baseline: a 82-step run peaked at 31,189 input tokens per step) |
| C2 | S1 | **Definitive failures are retried.** 3 Planner attempts against a 402. | Run D log | **LANDED** (see below) | A 402 consumes zero repair attempts |
| C3 | S2 | **Redundant rediscovery.** Version probes 3–4×; two `venv`s created (`/tmp/test/.venv` *and* `/tmp/test/backend/.venv`). | **CONFIRMED by line numbers** (see the note below): the same 3 facts probed as 1 combined + 3 individual invocations, and `python3 -m venv backend/.venv` issued at proxy-log lines 222 AND 232 | Reuse probe results; verify the write landed before redoing it | **LANDED (Bundle 4b)**: `tools/command-memo.ts` + `ToolContext.commandMemo` (one per run) — a pure probe or an idempotent setup command already answered in this run is answered from the memo (`↺ run_terminal: not re-run …`) instead of spawning; combined probes cover the individual facts they established; failures are never remembered and the consult sits after DENY, so it can never widen what may run. | **MET**: `tests/tools/command-memo.test.ts` (new, 24) — including a test that makes a genuine re-spawn observably FAIL (a directory replaced by a file) and shows nothing runs, and a REAL-loop test that both steps share one memo. The write-landed half is met for the measured setup commands; a duplicate `write_file` of identical content stays a non-goal. The live parity re-run is the remaining proof — see the section. |
| C4 | S2 | **Plan durability.** The report read it as "4 continuations; the plan is re-derived rather than carried". | Run A (12 `plan_todo` bursts), then the **experiment below** | **EXPERIMENT RUN — the reported mechanism is WRONG; a real, different defect is MEASURED in its place.** A step-bound continuation inside one turn does NOT re-derive the plan (the re-declaration is refused by the planner guard, tool-loop.ts:2196, and the store is carried unchanged). The actual defect is ACROSS TURNS: a plan re-declared in a later turn (a fresh loop resets the per-turn create counter) lands on `PlanStore.create`, which docs itself as *"Create (or REPLACE) the plan … a fresh declaration supersedes the old"* (plan-store.ts:213–226) — it resets every step to `pending`, discarding completed work (measured: revision 2 with `s1 done` ⇒ revision 3 with all three `pending`), and the model's turn-start context contains no trace of the plan it already has (the store is read only to answer "does a plan exist", tool-loop.ts:2465/2483, and for the turn report). | **LANDED (Bundle 4c)**: `PlanStore.create` carries a step's status + note when the goal is unchanged (by id, else by an identical normalized description) instead of resetting everything; a different goal is still a wholesale replacement; the `plan_todo` create result announces what it carried (`♻️ Carried N step(s) …`) and the model can explicitly put a carried step back to `pending`. | **MET**: measured before/after in `tests/tools/c4-plan-continuation.test.ts` (turn 2 reads `1/3 done` with the carried note where it previously read `0/3`, all pending) plus 6 new cases in `tests/tools/plan-store.test.ts`. **Still open:** the model is never SHOWN the plan it already has at the start of a turn — the store is read only to answer "does a plan exist" and for the turn report — which is the reason it re-declares at all, and is recorded as a residual, not fixed here. |
| C5 | S2 | **No context fit on model handoff** — the whole thread is handed over, which would overflow a smaller model. | `tool-loop.ts` handoff | Fit-to-window by dropping the oldest turns; never rewrite | Handoff to a small-window model never overflows |
| C6 | S3 | **Cost is not attributed per step in the user-facing output.** Total token burn is invisible until the trace is read. | Run A/B comparison | **LANDED (Bundle 4a)**: the turn report carries the spend read from the persisted ledger over the turn's own time window (`costSince` — a timestamp window, so a continuation or a resumed turn in a fresh process still reports its own), rendered as `💰 cost: $0.0234 / 1.19M tok (82 calls)`; a trivial-looking turn that spent ≥ `COST_NOTICE_USD` (1¢) gets a summary line of its own instead of staying silent. | **MET**: `tests/learning/turn-report.test.ts` (+5) — the measured run-A shape (1,192,115 tokens / 82 calls) reports, a half-cent chat answer does not shout, and a turn with no recorded call says nothing at all (absence is not "free"). |

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

### Re-measurement — C3 confirmed, C4 sharpened (the operational cost of run A)

Counted from run A's own artefacts — its debug log (`~/.nuvira/debug-logs/cli-chat-1791300903906.log`,
247 events) and the proxy log (`/tmp/nuvira-logs/runA.log`) — rather than re-read from the original
report, whose numbers nobody could check.

| Run A, measured | Value |
|---|---|
| LLM steps / tool calls | 82 / **119** (≈1.45 calls per step) |
| By tool | `write_file` 42 · `run_terminal` 37 · `plan_todo` 12 · `edit_file` 9 · `finding` 7 · `ask_user` 3 · `glob` 3 · `browser` 2 · `list_dir`/`delegate`/`tool_search`/`suggest_followups` 1 each |
| FAILED tool calls | **10 of 119** — `run_terminal` 9, `write_file` 1 |
| Input / output tokens | 1,192,115 / 2,462 (delivered answer 4,024 chars) |

**C3 — CONFIRMED, and sharper than the report had it.** The turn asked the SAME three facts twice: line
3 of the proxy log is one COMBINED probe (`python3 --version; node --version; npm --version`) and lines
4–6 are the same three probes issued INDIVIDUALLY — 4 invocations for 3 facts, in one turn. The venv
claim is also confirmed on both the log and the filesystem: `python3 -m venv backend/.venv` is issued at
line 222 and again at line 232, and `/tmp/test/.venv` **and** `/tmp/test/backend/.venv` both exist. So
"one probe per fact per run" is a real, countable defect — not a stylistic complaint.

**C4 — SHARPENED, deliberately not confirmed.** `plan_todo` was called **12** times, in bursts (2 at
15:35:46/48, six within 2 ms at 15:38:48, four within 1 ms at 15:42:27). Milliseconds apart means several
`plan_todo` calls inside ONE model response — the normal way the model declares steps — so this evidence
CANNOT distinguish "the plan was re-derived after a continuation" from "the model updated its own plan".
The original claim ("4 continuations; the plan is re-derived rather than carried") is therefore **not
established by what is on disk**, and the fix must not be designed from it. The experiment that would
settle it is stated here so it is not lost: run one turn that forces a continuation, and compare the
plan store's `revision`/step identities before and after — a re-derivation replaces the steps, a carry
increments the revision.

### The C4 experiment — the reported mechanism is wrong, a real one measured in its place

Run in-process, deterministically, through the REAL tool loop and the REAL plan store
(`tests/tools/c4-plan-continuation.test.ts`; log `/tmp/nuvira-logs/c4-experiment.log`), because the
artefacts on disk cannot answer the question the report was answering.

**A — a continuation inside one turn carries the plan; it does not re-derive it.** With `maxSteps: 1`,
`maxContinuations: 1`, the loop granted exactly one continuation (`continuations: 1`, `steps: 3`) and the
model's attempt to DECLARE THE PLAN AGAIN in the continuation step was **refused** by the planner guard
(`do NOT declare it again`), leaving the store untouched: ids `s1,s2,s3`, revision 1. So "the plan is
re-derived after a continuation" is **not** a property of the continuation path — the same thread is
kept and the harness explicitly refuses a second declaration.

**B — the defect is across TURNS, and it is worse than the report said.** Turn 1 declared `[s1,s2,s3]`
and marked `s1` done (revision 2, `s1 done`). Turn 2 — a fresh loop, the same per-session store, which is
what the tool's own description promises ("the table persists across the whole conversation AND across
sessions") — declared the same plan again. Measured result: revision 3 and **every step back to
`pending`**; the completed step was silently discarded. And the model could not have known better: the
first request of turn 2 contained **no trace of the existing plan** (`secondTurnSawThePlan: false`) —
the plan is never shown to the model, only the tool results the model itself produced earlier in the
turn.

So the mechanism is: **the per-turn create guard resets every turn + `create` replaces + the plan is
never shown**. The symptom the report described ("the plan is re-derived rather than carried") is real;
the cause it named (continuations) is not.

**C6 (per-turn cost) has a clean home now.** The turn report already exists and is rendered per turn; the
spend above shows why it belongs there — 1,192,115 input tokens for a 2,462-token answer is invisible in
the delivered output and only readable from the trace.

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

## Bundle 3a — the measured outcome reaches the reward (B3 PARTIAL)

**B3. The router had a measured-quality reward and threw the measurement away.** `RouterBandit`
carries `BanditOutcomeData` — `testPassed`, `userAccepted`, `verificationPassed`, `qualityScore` —
and `applyReward` folds all four into the reward for BOTH the provider arm and the per-model arm. But
`AutoModelRouter.recordOutcome` declared its payload as a three-field inline type (`latencyMs`,
`costUsd`, `qualityScore`) and then forwarded **`undefined`** to every arm, so the honesty fields had
no parameter to travel through and the reward reduced to a cost-adjusted coin flip on *"the agent did
not throw"* — the D2 defect one layer down.

**Two defects, one omission.** Fixing the type was not enough on its own:

1. **The parameter did not exist.** The payload type is now the bandit's own
   `Partial<BanditOutcomeData>`, forwarded intact to the provider and model arms. Without this no
   caller could have supplied the signal, whatever it knew.
2. **The chat path never recorded an outcome at all.** The orchestrator has fed the bandit for
   pipeline tasks all along; `answerOnce` — the CLI, the dashboard console and the gateway, i.e. the
   product's most common entry point — never did. So the router learned from ONE of its two execution
   models, and every chat turn's real result was discarded.

**The signal is derived, not narrated.** `learning/outcome-observation.ts` holds the single pure
mapping from `TurnReport.verification` (itself built from recorded tool/plan evidence) to the learning
payload, so the translation is one reviewable decision rather than a payload assembled per call site:

| Turn verdict | Learned as | Why |
|---|---|---|
| `verified` | success + `verificationPassed: true` | a change was made and observed |
| `unverified` | success + `verificationPassed: false` | the model DID answer; the reward model's own −0.08 for an unverified success is the calibrated weight. Booking it as a failure would penalise one event twice |
| `blocked` | **nothing** | a wall the run hit is not a capability verdict about the model |
| `not-applicable` | **nothing** | a plain answer with nothing to verify is not evidence; a neutral sample would dilute the real ones |

**Measured after.** `tests/learning/outcome-observation.test.ts` (+6) and one in
`tests/learning/auto-router.test.ts` that pins the forwarding: the same provider, same cost score and
same outcome, with and without a measured payload — **the reward is strictly lower with it**, which is
only true if the payload survives the call (it was `undefined` before).

**Honest residual.** `testPassed`, `userAccepted` and a real `qualityScore` are still absent, so the
reward is a coin flip on verification plus the cost adjustment — better, not complete. That is
`docs/DESIGN_CAPABILITY_BY_MEASUREMENT.md` §4 steps 2–4, waiting on the §7 sign-off. And this bundle
changes LEARNING only: no score, weight or routing order is affected until the scorecard lands.

## Bundle 4a — the turn states what it cost (C6 LANDED)

**The defect.** Run A spent **1,192,115 input tokens over 82 steps** and no surface said so: the only
figure anywhere was a session total, so one expensive turn was invisible and the ratio (484 input tokens
per output token) could not be seen. A cost you have to go and compute is a cost nobody watches.

**What landed.** `TurnReport.cost` — `{ usd, tokens, calls }` — read from the PERSISTED ledger over the
turn's own timestamp window (`costSince`), taken before the first provider call. The window is a
timestamp, not a counter, so a continuation or a resumed turn in a fresh process still reports its own
spend. It renders as `💰 cost: $0.0234 / 1.19M tok (82 calls)` in the console close-out block, and joins
the summary line when the turn did work. (Live, a cheap turn prints nothing — see the 1¢ rule below;
that silence is the design working, not the feature missing.)

**One deliberate judgement.** A cheap turn that did nothing stays silent, because a cost line on every
reply is noise — the opposite of making spend visible. The exception: a trivial-LOOKING turn that spent
at least `COST_NOTICE_USD` (1¢) gets a line of its own, since a long prompt on an expensive model is
exactly the expense nobody sees. Absence of a ledger entry produces NO cost field at all: `$0.000000`
would claim the turn was free.

## Cluster F — a payload that does not fit (found live in the dashboard traces, 2026-10-07)

Not on the original 34-defect list: found by reading the last ten dashboard-chat session logs after the
user reported "some serious bug is there".

| # | Sev | Issue | Evidence | Fix | Acceptance |
|---|---|---|---|---|---|
| F1 | **S1** | **A tool call whose ARGUMENTS never arrived is parsed to `{}` and EXECUTED.** The wire layer's defensive `JSON.parse(raw \|\| '{}')` turns "the payload was cut off" into a valid-looking call with no arguments; the loop then runs it, the model is told `write_file: path is required` (the WRONG cause), and nothing offers a way to deliver a payload larger than one model output. | Two of the last ten dashboard sessions, same ask ("deliver complete document" / "retry"): **`write_file` 75 EMPTY calls** (`cp-a7d0878f9953`, 09:59, 81 steps) and **59 EMPTY calls** (`cp-ab3949f5cc0c`, 10:52, 81 steps, 15 min, `bounded: true`, **no document**); 73 of that turn's 81 calls arrived empty. The model diagnosed it itself ("my calls were emitted empty") and retried the identical call 59 times. | **LANDED (Bundle 6)** — see below | A call whose arguments did not arrive is REFUSED (never executed as `{}`), the refusal names the real cause (quoting `finish_reason: "length"` when the provider said so) and the sectioned-delivery alternative, and after three the loop spends ONE bounded nudge on the strategy |

## Cluster G — the attached folder (found live, 2026-10-07, while the user was blocked on it)

Not on the original 34-defect list either. Reported verbatim, mid-session: *"if this attach folder is not
able to handle by agent ( as it is very strangely misbehaving … this is a brutal failure agent keep
refusing even after i attach the folder and working was pathetic , it appears we degrated this agent by
our latest changes atleast it was genuine working fine ( except it was facing issues in running command
terminal etc )."* The suspicion was a regression. **It is not a regression** — it is four independent
defects in one area, three of them older than the recent work, and the fourth (the empty-folder wording)
introduced by the P3 project-context feature itself.

| # | Sev | Issue | Evidence | Fix | Acceptance |
|---|---|---|---|---|---|
| G1 | **S1** | **An attached folder that is EMPTY reads to the model as "no project is attached".** The whole description of the workspace was `Files: 0` + `(no source files)`, so the model asked the user to attach a folder that was already attached. | `cp-a7d0878f9953` (goal "retry", cwd `/Users/dheeraj/Documents/Design Doc`, 81 steps) — the model's OWN reasoning at step 1: *"The project context is 'Design Doc' with 0 files"*, then two `ask_user` calls and *"the project shows as empty (0 files)"*; the user's unblock sentence in the transcript: *"folder is attached continue to finish the task"*. | **LANDED (Bundle 7)** | The context's first line is `Workspace: ATTACHED — <path> is this chat's project`, and an empty folder says in words that empty is a normal START and that the model must not ask for a folder it already has |
| G2 | **S1** | **A folder the CHAT already attached was forgotten by the server.** The composer re-sends `projectPath` from React state only, and re-attaching after a resume is async/best-effort — so a reload mid-conversation, or an attach whose response the UI never received, left the server folder-less while the conversation still had one. Every turn after that got "I need a project folder". | `server.ts` computed the workspace from `body.projectPath ?? dashboard.cwd` and **never read the session's stored `projectPath`**; `chat-sessions.json` shows 20 conversations carrying a `projectPath` the request may not resend; `ChatPage.tsx` keeps a manual "re-attach" fallback button precisely because the automatic path can fail. | **LANDED (Bundle 7)** — `resolveTurnWorkspace` consults the session, after the request and before anything else | The test drives turn 1 WITH a path and turn 2 without one, and turn 2 runs instead of refusing |
| G3 | **S1** | **A folder the user NAMED in the message was thrown away.** `needsProjectAttachment` already treats a typed absolute path as "the user is being specific, do not ask them to attach anything" — and then discarded it instead of running there, so the user's own words could not scope the turn. | The guard's early return: `if (/(?:^|[\s("'`])(?:\/|~\/|https?:\/\/|www\.)/.test(text)) return false;` — then `server.ts` built the workspace from `body.projectPath`/`dashboard.cwd` only. | **LANDED (Bundle 7)** | `create the app in /Users/me/proj` runs with `workspaceSource: "message"`, and the folder is attached to the chat so the next turn keeps it |
| G4 | **S2** | **An unscoped turn could write into the dashboard PROCESS's own directory.** An ask with no project noun and no file noun slips past the turn guard (it must — gating prose was an earlier bug), so it ran, and `ctx.cwd` fell back to the directory the dashboard was started from — a deployment directory that belongs to nobody asking the question. | `chat.ts`: `const turnScope = ctxOverrides?.projectPath \|\| process.cwd()` reached `ToolContext.cwd` unconditionally. | **LANDED (Bundle 7)** — a write in an unscoped turn refuses with an ASK (where should it go?), and a folder the user then names in their reply is adopted | `write_file`/`edit_file` in an unscoped turn create nothing, in either the server cwd or anywhere else; the reply's directory becomes `ctx.cwd` and the retry lands inside it |

## Bundle 6 — a call whose arguments never arrived (F1 LANDED)

**What the traces showed.** The two most recent turns that asked for a deliverable are the same ask twice
(the user retried because the first failed). Measured from their step checkpoints:

| Trace | Steps | Calls that arrived EMPTY | Outcome |
|---|---|---|---|
| `cp-a7d0878f9953` — goal "retry", 09:59 | 81 | `write_file` **75** | no document |
| `cp-ab3949f5cc0c` — goal "yes deliver complete document", 10:52 | 81 (164 events, 16 min) | `write_file` **59**, `run_terminal` 14, `code_execution` 2 | `bounded: true`, 583-char answer, no document |

In the second one the six calls that DID carry arguments were trivial (`read_file`, `list_dir`, a
`write_file _probe.md` with 5 bytes of content) — every call that had to carry the DOCUMENT arrived empty.
The model reasoned its way to the right diagnosis on its own ("Root cause: my `write_file` calls were
emitted empty — I never actually passed the `path` and `content` arguments") and still could not recover,
because there was no way to say it: the tool only overwrote, and no surface told it to build the file in
sections.

**The two lies.**

1. `src/inference/tools.ts` (streaming and one-shot) and `src/inference/native-tools.ts` parsed the
   arguments with `JSON.parse(raw || '{}')` and a bare `catch { args = {} }`. A truncated or absent
   payload became a valid empty argument object, so the CALL looked real.
2. The loop then executed it, so the accounting (successful calls, mutations, verification) and the
   model's own feedback both described a call the model never really made.

**What landed (Bundle 6).**

- `ToolArgumentsError = 'empty' | 'unparseable'` on the parsed tool call plus `finishReason` on the
  response (`inference/interface.ts`); `parseToolCallArguments` is the one shared parser (exported from
  `inference/tools.ts`, used by the streaming and one-shot paths, and by `native-tools.ts` for the
  Anthropic wire), so the answer to "did these arguments arrive?" is produced once and reported, never
  swallowed.
- The tool loop REFUSES such a call before execution: `Error: <tool>: NOT run — the call arrived with NO
  arguments at all … Reason: the provider stopped this step at its output-token limit (finish_reason:
  "length")… Send the payload in PIECES instead of one call: `write_file` the FIRST section, then call
  `write_file` again with mode:"append" for each further section … Do NOT re-send this call unchanged`.
  `Error:`-prefixed on purpose — the call did not run, and the loop's honest accounting keys on that.
- After the THIRD such call in a turn, one bounded nudge (`malformed-call` gate) states the delivery
  strategy outright, instead of a fourth identical error.
- `write_file` gains `mode: "overwrite" | "append"` (the missing affordance): section one creates the
  document, every later section appends, and the deliverable is still ONE file. Its description and schema
  now say that a single oversized call cannot be delivered at all.
- The forked subagent's own loop (`child-agent-runtime.ts`) refuses the same way, with the same words — a
  delegated run must not be able to execute the call the parent just refused.

**Why the payload never fit (measured on this machine).** Every configured provider carries
`maxTokens: 4096` (`~/.nuvira/nuviraconfig.json` — nim, openrouter, groq, bedrock, local; gemini 8192).
4096 output tokens is roughly 3,000 words, while the draft the model was extending was already 241 lines
and the ask was to add seven more sections. So the truncation was STRUCTURAL, not a model slip: no prompt
could have delivered that document in one call, and the only correct harness response is to make the
sectioned path the obvious one — which is what `mode: "append"`, the refusal text and the nudge now do.

**Honest residual.** The JSON-fallback transport (a model asked to emit the tool call as text) and the
Gemini wire (whose function calls carry structured `args`, so "empty" is ambiguous) are not covered; the
live re-run of the failing ask ("deliver the document", now in sections) is the remaining proof; and
one smaller observation from the same ten traces is recorded but NOT fixed — the question of whether a
document-delivery turn should get a larger output budget than 4096 tokens (a cost decision, not a bug).
The other one, the provider-label mismatch, is **LANDED (Bundle 2h)** — see below.

## Bundle 2h — the log says which pair ANSWERED, and which was ASKED FOR (A5/D3's last face, LANDED)

**The measurement.** One of the ten dashboard traces opened with
`# backend.provider: local` / `# backend.model: qwen2.5:0.5b` / `# backend.transport: json` and its very
first event read `turn.start {"provider":"gemini"}`. Neither value was computed wrongly, which is why
this survived the A5/D3 work: the HEADER is written at close from `lastAttempt` (so it names the pair that
ACTUALLY served — the local model, whose 169,165-char answer is in that same log), while `turn.start`
named the pair the turn was CONFIGURED with, before the provider walk had run.

**Why that is still a defect.** A lone `provider` key inside an event called `turn.start` reads as "the
turn started on gemini", and a bug report is read by people, not by the code that wrote it. The two fields
asked different questions and used the same word for the answer.

**The fix.** Each field now says which question it answers:

- `turn.start` carries `requested` — the pair the surface resolved (`gemini/gemini-3.1-flash-lite`).
- `turn.end` carries `served`, computed from the SAME expression the header is given (`servedProvider` /
  `servedModel`, both taken from `lastAttempt ?? session`), plus `requested` only when it differs. So a
  reader can tell a straight run from a failover without cross-referencing the header, and the header and
  the event stream can no longer drift — the drift was possible only because one fact was computed twice.

**Measured / verified.** Full root suite **462 passed | 2 skipped, 8453 passed | 19 skipped, 0 failed**;
`tests/observability tests/cli tests/parity` **69 files / 875 tests**; `tsc --noEmit` clean; `build:cli` +
the four docs guards + `verify:commands` (336/336) + `dashboard:bundle:check` green. New test in
`tests/observability/debug-log.test.ts` (+1) writes the log exactly as `cli/chat.ts` does and pins the
contract: the header's provider equals the event's `served`, and the misleading shape
(`turn.start {"provider": …`) is asserted ABSENT.

**Honest residual.** The existing ten traces on disk still read the old way; only new turns carry the
labels. And the child agent's own log event (`child-agent-runtime.ts`) records `{ tools, transport }` with
no provider at all, so it never had this mismatch to fix.

## Bundle 9 — the reasoning tier was read from a SUBSTRING (B2's real root cause, LANDED)

**Bundle 8 recorded a conclusion this bundle disproves, so it is corrected here rather than left
standing.** Bundle 8 concluded that B2's defect was "with equal priors the ranking carries NO
information". The measurement behind that claim was itself read wrong: `0.43836864406779663` is **not** a
model-level candidate score. It is `decision.score` — the provider-level score — and `cli/chat.ts` writes
that SAME value onto every row of a walk (`recordRoutingDecision({ …, score: decision.score })` at both
call sites). The three rows were equal because they were one number copied three times, not because three
models tied. The model-level pool was never a tie: recomputed for the same ask at `complex`,
`gemini/gemma-4-26b-a4b-it` scored **0.920624**, `openrouter/cohere/command-r7b-12-2024` **0.77**,
`deepseek/deepseek-flash` **0.597148**.

**What actually chose the model.** `estimateTaskRequirements` decided `reasoningNeed` with
`desc.includes('hi')`. `'hi'` is a substring of **this**, which, anything, nothing, shift, crashing,
architecture, graphify — and the ask contains the word "this" ("…**this** will work as a model facilitator…").
A task the router had just graded `complex` was therefore graded as needing **low** reasoning, which in
`buildModelCandidates` does two things:

| consequence | `reasoningNeed: 'low'` | `reasoningNeed: 'high'` |
|---|---|---|
| the weights | cost **0.30**, capabilityFit **0.15** | cost 0.10, capabilityFit **0.40** |
| `capabilityFit` for a ~4B-active model | **1.0** ("prefer small/fast") | **0.2** |

The second row is why the P6 active-width fix looked ineffective: it correctly read
`gemma-4-26b-a4b-it` as ~4B ACTIVE and capped it at 0.2 for a high-stakes ask, and the `low` tier set it
back to 1.0 one line later. (The same `low` also neutralised `costPriority`, which the ask trips on the
word "free" — with high stakes the cost weight is 0.10 regardless.)

**Blast radius, measured against a freshly built `dist/` over the local routing history**
(`~/.nuvira/memory/routing-history.json`, 160 distinct tasks):

| | before | after |
|---|---|---|
| `reasoningNeed` `low` | **81** (51%) | **17** |
| `reasoningNeed` `high` | **2** | **5** |
| tasks where the substring `hi` fired but the whole WORD did not | **77 / 160** | 0 |

**Ranking of the same ask, before → after** (431 candidates, fresh `dist/`):

| rank | before | after |
|---|---|---|
| #1 | `gemini/gemma-4-26b-a4b-it` 0.9206 (cap **1.0**) | `local/gpt-oss:120b-cloud` 0.9615 (cap 1.0) |
| #2 | `local/qwen2.5:0.5b` 0.9006 | `groq/openai/gpt-oss-120b` 0.8935 |
| #3 | `gemini/allam-2-7b` 0.9000 | `local/deepseek-coder:latest` 0.7561 |
| the live run's first pick | **#1**, cap 1.0 | 0.6506, cap **0.2**, out of the leading group |

**The fix.** `learning/hybrid-router.ts` gains ONE exported predicate, `isSmallTalk`, and both
`estimateTaskRequirements` copies call it instead of three `includes()` tests. It asks the right question —
not "does it contain a greeting word" but "is there nothing here but a greeting and pleasantries": the
greeting is matched on whole words (`\b`), removed, and what REMAINS must be punctuation and filler
(there, thanks, how, are, you, ok, …). `"hi"` and `"hello, how are you?"` → true; `"hi, build me a RAG
pipeline"` → false (a real ask that opens politely, which the old rule would have demoted); `"this will
work"` → false. It lives in `hybrid-router.ts` because both routers already depend on that module, and
because the two copies had ALREADY drifted apart on other phrases — one home is how they stop.

| Item | What changed | Tests | Status |
|---|---|---|---|
| **B2 (Bundle 9)** | `learning/hybrid-router.ts`: new exported `isSmallTalk` (whole word, whole message); `learning/model-first-router.ts` + `learning/model-scoring.ts`: `estimateTaskRequirements` use it in place of `desc.includes('hello') \|\| desc.includes('hi') \|\| desc.includes('greeting')`. | `tests/learning/hybrid-router.test.ts` (+4: recognises bare greetings, rejects the eight measured false positives, rejects a real ask that opens politely, does not treat `ok` as small talk); `tests/learning/router-scoring-truthfulness.test.ts` (+5: the live ask is `high`, the measured strings keep their complexity-implied tier, `hi` is still `low`, the MoE stays ≤ 0.2 on the live ask and ranks BELOW `gemini-3.1-flash-lite`, and the two `estimateTaskRequirements` copies agree) | **LANDED**, measured before/after against a rebuilt `dist/` |

**Residual found while correcting this — OPEN, and it is a TRUTHFULNESS defect, not a routing one.**
Because `cli/chat.ts` records `score: decision.score` on every row of a walk, the audit trail attributes
one provider-level number to models that never had it — the live rows show three different pairs sharing
`0.43836864406779663`, a value that matches NO candidate's model-level score. An audit reader cannot tell
from `routing-history.json` why a model was chosen. The field must either carry the PAIR's own score or be
absent ("no guessed value may be written into an audit record"). Recorded as B2-a below.

## Bundle 8 — the live re-run of the user's own ask (measured, not inferred)

**What was run.** The user's own large routing-design ask (the one from the transcript), against his
project folder's contents copied to `/tmp/g-live-routing`, driven through the built CLI:
`node dist/index.js chat "$(cat task.txt)"`. His `Router_Design.md` was left untouched — the run states so
itself ("Both existing design docs were left untouched"), and the copy is why.

**It delivered**, in **4m16s** (09:11:23 → 09:15:39), 36 model calls, two bounded continuations
(1/4, 2/4), 66 log events, and its own verification: it wrote `ai-router/router_core.py`, ran it
(`EXIT=0`), and confirmed each requirement against that run — entitlements, the
`(account_id, provider_model_id)` identity, the cross-provider spend cap, `sync_catalog` change events,
and the capability ingest.

**Three results that only a live run could produce.**

| # | What was measured | Why it matters |
|---|---|---|
| 1 | **B5 is confirmed live, not just in a unit test.** `routing-history.json` for this exact ask records `complexity: "complex"`, where the pre-fix ladder rated the same text `moderate`. | The fix that was measured in a script and a test also fires on a real turn through the real router. |
| 2 | **The A5/D3 log-label fix is confirmed live.** The header reads `backend.provider: deepseek` / `backend.model: deepseek-flash`, the first event is `turn.start {"requested":"gemini/gemma-4-26b-a4b-it"}`, and the last is `turn.end {…,"served":"deepseek/deepseek-flash"}`. | The header and the events now agree, and a reader can see the failover from the log alone. This is the exact mismatch that was reported (header `local` vs `turn.start gemini`) — same shape, now labelled. |
| 3 | **B2's defect is now MEASURED rather than inferred.** Every row of the walk carried the IDENTICAL `0.43836864406779663` (gemini/`gemma-4-26b-a4b-it`, openrouter/`cohere-r7b-12-2024`, deepseek/`deepseek-flash`), and a task the router itself had just labelled **`complex`** was fed FIRST to **`gemma-4-26b-a4b-it`** — a small model — reaching `deepseek-flash` only after gemini failed twice (a timeout, then `Gemini tool-calling API error (500)`). | The two halves of this observation had two different causes, and Bundle 9 separates them: the repeated number is `decision.score` copied per row (an audit defect), while the WRONG FIRST PICK is `reasoningNeed: 'low'` from `desc.includes('hi')` matching the word "this" (the routing defect, now fixed). The inference drawn here in Bundle 8 — "the ranking carries no information, so a `complex` task is routed by tie-break" — was WRONG: the model-level scores were 0.9206 / 0.77 / 0.597148, i.e. ordered, just ordered wrongly. |

**A console-truthfulness defect found by the same run, and fixed here.** The progress line printed
`⚙ write_file({confirm: true})` five times and `⚙ edit_file({allow_multiple: false})` four times. Both
calls were COMPLETE — `summarizeArgs` took the FIRST key the model emitted, which is a boolean default,
so WHICH FILE was invisible; a line naming `confirm` reads as if the agent were confirming something it
never wrote. It now prefers the identifying field (`IDENTIFYING_ARG_KEYS`), falling back to the first, and
is exported so the preference is pinned by a test. (I checked the step checkpoint before believing the
console: 31 of 36 calls carried full argument sets, and the single argument problem was an `unparseable`
`plan_todo` that F1 already refuses — so the preview was the defect, not the calls.)

**Honest residual.** The run also shows the step bound still binding: two continuations totalling 85 steps
for a 1151-character ask, and the delivered answer is a *reference implementation* — it ships seeded
capability scores and a sample raw table, and says so. The routing history still writes a paired
`complexity: "unknown"` row beside each resolved one, which is defensible (D5's rule) but makes the file
harder to read than it needs to be.

## Bundle 3e — an ask's SHAPE counts, not only its vocabulary (B5 LANDED)

**The defect, measured rather than inferred.** B5's evidence line said "`model explain` baseline"; the
machine says something simpler and worse. Against the built `dist/`, the run-A parity ask — *"Build a
knowledge base web app where users can: upload documents … automatically extract embeddings (FAISS or
Milvus) … query the knowledge base using an LLM … view results in a React dashboard"* — rated
**`moderate`**, because the ONLY keyword that matched was `build`, a `moderate` word. `/architecture|architect|
design system/`, the `complex` trigger, never appears: nobody writes "architect" in a requirements list.

**The fix.** `analyzeComplexity` now takes the HIGHER of two signals, and only ever raises:

1. **Vocabulary** — the keyword ladder, unchanged and extracted to `complexityFromKeywords`.
2. **Shape** — `measureTaskBreadth`: the count of enumerated requirement UNITS × the count of distinct
   AREAS of work, floored at `complex` when `units ≥ 3 && areas ≥ 3`.

Both halves are deliberate:

- **Units** split on the separators that structure a request (a colon introducing a list, semicolons,
  newlines, bullet/numbered markers) and never on `and` or a comma. "PDF, TXT, Markdown" is ONE
  requirement with three file types, and counting it three times is the inflation this threshold exists
  to avoid.
- **Areas** are twelve coarse buckets (ingestion / embeddings / generation / retrieval / frontend /
  backend / persistence / auth / realtime / testing / deploy / integration). The question is "how many
  different KINDS of work", not "how many words are in my list" — a fine-grained set would start scoring
  synonyms as subsystems.
- **Both bars, not one.** Measured at `areas ≥ 4` first, then loosened to `≥ 3`: the stricter bar missed a
  second four-component ask (Stripe + Postgres + email receipts + a React dashboard — 5 units, exactly 3
  areas), and every false-positive shape has 1–2 units, so the looser area bar costs nothing.
- **It cannot reach `critical`.** Breadth establishes SIZE; `critical` is about urgency and blast radius,
  which size alone does not imply.

**Before / after — measured with the built `dist/` (before = the shipped build, after = the rebuilt one).**

| Ask | Before | After |
|---|---|---|
| run-A parity ask — upload / embeddings / LLM query / React dashboard | `moderate` | **`complex`** |
| invoicing tool — Stripe payments / Postgres / email receipts / React dashboard | `moderate` | **`complex`** |
| 3-part CLI — read a CSV; print a summary table; write a JSON file | `moderate` | `moderate` (4 units, 0 named areas) |
| one requirement that lists three file types (`PDF, TXT and Markdown uploads`) | `moderate` | `moderate` (1 unit) |
| two units (`build a login page; add an email notification`) | `moderate` | `moderate` (2 units, 3 areas) |
| ordinary multi-tech (`build a todo app with React and localStorage`) | `moderate` | `moderate` (1 unit) |

**Measured / verified.** Full root suite **462 passed | 2 skipped, 8452 passed | 19 skipped, 0 failed**;
focused `tests/learning tests/inference tests/tools tests/cli tests/agents` **300 files / 5473 tests**;
`tsc --noEmit` clean; `build:cli` + all four docs guards + `verify:commands` (336/336) +
`dashboard:bundle:check` green. New tests in `tests/learning/hybrid-router.test.ts` (+5): the measured
ask rates `complex`; the breadth measurement is asserted directly (units, areas, and the area NAMES)
so the level can never be asserted blindly; a listed-but-not-enumerated ask is one unit; the four
false-positive shapes stay `moderate`; and a `critical` ask is never talked DOWN by its size.

**Honest residual.** The area list is coarse by construction, so a genuinely four-component ask that
names no vocabulary from all three buckets can still land at `moderate` (the 3-part CLI row above is
exactly that, and `moderate` is the right answer for it). A measured area set — derived from what real
runs touched — would replace the hand-written twelve, and is the same "measured wins" step B2 still
needs.

## Bundle 7 — a workspace the user gave us is a workspace we use (Cluster G LANDED)

**The user's own design, which is what landed** (verbatim): *"we can gently ask before file write if
folder is not attached and as user gives folder either path via chat or in above browse and select we can
use it … if default folder is there - configured 0 - proceed with waring as project folder not attached
creating a folder or file in default folder."* Each clause is a row below.

**Where it lands.** All four defects live in ONE decision — "what workspace is this turn about?" — so
that decision now exists in exactly one tested place, and the call site only carries it out:

- **`src/utils/workspace-path.ts` (new)** — the pure rules both a SURFACE and a TOOL need:
  `isUsableDirectory`, `normalizeWorkspacePath`, `directoryFromMessage`. It lives in `utils/` rather than
  beside either user because it has two; a tool importing the dashboard would invert the dependency
  (`src/tools` is also driven by the CLI, the SDK and the child agent).
- **`src/web-dashboard/workspace-resolution.ts` (new)** — `resolveTurnWorkspace` (the priority order and
  the notice each source carries) and `formatWorkspaceNoticeText` (the caption the surface shows).

**The priority order, and why each step is where it is.**

| Order | Source | Why it wins where it does |
|---|---|---|
| 1 | `attached` — the path the request carried | The user picked it THIS turn. No notice: the user's own folder needs no caption. |
| 2 | `session` — the folder this conversation attached earlier | **G2.** The composer only re-sends from React state, so a reload or a failed re-attach drops it. The server can still read it back, and a folder the chat attached IS the chat's workspace. |
| 3 | `message` — a directory in the user's own words | **G3.** Only an ABSOLUTE path (or `~/…`) that is an existing DIRECTORY. A relative path is refused because resolving it needs a base, and the only basis for choosing one is `process.cwd()` — the exact guess behind the older "it went to kuttaaddon" report. A path that names a FILE is refused too: a path in a message is usually the file the user is talking about, and adopting its folder would silently relocate the turn. |
| 4 | `default` — the operator's `dashboard.cwd` | **The user's "proceed with warning" clause.** It is a real workspace, so the turn runs — but it is not the user's project, so the turn is TOLD so and the surface shows a caption. |
| 5 | `none` | **G4.** No workspace at all: the turn is marked `unscoped` and a write asks where the file goes. |

**The empty folder (G1), which is the measured cause of "keeps refusing".** `formatProjectText` now opens
with `Workspace: ATTACHED — <path> is this chat's project. Create and edit files INSIDE it.`, and when
`fileCount === 0` it adds, in words: *this folder is ATTACHED and EMPTY … create the files the user asks
for HERE … do not tell the user that no project is attached, and do not ask them to attach one — one is
already attached at the path above.* Reproduced before the fix against the real fixture: the entire
context for an empty attached folder was three lines ending `0 file(s) · 0 symbol(s)`.

**The write with no workspace (G4) is an ASK, not a refusal.** `ToolContext.workspaceUnscoped` (set by
`chat-console.ts` → `cli/chat.ts` from the server's resolution) makes `write_file`/`edit_file` return the
`confirmFirst`-shaped message: nothing was written, here is the `ask_user` to make, here are the three
answers that are honoured, and *do NOT say the file was created*. It is checked BEFORE the path gate so
the model gets the actionable message rather than a boundary denial about a directory nobody chose. Then:

- a folder the user names in their REPLY is adopted by `ask_user` itself — `ctx.cwd` moves and the flag
  clears, exactly as `clone_repo` moves `ctx.cwd` after it clones, and the result says the retry will now
  work. That is the user's "as user gives folder either path via chat … we can use it".
- **a deadlock had to be closed for it to work at all.** "Which folder should I create the app in?"
  reads to the permission-seeking heuristic like a permission question, and G13 suppresses those when the
  request already authorized the work — so the user would never be shown it, no folder would ever be
  named, and every retry would fail identically. That is the reported loop, in code. A missing workspace
  is a required INPUT, not a decision the model may take on the user's behalf, so the suppression now
  stands down while `workspaceUnscoped` is set.

**Highlight it (the user's clause, and the frontend half).** The response carries `workspaceNotice`,
`workspacePath` and `workspaceSource`; `ChatPage` shows the notice as a dismissable `📁` banner beside
the routing notice, and ATTACHES the resolved folder so the composer chip highlights what the turn
ground in. Without the attach the chip stayed empty and the next turn would ask for the folder again.

**What this bundle does NOT change.** The turn-level ask for a READ-a-project ask ("assess this
project") stays: with no workspace there is genuinely nothing to read, so asking before the turn is
cheaper and kinder than asking mid-turn. And the per-turn decision is still deny-first — a write never
lands outside the resolved workspace.

**Measured / verified.** Full root suite **462 passed | 2 skipped, 8447 passed | 19 skipped, 0 failed**
(was 460/8419; +2 files, +28 tests); dashboard suite **50 files / 1052 tests**; both `tsc --noEmit`
clean; `build:cli`, `docs:commands:check`, `docs:wire:check`, `docs:citations:check`, `verify:commands`
(336/336) and `dashboard:bundle:check` green (the bundle was rebuilt). New/added tests:
`tests/web-dashboard/workspace-resolution.test.ts` (new, 13), `tests/web-dashboard/project-context.test.ts`
(+3), `tests/web-dashboard/chat-api.test.ts` (+3), `tests/tools/unscoped-workspace.test.ts` (new, 9).

**Honest residual.** The live re-run — attach an empty folder in the dashboard, ask for a file, and watch
the turn run rather than ask — is the remaining proof, and needs the rebuilt `dist/`. And the notice
banner is a frontend addition that the browser smoke walk does not yet assert.

## Bundle 4b — one probe per fact per run (C3 LANDED)

**The defect, measured by line number.** Run A's proxy log asked the SAME three facts twice inside one
turn: line 3 is ONE combined probe (`python3 --version; node --version; npm --version`) and lines 4–6
are the same three issued INDIVIDUALLY — four shell invocations for three facts. The same run issued
`python3 -m venv backend/.venv` at lines 222 AND 232, and both `/tmp/test/.venv` and
`/tmp/test/backend/.venv` exist on disk. Every repeat costs a round trip, a tool slot in the context
window (the currency of the 2.85× gap), and a step of the model's attention on a question it already had
answered.

**Why the harness must fix it, not the prompt.** Across a long thread the model cannot be relied on to
remember what it ran — that is what a context window is for, and prompts get trimmed. The harness CAN:
it is the thing that ran the command and holds its output. So the discipline lives in the tool layer.

**What landed.** New `src/tools/command-memo.ts` (pure) plus its wiring:

- `splitCommandChain` decomposes a chain on `;` / `&&` / newline and REFUSES anything with a pipe
  (including `||`), a redirect, a substitution, a subshell or a glob — refusing is always safe, the
  command simply runs as before;
- `commandMemoKind` classifies a part as `probe` (`node --version`, `which uv`, `pwd`, `uname -a`) or
  `idempotent` (`python3 -m venv <dir>`, `mkdir -p <dir>`, `touch <file>`) and returns `null` for
  everything else;
- `lookupMemo` answers "this exact command again" and "this fact was already established by SOME command
  this run" — the measured shape (one combined probe, then the facts individually). A hit requires EVERY
  part of the incoming command to be covered by the SAME earlier command, so two separate one-fact runs
  can never be glued into one reply as if a single run had produced them;
- `ToolContext.commandMemo` carries the memo; the tool loop creates ONE per run
  (`context.commandMemo ?? createRunCommandMemo()`), so its lifetime is the run's and nothing is written
  to disk — the next run sees the workspace with fresh eyes;
- `run_terminal` consults the memo after the DENY check and returns the earlier output with a leading
  `↺ run_terminal: not re-run — …already answered in THIS run by \`<cmd>\`` instead of spawning, and
  stores the result of a SUCCESSFUL run (whole command + every fact it established).

**Three deliberate judgements.**

1. **The consult sits after DENY and before every other gate.** The memo only ever holds commands that
   ALREADY ran successfully in THIS run under these same gates in this same context, so there is nothing
   left for the confirm gate to decide — and a memo hit can never stand in for a command that would have
   been refused, because a refused command was never stored.
2. **Never memoized, each for a reason:** `npm`/`pip install` (repeating is harmless, SKIPPING is not — a
   second install after a manifest edit is exactly when it is needed, and the tool cannot see the
   difference); `git add`/`cp`/`mv`/`rm` (they interact with files created in between, so the second call
   is not the same question); a bare `mkdir` (it FAILS on the second call — memoizing would turn an error
   the model may be relying on into a silent success); anything composed or globby (never decomposed);
   anything `confirm`/`deny`-classified that the model cannot re-authorize.
3. **Failures are never remembered.** A non-zero exit (or a timeout) is retryable by definition — the
   model may have just fixed the cause — so only a successful result is stored.

**Honest residual.** The second half of C3's acceptance ("verify the write landed before redoing it")
is covered here only for the idempotent SETUP commands that caused the measured duplicate (`venv`,
`mkdir -p`); a duplicate `write_file` of the same content is a separate, deliberate non-goal — content
can legitimately change between two writes in a way a version string cannot. And the live parity re-run
(the end-to-end proof that the probe count drops) is deferred to the next full run, since a live turn is
the only way to observe it and it costs a real budget; the unit suite plus the REAL-loop test (a scripted
turn runs `run_terminal` through the actual loop twice and the second call is answered from the memo)
is what stands in until then.

## Bundle 4c — a re-declared plan keeps the work already done (C4 LANDED)

**What the experiment changed.** The report said *"4 continuations; the plan is re-derived rather than
carried"*. The experiment (its section above) showed a step-bound continuation CARRIES the plan — the
second declaration is refused and the store is untouched — while a re-declaration in a LATER TURN
REPLACES it. So the fix is aimed at turns.

**Measured, before and after** (`tests/tools/c4-plan-continuation.test.ts`, log
`/tmp/nuvira-logs/c4-experiment.log`): the same scenario — turn 1 declares `[s1,s2,s3]` and completes
`s1`; turn 2 (fresh loop, same store, the model never shown the plan) declares the same plan again.

| | Before | After |
|---|---|---|
| store after turn 2 | revision 3, **all three `pending`** | revision 3, `s1 done` (note kept) |
| what the model is told | `🗂️ Plan: ship it — 0/3 done` | `1/3 done` + `♻️ Carried 1 step(s) already progressed from this goal's previous plan: s1 (done)` |

**The rule (narrow on purpose).** `PlanStore.create` carries a step's status and note when the GOAL is
unchanged — matched by id, and failing that by an identical normalized description (case, inner
whitespace and a trailing full stop are phrasing, not meaning) — so a genuine correction still applies
(new steps arrive `pending`, dropped steps disappear). A DIFFERENT goal is still a wholesale replacement:
a new plan for new work is not a re-declaration. Progress stays overridable: the model can `update` a
carried step back to `pending` and the create result tells it the option exists, so a reset it really
means is one explicit call away rather than an accident.

**Why the harness, not the prompt.** The store is what remembers; the model cannot see it. Two smaller
alternatives were rejected: refusing a second `create` (the tool's own promise is that a later turn can
carry the plan, and a genuinely new goal needs a new plan), and merging by POSITION (a model that reorders
its steps would then attach a finished status to the wrong one).

**The other half, now also landed (Bundle 4d).** The model was never SHOWN the plan it already has at the
start of a turn (the store was read only to answer "does a plan exist" — tool-loop.ts:2465/2483 — and to
build the turn report), which is why it re-declared at all. The loop now hands the current plan back in one
bounded block at the top of the turn — goal, revision, every step id with its real status and note, and the
instruction to ADVANCE it with `plan_todo` action `"update"` rather than re-declare it. Only when there is
work left (a completed plan is not re-shown) and capped at `PLAN_CONTEXT_MAX_STEPS` (12). Measured:
turn 2's FIRST request now carries the plan (`secondTurnSawThePlan: true`, where the experiment measured
`false` before).

## Bundle 3b — capability by measurement, and the name stops counting (B1/B3/B4 LANDED)

**The root cause.** `getModelCapabilities()` judged a model from its ID: a fast-tier word
(`mini`/`tiny`/`small`/`nano`/`lite`/`instant`/`flash`/`turbo`/`haiku`) SUBTRACTED 0.1 per word, a
slow-tier word added 0.15, a parameter-size table gave `70b` +0.45 and `≤4b` −0.2, and frontier-family
keywords added 0.2. Nothing anywhere had measured whether a model is any good — so max mode's reasoning
floor was a **spelling test**, and this programme's own report fell into the trap it was reporting: it
called DeepSeek V4.1 Flash weak *because of the word "flash"* while that model served an 82-step build
(correction C-2).

**What was built.** `learning/capability-evidence.ts` (pure) defines the five parameters
(`accuracy` / `performance` / `cost` / `robustness` / `ecosystem`), each scored 0–100 with its own
sample count, plus the prior rule, the tier derivation and the rendering. `ModelRegistryEntry` gains a
`capability` record — model metadata like the token EMAs, so it survives every availability write
(an auth failure says nothing about how well the model answered). `recordCall` folds real calls
(robustness, performance) and `recordCapabilityEvidence` folds a turn's verdict (accuracy); the chat
turn writes both from the ONE derived `TurnReport.verification` it already computes for the bandit.
`getModelCapabilities()` now reads that record and nothing else, and `model explain` prints the
scorecard with each number's basis and sample count.

### The prior rule (§3.2) — why this could land safely

| Samples | Reported value |
|---|---|
| 0 | the provider's declared baseline, **byte-for-byte** — nothing unmeasured changes behaviour |
| 1 … 9 | the measurement blended with the prior, whose weight decays linearly |
| ≥ 10 (`PRIOR_FULL_SAMPLES`) | the measurement |

`MIN_SAMPLES_FOR_EVIDENCE = 5` decides when a value is *labelled* measured rather than a prior. Both
constants are stated in code with their rationale — the design called the decay rate a calibration
decision, not a constant to bury.

**The honest limit, as designed:** a turn that verified nothing contributes **no** accuracy sample
(not a neutral 50), so a run that never checks its work gets no accuracy evidence rather than good
ones. `blocked` is likewise silent — a wall the run hit is not a verdict about the model.

### Measured / verified

- **B1 (name contributes nothing)** — `getModelCapabilities` returns the provider baseline for EVERY
  id at zero samples, including `gemini-3.1-flash-lite` vs `gemini-3.1-flash`, `qwen3-72b-instruct` vs
  `llama3:1b`, and an unknown id. Test asserts object equality.
- **B4 (the floor acts on measurement)** — the two tests that used to assert the opposite were
  REWRITTEN, not deleted: a `flash-lite`/`qwen3-72b` pair is now eligible on a cold start, is floored
  out once the harness has measured it failing (`PRIOR_FULL_SAMPLES` unverified turns), and a measured-
  fast pair clears a `minSpeed` floor that its provider baseline would fail.
- **Live** (`model explain`, this machine): `accuracy 85 (prior)` / `cost n/a (no prior declared,
  nothing measured)` / `tier Balanced` for the served pair — no number without a basis.

### Still open (honest scope)

- **B2 (root cause) — LANDED (Bundle 9, below)**: the wrong model was picked because `reasoningNeed` was
  decided by `desc.includes('hi')`, which matches the word "this". The static provider baselines
  (`openrouter 0.95`, `gemini 0.85`, `local 0.30`) are now only the cold-start PRIOR; measuring
  per-provider accuracy to replace them remains the follow-up, and the same mechanism supports it.
- **B2-a — the audit trail's `score` does not describe the pair it is written against.** `cli/chat.ts`
  records `score: decision.score` (a provider-level number) on every row of a failover walk, so
  `routing-history.json` shows three different pairs sharing one score that matches no candidate's own
  score. Turn the field into the PAIR's measured score, or drop it — an audit record may not carry a
  number that did not decide what it sits next to. No guessed value may be written into an audit record.
- **B5** — **LANDED (Bundle 3e, below)**: complexity now reads the ask's SHAPE as well as its vocabulary, so a four-component ask rates `complex` instead of `moderate`. The area set is deliberately coarse (twelve areas) and the floor can only RAISE a level; a finer set is a later refinement, not a gap.
- `userAccepted` and a real `qualityScore` are still absent from the bandit payload; `testPassed` is
  not yet folded (the turn report does not carry per-action `ok` today). `cost` and `ecosystem` have
  declared priors but no measured feed yet.
- **No external feed was integrated** — §6's recommendation (provider catalogue only, opt-in, never on
  the routing path) stands and is not needed for any of the above.

## Bundle 3c — a provider can list a model it cannot serve (D7 LANDED)

**The requirement (user, 2026-10-07, verbatim):** *"suppose we have 4 providers and everyone provides
deepseek, only one provider's key actually provides deepseek where as the user has not purchased model
access on the other providers or there is no free tokens offered by those providers — in that scenario
when selection happens based on ranking (rank of a model can be same), the agent should only pick, or
only be allowed to access, the one which has genuine token budget available, than going for rounds
unnecessarily for models offered by providers which actually do not have access to the model on their
platform."*

**Ranking cannot express this, and it must not try.** Rank is a property of the MODEL; access is a
property of the ACCOUNT serving it. Four twins share one rank by construction, so the decision is not
explainable from the ranking at all — and folding access into the score would let a cost or capability
advantage buy a call that is certain to fail.

**The registry already knew; nothing asked.** `ModelRegistryEntry` holds `status`, `lastError`,
`deadPair` and `quotaParkedUntil` per provider × model, and `model-registry.ts` already owned two
predicates (`isEntitlementFailure`, the not-found check). What did not exist was one answer to *"may the
router call THIS PAIR"* asked **before** the call instead of after it.

### What was built

| Piece | Change |
|---|---|
| `learning/pair-entitlement.ts` (new) | The four-state verdict — `funded` / `unknown` / `stalled` / `refused` — plus the pick order (`funded < unknown < stalled < refused`), `orderByEntitlement` (a **stable partition**, never a filter), `twinKey`/`areTwins`, `resolveFundedTwin`, and the printed labels/notes. |
| `model-registry.ts` | `isNonexistentPair` (was private `isDeadEntry`) and `isEntitlementFailure` are **exported**, so the classifier and the dead-pair machinery read the same vocabulary instead of drifting into two answers for one question. |
| `model-first-router.ts` | `buildModelCandidates` annotates each candidate with `entitlement` and applies the entitlement partition **after** the score sort, so the model-first override starts on a pair that can be called. `isCandidateAvailable` now also refuses a pair whose ACCOUNT was refused. |
| `auto-router.ts` | `pushFallback` drops a refused pair (D6's `status === 'unavailable'` check could not see a `verified` latch carrying a `402`). The **PRIMARY pick** is re-checked against this pair's own row; on a refusal the router takes a funded twin of the same model, else the best non-refused provider, and states the rescue in `explanation`. |
| `cli/model.ts` | `model explain` prints a **Pair entitlement** block: the chosen pair's verdict, and every same-model twin on another provider with ITS OWN verdict. |

### Doctrine (the three rules that make it correct)

1. **Per PAIR, never per model.** `openrouter`'s exhausted credits and `deepseek`'s funded account are
   facts about two ACCOUNTS. A twin never inherits a sibling's verdict — that is F6 (an availability
   verdict erased by unrelated evidence) wearing a new hat, and it is why identity may group capability
   but never routability (`DESIGN_MODEL_IDENTITY.md` §2).
2. **A refusal is a NO while an alternative exists.** `stalled` is the opposite case — a quota park or an
   aged-out proof clears by itself — so it stays eligible and simply sinks. `unknown` outranks `stalled`,
   because "no budget right now" is the exact thing this bundle exists not to spend a round on.
3. **Never dead-end.** `orderByEntitlement` is a partition; refused pairs are still in the pool, last. If
   every twin is refused the pick stands — *"use every model we can actually call; reject only when
   nothing is left"* survives.

**One flaw found in the fix itself, and it matters.** The first cut checked the refusal *before* the
status, so an entry with a lingering `credit-exhausted` in `lastError` read as refused. But
`markVerified` deliberately **preserves** `lastError` across a success (it rebuilds the entry and keeps
`existing?.lastError`), so after a user tops up their credits and the next call works, the row is
`verified` + `credit-exhausted` while the model is being served. That would have skipped the very account
we had just proved works — the same defect class (a stale verdict outranking fresh evidence) pointing the
other way. `status` is therefore checked first, and an entitlement refusal only counts while the entry is
still in the state that refusal produced — the registry's own guard in `markListed`.

### Measured

- **The D6 fixture itself proved the pick defect.** Re-measured on the existing test fixture (2026-10-07):
  before this bundle `resolve()` chose **`gemini/gemini-2.5-flash`** — the pair the registry had just
  proven dead with a 404 — while the fallback chain (correctly, since D6) started on `groq`. A chain-level
  gate could never cover that, because provider ranking runs before the pair is consulted at all. The test
  is amended to assert on the PICK as well as the chain, and `groq` now carries a second verified model so
  the non-empty-chain assertion still has something to assert about.
- **Non-vacuous reproduction of the user's case.** Funded-but-degraded `openrouter` (score 0.5289, health
  0.007) against a pristine but **parked** `groq` (0.536, quota 0): scoring alone starts on `groq` — the
  twin with no budget — while the entitlement order starts on `openrouter`. The test asserts the raw-score
  relationship too, so it fails loudly rather than becoming a tautology if weights shift.
- **Live, real registry** (`model explain`, this machine): `✅ funded gemini/gemini-3.1-flash-lite` /
  `⛔ refused groq/gemini-3.1-flash-lite — the provider says this model does not exist on this endpoint` /
  `❔ untried openrouter/google/gemini-3.1-flash-lite` — the reported shape, now legible in the output.

**Honest residual.** The registry learns a refusal from a REAL call, so the first encounter still pays one
failed round trip (`recordCall` → `credit-exhausted`); what changed is that every later turn routes around
it, and that the failed pair can no longer be the primary pick while a funded twin exists.

**Tests.** `tests/learning/pair-entitlement.test.ts` (new, 20 — classifier, order, twins, the reported
four-provider scenario, and the non-vacuous case above); `tests/learning/auto-router.test.ts` D6/D7 amended.

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
| **B3 partial (Bundle 3a)** | `learning/auto-router.ts` `recordOutcome` takes the bandit's own `Partial<BanditOutcomeData>` and forwards it to the provider AND model arms (it discarded `undefined` before); `learning/outcome-observation.ts` is the pure mapping from `TurnReport.verification` to `verificationPassed`; `cli/chat.ts` `answerOnce` now records the turn's outcome (the chat path never fed the bandit at all). | `tests/learning/outcome-observation.test.ts` (+6), `tests/learning/auto-router.test.ts` (+1, proven to depend on the forwarding) | **LANDED** |
| **C6 (Bundle 4a)** | `learning/turn-report.ts` `TurnReport.cost` + `formatCost` + `COST_NOTICE_USD` + summary/console rendering; `cli/chat.ts` takes the ledger window before the first provider call and passes it to the report. | `tests/learning/turn-report.test.ts` (+5) | **LANDED**, unit-verified; live, a cheap CLI turn is silent BY DESIGN (the block needs a summary, and the summary needs ≥ 1¢ — a live `chat` turn on `deepseek-flash` correctly printed nothing) |
| **B1 / B3 / B4 (Bundle 3b)** | New `learning/capability-evidence.ts` (five parameters, per-parameter sample counts, prior decay, derived tier, `DEFAULT_PRIORS`, rendering); `ModelRegistryEntry.capability` + `recordCapabilityEvidence`/`getCapability` + folds in `recordCall`; the chat turn feeds the turn's derived verdict in; `getModelCapabilities` reads measurement and the id-substring block is DELETED; `model explain` prints the scorecard. | `tests/learning/capability-evidence.test.ts` (new, 16), `tests/learning/auto-router.test.ts` (4 rewritten/added: B1 equality, B4 cold-vs-measured ×2, planner floor) | **LANDED**, live-verified in `model explain` |
| **A1 (Bundle 3d)** | New `learning/model-identity.ts`: the hand-declared alias table (`declaredAt` + evidence per entry), `identityKey`/`sameModel` (exact + bare id, widened ONLY by declaration), and `identityProvenance`. Wired into `twinKey`/`areTwins` (funded-twin grouping), `route-resolver.ts` `verifiedEquivalent` (the pin-refusal sentence now names the funded twin for the run-D pair), `model explain` (twin set + provenance) and `model list` ("same model, different verdicts"). Identity groups CAPABILITY/legibility only — never routability. | `tests/learning/model-identity.test.ts` (new, 9), `tests/inference/route-resolver.test.ts` (rewritten pair + a new no-guessing pair) | **LANDED**, live-verified in `model list` |
| **C4 residual (Bundle 4d)** | `tools/tool-loop.ts`: `planContextBlock` + one bounded `system` block at the top of every turn holding the conversation's existing plan (goal, revision, each step id with status and note, the `update`-not-redeclare instruction). Skipped when every step is done (`PLAN_CONTEXT_MAX_STEPS` = 12). | `tests/tools/c4-plan-continuation.test.ts` (+2: no plan ⇒ no block, completed plan ⇒ no block; the cross-turn case now asserts the plan is visible with `1/3 done`) | **LANDED**, measured (`secondTurnSawThePlan: true`) |
| **console preview (Bundle 8)** | `tools/tool-loop.ts`: `summarizeArgs` prefers the field that IDENTIFIES a call (`IDENTIFYING_ARG_KEYS`: path/filePath/file/paths/command/pattern/query/url/goal/name/question/tool/action/claim) over whichever key the model emitted first, falling back to the first; exported for its test. | `tests/tools/tool-loop.test.ts` (+4) | **LANDED**, found by the live run (five `write_file({confirm: true})` lines) |
| **B2 (evidence, Bundle 8)** | No code — the live re-run produced the evidence: a `complex` ask was fed to `gemma-4-26b-a4b-it` first and reached `deepseek-flash` only after gemini failed twice. | evidence only (trace `cli-chat-1791364283748.log`, `routing-history.json`) | **MEASURED**; the conclusion drawn from it ("equal priors ⇒ the ranking carries no information") was **WRONG and is corrected in Bundle 9** — the repeated score was the audit trail copying `decision.score`, and the wrong pick came from `desc.includes('hi')` |
| **B2 (Bundle 9)** | `learning/hybrid-router.ts`: new exported `isSmallTalk` (whole word, whole message); both `estimateTaskRequirements` implementations (`model-first-router.ts`, `model-scoring.ts`) use it instead of `desc.includes('hi')`. | `tests/learning/hybrid-router.test.ts` (+4), `tests/learning/router-scoring-truthfulness.test.ts` (+5) | **LANDED**, measured before/after against a rebuilt `dist/`: `reasoningNeed low` 81/160 → 17/160, and the live ask's first pick moves off the ~4B-active model |
| **A5/D3 residual (Bundle 2h)** | `cli/chat.ts`: `turn.start` records `requested` (the resolved pair) instead of a bare `provider`; `turn.end` records `served` from the SAME expression the header uses, plus `requested` when it differs. | `tests/observability/debug-log.test.ts` (+1) | **LANDED**, measured on the trace that showed the mismatch |
| **B5 (Bundle 3e)** | `learning/hybrid-router.ts`: `analyzeComplexity` takes the higher of the keyword ladder (`complexityFromKeywords`, unchanged) and a measured breadth floor; new `requirementUnits` + `measureTaskBreadth` (exported, so a caller can state WHY) and the twelve coarse `CAPABILITY_AREA_RE` buckets. | `tests/learning/hybrid-router.test.ts` (+5) | **LANDED**, measured before/after against `dist/` (`moderate` → `complex`); four false-positive shapes pinned unchanged |
| **G1–G4 (Bundle 7)** | New `utils/workspace-path.ts` (the shared path rules) and `web-dashboard/workspace-resolution.ts` (`resolveTurnWorkspace`, `formatWorkspaceNoticeText`); `web-dashboard/server.ts` resolves the turn's workspace through it (attached → session → message → default → none) and returns `workspaceNotice`/`workspacePath`/`workspaceSource`; `web-dashboard/project-context.ts` opens the context with `Workspace: ATTACHED …` and states that an EMPTY attached folder is a normal start; `tools/registry.ts` (`ToolContext.workspaceUnscoped`, the `ask_user` folder ADOPTION, and the G13 suppression standing down while unscoped), `tools/coding-tools.ts` (`unscopedWriteRefusal` on `write_file`/`edit_file`), `web-dashboard/chat-console.ts` + `cli/chat.ts` (the flag reaches the tool context), `web-dashboard/src/api.ts` + `components/ChatPage.tsx` (the notice banner and attaching the resolved folder). | `tests/web-dashboard/workspace-resolution.test.ts` (new, 13), `tests/web-dashboard/project-context.test.ts` (+3), `tests/web-dashboard/chat-api.test.ts` (+3), `tests/tools/unscoped-workspace.test.ts` (new, 9) | **LANDED**, unit + API verified; the live re-run against the rebuilt `dist/` is the remaining proof |
| **F1 (Bundle 6)** | `inference/interface.ts` (`ToolArgumentsError`, `finishReason`), `inference/tools.ts` (`parseToolCallArguments` used by both the streaming and one-shot paths), `inference/native-tools.ts` (Anthropic wire), `tools/tool-loop.ts` (`malformedToolCallRefusal` + `malformedCallNudge` + the planning-phase refusal), `tools/child-agent-runtime.ts` (same refusal in the forked loop), `tools/coding-tools.ts` + `tools/registry.ts` (`write_file` `mode: "append"`), `learning/reasoning-trace.ts` (the `malformed-call` gate name). | `tests/tools/malformed-tool-call.test.ts` (new, 5), `tests/inference/tools-stream.test.ts` (+3: truncated, empty, healthy+finishReason), `tests/tools/coding-tools.test.ts` (+2: append sections, overwrite default) | **LANDED**, unit + loop verified; the live re-run of the failing ask is the remaining proof |
| **C4 (Bundle 4c)** | `tools/plan-store.ts` `PlanStore.create` carries status + note for a step re-declared under the SAME goal (by id, else by an identical normalized description); a different goal still replaces wholesale. `tools/registry.ts` `plan_todo` create announces what it carried and how to override it. | `tests/tools/plan-store.test.ts` (+6: carry by id, carry by description, exact-match-only, correction still applies, explicit reset, one previous step never carried twice, no carry across a different goal) and `tests/tools/c4-plan-continuation.test.ts` (the cross-turn scenario, now asserting `1/3 done` + the carried note) | **LANDED**, measured before/after; showing the plan to the model is the recorded residual |
| **C3 (Bundle 4b)** | New `tools/command-memo.ts`: `splitCommandChain` (refuses pipes/redirects/substitutions/globs), `commandMemoKind` (`probe` \| `idempotent` \| `null`), `memoKeyFor`/`lookupMemo`/`storeMemo`/`memoNotice`, and the per-run `RunCommandMemo`; `ToolContext.commandMemo` created once per run by the tool loop; `run_terminal` consults it after the DENY check (returning the earlier output with a `↺ not re-run` header) and stores only SUCCESSFUL results. | `tests/tools/command-memo.test.ts` (new, 24: pure classification, combined→individual coverage, one-by-one never satisfies a combined ask, failure-not-remembered, per-run isolation, directory scoping, the make-a-re-spawn-fail proof, and a real-loop wiring test) | **LANDED**, unit + real-loop verified; the live parity re-run is the remaining proof |
| **D7 (Bundle 3c)** | New `learning/pair-entitlement.ts` + registry exports: the verdict on whether the ACCOUNT serving a pair can be called (`funded`/`unknown`/`stalled`/`refused`), the entitlement partition applied to the model-first pool after scoring, the refusal gate in `pushFallback`, and a re-check of the PRIMARY pick that rescues to a funded twin. `cli/model.ts` prints the twin set. | `tests/learning/pair-entitlement.test.ts` (new, 20), `tests/learning/auto-router.test.ts` (amended, pick asserted) | **LANDED**, live-verified in `model explain` |
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

1. **Bundle 3c — pair entitlement** (D7): **LANDED** (see its section) — the model-first pool, the offered chain and the primary pick now all refuse a pair whose ACCOUNT was refused, and tie-break to the funded twin.
2. **Bundle 1 — identity & routability** (A1–A4): A2/A3/A4 **LANDED** (see their rows). **A1 decided by the user ("go ahead with all 3"): option A, the declared alias table** (seeded from this machine's registry), plus twin grouping in `model list`/`model explain`; identity groups CAPABILITY only and never routability. Next up.
3. **Bundle 2 — truthful reporting** (**CLOSED: D1/D3/D4/D5/A5 landed in Bundles 2c–2g**): make the system's account of itself true.
4. **Bundle 3 — capability by measurement** (B1–B5): the root cause. **Design re-written to the parameter-based scorecard you specified** (accuracy / performance / cost / robustness / ecosystem + a derived tier + a rank, each fed from measurement during task execution) — see `docs/DESIGN_CAPABILITY_BY_MEASUREMENT.md`. Awaiting sign-off on the three open questions in its §6 — **but note B5 LANDED (Bundle 3e) and B2's measured cause LANDED (Bundle 9)**: the reason a `complex` ask went to a small model first was NOT the static priors, it was `reasoningNeed` read from the substring `'hi'`, so the scorecard is now needed for RANKING QUALITY, not to explain that pick.
5. **Bundle 4 — context discipline** (C1, C3–C6): the 2.85× gap. **C6 LANDED (Bundle 4a)**, **C3 LANDED (Bundle 4b)**, **C4 EXPERIMENT RUN** (its section, above): a continuation does not re-derive the plan — a LATER TURN does, and `create` resets completed steps while the model is never shown the plan. **The fix LANDED (Bundle 4c + 4d)**: the carried progress + disclosure, AND the plan is now shown at turn start (`planContextBlock`, bounded to 12 steps and skipped once every step is done). **F1 LANDED (Bundle 6)** — found live in the dashboard traces, not on the original list: a tool call whose arguments did not arrive was executed as `{}` (134 empty calls across the last two big turns), so it is now refused with the real cause and the sectioned-delivery alternative, and `write_file` can append. **Cluster G LANDED (Bundle 7)** — also found live, while the user was blocked on it: an attached-but-empty folder read as "no project", a folder the CHAT had attached was forgotten when the request did not resend it, a folder the user TYPED was discarded, and an unscoped turn could write into the dashboard process's own cwd; the workspace decision now lives in one tested place, the priority is attached → session → message → configured default → none, and a write with no folder ASKS where instead of guessing. Next: the C1/C5 budget policy. **C1 begins with a policy decision, not a patch:** C1's re-measurement (above) shows compaction already exists and never fired, so the question is the budget policy (lower the 200K-char floor / compact proactively / compact against the plan), and C5's fit-to-window conflict with the deliberate `THREAD_BUDGET_FLOOR_CHARS` never-shrink rule must be resolved the same way.
6. **Bundle 5 — autonomy & inventory** (**PARTIAL: E1/E2 landed in Bundle 5a/5b; E3 + D6 landed in Bundles 2a/2b; B5 LANDED in Bundle 3e**).
