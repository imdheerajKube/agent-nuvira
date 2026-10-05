# Assessment — agent-nuvira vs freebuff on a real build: `cal` → Android (2026-10-05)

**Date:** 2026-10-05
**Task:** Take `/Users/dheeraj/Documents/cal` (a JS/Vite scientific calculator with a Tauri desktop shell) and deliver an Android app.
**Form:** Capacitor WebView wrapper (agreed up front).
**Model:** pinned to DeepSeek V4.1 Flash, `NUVIRA_STRICT_MODEL=1`.
**Mode:** autonomous run by agent-nuvira, supervised by the freebuff agent (me).

---

## 1. Outcome in one line

**agent-nuvira autonomously produced the entire Capacitor Android scaffold and built the web assets, but did not produce an APK.** I (freebuff) installed the missing toolchain and produced a working debug APK in ~30 s of build time. The APK exists:

```
/Users/dheeraj/Documents/cal/android/app/build/outputs/apk/debug/app-debug.apk   (4.1 MB)
applicationId / namespace = com.cal.app
```

## 2. What agent-nuvira actually did (verified from its logs/traces)

| Step | Result |
|---|---|
| `read_file` ×4, `list_dir` — recon | ✅ |
| `plan_todo` — a 7-step plan | ✅ (decomposition was correct) |
| `npm install @capacitor/core @capacitor/cli @capacitor/android` | ✅ (v8.5.2) |
| `write_file capacitor.config.json` (`appId: com.cal.app`, `webDir: dist`) | ✅ |
| `npx cap add android` | ✅ |
| `npm run build` (Vite web assets) | ✅ |
| `npx cap sync android` | ✅ |
| `./gradlew assembleDebug` | ❌ failed (exit 1) |
| README.md / DELIVERY_REPORT.md | ❌ never written |

It ran out of turn with an **instructional** close ("Ensure you have JDK 21 … run `./gradlew assembleDebug`"), not a delivered artifact — it deferred the last mile to the user.

## 3. Why it failed (root causes, separated)

1. **Model/provider instability — the dominant cause.** The pinned `deepseek-flash` failed repeatedly mid-run ("deepseek failed — trying the next loop candidate…"), and **`NUVIRA_STRICT_MODEL=1` did not prevent the loop engine from falling through** to groq then gemini (5 fallthroughs observed in run 2). Gemini later returned `500 Internal`, and run 3 degraded into confused narration ("6 attempts so far…"). So the harness was reliable; the model supply was not.
2. **An un-remediated environment fact.** The first real Gradle failure was a JDK-version error (Capacitor 8 needs JDK 21; the toolchain I first installed was JDK 17). agent-nuvira *diagnosed it correctly* but did not fix it (it never installed/pointed to JDK 21), whereas the supervisor did and the build then succeeded in 30 s.
3. **No `android/local.properties`.** Gradle resolution was not pinned to the SDK via `sdk.dir`; the supervisor added it and the build passed.

Notably, **none of these were capability gaps in planning or orchestration.**

## 4. The comparison, dimension by dimension

| Dimension | agent-nuvira | freebuff (me, supervisor) |
|---|---|---|
| **Code execution** | Ran the right commands in the right order (`npm`, `npx cap`, `gradlew`); no hallucinated commands. | Ran `./gradlew assembleDebug` with the correct JDK/SDK and got `BUILD SUCCESSFUL`. |
| **Debugging** | **Diagnosed the JDK-21 cause correctly**, but did not remediate; repeated the same failing command. | Fixed the environment (JDK 21 + `local.properties`) and completed the build. |
| **Static analysis** | Not exercised here; a prior agent-nuvira run left `cal/CODE_ASSESSMENT.md` (found `new Function` in `mathEngine.js`, unbounded factorial). | Not exercised here. |
| **Documentation generation** | ❌ `README.md` / `DELIVERY_REPORT.md` not written — it ran out of turn before the docs step. | Delivered the APK; docs were the agent's unmet step. |
| **Code review & critique** | Has a working path (the pre-existing `CODE_ASSESSMENT.md` is evidence). | n/a |
| **Planning & orchestration** | ✅ Strong: a correct 7-step plan; a real decomposition of install → init → config → build → sync → APK → docs. | I did not re-plan; I executed the one blocked step. |
| **Tracking execution** | ⚠️ **Defect: the plan counter stayed `1/7 (14%)` across many successful steps.** `plan_todo` accepted `status: done` updates but the progress aggregate did not advance — execution tracking lies about progress. | n/a |
| **Loop capability** | ✅ Real: `Step bound reached … continuing (continuation 1/4 → 2/4, budget 32 → 49 steps)` — it persists across step bounds and keeps working. | Single supervised continuation. |
| **Mid-way failure navigation** | ⚠️ Weak: it retried the same failure with minor variations, then deferred to the user, instead of changing approach (install JDK 21). | Correct: changed the environment, succeeded. |
| **Communication** | Clear, honest close (it stated the APK was still missing). It did **not** claim a false success — the honesty gate is working. | — |
| **Seeking genuine user input** | ✅ It asked **no** questions — correct here, since the goal was unambiguous. It did not spam spurious prompts. | I asked 4 scoping questions before spending hours; the right call for an ambiguous, expensive task. |
| **External skills (marketplace)** | Not used (Capacitor came from npm directly). The capability exists. | n/a |
| **API adapters** | ⚠️ The configured DeepSeek **model name is wrong**: `buffconfig.json` sets `"model": "DeepSeek-V4.1-Flash"`, which the API rejects ("supported names are `deepseek-flash`, `deepseek-v4-pro`"). | Used the real name `deepseek-flash`. |
| **Workflow composition** | ✅ `plan_todo` + `run_terminal` + `write_file` composed into a coherent pipeline. | n/a |

## 5. Verdict

- **Orchestration, planning, loop persistence, and honesty: agent-nuvira is genuinely strong.** It produced a complete, correct Capacitor project skeleton on its own.
- **Delivery: agent-nuvira did not finish.** It needs a model that stays up and, on environment failures, the willingness to remediate rather than defer.
- **This task: freebuff delivered the artifact.** The gap was not intelligence or planning — it was (a) provider stability under a pinned model, (b) strict mode not actually refusing substitution, and (c) an un-taken remediation step.

## 6. Actionable defects found

| # | Defect | Evidence | Fix direction |
|---|---|---|---|
| A1 | **`plan_todo` progress counter does not advance.** | Plan stuck at `1/7 (14%)` after 4 successful steps. | Recompute progress from step statuses on every update; add a test that N `done` updates move the aggregate. |
| A2 | **`NUVIRA_STRICT_MODEL=1` does not stop loop-candidate fallthrough.** | "deepseek failed — trying the next loop candidate…" ×5 with strict on. | The loop engine's candidate selection must consult strict mode (route-resolver does; the loop does not). |
| A3 | **DeepSeek config model name is invalid.** | `buffconfig.json` → `DeepSeek-V4.1-Flash`; API says `deepseek-flash`. | Correct the configured id; validate model ids against the provider's `/models` before saving. |
| A4 | **Environment failures are deferred, not fixed.** | JDK-21 diagnosis followed by instructions, not remediation. | On a recognized toolchain error, take the bounded fix (install/select the required JDK) before ending the turn. |
| A5 | **OpenRouter DeepSeek V4.1 Flash needs credits.** | `402 Insufficient credits … never purchased credits`. | Use the native DeepSeek provider (`deepseek-flash`), which works. |

## 7. Environment set up for this run (reusable)

```
~/android-toolchain/jdk21/Contents/Home      # JDK 21 (Capacitor 8 requires ≥21)
~/android-toolchain/android-sdk              # platform-tools, platforms;android-34, build-tools;34.0.0
```
`cal/android/local.properties` pins `sdk.dir` to that SDK.

---

*All claims above were verified from the run logs (`tmp/cal-android-run{,2,3}.log`), the agent debug logs and trace ids, the `cal` tree, and the successful supervised build.*
