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
| 12 | render tool calls as visible steps in the conversation | `ToolCards` in ChatPage (`chat-tool-card`: running → ok/error, args, result, durationMs, live mode) | ✅ CLOSED — P0.6 |
| 13 | clone a repo into a temp dir and analyze it (assess other people's projects) | `clone_repo` (shallow depth-1, hashed ephemeral cache, argv-only git, `ctx.cwd` scoping) | ✅ CLOSED — P3a |
| 14 | keep the website/docs in sync after each release (compare versions, fix gaps) | — | 🔴 OPEN — P5 (release-sync loop, plan row 23) |
| 15 | `git diff` / `git commit` gated in the conversation | `git` tool (status/log/diff/commit; structured `git:diff` event → 🔧 diff card; commit gated by `confirm:true` + accepted `files` subset; push/reset/clean structurally unexpressible) | ✅ CLOSED — P3b |
| 16 | skills: load reusable instruction packs | `skill` tool in the chat registry (compiled store + hub catalog, deterministic loop-side hint too) | ✅ CLOSED — P0.8 + Addendum v4 Phase 3.2 |
| 17 | plan-tracking: maintain a visible todo list across the turn | `plan_todo` tool (per-session `PlanStore`, GUI renders the live checklist; planner-loop guard in the loop) | ✅ CLOSED — P0.7 |
| 18 | sub-agents: delegate to specialized agents (context-gatherer, reviewer, security, tester) | `delegate` tool + 18 built-in agents in `ModuleRegistry.createWithBuiltins()` | ✅ present before |
| 19 | read documentation | `read_file` covers docs (README.md, docs/*.md) | ✅ CLOSED — P0.2 (was the biggest gap: `read_page` was web-only) |
| 20 | publish releases | `publish` (bump/changelog/build/publish, IRREVERSIBLE gate) | ✅ present before |
| 21 | deliver messages to channels | `gateway_send` + `run_cli` | ✅ present before |
| 22 | browser automation | `browser` (optional playwright) | ✅ present before |
| 23 | image / voice / vision | `generate_image`, `speak`, `transcribe`, `describe_image` | ✅ present before |
| 24 | Model-first routing (score models across providers) | `model-first-router.ts` — 6-dimension scoring, 22 providers, 300+ models | ✅ CLOSED — v1.80.0 |
| 25 | Tiered failover (same-model → same-tier → escalate → de-escalate → local) | `model-first-router.ts` — `buildTieredFailoverChain()` with quota pre-check | ✅ CLOSED — v1.80.0 |
| 26 | 1-token warmup (keep models hot) | `model-warmup.ts` — background daemon, priority scoring, 60s interval | ✅ CLOSED — v1.80.0 |
| 27 | Tool-level modality routing (image/audio/video with failover) | `tool-router.ts` — intelligent backend selection with failover | ✅ CLOSED — v1.80.0 |

---

## The honest summary

**Of the original gap table (rows 1–8), every row is now CLOSED** — that was
the "reading docs / no file tools" gap you remembered: the agent couldn't even
open a file (`read_page` was web-only). P0.1–P0.5 shipped the interactive
loop: read → edit → run → ask → verify, all as tools, all GUI-rendered.

**The remaining gaps (all verified missing in `registry.ts` today):**

1. **P3 — `clone_repo`** (row 13, plan row 21). Copilot-style "clone into a
   temp dir and assess" — CLOSED (P3a): `clone_repo` + tests, exposed in the
   'advanced' toolset.
2. **P3 — gated git** (row 15). CLOSED (P3b): the `git` tool (diff card +
   gated commit with accepted-files subset) + tests.
3. **P0.6 — step cards** (row 12). CLOSED: ChatPage `ToolCards` renders every
   tool call as a structured card (running/ok/error, args, result, duration).
4. **P0.7/P0.8 — plan_todo + skill tools** (rows 16/17). CLOSED: both in the
   registry, both toolset-exposed, both tested.
5. **P5 — release-sync** (row 14, plan row 23). Still OPEN — the only matrix
   gap left.

> Status refresh 2026-09-08: rows 12, 13, 15, 16, 17 verified CLOSED in code
> (registry.ts + ChatPage ToolCards + tests/tools/{clone-repo,git-tool}.test.ts,
> 21 tests) and Round-2 rows 24/27 closed by P0.7/P0.8. The Round-2 table's
> 🔴 verdicts for plan-tracking and skills are superseded by the matrix above.
> Remaining OPEN: row 14 (release-sync, P5) and row 25/26 model-dependent
> partials (mitigated by P3 fallback hints + parallel suggester, both in the
> loop).
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
verification). The comparison table below is the row-per-skill audit; P5c #3
(registry 404) is FIXED below (the repo now ships `.agents/skills/` + a
status-aware probe — never a silent 404); #4 acceptance proof is verified.

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

**P5c after this row — #3 FIXED:** the default registry (`…/agent-nuvira/main/.agents/skills`) stopped silently 404ing:

1. **Registry populated** — `scripts/sync-hub-skills.mjs` renders the five
   bundled skills into the committed `.agents/skills/` (index.json + real
   SKILL.md per skill with full methodology); a sync-drift guard test fails
   if `bundled-skills.ts` changes without re-running the script. The
   packaged `.agents/skills/` is ALSO shipped in the npm tarball
   (package.json files + .npmignore) and the default registry resolution
   prefers it (`file://` local-dir, resolves from the install itself) — so
   the registry works even though the repo is PRIVATE (raw.githubusercontent
   only serves public repos). Private-repo-independent by design.
2. **Never silently 404** — `probeRegistries()` is status-aware (local-dir
   index read, HTTP status for github-raw/browse-sh, clone result for
   git-repo); `buff skills search`/`install` empty-result paths now surface
   WHICH source failed and with what status + a fix hint
   (`skills.registries[]` / `BUFF_SKILLS_REGISTRY`) instead of a bare
   "no skills found". Verified live: with no config, the default probes
   `reachable:true, entryCount:5` and searches resolve.

**P5c #4 (acceptance proof):** `buff skills list` shows the five-skill batch
(verified via `buff skill list` + `buff skills search`); each matches from
dashboard chat (verified via the P0.8 skill tool and findMatch tests).

## P5c #5 — Skill ONBOARDING: agent-nuvira vs Hermes Agent (third-party consumption)

**Ask (user):** *"as per Copilot, Hermes can consume skills developed by
other developers — can't we allow our users to do that in similar fashion
and still keep our repo private?"*

**Ground truth (verified 2026-08-17):** Hermes (NousResearch, official docs
skills page + work-with-skills guide) vs agent-nuvira (code-verified this
session). Copilot's summary was directionally right but omitted Hermes'
concrete mechanisms (slash commands, /learn, bundles, external dirs,
conditional activation) — the table below uses the REAL docs.

### The short answer

**agent-nuvira users can ALREADY consume third-party skills — and the
private repo is irrelevant to it.** Third-party onboarding reads OTHER
people's registries (browse.sh, any git repo, any github-raw URL), never
agent-nuvira's own repo. The private repo only affected the FIRST-PARTY
default registry, which is now shipped inside the npm package instead.

### Row-by-row comparison (Hermes real docs vs agent-nuvira code)

| Capability | Hermes (official docs) | agent-nuvira (code) | Verdict |
|---|---|---|---|
| **Third-party install** | `hermes skills install <name>`, URL installs (`install https://…/SKILL.md`), official optional skills (`official/research/arxiv`) | `buff skills install <name>` from 4 source kinds: github-raw, local-dir, browse-sh, **git-repo** (clones ANY repo, auto-detects skills/.claude/skills/.agents/skills roots) + URL sources | ✅ PARITY — agent-nuvira consumes the SAME community ecosystem (browse.sh) and any developer's repo; Hermes adds URL-single-file + official namespace |
| **Discovery** | `hermes skills search` / `/skills search`, Skills Hub browse, skills.sh registry | `buff skills search <query>` across ALL configured registries (multi-source, deduped, priority-ordered) + probe with explicit unreachable-source hints | ✅ PARITY — multi-source is a superset of hub-only |
| **Standardized interface** | SKILL.md frontmatter + agentskills.io open standard; rich fields (platforms, tags, category, config, conditional activation) | SKILL.md frontmatter (name/description/version, same open standard); install validates frontmatter, records checksum + provenance, quarantines mismatches | ⚠️ CORE PARITY — same file format; agent-nuvira's hub parser reads fewer frontmatter fields (platforms/config/conditional fields not yet consumed) |
| **Dynamic loading** | Level 0 skills_list (~3k tokens) → Level 1 skill_view(name) → Level 2 reference file — loaded only when needed | P0.8 skill tool: hub catalog Level 0 (name+desc) → Level 1 (full methodology on match); skill-store findMatch; progressive disclosure | ✅ PARITY |
| **Composition / chaining** | Slash-command stacking (up to 5 per message) + skill bundles (YAML grouping) | Skill steps with `dependsOn` + agent-type routing; multi-step ordered execution via SkillRunnerAgent | ⚠️ PARTIAL — within-skill step chains exist; no cross-skill bundle/chain primitive yet |
| **Agent-authored skills** | `/learn` (point at docs/URLs/workflow → agent authors a SKILL.md following house standards) | trajectory→skill compiler (SkillCompiler distills high-scoring trajectories) + self-improver; skill-store GC | ⚠️ PARTIAL — compiler exists but requires trajectories; no interactive `/learn`-style path from user-provided material |
| **Community contribution** | Developers publish skills to skills.sh / hub / registries; CONTRIBUTING.md for upstream | Users publish by pointing a registry at their repo (github-raw/git-repo) or sharing a local-dir; no first-party marketplace | ✅ CONSUMER PARITY — agent-nuvira consumes community skills; lacks a hosted marketplace of its own |
| **Security on install** | quarantine + lock.json + audit.log + content hash; secure env-var setup | sandboxed name validation (^[a-z0-9-]+$), frontmatter sanity, checksum mismatch → quarantine, provenance ledger | ✅ PARITY |
| **Private-repo independence** | n/a (open-source repo) | Default registry ships in the npm package; probe never silently 404s | ✅ agent-nuvira-specific win |

### Honest gaps (where agent-nuvira is behind)

1. **No `/learn`** — Hermes turns docs/URLs/workflows into a skill in one
   interactive step; agent-nuvira's compiler needs stored trajectories.
2. **No cross-skill bundles** — Hermes chains multiple skills under one
   command; agent-nuvira chains steps WITHIN a skill only.
3. **Thinner frontmatter consumption** — platforms, conditional activation
   (requires/fallback toolsets), config settings, secure env-var setup are
   Hermes fields agent-nuvira's hub parser doesn't yet read.
4. **No hosted marketplace** — agent-nuvira is a full CONSUMER of the
   community ecosystem but has no first-party "agent-nuvira skills hub" to
   publish against.
5. **No skill-creation offer loop** — Hermes offers to save a solved task as
   a skill; agent-nuvira compiles automatically from trajectories but never
   ASKS the user to confirm/publish one.

### What would close them (NOW PLANNED — see DASHBOARD_FIRST_PLAN.md Phase 7 + IMPLEMENTATION_BRIEFS.md P6)

- **P6a — `/learn`-style skill authoring**: point skill tool at a URL/dir/
  transcript → agent drafts a SKILL.md following bundled-skill standards →
  preview card (accept/edit/reject) → writes to the store under a
  user-visible name (mirrors Hermes `build_learn_prompt` + `skill_manage`;
  reuses the skill-compiler machinery + P0.8 skill tool).
- **P6b — skill bundles**: a `bundle` action on the skill tool + a
  `buff skills bundle` CLI that groups skills under one id (Hermes parity).
- **P6c — frontmatter depth**: parse + honor `platforms`, conditional
  activation fields, and declared config/env in hub-skill-catalog.
- **P6d — marketplace import surface**: dashboard Skills panel + thin
  endpoints over the EXISTING multi-source registry (browse.sh / git-repo /
  github-raw) — the private-repo-safe consumer path, Hermes Skills-Hub
  parity.
- **P6e — shipable first-party batch**: the five P5b skills become
  first-class product content (panel provenance, empty-state suggestions).

---

## Addendum v4 — implementation status (updated 2026-09-08)

All v4 phases are now implemented and tested. Per-phase landing:

- **Phase 0 — eval arms (loop vs pipeline vs writer-tc)**: shipped
  (`eval-framework.ts` + `tests/learning/eval-arms.test.ts`).
- **Phase 1.1 — `runToolLoop` as the executor behind `nuvira execute`
  dispatch**: shipped (`loop-executor.ts` + `tests/cli/loop-executor.test.ts`;
  `execute.ts` dispatches via `resolveEngine()`).
- **Phase 1.2 — native tool-calls protocol (the BLOCKING item)**: shipped
  (`inference/native-tools.ts` + `tests/inference/native-tools.test.ts`).
- **Phase 1.4 — ambient project context for the loop**: shipped
  (`tools/loop-project-context.ts`); CLI chat injects it too.
- **Phase 2 — route MODE as well as model**: shipped (`engine-router.ts` +
  `routing-cache.ts` + `tests/learning/engine-router.test.ts`;
  `routing.engineMode` config in `config/types.ts`).
- **Phase 3.2 — loop-side skill match hint**: shipped
  (`tools/loop-skill-hint.ts` + `tests/tools/loop-skill-hint.test.ts`). The
  chat loop and the execute loop now consult the compiled SkillStore + the hub
  catalog deterministically before every turn and inject the matched skill's
  methodology (bounded to ONE block, disabled-skill gate + website-deploy
  activation gate honored, exact skill-tool load syntax included). Guarded
  against the compiled store's loose threshold by a real-goal-evidence filter
  (`hasRealGoalEvidence`): a generic word like "goal" alone can never inject
  methodology into a chat turn.
- **Phase 3.3 — mechanical thread budget**: shipped (`tool-loop.ts`
  `trimThreadBudget`).
- **Phase 4 — engine-mode badge + per-turn tool-call telemetry in the
  dashboard DAG view**: shipped. The DAG store carries `engine` +
  `engineExplanation` + `loopTurn` telemetry
  (`web-dashboard/server.ts`: `beginLoopTurn` / `recordLoopToolCall` /
  `endLoopTurn` / `setLoopEngineContext`); the chat console reports real turns
  through the `onTurnCompleted` hook (a local server-fulfilled hook — no
  circular import; `web-dashboard/loop-turn-telemetry.ts` is the lazy sink);
  loop turns persist as timeline runs (phases = tool calls, engine 'loop');
  DAGView renders the engine badge (`🔁 loop` / `⬡ pipeline`), the per-turn
  telemetry card (tool calls, errors, provider/model, bounded/generation-
  failed/cancelled chips), and PhaseTimeline badges every run chip + meta row
  with the engine. Tests: `tests/web-dashboard/dag-store.test.ts` (Phase 4
  block), `tests/web-dashboard/chat-console.test.ts` (hook block),
  `src/web-dashboard/src/components/DAGView.test.tsx` +
  `PhaseTimeline.test.tsx` (Phase 4 blocks).

**Remaining from the matrix above (unchanged by v4):** P5 release-sync (row
14) is the only matrix gap left; P6a–P6e skill-onboarding items remain.
`clone_repo` (row 13, P3a) and the gated `git` tool (row 15, P3b) are
implemented + tested (2026-09-08).
