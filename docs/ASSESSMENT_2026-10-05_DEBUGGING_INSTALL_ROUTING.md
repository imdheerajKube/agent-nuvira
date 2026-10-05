# Assessment — debugging, installation remediation, and routing (2026-10-05)

**Scope:** the shortcomings observed on the supervised Android run against
`/Users/dheeraj/Documents/cal` and the WS7 seeded-bug suite, split into the four
things the request named: **debugging capability**, **installation
remediation**, **loop-stuck behaviour**, and **routing**. Every claim is traced
to a log, a file, or a benchmark report already in this repo.

This document accompanies two fixes landed the same day:

- **A1 — plan tracking** (`plan_todo` counter froze at `1/7`).
- **A2 — strict mode** (`NUVIRA_STRICT_MODEL=1` did not stop the loop engine
  substituting another provider).

and one capability added the same day: a **per-chat strict pin** in the
dashboard and a plain-English routing notice when a pin does not hold.

The open defects A3, A4 and A6 below were then closed the same day, and
OmniRoute was added as a provider (see §5).

---

## 1. Debugging capability — diagnosable, but it stops at the diagnosis

**What it did well.** On the `cal` run the agent correctly identified the real
cause of the Gradle failure: the project compiles at `JavaVersion.VERSION_21`
(Capacitor 8) while the environment had JDK 17. It read
`node_modules/@capacitor/android/capacitor/build.gradle`, grepped for
`JavaVersion`, ran `java -version`, and reasoned to the right conclusion. That
is real debugging, not narration.

**Where it stops.** Having found the cause it did **not** act on it. It retried
the same failing command with small variations, then closed the turn with
instructions for the user:

> "Since I cannot update your system's Java version, this is a blocker that
> requires your manual intervention."

The supervisor fixed it in ~30 s (point `JAVA_HOME` at a JDK 21, add
`android/local.properties` with `sdk.dir`, rerun `./gradlew assembleDebug` →
`BUILD SUCCESSFUL`). So the failure was **not** environmental in the sense of
"impossible to fix"; it was an un-taken remediation step.

**The precise defect.** The agent's own world model says "I cannot modify the
system," so a fix it can *see* is classified as out-of-scope and handed back.
But it had, in the same turn, already written files (`capacitor.config.json`)
and run `npx cap add android` — it was clearly authorised to act in the
project. The missing distinction is **project-local remediation vs
system-wide mutation**: setting `local.properties`, `gradle.properties`, or an
env var *for the build command* is project-local and should be taken; changing
the user's default JDK is system-wide and may be deferred.

**Direction:** on a recognised toolchain error (JDK version, missing SDK
licence, `sdk.dir`, a missing build tool), take the **bounded, project-local**
fix before ending the turn — write `local.properties`, select the required JDK
for this one command, accept SDK licences — and only defer the irreducible
system change. A remediation that is a file write or an env var scoped to a
child process is not "manual intervention."

**Honesty held.** It did **not** claim success: the close says the APK is still
missing. The false-success gate is working on this surface.

---

## 2. Installation remediation — why it gets stuck in a loop

**Observed loop.** Run 2 shows the classic shape: `./gradlew assembleDebug`
fails → `:capacitor-android:compileDebugJavaWithJavac --stacktrace` fails →
`cat android/capacitor-android/build.gradle` fails (wrong path) → `ls -R …`
fails → the loop's own stall detector fires ("4 steps with no successful
action — asking the model to diagnose the stall") → it probes more paths, some
succeed, but the underlying build is never fixed. Meanwhile the provider
beneath it is failing repeatedly (`deepseek failed … groq failed … gemini
failed`), so *the diagnosis model itself is being handed off mid-thought*.

**Root causes, separated:**

1. **Provider instability dominates.** With the pinned model flapping, the
   agent's reasoning continuity is broken: each fallthrough is a different
   model resuming a half-diagnosed problem. A loop is the natural result — the
   incoming model re-derives the same cause and re-tries the same command.
2. **No remediation ladder.** There is no notion of "I know this class of
   error; take the known fix." Each failure is treated as novel, so the agent
   explores rather than repairs. Installing a *known* toolchain (JDK 21 /
   Android SDK) is exactly the kind of task where a ladder — not exploration —
   is correct.
3. **Strict mode was not actually strict** (A2, fixed today). Falling through
   to a weaker provider on every retry is what turned a one-pass fix into the
   appearance of a loop.
4. **The done-state is not checked against the artifact.** The plan had a
   "produce the APK" step; the agent never confirmed the APK exists, so the
   loop had no objective signal to stop on.

**Direction:** (a) a small, declared **remediation map** (error signature →
bounded local fix) consulted before free exploration; (b) feed strict mode into
the loop's candidate walk so a pinned run is not handed off (done, A2); (c) make
the deliverable the loop's stop condition — a step that names an artifact is
not "done" until the artifact is on disk.

---

## 3. Loop-stuck behaviour — the guardrails that already exist

The engine is not without defences: the plan gate blocks the first mutation
until a plan exists, a stall detector asks for diagnosis after 4 no-op steps,
the step budget extends in bounded continuations (`continuation 1/4 … 2/4,
budget 32 → 49`), and a durable step hand-off records what is still outstanding
so the next model does not re-derive it. The `cal` run used every one of these.

What it lacks is the **join** between them: a hand-off that says *"the build
fails and here is the known fix"* rather than *"the build fails."* The
hand-off record exists (`step-handoff.ts`); its remediation content does not.

---

## 4. Routing — is the capability weak, and should we adopt OmniRoute?

### 4.1 What we actually have

The multilayer router is **not** weak; it is more sophisticated than a router
usually needs to be:

- `src/learning/auto-router.ts` — 5 scored dimensions (reasoning, speed, cost,
  privacy, reliability), complexity-shifted weights, plus a bandit
  (`router-bandit.ts`), an ML router (`ml-router.ts`), a promotion mechanism
  (`router-promotion.ts`), and a model-first tiered chain
  (`model-first-router.ts`).
- `src/inference/route-resolver.ts` — validates provider+model as a **pair**
  against the adapter that will serve the call, repairs a stale model, and
  audits every substitution.
- `src/inference/model-validator.ts` — repairs a dead pinned model to a
  verified-working one via a live model list.
- `src/learning/provider-fallback.ts` + failure bookkeeping — circuit
  breakers, registry write-through, quota timelines.

The defects we found are not "the router cannot route"; they are **gaps between
the router and the engines that consume it**:

- **A2 (fixed):** the loop engine's candidate walk ignored strict mode, so a
  pinned model was substituted anyway.
- **A3 (open):** the configured DeepSeek id was invalid
  (`DeepSeek-V4.1-Flash`); the provider accepts `deepseek-flash`. A router that
  never checks a pin against the provider's `/models` will keep sending a dead
  id.
- **Attribution:** on the free tier a run's provider recorded is the
  *requested* one, not the one that served each task, which is why the first
  two WS7 scorecards could not be read as single-model measurements. The
  strict-mode pin (now honored end to end) is what makes attribution real.

### 4.2 What OmniRoute is

OmniRoute (`diegosouzapw/OmniRoute`, MIT, local-first) is an **AI gateway**, not
a routing brain: one OpenAI-compatible endpoint in front of ~350 providers and
~1,200 model ids, quota-aware auto-fallback, 19 per-combo routing strategies
(priority, weighted, p2c, cost-optimized, headroom, lkgp, fusion, pipeline …),
token compression, and MCP/A2A exposure. Its value is **aggregation, quota
pooling, and an extra upstream failover layer** — 150+ free tiers behind one
key.

### 4.3 Recommendation — do not replace our router; adopt OmniRoute as a provider

Replacing the multilayer router with OmniRoute would be a **downgrade for the
agent use case**: OmniRoute routes *provider connections*, while our router
also scores task fit, agentic capability, privacy/local-ness, and verified
model health — the things an agent deciding "which model for this step" needs.
OmniRoute has none of that task-awareness by default (it optimizes cost, quota
and latency).

But OmniRoute solves a real problem we have: **provider supply and quota on a
free/cheap tier**, which is the dominant cause of the instability above.

**The pragmatic path:**

1. **Keep and finish the in-house router** (fix A3; make strict authoritative —
   done; make every substitution attributed).
2. **Add OmniRoute as one more OpenAI-compatible provider adapter** behind our
   existing routing. It then participates in the auto-router as a connection
   with 350 providers behind it, while our router keeps ownership of
   task-aware, capability-aware, privacy-aware selection.
3. **Optionally borrow one idea, not the whole product:** the "lkgp"
   (last-known-good path) and "headroom" strategies are the same class as our
   circuit breaker, so there is no architecture gap — only the aggregation
   reach, which the provider adapter buys.

**Do not** adopt OmniRoute as a replacement; **do** evaluate it as a provider
once the in-house fixes above are in, and measure it with the WS7 suite (which
now produces clean single-model attribution under strict mode).

---

## 5. What was fixed today

| # | Item | Change | Evidence |
|---|------|--------|----------|
| A1 | `plan_todo` counter froze | `PlanStore.resolveStepId` maps ordinals/`step-` prefixes/case onto real ids; `update()` uses it; the tool **refuses** an update that names no step and lists the valid ids | `tests/tools/plan-store.test.ts`, `tests/tools/registry.test.ts` |
| A2 | Strict mode fell through | `strictModelMode()` is an `AsyncLocalStorage`-scoped override; the loop engine collapses its candidate walk to the pinned pair under strict and surfaces the real error; chat's pinned fallback branch is short-circuited | `tests/cli/loop-executor.test.ts`, `tests/inference/route-resolver.test.ts` |
| NEW | Per-chat strict pin | Dashboard chat gains a **🔒 strict / 🔓 auto-fallback** toggle (shown once a model is pinned); `/api/chat` accepts `strict`, scoped to the turn via `withStrictModel`; the response carries a `routingNotice` ("Auto routing took over … to work with X only, enable strict model mode.") | `tests/web-dashboard/chat-api.test.ts` |
| NEW | CLI help | `nuvira chat --help` and `nuvira execute --help` state that a pin does **not** stop auto routing, and that `NUVIRA_STRICT_MODEL=1` is how to force the pinned model only | `src/cli/chat.ts`, `src/cli/execute.ts` |
| A3 | Invalid DeepSeek model id in default config | `validateModelIdForProvider` checks an id against the provider's live model list at the SAVE boundary (CLI + dashboard), refusing with the closest matches; an unreachable/keyless provider saves unverified instead of blocking | `src/inference/model-id-validation.ts`, `tests/inference/model-id-validation.test.ts` |
| A4 | Environment failures deferred, not remediated | `run_terminal` appends a bounded project-local remediation to a recognised failure (JDK, SDK/`local.properties`, non-exec wrapper, toolchain, venv, Node engine, Docker daemon); opt-in `NUVIRA_REMEDIATE=auto` applies only the two idempotent single-file operations | `src/tools/remediation-ladder.ts`, `tests/tools/remediation-ladder.test.ts` |
| A6 | No artifact-checked stop condition | `plan_todo` refuses to mark a step `done` while a file it NAMES is absent | `src/tools/step-artifact.ts`, `tests/tools/step-artifact.test.ts` |
| NEW | OmniRoute as a provider | Keyless `omniroute` catalog entry (default `auto`, `127.0.0.1:20128/v1`) served by the generic OpenAI-compatible adapter — aggregation reach without ceding task-aware routing | `src/inference/provider-catalog.ts`, `tests/inference/factory-constructibility.test.ts` |

## 6. Open defects

| # | Defect | Why it matters | Direction |
|---|--------|----------------|-----------|
| A5 | OpenRouter DeepSeek needs paid credits | Attribution on that route is impossible | Use the native DeepSeek provider, or OmniRoute as a provider |
| A7 | OmniRoute not yet measured | It is a catalog entry only; no local instance has been verified running | Start OmniRoute locally and run the WS7 suite on `omniroute/auto` vs native `deepseek-flash` |

---

*Sources: `tmp/cal-android-run{,2,3}.log`, `~/.nuvira/debug-logs/cli-execute-*.log`,
`docs/ASSESSMENT_2026-10-05_ANDROID_PARITY_CAL.md`,
`docs/benchmarks/seeded-bugs-deepseek-deepseek-flash.md`, the routing modules
named above, and `https://github.com/diegosouzapw/OmniRoute`.*
