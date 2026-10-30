# Head-to-head, 2026-10-27 — patched nuvira vs Cline, re-run

**Task:** the same Ultimate Agent Benchmark prompt as the two earlier rounds
(`/tmp/final_bench_2026-10-26/TASK.md`) — a production-ready SaaS Operations Platform built
from an empty folder: Next.js, a Node API, PostgreSQL, JWT + RBAC, projects / tasks /
documents / AI assistant / notifications / admin, unit + integration + e2e tests, docs,
security, performance, and `todo.md` / `progress.md` / `issues.md` / `changelog.md` kept live.

**Model:** `deepseek` / `deepseek-flash` (thinking) for both arms. **Machine:** macOS, one
empty folder per arm, 60-minute cap, the same four change events injected at 10 / 20 / 30 / 40
minutes.

**What is new in our arm this round** — the three mechanisms the last report asked for, plus
the one this round's ask added:

1. **Plan depth recurs at phase boundaries** (`learning/plan-depth.ts`): a coarse plan is
   re-asked when the plan *changes*, not only when it is created.
2. **Wall clock** — a closing window is announced while there is still time to finish.
3. **Contract verification at delivery** (`learning/api-contract.ts`): a spec that disagrees
   with the routes is a named problem, not a silent one.
4. **The contract is generated from the route table** (`learning/api-spec.ts`, tool
   `api_spec`): the document is derived from the routes the code registers, so it cannot
   disagree with them by construction.

Cline's arm is its **2026-10-26** tree — same task, same model, same protocol — because this
round re-ran only ours.

## Time

| Arm | Wall clock | How it ended | Exit |
|---|---:|---|---:|
| **agent-nuvira (patched, this session)** | **48 min 33 s** | its own 634-step ceiling, 63 requirements still open | 0 |
| Cline 3.0.73 | 48 min 50 s | stopped on its own, then the provider reset the socket | 1 |

The 60-minute cap was **not** the binder this round: the turn stopped 11½ minutes before it,
on a step count. That is the successor of the cap problem, and it is visible in the log —
`Tool loop reached its 634-step budget` — not hidden.

## Scoreboard

| Aspect | Weight | **nuvira (patched)** | Cline |
|---|---:|---:|---:|
| Planning | 15 % | 100 | 100 |
| Tool usage | 20 % | **100** (679 calls, 9 tools, 138 shell) | 70 (692 calls, **3 tools**) |
| Task management | 10 % | 60 (`progress.md`, `issues.md`; **no `todo.md`, no `changelog.md`**) | **100** |
| Development | 20 % | 90 | 90 |
| Problem solving | 10 % | 100 (52 `try`, error middleware, recovery in log) | 100 (59 `try`) |
| Testing | 10 % | **100** (18 files, **477 assertions**, unit+integration+e2e) | **100** (22 files, 345 assertions) |
| Documentation | 5 % | 75 (README 4.4 KB + `docs/API.md`, no deployment story) | **100** (README 10.3 KB, deployment doc) |
| Adaptability | 10 % | 100 (4 / 4 events in code) | 100 (4 / 4) |
| **Weighted overall** | | **93** | **92** |
| Security (reported) | — | 100 | 100 |
| Performance (reported) | — | 85 | 85 |

Both arms were scored with the same script and the same weights:
`node scripts/bench/platform/score-platform.mjs --dir <arm> --log <arm>.console.log`.

## The endpoint delta — the number this round was for

| | Cline | nuvira |
|---|---:|---:|
| Routes the tree registers (scanner) | **60** | **55** |
| Operations in a machine-readable contract | **59** | **0** |
| Contract document | `docs/openapi.yaml`, **48.2 KB** | none — `docs/API.md`, 9.5 KB of prose |
| Contract problems (verified against routes) | 1 (one route undocumented) | n/a — nothing to verify |
| Method mix | GET 28, POST 17, PATCH 9, DELETE 6 | GET 23, POST 22, PATCH 5, DELETE 4, PUT 1 |

**The gap is not the count of endpoints — it is that ours are not machine-readable.** 55
routes are served; both trees document their routes in *something*; only one of those
somethings can be consumed by a client generator, an SDK, or a contract test. Cline's spec
omits exactly one of its 60 routes (a real drift finding, small and reported). Ours has no
spec at all, so there is nothing to drift *from* and nothing to check.

That is the failure mode the ask named: **a hand-written reference to 55 routes is a document
that has already begun to drift** — every route added after it was typed is missing from it,
silently, and prose that was correct on the day it was written looks exactly like prose that
is correct now. Our arm wrote 63 route rows by hand at the very end of the turn, which is the
best case for prose and still not a contract.

## The documentation delta

| | Cline | nuvira |
|---|---:|---:|
| Markdown documents / kilobytes | **21 / 96** | 12 / 61 |
| `README.md` | **10.3 KB** | 4.4 KB |
| PRD / architecture / roadmap / risk register | 4 / 4 | 4 / 4 |
| Architecture decision records | **7** | 0 |
| `docs/OPERATIONS.md` (deployment story) | **present** | **missing** |
| `docs/SECURITY.md` | present | present |
| `docs/API.md` | — | present (9.5 KB, 63 route rows) |
| Machine-readable API contract | **48.2 KB spec** | **none** |
| `todo.md` | **present** | **missing** |
| `changelog.md` | **present** | **missing** |
| `progress.md` / `issues.md` | present | present |
| Testing document | missing | missing |

Two rows are worth naming: **the deployment story** (the 25 documentation points this project
has now lost in two consecutive rounds) and **the two tracking files it dropped** — the plan
existed in the loop's own board (`5/20 done`) but never reached `todo.md`, and a changelog was
never written. Cline's tree answers for all four tracking files.

## What the new gates actually did in this run

- **Plan depth fired before any code was written.** The first plan put six named requirements
  into one step; the gate asked once and the model re-planned from **7 steps to 20**, each
  naming one deliverable (`Scaffold monorepo…`, `PostgreSQL schema + migration runner…`,
  `RBAC: role/permission model…`).
- **All four change events were delivered mid-turn** (teams, SQLite, audit log, httpOnly
  cookies) and all four are in the tree — `teams`, `sqlite`, `audit`, `httpOnly` all present.
- **The closing window spoke once**: `⏳ Closing window — about 12 min left`.
- **Contract verification had nothing to verify**, because no spec was written. It is
  implemented and pinned (generate → verify → zero problems), and it is silent on a tree that
  has no contract — which is honest, but it is also why the missing contract was never raised.

## The fix this measurement produced

The generator existed and the agent did not use it — the tool was available from step one and
the model never called it. That is a gate problem, not a tool problem:

- **Hand-written prose no longer settles the API-contract item** (`learning/adoption-kit.ts`).
  The reference is still read and cited (it is evidence the routes exist), but the ask becomes
  *"derive the document"*, naming `api_spec`.
- **A false negative that was hiding the best reference is fixed.** Route tables
  (`| GET | /api/tasks | … |`) were invisible to the endpoint check, so a complete reference
  read as "nothing documented" — the one mistake that teaches a model the ask is noise.

Verified on the delivered tree, not just in unit tests:

```
gap before : API contract — no OpenAPI/Swagger document with `paths` — the only reference is
             `docs/API.md`, written by hand, which stops matching the routes the next time one is added
             — evidence: 40 route registration(s) found in the files read, and `docs/API.md` lists some of them
api_spec   : ✅ Wrote `docs/openapi.yaml` — 55 operation(s) across 44 path(s), derived from the
             registered routes
verify     : documented 55, registered 55, problems 0
gap after  : cleared
```

## Limits — read before quoting a number

- **One sample per arm**, and Cline's sample is from 2026-10-26 (same prompt, model and
  protocol; different day). Movements worth acting on are the ones with a mechanism behind
  them — the plan going 7 → 20 steps, all four change events in code, 477 assertions — not
  the single point of overall score.
- **The route count is a floor, not a census.** The scanner reads a bounded set of files
  (server-named first) and collapses mounted prefixes where it can resolve them; a route
  registered behind a dynamically-computed path may be missed by both arms equally.
- **The documentation row is a path scan.** 75 means "README + API prose + architecture, no
  deployment artefact", not "the docs are good".
- **Our arm ran out of steps, not of ideas**: 63 requirement rows and 15 plan steps were still
  open when the 634-step ceiling hit, and it says so in its own final message instead of
  claiming completion. The tree is what it is; the honest ending is worth separating from the
  delivered surface.
- Cline exited 1 on a provider `ECONNRESET` **after** it had stopped working; its tree and
  every number above come from what it wrote.

## Reproduce

```bash
B=/tmp/bench_nuvira_rerun_2026-10-27
C=/tmp/final_bench_2026-10-26

node scripts/bench/platform/score-platform.mjs    --dir "$B/nuvira" --log "$B/logs/nuvira.console.log"
node scripts/bench/platform/score-platform.mjs    --dir "$C/cline"  --log "$C/logs/cline.console.log"
node scripts/bench/platform/compare-delivery.mjs  cline="$C/cline" ours="$B/nuvira"
```

`compare-delivery.mjs` is new in this round: it reports the endpoint and documentation deltas
above from the trees themselves, using the SAME route scanner and spec reader the in-loop gate
uses (`dist/learning/api-contract.js`), so a number here is the number the model was shown.
Run `npm run build` first — it imports the built module.
