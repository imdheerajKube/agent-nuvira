# DESIGN — Capability by measurement (Bundle 3, B1–B5)

**Status: proposal, awaiting sign-off. Nothing here is implemented.**

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

## 4. What has to be built (the wiring)

1. **`CapabilityRecord`** on the registry: the five parameters, a sample count each, the tier, and the
   `source` confidence the registry already uses. Durable across processes (the registry is).
2. **Observation wiring.** One place per completed turn computes the observation set from evidence
   that already exists (`TurnReport.verification`, executed `ok` actions, the honesty flags, tokens,
   latency, `userAccepted`) and calls `recordOutcome(..., outcomeData, ...)` with a REAL payload —
   replacing today's `undefined` — plus a per-model capability update.
3. **`recordOutcome` stops discarding `outcomeData`** for the provider arm and the model arm.
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

## 6. Open questions for sign-off

1. **Parameter weights** — how much does each of the five move the final rank? The sample JSON gives
   equal-looking weight; I would keep them explicit and tunable rather than equal-by-accident.
2. **`ecosystem`** — accept the split above (measured tool-calling + declared catalog facts), or drop
   it from the measured set and treat it as static metadata only?
3. **`MIN_SAMPLES_FOR_EVIDENCE`** and the prior's decay rate — these decide how long a wrong static
   can outrank evidence. They need a stated default (I would use 5 samples and a linear decay).
