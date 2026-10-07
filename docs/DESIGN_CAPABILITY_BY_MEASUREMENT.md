# DESIGN — Capability by measurement (Bundle 3, B1–B5)

**Status: proposal, awaiting a decision. Nothing here is implemented.**

This document exists because Bundle 3 of `PLAN_MODEL_ROUTING_PARITY.md` is the programme's root
cause — *the router judges a model's capability from its name* — and a fix needs a measurement design
before anyone writes code. The user asked for the design first, to choose between three options. All
three are laid out below, with the data each would need and the way each can fail.

---

## 1. The defect, restated precisely

`AutoModelRouter.getModelCapabilities()` (`src/learning/auto-router.ts`, ~1371) computes a model's
REASONING and SPEED scores from:

| Evidence | Effect |
|---|---|
| Fast-tier words in the id — `mini`, `tiny`, `small`, `nano`, `lite`, `instant`, `flash`, `turbo`, `haiku` | **−0.1 per word**, +0.15 speed |
| Slow-tier words — `large`, `max`, `opus`, `pro`, `ultra`, `frontier` | +0.15 |
| Parameter size in the id — `70b`, `8b`, `3b` | +0.45 / +0.15 / +0.05; −0.2 at ≤ 4B |
| Frontier-family keywords — `gpt-4/5`, `claude-3/4`, `gemini-2`, `deepseek-r1`, `qwen3` | +0.2 |
| **Measured latency only** — `entry.latencyMs ≥ 10s` / `≤ 800ms` | ±0.1 |
| Static provider baseline — `openrouter 0.95`, `gemini 0.85`, `nim 0.72`, `groq 0.55`, `nuvira 0.50`, `local 0.30` | the starting value |

Adjustments clamp to ±0.35 and never leave 0..1. **No term is a measurement of whether the model
delivered.** The only measured input is latency. Consequently:

- **B1** — a strong model is penalised for the word `flash` in its id. The programme's own
  pre-measurement proved this the hard way: the investigator called DeepSeek V4.1 Flash weak *because
  of its name*, and the runs later showed it served the whole task ("C-2" in the tracker).
- **B2** — `openrouter (0.95)` outranks `gemini (0.85)` regardless of what either has actually done.
- **B4** — `MAX_CAPABILITY_MIN_REASONING = 0.7` is therefore a NAME threshold: `flash` + `lite` = 0.65
  fails it, a single `-flash` passes. The floor is enforced on numbers derived from spelling.
- **B3** — there is no measured quality signal anywhere.

## 2. What already exists (this matters — the design is mostly WIRING)

The measurement scaffold is largely built. What is missing is that nothing POPULATES it.

### 2.1 The bandit already has a quality reward model

`src/learning/router-bandit.ts`:

- `BanditOutcomeData` (line ~34) carries **`qualityScore`**, **`testPassed`**, **`userAccepted`**,
  **`verificationPassed`** — exactly the "delivered? verified? retried? user-corrected?" signals B3
  asks for.
- `applyReward()` (~374) already folds them in: a successful arm's reward is adjusted by
  `(qualityScore − 0.5) × 0.2`, `−0.1` when `testPassed === false`, `−0.1` when
  `userAccepted === false`, `−0.08` when `verificationPassed === false`, clamped to 0.1..0.9.
- Learning is bucketed per **provider arm AND per-model arm** (`recordOutcome`,
  `recordModelOutcome`, `recordOutcomeWithComplexity`, `recordModelOutcomeWithComplexity`), and
  bucketed by task intent so a coding win cannot leak into a creative prior.
- It is **ON by default** (`routing.bandit !== false`), and cold start is deterministic
  (Beta(1,1) samples its own mean), so nothing randomises an unlearned ranking.

### 2.2 The real outcome path passes `undefined` for all of it

- `AutoModelRouter.recordOutcome(...)` (`auto-router.ts` ~2744) accepts `outcomeData` and forwards
  **`undefined`** to both the provider and the model arm (~2762/2764).
- Its only live caller, the orchestrator (`agents/orchestrator.ts` ~3324), also passes `undefined`,
  and its outcome is the binary `result.success ? 'success' : 'failure'` — i.e. *"the agent did not
  throw"*. That is the D2 defect again, one layer down: a useless response is a success.
- `outcomeData` is forwarded intact only to the **promotion gate** (~2782), never to the reward.

So `BanditOutcomeData.qualityScore` / `testPassed` / `userAccepted` / `verificationPassed` are
**dead on the real path**. The reward is a cost-adjusted coin flip.

### 2.3 The harness already DERIVES every signal the reward wants

The programme has spent the last several bundles building exactly the replayable evidence a quality
score needs. None of it is wired to the router:

| Signal | Where it is derived today | Trust basis |
|---|---|---|
| `verificationPassed` | `TurnReport.verification` ∈ `verified` / `unverified` / `blocked` / `not-applicable` (`learning/turn-report.ts` `buildTurnReport`) | Derived from recorded tool + plan evidence, never the model's narration |
| `testPassed` | `ExecutedAction[]` with `ok` (the within-turn work digest, `buildWorkDigest`); honesty flags `unverifiedBuildClaim`, `unverifiedEditClaim`, `undeliveredArtifact`, `unfulfilledPromise`, `noActionTaken` | Recorded from real command outcomes |
| `userAccepted` | The next-turn correction signal (`learning/working-state.ts`), followup rejection, dashboard `chatRespond` feedback | Observed user behaviour |
| `qualityScore` | **Must be built.** Candidate inputs: did the turn produce a productive tool call (`countProductiveWork`), did it deliver an artifact (`undeliveredArtifact`), was the response a bare acknowledgment (`isBareAcknowledgment`), retry count, and — the D2 case — an empty or content-free response | Recorded turn facts, not prose judgement |
| Availability/health | `ModelRegistryEntry` already carries `errorRate`, `partialRate`, `latencyMs`, `measuredInput/OutputTokens`, `contextWindowTokens`, `deadPair`, `quotaParkedUntil`, `status`, `source` | Real calls; `source: telemetry` vs `spot-check` already distinguishes evidence strength |

The registry (`learning/model-registry.ts`) is the durable, per-pair home for this — it already stores
health and cost per `provider × model`, and already has a source-confidence hierarchy.

## 3. The three options

### Option A — Measured outcomes only, statics decayed

Rank by the per-pair recorded outcomes; the static `BUILTIN_PROFILES` and the id-substring hints
decay toward zero influence as samples accumulate.

- **Data needed:** the four signals above, wired into `recordOutcome`, plus a per-pair quality EMA.
- **Pros:** the defect is gone by construction — no term is spelling-derived once evidence exists;
  the acceptance criteria for B1/B2/B3 become testable directly.
- **Cons:** an unmeasured pair becomes an unknown, and cold start gets *worse* before it gets better.
  A provider can look terrible from one unlucky call and good from one lucky call. Requires a
  minimum-sample threshold and a decay schedule that nobody can validate without production data.
- **Failure mode:** thin data on the exact pair the user needs → the router flip-flops.

### Option B — Blended prior: outcomes over a static floor  *(recommended)*

Keep the static baselines as a **cold-start prior**, and let measured outcomes override them as they
accumulate. Concretely: the profile value is a prior with weight `w₀`; each recorded outcome is an
observation; the ranking value is the posterior mean, and `w₀` decays as samples grow. The id-substring
adjustment is **removed entirely** and replaced by "no evidence ⇒ prior unchanged".

- **Data needed:** the same as A, plus an explicit sample-count field per pair (the registry already
  has `measuredSamples` for tokens; the bandit already tracks arm counts).
- **Pros:** no cold-start cliff; no flip-flop on thin data; the defect is still fixed because the
  id-substring terms are gone and the statics can never outrank real evidence once it exists.
- **Cons:** a prior that is wrong stays wrong a little longer than under A. Two providers with equal
  measurements still differ by prior — so B2's acceptance ("two providers with equal measurements
  rank equally") holds only in the limit. **This must be stated honestly, not hidden.**
- **Failure mode:** the prior set is never decayed "because it works", silently re-creating B2.

### Option C — Outcomes plus a hard-capped name hint

Measure outcomes, but keep the id-substring hint as a weak tiebreaker with a small, documented
maximum influence so it can never outrank evidence.

- **Pros:** smallest behavioural delta; nothing regresses on day one.
- **Cons:** keeps the exact defect the bundle exists to remove, in weakened form. The programme's
  stated doctrine is that no fix may be a name judgement; a capped name hint is still one. Any cap is
  arbitrary.
- **Verdict:** should be rejected unless the user wants the smallest possible change.

## 4. Recommendation

**Option B**, with the id-substring adjustment removed rather than capped. Reasons, in order:

1. B1 and B4 are name defects; only removing the term actually fixes them. Option C merely makes the
   name defect smaller.
2. The scaffold already exists (§2), so B is mostly wiring: populate `BanditOutcomeData` from
   `TurnReport` + the executed-action ledger, and stop passing `undefined`. That is a reviewable,
   testable change, not a research project.
3. It gives B2/B3 a real signal without inventing a scale: `verificationPassed` and `testPassed` are
   booleans the harness already derives from recorded evidence, so the reward cannot be talked up by
   the model — the property the whole programme is built on.
4. Cold start is already handled: the bandit is deterministic at Beta(1,1) and the resolver can only
   ever RAISE eligibility, so a prior-based fallback cannot dead-end a run
   (`R4 — agentic capability floor` already proves the never-dead-end path).

**Non-goal reminder.** No part of this may become "route to a different model". The model is held
constant on purpose (see the tracker's preamble); this bundle changes *how the harness judges* a
model, not which model it prefers.

## 5. What the design must produce, precisely

If Option B is chosen, the changes are:

1. **A quality signal per turn** (`qualityScore`), built from recorded facts only: productive work
   performed, artifact delivered, honesty flags, retry/repair count. Explicitly NOT from prose.
2. **Wiring**: `TurnReport.verification` → `verificationPassed`; executed `ok` actions →
   `testPassed`; user correction → `userAccepted`; the new score →
   `qualityScore`. Passed through `AutoModelRouter.recordOutcome(..., outcomeData, ...)` and into
   both the provider arm and the model arm, replacing today's `undefined`.
3. **A per-pair quality record** in the registry (durable across processes), with a sample count and
   the same source-confidence discipline `status` already uses.
4. **Scoring**: `getModelCapabilities()` loses the id-substring terms entirely; the profile becomes a
   prior blended with the measured record, and `MAX_CAPABILITY_MIN_REASONING` is applied to the
   blended value.
5. **B5** (complexity under-rated) is a separate calibration on `analyzeComplexity`: a 4-component
   full-stack ask classifies `moderate` today and should classify ≥ `complex`. It needs a before/after
   table of prompt → classification, not a new signal.

### Acceptance (from the tracker, restated as tests)

| # | Test that must pass |
|---|---|
| B1 | A model whose id contains `flash` is not penalised for it: two pairs differing ONLY by that word in the id score identically at equal evidence. |
| B2 | Two providers with equal measured records rank equally; a provider with a track record outranks a static baseline once its sample count clears the threshold. |
| B3 | A pair that consistently fails (failed verification, no artifact) is demoted by MEASUREMENT, and the demotion is visible in `model explain` with the sample count beside it. |
| B4 | The reasoning floor is applied to the blended value; a documented table shows which pairs pass and why, from measurements — not spelling. |
| B5 | The 4-component full-stack prompt classifies ≥ `complex` (before/after table). |

## 6. Open questions for the decision

1. **Which option** (A / B / C)?
2. **Where does `userAccepted` come from?** The dashboard can capture it; the CLI can only infer it
   from the next turn. Inferring is a name-free but *weak* signal — acceptable, or should it be
   dashboard-only?
3. **How long may a static prior outrank evidence?** Option B needs a stated decay or sample
   threshold; without one it silently becomes B2 again.
