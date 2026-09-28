# Agent-Nuvira Major Revamp — Sequential Project Plan

**Scope:** close the real-execution + capability gap vs Freebuff / Hermes, revalidate Copilot's
recommendations, leverage existing libraries instead of reinventing the wheel, and close the
17 capability gaps catalogued in §1.6 (tool-calling loop, sub-agents, web/browser/image/voice/
vision, gateway, cron, skills hub) using OSS/free tools only — no paid SaaS as a hard dependency.
Phases A–J close the capability gaps; **Phases K–N** (added later) harden the result for
enterprise use and commercialization: observability + security (K), skills lifecycle (L),
testing/CI (M), and governance (N).
**Understanding-first principle (Session 7c):** request understanding is the product — the user's
experience of working and delivering against a request — NOT a cost center. Every dispatch is
verified by a model (router-cheap call) before a pipeline runs; cost is managed via prompt
caching + cheap-model discipline, never by skipping understanding. This supersedes the earlier
zero-cost framing of Phase C (see Part 1.8).
**Basis:** agent-nuvira v1.61.x (3,512 tests) + cloned references (`/tmp/freebuff-src`,
`/tmp/hermes-src`, `/tmp/mem0-src`) + 2026 ecosystem research.
**Supersedes:** `MEMORY_NLU_PROJECT_PLAN.md` (deleted — had criss-cross dependencies).

---

## ⚠️ STANDING RULE — cross-command parity (READ FIRST, applies to EVERY phase)

**Every capability this plan adds must be validated AND upgraded across ALL action commands —
never chat-only.** A row is NOT done if its behavior works in `nuvira chat` but is missing from
execute/plan/edit/run. This is a hard gate on every `✅ Done` in the tracker.

**Why:** the agent has many entry points that perform work. In the past, capabilities have landed
in `chat.ts` only (e.g. the dev-mode menu prompt lives ONLY in chat.ts today; C1's NLU rules are
currently un-wired by design until C3). If each phase ships chat-only, execute/plan/edit/run
diverge from chat and the user-facing experience degrades exactly as it did before.

**The action-command set (every command that can perform work with a goal/prompt):**

| Command | Performs work with | Current routing/menu state (v1.61.x) |
|---|---|---|
| `nuvira chat` | interactive + single-shot | auto-routing ✅ · dev-mode menu (must be removed in E3) |
| `nuvira execute` | goal → pipeline | auto-routing ✅ (buildAutoResolveOptions) |
| `nuvira plan` | goal → plan | auto-routing ✅ |
| `nuvira edit` | goal → edit | auto-routing ✅ |
| `nuvira run` | goal/script → run | auto-routing via orchestrator ✅ |
| `nuvira ci` | CI workflow | uses orchestrator (useMemory) |
| `nuvira workflow` | template workflow | uses orchestrator (useMemory) |
| `nuvira eval` | eval suite | auto-routing ✅ (buildAutoResolveOptions) |
| `nuvira benchmark` | benchmark suite | auto-routing ✅ |
| `nuvira models` | refresh/status/spot-check | router-adjacent (models commands) |
| `nuvira agent` | single agent run | auto-routing via orchestrator ✅ |

**The gate, applied to EVERY phase:**
1. When implementing a phase, identify every command in the action-command set that reaches the
   code path the phase changes (NLU dispatch, memory injection, live board, tool loop, failover,
   shell events, etc.).
2. Upgrade ALL of them — not just `chat.ts`. If a behavior is shared (e.g. orchestrator-level
   memory injection), one shared choke point is ideal; if it is entry-point-specific (e.g. the
   dev-mode menu), each entry point must be brought to parity.
3. Tests must cover at least one non-chat action command per affected phase — e.g. an NLU
   dispatch test that runs the SAME prompt through chat-equivalent and execute-equivalent paths.
4. The tracker row's "Done when" column must list the non-chat commands it was validated on.

**Example (Phase C, this session):** C1 built `src/nlu/intent.ts` as a pure module (no entry
point — correct, C3 wires it). C3 MUST wire the parser into chat AND execute AND plan AND edit
AND run — one `ParsedRequest` consumed everywhere, never a chat-only dispatch. E3 then kills the
chat-only dev-mode menu so every command shares the same intent-first dispatch.

---

## Part 0 — Leverage survey (adopt, don't reinvent)

Agent-Nuvira runs on **5 runtime deps** (chalk, commander, inquirer, ora, typescript). The
ecosystem provides maintained, battle-tested replacements for the hand-rolled pieces:

| Capability needed | Today (hand-rolled) | Leverage (verified 2026) | Why |
|---|---|---|---|
| OS keychain / secret vault | plaintext keys in `nuviraconfig.json` | **`@napi-rs/keyring`** | keytar is **archived**; napi-rs ships **prebuilt binaries** (no node-gyp), used by Azure identity SDK |
| SQLite persistence | JSON files (history, cache, trajectories) | **`node:sqlite`** (built-in, `DatabaseSync`) | production-ready since Node ~25.7/26; zero deps, no native build; STRICT tables. ⚠️ needs engines bump to ≥22.5 (or JSON fallback tier on older Node) |
| TUI live activity board | hand-rolled ANSI board (`pipeline-board.ts`) | **`ink`** (React for CLIs) | the standard behind Claude Code / Gemini CLI / Copilot CLI; Yoga (WASM) flexbox layout, `useInput`, live re-render — no node-gyp build |
| Shell/process execution | raw `child_process`/`execSync` | **`execa`** | standard for programmatic CLI spawn; no-shell-by-default (safer), streams, abort, rich errors |
| Code search in projects | `grep`/manual | **`ripgrep` binary** (bundled per-platform, or `$PATH`) | Claude Code / Cursor / Aider all bundle `rg`; 5–300× faster; respects `.gitignore` |
| MCP client | hand-rolled `src/mcp/client.ts` | **`@modelcontextprotocol/sdk`** (official TS SDK) | actively maintained by Anthropic; stdio + Streamable HTTP transports |
| Temporal/unit parsing ("last week", "2 days ago") | keyword regex in chat.ts | **`@microsoft/recognizers-text-datetime`** (MIT, TS-native) | **validated as real + MIT + maintained** (see §1.5) — rule-based Date/Time/Number/Unit parsing, no Python, no model call; this is the genuinely useful slice of Copilot's "NLP stack" |
| NLU rule fast-path | keyword regex in chat.ts | **`wink-nlp`** or **`compromise`** (MIT, pure JS) | fast deterministic pre-filtering (dates, file paths, numbers) *before* any LLM call — **NOT spaCy** (see §1.5) |
| spaCy / JointBERT | (not used today) | **❌ REJECTED** — see §1.5 | claimed by Copilot to be the Freebuff/Hermes backbone; **verified FALSE** against the clones; Python-bound, no TS binding, JointBERT is actually Apache-2.0 + unmaintained |
| LLM structured extraction | JSON try-parse (failure-lessons) | **Vercel AI SDK `tool()`/zod** — **optional only** | agent already has 17 provider adapters; adopt only the tool-schema/validation slice, not the transport (avoid a rewrite) |
| Memory backend (optional) | FAISS vector store (exists) | **`mem0ai`** OSS/TS SDK — **opt-in backend** | cross-machine/enterprise memory; never a hard dep |
| Token-aware compaction | `context-pruner.ts` (deterministic) | Freebuff `compact-history.ts` **pattern** (not a lib) | mechanical compaction without a model call |
| Multi-agent memory shape | trajectory/pattern/failure stores | Hermes `MemoryProvider` **pattern** (not a lib) | pluggable provider lifecycle |
| Structured logging | hand-rolled `utils/logger.ts` (has `scrub()`) | **pino** (optional) — or extend the existing logger | JSON lines + correlation IDs (sessionId/projectId); pino is the Node standard, but the existing `scrub()` must be preserved either way (Phase K1) |
| Schema validation | ad-hoc JSON try-parse | **zod** (already adopted for H1) | validate every tool schema before dispatch — invalid definitions BLOCK, never silently coerce (Phase M3) |

**Decision rules:** adopt libraries that are *maintained, prebuilt, and standard*; keep the
zero-native-dependency philosophy by making native deps (keyring, ink is pure JS, node:sqlite is
built-in) optional tiers with graceful fallback. **Do NOT** adopt a full agent framework
(LangChain/Vercel loop) — agent-nuvira's multi-agent pipeline + 17-adapter router is a strength;
borrow only focused libraries.

---

## Part 1 — Revalidated Copilot recommendations

| Copilot recommendation | Verdict after revalidation | Revised position |
|---|---|---|
| 1. "Freebuff-style local persistence for credentials/workspace" | ✅ **Correct direction, better tools available** | Adopt Phase A (vault + workspace state) using `@napi-rs/keyring` + `node:sqlite` — stronger than Copilot's vague "YAML/JSON files" |
| 2. "Integrate Mem0 for semantic memory" | ⚠️ **Half-right, wrong default** | Fact/preference memory built on the **existing FAISS store** (Phase B); Mem0 as an **opt-in backend** (Phase F). Mem0 is a pluggable provider, not a dependency |
| 3. "NLP pipeline — spaCy (MIT) as backbone, JointBERT, Recognizers-Text, Ruflo" | ❌ **Factually wrong about Freebuff/Hermes; one genuinely valid piece** | Copilot's claim that Freebuff + Hermes use spaCy is **falsified by the actual repos** (§1.5). Corrected: adopt the **real** Freebuff/Hermes methodology — **LLM-native tool-call dispatch in a single loop** — plus the **valid** MIT/TS pieces: `@microsoft/recognizers-text-datetime` (temporal parsing) and `wink-nlp`/`compromise` (rule fast-path). Reject spaCy (no TS binding, Python sidecar), JointBERT (Apache-2.0, unmaintained, PyTorch-1.6-era), Ruflo (real but a whole orchestration paradigm, not an NLP lib — see §1.5). Phase C now carries detailed implementation execution expectations. |

**New gaps Copilot missed (added to this plan):**
- Shell/process visibility (`execa`) and a live TUI board (`ink`) — the user's #1 execution complaint
- Intent-first UX — kill the mode menus; one conversational surface with internal dispatch
- Agent-driven recall — no manual `nuvira session/eval/models` commands
- Standard MCP SDK adoption and `ripgrep` code search
- SQLite consolidation of JSON file stores

---

## Part 1.5 — Copilot's spaCy claim: validated against the clones (evidence)

Copilot asserted: *"Hermes Agent uses spaCy + HuggingFace Transformers for intent/entity parsing…
Freebuff leverages spaCy for entity extraction… Primary NLP Backbone: spaCy (MIT)".*
**This is not true.** Verified directly against the cloned repos and the 2026 ecosystem:

| Claim | Verdict | Evidence |
|---|---|---|
| "Freebuff uses spaCy" | ❌ **FALSE** | Freebuff is a **TypeScript/Bun** monorepo — it cannot run Python spaCy in-process. `packages/agent-runtime/package.json` deps = `gpt-tokenizer`, `zod-from-json-schema`, `lodash`; root deps = `canvas`, `gif-encoder-2`, `zod`. `grep -rniE 'spacy\|compromise\|wink-nlp\|natural'` over `.ts`/`.json` returns **zero library refs** — the only "natural" hits are the English word inside prompt strings (e.g. `agents/base-chat.ts:47` "natural next questions", `agents/types/tools.ts:148` "natural language description"). Freebuff does **LLM-native tool dispatch** in a single agent loop (`packages/agent-runtime/src/run-agent-step.ts`, `prompt-agent-stream.ts`); "mode" is an internal agent template chosen by cost (`main-prompt.ts:93`), never a user-facing NLP layer. |
| "Hermes uses spaCy + HF Transformers" | ❌ **FALSE** | `grep -rniE 'spacy' /tmp/hermes-src` over `.py/.toml/.txt` → **0 matches**. `pyproject.toml` core deps: `openai`, `pydantic`, `httpx`, `tenacity`, `prompt_toolkit`, `rich`, `psutil`, `fire`, `pyyaml`, `fastapi`, `uvicorn`, `websockets` — no spaCy, no transformers. Hermes understands requests via **LLM-native tool-calling**: `tools/registry.py` collects JSON schemas for 70+ tools exposed to the model's `tool_calls` interface (`transports/chat_completions.py`), with retries/fallbacks in `conversation_loop.py`. |
| spaCy is a viable Node/TS backbone | ❌ **No production TS binding** | spaCy is Cython/Python-bound; 2026 has no maintained native/WASM Node binding. The only pattern is a Python sidecar (REST/socket) — a new heavyweight runtime dependency that violates agent-nuvira's zero-native-dep design and the 17-provider no-cost ethos. The observed pattern across major TS coding agents (Claude Code, Cursor, Gemini CLI — per their public tooling/docs) is LLM tool-calling + regex + AST, not an external NLP library. |
| JointBERT (MIT) | ❌ **License + maintenance wrong** | Actually **Apache-2.0** (per `LICENSE` in `monologg/JointBERT`), **unmaintained** (PyTorch 1.6 / Transformers v3 era), needs ~400MB BERT weights, GPU/CPU inference — wholly impractical inside a Node CLI. |
| Recognizers-Text (MIT) | ✅ **VALID — adopt** | Microsoft `@microsoft/recognizers-text-*` on npm (DateTime, Number, Unit); MIT; maintained (slower cadence but stable); rule-based, TS-native, zero Python. Fills exactly the temporal-parsing gap ("continue **last week's** plan"). |
| Ruflo (MIT) | ⚠️ **Real but different paradigm** | `ruvnet/ruflo` exists, MIT, actively maintained — but it is an **agent meta-harness/orchestration engine** (swarm topologies, AgentDB vector memory, SONA self-learning, federation), not an NLP library. Adopting it is an architecture decision, not a library add; out of scope for this revamp (agent-nuvira already has its own multi-agent pipeline + router). |

**Bottom line:** Copilot's specific tooling recommendation is a plausible-sounding **hallucination** —
but its underlying direction (deep request understanding) is right, and the *correct* way to
achieve it is exactly what Freebuff and Hermes actually do: **single conversational loop +
LLM-native tool-call dispatch**, with a thin deterministic fast-path (`recognizers-text-datetime`
for time refs, `wink-nlp`/`compromise` for the rule layer). Phase C implements that methodology
and Phase E3 exposes it through the unified chat surface.

---

## Part 1.6 — Capability gap analysis: agent-nuvira vs Freebuff vs Hermes (evidence-based)

A full inventory of the three codebases was taken (`ls`/`grep` over `/tmp/freebuff-src`,
`/tmp/hermes-src`, and agent-nuvira `src/`). The matrix below lists **every material capability**
Freebuff or Hermes ships that agent-nuvira does not, the evidence, and the **open-source / free
solution** that closes it (per the constraint: no paid SaaS as a hard dependency, so end users pay
nothing).

| # | Capability | Freebuff | Hermes | Agent-Nuvira today (evidence) | Verdict | OSS/free fix → Phase |
|---|---|---|---|---|---|---|
| 1 | **Native LLM tool-calling loop** | `tool-executor.ts` + `tool-stream-parser.ts`; dozens of tools | `tool_executor.py`, `tools/registry.py`: **70+ tools across 28 toolsets** exposed to native `tool_calls` | **None.** `grep -E 'toolCall|tool_calls|function call' src/agents/agents/*.ts` = 0 hits; agents are prompt+JSON-parse only | 🔴 MAJOR | `src/agents/tools/registry.ts` — zod tool schemas + native tool-call adapter for providers that support it, JSON fallback for the rest → **H1** |
| 2 | **Sub-agent spawning + live delegation log** | `spawn_agents` (basher, code-searcher, researcher-web, browser-use…) parallel sub-agents | `delegate_tool.py`, `async_delegation.py`, `subagent_lifecycle.py`, `delegation_live_log.py` | Only **A2A federation** `delegateTask` (machine-to-machine). No in-process sub-agent spawn registry, no live delegation log | 🔴 MAJOR | Internal sub-agent registry over the existing orchestrator + `delegation:spawn/result` events on the EventBus → **H2** |
| 3 | **Web research** | `researcher-web.ts`, `researcher-docs.ts` | `web_search_registry.py`, `x_search_tool.py` | **None.** No web-search tool, no fetch-based research agent | 🔴 MAJOR | Free-tier search (DuckDuckGo HTML, SearXNG self-host, Jina Reader free tier) + `fetch` tool reusing the existing router → **I1** |
| 4 | **Browser automation** | `browser-use` agent | `browser_tool.py`, `browser_cdp_tool.py`, `computer_use/` | **None.** `grep browser\|playwright` = only dashboard-restart/dashboard files (unrelated) | 🔴 MAJOR | **Playwright** (MIT, `npm i playwright` + bundled browsers) as an optional tool → **I2** |
| 5 | **Image generation** | image output via canvas/gif-encoder | `image_gen_registry.py`, `image_generation_tool.py`, `flux3_video_tool.py` | **None.** `sandbox/images.ts` is container images, not generation | 🟠 MEDIUM | Local **ComfyUI / Stable Diffusion** via API, or free image APIs (Pollinations.ai, Groq vision-free tiers) → **I3** |
| 6 | **Voice: TTS + transcription** | — | `tts_registry.py`, `tts_tool.py`, `transcription_registry.py`, `voice_mode.py`, `wake_word.py` | **None** | 🟠 MEDIUM | **edge-tts** (free, local) or Piper TTS + **whisper.cpp** / faster-whisper → **I4** |
| 7 | **Vision / multimodal input** | — | `vision_tools.py` | **None.** Adapters are text-only | 🟠 MEDIUM | Local **llava/llama3.2-vision via Ollama** or free Gemini vision tier, exposed as a tool → **I5** |
| 8 | **Multi-channel gateway (Telegram/Discord/Slack/WhatsApp/Weixin)** | — | `gateway/` (Telegram, Discord, WhatsApp Cloud, Slack, Weixin), `channel_directory.py` | **None.** Only CLI + web-dashboard + A2A | 🟠 MEDIUM | **grammY** (Telegram, MIT), **discord.js** (MIT), **@slack/web-api** (MIT), WhatsApp via **Meta WhatsApp Cloud API** free tier (avoid unofficial reverse-engineered wrappers — ToS risk) — all free bot APIs, no server cost → **J1** |
| 9 | **Cron / scheduled jobs** | — | `cron/jobs.py`, `cronjob_tools.py` | **None.** `workflow/registry.ts` is template-only | 🟠 MEDIUM | **node-cron** (MIT) → **J2** |
| 10 | **Skills marketplace / hub / sync** | `.agents/skills` + `npx skills` install flow | `skills_hub.py`, `skills_tool.py`, `skill_manager_tool.py`, `skills_sync_client.py` | Partial: `skill.ts` CLI + `skill-store.ts` + `skill-runner.ts` exist, but **no hub listing, no sync, no provenance** | 🟡 LOW-MED | Reuse the existing skill store; add `nuvira skills search/install/update` + provenance metadata (mirrors Hermes `skills_sync`) → **J3** |
| 11 | **Code map / real AST (tree-sitter)** | `code-map` package (tree-sitter, 6 languages) | `lsp/` integration | `editing/ast.ts` is **regex-based** with a `TODO: Replace with web-tree-sitter WASM` | 🟡 LOW-MED | **web-tree-sitter** WASM (MIT, no native build) → fold into **F2** | ✅ **code-map LANDED (Session 47)** — `nuvira code-map [dir] [--json]` via the existing AST engine (engine-agnostic); tree-sitter remains the engine-upgrade follow-up |
| 12 | **MCP server + OAuth** | `mcp.ts` (client) | `mcp_oauth_manager.py`, `hermes_tools_mcp_server.py`, `mcp_serve.py` | Hand-rolled MCP **client only**; no MCP server, no OAuth | 🟡 LOW-MED | Official `@modelcontextprotocol/sdk` (F2) + expose agent tools via MCP server; OAuth via `open` + PKCE → **F2 + H1** |
| 13 | **Provider prompt caching** | — | `prompt_caching.py` | `reasoning-cache.ts` caches router decisions, not provider prompt prefixes | 🟡 LOW | Provider-native prompt-cache headers (free on most providers) wired into adapters → **H1** |
| 14 | **Turn/session finalization (summaries, titles, session search)** | `compact-history.ts` (mechanical) | `turn_finalizer.py`, `turn_summary.py`, `title_generator.py`, `session_search_tool.py` | `history.ts` stores raw turns only; no per-turn summary/title; no temporal session search (planned in D1) | 🟡 LOW | Extend D1's `searchSessions` + add LLM-free title/summary generation (regex+topics) → **D1** |
| 15 | **Self-learning graph + insights** | `buffbench` evals | `learning_graph.py`, `learning_mutations.py`, `insights.py`, `background_review.py` | `self-improver.ts` + `pattern-extractor.ts` + `failure-lessons.ts` + `router-bandit` — learning exists, but no **visual graph / insights dashboard** | 🟢 OK w/ gap | Dashboard learning-graph view over existing stores → **G2** |
| 16 | **Desktop/TUI app** | website + web UI | `apps/desktop`, `ui-tui/`, `tui_gateway/` | `web-dashboard` (React) exists | 🟢 OK | Ink TUI (E2) + existing dashboard; desktop app out of scope |
| 17 | **i18n / locales** | — | `i18n.py`, `locales/` | **None** | 🟢 OK w/ gap | Not planned (docs are English); revisit post-revamp |

**Ranking used:** 🔴 MAJOR (blocks parity) → 🟠 MEDIUM (visible capability gap) → 🟡 LOW (polish) →
🟢 OK (already covered). **Constraint honored throughout:** every fix is OSS/MIT or free-tier;
no paid SaaS is a required dependency. The new phases below (H, I, J) close items 1–10;
items 11–14 fold into existing phases as noted.

---

## Part 1.7 — Understanding machinery: verified mechanism depth (clone code, not library names)

Deep read of both clones' request-understanding PATH — the mechanism by which a natural-language
request becomes action (all verified against /tmp/freebuff-src and /tmp/hermes-src on this
machine). Neither engine has an "NLU layer"; understanding IS the LLM tool-calling loop, with the
depth living in: tool schemas, the loop's end/retry semantics, and context assembly.

| Mechanism | Freebuff (verified) | Hermes (verified) | Agent-Nuvira must have (phase) |
|---|---|---|---|
| Understanding locus | The model itself: `systemPrompt` + tool schemas + native tool-calling (`run-agent-step.ts` → `prompt-agent-stream.ts`); NO classifier | Same: registry schemas + `tool_calls` loop (`run_agent.py`, `conversation_loop.py`); NO classifier | Rules fast-path + LLM verify (C1–C3 ✅) driving a model loop (E3) |
| Agent / mode selection | `main-prompt.ts:93` CostMode → AgentTemplateType (`ask→ask`, `free/lite→base_free`, `normal→base`, `max→base_max`) — internal pick, never a user menu | `system_prompt.py` builds session prompt in 3 ordered cache tiers | Never a user-facing mode picker (E3) |
| Tool surface | ~40 zod-schema tools (`handlers/tool/*`, `ensureZodSchema`, `toJSONSchema`) | 97 tools: `registry.register(schema, handler, toolset, check_fn, dynamic_schema_overrides)` | H1 registry from C3 action descriptors |
| Loop semantics | `run-agent-step.ts`: stream → `stream-xml-parser` → typed tool calls → execute → results fed back → next step, until `task_completed`/`end_turn`; `isThinkOnly` continues; tool errors force a retry step | `conversation_loop.py`: "model call, tool dispatch, retries, fallbacks" per turn until completion | E3 loop with identical end/retry semantics |
| Clarification | `ask-user` tool | `tools/clarify_tool.py` — structured MCQs / open prompts in-loop (arrow-key CLI) | E3 `ask_user` tool (REPLACES the pre-dispatch menu) |
| Context depth | Per-agent `systemPrompt` + tool defs | `prompt_builder.py`: identity + AGENTS.md/.cursorrules/SOUL.md + skills index, each scanned by `scan_for_threats` (injection/promptware/C2/role-play hijack) with `[BLOCKED …]` replacement | E3 context-file assembly + threat scan |
| Stream robustness | `tool-stream-parser.ts` XML/JSON parse + `processToolCallObject` JSON repair; `MAX_CONSECUTIVE_STREAM_RECOVERIES` | `message_sanitization._repair_tool_call_arguments`, surrogate/non-ASCII sanitize | H1 executor (repair + bounded error text like `_bound_error_text`) |

**Verdict (recorded 2026-08-09):** agent-nuvira's hybrid — deterministic rules + LLM verify +
action map — has NO equal in either clone (they pay an LLM call for EVERY dispatch decision; we
resolve the common cases in <5ms at zero cost). The parity gap is not the classifier; it is the
LOOP (E3, next after C3) + the SURFACE (H1) + the three depth items now specified in E3
(clarify-as-tool, end-turn semantics, context-file understanding + injection scanning).

---

## Part 1.8 — Request-understanding quality: Freebuff/Hermes vs our cost-first hybrid (evidence)

**Trigger (2026-08-09, Session 7c):** user rejected the "zero-cost" framing of Phase C — *"I
disagree with the way NLP is implemented in agent-nuvira just to achieve zero cost… I want NLP to
be better or at least equally effective as Freebuff and Hermes. Don't search only repo names —
deep dive into the technical code and understand how these two agents are leveraging NLP and
processing user requests **with follow-up recommendations**. The end-user experience of working
and delivering against a request is the main differentiator — never break with useless or
half-understood requirements."* This section records the code-level findings (not library names)
and the resulting design change.

### How Freebuff processes a request (verified code)

- **Understanding is 100% the model.** `agents/base-chat.ts` is a `SecretAgentDefinition`:
  `systemPrompt` (identity) + a large `instructionsPrompt` (the behavioral contract: when to
  spawn `researcher-web`, when to spawn a thinker, `gravity_index` discipline, and the
  **followup contract**: *"End every response by calling the suggest_followups tool with exactly
  3 followups the user is likely to want next — natural next questions, deeper dives, or related
  directions that build on what you just said. Make them specific to this conversation, not
  generic."*) + `toolNames` + `spawnableAgents` + a `handleSteps` generator that prunes context
  before every step. **There is no classifier anywhere in the repo.**
- **The loop** (`run-agent-step.ts`): stream → `stream-parser` → typed tool calls → execute →
  results fed back → next step, until `task_completed`/`end_turn`; `isThinkOnly` continues;
  `hadToolCallError` forces a retry step; `requiresExplicitCompletion` for write-intent tools;
  `filterUnfinishedToolCalls` guards strict providers.
- **Follow-up recommendations = a native tool** (`common/src/tools/params/tool/suggest-followups.ts`):
  zod schema `{ followups: [{ prompt, label? }][] }`, `endsAgentStep=false`, and a full guidance
  description (3 suggestions; alternatives / related features / cleanup / tests / next-step;
  never "commit these changes"; persist + clicked state). The CLI renders them as **clickable
  cards** (`cli/src/components/tools/suggest-followups.tsx`: hover, clicked state, width-aware
  truncation); a click sends the prompt as the next user message. It is part of the model's
  output contract, not a post-hoc CLI heuristic.
- **Clarification = `ask_user` tool** (`common/src/tools/params/tool/ask-user.ts`), called by the
  model in-loop.
- **Cost is managed by caching, not by skipping calls**: 3-tier system-prompt prompt caching,
  context-budgeted pruning, cheap default models. Mode is internal
  (`main-prompt.ts:93` CostMode → AgentTemplateType) — never a user menu.

### How Hermes processes a request (verified code)

- `agent/conversation_loop.py` (7,596 lines) — per-turn prologue (`build_turn_context`):
  credential refresh from .env edits, system-prompt restore-or-build **with caching**, preflight
  compression, memory prefetch, user-message sanitization, crash-resilient persistence; then the
  loop: model call → tool dispatch → retries/fallbacks until completion, bounded by
  `max_iterations` + `iteration_budget`. Tool-call arguments are canonicalized
  (`_canonicalize_tool_call_arguments`), error text is bounded, continuations get a
  `_get_continuation_prompt`, and prompt-cache headers are decorated per provider.
- Understanding = model + `tools/registry.py` (70–97 tool schemas). No classifier.
- **Clarification = `tools/clarify_tool.py`**: question + up to 4 choices + `multi_select` +
  auto-appended "Other"; platform renders it (arrow-key CLI / Discord buttons / Telegram
  numbered list); schema-validated with dict-choice normalization (`_flatten_choice`).
- **Hermes has no Freebuff-style end-of-turn followup tool** — its continuity is clarify +
  turn summaries/titles + memory. The follow-up-recommendation experience the user wants is
  specifically the Freebuff pattern, and it is a Freebuff differentiator.

### Where our cost-first hybrid fell short (verified code)

- `shouldAutoDispatch` (src/nlu/actions.ts) gates ONLY create; every other intent
  (fix/continue/explain/configure) auto-dispatches on **rule** confidence ≥0.8 with NO model
  confirmation — `parseRequestSync` is the hot path in chat/execute/plan/edit. A rule misread
  therefore runs the pipeline: the exact "half-understood requirement" failure mode.
- `chat.ts` has **zero** follow-up suggestions. `execute.ts` has a post-execution inquirer menu
  ("What next?") with LLM-generated followups + a **keyword-matched rule fallback**
  ("add JSDoc if .ts files changed") — generic, not contextual, and CLI-side only.
- Ambiguity resolves via the pre-dispatch `promptDeveloperMode` inquirer menu, not an in-loop
  clarify tool.

### Design change (applied to C2 / E3 / H1)

**Understanding is the product; cost is a second-order concern.** Rules stay as a pre-filter and
offline fallback, but **every request is verified by a model before any pipeline runs**, and the
verify schema gains `requirementState` + `missingInfo` so a partial understanding never dispatches
— it triggers the in-loop `ask_user` tool (Hermes clarify parity) instead. Follow-up
recommendations become a first-class `suggest_followups` tool (Freebuff parity) in the H1
registry, rendered clickable in chat/execute/plan. Cost discipline = one cheap-model call per
request + prompt-cache headers, which is dwarfed by the cost of a wrong execution.

---

## Part 1.9 — Honest competitive verdict: would a developer choose us? (Session 7d)

**Question asked (2026-08-09):** "Are we certain our plan offers better UX and better execution
than Freebuff/Hermes on deep technical capability — or is it coverup? When a developer uses all
three, will they choose us for ease of doing + better results + fewer failures/stuck states?"

**Honest verdict — three parts:**

1. **Today: no.** Head-to-head TODAY we lose on capability breadth and polish — no tool-calling
   loop, no web/browser, no follow-ups in chat, menu-based dispatch, no clarify-as-tool, no
   gateway/cron. A developer comparing today picks Freebuff or Hermes. Claiming otherwise would
   be coverup.
2. **Parity-by-borrowing is the coverup risk.** Most of Phases E/H/I/J mirror their mechanisms —
   that buys parity, not switching. The plan only beats them if the parts THEY lack are built
   first and **measured**.
3. **Where we have evidence-backed genuine edges (verified code, not claims):**
   - **Execution recovery / anti-stuck (already built).** ErrorRepairEngine (580 lines) +
     VerifyModule (386) + RecoverModule (353) + FailureLessons memory (501) + SafeExecutionLayer
     (478) + per-task model escalation, wired into the orchestrator. Freebuff: stream-parser +
     HTTP retry only — no post-execution verify, no failure memory, no repair engine. Hermes:
     API-error classification + adaptive backoff + failover + a verification hook — turn-level
     only, no failure-lessons memory, no repair pipeline. "Less stuck / less rework after a
     failure" is exactly our machinery, and neither clone has the full stack.
   - **Anti-half-understanding (planned: C2/E3).** `requirementState` gate + clarify-as-tool —
     neither clone gates dispatch on understanding completeness; they trust the model alone.
   - **Availability (already built).** 17-provider router with failover/fallback chain + quota
     ledger + offline rule classification — a dead provider degrades us to the next candidate;
     it stalls them.
   - **Reliability (already built).** Zero native deps, 3,687 tests, OS-independent execution.
   **The missing piece is measurement.** Neither we nor they publish success rates. Without
   running the SAME task set through all three CLIs and scoring completion / stuck states /
   rework turns / time-to-done, "better" is an assertion — exactly the coverup the question
   fears. Fix: **row 35 (M2b) — black-box experience-parity benchmark vs Freebuff + Hermes.**

**Decision rule for every row (anti-coverup):** a phase's acceptance criteria must move a
benchmark metric (completion ↑, stuck ↓, rework ↓, time-to-done ↓), not just pass unit tests. A
row that only adds capability breadth without touching an experience metric is deferred behind
the differentiators (E3 loop, H1 tools, C2 gate, follow-ups, repair surfacing).

---

## Part 1.10 — NLP strategy decision: adopt vs new vs continue (Session 7e)

**Question asked (2026-08-09):** "For NLP handling, should we adopt Hermes/Freebuff's concept,
explore something new/revolutionary to enhance UX, or continue with our current updated plan?"

**Decision: their mechanism as the backbone + our rules as pre-filter (already decided in 7c) +
ONE genuinely new layer — the Request Contract — and continue the updated plan. The new layer is
the honest answer to "what's new"; it is small, measured, and replaces nothing that is built.**

**Why NOT pure adoption (drop the rules):** pure model-native understanding makes us equal to
Freebuff/Hermes at best — and equal is losing. It also throws away C1–C3 (built, tested): rules
give offline fallback, <5ms common-case resolution, and a cheaper verify prompt. Their
architecture is the floor we must stand on, not the ceiling we aim at.

**Why NOT a from-scratch "revolutionary" rewrite:** unproven, expensive, and unmeasurable without
the M2b benchmark — the coverup-risk in reverse. The genuinely underexploited space is not
"another classifier" (neither clone has one) but making the understanding **visible, elicited,
and verifiable** — a contract both the user and the verify step can check. Neither Freebuff nor
Hermes does this.

**The Request Contract (the new layer — folded into C2/E3):**
1. **Contract, not classification.** The mandatory verify call returns
   `requestContract = { goal, target, scope, constraints, acceptanceCriteria[], riskFlags[],
   requirementState }` — a machine-checkable statement of what "done" means, not just an intent
   label. (Upgrade of the 7c requirementState field.)
2. **Elicitation loop (up to N rounds).** When acceptanceCriteria is empty or any field is
   low-confidence, the model calls clarify-as-tool with **self-proposed interpretations** ("I
   think you mean X (1), or Y (2), or edit (3)") — Hermes clarify's ≤4-choice shape, but
   model-authored. Each answer re-runs the cheap verify. No pipeline runs on an incomplete
   contract (anti-half-understanding, 7c).
3. **Understand-card (intent transparency).** Before any pipeline runs, EVERY action command
   shows a live card: "🧠 Understood: fix failing login test in src/auth/login.ts · scope: tests
   green · criteria: [1..n] · [run] [edit] [clarify]". Fast-accept default when the contract is
   complete and confidence high (auto-dispatch preserved); the card is an accept/correct
   affordance, never a blocking wizard. This is the user-visible differentiator: the request is
   SEEN before it is run — the "best experience of working against the request" the user asked
   for.
4. **Spec→verify feedback.** acceptanceCriteria feed the existing VerifyModule at pipeline end —
   "done" = criteria met (measured), not agent-declared done. This is the hook the M2b benchmark
   scores, and it closes the loop between understanding and execution.
5. **Difficulty cascade.** The cheap router model builds the contract; on low self-confidence or
   riskFlags it escalates the verify to a stronger router-selected model (the router already
   exists) — cost stays low where possible, correctness guaranteed where it matters.

**Risk + mitigation:** the loop can add a clarify round when the model is unsure → fast-accept
card default keeps the common case at one keystroke; M2b measures whether the contract actually
moves completion ↑ / rework ↓ before we invest further in it.

**Bottom line:** continue with the updated plan — 7c's direction stands. C2 absorbs the contract
+ elicitation loop + cascade; E3 absorbs the understand-card + spec→verify. This is "their
concept, our rules, our contract" — and the contract layer is the differentiator, not a coverup.

## Part 1.11 — LangChain/LangGraph + RAG assessment: adopt vs stay bespoke (Session 10)

**Question:** should we leverage LangChain/LangGraph ("they help agents perform better")? Do
Freebuff/Hermes use any RAG?

**Evidence (verified in the clones, this session):**
- Freenuvira runtime deps: `canvas`, `gif-encoder-2`, `zod` (+ agent-runtime: `gpt-tokenizer`,
  `zod-from-json-schema`, `lodash`). **No LangChain/LangGraph, no RAG stack** — no embedding or
  vector store anywhere in the runtime.
- Hermes deps: Anthropic SDK, exa, firecrawl, parallel-web, fal, edge-tts, modal, daytona,
  vercel, hindsight + optional **third-party memory backends** (`honcho-ai`, `supermemory`,
  `mem0`). **No LangChain/LangGraph.** RAG is delegated to hosted memory services — external,
  optional, not built-in.
- Ours: no LangChain/LangGraph (only a comment mention in A2A federation types). We already run
  a **bespoke RAG stack**: `embedder.ts` (bge-small-en-v1.5, 384-dim) + `vector-store.ts` (pure-JS
  cosine) + optional `faiss-backend` + `fact-store` + `trajectory-store` + `retrieval.ts`
  (chunk→embed→retrieve→assemble) + `reasoning-cache` + `context-pruner`.
- The LangGraph claim, per its own docs + industry consensus: it adds **orchestration ergonomics**
  — graph state machines, durable checkpointing, human-in-the-loop breakpoints, tool-routing
  middleware, streaming, memory abstractions, RAG connectors. Documented drawbacks: boilerplate,
  hidden API calls/billing surprises, rigidity of pre-drawn graphs, state-serialization bloat.
  The consensus for single-agent interactive coding is to SKIP the framework (Claude Code & co.
  run on plain lightweight harnesses) and use LangGraph only for multi-agent orchestration /
  deterministic business logic / audit trails.

**Assessment — decision: NO to LangChain/LangGraph; keep the bespoke stack.**
1. **The claim doesn't move our metrics.** LangGraph is ergonomics, not capability. The M2b axes
   (completion / stuck / rework / time-to-done) move via understanding gates (C2/E3), follow-ups,
   repair+verify (built), recall (D1) — none of which need a graph framework.
2. **Everything it offers, we already have, bespoke:** checkpoint-store (durable resume),
   phase-engine + pipeline (deterministic control flow), ErrorRepairEngine + VerifyModule +
   failure-lessons (failure handling), clarify-as-tool + understand-card (HITL), retrieval.ts
   (RAG), context-pruner (compaction), auto-router (tool/provider routing).
3. **Adopting it would violate our positioning:** a heavy dep tree against our 7-dependency,
   zero-native-deps footprint; an orchestrator rewrite; and the hidden-API-call/billing downside
   is literally the thing our cost-tracker + quota-ledger exist to prevent.
4. **It's not even a parity question** — neither competitor uses it. The RAG parity question
   resolves in our favor: Freebuff has none, Hermes delegates to hosted services, we have a
   stronger local, free, failure-lesson-integrated one.
5. **Re-evaluate ONLY if** we build multi-agent federation beyond A2A (swarms, complex team
   topologies) — that is the one use case LangGraph genuinely targets. Not today; note in the
   tracker as a revisit trigger.

**Bottom line:** continue with the current plan. E1 (execa shell modernization) is still the next
core row; no new dependency is introduced by this decision.

---

## Part 2 — Sequential implementation plan

Each phase is a **small, independently shippable unit** with concrete files, acceptance criteria,
and tests. Phases are ordered so each depends only on earlier phases (no criss-cross).

**Every phase carries an `Implementation reference` block.** This is the *reasoning transfer*
insurance: at execution time only this document will be available (not this analysis session), so
each block records **how the inspiration source (Freebuff/Hermes) implements the same thing** —
with the actual reference file paths under `/tmp/freebuff-src` and `/tmp/hermes-src`, the key
symbols/signatures to mirror, and the **expected outcome** (what "done" looks like). If the clones
are unavailable during implementation, the block still names the file + pattern to study. These
blocks are implementation expectations, not optional reading — phases are NOT done until the
mirrored pattern is demonstrably in place.

### Phase A — Foundation: Secret Vault + Workspace State (A1, A2)

**A1. Secret vault (`src/enterprise/vault.ts`)**
- Leverage: `@napi-rs/keyring` (prebuilt binaries, zero node-gyp).
- Implementation:
  - Tier 1: keyring (`getPassword`/`setPassword`/`deletePassword`) — macOS Keychain, Windows
    Credential Manager, Linux Secret Service.
  - Tier 2 (fallback if keyring unavailable): AES-256-GCM encrypted file `~/.nuvira/vault.enc`
    (0600 perms), key derived from a user master passphrase (in-memory for the session). Node
    built-in `crypto` only.
  - `ConfigManager` key read/write routes through `Vault`; `nuviraconfig.json` stores only vault IDs.
- Migration: `nuvira config migrate-keys` one-shot move of existing plaintext keys.
- Dead-key interplay: the ISSUE-004 `removeDeadApiKey` path also purges the vault entry.
- Tests: `tests/enterprise/vault.test.ts` (round-trip, masked read-back, fallback tier, delete).
- Acceptance: no key-shaped plaintext in config/logs; `nuvira doctor` shows vault tier.

**A2. Workspace state + project registry (`src/config/workspace.ts`)**
- Leverage: `node:sqlite` (`DatabaseSync`) — replaces JSON state files for workspaces.
- Implementation: `~/.nuvira/workspaces.db` with `projects(id, git_repo, cwd_hash, prefs,
  last_session_id, last_run_at, last_goal, run_summary)`; STRICT tables; WAL.
- Loaded at startup by `ConfigManager`; written on session end + run completion.
- Tests: `tests/config/workspace.test.ts` (create/load/update, projectId derivation, corruption
  tolerance).
- Acceptance: `nuvira doctor` shows workspace DB + current project; project switch is instant.

**Implementation reference (A1 vault):** Hermes `agent/credential_persistence.py` +
`credential_pool.py` + `credential_sources/` — credential storage is **provider-swappable**
(keychain / file / env sources) behind one persistence layer, so the vault never hard-binds to one
backend; `agent/secret_scope.py` + `secret_sources/` scope secrets per project/app. Expected
outcome: a `Vault` whose read/write API is source-agnostic (keyring = one source, AES file =
another) and testable without touching the real keychain — see Hermes `credential_persistence.py`
for the source-interface shape to mirror.

**Implementation reference (A2 workspace):** Freebuff stores session state as typed
`ProjectFileContext` (`packages/agent-runtime/src/run-agent-step.ts`) that is loaded per step;
Hermes persists per-project state under `~/.hermes` with a schema (`hermes_state_schema.py`) and
migration helpers (`hermes_state_portability.py`). Expected outcome: `workspaces.db` is the only
place project continuity is read from; a corrupt DB file degrades to a fresh workspace instead
of crashing (see Hermes `hermes_state.py` for the corruption-tolerance pattern to mirror).

### Phase B — Memory Intelligence: Facts + Provider Abstraction (B1, B2)

**B1. Fact & preference memory (`src/memory/fact-store.ts`)**
- Reuse: existing `embed()` + `vector-store.ts` (FAISS) — no new dep.
- Implementation: `addFacts(projectId, facts[])` → embed + insert with metadata
  `{ kind:'fact', projectId, agentRole, timestamp, tags, source }`; `extractFactsFromTurn(...)`
  via one LLM JSON call (router-selected cheap model) with rule fallback; `retrieveFacts(projectId,
  query, k, timeRange?)` with metadata filter (the temporal-filter gap); dedupe by cosine;
  per-project budget + 180-day expiry.
- Tests: `tests/memory/fact-store.test.ts`.
- Acceptance: `nuvira memory facts list --project <id>` works; new session retrieves facts.

**B2. MemoryProvider abstraction + MemoryManager (`src/memory/provider.ts`, `src/memory/manager.ts`)**
- Reuse: Hermes `MemoryProvider` lifecycle shape (prefetch / sync_turn / on_session_end).
- Implementation: `MemoryProvider` interface; `LocalMemoryProvider` over trajectory-store +
  fact-store + history; `MemoryManager` builds the "persistent memory" context block injected into
  planner/chat prompts (via existing `retrieveMemoryContext`) and calls `onSessionEnd`.
- Integration: `src/memory/memory-integration.ts`, `src/cli/chat.ts`, `src/agents/orchestrator.ts`.
- Tests: `tests/memory/manager.test.ts`.
- Acceptance: planner prompt contains persistent-memory block; session-end extraction runs.

**Implementation reference:** Hermes `agent/memory_provider.py` defines the exact lifecycle to
mirror — `MemoryProvider` ABC with `name()`, `is_available()`, `initialize(session_id)`, a
`system_prompt_block()` for static context, `prefetch(query, session_id)` for background recall
before each turn, `sync_turn(user, asst)` for async write after each turn, and `on_session_end()`
for end-of-session extraction; `agent/memory_manager.py` injects provider tools and scrubs
context (`StreamingContextScrubber`). Expected outcome: `LocalMemoryProvider` (B2) exposes the
same five lifecycle hooks and `MemoryManager` calls them at the same points in the chat/planner
loop; a trivial-prompt gate (Hermes `is_trivial_prompt`) skips prefetch on short messages.

### Phase C — NLU Intent & Entity Layer (C1, C2, C3) — **mirrors the real Freebuff/Hermes methodology**

**Design source (not invented):** this phase reproduces, in TypeScript, the exact request-
understanding mechanism Freebuff and Hermes ship in production:

1. **Single loop, LLM-native tool dispatch** (Hermes `conversation_loop.py` + `tools/registry.py`;
   Freebuff `run-agent-step.ts`): the *model* emits a structured action (intent + entities) via
   tool-call / JSON schema semantics — there is **no separate user-facing NLP mode picker** and no
   heavyweight classifier.
2. **Understanding-first (re-scoped Session 7c): rules pre-filter, model ALWAYS verifies**
   (supersedes the earlier zero-cost framing — see Part 1.8): rules + `recognizers-text-datetime`
   + `wink-nlp`/`compromise` resolve the common cases in <5ms and narrow the verify prompt; the
   router-selected cheap model confirms intent + extracts entities + judges requirement
   completeness on EVERY request. Cost is managed by prompt caching + cheap-model discipline,
   never by skipping understanding.
3. **Every intent resolves to an action descriptor consumed by the same orchestrator** — chat,
   execute, plan, edit, and the router share one `ParsedRequest` (single source of truth), exactly
   like Hermes' tool registry feeding every transport.

**C1. Rule fast-path (`src/nlu/intent.ts`)**
- Leverage: **`@microsoft/recognizers-text-datetime`** (temporal refs: "last week", "yesterday",
  "2 days ago") — this alone covers the headline "continue last week's plan" case. Optional, only
  for file-path/number disambiguation: `wink-nlp` or `compromise` (light POS/phrase hints). All
  MIT, pure JS, no Python, no model call.
- Implementation: `classifyIntent(text)` → `{ intent, confidence, modeHint, timeRange? }`
  deterministically (create/build → dev; continue/resume → recall + `timeRange` from
  recognizers; fix/debug → execute; explain → chat; configure → config).
- **Execution expectation:** must return in <5ms with zero network; every rule is a pure function
  with a unit test; unknown inputs return `confidence: 0` (NOT a guess) so C2 takes over.
- Tests: `tests/nlu/intent.test.ts` (rule matrix incl. "continue last week's ecommerce plan").

**C2. Mandatory verification + entity extraction (`src/nlu/entities.ts`) — UNDERSTANDING-FIRST (re-scoped Session 7c)**
- Implementation: ONE structured JSON call (router-selected cheap model) on EVERY request before
  dispatch — no more "LLM only below threshold". Rules are the pre-filter: `classifyIntent` +
  deterministic entities narrow the candidates and shape the verify prompt (a smaller, cheaper
  call), and are the fallback ONLY when no model is available (offline mode). The verify
  response is `{ intent, confidence, entities, memoryHint, requirementState, missingInfo[] }` —
  schema validation with try-parse (mirrors failure-lessons); any failure → rule result + log.
- **`requestContract` replaces the bare label (Session 7e — the new layer):** the verify
  response becomes `{ goal, target, scope, constraints, acceptanceCriteria[], riskFlags[],
  requirementState }` — a machine-checkable statement of what "done" means. `requirementState`
  ('complete' | 'needs-clarification') is the anti-half-understanding gate: a pipeline NEVER runs
  on a partial contract (see C3 acceptance f + E3 clarify-as-tool).
- **Elicitation loop (up to N rounds):** empty acceptanceCriteria or low-confidence fields →
  clarify-as-tool with model-proposed interpretations ("X (1), Y (2), or edit (3)"); each answer
  re-runs the cheap verify. **Difficulty cascade:** cheap router model builds the contract; on
  low self-confidence / riskFlags the verify escalates to a stronger router-selected model.
- Entities: project (git slug / cwd), file paths, temporal refs, framework/keywords.
- **Execution expectation (mirrors Hermes tool schema discipline):** the JSON schema for the
  extraction call is declared once (`src/nlu/schema.ts`, zod + JSON schema) and reused by every
  adapter that supports structured output — no per-prompt hack-parsing; provider fallback: if the
  call fails (router fallback chain), return the rule result and log the miss.
- **Cost discipline (NOT zero-cost):** one cheap-model call per request (fractions of a cent) is
  dwarfed by the cost of a wrong execution; the verify prompt is small (rules narrow candidates),
  the assembled system prompt is prompt-cache-decorated (H1), and no second call is made on the
  fast path.
- Tests: `tests/nlu/entities.test.ts` (garbage tolerance, fallback, schema validation,
  requirementState + missingInfo contract).

**C3. Unified parser + action map (`src/nlu/parser.ts`, `src/nlu/actions.ts`)**
- Implementation: `parseRequest(text, callLLM)` → `ParsedRequest { intent, entities, action, mode,
  memoryHint, sourceHint }`; declarative intent→action map consumed by chat, execute, plan, edit
  AND the router task-type (single source of truth for "which pipeline runs").
- **Execution expectation (mirrors Freebuff's internal cost-mode template selection, never a user
  menu):** `action` is a tool descriptor `{ name, inputSchema, run }` in the same shape Freebuff's
  tool definitions and Hermes' `tools/registry.py` entries use — so the orchestrator pipeline
  (plan/execute/edit) is invocable both from the chat loop (Phase E3 pipeline-as-tool) and from
  native tool-calling providers, with zero re-implementation.
- CLI: `nuvira nlu debug "<query>"` for explainability (shows rule vs LLM path, confidence,
  entities, resolved action).
- Tests: `tests/nlu/actions.test.ts`.
- **Methodology-conformance acceptance (makes "adopted their methodology" verifiable):** (a) when
  rule or LLM confidence ≥ threshold, **no user-facing mode/menu is ever reached** — the parser
  output drives dispatch directly (Freebuff/Hermes single-loop); (b) the `ParsedRequest.action`
  descriptor is byte-identical to the tool schema handed to native tool-calling providers — one
  schema, two consumption paths, zero re-implementation; (c) the single dispatch loop (rules →
  LLM  verify → action run) is covered by a test asserting the menu is unreachable for the five
  canonical prompts; (d) latency budget: rule pre-filter <5ms, mandatory verify ≤1 call per
  request (cheap model + prompt-cache headers); **(f) REQUIREMENT-COMPLETENESS (Session 7c):**
  `parseRequest` returns `requirementState` — a test asserts a `needs-clarification` request
  NEVER reaches a pipeline and resolves via the in-loop `ask_user` tool (E3) instead; **(e)
  STANDING RULE — cross-command parity: the parser output drives dispatch in
  chat AND execute AND plan AND edit AND run — a parity test runs the same five canonical prompts
  through each action command's dispatch and asserts identical intent→action resolution. The
  `ParsedRequest` is consumed by every action command, never a chat-only branch.**

**Implementation reference:** Freebuff `agents/base-chat.ts` shows the real shape to copy — a
single `base-chat` agent whose *only* decision is which tool to call next; Freebuff `run-agent-step.ts`
handles the loop (`getAgentStreamFromTemplate` → `buildAgentToolSet` → `processStream`) and
`main-prompt.ts:114` maps `CostMode → AgentTemplateType` so "mode" is an internal model/agent
template pick, never a user menu. Hermes `agent/conversation_loop.py` is the same idea in Python:
"model call, tool dispatch, retries, fallbacks" per turn. Expected outcome: the C3 parser output
is consumed as a tool call in the chat loop (not a mode branch), and the action map keys match
what the loop's tool dispatcher accepts — so intent resolution and tool dispatch share one
vocabulary. Freebuff `agents/basher.ts` + `file-picker.ts` show the generator-step style
(`yield { toolName, params }`) that a TS tool registry can mirror for sub-agent tools (H2).

### Phase D — Agent-Driven Recall & Continuity (D1, D2)

**D1. Auto-recall (`src/context/session-recall.ts`)**
- Implementation: `autoRecall(projectId)` — workspace (A2) → vault unlock (A1) → checkpoint-store
  snapshot → `ContextVault.fromSnapshot()` rehydrate → facts + history merge → board shows
  "📦 Recalled project 'shop' — 4 sessions, 12 facts, resumed step 3/8" → ONE confirmation.
- Rule trigger first ("continue"/"resume"/"pick up where"/temporal refs); Phase C upgrades it via
  `memoryHint`.
- **Temporal-aware session search** (carried from the original requirement): `searchSessions(
  { projectId?, timeRange?, query? })` in `src/context/history.ts` with a deterministic time-range
  parser ("last week"/"yesterday"/"last month", no LLM for the common cases) + `projectId`
  metadata on session indexing — this is the exact "continue **last week's** plan" flow.
- Tests: `tests/context/session-recall.test.ts`, `tests/context/history.test.ts` (temporal
  parsing, project-scoped search).
- Acceptance: `continue` in a fresh chat on a project with prior work resumes with zero manual
  commands — **AND the same `continue`/`resume` goal works from `nuvira execute`, `nuvira plan`, and
  `nuvira run` (auto-recall is invoked from the shared dispatch, not a chat-only hook).**

**Implementation reference:** Freebuff `packages/agent-runtime/src/compact-history.ts` is the
mechanical-compaction model (no model call): history is rewritten into a condensed
`<conversation_summary>` message preserving every file read/edited, command run, and user message
(USER_MESSAGE_LIMIT 13k, ASSISTANT 1.3k, TOOL_ENTRY 5k, ~20k budget); a parity test
(`context-pruner-parity.test.ts`) keeps the pruner agent and the runtime in sync. Hermes
`agent/session_activity.py` + `title_generator.py` (see those files for the per-session
summary/title pattern). Expected outcome: the D1 recall card shows a summary built the same
mechanical way (facts + files + commands + last goal), and `searchSessions` returns session
summaries + titles rather than raw turns.

**D2. Auto-run background duties (`src/cli/` integration)** — ✅ **Done (Session 9)**
- Implementation: `nuvira eval`, `nuvira models refresh/status`, `nuvira doctor` become opportunistic
  background tasks (idle / session start) surfacing a one-line result — the agent does them, not
  the user. Display via logger first; board lanes for these duties land with E2.
  **Landed subset:** one-line health (provider/vault/workspace counts) + models status
  (blocked/ok from `getModelRegistry().getStatus()`), throttled to once per 12h per config dir,
  best-effort, silent under `--json-events`; `src/cli/duties.ts`, wired into chat / execute /
  plan / run session starts. **Deferred:** `nuvira eval` auto-run is heavy → lands with the E2
  board lanes, not session start.
- Acceptance: a fresh session shows one-line health/model status without user action — **from
  every entry point that starts a session (chat, execute, plan, run), via the shared
  session-start path, not a chat-only hook.** (met)

### Phase E — Execution Experience: Live Activity + Intent-First UX (E1, E2, E3)

**E1. Shell execution modernization (`src/utils/shell.ts`)** — ✅ Done (Session 11)
- Leverage: `execa@^8` (node floor `>=18.18`; pure-JS, zero native — consistent with
  Decision #10 focused-job borrowing).
- Landed: `runShell` (async; events, streaming `onChunk`, `timeoutMs`, `signal` abort,
  `emitEvents:false` silent mode) + `runShellSync`; `EXEC_SHELL_START`/`EXEC_SHELL_END`
  events + LoggerConsumer "$ cmd" lanes; never-throw contract (exit code returned).
- Migrated execution-path sites (6): `task-execution-pipeline.ts` stepTest (the plan's
  named site), `execute-module.ts`, `test-module.ts` (install + test), `runner.ts`
  (executeOnHost + install + commandExists), `tester.ts`, `sandbox/manager.ts`
  `execHostCommand`.
- **Deferred (documented):** git/credential plumbing sites (credential-store,
  branch-automation, git-agent, etc.) + `sandbox spawnDockerExec` keep raw
  child_process — adopted incrementally; they are internal plumbing, not user-visible
  command lanes. `2>&1` merged-stderr commands now capture stdout/stderr separately
  (joined downstream).
- Tests: `tests/utils/shell-run.test.ts` (14: success, non-zero exit, stderr, timeout,
  abort, streaming, event emission, silent mode, sync parity).
- Acceptance: every user-visible subprocess is a live "$ npm test" lane via
  `exec:shell-start/end` — consumed by E2's board next.
- Extra: fixed a pre-existing test-isolation gap in `auto-router.test.ts`
  (`resolveModel` describe read the ambient `~/.nuvira` registry — ambient telemetry
  flipped a deterministic pin test; now isolated like sibling describes).

**E2. Live activity board v2 (`src/cli/pipeline-board.tsx` rewrite)** — ✅ Done (Session 13)
- Leverage: `ink`@^5 + `react`@^18 (React for CLIs; Claude Code / Gemini CLI standard) — FULL
  rewrite per user decision (plan's Leverage line honored; the hand-rolled ANSI board was
  replaced, not extended).
- Landed: TUI with parallel lanes, per-agent thought trail (board-side heartbeats: per-lane
  elapsed clock + 500ms pulsing dot — no agent changes), **shell lanes (E1)** from
  `exec:shell-start/end`, **inline retry lanes** from the ALREADY-EMITTED `recover:classified /
  attempt / model-switch / budget-exhausted / result` events (they ran silently before — no new
  emissions needed; payloads already carry taskId), **ETA** (avg completed-task duration ×
  remaining), keyboard control (j/k/arrows, space, e/h, q via ink `useInput`), and an NDJSON
  extension to PipelineEventStream (shell/recover lines).
- Architecture: class keeps the drop-in API (`start/stop/finish/freeze`, spinner interface,
  keyboard methods); ink `BoardView` renders via `useSyncExternalStore` over a version counter;
  unmount on stop/finish/freeze (no process-exit blocking; stdin restored by ink); non-TTY
  falls back to sequential log lines (CI-safe, incl. shell/recovery lines).
- **Entry-point coverage (STANDING RULE): mounted in EVERY action command — chat, execute, plan
  (replaces the bare ora spinner + emits inspection/agent-update events), run (was silent), ci
  (board → stderr; stdout stays pure machine JSON), workflow run, eval, benchmark (progress via
  AGENT_UPDATE), models (→ stderr; `--json` untouched). `nuvira agent` = scaffolding
  (create/list/info — nothing to animate, documented). Secondary registry ops (workflow
  search/install/info, edit/publish/skill/marketplace spinners) keep ora — adopted
  incrementally (same precedent as E1), tracked for follow-up.**
- Dashboard parity via the existing EventBus → dashboard DAG (web DAG does not render
  shell/recovery lanes yet — follow-up).
- Tests: `tests/cli/pipeline-board.test.tsx` (14: non-TTY frames incl. shell/recovery lines,
  ink event→lane mapping via ink-testing-library, ETA, keyboard/collapse, final-frame contract,
  NDJSON shell/recover extension).
- Acceptance: long tasks show running steps + shell commands + retries + ETA + parallel lanes
  in every action command.

**E3. Intent-first unified experience (`src/cli/chat.ts` + entry points)** — E3a ✅ (Session 14) · E3b ✅ (Session 15: H1 tool registry + full tool-call loop + ask_user + followups) · E3c ✅ (Session 16: model-decides — every request enters the tool loop, rules demoted to hints + no-model fallback, 5 task tools added)
- E3a landed: the `promptDeveloperMode` mode menu is **DELETED** — replaced by
  `resolvePipelineDispatch` (rule-based, C1/C3): every pipeline intent (create/fix/continue)
  dispatches, high confidence auto-dispatches (menu-unreachable gate), ONLY an ambiguous
  create asks a single confirm (never a mode picker); `runDeveloperMode` emits the
  **understand-card** on the live board + wires **D1 recall parity** (recallContext). See
  tracker Session 14 for scope notes (low-confidence fix/continue auto-dispatch pending
  E3b clarify-as-tool; no checkpoint auto-resume — execute `--resume` parity).
- Implementation:
  - **Delete `promptDeveloperMode` (the "1. Chat mode / 2. Developer mode" inquirer menu)
    entirely (re-scoped Session 7c)** — no menu, no LLM-unavailable fallback menu.
    Understanding-first: the C2 mandatory verify decides intent; LLM-unavailable degrades to a
    plain chat answer (never a mode picker). The menu is chat-only today — deleting it is the
    first cross-command parity win (execute/plan/edit/run must never show it either).
  - `nuvira chat` becomes the single surface: routes to plan/execute/edit internally
    (**pipeline-as-tool** — orchestrator pipeline callable from the conversation, the
    Freebuff/Hermes tool-call model); commands become power-user flags (`--plan-only` etc.).
  - CLI decluttering: promote 4–5 real-workflow commands to `/aliases`; demote the rest to
    `nuvira admin <sub>`; **backwards-compatible** (no command removal).
    - **E3c re-scoped (Session 16 — user decision):** "declutter the help text" was the
      WRONG lens. The user's ask ("why can't agent-nuvira act like freebuff/hermes — user just
      types the requirement, the system decides") re-scoped E3c to the **model-decides
      refactor**: every request runs as a tool-call turn and the MODEL decides what to do
      (publish/document/website/analyze/test now in the registry vocabulary). The rules
      (C1/C3) are demoted to (a) a HINT injected into the model context
      (`buildToolSystemPrompt(parsed)` — "rule assessment, NOT an order") and (b) the
      NO-MODEL fallback only: when the tool loop fails to generate a single response AND
      rules assessed a high-confidence pipeline intent, `runDeveloperMode` runs directly.
      `resolvePipelineDispatch` is never a bypass anymore. The CLI command surface stays
      intact (backwards-compatible) but becomes internal machinery — the dashboard
      command-runner landed ✅ (Session 17): the dashboard now EXECUTES the state
      commands on demand — `/api/admin/checks` runs doctor system + enterprise checks
      (same `runAllChecks` core as the CLI) and returns a MASKED provider summary;
      the Admin panel surfaces them with a single Refresh. Keys never leave the server
      unmasked. This is the read foundation of the future admin surface.
      **Write surface + control layer landed ✅ (Session 18):** the dashboard now
      CONFIGURES providers in parallel to the CLI (API-key/baseUrl/model via the SAME
      `ConfigManager.save()` the CLI uses; empty fields clear; DELETE purges vault
      keys; env-sourced keys warn, never fake-remove). Every write is gated behind a
      user-id + password (scrypt-hashed `dashboard-admin.json` or
      `NUVIRA_DASHBOARD_ADMIN_USER/PASSWORD` env override; in-memory 8h Bearer
      sessions; 10-failures/minute login throttle; constant-time password checks).
      CLI never deprecated — GUI and CLI stay parallel.
      **RBAC roles landed ✅ (Session 19):** multi-user credential store
      (`dashboard-admin.json` v1 users map, legacy single-user file migrates), and
      sessions carry an admin/operator/viewer role. `rbac.json` assignments override
      the stored role (CLI governance parity — a viewer in rbac is a viewer here,
      no escalation), the env override's role applies for the zero-config path
      (regression-fixed). Provider writes gate on `credential.write` (admin); admins
      manage dashboard users in-panel (`role.manage`, last-admin + self-remove
      guards); operator/viewer get the read-only table. Same `roleCan` matrix the
      CLI enforces.
      **Request Contract landed ✅ (Session 20 — Decision 3 shipped):**
      `src/nlu/contract.ts` resolves every goal into
      `{ goal, intent, action, actionLabel, mode, target[], scope[], constraints[],
      acceptanceCriteria[], riskFlags[], source }` — rule path deterministic +
      ZERO-cost (no extra model call; below `RULE_TRUST_THRESHOLD` it enriches
      from the SAME C2 verify call, never a second one). The 🧠 understand-card
      (`renderContractCard`) prints BEFORE the pipeline board starts on every
      run — fast-accept by default, never a blocking wizard (the Copilot-parity
      ask: "show what you understood, don't ask for a mode"). The contract's
      acceptance criteria feed spec→verify: `OrchestratorOptions.acceptanceCriteria`
      → vault metadata → the reviewer pass (per-criterion PASS/FAIL verdicts;
      any FAIL blocks) and `VerifyParams.acceptanceCriteria` → the
      VerifyModule goal-alignment check (TaskExecutionPipeline threads it too).
      The pipeline tool now passes `checkpoint: true`, so the card's
      "checkpoints keep it resumable" is true for every run. Remaining from the
      decision: the difficulty cascade + M2b measurement of completion ↑ / rework ↓.
      **Cross-command parity landed ✅ (Session 21 — execute + plan):** `execute.ts`
      and `plan.ts` now both show the 🧠 Understood card before their respective boards
      start — same shared choke point as chat's pipeline runs. execute ts reuses the
      existing `parseRequestSync(goal)` (zero-reparse), suppresses under `--json-events`,
      and passes `acceptanceCriteria: contract.acceptanceCriteria` to the orchestrator.
      plan.ts hoists `parseRequestSync(task)` before the board and reuses it in the D1
      recall block (no duplicate parse); uses a plan-specific footer ("no files are changed
      until you execute it") instead of a resumability claim. `renderContractCard` now
      supports `{ footer?, resumable? }` opts so each surface can calibrate the card's
      claim. Structural-wiring guard (+4 tests) verifies the ordering and zero-reparse
      invariant across all three entry surfaces. Full suite: **3,805/3,805**.
      **edit.ts parity landed ✅ (Session 22):** `edit.ts` now also shows the card —
      built from `parseRequestSync(instruction)` and printed before the routing
      decision; uses a direct-edit footer ("no pipeline run"). Cross-command parity
      structural guard covers all four entry surfaces. Full suite: **3,806/3,806**.
      **Docs: design decisions + README refreshed ✅ (Session 23):** DESIGN_DECISIONS.md
      Decision 5 status updated to ✅ Shipped (suggest_followups is a registered tool in
      E3b); Decision 3 implementation notes extended with cross-command parity (Sessions
      21–22); Decision 6 structural wiring guard mentioned. README.md first bullet rewritten
      to highlight the 🧠 visible contract as the Freebuff/Hermes differentiator; test counts
      updated to 3,806 across 149 files. Docs claim only what's shipped per Decision 19.
      **M2b baseline benchmark infrastructure ✅ (Session 24):** `M2B_TASK_IDS` constant
      defines the 9-task curated experience-parity suite (7 existing + 2 new: js-continuation
      for order validation + py-multi-file for multi-file Python pipeline). `--suite m2b` flag
      on `nuvira eval run` filters to the suite; `writeBenchmarkReport()` saves markdown with
      YAML frontmatter to `docs/benchmarks/`.      Hidden test templates fixed for Python syntax correctness. 3,806/3,806 tests pass.
      **Benchmark index + README link ✅ (Session 25):** `docs/benchmarks/INDEX.md` created
      with suite description, task table, scoring rules, and how to run. README.md "Runs
      anywhere" bullet gains a link to the benchmark index. 3,806/3,806 tests pass.
      **User-declared daily budget ✅ (Session 36, Decision 21):** the TPD-noise finding (Session 35)
      became a capability — `nuvira model quota set <provider>` (CLI) + dashboard Admin → 💰 Daily Budget
      panel (GET/PUT /api/admin/quota) edit the SAME `routing.quota.*` + `governance.maxCostUsd`
      config, advisory not hard-capped; the quota ledger + auto-router enforce it in-loop.
      Fixed a latent ConfigManager shallow-merge bug (quota writes wiped sibling providers).
      3,899/3,899 tests pass.
      **Eval --pace landed ✅ (Session 37):** `nuvira eval run --pace` consults the declared daily
      token budget + today's ledger usage and stops BEFORE a task would cross the cap — the
      Decision 21 gate fix. M2b is now measurable on free tier (was: TPD exhaustion made
      identical-setup runs swing ±45pt). 3,908/3,908 tests pass.
      **I1 web research landed ✅ (Session 38):** `web_search` + `read_page` tools (DDG free tier /
      SearXNG opt-in / Jina Reader) registered in H1 + the safe MCP surface — the model can now
      ground answers in current web info (Freebuff researcher-web / Hermes web_search_registry
      parity; capability gap #3 closed). SSRF guard on read_page; DDG redirect URLs decoded.
      156/156 test files pass.
      **J3 skills hub landed ✅ (Session 39):** `nuvira skills search/install/update/list` —
      community skills installed into `.agents/skills/` with provenance + SHA256 + quarantine
      (Hermes skills_hub / Freebuff npx skills parity; gap #10 + L1–L3 closed). Sandboxed names,
      frontmatter cross-check, version-gated update that never downgrades. 157/157 test files pass.
      **Gate calibration ✅ (Sessions 31–35):** first real baseline 72.2% composite / 78% test-pass
      (2 stuck, 15 rework, Session 31) · `nuvira eval results --compare` (Session 32) · noise floor
      re-measured across 3 identical-setup runs at **72.2% / 55.0% / 26.9% (~±45pt) — TPD
      exhaustion dominates** (Session 35: 12 TPD 429s, 0 TPM). The Part 1.9 gate verdict: free-tier
      Groq movement is uninterpretable; run the gate on a paid tier or with per-task pacing. 3,886/3,886 tests pass.
      **H2 sub-agent delegation landed ✅ (Session 26):** `src/agents/tools/delegation.ts` —
      `spawnSubagent` (fresh isolated context, per-sub-agent timeout + AbortSignal kill,
      `delegation:spawn/result/error` events) + `spawnSubagents` parallel fan-out with a
      maxSubagents budget guard (Freebuff `spawn_agents` / Hermes `delegate_tool.py` parity).
      `delegate` tool registered in H1's registry (nuvira tools list); E2 board renders live
      delegation lanes + NDJSON stream. 3,820/3,820 tests pass.
      **H2 plan-step delegation landed ✅ (Session 27):** the H2 acceptance "a plan step can
      delegate to 3 sub-agents in parallel" — `TaskStep.delegation` specs + `DelegateAgent`
      (module-registry agent that finds its OWN step via the race-free per-instance
      currentTaskId, fans out via spawnSubagents, aggregates success/soft-success/failure),
      planner prompt + normalization (validated, files-as-array guard), delegate steps run in
      the parallel batch without ErrorRepairEngine layering. 3,829/3,829 tests pass.
  - **Clarify-as-a-tool (verified against Hermes `tools/clarify_tool.py` + Freebuff `ask_user`):**
    ambiguous or incomplete requests are resolved by the MODEL calling an `ask_user` tool INSIDE
    the loop (question + ≤4 choices + `multi_select`, schema mirroring Hermes clarify_tool; CLI
    renders arrow-key/checkbox, exactly like Hermes) — NEVER by a pre-dispatch inquirer menu.
    The C2 `requirementState: 'needs-clarification'` result is the trigger: the model asks for
    exactly the `missingInfo` items, gets the answer, re-verifies, then dispatches. No pipeline
    runs between the ask and the answer.
  - **Follow-up recommendations as a first-class tool (verified against Freebuff
    `suggest_followups`):** the chat loop's system prompt carries the same contract Freebuff
    `agents/base-chat.ts` ships — *"End every response by calling `suggest_followups` with
    exactly 3 followups the user is likely to want next — natural next questions, deeper dives,
    or related directions that build on what you just said; specific to this conversation, not
    generic."* The H1 registry defines `suggest_followups` (zod `{followups: [{prompt,
    label?}][]}`, `endsAgentStep=false`); the CLI renders them as numbered clickable options;
    clicking sends the prompt as the next user message (clicked state persisted). Cross-command
    parity: execute/plan post-run surface the same tool output — replacing the keyword-matched
    rule fallback in execute.ts (rule fallback stays only when no model is available).
  - **Understand-card (Session 7e — intent transparency):** before any pipeline runs, every
    action command shows the resolved request contract as a live card — "🧠 Understood: … ·
    scope: … · criteria: [1..n] · [run] [edit] [clarify]" — fast-accept by default when the
    contract is complete + high confidence (auto-dispatch preserved), never a blocking wizard.
    The request is SEEN before it is run.
  - **Spec→verify feedback (Session 7e):** the contract's acceptanceCriteria feed the existing
    VerifyModule at pipeline end — "done" = criteria met (measured), not agent-declared done;
    the M2b benchmark scores this.
  - **Explicit end-turn semantics (verified against Freebuff `run-agent-step.ts`):** the chat
    loop continues while the model emits tool calls and ends on `end_turn`/`task_completed` (or
    a no-tools response); think-only responses (`isThinkOnlyResponse` — orphan reasoning or a
    bare <think> block) continue instead of ending; tool-call errors (`hadToolCallError`) force
    another step so the model retries in-context with the error message, exactly like Freebuff
    `shouldEndTurn`/`hasTaskCompleted`/`hasNoToolResults`.
  - **E3b landed (Session 15):** the H1 tool registry (`src/tools/registry.ts`) + tool loop
    (`src/tools/tool-loop.ts`) + chat wiring (`runChatAnswer` in `src/cli/chat.ts`) replaced
    the legacy generation-retry block. `confirmAmbiguousCreate` is GONE — ambiguous create
    clarifies in-loop via the `ask_user` tool (Hermes clarify parity); every chat answer runs
    as a tool-call turn (native `generateTools` on openai-compat/groq/openrouter/nim, JSON
    fallback otherwise) and ends with `suggest_followups` (Freebuff parity, 3 followups,
    numbered click-to-send in interactive / printed in single-shot). The pipeline is a tool
    (`build`/`resume`/`repair` → `runPipelineTool`, the extracted `runDeveloperMode` core),
    so `nuvira chat` pre-dispatch and in-loop tool calls can never diverge. `nuvira tools list`
    exposes the registry. Cross-command parity: execute.ts post-run followups validate
    against the shared `suggest_followups` schema (rule fallback stays as the no-model path).
    Honest scope (tracker Session 15): chat answers print after each step completes instead
    of character-streaming (mid-stream continuation M4.1 + partial-registry recording are
    chat-answer-only losses, preserved elsewhere); the H1 prompt-cache headers item is
    deferred (follow-up); Azure tool-calling URL handled via the shared helper's `url`
    override.
  - **Project-context understanding + injection scanning (verified against Hermes
    `agent/prompt_builder.py` `scan_for_threats` + `agent/system_prompt.py`):** the chat system
    prompt is assembled once per session (cached for prompt caching) from identity + project
    context files (AGENTS.md / .cursorrules / SOUL.md equivalents) + a skills index. EVERY
    context file is scanned for prompt injection / promptware / C2 / role-play hijack BEFORE
    injection (mirror `tools/threat_patterns.py`); blocked content is replaced with an explicit
    `[BLOCKED: <file> contained potential prompt injection …]` marker — never injected verbatim.
- Tests: `tests/cli/chat.test.ts` (no menu for high-confidence create; single confirm for
  ambiguous; fallback menu when LLM unavailable) **+ `tests/cli/execute.test.ts` and
  `tests/cli/plan.test.ts` parity tests — the SAME five canonical prompts resolve to the same
  action with zero mode selection from execute/plan/edit/run, not just chat.** + a loop test
  asserting: ambiguous request → model calls `ask_user` (no menu), tool error → next step,
  think-only → continue, `end_turn` → end.
- Acceptance: the five canonical prompts (assess / create addon / fix test / generate image /
  continue) produce the correct action with zero mode selection and live board feedback — **from
  every action command, verified by the parity tests above.** A request needing input resolves
  via an in-loop `ask_user` tool call (never a pre-dispatch menu); project conventions from
  AGENTS.md appear in the assembled system prompt and a planted injection attempt is blocked
  with an explicit `[BLOCKED …]` marker.

**Implementation reference:** Freebuff `packages/agent-runtime/src/tools/stream-parser.ts` +
`tool-executor.ts` are the model: a stream parser turns the provider's tool-call stream into
typed `CodebuffToolCall` objects, and the executor dispatches them with schema validation
(`ensureZodSchema`), error capture, and MCP tool lookup (`getMCPToolData`). Hermes `agent/transports/chat_completions.py`
handles the equivalent `tool_calls` loop. Expected outcome (E1): every subprocess emits
`EXEC_SHELL_START/END` with command + cwd + exit code through one `runShell` choke point — the
event a live lane renders. Expected outcome (E2): board v2 renders lane events from the same
EventBus the dashboard already consumes, with inline `recover:classified`/`recover:retrying`
lanes for Hermes-style failure visibility (`agent/error_classifier.py`, `retry_utils.py`).
Expected outcome (E3): the chat loop consumes the C3 parser output as the *next tool call*
(pipeline-as-tool), mirroring Freebuff `agents/base-chat.ts` (decide → call tool → observe result).
Verified mechanism references for the three E3 depth items (read directly from the clones):
- Clarify: Hermes `tools/clarify_tool.py` (structured MCQs / open prompts, platform layer owns the
  interaction — `_parse_multi_select_response`, schema validation) and Freebuff `ask-user` handler.
- End-turn: Freebuff `packages/agent-runtime/src/run-agent-step.ts` — `hasTaskCompleted`
  (task_completed/end_turn), `isThinkOnly` (think-only continues), `requiresExplicitCompletion`,
  `hasNoToolResults`, `hadToolCallError` forces a retry step.
- Context + injection: Hermes `agent/prompt_builder.py` (`_scan_context_content` →
  `scan_for_threats` from `tools/threat_patterns.py`; `[BLOCKED …]` replacement) +
  `agent/system_prompt.py` (`build_system_prompt_parts`, three ordered cache tiers).

### Phase F — Optional Enterprise Backend (F1, F2)

**F1. Optional Mem0 provider (`src/memory/mem0-provider.ts`)** — ⛔ **SKIPPED (Session 38, pre-decided):**
DESIGN_DECISIONS #15 already answers this — memory that depends on a paid cloud contradicts
free-first/local-first economics, and the local store keeps failure-lessons/trajectory under the
user's control offline. Tracker row 13 marked skipped; no implementation. (Original plan text
retained below for reference.)
- Leverage: `mem0ai` npm SDK v3.1.5 (platform + OSS; verify `mem0ai/oss` subpath exports first).
- Implementation: implements the Phase-B `MemoryProvider` interface; maps metadata →
  `filters{appId:projectId, agentId:agentRole, runId:sessionId}`; OSS mode with local vector
  backend; dual-write policy (local always-on, Mem0 async enrichment); config
  `memory.backend: local|mem0` (default `local`); `isAvailable()=false` when unconfigured.
- CLI: `nuvira memory backend set/status`.
- Tests: `tests/memory/mem0-provider.test.ts` (availability gating, filter mapping, no network).
- Acceptance: no Mem0 env vars → `local (active)`, suite green; with vars → dual-write works.

**F2. Standard MCP SDK + ripgrep adoption** — ✅ **Done (Session 28)**
- Leverage: `@modelcontextprotocol/sdk` (replace hand-rolled `src/mcp/client.ts`),
  `ripgrep` binary (bundled per-platform or `$PATH`).
- Implementation: MCP client/server over the official SDK (stdio + Streamable HTTP); code-search
  helper `src/utils/code-search.ts` using `rg` for context gathering + sandbox paths.
- Tests: `tests/mcp/sdk-client.test.ts`, `tests/utils/code-search.test.ts`.
- Acceptance: MCP tools load via the official SDK; project search is `rg`-fast.
- **Landed (Session 28):** `src/mcp/client.ts` rewritten on `@modelcontextprotocol/sdk@1.30`
  with an unchanged public API (connect/disconnect/listTools/callTool/listResources/
  readResource/listPrompts/getPrompt, state getter, change events, timeouts, process-tree
  cleanup); `src/utils/code-search.ts` `searchCode()` with `@vscode/ripgrep` bundled binary
  (rg 15), fs-walker fallback, and both engines case-insensitive by default (deliberate,
  documented); `code_search` tool registered in the H1 registry (reachable via the generic
  tool-loop dispatch). MCP server exposure of agent tools — **Landed (Session 30):**
  `src/mcp/server.ts` exposes the H1 registry as an MCP server via the official SDK
  (`McpServer` + stdio transport; `nuvira mcp serve`), safe surface = pipeline tools +
  `code_search` (headless, `board:false`), loop-internal/LLM-dependent/irreversible tools
  (`ask_user`/`suggest_followups`/`verify_requirement`/`delegate`/`publish`) excluded by an
  explicit allowlist; `--with <tools>` opts extras in; pre-connect output routes to stderr so
  stdout stays protocol-clean.

**Implementation reference:** Hermes `tools/mcp_tool.py` + `mcp_serve.py` + `agent/transports/hermes_tools_mcp_server.py`
show the two sides: consuming remote MCP tools and *exposing* agent tools as an MCP server —
`tools/mcp_oauth_manager.py` + `mcp_oauth.py` add the OAuth dance agent-nuvira lacks. Expected
outcome: the official SDK replaces `src/mcp/client.ts` internals with identical call behavior
(no API break for callers), and the agent can optionally expose its own H1 tools via MCP so other
clients (dashboard, gateway) reuse them. For tree-sitter: Freebuff `packages/code-map/` (languages.ts,
parse.ts) is the code-map model; expected outcome is `editing/ast.ts` upgraded from regex to
`web-tree-sitter` WASM with the same `StructuralNode` output shape — zero caller churn.

### Phase G — Observability, Dashboard, Docs, Audit (G1, G2, G3)

**G1. CLI surfacing:** `nuvira memory facts`, `nuvira memory backend status`, `nuvira nlu debug`,
`nuvira config vault status`, **`nuvira session list/resume/summarize` (debug surface — D1 is the
primary path)**, `nuvira doctor` sections for vault / workspace / facts. — **✅ Done (Session 29):**
`src/cli/session.ts` (list with `--project`/`--since` temporal filter, summarize, resume) +
router registration; doctor gains a Fact Memory section (fact count per project).

**G2. Dashboard surfacing** (`src/web-dashboard/`): memory panel (facts, sessions by project,
recall hits, backend tier); live activity lanes for shell + retry (E2 events); reuse the existing
`server.ts` read-path pattern. — **✅ Done (Session 29):** `/api/memory` now also serves facts
(vectors-facts.json, record-keyed read) + recall hits (shared `readRecallHits` from
session-recall.ts) + backend tier; MemoryPanel renders them. Shell/retry lanes remain a
follow-up (E2 events already emitted).

**G3. Audit + privacy + docs:** assert all memory/session writes pass through `redact()`
(secrets.ts) — P6 M6.2 compliance tests; `User_Manual.md` + `Product_Guide.md` + website release
rows + CHANGELOG per phase. — **✅ Done (Session 29):** `history.ts storeSession` redacts
message content before persist (history.json + vector index); 4 compliance tests (key masking,
Bearer masking, caller-array immutability, on-disk assertion); CHANGELOG + User_Manual
(§6.14b session command + privacy note) + Product_Guide (3 rows) updated.

**Implementation reference:** Freebuff ships a published `sdk/` package with its own changelog and
PUBLISHING.md — the pattern to mirror for agent-nuvira's dashboard + docs release workflow; Hermes
`agent/redact.py` + `message_sanitization.py` are the privacy model (strip credentials before any
persist/display). Expected outcome: every new CLI/dashboard surface added in H/I/J lands in G with
a redaction assertion test and a one-line release-note entry — nothing ships unobserved.

### Phase H — Tool Loop & Delegation: the missing Freebuff/Hermes core (H1, H2)

*Closes capability gaps #1, #2 (native LLM tool-calling, sub-agent spawning). This is the
mechanism Freebuff/Hermes use for EVERY capability — without it, adding tools (web, browser,
voice) would be the "superficial layer" the user rejected.*

**H1. Tool registry + native tool-calling adapter (`src/tools/registry.ts`,
`src/tools/executor.ts`)** — ✅ Done (Session 15)
- Leverage: **zod** (`npm i zod` — pure JS, MIT; add if not present) + the Phase-C3
  action-descriptor schema.
- Implementation (mirrors Hermes `tools/registry.py` + Freebuff `tool-executor.ts`):
  - `registerTool({ name, description, inputSchema, run, category })` — declarative registry;
    every existing pipeline entry point (plan/execute/edit/analyze) is registered as a tool.
  - `ToolExecutor` — for providers with native tool-calling (gemini/openrouter/groq/nim expose
    function schemas): pass `tools` to the request, parse `tool_calls`; for providers without it,
    fall back to the existing JSON-parse path. One schema, two transports (Phase C3 acceptance b).
  - **First-class experience tools (Session 7c):** register `suggest_followups` (Freebuff
    parity — end-of-response follow-up recommendations), `ask_user` (Hermes clarify parity —
    in-loop clarification, ≤4 choices + multi_select), and `verify_requirement` (the C2
    requirementState check as a reusable tool) in the same registry, so chat/execute/plan share
    one definition (STANDING RULE).
  - **Prompt-cache headers** (gap #13, Freebuff 3-tier prompt-cache pattern): adapters send
    provider-native cache prefixes on tool descriptions + the assembled system prompt (E3), so
    the mandatory per-request verify stays cheap.
- Tests: `tests/tools/registry.test.ts`, `tests/tools/tool-loop.test.ts`, `tests/tools/verify-requirement.test.ts`, `tests/inference/tools.test.ts` (native parse + JSON fallback, unknown-tool rejection, schema validation, end-turn semantics, bounded steps), `tests/cli/tools.test.ts` + `tests/cli/chat-tool-loop.test.ts` (both transports through `runChatAnswer`), and the ported `tests/cli/chat-failover.test.ts` (promptOnFailover contract on the new walk).
- Acceptance: a chat turn can invoke `plan`/`execute`/`edit` as a tool call (native path) and the
  same request works via JSON fallback on a non-tool provider; every tool is visible in
  `nuvira tools list` — **and the tool registry is consumed by every action command
  (chat/execute/plan/edit/run/ci/workflow), so a tool registered once works everywhere with zero
  per-command re-implementation (STANDING RULE).**

**H2. Sub-agent registry + live delegation (`src/agents/tools/delegation.ts`)**
- Leverage: existing orchestrator + EventBus; no new dep.
- Implementation (mirrors Hermes `delegate_tool.py` + Freebuff `spawn_agents`):
  - `spawnSubagent({ agentType, prompt, files })` → runs a specialized agent (context-gatherer,
    reviewer, researcher-web, etc.) as a sub-task, streaming `delegation:spawn` /
    `delegation:result` / `delegation:error` events (E2 renders them as live lanes).
  - Parallel fan-out with result aggregation (orchestrator already has Promise.all patterns).
  - Budget/loop guard: max sub-agents per turn, timeout, kill-switch.
- Tests: `tests/agents/tools/delegation.test.ts` (parallel spawn, event emission, kill).
- Acceptance: a plan step can delegate to 3 sub-agents in parallel and render each live lane;
  `nuvira tools list` shows delegation tools.

**Implementation reference:** Hermes `tools/registry.py` is the canonical tool-registry pattern —
each tool module registers schema + handler + toolset + availability at import time, and
`model_tools.py` queries the registry (no parallel data structures); `tools/registry.py` also
bounds error text returned to the model (`_bound_error_text`, 2k/8k char caps). Hermes
`tools/delegate_tool.py` is the sub-agent pattern: child gets a fresh conversation, isolated
context, its own task id, parent's toolsets minus blocked tools, and a focused system prompt — the
parent only ever sees the delegation call + summary result, never the child's intermediate turns.
Freebuff `agents/basher.ts` + `file-picker.ts` show the TS generator-step flavor (`yield
{toolName, params}`) the TS registry can adopt. Expected outcome: `registry.ts` is the ONLY place
tools are declared; `executor.ts` validates schemas (zod), truncates error bodies like
`_bound_error_text`, and delegation results are summaries — not child transcripts — just like
Hermes.

### Phase I — Modality & Research Packs (I1–I5) — optional, OSS/free only

*Closes capability gaps #3–#7 (web research, browser, image, voice, vision). Every pack is
availability-gated (like F1's Mem0) — zero behavior change when unconfigured, and all backends
are OSS/MIT or free-tier so end users pay nothing.*

**I1. Web research tool (`src/agents/tools/web-research.ts`)** — mirrors Freebuff
`researcher-web.ts`/`researcher-docs.ts`.
- Free search endpoints: DuckDuckGo HTML (no key), SearXNG (self-host, OSS), Jina Reader free
  tier for page text; `fetch` with timeout + robots-aware headers.
- `search(query)` + `readPage(url)` tools → registered in H1; results cached in `context/cache.ts`.
- Tests: `tests/agents/tools/web-research.test.ts` (mocked fetch, no network).

**I2. Browser automation (`src/agents/tools/browser.ts`)** — mirrors Freebuff `browser-use` +
Hermes `browser_tool.py`. ✅ **LANDED (Session 43)** — `src/tools/modality/browser.ts`: `browser` tool (open/click/type/extract/screenshot), playwright optional via `require.resolve` (no forced download), SSRF guard reusing web-research's `isAllowedReadUrl`.
- Leverage: **Playwright** (MIT). Optional install (`nuvira tools install browser`); graceful
  `isAvailable()=false` when not installed (no forced heavy download).
- Tools: `browser_open/navigate/click/type/screenshot/extract`. Screenshots saved to sandbox dir.
- Tests: `tests/agents/tools/browser.test.ts` (availability gating, fake page).

**I3. Image generation (`src/agents/tools/image-gen.ts`)** — mirrors Hermes
`image_generation_tool.py`. ✅ **LANDED (Session 43)** — `src/tools/modality/image-gen.ts`: `generate_image` → Pollinations.ai free endpoint default, local SD/ComfyUI via `NUVIRA_IMAGE_API_URL`, writes to `images/` artifacts.
- Backends (free): local ComfyUI / Stable Diffusion API, Pollinations.ai free endpoint. Tool:
  `generate_image(prompt, size)` → writes to sandbox `images/`.
- Tests: `tests/agents/tools/image-gen.test.ts` (mocked backend).

**I4. Voice pack (`src/agents/tools/voice.ts`)** — mirrors Hermes `tts_tool.py` /
`transcription_registry.py`. ✅ **LANDED (Session 43)** — `src/tools/modality/voice.ts`: `speak` (edge-tts + Piper stdin fallback) and `transcribe` (whisper.cpp/whisper-cli, transcript file read-back), availability-gated + injectable exec.
- **edge-tts** (free Microsoft edge voices) or Piper TTS for `speak(text)`; **whisper.cpp** or
  faster-whisper (local) for `transcribe(audioPath)`. Both optional installs.
- Tests: `tests/agents/tools/voice.test.ts` (availability gating).

**I5. Vision (`src/agents/tools/vision.ts`)** — mirrors Hermes `vision_tools.py`. ✅ **LANDED (Session 43)** — `src/tools/modality/vision.ts`: `describe_image` reusing the model router (Ollama llava/llama3.2-vision or Gemini).
- Local **llava / llama3.2-vision via the existing Ollama local adapter**, or free Gemini vision
  tier. Tool: `describe_image(path, prompt?)` reusing the model router.
- Tests: `tests/agents/tools/vision.test.ts` (mock model response).

**Implementation reference:** Hermes uses **registry + availability gating** everywhere: `agent/web_search_registry.py`
(`register_provider`/`list_providers`/`get_provider`, one-capability-eligible fallback),
`image_gen_registry.py`, `tts_registry.py`, `transcription_registry.py`, `browser_registry.py` —
tools query the registry and degrade gracefully when a backend is unconfigured. Expected outcome
for every I-pack: a registry keyed by capability, an `isAvailable()` check per backend, and
the same one-eligible-provider fallback Hermes implements — so adding/removing a free backend is a
one-line registry change, never a code edit in the tool.

### Phase J — Channels, Automation, Skills Ecosystem (J1–J3)

*Closes capability gaps #8–#10 (multi-channel gateway, cron, skills hub). All MIT bot libs with
free tiers — no paid infra.*

**J1. Multi-channel gateway (`src/gateway/`)** — mirrors Hermes `gateway/`. ✅ **LANDED (Session 42)** — `nuvira gateway start/send/status/alias` with dependency-free pure-fetch adapters (Telegram long-poll + Discord/Slack webhooks + WhatsApp Cloud API; deliberately NO grammY/discord.js/@slack/web-api SDKs — same REST calls, hundreds fewer packages), GatewayRegistry (parseRequestSync → shared runPipelineTool → reply to originating channel + board-event streaming), channel directory + alias resolution (Hermes channel_directory.py pattern), webhook signature verification + `NUVIRA_GATEWAY_ALLOW_IDS` pipeline allow-list + `gateway.manage` RBAC, and J2 cron `--channel` delivery.
- Adapters (all MIT, free bot APIs): **grammY** (Telegram), **discord.js**, **@slack/web-api**, and
  WhatsApp via **Meta's official WhatsApp Cloud API** (free tier; avoid unofficial reverse-
  engineered wrappers like Baileys — account-ban/ToS risk). `GatewayRegistry` maps inbound
  messages to `parseRequest` (Phase C3) and streams board events as channel messages (E2
  JSON-events → channel).
- Channel directory + alias resolution (Hermes `channel_directory.py` pattern).
- Tests: `tests/gateway/*.test.ts` (mock adapters, no network).
- Acceptance: a Telegram message "fix the failing test" runs the execute pipeline and replies
  with the result; all adapters are opt-in via env bot tokens.

**J2. Scheduled jobs (`src/gateway/cron.ts`)** — mirrors Hermes `cron/jobs.py`. ✅ LANDED (Session 40) — `nuvira admin cron add/list/remove/run` with node-cron validation, dry-run, add-time arg schema validation, `cron.manage` RBAC, run-now via the H1 registry + event bus.
- Leverage: **node-cron** (MIT). `nuvira admin cron add/list/remove` (per E3 CLI decluttering) —
  jobs are tool invocations (H1 registry) with delivery to a channel (J1) or CLI notification.
- Tests: `tests/gateway/cron.test.ts` (schedule parse, dry-run).

**J3. Skills hub + sync (`src/cli/skill.ts` extension)** — mirrors Hermes `skills_hub.py` /
`skills_sync_client.py` + Freebuff `npx skills add`.
- Extend the existing skill-store: `nuvira skills search <q>` (fetch index from a configurable
  registry URL or local dir), `nuvira skills install <owner/repo> --skill <name>` (download,
  provenance + checksum recorded, sandboxed install), `nuvira skills update`, `nuvira skills list
  --origin`.
- Tests: `tests/cli/skills-hub.test.ts` (mocked registry).

**Implementation reference:** Hermes `gateway/` is the transport model — `config.py` defines the
`Platform` enum (Telegram/Discord/WhatsApp/Slack/Weixin) + env-var token map, and
`channel_directory.py` maintains a cached map of reachable channels with human-friendly aliases.
Skills: Hermes `tools/skills_hub.py` (SkillMeta, SkillBundle, quarantine dir, audit log, taps file,
index cache) + `skills_sync_client.py`; Freebuff `.agents/skills` + `npx skills add` flow.
Expected outcome: `GatewayRegistry` mirrors `channel_directory` (alias resolution included), and
J3's skills install records provenance + checksum + quarantine, mirroring `skills_hub.py` — with
the same tap/index-cache shape so skills can be searched without network.

### Phase K — Observability & Security (K1–K4) — enterprise-grade visibility + protection

*Not a clone-parity gap (Freebuff/Hermes don't ship these either) — this phase hardens agent-nuvira
for enterprise use. Reuses what already exists (logger `scrub()`, `enterprise/audit-chain.ts`,
`enterprise/rbac.ts`, `vault.ts`) rather than adding parallel systems.*

**Evidence-based re-scope (2026-08-08):** K3 (vault audit) and K4 (RBAC enforcement) are the
REAL gaps — the vault currently has **zero access logging** (`grep logger. vault.ts` → empty), and
RbacManager is used for identity display in `admin.ts` but never DENIES anything. K1/K2 are
**deferred**: the P0 reasoning-trace already records per-step latency/tokens/agentType with
`traceId`, and `nuvira stats`/cost-tracker/quota-ledger/doctor Telemetry already cover metrics; the
only new metric (rule-vs-LLM latency) needs Phase C's paths to exist first.

**K1. Structured logging (`src/enterprise/log.ts`)** — correlation IDs. ✅ **LANDED (Session 45)** —
- Rationale: incremental over what the reasoning-trace + event bus + dashboard already provide.
- When it lands: adopt **pino** (optional) or extend `utils/logger.ts` with a JSON line mode +
  correlation-id carrier (`sessionId` from history, `projectId` from A2, `taskId` from the
  orchestrator); `NUVIRA_LOG_JSON=1` for the dashboard/CI; the existing `scrub()` path must be
  preserved. Tests: `tests/enterprise/log.test.ts`. Acceptance: one session = one sessionId.

**K2. Metrics (`src/enterprise/metrics.ts`)** — latency budgets, memory hits/misses, vault access.
✅ **LANDED (Session 45)** — C1's rule path (parseRequestSync/dispatch) and B2's memory retrieve (buildMemoryBlock) both exist, so the deferral is lifted.
- Rationale: today's `nuvira stats` / `feedback stats` / `memory stats` / cost-tracker /
  quota-ledger / doctor Telemetry-Usage-Health already cover the aggregate picture; the new
  rule-vs-LLM latency budget needs C1's rule path to exist.
- When it lands: counters/timers (no new dep) + JSON persistence in the memory dir, surfaced by
  `nuvira doctor` + dashboard (G2). Tests: `tests/enterprise/metrics.test.ts`.

**K3. Vault audit (`src/enterprise/vault-audit.ts`)** — every credential read/write/delete logged
with masked values. ✅ **ACTIVE — highest-value item in K–N.**
- Reuse: `enterprise/audit-chain.ts` (append-only, hash-chained JSONL) + existing `nuvira audit`
  command — vault events append to the SAME chain, not a new store.
- Implementation: wrap `Vault.getPassword/setPassword/deletePassword` to emit
  `{ action, account, at, masked }` — the value is passed through `secrets.ts` masking, NEVER the
  raw secret. Read events throttled (one per minute per account) to avoid log floods.
- Tests: `tests/enterprise/vault-audit.test.ts` (masked value present, raw secret absent, chain
  integrity holds).
- Acceptance: vault access is auditable — `nuvira audit tail` shows who read what (masked) with a
  valid hash chain.
- **Landed (Session 33):** `src/enterprise/vault-audit.ts` records every get/set/delete as a
  hash-chained, account-name-only record (`vault-access.jsonl`, chain id `vault-access`); hooks in
  `Vault.getPassword/getPasswordSync/setPassword/deletePassword`; surfaced via `nuvira config vault
  log`, `nuvira audit verify` (which also fixed a latent bug: builtin chain ids now carry `.jsonl`
  so real stores verify — quota-events 200 + model-registry 2,408 records now report intact) and
  `nuvira doctor --enterprise`. Deliberate deviations: dedicated per-concern chain (matches the
  existing quota/registry pattern) instead of one shared chain; reads NOT throttled — rotation
  (5,000×2) bounds volume and only vault-ref configs log.

**K4. RBAC enforcement (existing `src/enterprise/rbac.ts` + wiring in sensitive commands)** ✅ **DONE (Session 34)**
- Reuse: existing `enterprise/rbac.ts` (roles admin/operator/viewer, `permissionsFor`, OIDC
  adapter) — K4 extends the ACTION set and WIRES enforcement, it does not duplicate the engine.
- Implementation: `SENSITIVE_ACTIONS` (config vault migrate, admin, team, sbom write, skills
  remove); `requireRole(role, action)` in `config.ts vault`, `admin.ts`, `team.ts`,
  `skill.ts remove`; deny → clear message + exit code 3. Default (no rbac.json) = permissive,
  fully backwards-compatible.
- Tests: `tests/security/rbac.test.ts` (deny viewer/operator, allow admin, default permissive).
- Acceptance: an unauthorized role triggering a sensitive command is DENIED with a clear error.

**Implementation reference:** Hermes `agent/credential_persistence.py` + `secret_scope.py` scope
secrets per project/app and never log raw values (the masking model); `enterprise/audit-chain.ts`
already gives the append-only hash-chained store to extend. Expected outcome: every vault access
is on the audit chain with masked values, and RBAC denies unauthorized sensitive commands — with
zero change to how keys are stored/used.

### Phase L — Skills Lifecycle (L1–L3) — provenance + lifecycle management

*Evidence-based re-scope (2026-08-08): this is a genuine gap (the skill CLI has
list/show/run/compile/search/gc — **no install/update/remove, no hub to install from**) but it
only pays off once J3's hub exists. **FOLDED INTO J3** — J3's acceptance criteria now include the
lifecycle + provenance below; there is no separate L row.*

**L (as part of J3). Skill registry + install/update/remove + signature checks.**
- Reuse: `src/learning/skill-store.ts` + `src/cli/skill.ts` (list/show/run/compile/search/gc)
  and the A2 node:sqlite pattern for the provenance DB.
- `SkillMeta { id, author, signature, version, origin, installedAt, checksum }` on every
  installed skill; `nuvira skills install/update/remove <id>`; update = verify new signature +
  atomic swap; remove = deactivate + quarantine before delete (mirrors Hermes `skills_hub.py`).
- **SHA256 signature verified BEFORE activation** — a mismatched package is quarantined, never
  run; provenance persists in `skills.db` (node:sqlite, same STRICT pattern as A2) so the audit
  trail survives restarts.
- Tests: `tests/skills/registry.test.ts`, `tests/skills/install.test.ts`,
  `tests/skills/provenance.test.ts` (signature mismatch → refusal + quarantine).
- Acceptance: `nuvira skills list --provenance` shows id/author/signature/version for every
  installed skill; a tampered package cannot activate.

**Implementation reference:** Hermes `tools/skills_hub.py` (SkillMeta, SkillBundle, quarantine
Dir, audit log, taps file, index cache) + `skills_sync_client.py`; Freebuff `.agents/skills` +
`npx skills add` flow. Expected outcome: skill activation mirrors Hermes — provenance recorded
before activation, tampered bundles quarantined, and the lifecycle (install/update/remove) leaves
a restart-surviving audit trail in `skills.db`.

### Phase M — Testing & CI/CD (M1–M4) — reliability + regression safety

*Guarantees the revamp stays green as 30+ new modules land. Iterative — M1 lands with each
phase; M3 defers to H1; M4 is a small correction, not a new pipeline.*

**Evidence-based re-scope (2026-08-08):** CI **already exists** — `.github/workflows/` has
`test-linux.yml`, `test-windows.yml`, `publish.yml`, `deploy-website.yml`, `publish-vscode.yml`.
M4 is therefore **corrected to "extend the existing matrix"**, not "add a pipeline". And M3 (zod
schema validation) can't validate tool schemas before the H1 tool registry exists — deferred to
H1's acceptance.

**M1. Integration tests (`tests/integration/`)** — Vault + Workspace + MemoryProvider end-to-end.
✅ **LANDED (Session 41)** — `tests/integration/a1-a2-b1.test.ts` (vault→workspace→memory continuity, one hermetic temp harness, reload legs) + `tests/integration/orchestrator-workspace.test.ts` (real orchestrator run records its workspace row even on FAILURE, upsert across runs, zero network).
- Implementation: one temp `NUVIRA_CONFIG_DIR` harness driving the REAL modules together:
  vault set→read, workspace recordRun→reload, fact-store add→retrieve, and a full
  orchestrator→workspace write cycle (no network, no real ~/.nuvira).
- Tests: `tests/integration/a1-a2-b1.test.ts`, `tests/integration/orchestrator-workspace.test.ts`.
- Acceptance: the three foundation systems pass as ONE unit — the end-to-end continuity story
  (vault → project row → memory) is proven, not assumed.

**M2. Regression parity suite (`tests/regression/`)** — against the Freebuff/Hermes clones.
🕒 **LOW priority** — nice-to-have; lands opportunistically after the borrowed designs (C3, H1)
stabilize. Clone paths in /tmp; tests SKIP with a message when a clone is absent (never fail CI).

**M2b. Black-box experience-parity benchmark (Session 7d — anti-coverup).** The only way to
answer "would a developer choose us?" is to measure it. A curated task suite (10–15 realistic
developer goals spanning build/fix/continue/explain + ambiguous cases) executed as a black box
through all three CLIs (`nuvira`, freebuff CLI, `hermes`) with the SAME provider/model family where
possible; automated scoring of: completion rate, user-visible stuck states, rework turns
(retries/clarifications needed), follow-up usefulness, and wall-clock time-to-done. Runner
mirrors the existing `eval-framework.ts` + `buffbench` pattern; results table published to
`docs/benchmarks/`. Gate: a phase's acceptance criteria must move a metric (Part 1.9 decision
rule). Runs after H1+E3 (the machinery must exist to be measured) — the FIRST run is a baseline
taken even earlier (today's product), so progress is visible.
- **Landed (Session 31):** first real baseline run — auto-routed to `groq/llama-3.3-70b-versatile`,
  72.2% composite · 78% test-pass (7/9) · 56% pipeline-completion · 15 rework turns (1.7/task) ·
  2 stuck states ($0.02, 142s). Experience-parity breakdown (stuck/rework) implemented and
  rendered in the reports; key finding: Groq free-tier TPM 429 rate-limits hit 3 tasks — 2
  recovered to correct code (interference, not stuckness — the stack worked through it), 1 failed.
  Full detail: `docs/benchmarks/m2b-groq-llama-3.3-70b-versatile.md` + tracker Session 31.
- **Landed (Session 32):** `nuvira eval results --compare` (compareEvalRuns + same-setup
  selectCompareRuns) makes the Part 1.9 gate one command. Second identical-setup run
  quantified the noise floor: 55.0% vs 72.2% composite on the SAME setup the same day
  (17 Groq free-tier TPM 429s) — movement inside ~±17pts is noise on free-tier Groq.
- **Landed (Session 44):** post-revamp re-run (`nuvira eval run --suite m2b --provider groq
  --budget 0.05`, $0.008). `--compare` vs the immediately-prior run: win on EVERY axis
  (47.2% vs 26.9% composite · 44% vs 11% test-pass · stuck 5 vs 8 · rework 32 vs 36).
  Caveat: composite sits below the S31 peak (72.2%) — inside the ±17pt free-tier noise
  floor, and this run hit 2 circuit-breaker cooldowns (120s each), a post-baseline
  failure mode that manufactures "stuck" states from recoverable 429s. The absolute
  number cannot move past free-tier noise until M2b runs on a stable provider.

**M3. Schema validation (zod) before dispatch** ✅ **LANDED (via H1, Session 45 sweep)** — the H1
registry zod-parses every tool's args (`schema.parse(args)`) before `run`, so invalid definitions
are rejected, never silently coerced (H1 landed Session 15; M3's deferral precondition). The
standalone `schema-health` report in `nuvira tools list` remains a nice-to-have, not a blocker.
Acceptance: an invalid tool schema cannot reach an agent run.

**M4. CI/CD — EXTEND the existing GitHub Actions matrix (Node 22/24/26 + Bun latest)**
✅ **LANDED (Session 41)** — `test-linux.yml` extended in place: Node 22/24/26 × ubuntu/macos + a new `bun` job (`oven-sh/setup-bun`, `bun install --frozen-lockfile` with a committed `bun.lock`, `bunx tsc --noEmit`, `bun run build`, `bunx vitest run`). Verified locally under Bun 1.3.
- Implementation: add `node 26` + `bun latest` to the existing `test-linux.yml` matrix;
  keep `tsc --noEmit` + `vitest run` + dashboard `vite build` steps; cache node_modules.
- Acceptance: the existing workflows pass on the extended matrix — no NEW pipeline file.

**Implementation reference:** Freebuff `context-pruner-parity.test.ts` is the parity-test model to
copy; Hermes `hermes_state_portability.py` is the portability-test shape (schema drift detection).
Expected outcome: the foundations are integration-tested end-to-end (M1), the existing CI matrix
is extended (M4), and the borrowed designs are pinned by parity tests once they stabilize (M2).

### Phase N — Governance (N1–N3) — IP, contributors, commercialization

*Procedural, not code. Evidence-based re-scope (2026-08-08): LICENSE and CONTRIBUTING.md **already
exist**; a CLA is premature until there are external contributors (it adds friction before the
community exists to protect). **TRIMMED to a one-time decision note — not a scheduled row.***

**N. One-time license decision (do when first external contributor approaches, or before any
commercial launch):** MIT (permissive adoption) vs dual MIT + commercial (MIT for community +
commercial terms for enterprise features like K/G enterprise checks). Then: `CLA.md` (individual
+ corporate variants) + PR template sign-off, and SPDX headers on new files. CONTRIBUTING.md
already exists — extend it with the CLA + `REVAMP_PROGRESS.md` tracking convention when the time
comes.

**Implementation reference:** GitHub community CLA practices (individual vs corporate); Freebuff
`PUBLISHING.md` + CONTRIBUTING shape; Hermes LICENSE. Expected outcome: when contributions begin,
they arrive license-clean (CLA signed, SPDX-tagged) and the commercial path stays open without a
rewrite.

---

## Part 3 — Sequencing, effort, dependencies

| Order | Phase | Deliverable | Effort | Depends on |
|---|---|---|---|---|
| 1 | A1 | Secret vault (keyring + AES fallback) | S (2d) | — |
| 2 | A2 | Workspace DB + project registry (node:sqlite; engines bump to ≥22.5 or JSON fallback tier) | S (2d) | — |
| 3 | B1 | Fact & preference memory (existing FAISS) | M (4d) | A2 (projectId) |
| 4 | B2 | MemoryProvider + MemoryManager | M (3d) | B1 |
| 5 | C1 | NLU rule fast-path (wink-nlp/compromise + recognizers-text-datetime temporal parsing) | S (2d) | — |
| 6 | C2 | **Mandatory** LLM verify + request-contract (goal/target/scope/criteria/risk) + elicitation loop + difficulty cascade (7c + 7e re-scope) | M (5d) | C1 |
| 7 | C3 | Unified parser + intent→action map | S (2d) | C1, C2 |
| 8 | D1 | Agent-driven auto-recall — workspace row + project-scoped temporal sessions + facts + resume point; card + context block; wired chat/execute/plan/edit (run documented exempt) | M (3d) ✅ | A1, A2, B2, C1 |
| 9 | D2 | Auto-run background duties | S (2d) | A2 (display via logger; board lanes later) |
| 10 | E1 | execa shell modernization + shell events | S–M (3d) | — | ✅ Session 11
| 11 | E2 | ink live activity board v2 + failure UX | L (5d) | E1 |
| 12 | E3 | Intent-first UX (delete menus, pipeline-as-tool, clarify-as-tool, follow-up recommendations) | L (6d) | C3, E2 (full); menu deletion standalone |
| 13 | F1 | Optional Mem0 backend | S–M (3d) | B2 |
| 14 | F2 | MCP SDK + ripgrep adoption | M (3d) | E1 |
| 15 | G1–G3 | CLI/dashboard/docs/audit surfacing — **iterative**: runs continuously; G3 documents every phase (incl. H/I/J) as it lands | M (3d) | all earlier phases |
| 16 | H1 | Tool registry + native tool-calling adapter + prompt caching | M (4d) | C3 (action descriptors), E1 |
| 17 | H2 | Sub-agent registry + live delegation lanes | M (3d) | H1, E2 |
| 18 | I1 | Web research tool (DDG/SearXNG/Jina, free tiers) | S (2d) | H1 |
| 19 | I2 | Browser automation (Playwright, optional install) | M (3d) | H1 |
| 20 | I3 | Image generation (local/free backends) | S (2d) | H1 |
| 21 | I4 | Voice: TTS + transcription (edge-tts/whisper) | S (2d) | H1 |
| 22 | I5 | Vision (local llava via Ollama / free tier) | S (2d) | H1 |
| 23 | J1 | Multi-channel gateway (Telegram/Discord/Slack/WhatsApp) | M (4d) | C3, E2, H1 |
| 24 | J2 | Cron jobs (node-cron) | S (2d) | H1, J1 |
| 25 | J3 | Skills hub + sync (search/install/update) | S–M (3d) | H1 |
| 26 | K3 | Vault audit (masked, hash-chained) — **unblocked** (A1 ✅; audit-chain pre-exists) — optional quick win, may slot in any time | S (2d) | A1, audit-chain |
| 27 | K4 | RBAC enforcement on sensitive commands — **unblocked** (rbac engine pre-exists) — NOT urgent; core path first | ✅ Done (Session 34) | A1 (existing rbac.ts) — shared guard `rbac-guard.ts` + 4 new actions; team/skill/sbom/vault-migrate wired; legacy permissive preserved |
| 28 | M1 | Integration tests — **vault+workspace legs unblocked** (A1/A2 ✅); memory leg after B1 | S (2d) | A1, A2 (vault+workspace legs); B1 (memory leg) |
| 29 | K1 | Structured logging (correlation IDs) — 🕒 deferred until C1 | S (2d) | C1 (when scheduled) |
| 30 | K2 | Metrics (latency budgets) — 🕒 deferred until C1+B2 | S (2d) | C1, B2 (when scheduled) |
| 31 | M3 | zod schema validation — 🕒 deferred until H1 | S (1d) | H1 (when scheduled) |
| 32 | M4 | Extend EXISTING CI matrix (Node 26 + Bun) — no new pipeline | S (0.5d) | — (existing workflows) |
| 33 | L1–L3 | Skills lifecycle — **folded into J3** (no separate row) | — | J3 |
| 34 | N1–N3 | Governance — **trimmed to one-time license note** (LICENSE + CONTRIBUTING already exist) | — | — (when contributors/commercialization) |
| 35 | M2b | Black-box experience-parity benchmark vs Freebuff + Hermes (completion/stuck/rework/time; baseline BEFORE H1/E3, then re-run after) | M (4d) | ✅ Baseline (Session 31) — groq, 72.2% composite, 78% test-pass, 2 stuck, 15 rework; re-run after each landed phase (Part 1.9 gate) |

**Total ≈ 10–11 weeks.** Fast value path: `A1 → C1 → C2(verify upgrade) → C3 → E1 →
E3(menu-deletion + clarify-as-tool) → H1(+suggest_followups/ask_user)` — note H1 needs the
**complete C chain** (H1 depends on C3, which needs C2). The menu-deletion + mandatory-verify
sub-deliverable can land right after C2 (rules pre-filter + model confirms intent); H1 requires
C3+E1. Vault, verified NLU dispatch, shell visibility, mode-menu deletion, and the tool registry
(the Freebuff/Hermes core mechanism) deliver the majority of user-visible value in ~3–4 weeks;
the rest of E3 (pipeline-as-tool, follow-ups, CLI declutter) lands with C3/E2, and H2/I/J build
capabilities on the H1 foundation. **K–N re-scoped (2026-08-08):** the K–N items are classified by WORTH, not
schedule. "Unblocked" means the row's dependencies are green — it does NOT mean "next": the core
path B1 → J3 is unchanged and **B1 is the next row in order**. K3 (vault audit) and K4 (RBAC
enforcement) are unblocked (both reuse pre-existing infra), so they MAY be picked up as small
self-contained hardening at any point — but they are optional quick wins, never a reason to skip
core capability rows. M1's vault+workspace legs are unblocked (A1/A2 ✅); its memory leg waits for
B1. K1/K2/M3 are deferred until (C1, B2, H1); L is folded into J3; M4 extends the existing CI
matrix; N is a one-time license note.

**Session-sized execution (how to run this plan one Freenuvira session at a time):**
- **One session = one row's sub-deliverable.** Rows marked S (2d) fit in a single session;
  M (3–4d) rows are 1–2 sessions; L (5d) rows (E2, E3) MUST be split into session-sized chunks
  (e.g. E2 as: (a) ink skeleton + non-TTY fallback, (b) shell lanes via E1 events, (c) retry
  lanes, (d) plan/eval/benchmark mounts).
- **Session rule:** start every session by reading the target phase's `Implementation reference`
  block + the relevant clone files, end by updating `REVAMP_PROGRESS.md` (status + what landed
  vs. remains).
- **Never start a row whose `Depends on` column contains a ⬜ in `REVAMP_PROGRESS.md`.**
- **Each session leaves the repo green:** `npx tsc --noEmit` + the affected vitest file pass
  before the row is marked done.

---

## Part 4 — Explicitly out of scope (do NOT do)

- ❌ spaCy / spaCy-Python-sidecar / JointBERT / fine-tuned transformers — **falsified as the
  Freebuff/Hermes backbone (§1.5)**; no TS binding; JointBERT is Apache-2.0 + unmaintained;
  LLM-native tool-call dispatch + rules instead (Phase C).
- ❌ Mem0 as a hard dependency — opt-in backend only (F1).
- ❌ Full agent framework adoption (LangChain / Vercel AI SDK loop) — agent's multi-agent pipeline
  + 17-adapter router is a strength; borrow only focused libraries (tool-schema slice at most).
- ❌ OS-keychain as a required dependency — Tier 2 AES fallback keeps it optional.
- ❌ Storing credentials in Mem0 / vector store — vault only.
- ❌ Removing existing CLI commands — Phase E3 is alias-only, fully backwards-compatible.
- ❌ Replacing trajectory-store / pattern-extractor / failure-lessons — the plan extends them.
- ❌ Paid SaaS as a required dependency — every new capability (web research, browser, image,
  voice, vision, gateway) uses OSS/MIT libraries or free tiers; nothing hard-depends on a paid API.
- ❌ Forcing heavy optional installs — Playwright browsers, ComfyUI, whisper, and gateway bots are
  opt-in installs behind `isAvailable()` gating, never bundled by default.
- ❌ Rebuilding the multi-agent pipeline — the plan registers existing agents as tools (H1) and
  delegates through the existing orchestrator (H2), rather than replacing it with a framework.

---

## Part 5 — Risks & mitigations

| Risk | Mitigation |
|---|---|
| Mandatory per-request verify adds cost/latency | Understanding is the product, not the cost center: one cheap-model call (fractions of a cent) is dwarfed by the cost of a wrong execution; rules pre-filter → small verify prompt; prompt-cache headers (H1) on the system prompt |
| Rule misread dispatches a half-understood requirement | C2 `requirementState` gate — a pipeline never runs until 'complete'; a needs-clarification request resolves via the in-loop `ask_user` tool (E3) instead |
| `ink` TUI vs existing ANSI board regression | Keep `--json-events` + non-TTY static-frame path; E2 acceptance gated on both modes |
| `node:sqlite` version availability | Feature-detect `node:sqlite`; JSON-file fallback tier (existing stores already JSON); bump `engines` to ≥22.5 (node:sqlite) or document the fallback as default on older Node |
| Mem0 SDK changes | Behind `MemoryProvider` interface; availability-gated CI tests |
| Vault fallback key management | Clear `nuvira config` UX + `nuvira doctor` guidance; keys always masked (secrets.ts) |
| Auto-dispatch misread (E3) | Confidence threshold → single inline confirm; rule fallback → legacy menu; undo via board |
| execa migration breaks call sites | Single choke point + orchestrator emission tests; keep `execSync` wrapper during transition |
| Native tool-calling unsupported on a provider | JSON-parse fallback path (H1) — same schema, two transports; acceptance tests both |
| Optional packs (browser/voice/image) add weight | `isAvailable()` gating + lazy install via `nuvira tools install`; never bundled by default |
| Gateway bots (Telegram/Discord/WhatsApp) expose attack surface | Tokens via vault (A1); allowlist of chat IDs; bot receives only parsed requests, never raw shell |
| Cron jobs run while agent is idle | Guard: jobs only fire when a gateway or CLI session is active; `nuvira admin cron pause` kill-switch |
| Skills hub installs untrusted code | Provenance + checksum recorded, sandboxed install dir, user confirmation before install |

---

## Part 6 — How this plan answers the original questions

- **Freebuff vs Mem0?** Freebuff-style persistence as the default local tier (A1/A2),
  Mem0-style fact memory on the existing FAISS store (B1), Mem0 itself as an opt-in backend (F1).
- **Will the agent close tasks superficially?** No — each phase has concrete files, tests, and
  acceptance criteria; nothing is a thin layer.
- **Why so many modes?** Phase E3 removes the mode menus; chat becomes the single intent-first
  surface with internal dispatch, matching Freebuff/Hermes.
- **Does the user need to run commands?** No — Phase D makes recall + health checks agent-driven.
- **Is agent-nuvira's real execution low-grade vs Freebuff/Hermes?** Where it genuinely is (live
  activity granularity, shell visibility, inline failure handling, plan-phase transparency) —
  Phase E fixes it using the same EventBus infrastructure that already exists.
- **Does the plan need spaCy (per Copilot)?** No — verified against the cloned Freebuff/Hermes
  repos that neither uses spaCy (§1.5); the real methodology (LLM-native tool dispatch in one
  loop) is what Phase C implements, with the valid MIT/TS pieces (recognizers-text-datetime,
  wink-nlp/compromise) replacing Copilot's Python-bound stack.
- **Is NLP cost-first in this plan?** No (re-scoped Session 7c) — the earlier "zero-cost"
  framing was wrong for the experience. Freebuff/Hermes understand EVERY request with the model
  (no classifier) and manage cost via prompt caching + cheap models, never by skipping
  understanding. Agent-nuvira now does the same: mandatory C2 verify per request, rules as
  pre-filter/offline fallback, a requirement-completeness gate that blocks half-understood
  dispatches, clarify-as-tool, and Freebuff-style `suggest_followups` follow-up recommendations
  (§1.8).
- **Would a developer choose us over Freebuff/Hermes?** Not today, and not on borrowed parity
  alone (§1.9). We win ONLY on the axes they lack: execution recovery (repair+verify+lessons —
  built), anti-half-understanding (requirementState gate — planned), availability (17-provider
  failover + offline rules — built), and it is PROVEN by the black-box benchmark (row 35), not
  asserted. Every phase's acceptance moves a benchmark metric — the anti-coverup rule.
- **What does agent-nuvira lack vs Freebuff/Hermes?** §1.6 lists 17 evidence-backed gaps ranked
  🔴→🟢. The majors: no native LLM tool-calling loop, no in-process sub-agent spawning, no web
  research, no browser automation, no image/voice/vision, no chat gateway, no cron, no skills hub.
  Phases H, I, J close them with OSS/free tools only — so end users get Freebuff/Hermes-class
  capability with zero paid dependencies.
- **Enterprise readiness?** Phases K–N cover the operational layer Freebuff/Hermes don't ship —
  re-scoped to what's genuinely missing: **vault audit (K3)** (the vault today has zero access
  logging), **RBAC enforcement (K4)** (the engine exists but never denies), and **integration
  tests (M1)** for the new foundation. These are classified as "unblocked", NOT "next" — the
  core path (B1 → J3) still runs first and B1 is the next row; K3/K4/M1 are optional quick wins
  whose dependencies are already green. Structured logs (K1), metrics (K2), and schema validation
  (M3) are deferred until their dependencies land; L folds into J3; M4 extends the existing CI;
  N is a one-time license note — all reusing existing modules (audit-chain, rbac.ts, skill-store,
  node:sqlite) rather than adding parallel systems.
