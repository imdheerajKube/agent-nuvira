# Enterprise-Grade Agent Hardening — Project Tracker

**Goal:** close the agent-side (not model-side) capability gaps found by auditing the
last 30 reasoning traces, starting from the calculator-enhancement session
(2026-09-22, 15 turns / 99 LLM calls / 77 min).

**Source of the gaps:** `~/.nuvira/memory/reasoning-traces.json` (last 30 traces) +
`chat-sessions.json` (calculator session) + the delivered code in
`~/Documents/cal`.

**Status legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

---

## The gaps (evidence-backed)

| # | Gap | Evidence from the traces |
|---|-----|--------------------------|
| G1 | **No verification loop** — nothing ever proves an edit works | `run_terminal` / `test` / `browser` used **0 times** across 99 calls; user had to say *"please test before confirming"* mid-session |
| G2 | **"Acted" is reported as success** — a botched edit still reads ✅ | Every one of the 15 turns ended `success=true, outcome.kind=acted`; the honesty guards were scoped to *delivery* claims, so 8 consecutive false "I fixed it" lines went unflagged |
| G3 | **No regression memory** — each fix can undo the last | Turn 17's fix made the converter vanish; turn 21's broke the dropdowns; 6 rounds of "still broken" with the root cause re-derived each time |
| G4 | **No working-state / cross-turn memory** — the model re-diagnoses from scratch | Input tokens grew 2,172 → 7,317 in one session; the same root cause was flip-flopped over (turn 23 finds it, turn 25 un-finds it) |
| G5 | **Trace fidelity** — the Trace tab's "model used" was the session default, not the real per-call model; no routing snapshot | 98/99 steps stamped `gemini/gemini-3.1-flash-lite`; **0/99** steps carried a routing snapshot; token counts were `chars/4`, not `estimateTokens` |
| G6 | **Draft-quality leftover in the delivered artifact** | `index.html` had an inline `onchange` (double-binding `updateUnits`); `showTab()` dead stub; CSS styled `#conv-type`, which does not exist, while the real selects were unstyled (the "blank dropdowns" the user kept reporting) |

---

## Workstreams

### G1 — Mandatory verification gate `[x]`
- [x] `src/tools/edit-verification.ts` — `MUTATION_TOOLS`, `VERIFICATION_TOOLS`, `classifyEditActivity`
- [x] `ToolLoopProgress` classifies mutations vs verifications from *successful* calls
- [x] Bounded one-shot verification nudge on BOTH end-turn exits (no-tools **and** the concluding `suggest_followups` exit — the shape most edit turns actually use)
- [x] `ToolLoopResult.unverifiedEdit` (annotated whether or not the nudge is enabled)
- [x] `ToolLoopOptions.requireVerification` (default **on**)
- [x] Tests: `tests/tools/edit-verification.test.ts` + 5 loop tests

### G2 — Edit-claim honesty `[x]`
- [x] `detectUnverifiedEditClaim(content, mutations, verifications)` — sentence-scoped, negation/future/list aware
- [x] `ToolLoopResult.unverifiedEditClaim`
- [x] Carried through `buildTraceOutcome` → `TraceOutcome` → `types.ts` → `TracePanel` badge
- [x] Tests in `tests/tools/action-claim-honesty.test.ts`

### G3 — Regression memory `[x]`
- [x] `src/learning/working-state.ts` — per-project ledger (files, verification debt, open issues, corrections)
- [x] `detectRegressionSignal()` tuned on the user's real phrases ("still", "same issue", "i don't see any change")
- [x] Persisted to `~/.nuvira/memory/working-state.json` (honours `NUVIRA_MEMORY_DIR`)
- [x] Tests: `tests/learning/working-state.test.ts` (12)

### G4 — Working-state injection (kill context drift) `[x]`
- [x] `formatWorkingState()` → compact deterministic block (empty for a pristine project)
- [x] Injected into the model-facing thread in `chat.ts`
- [x] `recordWorkingState()` called at turn end with observed touched-file paths (from the `tool:started` event stream)
- [x] Integration tests in `tests/cli/chat-tool-loop.test.ts`

### G5 — Trace fidelity `[x]`
- [x] `chat.ts` records the **real** per-call provider/model (post-failover) via `lastAttempt`
- [x] Routing snapshot captured at resolve time (`lastRouteSnapshot`) and attached on auto turns
- [x] Token counts now use `estimateTokens()` (not `chars/4`)
- [x] Integration test asserts the trace step names the attempt's provider/model

### G6 — Fix the calculator defects `[x]`
- [x] Removed the inline `onchange` (single `addEventListener` binding remains)
- [x] Deleted the dead `showTab()` stub; extracted `activateTab()`
- [x] Styled the real selects (`#conv-category`, `#unit-from`, `#unit-to`); dropped `#conv-type`
- [x] Gated keyboard handling to the calculator tab
- [x] Hardened `calculate()` (whitelist + `Number.isFinite`) and `scientific()` (domain guards)
- [x] **Verified by execution** (the thing the agent never did): DOM-stub harness drove the real
      `script.js` — dropdowns populate (`m,km,ft,in`), 1 km→m = 1000.0000, 1 lb→g = 453.5920,
      100 C→F = 212.0000, `2+3*4` = 14, junk rejected, `node --check` clean

---

## Definition of done (enterprise grade)
1. [x] An edit turn that never verified is **impossible to mistake for a success** — trace badge + flag.
2. [x] A false "I have fixed it" line after an unverified edit is **flagged**, not trusted.
3. [x] A regression the user already reported is **remembered**, so the agent does not re-break or re-derive it.
4. [x] Each turn starts knowing what was changed, what was verified, and what is still broken.
5. [x] The Trace tab shows the **actual** model/provider per call.
6. [x] `tsc --noEmit` clean; full vitest suite green.

---

## Verification (this session)

```
npx tsc --noEmit                    → clean
npx vitest run --exclude tests/live → 309 files, 6144 passed, 13 skipped, 0 failed
npm run test:dashboard              → 27 files, 291 passed
calculator DOM harness              → all conversions + calculator cases correct
```

---

## Session 2 — orchestrator ledger, CLI warning, prompt audit

### G3/G4 — extended to the ORCHESTRATOR pipeline path `[x]`
- [x] `ProjectAssessment.workingState` + `assessProject()` reads the ledger → every agent
      (writer / reasoner / writer-tool-calling / CLI loop context) inherits it automatically
- [x] `assemblePrompt()` renders it into the CONTEXT layer (omitted entirely when empty)
- [x] `OrchestrationResult.changedFiles` (paths, deletions excluded) added in `buildResult()`
- [x] `executeCorrelated()` finally-block records the run — files, whether a verification
      agent (`test|runner|verif|audit`) succeeded, and the goal (scanned for a regression)
- [x] Tests: `tests/agents/prompt-assembly.test.ts` (4 new)

### CLI console warning `[x]`
- [x] `chat.ts` prints the unverified-edit warning to the console for every surface
      (CLI, dashboard console, gateway). Printed only — never appended to `content`,
      so the delivered answer and the answer cache stay clean.

### Two FALSE POSITIVES found by the live E2E (and fixed) `[x]`
These were bugs in the honest-accounting contract that the live re-run exposed — the
verification gate happily accepted a no-op as proof:
- [x] `run_terminal` refusals (empty command / denied / needs-confirm / routed-to-run_cli)
      returned **no `Error:` prefix** → counted as a successful run. Live: the model answered
      the nudge with a bare `run_terminal` and the turn read "verified". All four now `Error: `.
- [x] **A FAILING command** (non-zero exit / timeout / spawn error) also had no prefix →
      a red test run marked the turn "verified". Now `Error: ` while preserving the real output.
- [x] Same treatment for `run_cli`'s seven refusal paths.
- [x] Tests: 3 new in `tests/tools/run-terminal.test.ts`, 1 new loop test in `tests/tools/tool-loop.test.ts`.

### Live E2E vs the baseline session (same first prompt, fresh sandbox, gemini-3.1-flash-lite)

| | Baseline (Sep 22, 15 turns) | Hardened (this run) |
|---|---|---|
| verification tools used | **run_terminal 0** | **run_terminal reached on every edit turn** |
| edit turns flagged unverified | n/a (no such signal) | gate fires; clears only on a real successful check |
| cross-turn memory in prompt | none | working-state block injected |
| ledger | none | `working-state.json` entry per project, `turns`/`filesTouched`/`unverifiedEdits` |
| false "I fixed it" | unflagged, 8× | nudged; model now states what it could and could not verify |
| trace per-step model | session default | real attempt (pin → `routing` correctly omitted) |

Observed live behaviour after the gate:
1. read-only turn → gate stays **silent** (no false positive on assessment turns).
2. edit turn → `🔎 Files were changed but nothing verified them — asking the model to run a check.`
3. nudge answered with a bare `run_terminal` → correctly stayed **unverified** (after the fix).
4. nudge answered with `grep "border-radius: 20px;" style.css` → successful check → verified.

### Prompt-engineering / context-engineering audit (last 30 traces, 126 steps)

**Can it be audited at all? Barely — that is the headline finding.**
- 106/106 chat steps expose only **83 bytes** of the system prompt (`prompt.slice(0, 80) + '…'`),
  so the single most important prompt artifact (tool contract, response-format rules,
  persona) is **invisible in every trace**. Orchestrator previews cap at 300 chars.
- The `promptDigest` hashes the **entire thread**, which grows every step → 126/126 distinct
  digests, so the `seenStepDigests` dedup guard can never fire (dead code) and the digest
  cannot prove system-prompt stability / cacheability.

**What the visible prompts show:**
- ✅ Orchestrator planner uses a clean role-based, decision-first persona
  ("You are a senior software architect… 1. Language 2. Framework…"), 16/20 identical.
- ✅ A dedicated **failure-escalation** planner prompt exists (4/20):
  "The current approach has failed repeatedly. Propose a COMPLETELY DIFFERENT strategy…"
  — good anti-repetition engineering.
- ✅ 77/106 chat steps carry `[Assistant]` + `[Tool result]`, i.e. the loop genuinely iterates.
- ⚠️ On WhatsApp turns ~**80% of the visible user turn is boilerplate**
  (`[Origin: …]` + `RESPONSE FORMAT (non-negotiable…)`, ~330 of 417 bytes), re-injected
  every turn. Channel policy belongs in the stable system layer, not the volatile user turn.
- ⚠️ `trimThreadBudget` defaults to 200K chars (~50K tokens); the session peaked near 10K,
  so mechanical compaction never triggered — the growth is real but the budget far too loose.
- ⚠️ No cross-turn state in any observed prompt (the G4 gap — now fixed on both paths).

**Recommended (tracked, not yet done):**
- [ ] Store a **layered** prompt record per step: separate digests + previews for the
      system / context / volatile layers, plus the FULL system prompt once per trace.
      Without it, prompt engineering cannot be reviewed at all.
- [ ] Move channel/format policy out of the user turn into the stable system layer.
- [ ] Tie the compaction budget to the model's real window instead of a flat 200K chars.

---

## Session 4/5 — layered tracing, policy placement, strict verification, full replay

### Layered prompt tracing `[x]`
- [x] `src/learning/prompt-layers.ts` — deterministic splitter for BOTH transports
      (chat `[System]`/`[User]`/`[Assistant]`/`[Tool result]` markers; assembler
      `# Project Context` / `## Task` headings), plus per-layer digests + sizes
- [x] `recordStep({ promptFull })` derives `layers` and captures the **full system prompt
      once per trace** (`systemPrompt` + `systemPromptChars`, capped 16K). `promptFull`
      is never stored — verified by test (no leak of the user ask).
- [x] CLI `trace show` / `trace replay` print the system prompt and per-step layer digests
- [x] Dashboard: `TraceStep.layers` + a collapsible full system prompt; list endpoint strips it
- [x] Tests: `tests/learning/prompt-layers.test.ts` (10), 4 new in `reasoning-trace.test.ts`

**Live proof** — a real turn now records `sys 5738c` vs `vol 41c` and a 5738-char system
prompt; the persistent digest across steps is the cacheability signal the flat digest
could never provide.

### Channel policy moved to the stable layer `[x]`
- [x] `answerOnce({ systemPolicy })` merges policy into the system message; `ChatEngine`
      slice + gateway call site updated
- [x] The gateway's ~330-char `RESPONSE FORMAT` block no longer rides in the user turn;
      the open turn is now `[Origin…]` + the ask only (
      was ~80% of the visible user turn on WhatsApp turns)
- [x] Test asserts the policy is in the system layer and NOT in any user message

### Verification must EXERCISE the changed artifact `[x]`
- [x] `verificationExercisedArtifact(evidence, changedFiles)` + `assessEditActivity()`
- [x] The loop now records mutated paths + verification evidence (args + result)
- [x] A run counts only if it is `test`/`browser`, a generic project check
      (`npm test`, `tsc`, lint, build), or names a changed file. `echo hi` no longer counts.
- [x] Falls back to permissive when changed paths are unknown (never false-flags)
- [x] Tests: 6 new in `edit-verification.test.ts`, 2 new loop tests

### Full 15-turn replay — PARTIAL (blocked, not a code defect) `[~]`
Driven programmatically through the real engine with shared history
(`ChatSession` via `answerOnce`, non-TTY `ask_user`), sandbox seeded with the baseline's
end-state files and the exact 15 baseline prompts.

**It did not finish.** Results at the point of failure:

| Turn | Baseline | Hardened |
|---|---|---|
| 1 "assess + recommendations" | 6 steps | **0s, no tools, NO TRACE — served from the response cache** |
| 2 "yes, continue" | 17 steps · verification **NONE** | 9 steps · **`run_terminal`** · layers `sys 5738c/vol 41c` · routing snapshot ✅ |
| 3 "Continue with Step 2" | 8 steps · verification **NONE** | 20 steps · **`run_terminal`** · system prompt 7998c · routing ✅ |
| 4 "Proceed with UI/UX CSS" | 8 steps · verification **NONE** | **crashed mid-turn** (Gemini failed → failover to `local/gpt-oss:120b-cloud` → process died) |

**What the partial data proves:** on every edit turn that completed, the hardened agent ran a
verification tool (baseline: zero across the whole session) and the ledger recorded
`unverifiedEdits: 0` with `lastVerifiedAt` set (i.e. verified, not claimed).

**Two blockers found (both tracked, neither a regression):**
- [ ] **A cached turn leaves NO trace.** Turn 1 returned in 0s with no LLM call and produced
      no trace at all — so the Trace tab silently under-reports cached turns.
- [ ] **Provider failover to a slow local model can hang the process.** Turn 4 died after
      Gemini failed over; the replay could not proceed. Needs a per-turn watchdog.
- [ ] A true end-to-end 15-turn replay needs a turn-level timeout + cache bypass;
      ~60–90 min of provider time. Re-run with `--no-cache` once the watchdog lands.

---

## Follow-ups (not blocking, worth a later pass)
- [ ] Config flag to make the verification nudge **strict** (block the turn) for CI/enterprise profiles.
- [ ] Accept a verification run only when it actually EXERCISED the changed artifact
      (today any successful `run_terminal` counts — e.g. `echo hi` would pass).
- [ ] Retire a working-state project entry after N verified turns with no reports (age-out).
- [ ] Per-turn watchdog + `--no-cache` for a clean full-session replay.
- [ ] Make a cache-served turn leave a trace (source `cache`), so the Trace tab is complete.

---

## Evidence (raw session numbers)

```
calculator turns : 15
LLM calls        : 99   (failed: 0, escalated: 0, routing snapshots: 0)
tokens           : 531,517 in / 7,358 out   (72:1)
avg latency      : 4.0 s   (worst single call: 72.3 s)
tools            : read_file 42 · edit_file 22 · list_dir 8 · ask_user 7
                   plan_todo 3 · write_file 2 · suggest_followups 4 · skill 1
                   run_terminal 0 · test 0 · browser 0        <-- the gap
outcome          : every turn success=true, kind=acted
```

## Session log
- **2026-09-22 (s1)** — tracker created; G1–G6 scoped from the trace audit.
- **2026-09-22 (s1)** — G1/G2/G3/G4/G5/G6 **implemented + tested**. Full suite green (6144 passed).
- **2026-09-22 (s2)** — ledger extended to the orchestrator; CLI warning added; **two
  honest-accounting false positives found by a live E2E and fixed**; live E2E run and
  compared to the baseline; prompt-engineering audit completed (layered tracing tracked).
  `tsc` clean; full suite green (6148 passed, 13 skipped).
- **2026-09-22 (s4/s5)** — layered prompt tracing shipped (module + trace + CLI + dashboard);
  channel policy moved to the stable layer; verification gate now requires the run to
  EXERCISE the changed artifact. Full 15-turn replay attempted and **partially completed** —
  the diff table + two blockers are recorded above.
- **2026-09-22 (s7)** — unattended execution (G11) + hybrid/phase intent (G12) shipped, then
  **G14 (continuation batches skip reasoner+planner) and G15 (a provider-named output cap is
  learned, not fatal) closed**. The 12-page story ask that failed 6/6 live runs now **completes
  unattended in ONE command** — 5/5 chapters, assembled `kharig-nights.md` (5,084 words ≈ 14.5
  pages). `tsc` clean; 2,800 + 1,512 tests green. New live symptom recorded under G13: the loop
  engine satisfied the same authored ask with chat text and wrote nothing to disk.
- **2026-09-22 (s7 cont.)** — **G13a closed: the loop engine no longer asks permission for work
  the request already authorized**, implemented through the autonomy policy (request
  authorization → permission-seeking detection → the write-confirmation rule) and enforced at
  three points: `write_file` (authorized CREATE applied directly), the loop (a bounded
  "the request already asked for this work" nudge), and `ask_user` (a reflexive permission
  question is settled in-process, with irreversible choices still escalated). The original gate's
  safety property — never clobber existing work — is unchanged. `tsc` clean; 3,286 + 1,452 + 283
  tests green. The delivery half is now tracked separately as **G13b (open)**: both live loop runs
  wrote no artifact.

### Verification (session 4/5)
```
npx tsc --noEmit                                 → clean
vitest tests/tools                               → 30 files, 424 passed
vitest tests/gateway                             → 21 files, 396 passed
vitest tests/cli tests/agents tests/integration   → 97 files, 1731 passed
vitest tests/learning tests/inference tests/web-dashboard → 84 files, 1904 passed
npm run test:dashboard                           → 27 files, 291 passed
```

---

## Session 6 — LONG-FORM / CREATIVE-DELIVERABLE audit (a 100-page story, sent by WhatsApp)

Reported symptom: *"1/4 steps completed · 3/4 agents ok · ❌ writer: Repair budget
exhausted (1 attempts)"* followed by *"Ruled out … local/nonexistent-fast-fail,
local/gemini-3.1-flash-lite … No suitable model is available right now."*

The user's instinct — "the agent was stuck on two models" — is **half right and half
wrong, and the wrong half is the important one**: no model shortage was involved.

### Evidence (traces, registry, config — all read, none inferred)

```
Traces mentioning the story task : 21
Orchestrator runs               : 6  (05:44→06:16, 32 min) — ALL failed, identical shape
Failed-run steps recorded       : 3–4, of which the writer was the failing one
~/Documents/story/              : DOES NOT EXIST — nothing was produced
Writer output cap               : maxTokens: 2048  (≈1,500 words ≈ 4–5 pages)
Writer step 2 of run 1          : responseLength 0, outputTokens 0, success: TRUE
  (a GREEN step in the dashboard for a call that returned nothing)
```

**The reasoner mis-framed a writing task as software engineering.** Its own output:
`{"language":"python","framework":"none","platform":"cli","deliverable":"markdown_file",
"reasoning":"…a Python script is the most efficient way to read existing chapters…"}`.
The planner then produced **zero prose steps** — step-02 is *"Create a Python script to
append the story continuation"*, step-03 *"Run the Python script"*. The agent built a
tool to write the story instead of writing the story; and because step-02 itself
failed, even the tool was never created.

**Three independent blockers, each individually fatal, none model-dependent:**
1. **Reasoner taxonomy** — creative authorship collapses to `language: python` even
   when `deliverable: markdown_file` is correctly identified. No first-class
   "authored document" branch.
2. **Writer contract** — success requires ``` ``filepath: …`` ``` code blocks; the
   persona is literally *"You are an expert software engineer implementing changes to
   a codebase."* Prose is not code, so real prose = "Writer produced no parseable
   output".
3. **Writer output cap** — 2048 tokens. A 100-page book needs ~25–40 sequential
   generations accumulated into one file. Nothing decomposes by chapter and nothing
   counts pages, so **the ask is impossible for ANY model in the pool.**

### Why the failure message is misleading (a real honesty bug)

`renderModelBreadthReport` derives its closing sentence from `nextFreeInMs`, which is
computed **only from parked entries that have an expiry**. A dead pair has
`expiresAt: 0`. So when the only exclusions are dead pairs, the function prints
*"No suitable model is available right now"* — a **global-drought claim inferred from a
2-entry park list**. Meanwhile, provably available at that moment:

```
registry entries (non-dead) : 507   (openrouter 443 · gemini 50 · groq 13 · local 6 · bedrock 1)
configured provider keys    : gemini, groq, openrouter, nim, tokenra, bedrock/defaultProvider : "auto"  (escalation is NOT pinned to one provider)
gemini|gemini-3.1-flash-lite: status "verified", lastVerifiedAt = 52 SECONDS after the failed run
```

The pool was never empty. The report named the two dead pairs it could read off disk
(both `local`) and then asserted a shortage it never measured. `tried` comes from
`attemptsSince(mark)` — an **in-process, in-memory** array — so a walk that recorded
no attempt renders no "I tried …" section, and the two sections that would have
corrected the impression are simply absent.

### The "loop" the user saw

6 orchestrator runs in 32 minutes, each: reasoner JSON → plan → writer fails →
failure report. Interleaved, the **chat** surface (which *can* write prose — those
traces show 1,200–1,700 output tokens of actual narrative) kept answering "yes I can"
and then **delegated to the orchestrator**, which structurally cannot.

Worse, the retry lane is gated on the wrong thing: the failure report offers *"reply
*yes* and I will keep trying"*, and `deferFailedAsk` schedules that retry with `retryWaitMs(undefined)` → **DEFAULT_WAIT_MS = 5 min**, up to **40 attempts over 6
hours**. The retry is conditional on *model availability*, but the failure was a
*task-shape* failure. All 40 attempts would fail identically. The offer is not a
recovery path; it is a 6-hour re-run of the same mistake.

### G7 — Deliverable-class awareness `[ ]`
Classify the ask before planning: `code | document | creative | data | research`. A
`document`/`creative` deliverable must plan **sections**, not a program that emits
sections, and must route to a prose capable path rather than the code writer.
*DoD:* the 100-page story lands chapter-by-chapter in `Mahagatha.md`.

### G8 — Bounded long-form execution (progress accounting) `[ ]`
A deliverable larger than one generation must be split into N bounded units with a
running total checked against the target (pages/words), resumable across turns.
Fix the 2048 cap for document units. *DoD:* "100 pages" is a measurable plan, and
partial progress is preserved instead of lost.

### G9 — Failure report must distinguish "empty pool" from "no attempt" `[ ]`
`renderModelBreadthReport` must (a) never print a global-drought sentence from a
park-only park list, (b) always show the eligible pool size, and (c) say plainly when
nothing was attempted. The retry offer must be suppressed when the failure is not
availability-shaped. *DoD:* a task-shape failure cannot produce "no suitable model is
available" + a 40-attempt retry promise.

### G10 — A zero-output step is never a success `[x]`
`withTraceCapture` now records an EMPTY response as `success: false` with the error
`empty response — the provider returned no content (0 chars)`. Live evidence: the story
session's writer step was `success: true, responseLength: 0, outputTokens: 0`. Every call
site wrapped by it is a plain text generation, so an empty string can only mean the
provider returned nothing. *Pinned by 2 tests.*

### G7 — Deliverable-class awareness `[x]`
- New `src/learning/deliverable-class.ts` — a DETERMINISTIC classifier
  (`code | document | creative | data | research`) with an authored/unauthored verdict, an
  English + Hindi/Hinglish signal table, and a code-intent override so
  "create a PDF exporter" stays software.
- `reasoner.ts` reports the class to the model as already decided and ENFORCES it after
  parsing: a mis-framed answer (live: `language: python`, "a Python script is the most
  efficient way") is corrected to `language: none`, `platform: document`,
  `architecture: sections`. *Pinned by 3 tests + confirmed LIVE (see below).*

### G8 — Bounded long-form execution `[x]`
- New `src/learning/long-form.ts` — target parsing (pages/words/chapters/sections, EN + HI),
  unit planning whose word targets SUM to the whole ask, a per-project LEDGER at
  `~/.nuvira/memory/long-form.json` with resume, verification-debt repair (a done unit whose
  file vanished is re-opened), bounded per-run batches, progress reporting, and DETERMINISTIC
  assembly of the single document from its unit files.
- New `src/agents/long-form-plan.ts` — bridges that into the orchestrator's task plan:
  authored asks become WRITER steps with `expectedFiles`, chained `dependsOn` (units are
  sequential), a document path resolved from the goal, and a continuation note.
- `writer.ts` gained a PROSE mode: an author persona, `maxTokens: 8192` (sized for a
  2,500-word chapter), the response IS the artifact (fences stripped), a minimum word count
  so a truncated/empty reply FAILS, and continuity read from the previous unit's file at
  EXECUTION time.
- `orchestrator.ts` — the unit plan is built BEFORE the code planner and replaces its output
  for authored asks; a planner failure no longer sinks a story; prose steps never route to
  the tool-calling writer; each finished unit is measured from the FILE on disk and the
  document is assembled when the last unit lands. *Pinned by 37 tests.*

### G9 — Failure report cannot claim a shortage it never measured `[x]`
- `countEligibleModels()` (model-first-router) reuses the router's OWN filtering, so the
  report's pool count can never disagree with what routing would consider.
- `ModelBreadthReport` now carries `poolSize`/`poolProviders`; the renderer distinguishes
  "no model call was made" from "everything I reached failed", prints
  `Pool at the time: N eligible models across M providers`, marks the ruled-out pairs as
  "not the reason above", and claims a shortage ONLY when the pool is measured empty.
- `reportWarrantsRetry()` is the single source of truth shared by the renderer AND the
  queue: a healthy pool with zero attempts offers NO retry (live: 6 identical runs in 32
  minutes, 507 models eligible); a model-layer failure still does. *Pinned by 8 tests.*

## Session 6 — END-TO-END: the story ask, re-run on the hardened agent

### Hermetic E2E (real orchestrator; only the model is scripted)
`tests/integration/long-form-story.test.ts` drives the real reasoner, planner, plan
replacement, writer prose path, disk writes, ledger and assembly — with the reasoner and
planner returning the EXACT hostile answers from the live run (a Python script that would
write the story).

```
baseline (live, 6 runs / 32 min)      hardened (E2E)
  plan     4 code steps, 0 prose       4 prose units (of 39), hostile plan REPLACED
  prose    none                        chapters/01..04-chapter-N.md, each > 120 words
  code     Python script intended      no .py file, no requirements.txt
  ledger   none                        job: 39 units, 35,000-word target, 4 done
  result   "Failed" x6                 "chapter 4/39 ... words ... Reply continue"
  continue n/a                         resumes at units 5-8, ONE job (no restart)
  finish   nothing produced            5/5 units assembled into book.md (4,599 words)
```

### LIVE run (real models, real API) — SUCCESS in 8.7s
Goal: *"write a 5 page story called Mahagatha about a village boy who discovers he has
magic, with suspense and wonder"*.

```
Reasoner          creative writing (an authored work) — none+none on document
Planner           Created 2 task steps            (then REPLACED)
LongFormPlanner   2 prose unit(s) planned — chapter 0/2 · 0/1,750 words
writer            Wrote Chapter 1 (1270 words)
writer            Wrote Chapter 2 (1342 words)
files             chapters/01-chapter-1.md, chapters/02-chapter-2.md
assembled         story.md — 2,619 words (~5 pages), 2 units
ledger            class=creative status=done units=2 done=2 words=2612 target=1750
trace             4 steps, writer out=1506/1638 tokens, success=true
```
The prose is real, coherent and continuous: the assembled work opens with the village of
Kharig, Rohan, the banyan-root stone — and Chapter 2 continues it, which is the continuity
contract (previous unit tail) doing its job.

### Judgment against enterprise-grade expectations
**Met:** the ask now decomposes into units the harness can actually produce; progress is
measured from disk and persisted; work resumes across turns instead of restarting; a
planner/JSON failure is no longer fatal to an authored deliverable; the failure report can no
longer assert a shortage it did not measure; a zero-output step is no longer green.
**Not yet enterprise-grade:** (1) a batch of 4 units is still a per-turn cap, so a 100-page
book is ~10 turns — correct but not yet unattended (needs a resumable job runner that
continues across turns without a human "continue"); (2) long-form steps record
`provider/model: unknown` in the trace (the per-task routing snapshot is not reaching our
own wrapped calls) — auditability gap, same family as G5; (3) a title given in prose
("called Mahagatha") is not used for the document name (it fell back to `story.md`);
(4) the full 39-unit live run has not been executed end-to-end.

### New follow-ups recorded
- `[ ]` Resumable long-form job runner: continue batches unattended until the target is met.
- `[ ]` Trace fidelity for long-form steps: record the real provider/model (flagged above).
- `[ ]` Extract a quoted/prose title ("called Mahagatha") for the document name.
- `[ ]` Full 39-unit live run + a 100-page timing/cost report.

---

## Session 7 — UNATTENDED EXECUTION + HYBRID INTENT (G11–G15, G13a)

THE COMPLAINT THIS SESSION ANSWERS, verbatim: *"when i ask you to create a 100 page 200
page book you do it without asking me again … we can't afford to have 4 turn manual
cadence, it must run at enterprise grade not the cheap shortcuts. Same expectation is for
intent identification and deliver."*

Two structural defects sat behind that:

| # | Defect | Why it was fatal |
|---|---|---|
| 1 | A batch of 4 units ended with `Reply "continue"` | A 100-page book needed ~10 HUMAN turns. The ask itself is the authorization; a protocol replaced the work. |
| 2 | The classifier had ONE class per goal | "a web-based interactive book with voice" is prose AND an application. Planning either alone loses half the ask — the same category error as the Python-script story, one level up. |

### G11 — Long work continues UNATTENDED `[x]`
`src/learning/unattended-job.ts` (new) + `src/learning/unattended-progress.ts` (new) +
`src/learning/autonomy-policy.ts` (new).

A persisted queue of IN-PROGRESS WORK — deliberately NOT the retry queue, whose consent
semantics are the opposite (a retry needs the user's "yes"; a book does not — the ask was
the authorization). The runner loops until the deliverable exists, a decision only the user
can make blocks it, or its own 10-hour budget runs out.

Three guarantees, each tested:
- **Progress is MEASURED, never claimed.** A batch that did not move the ledger is a stall
  even if every step was green. Three stalls stop the run and ASK — an agent looping without
  progress is the exact behaviour this exists to end.
- **It stops for QUESTIONS, not permission.** `autonomy-policy.ts` decides: proceed unless the
  decision is blocking AND high-impact AND irreversible AND has no sensible default. Asking
  about something the ask already specified is a non-delivery dressed as diligence.
- **It never runs unbounded.** 10h deadline, 3-stall cap, 6-failure cap, per-drain batch cap,
  stale-`running` self-heal (a restart mid-batch cannot strand the work).

Wired into the two surfaces where these asks actually land: the **CLI** (`execute` runs the
remaining batches in the same command) and the **gateway** (WhatsApp/Telegram — the surface of
the original failure). Both driven by `result.pendingWork`, which the orchestrator hands over
ONLY while work remains.

### G12 — Hybrid intent is PHASED, not force-classified `[x]`
`deliverable-class.ts` gained `substrates` / `composite` / `interactive`;
`src/agents/composite-plan.ts` (new) plans the phases.

`"a web-based interactive book with voice narration"` →
`substrates: [prose, web, python, asset]`, planned as
**shape → content → experience → services → verify**.

Two judgment calls, both deliberate:
- **Content is not last and is not optional.** The shell is one step; the book is dozens.
  A run that stalls early still leaves real chapters on disk, which is what makes it resumable.
- **An optional service never gates the deliverable.** The Python narration script IS created,
  but the site narrates through the browser with nothing installed. A page needing `pip install`
  before it says a word is not an enterprise deliverable.

The verification step is generated BY US (a deterministic `node -e` command), because the thing
that judges the work must not be part of the work. It asserts every promised file exists and the
site reads its chapters from the content directory — and it deliberately does NOT assert that the
site's source names each chapter file, since a correct reader enumerates the directory at load
time and names none of them.

### G14 — The planner still runs on every continuation batch `[x]`
Each unattended batch re-ran reasoner + planner even though the composite/unit plan REPLACES
their output. In the live run the planner began failing with `provider-error` on every batch and
burned the repair budget before the real work started. Not fatal (the content plan was adopted
anyway) but it was wasted latency and a failure surface that the plan does not need.

**Fixed.** The in-flight authored job is now read BEFORE the design layers run, and a
CONTINUATION skips both reasoner and planner — the deliverable class is in the ledger and the
unit/phase plan is a deterministic function of it, so nothing about the design is still open.
The skip is REPORTED, not hidden (`✅ Reasoner: Skipped — continuing in-flight authored work`),
and it is deliberately scoped to continuations: a first, fresh authored ask still runs both,
because that is the one run where the class is being established — and it is one batch, not one
per batch.

*Evidence (live, real models — `execute --engine pipeline`, 12-page story with a hostile pool):*
```
🤖 Unfinished work detected — 1 of 5 content units remaining. Continuing automatically; no reply needed.
⚡ Pipeline started: continue
   📖 Long-form plan: 📖 chapter 4/5 complete · 4,148/4,200 words (11.9 of ~12 pages, 99%)
📋 Plan ready: 1 step(s) — writer          ← no 🧠 Reasoning…, no 📋 Planning…
   ✅ writer: Wrote Chapter 5 (917 words)
✔    📖 Document assembled: …/kharig-nights.md — 5,084 words (~14.5 pages, 5 units)
📖 Job complete — 📖 chapter 5/5 complete · 5,065/4,200 words (14.5 of ~12 pages, 100%) (1 batch).
✅ Finished unattended — 5/5 chapters
```
No LLM tokens spent re-deciding a design that was already committed to the ledger.

### G15 — Our own output cap could fail every step, and nothing learned `[x]`
Found by re-running the story task live after G14. EVERY prose unit failed with the same
provider rejection, six batches in a row:

```
Groq API error (400): {"error":{"message":"`max_tokens` must be less than or equal to `512`,
  the maximum value for `max_tokens` is less than the `context_window` for this model"}}
```

The cause was OUR constant, not the model pool: the prose path asks for `maxTokens: 8192`
(a chapter needs ~900 words with headroom) and the routed model permitted 512. Three things
were wrong, and each is a separate enterprise gap:

1. **`resolveMaxOutputTokens()` could not have saved this.** Its heuristic reads the CONTEXT
   WINDOW; this model advertises a large window with a tiny output cap — precisely the case the
   window heuristic cannot see.
2. **A hard-coded caller constant beat the capability lookup.** `inferenceOptions.maxTokens`
   wins by design, so a caller's number could exceed what the model can do, silently.
3. **Nothing learned.** The provider named its limit in the error and the agent threw that
   information away, then repeated the identical mistake on the next unit, and the next batch.

**Fixed** — `src/learning/provider-limits.ts` (new) + the orchestrator's SINGLE call point:
- `parseMaxTokensLimit()` reads the limit out of the error text (Groq/OpenAI-compat, Anthropic,
  Gemini `maxOutputTokens`, nested `cause`/`response.data` bodies), normalizing camelCase so one
  set of patterns covers `max_tokens`, `maxCompletionTokens` and `maxOutputTokens`; it takes the
  SMALLEST number named, because a too-small retry still succeeds while a too-large one wastes
  another call — which is the whole failure being fixed.
- The limit is learned per provider × model and applied PREDICTIVELY to later calls, so one
  rejection costs one wasted call per process instead of one per unit. It only ever clamps DOWN,
  so a provider that accepted our request is never overruled.
- On rejection the orchestrator clamps to the named number and retries ONCE; the retry lands at
  the same bookkeeping points as any other call.

*Evidence (hermetic, through the real `Orchestrator.execute`):*
```
⚠ local/test-model caps output at 512 tokens (we sent 2048) — clamping and retrying once
ℹ    ✅ Pipeline succeeded (2/2 tasks)
```
A two-step plan sees exactly ONE rejected call — not one per step.

### G13a — The loop engine asks permission for work the request already authorized `[x]`
The `execute` goal defaulted to the **loop** engine and the loop asked permission twice for a
decision the ask had already made: *"Create the Mahagatha interactive-book project with 20
chapter pages…?"* and *"Do you want me to create the full project structure…?"*. Over a chat
surface that is a message to the user, so the round trip is the manual cadence again.

**Fixed — with the autonomy policy, and without removing the safety property.** The gate was
BINARY (confirm or refuse) because it had no notion of a request that had *already authorized*
the work. `autonomy-policy.ts` now supplies exactly that missing input, in three pieces:

- **`requestAuthorizesWrites(request)`** — does the user's own ask authorize files? Evidence
  order: an explicit confirmation ("yes", "go ahead"), a continuation ("continue", "finish the
  remaining chapters"), a named destination path, then a creation verb applied to a file-shaped
  deliverable. An analysis/interrogative opener ("explain how to write a story to a file", "what
  files should I create?") VETOES the last two, so questions stay questions. Deliberately
  conservative: anything unrecognised is NOT authorized, which leaves the old gate exactly as
  strict as it was.
- **`detectPermissionSeeking(content)`** — does the turn END by asking permission? Catches
  "do you want me to…", "shall I…", "awaiting your confirmation", and the bare proposal question
  ("Create the Mahagatha project with 20 chapter pages…?"). A genuine content question ("which
  title do you prefer?") is not permission-seeking, and only the closing two sentences are
  judged — a question mid-answer followed by the deliverable is narration.
- **`decideWriteConfirmation`** — CREATING a file the request asked for, where nothing exists at
  that path, proceeds (it destroys nothing and is undone by deleting it). Everything else keeps
  today's gate: an unauthorized request, and any write that would REPLACE existing content.

The asymmetry is deliberate and load-bearing: the safety property the original gate protected
(never clobber existing work without a human) is untouched; the property it lacked (do not stall
on work the user already ordered) is added.

Three enforcement points, all reading the same verdict:
| Where | What happens |
|---|---|
| `write_file` | An authorized CREATE is applied directly and the model is told to state the decision. Overwrite still needs `confirm:true`. |
| the loop | A turn that ends ON a permission question for authorized work earns ONE bounded nudge ("the user's own request already asked for this work…") and continues; the trailing question is stripped so it can never outrank a shorter real answer under the longest-substantive rule. |
| `ask_user` | A reflexive permission question about authorized work is answered in-process instead of becoming a message to the user — with the first choice returned as the recommended default, and an explicit escape: a question naming an IRREVERSIBLE action (overwrite, delete, publish, deploy, send, pay…) is passed straight through, because that decision IS the user's. |

The `TOOL_CONTRACT` changed with it: creating a file the request asked for needs no confirmation,
and the model may never ask in plain text for permission to do work it was asked to do.

### G13b — The loop engine satisfies an authored ask without writing the artifact `[x]` (closed — Session 11)
The same investigations produced a second, now-sharper symptom. Two live runs of an authored ask
on the loop engine wrote **nothing to disk** — the deliverable stayed chat text:

- 12-page story: a complete, good-quality reply, no files. `chapters/…` never created.
- web-book ask: the model NARRATED the file plan (index.html / style.css / script.js / README.md)
  and closed with *"Below are the files."* — zero files, zero tool calls. `detectUnfulfilledIntentPromise`
  could not catch it because a dangling promise is deliberately ignored when the answer contains a
  LIST, and a narrated file plan IS a list. The loop has no delivery obligation for a file-shaped
  ask, only the pipeline engine does (it assembles `kharig-nights.md`).

This is the "deliver" half of G13. It is not a regression from the fix above — the permission
question was one SYMPTOM of the same missing notion of "the ask was for an artifact", and the
symptom is closed while the cause is half closed.

**CLOSED in Session 11 — see "Session 11 — THE ARTIFACT LANDS, AND THE RUN ACCOUNTS FOR ITSELF"
below.** Two predicates now decide it, and the split is the design: `wantsAuthoredArtifact`
(authored + the request authorized writes) routes the default path to the pipeline and arms the
loop gate; `asksForAuthoredFile` (a multi-unit magnitude OR a NAMED destination) is the narrower
rule the chat-vs-task gate uses, so the pinned chat asks (a poem, a song, an essay, a 1-page
summary, a bare "book") keep their chat answers.

---

## Session 8 — THE OTHER CONFIRMATION GATES: an audit (G16)

G13a fixed ONE gate (`write_file`). The obvious next question is the one the audit asks: *which
other gates have the same missing input?*

### The population (found by the codebase's own definition: a gate whose refusal says
"call `ask_user`, then retry with confirm:true")

| Tool / path | Gate before this session | Had the authorization input? |
|---|---|---|
| `write_file` — create | confirm unless authorized-create | **yes** (G13a) |
| `write_file` — overwrite | always confirm | yes, deliberately (destroys existing content) |
| `edit_file` — every edit | **always confirm** | **NO** |
| `run_terminal` — confirm class | **always confirm** | **NO** |
| `run_cli` — `confirmation:true` intent | **always confirm** | **NO** |
| `git` — `action:'commit'` | **always confirm** | **NO** |
| `publish` | irreversible + external, asks for bump/target | yes — correct, unchanged |
| `skill` `manage` drafts | preview-card gate | n/a — a draft is not the user's work product |

### What each missing gate extracted from the live sessions

- **`edit_file`** is the sharpest one, and it contradicts the design around it. `run_terminal`'s
  whole purpose is the loop *"run → read the failure → edit → re-run"* — but the edit step needed a
  human, every iteration. Worse, the refusal fired **before validation**: the user was asked to
  approve an edit whose `old_string` might not match, and the approval was then spent on a change
  that failed.
- **`run_terminal`**: `npm install` is confirm-class, so the setup step of every build task was a
  mandatory round trip.
- **`run_cli`**: 14 intents are confirmation-gated. **10 of them are recoverable** (a service that
  restarts, config that is re-added, a cache that rebuilds) and 4 are not (`history.clear`,
  `memory.prune`, `stats.cost.clear`, `publish`). The manifest flag says the *action* is stateful —
  it does not say the user must approve what they just asked for.
- **`git commit`**: the tool's own contract said the model must ask *"after the user approved via
  ask_user"* — but "commit these changes" **is** the approval.

**A second, deeper finding:** a single `writesAuthorized` boolean was the wrong shape for all of
this. It answers *"did the request ask for FILES"* — the wrong question for "stop the dashboard",
which reads as unauthorized. Each gate needs the evidence **its own** question requires, so the raw
request text is now threaded alongside the verdict and each tool measures for itself.

**A third, and it was hiding a real hole:** the verdict itself under-authorized the most common ask
in this whole project. `"fix the calculator so division by zero returns 0"` came back **NOT
authorized**, because the noun list names *artifact types* (file, app, story, script) and a
directive verb on existing work names no artifact at all. `MAINTENANCE_VERB_RE` closes it (still
vetoed by an analysis opener, so *"why is the build failing?"* stays a question).

### The fix: one rule table, four gates

`decideStateChange()` in `src/learning/autonomy-policy.ts` replaces four ad-hoc gates. The two
never-autonomous classes are settled **first**, so no later rule can turn them autonomous:

1. `destructive` → **ask**, even when the request names it (permanent; a round trip is cheap).
2. `external` (visible to others / billed / leaves the machine) → **ask**, same.
3. neither authorized nor named → **ask** — the original strictness and the no-loop-context default.
4. named by the request → **proceed** (the user's own words are the authorization).
5. authorized + measurably recoverable → **proceed**.
6. otherwise → **ask** (a surprise is possible).

| Gate | The evidence it now measures |
|---|---|
| `edit_file` | `requestNamesPath` (the request names the file) OR `isSurgicalEdit` (touched ≤ 50% of the file) — *the same rule as `write_file`'s overwrite: preserve most, proceed; replace most, ask* |
| `run_terminal` | a narrow `RECOVERABLE_PREFIXES` allowlist (`npm/pip/cargo install`, `mkdir`, `touch`, `cp`, `mv`, `git add`…), rejected inside **any** composed command and for `-g/--global` |
| `run_cli` | the user's own request resolved through the **same** router, matching the **identical** command |
| `git commit` | `requestRequestsCommit` — and NOT `recoverable`, so a commit the model decided on still asks |

Every autonomous decision is **reported, never silent**: the tool result tells the model to state
the decision, and `autonomy:write-applied` carries the reason.

### G17 — the audit found a pre-existing classifier bypass `[x]`
Reasoning about whether the new allowlist could be chained around exposed a live hole in
`classifyCommand`: it scored the **whole string** against the verify allowlist, so a verify prefix
granted the entire line its safety — `npm run build && rm -rf src/` was classified `verify` and ran
with **no** confirmation. It now splits on `&&`/`||`/`;`/`|`/newline/substitution and takes the
**worst** segment class: `npx tsc --noEmit && npx vitest run` (both verify) still runs freely,
`npm run build && npm publish` no longer does. Deny-first on the whole string is unchanged, so
`echo $(rm -rf /)` is still denied. `basename`/`dirname`/`realpath` were added to the verify list so
`npx vitest run tests/$(basename x).test.ts` is not a false positive.

### G18 — the audit could not be done from telemetry `[x]` (closed — Session 11)
Recorded because it bounds every claim above. **The loop engine writes no reasoning trace** and the
CLI's `-v` does not print tool *results*, so: gate refusals, the cadence (how often a gate asked),
and which branch a gate took are all invisible. The trace store showed **0** confirmation refusals —
not because there were none, but because it cannot see them. This audit had to be done by reading
code and driving the real tools. Finding it: `grep -n "reasoning-trace" src/tools/tool-loop.ts` →
empty.

### Verification (Session 8)
| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `tests/tools tests/learning tests/commands tests/agents tests/nlu` | 149 files · **3,369 passed** |
| `tests/cli tests/gateway tests/integration tests/inference tests/web-dashboard` | 109 files · **1,735 passed** |
| dashboard suite (`npm run test:dashboard`) | 27 files · **291 passed** |
| New tests | `autonomy-state-change` (20 — the rule table + a **manifest-coverage guard**: every gated CLI intent must be classified in exactly one table, in both directions) · `state-change-autonomy` (22 — all four gates through the real registry, plus chain classification) · 2 loop-level wiring tests proving the **raw request reaches the tools** |
| **LIVE (real models, `--engine loop`)** | A failing calculator test, one command: `read_file` → **`edit_file`** → `run_terminal` → answer. **Zero permission markers** (`💬`/`Choices:`/`ask_user`/`needs explicit confirmation` — grep empty). `src/calc.ts` really changed; I then ran `vitest` myself and the test genuinely passes — so the agent's success claim was true, not asserted. |

**Honest limit on that live run:** the CLI does not print tool results, so it does not distinguish
"the gate applied the edit autonomously" from "the model passed `confirm:true` without asking" —
the *outcome* (no round trip, real fix, real verification) is witnessed either way, and the branch
itself is pinned by the loop-level hermetic test. That gap is exactly **G18**, above.

**CLOSED in Session 11** — the loop engine now writes a reasoning trace (LLM steps with prompt
digests, per-layer stability, model, tokens, latency) AND a separate, non-LLM `events` list: every
tool call (name, args preview, result preview, ok/error, duration), every gate DECISION (a nudge
spent, an autonomy probe proceeding, a bound reached) and every REFUSAL (a confirmation decline,
an unknown/disabled tool, a repeat dispatch). `nuvira trace show` lists them; `-v` prints each tool
result under its call. `getTraceStats()` counts events/refusals/gateDecisions separately from
steps, because an event is not an LLM call and folding them together would corrupt both averages.

---

## Session 9 — MODELS PAGE AUDIT: three reports, one connected cause (G19–G21)

Three observations from the Models dashboard, investigated against the live stores.

### What the numbers actually were

| Section | Endpoint | Source | Showed |
|---|---|---|---|
| Model Health Overview / Provider Status + the headline bar | `/api/models` | live catalog probe of 18 providers | **662 listed · 509 "available"** |
| Model Availability Registry — *"the store routing reads"* | `/api/model-registry` | `model-registry.json` | **513 entries · 12 verified · 496 unverified** |

`checkOpenRouterProvider()` fetches `openrouter.ai/api/v1/models` and stamps **every** returned id with
the **provider-level** rate-limit status. So one credit check marks ~400 OpenRouter models "Available"
at once — while the registry holds **443 OpenRouter entries with 0 verified**, and `isUsable()` requires
`status === 'verified'`. The headline was a **listing** count presented as a **capability** count.

### G19 — routing was frozen, and then decaying `[x]`
The cost ledger is unambiguous (2649 per-call entries):

```
2026-09-21  7 distinct models / 126 calls
2026-09-22  3 distinct models / 255 calls   gemini-3.1-flash-lite 223 (87%) · local/gpt-oss 17 · azure 15
```

Two mechanisms, both found in code:
1. **The primary pool is the verified set only** (12 models, 3 providers); the other 496 are a
   reserve reached only after every verified candidate fails — so `azure`/`local` appear as
   *fallbacks*, which is exactly the "2 models" pattern.
2. **Nothing could grow the pool.** `runWarmupCycle` iterated only `usageMap` — models THIS process had
   already used — so a never-used model could never be verified, and an unverified model can never be
   used. It also bailed out on an empty map, which is the state of every short-lived CLI run. And the
   daemon was started **only from the cold-start branch** (`getUsableProviders().length === 0`), so from
   the first verified model onward nothing warmed *or* verified anything again.

Consequence, from the registry itself: 4 of the 12 verified models were at **142.8h** against a **7-day**
staleness cutoff — the pool was going 12 → 8 within a day. Fixed: `selectExplorationCandidates()`
(providers with the **fewest** verified models first, servable providers only, 6/cycle, 10-min
per-model throttle, self-terminating once the sweep drains), the cycle now runs with an empty usage
map, and the daemon starts on **every** run. The daemon had to be `unref()`'d first — without that,
starting it on a normal run would hang every CLI command forever, which is *why* it was cold-only.

### G20 — the Models page contradicted the router on the same screen `[x]`
`/api/models` now reconciles through the registry's **own** `isUsable()` predicate (duplicating the
staleness/park rules would recreate the divergence), adding `routable` / `registryTotal` /
`registryVerified` plus per-model `routable`, `registryStatus`, `parked`, `resetsInMs`. The bar states
the reconciliation ("662 listed by providers · 12 routable right now"), and a cell the router cannot
pick now says so instead of reading identically to the model that takes 87% of calls.

### G21 — test data was being written into the production registry `[x]`
The single largest row in "Learned from real usage" — `local/nonexistent-fast-fail`, **100 events that
day, 160 the day before, 2110 of the log's 3436 lines** — exists **only in the test suite**
(`grep nonexistent-fast-fail src/` → nothing). Proven by experiment: running
`tests/federation/a2a.test.ts` added **20 real telemetry events** to `~/.nuvira/memory/` and a
permanent `deadPair` entry. That test isolates `NUVIRA_CONFIG_DIR` and *not* the memory dir, so the
real Orchestrator pipeline it drives (deliberately configured with the fake model) recorded real
telememtry. `vitest.config.ts` had **no env isolation at all** — it set `fileParallelism: false`
because "memory tests share a JSON file store at ~/.buff/memory/", so every un-pinned test wrote the
developer's real store.

Fixed systemically: `tests/setup/hermetic-env.ts` (per-file throwaway memory dir, `NUVIRA_*` +
`BUFF_*` to the same path, best-effort cleanup) wired as `setupFiles`. Verified: the same test file
now leaves the real registry byte-identical. Three files that isolate via a mocked `homedir` had to
pin the same root (a test that had itself once "WRITTEN TO AND WIPED the user's real evals.json").
Poisoned entry removed from the live registry (backup kept, 513 → 512); the **hash-chained** action
history was deliberately left intact — rebuilding a tamper-evident chain to make a chart look better
is a decision for the data owner, and the fake events age out of the chart window.

### Verification (Session 9)
| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `tests/tools tests/agents tests/commands tests/nlu tests/skills tests/gateway tests/integration tests/inference tests/cli` | **3,533 passed** (13 skipped) |
| `tests/learning tests/web-dashboard` | 77 files · **1,700 passed** |
| dashboard suite | 27 files · **291 passed** |
| New tests | `model-warmup` (11) — the empty-usage-map case, provider-breadth ordering, unservable providers skipped, throttle, budget, failure reporting |
| Leak proof | `a2a.test.ts` run → real registry mtime + action-log count **unchanged** (was +20 lines/run) |
| `unref` proof | a process that starts the daemon **exits in 1s** instead of hanging |

**Left open deliberately:** the 2,110 chained fake-telemetry lines (see G21) and the residual that
`azure`/`nim` route only as reserve (no verified models yet — the sweep now addresses exactly that).

### Also fixed this session
- **Trace attribution.** A live 5-page story run recorded every step as `provider/model: unknown`
  because `options.provider` is undefined when the user pins nothing. The orchestrator now
  resolves the effective provider/model once per run for traces, events and review bundles.
- **Stated titles become filenames.** *"a 5 page story called Mahagatha about a village boy"*
  filed itself as `story.md`. `extractStatedTitle` reads `called|titled|named|नाम से` and stops
  at the first continuation word.
- **A satisfied phase is not re-planned.** `alreadySatisfied` drops presentation steps whose files
  exist — the second run of the composite E2E exposed why this is required, not merely tidy: an
  idempotent writer that correctly reports "no changes" was marked as HAVING FAILED its expected
  files and burned an entire repair budget.
- **Greenfield creation goes to the one-shot writer.** Live: the tool-calling writer returned
  ZERO file changes for the site scaffold (`read→edit→verify` has nothing to read in a directory
  that does not exist) and the pipeline died on step 1 of 8. Composite creation steps are now
  routed to the writer whose contract is "emit the complete file".

### Verification (G13a — the permission half)
| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `tests/tools tests/learning tests/nlu tests/agents` | 145 files · 3,286 passed |
| `tests/cli tests/gateway tests/integration tests/inference` | 95 files · 1,452 passed (an earlier run of this batch had one flaky failure; a re-run was green) |
| `tests/web-dashboard` | 14 files · 283 passed |
| New tests | `autonomy-authorization` (37) — authorization, permission-seeking, irreversible escape · `write-autonomy` (9) — the real `write_file` gate and `ask_user` suppression through the registry · 5 loop-level nudge tests in `tool-loop` |
| **LIVE (real models, `--engine loop -v`)** | the 12-page story ask and the composite web-book ask: **zero permission questions, zero confirmation round trips** (previously *"Do you want me to create the full project structure…?"*) — and neither run regressed on the old behaviour where it should not have. Artifacts: **none** — see G13b |
| Hermetic E2E (the gate itself) | authorized CREATE writes and returns `Applied without asking`; overwrite is still refused byte-for-byte unchanged; no `ctx` → unchanged; `confirm:true` honoured |

### Verification (G14 + G15 hardening)
| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `tests/learning tests/agents tests/nlu` | 113 files · 2,800 passed |
| `tests/integration tests/tools tests/gateway tests/cli` | 110 files · 1,512 passed |
| New tests | `provider-limits` (15) · cap self-heal + predictive clamp through the real `Orchestrator.execute` (2) · reasoner/planner skip on continuations in `long-form-story` + `composite-web-book` E2E |
| **LIVE (real models)** — 12-page story, `--engine pipeline` | **COMPLETES UNATTENDED, 5/5 chapters, ONE command** → `proj/chapters/01..05-chapter-N.md` + assembled `proj/kharig-nights.md` (5,084 words ≈ 14.5 pages). Batch 2 ran with reasoner + planner skipped. Contrast the earlier identical run: 6 batches, 0 words, every unit rejected on `max_tokens` |

### Verification (Session 7, for reference)
| Check | Result |
|---|---|
| `tests/learning tests/agents tests/tools tests/integration` | 140 files · 2,895 passed |
| `tests/cli tests/gateway tests/inference tests/web-dashboard` | 100 files · 1,699 passed |
| New tests | `unattended-job` (24), `autonomy-policy` (9), `composite-plan` (14), substrates in `deliverable-class`, stated titles in `long-form-plan` |
| Hermetic E2E — web book | phases execute · 4 chapters + site + narration script on disk · OUR verify step FAILS at 4/8 units (success=false) · continuation completes it and verify PASSES (success=true, no pendingWork) |

### LIVE run — the hybrid ask, unattended, real models
Goal: *"develop a web-based interactive book: a 20 page story called Mahagatha … with voice
narration for every chapter, presented as a website"* (`nuvira execute --engine pipeline`).

**The cadence problem is FIXED and witnessed in the real CLI:**

```
🛠️ Composite plan: prose + web + python + asset — 8 step(s) across 5 phase(s), 8 content units
🤖 Unfinished work detected — 8 of 8 content units remaining. Continuing automatically; no reply needed.
🛠️ Still working — 4% · 📖 chapter 0/8 · 2/14 deliverable files (batch 2). No reply needed…
🛠️ Still working — 14% · 📖 chapter 1/8 · 582/7,000 words · 4/14 deliverable files (batch 3)…
… batches 4-8, zero human input …
🛠️ I could not finish this one — 14% done (📖 chapter 1/8 · 582/7,000 words · 4/14 files).
   stopped after 6 consecutive failed batches — last error: ❌ Completed 1/4 tasks with some failures in 2.7s
```

**8 batches, one command, no "continue".** Artifacts on disk: `site/index.html`,
`site/styles.css`, `site/reader.js`, `site/content.json`, `content/chapters/01-chapter-1.md`.

**Batches 4–8 failed at the MODEL layer, fast (2.7s each, provider errors), and the hardened
agent responded correctly**: measured the real progress, reported `14% done` instead of
"Failed", stopped at the failure cap, and produced a precise reason. Compare the baseline:
six 30-second "Failed" messages, nothing on disk, and a model-availability claim that was
false. The remaining work is resumable from the ledger.

**Not yet enterprise-grade (state at the end of Session 7):** G13 (loop-engine confirmation round
trips AND an authored ask being satisfied with chat text that never reaches disk), the full
39-unit/100-page unattended run, and a per-batch cost/latency report. None of them is a regression;
all are recorded above with evidence. **Superseded by the G13a/G14/G15 sections above:** G14,
G15 and the confirmation-round-trip half of G13 were closed afterwards; the missing-delivery half
is now tracked as G13b and remains open.

---

## Session 10 — PROVENANCE AND HONEST LABELS (G22–G26)

The follow-ups from the Models-page audit's own recommendation. The through-line: **the store
records what happened, and the VIEW must be able to say where a number came from.** Nothing here
hides data or filters it away — every change is a label, a count, or a notice.

### G22 — a test-origin record can no longer move a chart `[x]`
G21 fixed the leak at the source (the harness had no env isolation) and left the 2,110 chained
fake-telemetry lines in place, because rewriting a **hash-chained, tamper-evident** log to make a
chart look nicer is the data owner's call. This closes the reporting half:
`ActionTelemetryEntry.origin` (`live` | `test`) is stamped at the **single write path** by
`telemetryOrigin()` — not passed by callers, because the caller that forgets is exactly how the
poison got in. `aggregateActionTelemetry` excludes `origin: 'test'` from every number and reports
`insights.synthetic` so the exclusion is **stated**, in the dashboard stat card ("Test-origin,
excluded") and in `nuvira models status --verbose`. `includeSynthetic: true` is available for a
caller whose subject IS the log. Records with **no** origin are treated as live, so old data keeps
working.

### G23 — cost is LABELLED, never used to hide a model `[x]`
The suggested "free models only" filter is the same lie as the old "509 available", pointing the
other way: a user who just bought $20 of OpenRouter credits would see nothing appear and conclude
the purchase failed. New `src/inference/model-entitlement.ts` classifies each provider × model as
`free` | `metered` | `unknown` and states its `basis`, rendered as a cell chip with the reasoning in
the tooltip. **The load-bearing case is negative:** the catalog carries `0/0` pricing for Gemini and
the codebase's own auto-router notes *"Gemini paid models 403 without billing"*, so a zero price is
NOT labelled free — `free` is only claimed for a provider-declared `:free` id or a local runtime,
and `nuvira` (keyless, localhost, but a **gateway to providers that bill**) is deliberately not one.

### G24 — an unusable model now says WHY `[x]`
`/api/models` passes the registry's learned `lastError` and `deadPair` per model, so a cell reads
"Not served here — this id does not exist on the endpoint" vs "Your key cannot use this model
(auth / entitlement / access)" instead of a flat "unavailable". This is what removes the temptation
to say "requires purchase": a dead pair is a permanent fact about the endpoint, while an auth
failure is repairable by the key's owner — and neither is a claim about the user's wallet.

### G25 — a purchase mid-session is noticed `[x]`
There is no per-model entitlement API to ask ("may I buy `meta-llama/…`?" is not a question
OpenRouter answers); the only honest signal is *"we sent one token with this key and it answered"*.
But noticing that the **key set** changed is cheap, and it was invisible: the pool only grows from a
probe, and probes only ran on a cold start. New `src/learning/credential-fingerprint.ts` stores a
SHA-256 digest of the credential **shape** (which providers, key digests, base URLs, env presence —
never a key, not even truncated) and `runWarmupCycle` forces one `refreshModelRegistry` when it
differs. Fires **once** per change; `firstRun` is reported separately so a fresh machine is not
treated as a purchase.

### G26 — the sweep's bounds are configuration, not constants `[x]`
`warmupConfig()` resolves interval / hot budget / exploration budget / exploration throttle / hot &
warm windows from `NUVIRA_WARMUP_*` (invalid values fall back rather than disarming or spinning up
the sweep). The sweep is safe because it is bounded — so the bounds are exactly what an operator
needs to see and tune per plan, instead of a source edit and a rebuild.

### Verification (Session 10)
| Check | Result |
|---|---|
| `tsc --noEmit` (root) | clean |
| `src/web-dashboard/server.ts` | clean (typechecked directly — the root tsconfig excludes `src/web-dashboard`, and the dashboard tsconfig has 45 **pre-existing** errors in `api.ts`/`*.test.tsx`, unchanged in count and none in the files touched here) |
| `tests/learning tests/inference` | 81 files · **1,826 passed** |
| `tests/tools tests/agents tests/gateway tests/cli` | 145 files · **2,610 passed** |
| `tests/integration tests/nlu tests/commands tests/skills` | 32 files · 548 passed (13 skipped) |
| dashboard suite (`npm run test:dashboard`) | 27 files · **291 passed** |
| New tests | `model-entitlement` (8 — incl. the zero-price "not free" case and the nuvira gateway) · `credential-fingerprint` (9 — fires once, first-run ≠ change, base-URL change, corrupt sidecar, **never stores a key**) · `telemetry-provenance` (10 — runner detection, exclusion, `synthetic` count, write-path stamping, raw chain intact) · `model-warmup` +7 (re-probe once on change, survive a failed re-probe, env bounds actually used) · `ModelsPanel` +4 (listed-vs-routable, dead-pair wording, chips rendered, provenance card conditional) |

**Two test suites had to be told the truth deliberately:** `model-registry` / `provider-fallback`
inspect the action log, so they now pass `includeSynthetic: true` (their subject IS the log); and
`cli/models.test.ts` **models a live run**, so it pins `TELEMETRY_ORIGIN=live` for its duration —
which is precisely what that override exists for.

**Left open, unchanged:** G13b (the loop engine satisfies a file-shaped authored ask with chat text
and writes nothing to disk) and G18 (the loop engine's tool calls/gate refusals are not in the trace
store). The 2,110 chained fake lines are still in the log — now counted, labelled and excluded from
every view, and still the data owner's call to re-chain.

---

## Session 11 — THE ARTIFACT LANDS, AND THE RUN ACCOUNTS FOR ITSELF (G13b, G18, G27)

Three gaps were left open with reasons. All three are now closed, and the order they were closed
in was deliberate: **make the artifact land, then run the real long job, then instrument it with
what the run actually needed to see.**

### G13b — an authored artifact cannot be answered with chat text `[x]`

The failure was never "the agent cannot write files" — the loop engine has `write_file`. It was
that the loop's idea of *done* was *a turn ended*, while for an authored deliverable it has to be
*an artifact exists*. Two live runs (a 12-page story, a web-book) composed excellent prose into the
chat window and wrote nothing.

**Two predicates, because the two questions are different:**

| Predicate | Rule | Who uses it | Why that one |
|---|---|---|---|
| `wantsAuthoredArtifact` | `isAuthoredGoal` AND the request authorized writes | engine router, loop deliverable gate | both run only AFTER the ask is known to be a task, so "a creation verb on an authored noun" is enough evidence — and it covers the HYBRID "web-based book" shape |
| `asksForAuthoredFile` | `isAuthoredGoal` AND (a multi-unit magnitude OR a **named destination path**) | the chat-vs-task gate | the gate must stay narrow: for "write a poem about rain" the text IS the deliverable |

The narrow half is what the live failure needed. `write a 2 page story to /path/kharig-nights.md`
resolves to ONE unit, so the existing `isLongFormDeliverable` magnitude rule missed it and the ask
fell through to the NLU's chat mapping — a complete story in the reply, no file at the path the
user named. The gate is the only place that could fix it (every surface routes through it, and the
engine router is never reached when the ask is called chat), so the fix went there.

**Pinned chat asks were the guard rail, and this is where the first attempt failed.** The initial
(broad) predicate re-routed "write a poem about rain", "write a song in Hindi", "write an essay
about my village", "write a 1 page summary" and "a book" (a DEFAULT magnitude is not a request)
to the pipeline — 8 test failures across `conversation-gate`, `dev-plan-sequence`, `gateway/registry`
and `retry-loop`. Splitting the predicate fixed all 8 without weakening the rule, and the split is
now pinned from both sides in `deliverable-class.test.ts` (the poem separates them).

`engine-router.ts` also routes the default path to the pipeline on the broad predicate, so an
authored deliverable no longer depends on the provider TIER (a strong tier used to mean "loop", and
the loop answered in chat). An explicit `routing.engineMode='loop'` still wins — which is exactly
why the loop engine carries its own deliverable gate.

**The loop gate.** One bounded nudge naming the destination the request itself gave, at BOTH turn
exits (the no-tools path a story ask actually takes, and the concluding path), placed AFTER the
verification gate so edit turns stay byte-identical (a turn that wrote nothing has nothing to
verify, so the two cannot both apply). Plus an honesty flag `undeliveredArtifact` that is a function
of what the turn DID, not of configuration — so no caller can read "the story is done" from a turn
that wrote no file, whether or not the gate is enabled.

### G18 — the loop engine is no longer invisible `[x]`

Recorded because it bounded every claim in Sessions 7 and 8: the loop wrote no reasoning trace, so
gate refusals, the cadence, and which branch a gate took were all invisible. "The trace store showed
0 refusals" meant *it cannot see refusals*, not *there were none*.

`TraceEvent` is a **separate** record from `TraceStep`, and that separation is the design: a step is
an LLM call (prompt digest, model, tokens, latency) and feeds `getTraceStats`; a tool call is none
of those, and folding it in would corrupt every aggregate the Trace tab already reports. So a trace
now has `steps` AND `events`, and stats count `totalEvents` / `refusals` / `gateDecisions`
separately.

- **Loop LLM steps** are recorded too (`source: 'loop'`), with the thread serialized through the
  SAME layer splitter the chat transport uses — otherwise a loop prompt lands in the "unknown
  shape" branch, the stable layer is the whole growing thread, and the one question the layers exist
  to answer (did the system layer stay byte-stable?) can never be answered for an `execute` run.
- **Events** carry what a later reader needs: the args the gate saw, the first line of the result
  (pre-decoration — hints and tips are the loop's own additions), the verdict, and the wall-clock.
- **Refusals are classified** (`classifyToolRefusal`): a confirmation decline, a loop guard, an
  unknown tool, an unloaded toolset, a disabled tool. A guard is not a provider error, and only the
  record can tell them apart.
- The loop DESCRIBES; the surface records. `onTraceEvent` is an option (best-effort, wrapped so a
  broken recorder can never break the turn it observes), not the loop reaching into the store —
  that coupling is what kept it invisible.
- `nuvira trace show` lists events; `-v` prints each tool result under its call, which closes the
  other half of the Session 8 limit: a live run can now distinguish "the gate applied the edit
  autonomously" from "the model passed `confirm:true` without asking".

### G27 — a long unattended run accounts for itself (new)

The run reported a batch COUNT and a percentage, which answers neither question a long job raises:
what did it cost, and is it slowing down. Both had to be reconstructed by hand from the cost ledger.

`UnattendedJob` now carries `costUsd`, `tokens` and a bounded `batchStats[]` (100 rows), and
`formatBatchReport(job)` prints the per-batch table plus a measured total. Three properties matter:

- **The window is measured from the PERSISTED ledger**, not a session counter (`costSince`). Each
  batch runs through a FRESH orchestrator and, after a resume, a fresh process — a per-instance
  counter would report zero for every batch but the first.
- **Failures are accounted.** A batch that died on a provider error still burned tokens; counting
  only the batches that reached the success path would understate the bill of exactly the runs most
  likely to be expensive.
- **A dash is never a fabricated 0.** "Free" and "not measured" must stay distinguishable, so the
  columns are absent when a surface did not measure them and render `—`.

Both surfaces feed it: the CLI `runBatch` and the gateway's `runUnattendedBatch` (so a WhatsApp book
is measurable too).

### Verification (Session 11)

| Check | Result |
|---|---|
| `tsc --noEmit` (root) | clean |
| `npm run build` | clean (tsc + dashboard bundle) |
| `tests/tools tests/learning tests/nlu tests/gateway tests/cli tests/integration tests/inference tests/agents tests/commands` | 249 files · **4,913 passed** |
| `tests/agent-sdk tests/config tests/context tests/docs tests/editing tests/enterprise tests/federation tests/memory tests/mcp tests/plugins tests/sandbox tests/scripts tests/security tests/skills tests/team tests/utils tests/web-dashboard tests/workflow tests/e2e tests/live` | 80 files · 1,607 passed (18 skipped) |
| dashboard suite (`npm run test:dashboard`) | 27 files · **294 passed** |
| New tests | `cost-window` (4 — the window boundary, a true zero, the sum, and a NEW process seeing a prior batch's spend) · `unattended-job` +6 (accumulation across batches incl. a failure, the rendered table + totals, a dash for unmeasured columns, no rows for no batches, persistence, `formatDuration`) · `deliverable-class` +5 (the narrow rule: magnitude, named destination, the pinned chat asks, a bare "book", and the poem that separates the two predicates) · `engine-router` +9 (G13b routing, the hybrid web book, the chat negations, the explicit-override negation, no-goal unchanged) · `tool-loop` +N (the deliverable gate on both exits, the honesty flag, the trace events) |

**The regression this session found is worth recording as a lesson:** the first version of the
predicate was correct for the ENGINE and wrong for the GATE, and the test suite caught it in one
run — because those chat asks had been pinned as deliberate decisions in earlier sessions. Pinning
a decision with a test is what made a too-broad rule impossible to ship.

### LIVE — the 100-page unattended book, end to end

The ask that had never been attempted: **"write a 100 page book to /tmp/…/mahagatha.md titled
Mahagatha, an epic fantasy about a village boy who finds a lamp in a banyan root"** — one command,
no reply, no "continue".

| | Result |
|---|---|
| Ask → engine | `authored-artifact` → **pipeline** (the router rule), one `nuvira execute` |
| Units | 39 chapters, `chapter 39/39 complete` |
| Deliverable | `mahagatha.md` assembled — **58,583 words** (58,428 across the chapters), 167 pages against the 100 asked for |
| Batches | **9**, run by the unattended runner with no human in the loop |
| Status | `done` · `stopReason: complete` |
| Cost | **$0.03037** · 93,995 tokens |
| Wall clock | ~28 min, including a 6m 09s batch and an 11m 11s batch that ran on a FREE (`gemini`) tier after groq's circuit breaker opened |

**The per-batch report, verbatim from the run:**

```
📊 Per-batch cost & latency
   batch    done       tokens        cost      time
       1     58%       11,599    $0.00669     19.6s
       2     68%        6,593    $0.00337      9.7s
       3     83%       11,847    $0.00000    6m 09s
       4     97%        9,540    $0.00591     13.6s
       5    100%        9,697    $0.00600     14.5s
       6    100%        8,935    $0.00309     12.7s
       7    100%            0    $0.00000      2.2s  ✗ ❌ Completed 3/4 tasks …
       8    100%       25,281    $0.00000   11m 11s
       9    100%       10,503    $0.00531     10.9s
   total    100%       93,995    $0.03037  ~2m 05s avg
```

**What the report made visible that nothing else could.** Three batches cost **$0.00** and took
minutes rather than seconds — the run had fallen through to a free tier after a rate limit, which is
exactly the trade a user would want to see and could not previously. Batch 7 failed (3/4 tasks, an
"answered with its own reasoning" writer, 0 tokens) and is **accounted for rather than hidden**: the
report is the record that the run had a bad batch and still finished. And the whole book cost three
cents.

**Two things the live run exposed, both fixed here.**

1. **The percentage saturated before the work was done.** Writers overshoot: by chapter 31 of 39 the
   word total was 43,906 against a 35,000 target, so the line read *"chapter 31/39 complete … 100%"*
   and batches 5–9 all reported 100% while eight units were still owed. `jobProgress` now takes the
   **minimum** of word-completion and unit-completion, so 100% means the deliverable EXISTS. This is
   the same class of contradiction as a listing count presented as a capability, one layer down.
2. **A refusal that read as a success.** See below — found on the first G18 verification run.

### LIVE — the loop engine, both halves (G13b + G18)

`nuvira execute "write a 2 page story to /tmp/…/kharig-nights.md about a village boy who finds a lamp
in a banyan root" --engine loop`:

- the artifact **landed** (`kharig-nights.md`, 5,119 bytes) where the pre-fix runs wrote nothing; and
- the trace records **11 events**: `refusal/workspace write_file`, `refusal/confirmation ask_user`,
  `gate/deliverable`, `tool write_file`, `gate/verification`, `tool read_file` … with
  `outcome.tools = [write_file, suggest_followups, read_file]` — the **successful** tools only.

**The honesty bug this found, and it is the exact shape G18 exists for.** On the first verification
run the model tried an absolute path, the workspace guard declined it — and the trace read
`write_file ran`, because the denial carried no `Error:` prefix and the loop's own `ranOk` test was
`!startsWith('Error:')`. A refusal was recorded, counted in `successfulToolCalls`, and rendered as
work done. It is now classified (`gate: 'workspace'`) and **the refusal classifier is the authority
for both the event kind and the success verdict**, so the two can never disagree again. Anchored to
the boundary phrasings rather than the bare word "denied", because a `run_terminal` that reads a log
containing "Permission denied" is a successful call.

### G28 — an `ask_user` TOOL call for authorized work is still a round trip `[ ]` (new, open)

Recorded because the G18 trace made it VISIBLE on the first loop verification run, and it is the
permission-seeking failure one layer down. The request named its destination and authorized the
write, yet the model called the **`ask_user` tool** twice ("Where should I save the story file?") — a
round trip in an interactive run, and in an unattended one an arbitrary self-answer ("Nobody was
available to answer in this run, so 'Yes, create inside workspace' was assumed"). The outcome was
still right — the autonomy gate proceeded on `write_file` and the artifact landed — but two calls and
one empty step were spent asking a question the request had already answered. The text-level
`detectPermissionSeeking` nudge does not see a TOOL call, and `ask_user` is deliberately NOT gated
(an irreversible action must be able to reach the user). The fix is not "gate ask_user": it is to
answer the question from the request's own authorization when the request already settled it, the
same way the write gate does. Not a regression, not attempted here, and now measurable in the trace.

### G29 — the followups contract leaked as raw JSON into the answer `[x]`

Found by the user reading their own calculator chat: every turn ended with
`{"suggest_followups":[{"label":…,"prompt":…},…]}` rendered as the last lines of the answer.
Counted in the store: **13 of that session's 16 assistant turns**, and **16 turns across all
sessions** — with `followups` never captured, so no chips appeared either. The user got neither half
of the contract: the plumbing as text, and none of the suggestions as data.

The root cause is a vocabulary that exists in only ONE of its shapes. `stripToolCallArtifacts`
(`src/inference/tool-call-utils.ts`) is the single strip every surface calls — CLI chat, `execute`,
dashboard console, gateway — and it knew three shapes: the canonical
`{"tool":"suggest_followups","arguments":{…}}`, the bare arguments object `{"followups":[…]}`, and the
captioned bare array. The shape models actually hand-write is the tool's **ARGUMENTS keyed by the
tool's own NAME**, and it matched none of them. The canonical shape — the one our own
`TOOL_CONTRACT_JSON` gives as the example — appeared **ZERO times** across 116 stored assistant
turns, so matching only that shape matched nothing in practice.

Three things were wrong, and each needed its own fix:

1. **The strip did not know the shape.** `isFollowupsPayload` now accepts the name-keyed payload
   (`[…]` directly, or `{followups:[…]}` under it). Because every surface already routes through this
   ONE helper, that single change cleans chat, execute, dashboard AND gateway.
2. **The recovery did not either.** The loop's text-call recovery was gated on
   `content.includes('"tool"')` — a gate that only knows one shape silently disables the fix for the
   other — and `extractFallbackToolCalls` could not parse the shape anyway. The gate is now the shared
   `TEXTUAL_TOOL_CALL_HINT`, and the name-keyed block becomes a REAL `suggest_followups` call, so the
   loop's existing sink collects it and every surface renders chips/menus.
3. **Already-stored turns stayed broken.** The dashboard's `history()` served the transcript
   verbatim, so reopening a session (or the 15-second refresh) re-rendered the stored garbage.
   Sanitizing on READ — never on write, the transcript is the user's record — is what makes the fix
   apply to the sessions that already exist, and it also stops the raw JSON being fed back to the
   model as its own history.

**Conservatism is the whole difficulty**, because this helper must never delete a deliverable. The
name-keyed branch is therefore STRICT: the tool's schema only ever allows `{prompt,label}` objects, so
`{"suggest_followups":["alpha","beta"]}` (a list of plain strings — a config a user could have asked
for) and `{"suggest_followups": "a note"}` both survive untouched, as does an unterminated code block
that is not our opener. A truncated payload is consumed only where it is bounded (inside a fence) or
handled by the loop's own extraction.

A **pre-existing cosmetic bug** fell out of the replay: `stripTrailingFollowupsHeader` required the
horizontal rule to sit at the very end of the string, but the caller slices at the payload's opening
brace, so a model writing `…answer\n\n---\n{payload}` left a dangling `---` under the cleaned answer.
It tolerated no trailing newline (`[ \t]*$`) where it needed to (`\s*$`).

**Verified against the real data, not a fixture:** replaying all 16 stored payload turns through
loop-extraction + the surface strip gives **0 raw JSON, 16/16 recovered, 0 dangling `---`**.
New tests pin the shape from both sides (recovery + strip + an end-to-end `answerOnce` assertion that
the text is clean AND the followups reach the caller), 5 new tests total, and the read-path test
asserts the store itself is NOT rewritten.

### What is still not enterprise-grade

The 2,110 pre-existing chained test-origin telemetry lines (G21 — counted, labelled, excluded, and
still the data owner's call to re-chain). **G28**, above. And the honest residual from the live run:
the book's own quality is the model's, not the harness's — the harness guarantees that ALL 39 units
exist, are contiguous, and are assembled; it does not (and cannot) guarantee the prose is good.

