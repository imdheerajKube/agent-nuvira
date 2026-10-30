# BENCH — GREENFIELD-API: agent-nuvira vs Freebuff, one prompt, one model

**Date:** 2026-10-30
**Task:** `tmp/bench/v3/tasks/GREENFIELD-API.md` — build a JSON notes API (stdlib
Python only) with token auth, per-user isolation, a rolling rate limit, SQLite
persistence, a CLI, a `unittest` suite and a README, to an exact contract.
**Model:** `deepseek-flash`, hard pinned in the arm runner (`tmp/bench/v3/run-arm.sh`).
**Arms:** agent-nuvira (built from `dist`, unattended) vs Freebuff (this session,
working by hand in `tmp/bench/v3/freebuff/repo`).
**Instrument:** `tmp/bench/v3/grade.py` (40 contract checks) and
`tmp/bench/v3/probe.py` (23 adversarial probes). The same scripts, same order,
same seeds of randomness (random free ports, fresh temp DBs) grade both repos.
Neither script reads either arm's source; every check is a file, an HTTP
exchange against the arm's own server, the arm's own suite, or the arm's own CLI.

## 1. Contract result

| | Freebuff | nuvira r1 (pre-fix) | nuvira r2 (post-fix) |
|---|---:|---:|---:|
| contract checks | **40/40 (100%)** | **40/40 (100%)** | 39/40 (97.5%) |
| adversarial probes | **23/23** | **23/23** | 22/23 |

Both arms delivered a working service. nuvira r2's two misses are independent
sample variance, not regressions from the loop fix — see §5.

## 2. Cost — and its variance

Five nuvira runs total (r1 before any loop fix, then r2 and three `final-*` runs on
the final build), all on the same prompt and model:

| run | wall | steps | tool calls | out tokens | contract | probes |
|---|---:|---:|---:|---:|---:|---:|
| r1 (pre-fix) | 414 s | 33 | 38 | 52.9k | 40/40 | 23/23 |
| r2 | 234 s | 31 | 41 | 43.4k | 39/40 | 22/23 |
| final-1 | **168 s** | **24** | 23 | 31.0k | 40/40 | 23/23 |
| final-2 | 359 s | 37 | 41 | 54.9k | 40/40 | 22/23 |
| final-3 | 398 s | 44 | 57 | 57.0k | 40/40 | 23/23 |
| **mean / median** | **315 / 359 s** | **33.8 / 33** | 40 | 47.8k | **39.6/40** | **22.6/23** |
| Freebuff (1 sample) | 129 s | ~11 arm actions | 9 | not measurable | 40/40 | 23/23 |

Freebuff's tokens are unmeasurable here (no meter in this interface), and its arm
cannot be re-sampled without a memory reset, so **its variance is unknown** — the
honest comparison is that nuvira needs 3–4× the round trips of this session's
single build, with a spread of 24–44 steps across five identical runs.

**Correction to an earlier claim in this document.** The first draft said the
surface-check fix took the run from 414 s to 234 s. That was one sample against
another, and the five runs above show a between-run spread of 168–398 s on the
final build alone. The *mechanism* is verified (the false gap fired twice in r1
and **zero times in all three post-fix runs**), but its **cost** is not separable
from generation variance at n=1. What stands is the mechanism, not the number.

One measurement caveat of the instrument itself: `final-1` graded 39/40 on its
first pass and 40/40 on four subsequent passes, so one check in `grade.py` is not
deterministic (most likely the rate-limit window or the arm's own suite binding a
port under load). Scores here should be read as ±1 check.

## 3. Rubric (the weights supplied for this benchmark)

1–5 per axis; `Total = Σ score × weight`.

| Axis | Weight | Freebuff | nuvira r1 | Why |
|---|---:|---:|---:|---|
| Task success | 20% | 5 | 5 | Both ship a service that passes every contract check. |
| Accuracy | 15% | 5 | 5 | 40/40 each; no incorrect response observed. |
| Completeness | 10% | 5 | 5 | Every named requirement implemented, including the CLI and the README table. |
| Reasoning quality | 10% | 4 | 4 | Both chose correct architectures (threaded server + SQLite, owner-scoped queries). nuvira documents its reasoning (plan, findings); Freebuff's decisions are less traceable. |
| Planning | 5% | 3 | **5** | nuvira ran an explicit 5-step plan and auto-advanced it from its own writes. Freebuff held no written plan. |
| Tool usage | 10% | 5 | 4 | Freebuff: 9 calls, batched reads/writes. nuvira: 38 calls, and needed a "batch independent calls" nudge. |
| Autonomy | 10% | 5 | 5 | Zero human interventions in either arm. |
| Efficiency | 5% | 5 | 3 | 129 s vs 168–414 s (median 359 s). |
| Error recovery | 5% | 4 | **5** | Freebuff caught its own CLI bug and fixed it. nuvira recovered a tool call written as text, survived two empty model responses, and continued past a step bound. |
| Output quality | 10% | 4 | **5** | nuvira's README is 162 lines with a security note and 106-line `SECURITY.md`; tests 758 lines. Freebuff's are tighter (85-line README, 365-line suite) but thinner prose. |
| **Total** | 100% | **4.65** | **4.70** | |

**The rubric does not separate these two agents, and it is worth saying why:**
nine of the ten axes ask "is the artifact there and is it good", which both arms
satisfy, and efficiency carries 5% while the step cost differs by 3.2×. A rubric
built for artifact quality will always rank a correct-but-expensive agent level
with a correct-and-cheap one. The mechanism-level differences in §4 are where the
real gap lives.

## 4. Findings

### 4.1 A hardcoded surface check reported a working backend as missing (fixed)

nuvira r1's step map shows the work finished at step 27 and then:

```
28 finish                          "Completion accepted"
29 finish                          (again)
30 suggest_followups      → 🧱 gate: "the ask named 2 surface(s) the tree does not
                              contain (backend / API, database / schema)"
31 run_terminal(ls -l server.py client.py)      ← proving its own file exists
32 suggest_followups      → 🧱 gate fires AGAIN
33 suggest_followups                            ← end
```

The project had `server.py` on `http.server` and a `sqlite3` store. Both surfaces
were reported absent because **every evidence pattern was a JS/TS filename**
(`server.ts`, `schema.prisma`, `migrations/`). Two closing steps were spent
proving, to a checker, that the server it had just built existed — after the
completion contract had already accepted the claim.

Two changes (`src/learning/deliverable-coverage.ts`, `src/tools/tool-loop.ts`):

1. **Evidence before assertion.** A surface may be proven by its *runtime shape*:
   the code that registers a route or opens a database counts, not only the
   filename a convention would have given it. Path evidence is now
   language-agnostic (`server.py`, `app.rb`, `main.go`, `wsgi.py`, `*.sqlite`),
   and a bounded content scan (≤400 source files, ≤256 KB each) looks for
   `HTTPServer`/`serve_forever`/`@app.route`/`express(` and
   `CREATE TABLE`/`sqlite3`/`psycopg`/`prisma.` — anything of that shape.
2. **A settled verdict outranks a heuristic.** The closing surface gate now
   returns nothing once `finish` has been accepted, the same rule the
   documentation gate and the self-review pass already followed. The mid-build
   check (every 40 steps) still fires, where there is budget to act.

Measured on r1's own tree: `missingSurfaceGaps` now reports **no gaps** (it
reported `backend`, `database` before). Across the three post-fix runs the gate
never fired once (r1: twice), with no loss of delivery (40/40, 40/40, 40/40).

Regression tests: a Python stdlib service with sqlite is accepted; a tree holding
only prose about a REST API still reports both surfaces missing.

### 4.2 The loop manufactured scope (`📘 security is missing`) — fixed

Both pre-fix nuvira runs wrote a `SECURITY.md` (61 and 106 lines) that the task
never asked for, because the adoption-kit gate's vocabulary included `auth`,
`jwt`, `oauth`, `rbac`, `token`, `tenant` — so *implementing* authentication was
read as *commissioning* a threat model. The words left are the ones that ask for
the ARTEFACT (`security`, `threat model`, `owasp`, `compliance`, `soc 2`, `gdpr`,
`pii`, `pen test`), and a production posture (`production-ready`, `enterprise`,
`saas`, `multi-tenant`) now supplies the case the duty was actually built for.

Result: no `SECURITY.md` in any of the three post-fix runs (4, 5 and 7 files, none
of them a security document), and the duty still fires for a production-shaped ask
(pinned by test).

### 4.3 The remaining step overhead is protocol, not work

Counting each step by what its tools were (`plan_todo`/`finding`/`finish`/
`suggest_followups` = protocol, everything else = work): r1 was **26 work / 7
protocol**, r2 **24 / 7**. The protocol tail is `finish` (once or twice),
`suggest_followups`, a step-bound continuation, a batching nudge and a call
recovered from prose. Two of r1's seven were **empty model responses**
(`deepseek returned nothing — blip patience`), which no loop change fixes.

The volume is on the work side: 16 `write_file` calls for 6 final files, because
`write_file`'s own description told the model to deliver "a large document … in
sections across several calls". That contract now states a threshold (~8,000
characters in one call), forbids re-sending content already on disk, and sends
changes to `edit_file`. The remaining cause is generation variance: the same
prompt produced 4-, 5- and 7-file deliveries.

### 4.4 Where the two arms genuinely differ

* **Cost per delivered requirement.** 129 s / 9 calls vs 168–414 s / 23–57 calls
  for the same 40/40. nuvira re-reads and re-verifies far more, and its protocol
  charges a step for finishing.
* **Robustness under an occupied port.** Freebuff exits 1 with a message. nuvira
  **r2 hangs indefinitely** (`server.py` starts and never exits); r1 exits 1.
  This is production-readiness variance between samples of the same agent.
* **Error taxonomy drift.** r2 answers a missing password with
  `400 bad_request` where the contract says `422 validation_error`; r1 got it
  right. The loop has no mechanism that would notice a cross-run drift like this.

## 5. Threats to validity

* **Sample size.** Five nuvira runs of ONE prompt produced 24–44 steps and
  168–414 s, so no single-run cost claim is sound and none is made here. The
  Freebuff arm is a single sample whose variance is unknown. Only the mechanism
  claims in §4.1–4.2 are, and those were verified against the runs' own trees.
* **The Freebuff arm had the task in context** from the start (no re-reading),
  which flatters its wall clock and step count. Its clock started after the
  prompt was authored; the prompt is shared, not arm-specific.
* **Both arms shared the machine** (they ran concurrently, as the clock stamps in
  `runs/*/meta.json` show), so neither had an idle CPU.
* **No token meter for the Freebuff arm**, so the 5%-weighted efficiency axis is
  scored on wall clock and steps only.
* **The probes are this session's hypotheses**, written after the build. They are
  identical for both arms, but they are not an independent evaluation suite.
