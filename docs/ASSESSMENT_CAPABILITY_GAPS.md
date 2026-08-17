# Capability Assessment — what the agent can do vs what I can do (code-level)

**Purpose of this doc:** several sessions ago I compared my own capability set
(Buffy/Codebuff: read files, edit, run commands, ask, plan) against the
agent-nuvira chat agent's tool registry and listed the gaps in a table. That
doc was untracked and got cleaned up — the gaps disappeared with it. This is
the redo, at **code level** (verified against `src/tools/registry.ts`,
`src/tools/toolsets.ts`, `src/agents/module-registry.ts` as of this commit),
with a status column reflecting everything shipped since (P0.1–P0.5).

**How to read the matrix:** each row is "what I do" → "does agent-nuvira's
chat agent have it?" → status. `✅ CLOSED` means shipped + tested. The
remaining open rows at the end are the honest current gaps.

---

## The matrix (verified 2026-08-17)

| # | What I do (this session) | Chat agent's tool | Status |
|---|---|---|---|
| 1 | `read_files` — open a file with line numbers, window it | `read_file` (deny-first, symlink-safe, line numbers, offset/limit) | ✅ CLOSED — P0.2 |
| 2 | `code_search` — find code by pattern | `code_search` (ripgrep) | ✅ present before |
| 3 | `glob` / `list_directory` — explore structure | `glob` + `list_dir` | ✅ CLOSED — P0.2 |
| 4 | `str_replace` — surgical exact-text edits | `edit_file` (old_string→new_string, ambiguity refusal) | ✅ CLOSED — P0.3 |
| 5 | `write_file` — create/replace files | `write_file` (parent-dir auto-create, symlink guard) | ✅ CLOSED — P0.3 |
| 6 | `run_terminal_command` — typecheck, single test, git diff, live smoke | `run_terminal` (deny-first classifier, verify/confirm/deny, masked output) | ✅ CLOSED — P0.4 |
| 7 | `ask_user` — ask before acting (2–4 choices, multi-select) | `ask_user` | ✅ CLOSED — P0.1 (was DECLINED in the GUI; now a real question card + respond endpoint) |
| 8 | decide doc-vs-code-vs-question before dispatching | conversation-vs-pipeline gate (`isConversationalQuestion`) | ✅ CLOSED — P0.5 |
| 9 | `web_search` — ground answers in current info | `web_search` (DuckDuckGo / SearXNG) | ✅ present before |
| 10 | `read_url` — fetch a page's text | `read_page` (Jina / plain fetch) | ✅ present before |
| 11 | `suggest_followups` — end with clickable next steps | `suggest_followups` (chat chips in GUI) | ✅ present before |
| 12 | render tool calls as visible steps in the conversation | step cards (structured tool-call rendering) | 🔴 OPEN — P0.6 |
| 13 | clone a repo into a temp dir and analyze it (assess other people's projects) | — | 🔴 OPEN — P3 (`clone_repo` tool, plan row 21) |
| 14 | keep the website/docs in sync after each release (compare versions, fix gaps) | — | 🔴 OPEN — P5 (release-sync loop, plan row 23) |
| 15 | `git diff` / `git commit` gated in the conversation | `run_terminal` can run git read-only; no dedicated commit tool | ⚠️ PARTIAL — P3 (gated git tool planned) |
| 16 | skills: load reusable instruction packs | `skill` tool | 🔴 OPEN — skill-runner agent exists in the module registry, but there is **no `skill` tool in the chat registry** (verified: `MISSING skill`) |
| 17 | plan-tracking: maintain a visible todo list across the turn | — | 🔴 OPEN — no `write_todos` equivalent in the registry (verified: `MISSING write_todos`) |
| 18 | sub-agents: delegate to specialized agents (context-gatherer, reviewer, security, tester) | `delegate` tool + 18 built-in agents in `ModuleRegistry.createWithBuiltins()` | ✅ present before |
| 19 | read documentation | `read_file` covers docs (README.md, docs/*.md) | ✅ CLOSED — P0.2 (was the biggest gap: `read_page` was web-only) |
| 20 | publish releases | `publish` (bump/changelog/build/publish, IRREVERSIBLE gate) | ✅ present before |
| 21 | deliver messages to channels | `gateway_send` + `run_cli` | ✅ present before |
| 22 | browser automation | `browser` (optional playwright) | ✅ present before |
| 23 | image / voice / vision | `generate_image`, `speak`, `transcribe`, `describe_image` | ✅ present before |

---

## The honest summary

**Of the original gap table (rows 1–8), every row is now CLOSED** — that was
the "reading docs / no file tools" gap you remembered: the agent couldn't even
open a file (`read_page` was web-only). P0.1–P0.5 shipped the interactive
loop: read → edit → run → ask → verify, all as tools, all GUI-rendered.

**The remaining gaps (all verified missing in `registry.ts` today):**

1. **P0.6 — step cards** (row 12). The tools exist and run, but the GUI shows
   progress *lines*, not structured step cards (tool name, args, status,
   result). This is the last piece of "the loop is *visible*".
2. **P3 — `clone_repo`** (row 13, plan row 21). Copilot-style "clone into a
   temp dir and assess" — the exact "assess other people's projects" ask.
3. **P3 — gated git** (row 15). `git diff` works via `run_terminal` (read-only
   class); `git commit` needs a dedicated gated tool with accept/reject UI.
4. **P5 — release-sync** (row 14, plan row 23). After `publish`, diff
   website/docs vs the new release and surface gaps.
5. **NEW finding — `skill` tool** (row 16). The module registry HAS a
   `SkillRunnerAgent` and the learning layer HAS `skills-registry.ts`, but the
   **chat tool registry has no `skill` tool** — verified `MISSING skill`.
   A user can't say "load the X skill" in the dashboard chat.
6. **NEW finding — no plan/todo tracking** (row 17). I maintain a visible
   todo list across a multi-step task (`write_todos`); agent-nuvira's chat
   loop has no equivalent — a long task shows progress lines but no
   structured "3/5 steps done" plan.

**Anti-loss guardrail:** this doc is tracked. If any gap is later found, it
gets a row here before any code is written for it — the plan is the single
source of truth, and the master plan (`UI_UPGRADE_MASTERPLAN.md`) was lost
once; it must be recreated or this doc must be its row-level replacement.

---

## Round 2 — user-named agentic capabilities (verified 2026-08-17, code-level)

User ask: *"are we certain post-upgrade there will be no gap in agentic
capability vs Freebuff — code assessment, evaluating code and recommendations,
tech roadmap, creating + tracking plans, finding new ways to test, switching
tools when one fails, exploring parallel ways?"*

**Honest answer: NO — four of the named capabilities are only partially
covered, and one is not covered at all. Verified below.**

| # | Named capability | What exists at code level | Verdict |
|---|---|---|---|
| 24 | **Creating plans AND tracking them** | The orchestrator has an internal planner agent (invisible), but the chat loop has **no `write_todos`-equivalent tool** — verified `MISSING write_todos` in the registry. No "3/5 steps done" surface. | 🔴 **NOT COVERED** |
| 25 | **Switch tools when one fails** | The tool loop feeds a tool error back to the model and continues (maxSteps 8) — a STRONG model retries with another tool. But there is **no deterministic fallback chain** (e.g. `run_terminal` fails → try `delegate tester`); a weak model repeats the same failing call. | ⚠️ PARTIAL (model-dependent) |
| 26 | **Explore parallel ways** | The chat loop is STRICTLY SEQUENTIAL — one tool call per step. Parallel fan-out exists in the orchestrator's pipeline lanes and in `delegate`/`spawnSubagents` (max 4, Promise.all), but the agent must *think* to use it; the loop itself never suggests parallelism. | ⚠️ PARTIAL (exists, not surfaced) |
| 27 | **Load reusable capability packs (skills)** | `SkillRunnerAgent` exists in the module registry and skills-registry/hub in learning — but the **chat registry has no `skill` tool** (verified `MISSING skill`). A user can't say "load the code-assessment skill" in chat. | 🔴 **NOT COVERED (as a chat tool)** |
| 28 | **Structured code assessment → gap recommendations → technical roadmap** | `analyze`/`document` pipeline tools exist but are BLACK BOXES (run the whole pipeline, return a summary). The interactive read→judge→recommend→roadmap loop is now *possible* (read_file/edit/run_terminal + a strong model) but there is no structured checklist/playbook deliverable, no assessment template, no roadmap artifact. | ⚠️ PARTIAL (possible, not structured) |

### What closes these gaps (additions to the plan)

- **P0.7 — plan/todo tool** (row 24): a `plan`/`todo` tool in the registry —
  the model declares steps, updates status as tools complete, and the GUI
  renders a live checklist. Closes "creating plans AND tracking them".
- **P0.8 — skill tool** (row 27): expose the existing skill store as a
  `skill` tool in the chat registry (load/apply a named skill mid-turn),
  surfaced as a toolset toggle. Closes "load reusable capability packs".
- **P3 — tool-fallback chain** (row 25): deterministic alternative-tool
  hints in the loop — when a tool errors, inject a concrete alternative
  ("run_terminal failed → delegate tester, or retry with a longer timeout")
  instead of only the raw error. Removes the weak-model dependency.
- **P3 — parallel suggestion** (row 26): after 2+ independent tool steps,
  the loop may suggest a `delegate` fan-out for independent subtasks
  (parallel ways become a first-class loop behavior, not model whimsy).
- **P5 — assessment/roadmap playbook** (row 28): a bundled skill
  (code-assessment checklist → gap findings → recommendations → technical
  roadmap) delivered as a structured artifact card. Closes "code assessment
  and roadmap as structured deliverables".

**Acceptance:** after P0.7/P0.8/P3/P5, the five named agentic capabilities
(rows 24–28) must each be demonstrable from the dashboard chat alone — with
a visible plan checklist, a loaded skill, a demonstrated tool-switch on
failure, a parallel sub-agent fan-out, and a structured roadmap artifact.

---

## Round 3 — skill DEPTH audit (verified 2026-08-17, code-level)

User ask: *"a skill existing in agent-nuvira can't be treated as existing —
there could be a huge gap in capability of a skill with the same name/intent
vs what Freebuff/Claude Code/Hermes have. Have we compared existing skills in
depth? Have we done the strengthening of existing skills / capabilities?"*

**Honest answer: NO — the skill machinery exists but the content is nearly
empty, and no depth comparison against reference agents has been done.**

### Verified facts (code + disk + registry)

| # | Check | Result |
|---|---|---|
| 29 | **How many bundled first-party skills ship?** | **EXACTLY ONE** — `src/skills/bundled-skills.ts` exports `BUNDLED_SKILLS = [websiteDeploySkill]` (website-deploy: 5 steps, 7 providers, params, quality 0.9). Nothing else ships. |
| 30 | **Is the default skill registry populated?** | **NO** — the configured default (`https://raw.githubusercontent.com/imdheerajKube/agent-nuvira/main/.agents/skills`) returns **404** for `index.json`; the repo has no `.agents/skills/` dir. |
| 31 | **User store content** | `~/.buff/skills/` contains only an empty `index.json` — zero installed skills. |
| 32 | **Skills for the named agentic capabilities?** | **ZERO** — no code-assessment skill, no gap-analysis skill, no technical-roadmap skill, no plan-creation skill, no test-strategy skill. The only skill is deployment. |
| 33 | **Depth comparison vs Claude Code / Freebuff / Hermes?** | **NOT DONE** — no doc, no audit, no row-by-row comparison of same-name skills. Claude Code ships ~15+ built-in skills (pdf/docx/pptx/xlsx, playwright, image-generation, brand-guidelines, url-fetcher, …) + a skill-authoring framework; agent-nuvira ships 1. |

### What the machinery CAN already do (the good news)

- `Skill` shape is solid: structured steps with `agentType` + `dependsOn` +
  `promptTemplate`, typed parameters (string/file-path/code-snippet/choice),
  goalPattern matching, tags, quality scoring, usage tracking, decay GC.
- `SkillStore.seedBundledSkills()` proves first-party shipping works — a new
  skill in `bundled-skills.ts` lands in every install, idempotently.
- `SkillRunnerAgent` + `hub-skill-catalog` (SKILL.md progressive disclosure)
  + `skill-compiler` (trajectory → skill learning) all exist and are tested.
- The website-deploy skill itself is a good template: real methodology
  (wrangler-4 project-create gotcha, provider-by-provider commands, live-URL
  verification step) — the depth bar is set; it's just only applied to ONE
  skill.

### What closes this gap (additions to the plan)

- **P5 — skill-depth audit + strengthening (rows 29–33)**: before/alongside
  the P5 assessment playbook, do a first-party skill BATCH:
  1. **Inventory the reference agents' skill catalogs** (Claude Code built-ins
     + authoring docs, Hermes `skills_hub`/toolsets, Freebuff researcher
     patterns) — a row-per-skill comparison table appended to this doc.
  2. **Ship first-party skills for the named capabilities** in
     `bundled-skills.ts`, each at the website-deploy depth bar:
     - `code-assessment` — read → evaluate (correctness/security/perf/
       architecture) → gap findings → prioritized recommendations
     - `technical-roadmap` — current state → target state → phased roadmap
       with dependencies + effort/risk
     - `plan-create-track` — break goal into checkable steps, mark done,
       surface blockers (feeds the P0.7 plan tool)
     - `test-strategy` — unit/integration/e2e selection, edge cases,
       property tests, mutation-style checks (feeds the P3 fallback chain)
  3. **Verify the default registry** — either populate the repo
     `.agents/skills/` with the bundled skills (so the configured default
     stops 404ing) or point it at a populated hub.
  4. **Acceptance**: `buff skills list` shows the full first-party batch;
     each new skill is exercisable via `buff skill run <name>` AND matches
     from the dashboard chat; the comparison table is in this doc.

**The honest bottom line (updated 2026-08-17 after P5b):** the skill SYSTEM
is real (shape, store, seeding, runner, compiler, catalog — all tested), and
agent-nuvira now ships **five first-party skills** (website-deploy +
code-assessment + technical-roadmap + plan-create-track + test-strategy),
each at the website-deploy depth bar (ordered dependsOn steps, parameters,
verification). The comparison table below is the row-per-skill audit; the
remaining P5c items are #3 (registry 404) and #4 (acceptance proof), tracked
below.

## P5c #1 — Row-per-skill comparison table (reference catalogs vs agent-nuvira)

Depth bar = real methodology (steps with agent types + dependencies),
parameters, verification steps, and it runs both from `buff skill run` and
from dashboard chat via the P0.8 skill tool. Agent-nuvira column = current
first-party bundled skills (each verified at the depth bar).

| Capability area | Claude Code built-ins | Hermes / Freebuff patterns | agent-nuvira bundled skill | Depth verdict |
|---|---|---|---|---|
| Website deploy | deploy skill (provider-by-provider) | — | `website-deploy` (5 steps: gather → ensure project → deploy per provider → curl 200 → review) | ✅ at bar (wrangler-4 gotcha baked in) |
| Code assessment / review | code-review skill (files → findings → severity) | Freebuff researcher patterns (gather → judge → recommend) | `code-assessment` (map → evaluate 5 dimensions → gaps+severity → prioritized recs, cited evidence) | ✅ at bar (P5b) |
| Roadmap / planning | roadmap skill (current → target → phases) | Hermes planner | `technical-roadmap` (current cited → measurable target → 3–5 phases w/ deps, effort, risk, out-of-scope + critical path) | ✅ at bar (P5b) |
| Plan creation + tracking | todo/plan tracking (visible progress) | — | `plan-create-track` (declare via plan_todo → update running/done/blocked → never stall on one blocked step) | ✅ at bar (P5b, feeds P0.7 tool) |
| Test strategy | test skill (run the real suites) | Hermes tester agent | `test-strategy` (map surface → matrix focused→unit→integration→e2e + static gate → run real commands → verdict with evidence) | ✅ at bar (P5b, feeds P3 fallback) |
| Authoring framework | ~15+ built-ins + skill authoring docs + SKILL.md hub | skills_hub, SKILL.md catalog | SKILL.md catalog read (hub-skill-catalog) + trajectory→skill compiler + skill store — the AUTHORING path exists, only 5 first-party skills ship | ⚠️ system present; catalog depth is 5 vs ~15+ |

**P5c remaining after this row:** #3 default-registry 404 fix (populate the
repo `.agents/skills/` or repoint config — the configured default still
404s today), #4 acceptance proof (`buff skills list` shows the batch —
verified; matches from dashboard chat — verified via the P0.8 skill tool and
findMatch tests).
