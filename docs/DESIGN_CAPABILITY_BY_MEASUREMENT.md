# DESIGN — Capability by measurement (Bundle 3, B1–B5)

**Status: §1–§5 LANDED (Bundle 3b, 2026-10-07) — the scorecard exists, the id-substring block is gone,
and the reasoning floor acts on measurement. §6 remains a recommendation (no external feed integrated).
§7 records the decisions taken. Implementation: `src/learning/capability-evidence.ts` +
`ModelRegistryEntry.capability` + `AutoModelRouter.getModelCapabilities()` + `model explain`.**

Bundle 3 of `PLAN_MODEL_ROUTING_PARITY.md` is the programme's root cause: *the router judges a
model's capability from its name*. This document replaced its first draft after the user specified
the shape they want — a **parameter-based scorecard per model, populated from measurement during task
execution**, of the form:

```json
{ "name": "Claude Haiku", "tier": "Balanced",
  "scores": { "accuracy": 78, "performance": 88, "cost": 85, "robustness": 75, "ecosystem": 80 },
  "overall_rank": 4 }
```

So the design is: **five named parameters + a tier + a rank, all derived from what the harness
observed while doing real work.** This is a superset of the three options in the first draft — the
open question there (how long a static prior may outrank evidence) becomes a per-parameter rule below.

---

## 1. The defect, restated precisely

`AutoModelRouter.getModelCapabilities()` (`src/learning/auto-router.ts` ~1371) computes REASONING and
SPEED from:

| Evidence | Effect |
|---|---|
| Fast-tier words in the id — `mini`, `tiny`, `small`, `nano`, `lite`, `instant`, `flash`, `turbo`, `haiku` | **−0.1 per word**, +0.15 speed |
| Slow-tier words — `large`, `max`, `opus`, `pro`, `ultra`, `frontier` | +0.15 |
| Parameter size in the id — `70b`, `8b`, `3b` | +0.45 / +0.15 / +0.05; −0.2 at ≤ 4B |
| Frontier-family keywords — `gpt-4/5`, `claude-3/4`, `gemini-2`, `deepseek-r1`, `qwen3` | +0.2 |
| Static provider baseline — `openrouter 0.95`, `gemini 0.85`, `nim 0.72`, `groq 0.55`, `nuvira 0.50`, `local 0.30` | the starting value |
| **Measured latency only** — `latencyMs ≥ 10s` / `≤ 800ms` | ±0.1 |

The only measured input is latency. Consequence: **B1** a strong model is penalised for the word
`flash` (the programme's own pre-measurement proved this the hard way — the investigator called
DeepSeek V4.1 Flash weak *because of its name*, and the runs showed it served the whole task);
**B2** `openrouter (0.95)` outranks `gemini (0.85)` regardless of what either has done; **B4**
`MAX_CAPABILITY_MIN_REASONING = 0.7` is therefore a NAME threshold (`flash` + `lite` = 0.65 fails it);
**B3** no measured quality exists anywhere.

## 2. What already exists (the design is mostly wiring)

### 2.1 The registry already stores most of the raw inputs

`ModelRegistryEntry` (`src/learning/model-registry.ts`) is a durable, per-`provider × model` record
that already carries `latencyMs`, `errorRate`, `partialRate` (mid-stream flakiness EMA),
`measuredInputTokens` / `measuredOutputTokens` / `measuredSamples`, `contextWindowTokens`,
`reasoningCapability`, `deadPair`, `quotaParkedUntil`, `status` and a **`source` confidence**
(`telemetry` > `spot-check` > inferred). Every one of those is a *measurement*.

### 2.2 The bandit already defines a quality reward that nothing populates

`BanditOutcomeData` (`src/learning/router-bandit.ts` ~34) carries **`qualityScore`**, **`testPassed`**,
**`userAccepted`**, **`verificationPassed`**; `applyReward()` (~374) folds them in; learning is bucketed
by **provider arm and model arm** and by task intent; it is ON by default with a deterministic
Beta(1,1) cold start. But the real path passes **`undefined`** for all of them —
`AutoModelRouter.recordOutcome` forwards `undefined` to both arms (~2762/2764), and its only live
caller (the orchestrator ~3324) does too, with an outcome that is just `result.success` ("the agent
did not throw" — the D2 defect, one layer down).

> **STATUS: FIXED for the chat path (Bundle 3a in the tracker).** The declared type had no parameter
> for the three honesty fields, so no caller COULD have supplied them; it now takes the bandit's own
> `Partial<BanditOutcomeData>` and forwards it to both arms, and the chat turn — the product's most
> common entry point, which had never fed the bandit at all — now records `verificationPassed` from
> its derived `TurnReport` verdict via the pure mapping in `learning/outcome-observation.ts`.
> Still open here: `testPassed`, `userAccepted` and a real `qualityScore`, which is why §7 still
> needs sign-off.

### 2.3 The harness already DERIVES the honesty signals

| Signal | Derived today in |
|---|---|
| did the turn's work actually verify | `TurnReport.verification` (`learning/turn-report.ts`) — from recorded tool/plan evidence, never narration |
| did a command/test/build pass | `ExecutedAction[]` with `ok` (the within-turn work digest) |
| did the turn deliver what it promised | honesty flags `undeliveredArtifact`, `unfulfilledPromise`, `unverifiedEditClaim`, `unverifiedBuildClaim`, `noActionTaken` |
| did the user accept it | the next-turn correction signal (`learning/working-state.ts`), followup rejection, dashboard feedback |
| was the work done at all | `countProductiveWork` / `hasProductiveAction` (`tools/tool-loop.ts`) |

## 3. The scorecard

One **CapabilityRecord** per `provider × model`, replacing the two ad-hoc scalars (`reasoning`,
`speed`) with five named parameters, a derived tier and a rank. Scores are 0–100 (integers, like the
sample) so a human can read `model explain` without translating a 0–1 float.

### 3.1 The parameters

| Parameter | What it means here | Measured from (during task execution) | Update rule | Honest limit |
|---|---|---|---|---|
| **accuracy** | Did the work actually work? | `TurnReport.verification` (`verified` / `unverified` / `blocked`), the honesty flags, `testPassed` from executed actions | EMA over turns, one observation per completed turn; a `blocked` turn is excluded (it is not evidence about the model) | Says nothing about a turn that did no checkable work — that turn contributes no accuracy sample rather than a neutral one |
| **performance** | How fast, in the user's terms | measured `latencyMs` (already in the registry) + tokens/sec from `measuredInput/OutputTokens` + steps-to-completion | EMA with the registry's existing latency statistic; normalised against the task's own complexity | A slow answer that is right beats a fast one that is wrong; speed is a tiebreaker, never a gate |
| **cost** | What it costs for the work done | `measuredInput/OutputTokens ×` provider pricing (`computeCostScore` already exists) | EMA of cost-per-delivered-turn, not cost-per-call — a cheap call that had to be retried is not cheap | Unpriced providers must not silently score as free; absent pricing → no sample |
| **robustness** | Does it hold up across many calls | `errorRate`, `partialRate` (mid-stream flakiness), empty-response rate, failover/retry counts, `deadPair` | Already EMA-based in the registry; the scorecard reads it rather than duplicating it | A provider with ONE call is neither robust nor fragile — needs a minimum sample before it can move the rank |
| **ecosystem** | What the pair can do besides answer | tool-calling success rate, `reasoningCapability` support, `contextWindowTokens`, number of served pairs on this provider | Registry facts, refreshed by the existing `listModels` probe | **This is the one parameter task execution cannot fully measure.** Tool-calling success IS measured; window/tool support is a CATALOG fact. Declared static where it is a fact, measured where it is behaviour — and labelled, so nobody reads a catalog fact as an observation |
| **tier** | Frontier / Balanced / Utility | **Derived**, never parsed: e.g. Frontier when accuracy and ecosystem are high and cost is not penalised; Utility when accuracy is low or the window cannot hold the work; Balanced otherwise | Recomputed whenever a parameter changes | The boundaries are a calibration decision, stated in code and in `model explain` — not a hidden constant |
| **overall_rank** | Position among comparable pairs | The blended rank the router already computes | Re-derived per resolve | A rank is meaningful only WITHIN an eligibility set; the scorecard prints the sample count beside it |

### 3.2 The statics become the cold-start prior, per parameter

The user's requirement is that these numbers are **measured during task execution**. The current
static tables are still useful for day one, so each parameter follows the same rule:

- **0 samples** → the static prior/declared fact (today's behaviour, byte-identical).
- **≥ `MIN_SAMPLES_FOR_EVIDENCE`** (to be set; single digits) → the measured EMA, with the prior's
  weight decaying as samples grow.
- **never** → the id-substring terms. They are **removed**, not capped: B1 and B4 are name defects,
  and a capped name hint is still a name judgement.

The measured value and its sample count are both stored, so `model explain` can say
`accuracy 78 (n=14)` — a number a reader can weigh — instead of a bare float.

An external feed is the SAME mechanism with a different source label (§6): it supplies a prior value
for a pair with no samples, it is printed as a prior rather than as measurement, and it can never
outrank evidence. Nothing else about the model changes because a number arrived from the network.

## 4. What has to be built (the wiring)

1. **`CapabilityRecord`** on the registry: the five parameters, a sample count each, the tier, and the
   `source` confidence the registry already uses. Durable across processes (the registry is).
2. **Observation wiring** — **PARTIAL (Bundle 3a)**: the chat turn now derives
   `verificationPassed` from `TurnReport.verification` and records it. Remaining: `testPassed` from
   the executed `ok` actions, `userAccepted` from the next-turn signal, `latencyMs`/tokens, and the
   per-model capability update (which waits on §7).
3. ~~**`recordOutcome` stops discarding `outcomeData`** for the provider arm and the model arm.~~
   **LANDED (Bundle 3a)** — including the chat-path wiring that supplies it.
4. **`getModelCapabilities()` reads the scorecard**: the id-substring block is deleted; the reasoning
   floor is applied to the measured `accuracy` (B4), with the same never-dead-end fallback that
   already exists (`R4 — agentic capability floor`).
5. **`model explain` / `model list`** render the scorecard (parameter, value, sample count, tier), so
   the routing decision is auditable in the terms the user asked for.
6. **B5** (complexity under-rated) is a separate calibration on `analyzeComplexity`: a 4-component
   full-stack ask classifies `moderate` today and should classify ≥ `complex`. It needs a before/after
   prompt→classification table, not a new signal.

**Non-goal.** No part of this may become "route to a different model". The model is held constant on
purpose; this changes *how the harness judges* a pair, not which model it prefers.

## 5. Acceptance (as tests)

| # | Test that must pass |
|---|---|
| B1 | Two pairs differing ONLY by a tier word in the id score identically at equal evidence — the name contributes nothing. |
| B2 | A pair with a track record outranks a better-baselined pair once its sample count clears the threshold; two pairs with equal records rank equally. |
| B3 | A pair that consistently fails (unverified, no artifact, retried) is demoted by measurement, and `model explain` shows the value WITH its sample count. |
| B4 | The reasoning floor is applied to measured accuracy; a table lists which pairs pass and why, from measurements. |
| B5 | The 4-component full-stack prompt classifies ≥ `complex`. |
| — | A turn with `verification: blocked` contributes no accuracy sample (it is not evidence about the model). |

## 6. External ranking feeds — assessed (checked 2026-10-07)

You asked whether the public model-ranking sources found online can be used for the scorecard. I
checked each one before designing anything against it, because a feed that is retired, unrelated, or
non-existent is a dependency that fails silently. **Two are dead, one is unrelated to ranking, one
name in the sample data does not exist, and one is genuinely useful — but it is not the kind of feed
the list describes.**

| Source (as proposed) | What it actually is today | Can it feed the scorecard? |
|---|---|---|
| **Open LLM Leaderboard (Hugging Face)** | **RETIRED and archived.** The 2024–2025 board was archived (last updated Oct 2025) and HF announced the retirement in Mar 2025. Only open-weight models were ever covered — no GPT/Claude/Gemini rows. | Only as a FROZEN snapshot for open-weight models. It cannot be a live feed, and it cannot score most of the pairs this router routes to. |
| **Chatbot Arena / LMArena** | **Live.** Elo/Bradley-Terry scores from crowdsourced human battles; a HF Space renders it and the battle datasets are released. There is **no documented keyless JSON API for the leaderboard itself** — the Space and the datasets are the routes, and their licences/ToS must be checked before any redistribution or commercial use. | Yes, as a **human-preference prior for `accuracy`**, behind a flag. Two caveats: arena ids are vendor-facing display names (they do not match our pairs — see A1 identity), and "prefers this chat answer" is not "can drive a 82-step tool loop". |
| **Papers With Code — Leaderboards** | **SHUT DOWN (July 2025, by Meta)**; the domain now redirects to Hugging Face. | **No.** There is no feed to consume. |
| **DeepSeek / Awesome-DeepSeek-Agent (GitHub)** | Not a ranking source in any form I can find. Note also that **"DeepSeek Hermes" does not exist** — Hermes is a Nous Research family, not DeepSeek. The same applies to the sample scorecard (`GPT-6.1 Sol`, `Claude Opus 5.5`): the **SHAPE** is exactly right and is what §3 adopts, but the names and numbers do not come from any leaderboard I can verify. | **No.** This is precisely why §3.2 lets a prior be replaced by measurement and requires a sample count beside every number: a plausible-looking score that nobody measured is the defect, not the fix. |
| **Graphify Labs / Graphify repo** | Real project (`Graphify-Labs/graphify`) — a **codebase knowledge-graph / coding-agent** tool. It does not publish model rankings, compatibility scores or "parsing performance" for models. | **No.** Consuming it as an ecosystem signal would be inventing a data source. |

### 6.1 The feed that DOES fit (and it is not a leaderboard)

`GET https://openrouter.ai/api/v1/models` — **keyless, documented, per-model, machine-readable**: it
returns each catalogue model's pricing, `context_length` and `supported_parameters` for the *exact
ids we route to*. That is the same class of input the registry already ingests from its `listModels`
probe, and it is the only external value here that attaches to a pair **without** an identity guess.
It feeds `cost` (pricing), `ecosystem` (context window, tool/reasoning support) and nothing else.

### 6.2 The rules for ANY external feed (non-negotiable)

1. **Prior only, and `accuracy` only.** An offline benchmark is a snapshot of *a different task* —
   multiple-choice questions, human chat preference, static code problems. Our premise is that this
   harness's own outcomes are the signal that matters. A prior may inform a pair with 0 samples; it
   may never outrank measured evidence (§3.2).
2. **Never on the routing path at runtime.** Fetched out-of-band, cached with a timestamp, and
   hard-failing to "no prior" — a routing decision must never wait on, or fail because of, a network
   call to a third party.
3. **Identity-mapped or unused.** An external row attaches to a pair only through the declared
   identity mapping (A1). Unmatched rows are dropped, never fuzzy-matched — matching by name is the
   defect this programme exists to remove.
4. **Provenance is printed.** `model explain` must distinguish `accuracy 78 (measured, n=14)` from
   `accuracy 78 (prior: LMArena, 2026-09-01)`. A reader has to be able to tell an observation from a
   borrowed number.
5. **Opt-in, with a documented TTL.** Default OFF. A stale prior is worse than none, so an expired
   entry is treated as absent rather than kept.

### 6.3 Recommendation

Adopt the **shape** (§3) and fill it with our own measurements, and if an external feed is used at
all, use the **provider catalogue** (6.1) for `cost`/`ecosystem`. Treat LMArena as an optional
`accuracy` prior behind the flag in 6.2. Do not integrate the retired HF leaderboard, the dead Papers
With Code, or Graphify — and do not populate any score from data whose names cannot be verified.

## 7. Decisions taken (2026-10-07, on the user's "go ahead with all 3")

1. **Parameter weights** — left EXPLICIT and unweighted for now: the record stores five independent
   parameters, and the router reads `accuracy` (replacing the id reasoning hints) and `performance`
   (replacing the id speed hints). A blended `overall_rank` was deliberately NOT introduced, because
   a single weighted number would hide which parameter moved — the thing this bundle exists to make
   visible. Weights are a later calibration, once parameters have samples.
2. **`ecosystem`** — kept, with the split as designed: measured tool-calling when observed, declared
   catalog facts otherwise. On a cold start it carries `DEFAULT_PRIORS.ecosystem = 0.5`, which keeps a
   pair OUT of the `Frontier` tier (that needs ≥ 0.7) — a pair we have never watched call a tool is not
   a frontier agent model.
3. **`MIN_SAMPLES_FOR_EVIDENCE = 5`** and a LINEAR decay to zero prior weight by
   `PRIOR_FULL_SAMPLES = 10` — implemented exactly so, with both constants and their rationale in
   `capability-evidence.ts`.
4. **External feeds — APPROVED and now being implemented (2026-10-07, user's "I approve openrouter based
   approach").** The provider catalogue only (for `cost`/`ecosystem`), never on the routing path, with
   every rule in §6.2 applied: prior-only, cached with a TTL, identity-mapped or dropped, provenance
   printed, opt-in. One requirement the user ADDED: the opt-in must be an **environment variable surfaced
   in both the CLI and the dashboard**, so it can be switched on without editing code. No leaderboard was
   integrated. `cost`'s prior stays `undefined` (printed `n/a`) until the feed supplies one, because
   pricing belongs to a provider ACCOUNT.

### What landed, precisely

| § | State |
|---|---|
| §3.1 parameters + tier | **LANDED** — `CapabilityRecord`, `deriveTier`, `capabilityLines`. |
| §3.2 prior rule | **LANDED** — 0 samples returns the prior byte-for-byte; the decay is linear. |
| §4.1 `CapabilityRecord` | **LANDED** — on `ModelRegistryEntry`, preserved across every availability write. |
| §4.2 observation wiring | **PARTIAL** — `verificationPassed` (chat turn) + robustness/performance (every `recordCall`) fold in; `testPassed` and `userAccepted` do not (the turn report carries no per-action `ok` today). |
| §4.4 floor on measured accuracy | **LANDED** — the floor reads the scorecard; the id-substring block is deleted. |
| §4.5 `model explain` | **LANDED** — parameter, value, basis and sample count; `n/a` when there is no prior. |
| §4.6 B5 (complexity) | **LANDED (Bundle 3e)** — `analyzeComplexity` now takes the higher of the keyword ladder and a measured breadth floor. This row said OPEN for several bundles after it landed; corrected 2026-10-07. |
| §4.2 `userAccepted` | **CLOSED (Bundle 27)** — `detectRegressionSignal` (the next-turn correction) is wired into the bandit as `recordUserRejection`; it corrects an arm, never creates one. This is the DERIVED negative half only. |
| §4.2 labelled reference | **LANDED (Bundles 30–31)** — see §8. The POSITIVE class has a source (an explicit per-turn verdict + the tier-3 behavioural labels), and `learning/acceptance-model.ts` now FITS `P(accepted \| features)` to it and prints it read-only in `model explain`. Nothing routes on it, and the fit refuses below 20 labelled turns — so on today's machine (0 rated) it correctly prints the not-trained line. |

## 8. Labelled reference — the previous approach vs the new one (Bundle 30)

§4.2 kept `qualityScore` OPEN for many bundles with the note *"no measured scale exists"*. The scale
was never the problem. A quality number fit to signals the harness already derives would just be a
**second copy of the verification verdict** — it would agree with `accuracy` and add nothing. What was
missing is a **LABEL**: an observation of whether the delivered work was what the user wanted. This
section records the previous label-sourcing approach, the new one, and why they differ.

### 8.1 Previous — derived signals only (negatives, and no positive class)

Every honesty signal the harness had was **derived from the run**:

| Signal | Source | Direction |
|---|---|---|
| `verificationPassed` | `TurnReport.verification` from recorded tool/plan evidence | both, but it is *"did the work verify"*, not *"was it wanted"* |
| honesty flags (`undeliveredArtifact`, `unfulfilledPromise`, …) | `tools/tool-loop.ts` | negative |
| `testPassed` | executed action `ok` | both |
| **`userAccepted`** | the **next-turn correction signal** — `detectRegressionSignal` (`learning/working-state.ts`) | **negative only** |

Bundle 27 wired the correction signal into the bandit (`recordUserRejection`, α−=0.1/β+=0.1) — a real
improvement, and it closed `userAccepted`. But the mechanics matter: `detectRegressionSignal` fires on
a CORRECTION and is **silent otherwise**. Silence is not acceptance — a user who closes the terminal is
recorded identically to one who is delighted. So the derived path can **only ever produce negatives**,
and a binary classifier trained on negatives alone would learn "reject everything". The `accuracy` fold
in the scorecard has the same shape: it measures *verified*, which is orthogonal to *wanted*.

**The consequence stated honestly:** `qualityScore` could not be built from these inputs, and no amount
of additional wiring would change that. The missing ingredient was a label, and the only source of one
is the person who asked.

### 8.2 New — an explicit verdict, recorded with provenance (Bundle 30)

The new approach adds the one input the harness cannot compute: the user's own verdict on a turn.

| Layer | Where | What it holds |
|---|---|---|
| Per-turn verdict | `ReasoningTrace.userVerdict` (`learning/reasoning-trace.ts`), written by `recordTraceVerdict` | `{ verdict: 'accepted' \| 'rejected', at, source: 'cli' \| 'dashboard' }` — the durable per-turn record |
| Corpus label | `deliverable-candidates.jsonl` (`learning/deliverable-corpus.ts`) | `verdict: 'accepted' \| 'rejected' \| null` + `verdictAt` + `traceId` — the artifact-specific row a fit would read |
| Recorder | `learning/turn-feedback.ts` — `rateTurn({verdict, traceId?, source})`, `parseVerdict`, `latestRateableTraceId`, `listTurnVerdicts` | labels the trace AND, when that turn delivered an authored artifact, exactly that corpus row |
| CLI surface | `nuvira rate <good\|bad>` (`cli/rate.ts`), `-t/--trace <id>`, `-l/--list` | source `'cli'` |
| Dashboard surface | `POST /api/traces/:id/verdict` + the "Was this what you wanted?" 👍/👎 control in `TracePanel.tsx` | source `'dashboard'` |

**Provenance is part of the label** (`source: 'cli' | 'dashboard'`) so a future fit can weigh a human
judgement separately from a derived one. **Silence stays `null`.** The corpus never fabricates a
`false` for an unrated turn, and a REJECTION falls back to the newest unlabelled row while an
ACCEPTANCE does not (`labelDeliverableByTrace`) — the positive class is never invented, only measured.

### 8.3 The four tiers of label sourcing (only tier 2 supplies the positive class)

| Tier | Source | Class supplied | State |
|---|---|---|---|
| 1 — derived | `detectRegressionSignal`, honesty flags | negatives only | wired (Bundle 27) |
| 2 — **explicit** | `nuvira rate` / dashboard 👍👎 | **both — the only source of `accepted`** | **landed (Bundle 30)** |
| 3 — behavioural | repeat ask (token similarity), user hand-edits the file (mtime after delivery), untouched artifact the user then **references** | both, weaker | **LANDED (Bundle 31)** — `learning/behavioural-labels.ts`, `source:'derived'`. An untouched artifact alone is NOT a label (silence is not acceptance); only an untouched artifact the user's next message names, with no regression, is a weak accept. |
| 4 — model-as-judge | an LLM scores the turn | both, but a prior, never a measurement | `source:'model-judge'` when built — not built |

### 8.4 Honest limits

- **Nothing routes on this yet.** `rateTurn` fits nothing and moves no score. Recording the label and
  using it are separate decisions; using it waits until enough rows exist to mean anything.
- **A few hundred rows with BOTH classes are needed** before a `P(accepted | features)` is fit-able.
  Until then `qualityScore` stays genuinely blocked — the collection path is the unblock, not the score.
- ~~**Coverage gap** — the dashboard chat console does not collect corpus candidates.~~ **CORRECTED
  (Bundle 31).** That claim was wrong: the dashboard console drives the *same* `ChatCommand.answerOnce`
  the CLI does, and the collection is a straight-line statement inside it, so a dashboard turn that
  authors a single on-length artifact DOES record a corpus row (pinned by
  `tests/web-dashboard/chat-console-corpus.test.ts`). A dashboard 👍/👎 can therefore label its row.

### 8.5 Decision — two feedback concepts, kept distinct (not merged)

There is a **pre-existing** `src/learning/feedback.ts` (`FeedbackStore`, `~/.nuvira/memory/feedback.json`,
CLI `nuvira feedback record|list|stats|clear`) whose shape is superficially similar. It is **not** the
same thing, and the decision is to keep both and say so plainly rather than ship two overlapping stores
silently:

| | `feedback.ts` (old) | `turn-feedback.ts` (new) |
|---|---|---|
| Key | `trajectoryId` — pipeline runs | `traceId` — **chat turns** |
| Verdict | `positive \| negative \| neutral \| skip` | `accepted \| rejected` (binary) |
| Store | `feedback.json` | the trace itself + the deliverable corpus row |
| Consumed by | stats display only (`cli/learn.ts`, `cli/memory.ts`, dashboard) | the corpus a future fit reads |
| `ratingToScoreDelta` (±0.3) | defined but **has no caller today** | — |

The old store never fed the **chat** turn (its `source` is hardcoded `'cli'` and it was only ever written
by the pipeline), so it could not have produced the chat-turn label this document needs. The new one is
the **trace-scoped** implementation and the only one that also labels the corpus. `nuvira feedback`
remains for trajectory ratings; its help now points at `nuvira rate` for turn labels.

### 8.6 The first consumer — the acceptance model (Bundle 31)

The label is only worth collecting if something reads it. `learning/acceptance-model.ts` is that first
consumer: it fits **`P(accepted | features)`** — a logistic model over the harness's own per-turn
features — and reports it READ-ONLY.

| Feature | Read from | Meaning |
|---|---|---|
| `verified` | `TurnReport.verification` ∈ {`verified`, `delivered-and-read-back`} | the turn's own check passed |
| `unverified` | `verification === 'unverified'` | it ran but nothing verified it |
| `flag` | any honesty flag fired | the turn disclosed a defect about itself |
| `delivered` | an authored artifact exists (corpus row / read-back) | the turn produced a deliverable |

- **Deterministic.** Zero initial weights, fixed iterations, L2 — the same corpus always yields the same
  coefficients, so a report cannot drift run to run.
- **It refuses to fit below the floor** (`MIN_LABELS_FOR_FIT = 20`, `MIN_PER_CLASS = 5`). With too few
  rows, or only one class, it returns a **named reason** and no model. A probability printed from three
  rows is exactly the plausible-looking number this programme exists to remove.
- **Read-only, by construction.** `model explain` is the only caller. Nothing in the router imports it; a
  fitted number that moved a routing decision would be the original defect one layer up.
- **Surfaced** as a new `model explain` section: the pair's own rated record (`👍 9 / 👎 3 (n=12, 75%)`)
  and the harness-level fit (or the honest "NOT trained — only N labelled turn(s)").

As of this bundle the corpus on this machine holds **0 labelled turns** (60 traces, none rated), so the
section prints the not-trained line — which is the correct, measured output, not a placeholder.

**Two read-only surfaces, one source (Bundle 32).** `acceptanceSummary()` is the single summary both
surfaces render: CLI `nuvira rate --stats` (labels, class balance, provenance, per-pair, fit status) and the
dashboard Trace tab's **Acceptance (read-only)** card (`GET /api/acceptance`). Neither can describe the
corpus differently from the other, and neither routes.

**Seeding stays the user's job.** The corpus is filled by real verdicts — a human rating a turn, or the
tier-3 behavioural inferences — never by the harness rating turns on the user's behalf. Auto-labelling
would fabricate the very ground truth the fit is supposed to measure, which is the hand-written-vocabulary
defect one layer up.

**The corpus is portable, both ways (Bundles 33–34).** `nuvira rate --export [path] [--format json|csv]`
writes the SAME labelled turns a fit here reads; `nuvira rate --import <file>` merges one back (deduped by
trace, idempotent), and the dashboard Trace card offers the same Export/Import. Imported rows live in their
own store so a fit reads them without the harness inventing a local trace, and a local trace for the same
id wins. `scripts/fit-acceptance.mjs` fits an exported file OFFLINE with the identical deterministic model
— no live store, no network, no model. `formatAcceptanceSummary` is the SINGLE renderer for all three
surfaces — `nuvira rate --stats`, `model explain` (focusing the decision's own pair via its `focusPair`
argument), and the dashboard card — so they cannot describe the corpus inconsistently.
