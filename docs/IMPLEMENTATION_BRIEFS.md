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

**Recovered (2026-09-28):** `docs/TOOL_TRUTHFULNESS_TRACKER.md` was restored as a
**tracked** doc (whitelisted in `.gitignore` — `*.md` is ignored, which is how the
original was lost). The eight source files that cite it by name now point at a file
that exists. Its P-list and status are reconstructed from those citations plus
`tests/tools/tool-truthfulness.test.ts`; see the doc's own provenance note for what
could **not** be recovered (findings #2/#8, and P4.1).

**Completed anchor (for continuity):** P0.1 ask_user round-trip (chat-console
`askQuestion`/`respond` + server `/api/chat/:sessionId/respond` + ChatPage
question card + 2 tests), P0.2 read/list/glob (`src/tools/coding-tools.ts`),
P0.3 edit/write (confirm-gated), P0.4 run_terminal
(`src/tools/run-terminal.ts`, deny-first), P0.5 conversation-vs-pipeline gate
(`src/nlu/conversation-gate.ts`, wired into `resolvePipelineDispatch` +
`execute.runSingleGoal`).

**CORRECTION (2026-08-21):** Several items previously listed as PENDING are
now SHIPPED. See `CORRECTED_GAP_PLAN_2026.md` for the verified status. The
following items are CONFIRMED SHIPPED:
- P0.7 plan_todo → ✅ SHIPPED (`src/tools/plan-store.ts` + registry.ts:664)
- P0.8 skill tool → ✅ SHIPPED (`src/tools/skill-tool.ts` + registry.ts:865)
- P3a clone_repo → ✅ SHIPPED (`src/tools/clone-repo.ts` + registry.ts:881)
- P3b git tool → ✅ SHIPPED (`src/tools/git-tool.ts` + registry.ts:897)
- P3c tool fallback hints → ✅ SHIPPED (`src/tools/tool-loop.ts:TOOL_FALLBACK_HINTS`)
- P3d parallel suggestion → ✅ SHIPPED (`src/tools/tool-loop.ts:makeParallelSuggester`)
- suggest_followups → ✅ SHIPPED (registry.ts:548)
- delegate → ✅ SHIPPED (registry.ts:912, 18 agents)
- artifact system → ✅ SHIPPED (`src/tools/artifact-types.ts`, `artifact-store.ts`)
- delivery ledger → ✅ SHIPPED (`src/gateway/delivery.ts`)

**ALL 6 GAPS ARE NOW SHIPPED (verified 2026-08-21):**
1. ~~P0.6 — Dashboard Step Cards~~ ✅ SHIPPED (ToolCards component + live/snapshotted + CSS + test)
2. ~~Hosted Skills Marketplace (P6d)~~ ✅ SHIPPED (server endpoints + AgentHub panel + CLI + tests)
3. ~~Skill Depth~~ ✅ SHIPPED (50 bundled skills, was 5)
4. ~~P6a /learn Skill Authoring~~ ✅ SHIPPED (learn action + buildLearnPrompt + draft system + preview card)
5. ~~Cross-Skill Bundles (P6b)~~ ✅ SHIPPED (bundle store + CLI + skill tool + tests)
6. ~~Toolset Enable/Disable UI~~ ✅ SHIPPED (AgentHub toolset grid + toggle switches + tests)

All gaps closed. See `UNIFIED_IMPROVEMENT_PLAN.md` for the full roadmap.

**CAPABILITY PARITY WITH HERMES (verified 2026-08-22):**

The real gap between agent-nuvira and Hermes was NOT the number of skills — it was the CAPABILITY to execute skills from the marketplace in any language. This is now SHIPPED:

- ✅ **Skill Execution Engine** (`src/skills/skill-executor.ts`) — Execute skills as scripts (Python, JS, shell)
- ✅ **Language Detection** — Auto-detect runtime from frontmatter, file extension, or heuristics
- ✅ **Env Passthrough** — API keys injected into skill execution with provider credential blocking
- ✅ **Skill Execute Action** (`src/tools/skill-tool.ts`) — `execute` action on the skill tool
- ✅ **Timeout & Output Capture** — Configurable timeout, max output size, stdout/stderr capture

**How it works:**
1. Skill declares `runtime: python` (or node/shell/auto) in frontmatter
2. Agent calls `skill tool → execute: { skill: "nanobanana", args: [...] }`
3. Executor detects runtime, creates temp script, spawns process with API keys injected
4. Returns structured result (stdout, stderr, exit code, duration)

**vs Hermes:** Same capability — Hermes uses `execute_code` sandbox + `env_passthrough`. We use `skill-executor.ts` + `registerEnvPassthrough`. Both achieve language-agnostic skill execution.

**Verification pass (2026-08-17, code-level re-analysis against acceptance
criteria — no rework required):**
- P0.1: `chat-console.ts` `askQuestion`(233)/`respond`(252) + server
  `POST /api/chat/:sessionId/respond`(server.ts:3700) + ChatPage question
  card (lines 74–77, 151, 231–249, 398) + round-trip test
  (`chat-console.test.ts:91`) ✅
- P0.2: `read_file`/`list_dir`/`glob` registered (registry.ts:543/552/561),
  deny-first `gateReal` symlink-escape refusal, binary sniff, 60KB/2000-line
  caps with truncation note, line numbering, `coding` toolset
  (toolsets.ts:84), TOOL_CONTRACT line 378 ✅
- P0.3: `edit_file`/`write_file` (registry.ts:570/579), confirm gate,
  ambiguity refusal, distinct not-found, `gateWrite` symlinked-parent
  escape guard, TOOL_CONTRACT line 379 ✅
- P0.4: `run_terminal` (registry.ts:588), three-class deny-first classifier
  (whole-string deny regexes incl. `$()` injection, positive verify
  allowlist, confirm default), sender-id masking, 6KB output cap,
  buff-command routing to run_cli, TOOL_CONTRACT line 380 ✅
- P0.5: gate wired BEFORE the dev bypass (chat.ts:236/239 — a question
  never dispatches, a coding ask in command position still does) and at the
  top of `runSingleGoal` (execute.ts:1593 — question → direct answer, the
  orchestrator never starts) + execute tests (1125/1140/1165) + dispatch
  tests (89/113) ✅
- P0.6: ✅ SHIPPED — ToolCards component (ChatPage.tsx:487) + live/snapshotted rendering + CSS (dashboard.css:3702) + test (verified 2026-08-21)
- P0.7: ✅ SHIPPED — plan-store.ts + registry.ts:664 (verified 2026-08-21)
- P0.8: ✅ SHIPPED — skill-tool.ts + registry.ts:865 (verified 2026-08-21)
- P3a: ✅ SHIPPED — clone-repo.ts + registry.ts:881 (verified 2026-08-21)
- P3b: ✅ SHIPPED — git-tool.ts + registry.ts:897 (verified 2026-08-21)
- P3c: ✅ SHIPPED — tool-loop.ts:TOOL_FALLBACK_HINTS (verified 2026-08-21)
- P3d: ✅ SHIPPED — tool-loop.ts:makeParallelSuggester (verified 2026-08-21)
- Full suites: typecheck clean · root **4,682 passed** (exact P0.5 baseline,
  zero regression) · dashboard **205 passed** · build clean ✅

**Integration trace (2026-08-17, is-this-siloed check):** the dashboard chat
path is NOT a separate engine — `chat-console.ts` runs ONE tool-loop turn
through `ChatCommand.answerOnce` (chat.ts:361), the same engine the CLI
uses. Verified chain: user message → `resolvePipelineDispatch` with the P0.5
`text` gate → `runChatAnswer` → `runToolLoop` (tool-loop.ts) with
`callModel` = `buildToolCallModel` (real providers, native `generateTools`
when supported, JSON fallback, auto-mode failover) and `executeTool` =
`getTool(name).run` — the REAL registry (read_file/edit_file/run_terminal/
ask_user all reachable), schema-gated by `effectiveToolJsonSchemas`
(toolset toggles). `onEvent` → `onProgress` → SSE `progress` lines →
ChatPage; ask_user questions render as choice cards (P0.1); followups
return as data → chips. The read→ask→edit→run→verify loop is ONE wired
path used by CLI and dashboard alike.

**Remaining depth gap vs Claude Code / Freebuff / Hermes (the honest
part):** the ENGINE loop is integrated, but the USER-VISIBLE experience
layer is still pending — that is exactly P0.6 (step cards: tool name/args/
status/result as cards, not plain lines), P3b (diff preview + accept/reject
per hunk — Claude Code's signature interaction), P0.7 (visible plan
checklist before edits), P0.8 + P5 (skill loading + depth batch), P3a
(clone_repo for other projects), P3c/P3d (deterministic fallback hints +
parallel suggestion — today fallback is model-strength-dependent). The
units work; the competitive UX depth is the unbuilt half.

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
- Never `git reset --hard` / `git clean` (deny list shared with run_terminal).
- `git push` is a real GATED action (added after the brief): it asks unless the
  user's own request named the push (`requestRequestsPush` — a local-only commit
  request does not count), while the raw `git push` SHELL string stays denied in
  run_terminal. The structured tool is the sanctioned path: allow-listed
  remote/branch passed as argv, so no option-injection or metacharacter travels.
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

---

## P6 — Skill onboarding: /learn, bundles, frontmatter depth, marketplace import

**Ask (user, 2026-08-17):** *"as per Copilot, Hermes can consume skills
developed by other developers — can't we allow our users to do that in
similar fashion and still keep our repo private? Build /learn from missing
and already-shipable skills, include them as part of the product, and make
agent-nuvira equally capable of importing marketplace skills. Add these to
DASHBOARD_FIRST_PLAN.md with full background, expected working, example, and
tests."*

**Ground truth — Hermes (cloned `NousResearch/hermes-agent` 2026-08-17):**

- `/learn` is a PROMPT, not an engine: `hermes_cli/cli_commands_mixin.py`
  `_handle_learn_command` builds `build_learn_prompt(user_request)`
  (`agent/learn_prompt.py`, 237 lines) and injects it onto the agent's input
  queue as a normal user turn. The live agent gathers the described sources
  (dirs/URLs/"what we just did") with its existing tools and authors the
  skill via `skill_manage`.
- `skill_manage` (`tools/skill_manager_tool.py`, 1,849 lines) actions:
  `create` / `edit` / `patch` / `delete` / `write_file` / `remove_file`;
  creates are validated (content required, frontmatter sane); `patch` needs
  `old_string`/`new_string`; reference files land under `references/`,
  `scripts/`, `templates/`.
- Skills Hub (`tools/skills_hub.py`, 4,621 lines): `SkillSource` ABC with
  `search`/`fetch`/`inspect`/`source_id`/`trust_level_for`; GitHub tap model
  (`GitHubSource.DEFAULT_TAPS`: openai/skills, anthropics/skills,
  huggingface/skills, NVIDIA/skills, garrytan/gstack) + `skills.sh` +
  agentskills.io open-standard compatibility; installs quarantine + write
  `lock.json` + append `audit.log`; `_ssrf_safe_http_get` guards URLs.
- Authoring standards live in the learn prompt: description ≤ 1 line, body
  section order (When to Use → Procedure → Pitfalls → Verification),
  copy-paste-exact commands, knowledge-base layout for large sources
  (lean SKILL.md index + per-chapter `references/`).

**Ground truth — agent-nuvira (code-verified 2026-08-17):**

- P0.8 `skill` tool (`src/tools/skill-tool.ts`): resolve by name/id from the
  compiled SkillStore OR the hub catalog (`<project>/.agents/skills/` +
  `~/.buff/skills/`), unknown → lists both, disabled → refused. Load-only
  today — no create/patch/write_file actions.
- SkillStore (`src/learning/skill-store.ts`): `save`/`get`/`getAll`/
  `search`/`findMatch`/`markUsed`/`delete` — the /learn write target exists;
  bundled skills seed idempotently (`seedBundledSkills`, edits preserved).
- Multi-source registry (`src/learning/skills-registry.ts`): github-raw /
  local-dir / browse-sh / git-repo (clones ANY repo, auto-detects
  `skills/`, `.claude/skills/`, `.agents/skills/` roots) — the marketplace
  import machinery is DONE, CLI-only (`buff skills search/install`).
- Install security (`src/learning/skills-hub.ts`): sandbox name validation,
  frontmatter sanity, SHA-256 checksum + provenance, quarantine on mismatch.
- Packaged default registry (P5c #3): ships `.agents/skills/` in the npm
  tarball, resolves from the install — the private repo is irrelevant.

**Acceptance (P6a–P6e, each independently shippable):**

### P6a — /learn-style skill authoring (headliner)

1. A `skill_manage` action on the P0.8 skill tool: `create` (full SKILL.md,
   frontmatter + body validated), `patch` (old/new string), `write_file`
   (reference file), `delete` (guarded, mirrors `buff skill gc` gating).
2. A learn-prompt builder (`src/learning/learn-prompt.ts` mirroring
   `agent/learn_prompt.py`): empty request → "the workflow we just went
   through"; otherwise the open-ended request verbatim + authoring standards
   (description ≤ 1 line, ordered steps w/ agent types + `dependsOn`,
   parameters, verification step — the BUNDLED-SKILL depth bar, not Hermes'
   prose bar).
3. Chat integration: the agent, on a "learn …" ask, gathers with existing
   tools, drafts, and calls `skill_manage` → the dashboard shows a preview
   card (✅ accept / ✏️ edit / ↩ reject) BEFORE the store write; accept
   persists via `SkillStore.save`, reject aborts (nothing written).

**Expected working (example):** user: "learn the S3 upload flow we just did"
→ step cards (gather transcript → draft) → preview card (`name: s3-upload`,
4 ordered steps, 2 params) → ✅ → `buff skill list` shows `s3-upload` → next
chat turn: "use the s3-upload skill" loads it via the P0.8 tool.

**Tests:** skill_manage unit (create rejects missing content / bad frontmatter
name; patch requires old_string; write_file path-validated to the skill dir),
learn-prompt builder unit (empty → conversation default; URL+constraints both
preserved), chat-loop integration (agent emits skill_manage → store contains
skill → skill tool loads it), dashboard preview-card test (accept saves, edit
re-drafts, reject writes nothing).

### P6b — skill bundles (cross-skill composition)

1. A bundle store (`~/.buff/skill-bundles/<slug>.yaml` — Hermes parity):
   `create`/`list`/`show`/`delete`, missing skill skipped not fatal.
2. A `bundle` action on the P0.8 skill tool (`load` returns every skill's
   methodology in one result) + a `buff skills bundle` CLI subcommand.

**Expected working (example):** "load my backend-dev bundle" → bundle
`backend-dev` = code-review + tdd + pr-workflow → one tool result with all
three methodologies → the agent runs the combined workflow.

**Tests:** bundle-store unit (create/list/delete, missing-skill skip),
skill-tool bundle-load test, CLI create→load round-trip.

### P6c — frontmatter depth in the hub catalog

Parse + honor Hermes-style fields the hub currently ignores: `platforms`
(hide on incompatible OS), `requires_toolsets` / `fallback_for_toolsets`
(conditional activation — reuse the P3c fallback-hint vocabulary),
declared `config` settings, `required_environment_variables` (surfaced as
"needs env X", value NEVER printed in chat).

**Expected working (example):** a skill with `platforms: [macos, linux]` is
absent from `skills_list` on win32; a skill with `requires_toolsets:
[terminal]` appears only when run_terminal is in the toolset.

**Tests:** catalog parser unit per field, platform-gate test (win32 hides
macos-only), conditional-activation test (visible iff toolset present),
env-var declaration surfaced without its value.

### P6d — marketplace import surface (private-repo-safe)

1. Thin server endpoints over the EXISTING multi-source registry:
   `GET /api/skills/marketplace?q=` (searchAllRegistries), `POST
   /api/skills/install` (installHubSkill → hub catalog), `POST
   /api/skills/uninstall`.
2. A dashboard Skills panel: bundled (🧠 provenance) + installed community
   skills, install/uninstall buttons, search box.
3. The repo stays PRIVATE — importing reads OTHER people's registries
   (browse.sh, any git-repo incl. `.claude/skills/`, github-raw). The
   packaged default registry (P5c #3) already serves first-party skills
   without GitHub.

**Expected working (example):** chat: "install the code-assist skill" →
agent: `buff skills install code-assist --source git-repo` (already works) →
result card "✅ installed v1.2.0 (quarantine checked)" → loads via the skill
tool next turn.

**Tests:** marketplace API tests (list from a local-dir fixture registry,
install lands SKILL.md + provenance, uninstall removes both), Skills panel
component test, end-to-end install→load-in-chat (mirrors the P5c #4
acceptance pattern: real CLI, hermetic BUFF_CONFIG_DIR/BUFF_SKILLS_REGISTRY).

### P6e — shipable first-party batch (include what's built)

The five bundled skills (P5b) become first-class product content: Skills
panel lists them with provenance, chat empty-state suggests them, /learn
results land alongside in `buff skill list`.

**Tests:** panel list test (5 bundled + community with badges), empty-state
suggestion test.

**Deep backward tests:** skills-hub / skills-registry / skill-tool suites
stay green (P6a adds tool actions — existing load tests unchanged; P6c
changes catalog parse — frontmatter tests extended, never weakened);
sync-drift guard (P5c #4) still passes.

**Matrix rows:** P5c #5 gaps 1–5 (learn, bundles, frontmatter depth,
marketplace presence, offer loop — closes the onboarding comparison).
