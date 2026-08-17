# Implementation Briefs — reasoning-carrying chunks for every pending item

**Why this doc exists:** the user's standing requirement — *"at the time of
implementation of each item you must recollect the ENTIRE (not one line) intent
from this conversation and perform exactly what was expected."* The original
master plan (UI_UPGRADE_MASTERPLAN.md) carried these briefs but was **lost**
(untracked working doc, cleaned up). P0.1–P0.5 survived only because they were
implemented in the same session that produced their briefs. This doc is
**tracked** and is the single source of truth for every pending item.

**How to use:** when implementing ANY item below, read the WHOLE chunk (ask →
ground truth → acceptance → deep-backward-tests → matrix rows), not just the
title line. If any capability from `ASSESSMENT_CAPABILITY_GAPS.md`
(rows 1–33) is relevant to the item, it is cross-referenced in the chunk —
implement the chunk's intent, then tick its matrix rows.

**Completed anchor (for continuity):** P0.1 ask_user round-trip (chat-console
`askQuestion`/`respond` + server `/api/chat/:sessionId/respond` + ChatPage
question card + 2 tests), P0.2 read/list/glob (`src/tools/coding-tools.ts`),
P0.3 edit/write (confirm-gated), P0.4 run_terminal
(`src/tools/run-terminal.ts`, deny-first), P0.5 conversation-vs-pipeline gate
(`src/nlu/conversation-gate.ts`, wired into `resolvePipelineDispatch` +
`execute.runSingleGoal`).

---

## P0.6 — Step cards (structured tool-call rendering)

**Ask (user):** *"make dashboard chat so powerful that no one needs to go back
to CLI"*; *"you have UI… agent-nuvira must deliver same capability as Claude
Code / Freebuff"*; the interactive loop must be *visible* — read → think →
edit → run → verify, each as a card.

**Ground truth:** the chat loop already emits progress LINES
(`chat-console.ts` `onProgress` → SSE `progress` event → ChatPage appends
plain lines). The registry (`src/tools/registry.ts`) exposes 28 tools
(verified 2026-08-17) with names/descriptions. The tool loop
(`src/tools/tool-loop.ts`) tracks `toolCallsRun` per turn and logs
`⚙ <name>(<args>)` via `onEvent`. But the GUI has **no structured
tool-call card**: no tool name, no args summary, no status, no result
preview. The observability bus already emits `tool:called` events
(`ctx.emit('tool:called', {tool, ok, result, durationMs})`) — the data
exists; the render surface does not.

**Acceptance:**
- Each tool call in a chat turn renders as a card: tool name, one-line args
  summary, status (running / ok / error), elapsed ms, and a collapsible
  result preview.
- The card stream appears in ChatPage in real time (same SSE path).
- Suggest_followups/ask_user calls do NOT render as cards (they have their
  own UI: chips / question card).
- A turn with no tool calls renders only the answer (no empty cards).

**Deep backward tests:** existing ChatPage tests pass (question card, chips,
send flow); chat-console progress-line tests still pass (cards are an
additional event, not a replacement); no double-render when both `progress`
lines and cards arrive for the same step.

**Matrix rows:** 12 (step cards), 26 (parallel suggestion later surfaces here).

---

## P0.7 — Plan/todo tool (creating AND tracking plans)

**Ask (user):** *"creating plans, tracking them"* is a named capability;
*"user may ask the agent to do a job and the agent executes it"* — a
multi-step job must show "3/5 steps done", not a wall of lines.

**Ground truth:** verified `MISSING write_todos` in the registry — the chat
agent has NO plan-declaration tool. The orchestrator's internal planner
(`src/agents/agents/planner.ts`) is invisible to chat. The Skill shape
(`src/learning/skill-types.ts`) already models ordered steps with
`dependsOn`/status — a usable pattern. The GUI renders a live checklist
surface in ChatPage (chips/cards precedent from P0.6).

**Acceptance:**
- A `plan` (or `todo`) tool in the registry: the model declares steps
  (id, description), updates status (pending/running/done/blocked), and the
  tool returns the current checklist; the GUI renders it as a live checklist
  card that updates in place.
- Steps persist across the turn (not per-step strings); a later turn can
  reference the plan ("step 3 is done").
- Belongs to a toolset (e.g. `coding` or `experience`) with a toggle; the
  hub-data toolset-count tests are updated DELIBERATELY (they broke before
  when a toolset was added — see P0.2 commit).
- When a step errors, the model can mark it blocked and continue others
  (feeds the P3 fallback chain).

**Deep backward tests:** toolsets-count tests updated intentionally, not by
accident; tool-loop tests still pass with the new tool registered (no
execution-order assumptions broken); ChatPage tests for the checklist card;
a plan that is never completed must not block the turn (best-effort tool).

**Matrix rows:** 24 (plan creation + tracking), 17 (no write_todos — closes).

---

## P0.8 — Skill tool (load reusable capability packs in chat)

**Ask (user):** *"load reusable capability packs"*; *"user can't say 'load the
code-assessment skill' in chat"* (round-3 finding); the skill store exists but
is unreachable from the dashboard chat.

**Ground truth:** verified `MISSING skill` in the registry. The machinery is
complete and tested: `SkillStore` (`src/learning/skill-store.ts`, seeded via
`seedBundledSkills`), `SkillRunnerAgent`
(`src/agents/agents/skill-runner.ts`, parses "Run skill: <name> --param=x"),
`hub-skill-catalog` (`src/learning/hub-skill-catalog.ts`, SKILL.md
progressive disclosure), `skills-registry.ts` (multi-source install/search).
Round-3 audit (rows 29–33): only ONE bundled skill ships
(`src/skills/bundled-skills.ts`), default registry 404s. The chat loop has no
`skill` tool to load/apply one mid-turn.

**Acceptance:**
- A `skill` tool in the registry: name (+ optional params) → loads from the
  store/catalog, returns the skill's steps/methodology to the model, marks
  used. Unknown skill → lists available ones.
- The four P5 first-party skills (code-assessment, technical-roadmap,
  plan-create-track, test-strategy) become loadable via this tool once P5
  ships them.
- Surfaced as a toolset toggle; `buff skills list` and dashboard chat agree
  on availability.

**Deep backward tests:** registry/toolsets count tests; skill-store tests
pass (tool only reads through existing store API, never mutates store
semantics); a load of a disabled skill is refused (toolset gate parity).

**Matrix rows:** 16 (skill tool — closes), 27 (NOT covered → closes).

---

## P3a — clone_repo tool (assess other people's projects)

**Ask (user):** Copilot "cloned the repo in a temp dir and did analysis" —
the agent must be able to assess a project that is NOT the attached workspace.

**Ground truth:** verified `MISSING clone_repo` in the registry. `git clone`
patterns exist in `src/team/memory.ts:125` and `src/learning/skills-registry.ts:163`
(shallow clone into a hashed cache dir, 60s timeout) — reusable as the
mechanics. Plan row 21 was assigned P3 and never built.

**Acceptance:**
- A `clone_repo` tool: `git clone --depth 1 <url>` into a sandboxed temp
  workspace (hashed under a tools cache dir), then read_file/list_dir/glob/
  code_search operate scoped to THAT workspace (cwd override per call), then
  a recommendation card; cleanup or cache-reuse on completion.
- Deny-first: only http(s)/git URLs; no shell injection (URL validated);
  depth-1 shallow only; the clone dir is outside the user workspace and
  marked ephemeral.
- Works from dashboard chat (the "assess this other repo" ask).

**Deep backward tests:** git clone stubbed in tests (no network — pattern
from `tests/learning/skills-registry.test.ts`); cwd-scoping tests for the
coding tools with a cloned workspace; cleanup tests (no stray clones in the
user's project).

**Matrix rows:** 13 (clone_repo — closes), 21 (plan row).

---

## P3b — Gated git tool (diff/commit with accept-reject)

**Ask (user):** "change the code files, asked me to commit" — the agent must
commit in-conversation, visibly.

**Ground truth:** verified `MISSING git` tool in the registry. `run_terminal`
(`src/tools/run-terminal.ts`) covers git READ-ONLY (status/diff/log as the
verify class) and `git commit` only as a confirm-class command — no
structured accept/reject diff UI. A `GitAgent` exists in the module registry
(`src/agents/module-registry.ts` 'git') but is not a chat tool.

**Acceptance:**
- A `git` tool: `git diff` (structured, rendered as a 🔧 diff card with
  accept/reject per change), `git commit` (gated: confirm via ask_user, then
  commit with the user's message), `git status`/`log` read-only.
- Never `git push` / `git reset --hard` / `git clean` (deny list shared with
  run_terminal).
- Works from dashboard chat; the diff card is the P2 artifact pattern.

**Deep backward tests:** deny-list parity with run_terminal (a command denied
in one is denied in the other); accept/reject applies only accepted hunks;
no commit without confirm; registry/toolsets count tests updated
deliberately.

**Matrix rows:** 15 (gated git — closes).

---

## P3c — Tool-fallback chain (switch tools when one fails)

**Ask (user):** *"if one tool fails you switch to another and explore parallel
ways"*; round-2 row 25: fallback is model-dependent today.

**Ground truth:** `src/tools/tool-loop.ts` (verified): on tool error the raw
`Error: …` text is fed back and the loop continues (maxSteps 8) — a STRONG
model retries with another tool; a weak model repeats the same failing call.
There is no deterministic alternative-tool hint. The tool registry has
redundant paths by design (read_file vs code_search vs delegate;
run_terminal vs delegate tester) but nothing surfaces them.

**Acceptance:**
- When a tool errors, the loop appends a CONCRETE alternative hint to the
  error text (e.g. run_terminal failed → "try delegate with agent_type
  tester, or retry with a longer timeout_ms") chosen from a per-tool
  fallback map.
- The hint is advisory (the model still decides), deterministic (no LLM
  call), and does not change tool-loop semantics for non-error paths.
- Falls back only on error/denial, never on success.

**Deep backward tests:** tool-loop error-path tests assert the hint is
present for the mapped tools and absent on success; no behavior change for
passing tools; generationFailed semantics unchanged (P0.4/P0.5 tests).

**Matrix rows:** 25 (tool-fallback — closes).

---

## P3d — Parallel suggestion (explore parallel ways)

**Ask (user):** *"explore parallel ways"* — independent subtasks should fan
out, not serialize.

**Ground truth:** the chat loop is strictly sequential — one tool call per
step (`src/tools/tool-loop.ts`). Parallel fan-out EXISTS in
`src/agents/tools/delegation.ts` (`spawnSubagents`, Promise.all, max 4,
per-sub-agent timeout + AbortSignal) and in the orchestrator's parallel
lanes — but the loop never suggests it; the model must think to call
`delegate`.

**Acceptance:**
- After 2+ independent tool steps in a turn, the loop may inject a
  suggestion to `delegate` independent subtasks in parallel (advisory hint,
  same mechanism as P3c) with the exact delegate syntax.
- The delegate result card (P6 surface) shows the fan-out lanes.
- Bounded: never more than `delegate`'s max 4; never on dependent steps.

**Deep backward tests:** delegation tests pass (spawnSubagents untouched);
loop hint tests assert the suggestion fires only after independent steps;
no change to sequential single-tool turns.

**Matrix rows:** 26 (parallel — closes), 18 (delegate exists — preserved).

---

## P5a — Release-sync loop (website/docs kept at release level)

**Ask (user):** *"whenever a new publish happens you ensure the website is
updated, kept at the same level, you compare release versions, fix the gaps"*
(plan row 23).

**Ground truth:** `publish` tool exists (`src/tools/registry.ts` publishTool,
bump/changelog/build/publish). The website is a built artifact in this repo
(`website/index.html` + `src/web-dashboard/public/` assets) whose version
strings drift from package.json after releases (observed: dist/assets
index-*.js are versioned by build). No post-publish diff exists.

**Acceptance:**
- After a successful `publish`, a release-sync step diffs the published
  version against the website/docs (version strings, changelog, asset
  hashes) and surfaces gaps as a card with offer-to-fix.
- The offer routes through ask_user → edit_file (existing loop).
- Best-effort: a sync check failure never marks the publish failed.

**Deep backward tests:** publish-tool tests pass (sync is post-publish,
never alters publish success); version-drift fixture tests (stale version
string detected); no-op when versions already match.

**Matrix rows:** 14 (release-sync — closes), 23 (plan row).

---

## P5b — Assessment/roadmap playbook (structured deliverables)

**Ask (user):** *"understanding a task of code assessment, evaluating code and
recommendations, generate gaps and suggest technical roadmap"* — as
structured artifacts, not black-box pipeline summaries.

**Ground truth:** `analyze`/`document` pipeline tools are BLACK BOXES
(`src/tools/registry.ts`: `runPipelineTool('analyze'|'document', …)` returns
a summary). Round-2 row 28: the interactive read→judge→recommend loop is now
possible (P0.2–P0.5 tools) but there is no structured checklist, no
assessment template, no roadmap artifact.

**Acceptance:**
- A bundled first-party skill `code-assessment`: read → evaluate
  (correctness/security/perf/architecture) → gap findings → prioritized
  recommendations, delivered as a structured artifact card.
- A bundled first-party skill `technical-roadmap`: current state → target
  state → phased roadmap with dependencies + effort/risk.
- Both are exercisable via `buff skill run <name>` AND loadable from the
  dashboard chat via the P0.8 skill tool.
- Each skill meets the website-deploy depth bar (real methodology, provider/
  scenario detail, verification steps — see `src/skills/bundled-skills.ts`).

**Deep backward tests:** skill-store seeding tests include the new bundled
skills (count + idempotent re-seed); skill-runner tests run each skill's
steps; catalog-match tests (a goal like "assess this codebase" matches
code-assessment).

**Matrix rows:** 28 (assessment/roadmap — closes), 32 (skills exist for named
capabilities — closes).

---

## P5c — Skill-depth audit + strengthening (rows 29–33)

**Ask (user, round 3):** *"a skill existing can't be treated as existing —
there could be a huge gap vs same-name skills in Freebuff/Claude Code/Hermes.
Have we compared in depth? Have we strengthened?"*

**Ground truth (verified 2026-08-17):** ONE bundled skill ships
(`BUNDLED_SKILLS = [websiteDeploySkill]`); default registry 404s; user store
empty; no comparison doc exists; Claude Code ships ~15+ built-in skills.

**Acceptance:**
1. A row-per-skill comparison table (Claude Code built-ins + authoring docs,
   Hermes skills_hub/toolsets, Freebuff researcher patterns vs agent-nuvira)
   appended to `ASSESSMENT_CAPABILITY_GAPS.md`.
2. First-party skill batch in `bundled-skills.ts` (code-assessment,
   technical-roadmap, plan-create-track, test-strategy) at the
   website-deploy depth bar.
3. Default registry fixed: populate repo `.agents/skills/` with the bundled
   skills OR repoint config to a populated hub (no 404).
4. `buff skills list` shows the batch; each matches from dashboard chat.

**Deep backward tests:** skills-registry/hub tests still pass with the new
default source (stub git clone / fetch — existing patterns); seed tests for
the new skills; registry-404 regression test (the configured default must
resolve or explicitly fall back, never silently 404 in a user's face).

**Matrix rows:** 29–33 (closes all).
