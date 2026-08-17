# Dashboard-First — One Chat Window as the Front Door

> **The decision (2026-08-16):** agent-nuvira's professional-assistant gap is a
> *front-door* gap, not an engine gap. The engines exist (chat loop, intent
> router, run_cli, orchestrator, gateway, memory). What's missing is ONE
> conversational window that hides all of it — the way Claude Code / Copilot /
> Cursor present a single window where the model decides everything.
>
> **This plan:** make the dashboard Chat the product's front door. Do NOT
> change the CLI engine — hardcore developers keep `buff` for scripting/CI;
> the dashboard becomes the surface where *nobody needs the CLI at all*.
>
> **Honest feasibility verdict: YES, achievable.** The work is ~95% frontend +
> a few thin server endpoints. The engine is already capable of everything
> the chat needs to *invoke* — the gap is presentation, streaming, artifacts,
> project context, and session continuity.

---

## 1. What the dashboard chat is today (audited 2026-08-16)

`src/web-dashboard/src/components/ChatPage.tsx` — 373 lines, one session, no markdown rendering:

| Capability | Today | Competitors (Claude Code / Copilot / Cursor) |
|---|---|---|
| One conversation window | ✅ `/chat` route | ✅ the whole product |
| Agent decides answer-vs-act | ✅ via tool loop + `run_cli` | ✅ via tool loop |
| Confirm cards for commands | ✅ ⚡ Run-this-command card (`chatResolve` pre-resolve) | ✅ |
| Ambiguous-ask choices | ✅ shows options | ✅ |
| Live progress steps | ✅ step list | ✅ streaming tokens |
| **Token streaming** | ❌ shows steps, then full answer at once | ✅ typewriter streaming |
| **Markdown / code blocks / syntax highlight** | ❌ plain `<div>{content}</div>` | ✅ full markdown + code + copy |
| **Inline artifacts** (plan / diff / deploy result as cards in the thread) | ❌ text only | ✅ tabs/cards per artifact |
| **Project directory awareness** | ❌ dashboard has no notion of the user's project | ✅ agent reads the cwd project |
| **Session history / resume** | ❌ one in-memory session, reset button | ✅ sidebar session list, resume any |
| **Auto memory recall per session** | ❌ | ✅ |
| **Tool-result rendering** (build output, test results, diffs as rich blocks) | ❌ steps as plain text | ✅ |
| **Chat = landing page** | ❌ `/` is Overview; chat is one of 12 routes | ✅ chat IS the app |

**The dashboard already has 12 rooms** (Overview, DAG, History, Costs, Benchmarks,
Memory, Models, Routing, Requests, Traces, Hub, Tasks, Chat) — the same "pick a
room" problem as the CLI, just prettier. The plan is to make **Chat the lobby**
and turn every other room into a **panel the chat can surface inline** or link to.

## 2. The target experience (one paragraph)

The user opens the dashboard → lands on Chat. They type: *"assess this project,
find the gaps vs our release checklist, fix the top three, and tell me when
it's done."* The agent: attaches the current project (auto-detected directory),
runs code-map + retrieval for context, produces a gap assessment **as a card**,
shows a **diff card** for each fix with accept/reject, runs the tests and shows
the result **inline**, and ends with a summary + followup chips. The user never
leaves the chat window. For *any* capability — gateway, memory, models, publish —
the same window works, because those are all just tools the agent can call.

## 3. Architecture (no CLI engine changes)

```
┌────────────────────────────── Dashboard (the product) ──────────────────────────────┐
│  ChatPage (the lobby)                                                                 │
│   ├─ streaming thread + markdown renderer                                             │
│   ├─ artifact cards (plan / diff / build / deploy / assessment)                       │
│   ├─ project context bar (directory, session, memory recall)                          │
│   └─ session sidebar (resume any past session)                                        │
└──────────────┬──────────────────────────────────────────────┬─────────────────────────┘
               │ /api/chat (exists)                            │ /api/tasks (exists)
               ▼                                                ▼
        chat engine (unchanged)                          task runner → spawns
        answerOnce + runToolLoop                         the REAL CLI (unchanged)
        + run_cli / intent router                        → RBAC-gated, masked output
               │
               ▼
     engine: gateway, orchestrator, memory,
     intent router, eval, publish — ALL UNCHANGED
```

**Everything the chat needs already has a server endpoint:**
- `/api/chat` (POST) — one agent turn (exists, `server.ts:3629`)
- `/api/chat/resolve` (POST) — pre-resolve to confirm cards (exists, `server.ts:3608`)
- `/api/chat/reset` (POST) — session reset (exists, `server.ts:3677`)
- `/api/tasks` (GET/POST) — run CLI commands as tasks, RBAC-gated (exists, `server.ts:3225/3236`)
- `/api/hub` (GET) — the full data surface (exists, `server.ts:2417`)

**The only NEW server work:**
1. `GET /api/chat/stream` (SSE) — token streaming instead of answer-at-once
2. `GET /api/projects` + `POST /api/projects/attach` — project directory picker (scan cwd + recent dirs)
3. `GET /api/sessions` + `GET /api/sessions/:id` — persisted session list for the sidebar
4. `POST /api/chat/artifact` — optional: structured artifact payloads (plan/diff blocks) alongside the text answer

## 4. The build plan (phased, each phase shippable)

### Phase 1 — Make the chat *feel* like a professional assistant (1–2 days)
The single highest-impact change: **the chat currently renders answers as raw
text** (`chat-bubble-text` = plain `<div>{m.content}</div>`). Everything else is
cosmetic until this is real.

- [x] Markdown renderer — a small dependency-free custom renderer
      (`src/web-dashboard/src/components/Markdown.tsx`, ~180 lines: headings, lists,
      bold/italic, inline code, links with href allowlist, tables, blockquotes, hr)
      — deliberately NO react-markdown (plan's risk table: "use a small renderer")
- [x] Code blocks with a language label + copy button (`⧉ Copy` → `✓ Copied`)
- [ ] Token streaming via SSE — LIVE progress already streams per-session
      (`/api/chat/:sessionId/events`: steps + tool cards + plan + diff); the final
      answer text still arrives at once via the POST (candidate: stream tokens of
      the final reply server-side)
- [x] Render tool *steps* as structured blocks — done earlier (P0.6 tool cards,
      P0.7 plan checklist, P3b diff card; live + snapshotted into the reply)
- [x] **Tests:** `Markdown.test.tsx` (10 cases incl. XSS href guard) + ChatPage
      markdown-rendering test

### Phase 2 — Artifacts: plans, diffs, and results as cards (2–3 days)
This is what makes it feel like Claude/Cursor rather than a terminal in a box.

- [ ] Detect structured blocks in the agent answer (plan → 📋 card, code change →
      diff card, build/test → result card, deploy → 🚀 card with URL)
- [ ] Diff card with per-file accept/reject (reuse the engine's edit module output —
      the CLI already produces structured edit results; surface them, don't re-implement)
- [ ] Inline command-run cards: the existing ⚡ Run-this-command card becomes a
      full execution card (command, live logs, exit code, output) in the thread
- [ ] **Tests:** artifact extraction + diff card interactions

### Phase 3 — Project context: "assess THIS project" (2–3 days)
The killer use case: the agent should understand the project the user is talking
about without being told how.

- [ ] Project attach bar: pick the working directory (server scans cwd + recent
      directories); the agent's system prompt gets the project path + file tree
- [ ] On attach, auto-run `code-map` + `retrieval` once and store the context
      (both already exist as CLI commands — the chat just calls them)
- [ ] "Assess this project" / "what's the state here" works from day one
- [ ] **Tests:** project attach flow + context injection

### Phase 4 — Sessions & memory: continuity (1–2 days)
"Leverage every past session for quick start on new assessment" — the user's ask.

- [ ] Session sidebar: list past sessions, click to resume (server persists
      session transcripts; `/api/sessions` + resume endpoint)
- [ ] On new session, auto-recall memory/facts for the attached project
      (the `session` + `memory` CLI commands already exist — wire their output in)
- [ ] **Tests:** session persistence + resume + memory recall injection

### Phase 5 — Chat as the front door (1–2 days)
- [x] `/` is Chat (the front door); Overview moved to `/overview`; the other rooms
      stay reachable as panels, never required
- [x] Empty-state onboarding chips: assess this project · run the tests · stop the
      gateway · publish the release — each sends its prompt through the normal
      flow (chatResolve → intent router → confirm card or agent)
- [x] **Tests:** onboarding-chip test (click → chatSend with the prompt)

### Phase 6 — Polish & hardening (ongoing)
- [ ] Streaming cancel, retry on failed turn, error surfaces (partial: exists)
- [ ] Followup chips kept clickable (the earlier bug the user reported)
- [x] Keyboard: Enter sends, Shift+Enter newline, ↑ recalls the last sent message
      (input → auto-growing textarea)
- [x] Full dashboard test suite green (**220** today, was 208) + new chat tests
      (markdown, onboarding, keyboard)

### Phase 7 — Skills as a product capability: onboarding, /learn, and marketplace import (3–4 days)

> **Why this phase exists (user ask, 2026-08-17):** *"Hermes can consume
> skills developed by other developers — can't we allow our users to do that
> in similar fashion and still keep our repo private? Let's build /learn from
> missing and already-shipable skills, include them as part of the product,
> and make agent-nuvira equally capable of importing marketplace skills."*
>
> Grounded in the REAL Hermes implementation (cloned `NousResearch/hermes-agent`
> 2026-08-17 — see `ASSESSMENT_CAPABILITY_GAPS.md` P5c #5 for the row-by-row
> comparison): `/learn` is NOT an engine — it builds a standards-guided prompt
> (`agent/learn_prompt.py`) and injects it as a normal user turn; the live
> agent gathers sources with its existing tools and authors the skill via
> `skill_manage` (actions: create / edit / patch / delete / write_file /
> remove_file). Marketplace import is the Skills Hub (`tools/skills_hub.py`):
> registry adapters (SkillSource ABC: search/fetch/inspect/source_id) with
> GitHub taps (openai/skills, anthropics/skills, huggingface/skills,
> NVIDIA/skills, garrytan/gstack), `skills.sh` + agentskills.io open-standard
> compatibility, install with quarantine + lock.json + audit log.
>
> agent-nuvira ALREADY has the machine room (all verified this session): the
> P0.8 `skill` tool (load-by-name from compiled store + hub catalog), the
> SkillStore (`save`/`get`/`search`/`findMatch`/`markUsed` — the /learn write
> target), the hub catalog (reads `<project>/.agents/skills/` SKILL.md),
> the multi-source registry (`skills-registry.ts`: github-raw / local-dir /
> browse-sh / git-repo with `.claude/skills/` auto-detection — the marketplace
> import path), and the packaged default registry (private-repo-independent).
> What's MISSING is the Hermes-equivalent ergonomics: an interactive /learn
> flow, a skill-authoring tool (create/patch/write_file), cross-skill bundles,
> richer frontmatter consumption, and an explicit marketplace install surface.

**The principle (mirrors Hermes, keeps the CLI untouched):** /learn is a
PROMPT, not a pipeline. The dashboard chat already has the agent + tools
(ask_user, read/list/glob/code_search, skill tool); the new work is (1) a
standards-guided authoring prompt + skill-authoring tool actions, (2) the
chat affordances ("Learn a skill" button → chat request, skills panel with
install/uninstall), and (3) thin server endpoints to list/install/uninstall
marketplace skills. The CLI engine stays exactly as it is.

- [ ] **P6a — /learn-style skill authoring (the headliner).** In chat, the
      user types "learn the workflow I just did" or "learn from
      https://docs.example.com/api/quickstart" — the agent gathers the source
      (transcript / URL / dir) with its existing tools, drafts a SKILL.md
      following the bundled-skill authoring standards (description ≤ 1 line,
      ordered steps with agent types + `dependsOn`, parameters, verification
      step), shows the user a preview card (✅ accept / ✏️ edit / ↩ reject),
      and saves it to the SkillStore via a new `skill_manage` action on the
      P0.8 tool (`create` / `patch` / `write_file` / `delete` — Hermes
      parity). **Background:** Hermes' `/learn` injects `build_learn_prompt()`
      as a normal turn; the agent authors via `skill_manage`. agent-nuvira
      already has the compiler (trajectory → Skill) and store; this phase
      adds the interactive, user-directed path.
      - **Expected working:** user: "learn the S3 upload flow we just did" →
        agent: step cards (gather transcript → draft skill → preview) →
        preview card with `name: s3-upload`, 4 ordered steps, 2 params →
        user: ✅ → `buff skill list` shows `s3-upload` → next chat turn the
        skill tool loads it by name.
      - **Tests:** authoring-tool unit (create validates frontmatter + name;
        patch applies to an existing SKILL.md; write_file adds a reference
        file), learn-prompt builder unit (empty request → "this conversation"
        default; request with URL+constraints keeps both), chat-loop
        integration (agent emits the skill_manage call → store contains the
        skill → `skill` tool loads it), dashboard preview-card test (accept
        saves, edit re-drafts, reject aborts).
- [ ] **P6b — skill bundles (cross-skill composition).** A `bundle` action on
      the skill tool + a `buff skills bundle` CLI: group N skills under one
      id (`backend-dev` → code-review + tdd + pr-workflow), load all in one
      chat turn. **Background:** Hermes YAML bundles (`~/.hermes/skill-bundles/
      <slug>.yaml`) let one slash command load several skills; agent-nuvira
      only chains steps WITHIN a skill (dependsOn). This is the composition
      gap from the comparison.
      - **Expected working:** user: "load my backend-dev bundle" → agent:
        skill tool `bundle:load(backend-dev)` → returns the three skills'
        methodology in one result → agent executes the combined workflow.
      - **Tests:** bundle-store unit (create/list/delete, missing skill
        skipped not fatal — Hermes parity), skill-tool bundle-load test,
        CLI `buff skills bundle` create→load round-trip.
- [ ] **P6c — frontmatter depth in the hub catalog.** Parse + honor the
      Hermes-style fields agent-nuvira currently ignores: `platforms`
      (hide on incompatible OS — the user runs macOS/Windows/Linux),
      `requires_toolsets`/`fallback_for_toolsets` (conditional activation —
      ties into the existing P3c tool-fallback chain), declared `config`
      settings, and `required_environment_variables` (secure setup on load,
      never in chat). **Background:** the comparison flagged "thinner
      frontmatter consumption" as a real gap; Hermes' conditional activation
      (`duckduckgo-search` shows only when `web` toolset is absent) is the
      pattern.
      - **Expected working:** a hub skill with `platforms: [macos, linux]`
        is absent from `skills_list` on Windows; a skill with
        `requires_toolsets: [terminal]` only appears when run_terminal is in
        the toolset.
      - **Tests:** catalog parser unit (each field parsed), platform-gate
        test (win32 hides macos-only skill), conditional-activation test
        (skill visible iff toolset present), env-var declaration surfaced in
        the skill tool result (value NEVER printed).
- [ ] **P6d — marketplace import surface (the private-repo-safe path).** A
      dashboard Skills panel + thin endpoints that list/install/uninstall
      skills from the EXISTING multi-source registry (browse.sh, any
      git-repo incl. `.claude/skills/`, github-raw URLs) — the user picks a
      community skill and it lands in `<project>/.agents/skills/` (hub
      catalog) OR the SkillStore, checksum-verified + quarantined on
      mismatch (already implemented in `skills-hub.ts`). The repo stays
      private — importing reads OTHER people's registries. **Background:**
      Hermes' Skills Hub (SkillSource adapters + taps: openai/skills,
      anthropics/skills, huggingface/skills, NVIDIA/skills) is the reference;
      agent-nuvira already has the adapters (`skills-registry.ts`) but only
      via CLI (`buff skills install`). This phase surfaces them in the
      dashboard chat.
      - **Expected working:** chat: "install the nvidia-skills code-assist
        skill" → agent: `buff skills install code-assist --source git-repo`
        (already works today) → result card "✅ installed v1.2.0 (quarantine
        checked)" → the skill appears in the hub catalog and loads via the
        skill tool next turn.
      - **Tests:** marketplace API tests (list from a local-dir fixture
        registry, install lands SKILL.md + provenance, uninstall removes
        both), dashboard Skills panel component test, end-to-end
        install→load-in-chat test (mirrors the P5c #4 acceptance pattern).
- [ ] **P6e — shipable first-party skill batch (already built, include it).**
      The five bundled skills (website-deploy, code-assessment,
      technical-roadmap, plan-create-track, test-strategy) are DONE + verified
      (P5b). Include them as first-class product content: the Skills panel
      lists them with provenance (bundled vs community), the chat empty-state
      suggests them ("try: load the code-assessment skill"), and `/learn`
      results land alongside them in `buff skill list`.
      - **Expected working:** new user opens dashboard → Skills panel shows
        the 5 bundled skills with 🧠 bundled badge → clicks code-assessment →
        the chat loads it via the skill tool and runs the assessment.
      - **Tests:** panel list test (5 bundled + any community, provenance
        badges), empty-state suggestion test.

**Phase 7 principle check — no CLI engine changes:** every item above either
(1) adds a tool action / prompt (P6a, P6b, P6c), (2) adds thin server
endpoints + a panel (P6d, P6e), or (3) reuses existing CLI commands via the
chat (`buff skills install` already works). The engine, orchestrator, and
CLI surface stay exactly as they are — consistent with the plan's north star.

**Total: ~2–3 focused weeks for Phases 1–5 + ~3–4 days for Phase 7, each phase shippable independently.**

## 5. What we deliberately do NOT do

- **No CLI engine changes** — `buff chat/execute/plan/...` stay exactly as they
  are. The dashboard calls the same engine through `/api/chat` and the same CLI
  through `/api/tasks`. (One exception allowed: if streaming needs an engine hook,
  add an opt-in flag — but the tool loop already returns per-step results, so
  streaming can be built purely server-side.)
- **No new rooms** — the plan *reduces* surface area. Every new capability is a
  tool the chat can call, not a new page. (Phase 7's Skills panel is a PANEL
  surfaced by the chat, not a 13th room — same rule as Memory/Models.)
- **No throwing away the 12 rooms** — they become panels the chat links to.
- **No skill-authoring pipeline** — /learn is a prompt + tool actions (P6a),
  exactly like Hermes; there is no separate ingestion engine to build or
  maintain.

## 6. Honest risks & mitigations

| Risk | Mitigation |
|---|---|
| Streaming adds server complexity | SSE is thin; keep the non-streaming POST as fallback |
| Markdown lib adds bundle weight | Use a small renderer; verify what's already bundled first |
| "12 rooms" become dead weight | Keep them as linked panels; chat surfaces them contextually |
| Chat quality depends on model | Same engine as CLI — no regression; confirm cards make commands deterministic |
| Session persistence privacy | Store transcripts in the existing `~/.buff` memory dir, same as CLI history |
| /learn drafts vary with model quality | The preview card (accept/edit/reject) is the gate — a bad draft is rejected, never saved silently; authoring standards in the prompt (Hermes parity) narrow variance |
| Community skills could be hostile | Already mitigated: installs are sandboxed (name ^[a-z0-9-]+$), checksum-verified, quarantined on mismatch (`skills-hub.ts`); marketplace skills load through the same hub catalog |

## 7. The north-star check

After Phases 1–5 (+ Phase 7), this must be true:

> A new user opens the dashboard and does everything in ONE window — attach the
> project, ask for an assessment, watch the agent plan, review diffs inline,
> confirm the fixes, see tests pass, get followups, learn a workflow as a skill,
> and install a community skill from the marketplace — without ever touching
> the CLI, without choosing a mode, without knowing a single `buff` command.
> The CLI remains for scripting and CI, exactly like `gh` is to the GitHub web UI.
