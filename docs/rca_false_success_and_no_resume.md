# RCA — false success, and a work ledger nothing reads

**Status:** fixed the completion contract; the resume and boundary findings are diagnosed but not yet implemented.

**Trigger.** A WhatsApp task — *"develop an NVDA add-on for 2026.2 that speaks a given phrase on NVDA+alt+9, with a deployable package in `/Users/dheeraj/Documents/kuttaaddon/`"* — ran all morning and never produced the deliverable, while reporting success. This is the analysis of that run, of the 19 attempts around it, and of the 25 checkpoints on disk.

---

## 1. The finding in one line

**The pipeline reports success for work that does not exist, and the ledger that could have corrected it is written but never read.** Neither is a model problem: `chat` succeeded 27 of 27 while the multi-agent `orchestrator` succeeded **1 of 28**.

---

## 2. Evidence

### 2.1 Success by path (60 stored traces)

| Source | Success | Failure |
|---|---:|---:|
| `orchestrator` (multi-agent pipeline) | **1** | **27** |
| `chat` | 27 | 0 |
| `loop` | 5 | 0 (hollow — see §2.3) |

**31 of 31 failed steps returned an empty response** (0 characters). One failure signature, not thirty-one bugs — which locates the problem in the pipeline's plumbing rather than in any individual step. Untraced stalls of 296s, 300s, 353s and **934s** accompany them: work was happening that the trace does not account for.

### 2.2 The reference trace — `trace-1790322554669-uie5d2`

Reported `success: True` after 982s. What that claim rested on:

| Signal | Reality |
|---|---|
| Steps 4 and 5: `success: False`, **0 characters** | Two writer calls returned nothing. Steps 3 and 5 are the *same* task, run twice. |
| Step 3's "response" | Not an edit — `{"tool": "list_files", …}` |
| Plan's own `expectedFiles` | `manifest.ini`, `globalPlugins/kutta_plugin.py`, `installTasks.py` — **none exists** |
| 13:19:27 → 13:35:01 | a **934-second gap** with no recorded step |
| Declared deliverable | `kuttaaddon.nvda-addon` — **22 bytes, zero entries** |

### 2.3 The checkpoint is the smoking gun

```json
cp-ced1d0668c68  goal: "Can you develop an NVDA add on…"
  taskPlan    5 tasks — ALL "completed", including step-04-package-addon
  runResult   { success: TRUE, command: "zip -r kuttaaddon.nvda-addon manifest.ini installTasks.py globalPlugins/" }
  runOutput   "zip warning: name not matched: manifest.ini
               zip warning: name not matched: installTasks.p…"
  deliverableAuthored: FALSE
  fileChanges 1 file → .../kuttaaddon/installTasks.py  (empty, and NOT on disk)
  workingDirectory: /Users/dheeraj      ← not the folder the goal named
```

`deliverableAuthored: false` and the `zip warning` lines sit in the **same object** as `5/5 completed`. The truth was computed, stored, and ignored.

A re-run reproduced it independently (`trace-1790332934683-mfngg5`): `success: True`, 6 steps, 5 of them 0 characters, the last being only the sentence *"Write manifest.ini and global plugin script."*

### 2.4 How systemic (25 checkpoints, Aug 12 – Sep 25)

- **9 of 25** plans are marked fully complete. Almost all are toys: `python3 hello.py` → `"hello"`, `ls -R .`, `nuvira gateway status`. The one substantive completion (09-23, `deliverableAuthored: true`, 4 file changes) is the exception.
- The NVDA goal has recurred **since Aug 12** across four separate checkpoints, never converging.
- 09-21 holds **four checkpoints for one goal in one hour** (15:29:24, 15:29:53, 15:31:38, 16:28:20), each starting from 0/7.
- The system reliably completes what one command can prove, and cannot complete a multi-file deliverable — precisely the case where the artifact must be *checked* rather than *assumed*.

---

## 3. The chain, end to end

1. **`write_file` was refused.** `gatePath()` (`src/tools/coding-tools.ts:73`) denies absolute paths outside `root || process.cwd()`. `/Users/dheeraj/Documents/kuttaaddon/` is outside the repo, so the three planned files were never created.
2. **The agent's only escape was `run_terminal`**, which is *not* gated by that check. It created paths by shell in whatever shape each turn happened to use — which is why the target folder holds a root-level `globalPlugins/` **and** a separate `YesYes/addon/` with no manifest beside the first: two attempts, neither complete. A user-named path was refused, and nobody was told.
3. **The packaging step then ran against files that did not exist.** `zip -r … manifest.ini installTasks.py globalPlugins/` printed `zip warning: name not matched` for every input and **still exited 0**, emitting a valid 22-byte empty archive — into `/Users/dheeraj/Documents/` rather than the requested folder.
4. **Completion was derived from that exit code.** `runner.ts` built `runResult.success = exitCode === 0`; the step counted as done; every task flipped to `completed` (5/5); the trace said success; WhatsApp said so too.
5. **The one guard that could have caught it waived it.** The `expectedFiles` check accepted `fileChanges` — the agent's own report — as proof the file existed, and only ran for `writer` steps. `step-04-package-addon` is a **runner**, so the one step whose entire job was to produce the deliverable was structurally exempt, and `step-03` passed on a claim about a file that does not exist.

**Why it could not close in ~20 steps.** The work is about four steps (write three files, package them). It spent roughly 5 steps × 16 runs ≈ **80 steps** re-deriving the same five, ending in exactly the state it began. Step 1 was *structurally impossible* under the workspace guard, and because the failure was reported as success the loop received **no error signal to adapt to**. A system that believes it succeeded has no reason to change approach, escalate, or ask for a wider scope. That is why it repeats instead of recovering.

---

## 4. The failover mechanism — what works, what is missing

The design intent is sound and **half of it is implemented**. Provider-level failover works — observed live:

```
🤖 Auto routing: execute → openrouter/gpt-oss:120b-cloud
⚠ openrouter failed — trying the next loop candidate...
⚠ gemini failed — trying the next loop candidate...
```

and per-step across the traces (`gemini` → `local/gpt-oss:120b-cloud`).

What does not exist is the other half: **a failed step leaves no durable, verified partial state for its successor to continue from.** The unit of retry is the whole step, and the plan is regenerated from the raw goal on every attempt. So *"another model takes over"* degrades into *"another model starts over."* Failover saves the **call**, not the **work**.

---

## 5. Why the next cycle never leverages prior work

The tracking exists. It is simply never consulted.

| Mechanism | State |
|---|---|
| Checkpoint (taskPlan + statuses + fileChanges), `checkpoint-store.ts` | **Written** — one file per goal, saved once at the *end* of a run |
| Load path (`orchestrator.ts:726`) | **Only on explicit resume** — `resumeWanted = resumeRequested \|\| resumeCheckpointId` |
| Otherwise | `new ContextVault(goal, process.cwd())` — a blank vault; the plan is regenerated from the prompt |
| Overwrite | One id per goal ⇒ **each attempt erases the record of the previous one** |
| Keying | `cp-<sha1(workingDirectory + goal)>` ⇒ the Aug 12 attempts ("Build NVDA compatible .nvda-addon package") live under a different key forever orphaned. The code comments that *"a reworded goal silently misses the auto id."* |
| Message dedup (`inbox.json`) | Dedupes **messages**, never **work**: 19 identical NVDA dispatches went in as fresh pipeline work; only 3 were caught as duplicates |

The "never silently resume a stale checkpoint" rule is **correct on its own terms** — re-entering a *completed* plan would skip real work. It is defeated only because the completion it refuses to re-enter is **false**. Load-or-not is the wrong axis; the axis is whether the recorded status survives contact with the filesystem.

---

## 6. The invariant that was missing

Stated as a rule, across both symptoms and both code paths:

> **The artifact is the source of truth. The plan, the exit code and the agent's own report are proposals. A step is done when its declared artifact exists and is not empty — and a resumed run must reconcile every recorded status against the filesystem before trusting it.**

How an interrupted session *should* resume (and how a session held this way does): re-read the world — files on disk, VCS status, the live endpoint — and re-derive only the delta. Never redo what can be *verified* already true, and never trust a claim about what was done. During this very investigation the check that mattered was comparing deployed bytes against the local file rather than believing a deploy's exit code — the check that was skipped here.

The three broken derivations:

1. **Success from process signal, not effect.** `exit code 0` ⇒ step done.
2. **Completion from self-report, not artifact.** `fileChanges` ⇒ file exists.
3. **Continuity from a claim, not a reconciliation.** Checkpoint statuses were trusted or ignored, never verified.

---

## 7. What was changed

### 7.1 New: `src/agents/artifact-verification.ts`

Deterministic, LLM-free. `verifyArtifacts(declared, root)` separates **missing** from **empty** (different bugs, different repairs) and detects the subtle case: a file that exists, is non-zero, and is a container holding **nothing**. `isEmptyArchive()` reads the zip End-Of-Central-Directory entry count (`PK\x05\x06`, uint16 at offset 10, searched from the tail to tolerate comments) — which is what distinguishes a real package from the 22-byte one that was reported as finished. `allowEmpty` exists because the same plan legitimately asked for *"an empty `installTasks.py`."*

`detectNoOpCommand(command, stdout, stderr)` catches a command that exited 0 while provably doing nothing. Deliberately narrow: only producer tools (`zip`, `7z`, `tar`, `git`), and only unambiguous signatures (`zip warning: name not matched`, `zip error: nothing to do`, `nothing to commit`, `0 files added`). A broad pattern like `/no such file/` would fail legitimate commands — a `grep` that finds nothing is not a broken build.

### 7.2 `src/agents/agents/runner.ts` — exit code is not an effect

`RunResult` gains `producedNothing` / `noOpReason`; both construction sites (host and Docker sandbox) ask the **output** as well as the status. Both agent-result returns now use `success: exitCode === 0 && noOpReason === null`, with a summary that names the no-op instead of claiming success.

### 7.3 `src/agents/orchestrator.ts` — completion derives from disk

The `expectedFiles` guard is rewritten to close the three holes:

- **Claims no longer satisfy it.** Only the filesystem counts; a path *reported as written but absent* is named explicitly, because that discrepancy is itself the bug.
- **Any step is verified**, not just `writer` — a runner that declares its archive is checked like any other.
- **Existence is not enough** — empty files and zero-entry archives fail, via `verifyArtifacts`. Resolution is against `workingDirectory` (the root the plan was built against) rather than `process.cwd()`.

A failing check sets `success: false` **before** the status is recorded, so agentResults, the task status, the checkpoint's `tasksCompleted` and the run's `success: !hasFailedTasks` all inherit the corrected outcome instead of the lie.

### 7.4 Tests

`tests/agents/artifact-verification.test.ts` — 19 cases, each drawn from the live failure: the empty archive, the identifier of an archive with entries, a zip with a trailing comment, the zero-byte file, the intentionally-empty file, the claim-that-is-absent, and `detectNoOpCommand` against the exact `zip warning` line the live run produced — plus its negatives (a `grep` that finds nothing, ordinary output containing "nothing to do").

**Verified:** `tsc --noEmit` clean. 19/19 new tests pass. `tests/agents/checkpoint-store.test.ts` + `tests/agents/orchestrator.test.ts` → **101/101 pass**, no regressions in the escalation/repair paths.

---

## 8. What is NOT fixed (honest scope)

1. **The boundary refusal (the direct cause).** A path the *user themselves named* is still denied to `write_file` with no way to grant it, and the agent still silently retargets into the workspace instead of saying so. Changing a write sandbox is a policy decision and has not been made.
2. **The ledger is still written, not read.** Reconciled-on-load resume is designed but not implemented; nothing yet re-opens a step marked complete whose artifact is missing.
3. **The ledger is still keyed on the literal goal string** and still overwritten per attempt — so a reworded task still cannot find its own history.
4. **Message dedup does not cover work.** 19 identical dispatches remain 19 fresh pipelines.
5. **The 31 empty model responses are untouched.** They are a provider-health symptom, and they are what made 27 runs fail *loudly* while the one with a plausible-looking command failed *silently* — the more dangerous failure is the one this change addresses.
6. **`execute` and the WhatsApp bridge do not take the same engine** (this investigation's reproduction landed on `loop`, the morning's runs on `orchestrator`). Any fix must be re-verified through the WhatsApp path specifically.

---

## 9. Recommended next invariants

In dependency order:

1. **Reconcile on load, always.** Read the most recent ledger for the *work* before planning; re-open any step marked complete whose artifact fails `verifyArtifacts`. This makes silent resume *safe* and turns the existing comment from an obstacle into a rule. Match reworded goals by a normalised goal fingerprint, not a literal hash.
2. **Step-level hand-off.** Persist per-step attempt state (provider, model, error, artifacts produced) so a failover step *continues* rather than restarts — the missing half of the existing design.
3. **Grant user-named paths, explicitly.** When the user names a path in their own message, treat it as a granted writable root for the turn, visibly. Never retarget silently.
4. **Key the ledger on the deliverable, not the sentence.** The work is identified by what it produces.
5. **Never let a checkpoint record a completion the filesystem contradicts** — the reconciliation in (1) makes this checkable, and §2.3 shows what it costs when it does not happen.
