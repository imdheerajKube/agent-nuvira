# RCA — a broken app was called "ready for use", and a no-op turn reported success

**Status:** §6.1–§6.6 and §6.8 are **implemented and covered by tests**; §6.7 is not implemented, and its premise was found to be wrong (§6.7 records the corrected cause). See §7 (and **§7.2** for the follow-up that put the derived census on the dashboard and the CLI) for the change list and evidence. §6.8 was found by the user *after* the first round of fixes, by reading the dashboard's Requests panel.

**Trigger.** A user attached a project (`/tmp/nuvira_test/nuvira_first` — a "zero-dependency local RAG document repository") to `agent-nuvira` and asked two questions.

1. *"what's the state of this project?"* → `trace-1791521454725-e7s5ew`, `success: true`, verdict **accepted** by the user.
2. *"…I found few bugs — 1. add document button doesn't work… 2. settings button doesn't respond… 3. how do I configure LLM provider… it appears just a demo webpage with no functionality!!"* → `trace-1791521608671-1bjnfa`, `success: true`, `outcome.kind: "acted"`, turn report `not-applicable`, verdict **rejected** by the user.

Turn 1 called it **"a stable, working state… ready for use or further development."** Turn 2 delivered the model's own working notes as the answer, changed nothing, and was recorded as a success.

---

## 1. The findings in one line

**The app was broken in exactly one place — and that place was invisible to everything the agent looked at.** `server.js` serves `/` and the five `/api/*` routes, so the browser's `import … from "./app.js"` 404s and **every control on the page is dead** — the Add Document button, Settings, Ask, Clear. The turn-1 check (`npm test` + `README.md`) could not see it: the 18 tests cover `retriever.js` only, and the README's route table lists no `/app.js`.

Turn 2 was worse than unhelpful: it was **silently answered by a 0.5-billion-parameter local model**, and the product's own signals — `success: true`, `kind: "acted"`, `verification: "not-applicable"`, a green `checksPassed` — all said the turn was fine.

---

## 2. Evidence

### 2.1 The ground truth of the tested app

```
GET /            -> 200  (12,050 bytes; contains `<script type="module"> import … from "./app.js"`)
GET /app.js      -> 404  {"error":"Not found"}      <-- the module the page imports
GET /public/app.js -> 404
GET /api/documents -> 200
node --test      -> tests 18 | pass 18 | fail 0     <-- all of retriever.js
```

Reproduced directly against the published artifact: `server.js` routes only `/`, `/api/documents`, `/api/documents/:id`, `/api/ask`. There is **no static-file route**, so the ES-module import fails, the inline `<script type="module">` never executes, and no `addEventListener` is ever attached. One missing route explains all three user-reported symptoms; the "drag-and-drop / selectbox" item is a feature request layered on top.

The 18 tests pass, and passing them proves nothing about any of it: `package.json` `test` is `node --test` against `retriever.test.js` — a chunker/BM25 unit suite.

### 2.2 Turn 1 — a green signal generalised into a product verdict

| Signal | What the agent did | What it proves |
|---|---|---|
| `list_dir .` | ran | the folder exists |
| `read_file README.md` | ran, first 20 lines | the README makes claims |
| `run_terminal npm test` | ran, exit 0 | **`retriever.js` behaves** |
| `public/app.js`, `index.html`, `server.js` | **never opened** | — |
| the server | **never started** | — |

The turn report it produced:

```json
{ "verification": "not-applicable", "checksPassed": true,
  "toolCalls": ["list_dir","read_file","run_terminal","suggest_followups"],
  "summary": null }
```

`checksPassed: true` is derived from *"a verification tool ran and nothing failed"* (`src/learning/turn-report.ts:275-277`) — i.e. from one exit code. It cannot tell **the check that matters** from **a check**, so a green unit suite is booked as "the turn's checks passed", and the prose then upgrades that to *"the project is in a stable, working state… ready for use."*

The honesty machinery that exists is all **action-shaped** (`unverifiedActionClaim`, `unverifiedEdit`, `unverifiedBuildClaim`, `undeliveredArtifact`, `noActionTaken`, `unverifiedFileClaim`, `artifactShortfall`). **Nothing covers a claim about a system's health.** Here the turn mutated nothing, delivered nothing, and claimed nothing it had failed to do — so every flag was correctly absent, and "ready for use" was free.

### 2.3 Turn 2 — a no-op that reads as work

Two steps, served by **two different models**:

| # | Pair | Out | Latency | Produced |
|---|---|---|---|---|
| 1 | `gemini/gemma-4-31b-it` | 220 tok | **50,221 ms** | the leaked working notes (below), plus a `read_file` call |
| 2 | **`local/qwen2.5:0.5b`** | 126 tok | 5,946 ms | *"Here is the provided code with the example suggest_followups call commented out…"*, plus a `suggest_followups` call |

The delivered answer — verbatim, and what `~/.nuvira/cache.json` stores under scope `/tmp/nuvira_test/nuvira_first`:

```
The user is reporting three main bugs/issues with the project:
1.  "Add document" button doesn't work…
…
I need to investigate the frontend code (`public/app.js`) and the backend code (`server.js`, `retriever.js`)…
Plan:
1.  Examine `public/app.js`…
2.  Check `server.js`…
3.  Analyze the "Settings" functionality…
4.  Look for LLM configuration logic…
Let's start by reading `public/app.js`.
```

What actually happened, from the trace:

| Event | Reading |
|---|---|
| `read_file {path: public/app.js}` — ran | the turn's only real step; **no edit, ever** |
| `suggest_followups {followups:[{"prompt":"This is a sample text.",…}]}` — "ran", *"Recorded 1 follow-up suggestion(s)"* | filler **invented by the 0.5B model** (the string appears nowhere in this repo — there is no schema example to echo), counted as a **successful tool call** |
| `model detour — 1 of 2 step(s) ran on a pair other than the run's own (gemini/gemma-4-31b-it): local/qwen2.5:0.5b ×1` | the substitution was **detected and logged as an audit note** — and nothing else. No user-visible notice, no flag, no downgrade of the verdict. |
| `turn report — not-applicable` | no flag fired, so the report had nothing to say |
| `success: true`, `outcome.kind: "acted"` | `acted` because *a tool ran* (`src/learning/reasoning-trace.ts:940`) |

So the answer was the model's thinking, the work was zero, and **the product's own accounting agreed it had succeeded** — which is why the chat box re-enabled.

### 2.4 The weak-model substitution was allowed, and silent

`local/qwen2.5:0.5b` is *not* agentic capable — `isAgenticCapableModel` rejects it via the ≤4B tag rule (`src/learning/model-harness.ts:158`). The failover walk does not drop it; by design it is kept as a last resort and the walk **logs a warning and continues**:

```ts
if (!isAgenticCapableModel(next.model, next.type)) {
  const notice = weakRouteNotice(…) ?? `⚠️ no agentic-capable model left — falling back to …`;
  logger.warn(`   no agentic-capable model left — ${notice}`);
}
```

(`src/cli/chat.ts:3763`.) The stated contract in the code above it is *"say so ONCE so a degraded answer is never mistaken for a real one"*. On this surface the notice reached **the console log only** — the dashboard user was told nothing, the answer carried nothing, and the trace said `success`. The 50-second `gemma` step and the free-tier quotas on the machine make a mid-turn 429 the likely trigger.

---

## 3. Why each existing guard missed

This is the part worth keeping: **the guards are not missing, they were narrowly bypassed.** Each miss is a specific, removable gap.

### 3.1 The reasoning-leak detector — three independent misses, all real

`detectAnswerQualityFailure` is wired into the chat loop (`src/cli/chat.ts:3607`) and the loop engine (`src/cli/loop-executor.ts:1006`). The leaked reply's **first line** is `The user is reporting three main bugs/issues with the project:`. The high-precision opener pattern listed `asking|planning|…|describing|said|asked|asks|wants|…` — **`reporting` was not in it.** The one verb that would have caught it.

Two further misses would have compounded it:

- `looksLikePlanningNarration` refuses any reply over **240 characters** (`src/inference/tool-call-utils.ts:266`); the leak is 986.
- A step that carries tool calls is judged `highPrecisionOnly`, which short-circuits the weaker signals — and this step **carried `read_file`**.

The opener branch is checked *before* the `highPrecisionOnly` short-circuit, so closing the verb gap fixes this case even on a tool-carrying step. **Shipped — see §6.1.**

### 3.2 The zero-action gate — blocked by `read_file`

`noActionTaken` fires on *"a request that DIRECTED work on the workspace was answered with nothing at all"*:

```ts
if (!hasProductiveAction(progress) && progress.mutatedPaths.length === 0 &&
    requestRequiresWorkspaceAction(askText, …)) result.noActionTaken = true;
```
(`src/tools/tool-loop.ts:3905`.)

The ask **was** recognised as a workspace request — it pairs the edit verb `add` with the code noun `bugs` (`WORK_EDIT_VERB_RE` × `CODE_NOUN_RE`, `src/tools/tool-loop.ts:3985`). `mutatedPaths` was empty. The single term that failed was `!hasProductiveAction`:

```ts
const NON_PRODUCTIVE_TOOLS: ReadonlySet<string> = new Set(['suggest_followups']);
function hasProductiveAction(progress) {
  return progress.successfulToolCalls.some((name) => !NON_PRODUCTIVE_TOOLS.has(name));
}
```

**`read_file` counts as having done something.** The repo's own test locks this in: *"does NOT fire when a tool already succeeded (a read-only answer)"* asserts `noActionTaken` is `undefined` for a workspace ask after one `read_file` (`tests/tools/tool-loop.test.ts:2224`). For a request that *requires a change*, a read is not an action — but the predicate cannot tell the two requests apart.

### 3.3 The dangling-promise flag — exempted by the answer's own shape

```ts
if (result.successfulToolCalls.length === 0 && detectUnfulfilledIntentPromise(result.content))
  result.unfulfilledPromise = true;
```
(`src/tools/tool-loop.ts:3788`.)

The reply literally ends **"Let's start by reading `public.app.js`."** — a textbook imminent first-person promise. It was excluded twice over:

- `successfulToolCalls.length === 0` was false (`read_file` succeeded);
- `detectUnfulfilledIntentPromise` returns `false` for any reply containing a list — `LIST_STRUCTURE_RE` (`src/tools/tool-loop.ts:3491`), a rule meant to stop real plans from being mislabelled, which exempts precisely the shape *"I wrote a plan and stopped"*.

### 3.4 The report and the outcome inherit all of it

`buildTurnReport` (`src/learning/turn-report.ts:227`) derives its verdict from those flags. With none set and no mutation, the ladder lands on `not-applicable` and `summary: null`. `buildTraceOutcome` (`src/learning/reasoning-trace.ts:940`) returns `acted` because tools ran. `success` follows the outcome. **Every downstream signal is a faithful join of upstream flags — so one missing flag becomes a clean chit on every surface at once.**

---

## 4. The chain, end to end

**Turn 1.** No static route serves `app.js` → the page's module import 404s → all UI handlers dead. The agent never opened the frontend, never started the server, never fetched an asset. It ran a unit suite, read a README that does not mention `/app.js`, and generalised a green *library* signal into a *product* verdict. `checksPassed: true` ratified it.

**Turn 2.** The ask is a bug report in user language. The router picks `gemma-4-31b-it`; step 1 takes **50 seconds** and returns the model's working notes plus a `read_file` call. The quality detector misses on the one uncovered verb. The step is mid-turn rate-limited; the failover walk falls to `local/qwen2.5:0.5b`, warns on **the console only**, and continues. That model echoes the `suggest_followups` schema example, which is recorded as a **successful action**. The loop ends with `read_file` + `suggest_followups` as its evidence. `noActionTaken` is blocked by the read, `unfulfilledPromise` by the read and by the answer's list, and no flag covers "the answer is thinking". Outcome `acted`, `success: true`, report `not-applicable`, chat re-enabled.

---

## 5. What this is, in one sentence

**The product verifies that *tools ran*, not that *the request was satisfied* — and it can be talked into a favourable verdict by a tool that did nothing, while a model too weak to do the work is substituted in silently.**

---

## 6. Remediation plan

Each item names the observable it changes, so it can be tested rather than asserted.

### 6.1 SHIPPED — the reasoning-leak opener gap

`HIGH_PRECISION_OPENERS` (`src/inference/tool-call-utils.ts:171`) now covers the **reporting family** — `reporting|explaining|complaining|flagging|noting|outlining|inquiring|mentioning` (and the matching past/bare forms). Opener-branch behaviour is unchanged for tool-carrying steps, and the reply that shipped is now rejected before it can be delivered.

*Acceptance:* the verbatim live reply is flagged, with `highPrecisionOnly: true` and with a `read_file` tool present; the existing "does NOT flag a real answer" corpus stays green. Regression tests added in `tests/inference/tool-call-utils.test.ts` (the live text is a `REAL_LEAKS` entry plus a tool-carrying case). Verified: `tsc --noEmit` clean; **322 files / 5,792 tests pass** across `tests/inference tests/tools tests/agents tests/learning tests/cli`.

### 6.2 Make a change-requiring ask require a change (highest value)

Add a flag distinct from `noActionTaken` — call it **`undeliveredChange`** — firing when the request directed *a change* to the workspace and the turn **mutated nothing**: the edit-shaped sibling of `undeliveredArtifact`, which already does this for authored deliverables.

- Do **not** weaken `hasProductiveAction` (it is test-locked and correct for read-only asks); add the predicate beside it, keyed on `requestRequiresWorkspaceAction` **plus an edit verb**, and exclude asks satisfied by reading (`requestForbidsWrites`, `replyAsksTheReader`).
- Add it to `UNFINISHED_FLAGS` (`src/learning/turn-report.ts:56`) and to the `incomplete` set in `buildTraceOutcome` (`src/learning/reasoning-trace.ts:932`), so the verdict, the report, the trace outcome and the cache-honesty gate all move together.

*Acceptance:* the exact turn-2 tool set (`read_file` + `suggest_followups`, no mutation) over the exact turn-2 ask yields `undeliveredChange: true` → `verification: unverified`, `outcome.kind: incomplete`, `success: false`. The existing read-only test still passes.

### 6.3 Treat "the answer is a plan" as unfinished, not as a plan-shaped exemption

`detectUnfulfilledIntentPromise`'s list exclusion exists to protect real deliverables. Narrow it: an answer whose **whole** body is plan-shaped (no completion claim `COMPLETION_CLAIM_RE`, no fenced block, ends on an imminent first-person promise) is a **dropped intent**, list or not. And drop the `successfulToolCalls.length === 0` gate for the case where the only successful tools are read-only and the ask required a change (§6.2 already covers the mutation side).

*Acceptance:* the verbatim turn-2 answer yields `unfulfilledPromise: true`; the existing negatives — a genuine plan *followed by* work, and a prose answer that stops — stay false.

### 6.4 Never let one green exit code be read as "checks passed"

`checksPassed` is `observed && !checksBroke` (`src/learning/turn-report.ts:277`). Either (a) scope it to checks that are **consequential for this ask** (a change asked for and never observed ⇒ `checksPassed` must not be `true`), or (b) rename it to what it measures (`aVerificationToolRanClean`) and stop rendering a green check beside a `not-applicable` verdict. (a) is the fix; (b) is the minimum.

### 6.5 Make the weak-model substitution user-visible and verdict-bearing

The "say so ONCE" contract currently lands in `logger.warn`. Carry it as **recorded evidence**: a `TurnReport` assumption line ("answered by `local/qwen2.5:0.5b` — no agentic-capable model was reachable"), an `outcome` field the Trace tab renders, and — when the substituted pair is not agentic-capable — a **downgrade of the turn verdict**. A degraded answer must not be able to present as a full one.

*Acceptance:* any turn with a non-agentic-capable detour carries the notice in its answer, its report and its outcome; a turn whose only served model is not agentic-capable cannot be `verification: not-applicable` with a clean summary.

### 6.6 Close the assessment gap that produced turn 1

The honesty flags are action-shaped; an **assessment** answer has no guard at all. Two concrete, cheap rules:

- **A capability claim requires an observation.** "works / ready for use / fully implemented" must be backed by the turn having *exercised the artifact through its user-facing interface* — for a web app: start it, fetch `/`, fetch the assets the page requests, hit one route. Add it as a deliverable-class (`wantsHealthVerdict`) with the same flag mechanics, so an unbacked claim becomes `unverified` rather than a clean answer. This is the same doctrine `verificationExercisedArtifact` (`src/tools/edit-verification.ts:170`) already applies to edits — it just does not reach an *assessment* ask.
- **Never generalise a unit suite to a product.** When the ask is about project state/health and the only verification ran a test script, the report should say so: `checksPassed: true` beside "18/18 unit tests (`retriever.js`)" and **not** beside a product verdict.

*Acceptance:* a replay of turn 1 ("what's the state of this project?" against a repo whose `/app.js` 404s) cannot end in `verification: not-applicable` with an unqualified "ready for use" — it must either exercise the running app or report the claim as unbacked.

### 6.7 Cheapest guards — one done, one deliberately NOT done

- **Make a tool-carrying step's text judged, not just its calls.** `highPrecisionOnly` is right to protect *narration before a call*; it should not protect a **long** reply whose first line narrates the user. **Done for this family in §6.1**; a length-bound generalisation remains open, because a 240-char cap cannot distinguish a long narration from a long answer.
- **Surface the detour in the trace's own verdict.** `model detour` was purely informational; **done in §6.5** — a non-agentic detour now records a `degraded` event, a `degradedBy` outcome and `success: false`.
- **Reject "placeholder" tool arguments — NOT implemented, and the reason is the finding.** The original plan was to reject a call whose arguments equal the schema's published example. **That premise was wrong:** the string `This is a sample text.` appears nowhere in this repository, and `suggestFollowupsSchema` (`src/tools/registry.ts:706`) carries no example. The filler was **invented by the 0.5B model**, so there is nothing principled to match against — a phrase list for plausible filler is exactly the anti-pattern this programme removes. The concrete harm is already closed without it: `suggest_followups` is in `NON_PRODUCTIVE_TOOLS` (`src/tools/tool-loop.ts`), so it never counted as productive work for any gate, and §6.5 means a turn a 0.5B model served can no longer report success.

---

### 6.8 The dashboard's Requests panel vouched for the model — a counter-signal

**Found by the user, after the fixes above.** The Requests page showed:

```
💬 chat    local    qwen2.5:0.5b          4 requests   0.0% error rate
💬 chat    gemini   gemini-3.1-flash-lite  9 requests   0.0% error rate
⚙️ execute local    qwen2.5:0.5b          4 requests   0.0% error rate
```

**`0.0%` is not a measurement of quality.** The panel counts a failure as
`outcome !== 'verified' && outcome !== 'partial'`, and `recordRegistrySuccess`
writes `verified` — which means *the provider answered*, not *the answer was
usable*. Worse, on the chat path that call site was reached
**unconditionally** (`src/cli/chat.ts`), with no quality gate and no latency, so
the weak model's unusable reply counted as health:

1. **The panel vouched for the model that produced the poor result** — the exact
   counter-signal the user was right to question.
2. **Routing was rewarded for it.** `verified` is what marks a pair good for real
   usage, so the same turn that exposed the 0.5B model also *promoted* it.

The `verified` outcome had no way to express "answered, but unusably": the
error classes were `auth | rate-limit | server | network | timeout |
empty-response | credit-exhausted | unknown` (`src/learning/provider-fallback.ts`),
and a rejected reply matched none of them. `empty-response` and
`credit-exhausted` were each added for exactly this reason ("otherwise it books
as `unknown` and taught the router nothing"), so the fix follows that precedent:

- **`quality-rejected` is now its own class**, recognised from the answer-quality
gate's own wording (`"… instead of the task"`), deliberately absent from
`TRANSIENT_RETRY_TYPES` (re-asking the same pair reproduces the same reply) and
retryable on a different provider, so the failover walk is the remedy.
- **The chat call site no longer writes `verified` for a pair that cannot hold the
task.** It books a `quality-rejected` failure instead — gated on the turn having
actually needed agentic work (it called tools), because a tiny local model
answering a *plain* conversational turn is not a quality failure and booking one
would invent a false signal in the other direction.

Because both loop engines already route a quality failure through the failure
path, this classifies it everywhere at once: the Requests error rate reflects it,
and the pair is no longer promoted for producing an unusable answer.

**Closed (§7.1):** the panel's latency columns used to read `—` for these rows
because the chat path passed no `latencyMs` to the recorder (the per-step latency
existed in the trace, not in the action log) — a measurement gap, not a verdict
bug. The chat path now sums the per-call durations it already measures
(`turnModelMs`) and passes them to both registry writes, so the panel receives
the turn's MODEL time instead of nothing.

---

## 7. The change list (what was implemented)

| § | Change | Where | Evidence |
|---|---|---|---|
| 6.1 | The reporting verb family added to the high-precision reasoning-leak openers | `src/inference/tool-call-utils.ts` (`HIGH_PRECISION_OPENERS`) | The verbatim live reply is flagged, with and without a tool call; the good-answer corpus stays green |
| 6.2 | New `undeliveredChange` flag: a change was asked for, nothing was mutated, a plan was delivered | `src/tools/tool-loop.ts` (`requestRequiresWorkspaceChange`, `answeredWithAPlanInsteadOfWork`); `src/learning/turn-report.ts`; `src/learning/reasoning-trace.ts`; `src/cli/chat.ts`; `src/cli/loop-executor.ts` | The live ask + live reply yields `undeliveredChange: true`, `noActionTaken: undefined` |
| 6.3 | The dangling-promise **nudge** now also fires when a change was asked for and the answer is a plan/promise after reads | `src/tools/tool-loop.ts` (the bounded nudge) | The live turn spends one extra model step asking for the work instead of delivering the plan |
| 6.5 | A non-agentic-capable pair that served a step **downgrades the turn**: `degradedBy` on the outcome, a `degraded` decision event, `success: false` | `src/learning/reasoning-trace.ts` (`endTrace`, `traceOutcomeSucceeded`) | `local/qwen2.5:0.5b` flips `success` to false and `traceOutcomeSucceeded` to false; an agentic-capable detour is untouched |
| 6.6 (+6.4) | New `unbackedHealthClaim` flag: the answer vouched for the product while nothing exercised it | `src/tools/tool-loop.ts` (`detectUnbackedHealthClaim`, `EXERCISES_PRODUCT_RE`) | The turn-1 shape (`npm test` + "ready for use") is flagged; the same verdict after `npm start` is not |
| 6.7 | The `highPrecisionOnly` opener family (6.1) and the detour verdict (6.5); the argument matcher deliberately NOT built — see the corrected cause above | — | — |
| 6.8 | New `quality-rejected` error class; the chat path no longer records `verified` for a pair that cannot hold the task | `src/learning/provider-fallback.ts` (`FallbackErrorType`, `classifyFallbackError`); `src/cli/chat.ts` | The gate's own error wording classifies as `quality-rejected`; not retried in place, retryable elsewhere |

**Verification:** `tsc --noEmit` exit 0; the **full suite 494 files / 8,837 passed / 19 skipped**, exit 0 (baseline 8,824 / 19 — the delta is the new regression tests, with no failures); docs guards (`docs:commands:check`, `docs:wire:check`, `tests/docs`) green.

### 7.1 The four gaps in the first report — and what happened to each

The first pass listed four "remaining gaps". All four were then addressed:

| Gap | Resolution |
|---|---|
| **Latency read `—`** for every chat row | **Fixed.** The chat path now sums the per-call durations it already measures (`turnModelMs` in `src/cli/chat.ts`, accumulated in `callModelWithTrace`) and passes them to both registry writes, so the panel receives the turn's MODEL time instead of nothing. |
| **Historic rows stayed `verified`** | **Corrected, read-only — and deliberately NOT by rewriting the log.** The action log is hash-chained (`appendChainedRecordFast` / `rechainRecords`) and its `origin` is only `live` / `test` (with `aggregateActionTelemetry` excluding `test`), so an appended "correction" would be indistinguishable from a real provider call — inventing an event to fix a display is the defect class this programme exists to remove. Instead `degradedCallsFromTraces` (`src/learning/reasoning-trace.ts`) **derives** the truth from the traces, which record the served pair per step. Run against the live store it reports **`local/qwen2.5:0.5b` — 10 steps across 6 traces**, i.e. the panel's "4 requests" undercounted a much wider pattern. |
| **No dashboard badge** for the new verdicts | **Fixed**, by rebuilding the committed bundle rather than leaving it stale: `undeliveredChange` / `unbackedHealthClaim` chips in the turn report, a **`degradedBy` badge that sorts first** in `outcomeBadge` (it explains every other badge on the turn), and the mirrored types. `npm run dashboard:bundle:check -- --rebuild` reports *"committed bundle matches a fresh build (4 files)"*. |
| **The 240-char cap** could not tell a long narration from a long answer | **Fixed.** The cap was removed: it treated "long" as "an answer", so the 986-character live leak was never judged. The four content guards (fence / completion claim / structure / question back) already prove a deliverable, and the check is now anchored to the FIRST LINE so a reply that merely mentions a search still is not flagged. A regression test pins a >240-char narration as caught, and the existing long-answer negative stays green. |

**Still open, deliberately:** §6.4's rename option (the flag now precedes the green check, which is the substantive fix). The `degradedCallsFromTraces` surface named below as the natural next step is now **done** — see §7.2.

### 7.2 The derived census, made visible (the next step §7.1 named)

`degradedCallsFromTraces` shipped in §6.8 as a tested library function whose
census was only ever run by hand. It is now consumed by the two surfaces a
reader actually uses, so the `0.0%` that vouched for the weak model is qualified
wherever it is read:

| Surface | Change | Where |
|---|---|---|
| **Requests panel** | A `⚠️ degraded` chip on every action row of a pair the traces derive as non-agentic-capable, a danger tile counting the pairs, and a banner naming them with step counts — rendered **beside** the unchanged (still `0.0%`) error rate, because the measurement is *qualified*, never rewritten | `src/web-dashboard/server.ts` (`readRequestsData`), `src/web-dashboard/src/types.ts` (`RequestsInsights.degraded`), `src/web-dashboard/src/components/RequestsPanel.tsx` |
| **CLI** | `nuvira trace degraded [-l <n>]` prints the same census, read-only, and says plainly that it is derived rather than written back | `src/cli/trace.ts` |

So the dashboard can consume the SAME census logic rather than reimplementing
it, `degradedCallsFromTraces` now takes a structural `DegradedCallsInput` (`id`
plus `steps[].provider`/`model`) instead of a full `ReasoningTrace` — the server's
own trace reader feeds it with no second file read, and the Requests and Trace
panels cannot disagree about which pairs served.

*Acceptance:* `GET /api/requests` carries `degraded: [{ provider, model, steps, traces }]`
derived from the traces, while the weak row's `errorRate` stays `0` (the log is
tamper-evident, so the truth is derived, not appended). Covered by
`tests/web-dashboard/requests-degraded-api.test.ts`, the panel's degraded/clean
cases in `RequestsPanel.test.tsx`, and `tests/cli/trace.test.ts`.

**Verification:** `tsc --noEmit` exit 0 (root and dashboard); `npm test` **498 files /
8,844 passed / 19 skipped**, exit 0; `npm run test:dashboard` **52 files / 1,067
passed**; `docs:commands:check` and `dashboard:bundle:check` green (the committed
bundle was rebuilt, and `nuvira trace degraded` was added to the curated
`docs/COMMANDS.md` so the coverage guard stays satisfied).

---

## 8. The rule this incident argues for

Stated once, because it generalises past this incident:

> **A verdict may only be derived from evidence that the request was satisfied — never from evidence that *something* ran.** Every green signal must name the question it answered. "18 tests passed" answers *"does `retriever.js` behave?"*. It does not answer *"does the product work?"*, and the product must not be able to print the second from the first.
