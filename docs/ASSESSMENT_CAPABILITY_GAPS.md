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
