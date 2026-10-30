# Enterprise migration benchmark, 2026-10-27 — Agent-Nuvira vs Freebuff (me)

**The task:** `scripts/bench/enterprise/TASK.md` — eight phases on a real legacy production
codebase: reverse-engineer the architecture, modernise, add an AI feature, migrate the database,
audit security, build CI/CD, hit performance KPIs, survive injected incidents.

**The repository:** `openedx/edx-platform` @ `03698e2` (shallow clone, 9 284 tracked files,
4 460 Python files, 755 359 lines, 168 installed apps, 266 models, 1 431 migrations).

**Two corrections to the brief, stated up front.** The pasted benchmark describes
React 16 + Redux / **Node 14 + Express** / **Postgres**. This repository is React 16 / **Django
5.2** / **MySQL 8**. The task maps the phases onto the real stack (Node 14 → 22 becomes the JS
toolchain; Postgres → Oracle becomes **MySQL → Oracle**, which is the harder migration). The
stack in the brief does not exist in this repo and pretending otherwise would have made every
later phase meaningless.

**The competitors.** Agent-Nuvira, pinned to the patched working-tree build
(`dist/index.js`, provenance and hashes in `/tmp/edx/arms/nuvira/PROVENANCE.md`), and Freebuff —
me — working the same task in `/tmp/edx/arms/freebuff` with the same tools, the same environment
and the same task file.

**No time limit** on either arm. Nuvira ended on its own at **23 min 21 s**; my arm ran
**~55 minutes** of wall clock, interleaved with building the harness.

**Environment (identical):** MySQL 8.4 (`:3307`), **Oracle 23ai Free** (`:1521`, real instance),
Redis, MongoDB, a **real kind cluster** (v1.34.0), Ollama. Python 3.12 + MySQL client headers
installed so the repository is installable at all.

## Scoreboard

100 points, weights published by the benchmark. Same scorer, same pristine base for the diff:
`node scripts/bench/enterprise/score-enterprise.mjs --dir <arm> --base /tmp/edx/edx-platform`

| Phase | Weight | **Agent-Nuvira** | **Freebuff (me)** |
|---|---:|---:|---:|
| Architecture (reverse-engineered) | 20 | 5 | **18** |
| Refactoring (React 19 / Zustand / toolchain) | 20 | 0 | 0 |
| AI feature (NL→SQL on local LLM) | 15 | 0 | 0 |
| Database migration (MySQL → Oracle) | 15 | 0 | **15** |
| Security audit + fixes | 10 | 2 | **6** |
| DevOps (CI/CD on the real cluster) | 10 | 0 | **8** |
| Debugging (incidents) | 5 | 0 | 0 |
| Documentation | 5 | 2 | **4** |
| **Overall** | **100** | **9** | **50.7** |
| Files changed vs pristine | — | 34 (all added) | 41 (39 added, 2 modified) |
| Tool calls | — | 141 | not instrumented (I was the harness, not a logged process) |

**Neither arm finished the task.** Phase 2 (React 19 + Zustand) and Phase 3 (AI assistant) are
untouched by both; no incidents were injected during either run, so Phase 8 is unexercised for
both and separates nothing. The gap is entirely in Phases 1, 4, 5 and 6.

## What Agent-Nuvira did

It went straight at Phase 0 and did real work there:

- Created `cms/envs/benchmark.py` and `lms/envs/benchmark.py` — its own settings modules rather
  than editing the platform's.
- Wrote a test for them and reports **7/7 passing**.
- Produced `docs/enterprise/architecture.md`, `BOOTSTRAP.md`, `threat-model.md`, `todo.md`, and
  the three tracking files (`PROGRESS.md`, `ISSUES.md`, `CHANGELOG.md`).

Then it stopped, and its own log says why:

> **Why the gate refused**: its remaining complaints are the same file twice under a path I moved
> (`common/test/test_benchmark_env.py`) plus "no unit test file exists" and "no test imports
> `lms/envs/benchmark.py`" — asserted while the test that imports both modules exists and just
> passed 7/7. I stopped rather than rename files back and forth indefinitely.

Two distinct failures, both worth fixing in the product:

1. **The completion gate produced a false positive.** It tracked the test file at its old path and
   kept asserting "no unit test exists" after the file moved and passed. The agent's correct
   response — "I am not going to shuffle files to satisfy a stale path" — is exactly what a
   user does not want an agent to have to reason about.
2. **It asked for permission in an autonomous run.** From its transcript: *"I need your OK to
   execute pytest… Run it?"* The task says work autonomously; nobody was there to answer.

## What I did (Freebuff arm)

| Phase | Delivered, with evidence |
|---|---|
| 0 | `lms/envs/enterprise.py`: registered **16 model-bearing apps** missing from `INSTALLED_APPS` (bookmarks, discussions, grades, program_enrollments, push_notifications, …). `manage.py lms check` clean, **622 tables migrated** into MySQL, 10 tests pass. |
| 1 | `scripts/enterprise/analyze_arch.py` derives the four documents from the tree (AST import graph, 296 package edges; 168 apps; 266 models; 1 431 migrations; service wiring read from the settings that configure each service). |
| 4 | `scripts/enterprise/gen_oracle.py` → **611 tables, 560 sequences, 560 triggers, 761 FKs, 1 375 indexes**, plus views, PL/SQL, integrity suite, rollback. **Executed on real Oracle 23ai: 605 tables, 2 202 indexes, 716 FKs, 560 sequences, 559 triggers, 3 views, 3 procedures VALID.** |
| 5 | SSRF in the RSS proxy fixed (`url_safety.py`: scheme + public-address checks, timeout, no redirects, body cap) with **10 tests**; `os.system` command injection in `clean_xml` fixed; `pip-audit` reports **59 advisories**, tabulated. |
| 6 | `enterprise-ci.yml` (build → lint → unit → integration → security → container → deploy → rollback), `deploy/Dockerfile`, `deploy/k8s/*` applied to the **live kind cluster**; deploy → readiness → smoke → `rollout undo` → re-verified with a canary. |
| 7 | One KPI measured (39.25 s warm install) and the CI cache mechanism implemented; the other two **reported as unmet, not estimated**. |
| 2, 3, 8 | **Not done.** Said so in `PROGRESS.md` rather than padded. |

## Where each one is actually stronger

- **Nuvira is better at not touching the platform.** Its instinct was a separate settings module
  (`lms/envs/benchmark.py`, `cms/envs/benchmark.py`) with a test; mine was to modify the LMS
  settings module directly, which is a wider blast radius on a real platform.
- **It also told the truth about being blocked**, and did not claim completion to get past the
  gate. That is the behaviour the finish contract exists to reward: `verified:false` with a
  reason is a legal ending.
- **I went wider, not deeper.** Four phases with executed artefacts and a live cluster, none of
  them finished end-to-end: the Oracle schema has no data in it, the LMS pods never started, and
  the two hardest phases were not attempted at all.
- **On the one phase both touched — Phase 0 — nuvira's diagnosis was sharper per minute.** It
  found the settings-module trap and wrote a test in 23 minutes; I found five more defects, but
  with an hour and with the advantage of knowing the environment I built.

## Use of the environment (the benchmark's own test)

| Given | Nuvira | Me |
|---|---|---|
| MySQL / Oracle | MySQL: not migrated | MySQL migrated (622 tables); Oracle loaded (605 tables, 716 FKs) |
| Kubernetes | untouched | manifests applied, canary deployed, smoke passed, rollback rehearsed |
| Ollama (local LLM) | untouched | untouched |
| Git / package manager | used for reads | used for reads; venv built twice (mine and the probe) |

## Limits — read before quoting this

- **I was both competitor and harness author.** The scorer, the task and the environment are
  mine. I did not tune the scorer for my arm (the SSH/SSRF and Oracle checks are path-based and
  the pristine repository scores 0), but this is not a neutral referee, and a second run scored by
  someone else is the only way to settle it.
- **One sample each**, different durations (23 min vs 55 min). Per-minute rates would flatter
  nuvira; totals flatter me. Neither is a controlled experiment.
- **The scorer is a floor.** It reads paths and content patterns; it cannot tell a good
  architecture document from a padded one, and it credits the Oracle phase for DDL that executed
  even though no data was migrated.
- **The nuvira arm's own gate ended its run.** Its 9 is the score of a run that was cut short by
  a bug on our side, not a measure of what that build can do. That bug is the real finding here.
- **Neither arm exercised Phases 2, 3 or 8**, which is 40 of the 100 points.

## Reproduce

```bash
B=/tmp/edx/arms
node scripts/bench/enterprise/score-enterprise.mjs --dir "$B/nuvira/repo"   --base /tmp/edx/edx-platform
node scripts/bench/enterprise/score-enterprise.mjs --dir "$B/freebuff/repo" --base /tmp/edx/edx-platform
```

Harness in the same folder: `TASK.md` (identical for both), `run-arm.sh` (fresh copy, mirrored
transcripts, incident schedule), `inject-incident.mjs` (six real failures, `--restore` to undo),
`score-enterprise.mjs` (the 100 points above).
