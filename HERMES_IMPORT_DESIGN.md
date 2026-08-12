# Import Design — Hermes Capabilities, Messaging & Artifacts into Agent-Nuvira

> **Date:** 2026-08-12
> **Status:** Design (analysis complete, no code written for this design yet).
> **Method:** Direct code analysis of the NousResearch hermes-agent install
> (`~/.hermes/hermes-agent`, git checkout) and this repo's `src/`.
> **Derived from:** [HERMES_ECOSYSTEM_INTEGRATION_PLAN.md](HERMES_ECOSYSTEM_INTEGRATION_PLAN.md)
> (P0–P3 skills/MCP plan) — this document extends it with three more pillars.
>
> **Desired outcome (user's words):** *import Hermes' capabilities, messaging
> and artifacts into our agent; front end handled by the dashboard; users
> consume tools and skills developed for Hermes inside our agent.*

---

## 1. What "capabilities, messaging, artifacts" actually are in Hermes (code evidence)

### 1.1 Capabilities = **Toolsets**

Hermes has no "capability" module per se — the UI concept maps to **toolsets**:

- `hermes_cli/setup.py:3266` — `from toolsets import TOOLSETS` (the registry).
- `hermes_cli/web_server.py:13724` — `_MODEL_CATALOG_TOOLSETS` (config-driven
  catalog of toolset entries: name, tools, provider, env).
- `hermes_cli/web_routers/tools.py` — `get_toolsets(profile)` endpoint + per-
  toolset config read/write; `_CONFIG_ONLY_TOOLSETS` (toolsets with no in-code
  tools, config-only).
- `hermes_cli/toolset_validation.py` — toolset config validation.
- Capability **gating** is explicit: `tests/tools/test_mcp_capability_gating.py`,
  `tests/tools/test_mcp_utility_capability_gating.py` — MCP tools only appear
  in the model's schema when their capability/toolset is enabled.
- Toolset examples: browser, web, vision, image-gen, video-gen, tts,
  computer-use, kanban, mcp, email, … Each toggles on/off, picks a provider,
  holds API keys (`ToolsetConfigDrawer.tsx` in the web UI).

**Takeaway:** a *capability* = a named group of tools with enable/disable +
provider/config state, and the **model's tool schema is built from enabled
groups only**.

### 1.2 Messaging = the **gateway**

`~/.hermes/hermes-agent/gateway/` is a full multi-channel messaging bus:

- `platforms/` — 20+ transports (signal, whatsapp_cloud, qqbot, weixin,
  yuanbao, bluebubbles, msgraph_webhook, api_server, …) plus
  `ADDING_A_PLATFORM.md` (the plugin contract for new channels).
- `channel_directory.py` — cached map of reachable channels/contacts, rebuilt
  every 5 min, saved to `~/.hermes/channel_directory.json`, with a
  user-maintained `channel_aliases.json` friendly-name overlay.
- `delivery.py` + `delivery_ledger.py` — **guaranteed delivery**: failed sends
  are ledgered and retried; `lifecycle_ledger.py` tracks channel lifecycle.
- `hooks.py` + `builtin_hooks/` — post-tool-call / session-end hooks.
- `profile_routing.py`, `mirror.py`, `pairing.py`, `drain_control.py`,
  `kanban_watchers.py`, `memory_monitor.py` — routing, mirroring, drain.

### 1.3 Artifacts = **deliverable tool outputs, auto-appended to the session**

- `gateway/run.py:1496` — "artifacts should be eligible for automatic append
  when the model omits them"; `run.py:1552` — "Tools in this set return their
  deliverable artifact as a JSON payload"; `run.py:1583` — docs, logs, search
  results, TTS audio are artifact kinds; `run.py:4700` — self-heal artifacts.
- `tools/kanban_tools.py` — structured tool-call surface returning JSON the
  model can reason about (the "better errors / no shell-quoting" pattern).
- `tools/environments/base.py` + `tools/read_preview_tool.py` — artifact
  previews from sandboxed environments (local/docker/singularity).

**Takeaway:** an *artifact* = a typed deliverable (file / doc / log / media /
data) produced by a tool, automatically attached to the session, previewable
in the UI.

---

## 2. What agent-nuvira already has (honest baseline)

| Pillar | We have | Gap vs Hermes |
|---|---|---|
| **Capabilities** | `src/tools/registry.ts` — ONE declarative zod-schema registry (`Tool{name, description, category, inputSchema, endsAgentStep, run}`), schema derived via `z.toJSONSchema`, used by native tool-calling providers. Categories: `pipeline / experience / workflow` | **No toolset layer** — no groups, no enable/disable, no provider/config state, no schema gating |
| **Messaging** | `src/gateway/` — a **deliberate Hermes mirror** (J1): `channel-directory.ts` ("mirrors Hermes `channel_directory.py`"), `adapters.ts` ("Hermes `gateway/` transport model"), Telegram long-poll + Discord/Slack/WhatsApp webhooks, HMAC verification, alias persistence to `~/.buff/gateway/aliases.json`; `src/federation/` A2A client/server (agent↔agent) | 4 platforms vs 20+; **no delivery ledger/retry, no hooks, no profile routing**; A2A covers agent-comms but not human-channels |
| **Artifacts** | `ContextVault.artifacts: Artifact[]` + `addArtifacts()/getArtifacts()` (`src/agents/context-vault.ts:19,78-86`) — per-run file artifacts, checkpointed/resumed | No artifact *kinds*, no tool→artifact JSON convention, no auto-append, no per-session artifact store/UI |
| **Front end** | Dashboard (pure-Node HTTP + SSE, `src/web-dashboard/server.ts`) with read-only telemetry panels; routes pattern + admin gate (`verifyAdmin`) already exist | No skills/toolsets/channels/artifacts pages; no write routes |

**Conclusion:** we are closer than it looks. Messaging is a *scale-up of an
existing mirror*; capabilities and artifacts need **new small layers** over
existing foundations (`tools/registry.ts`, `ContextVault`). No system needs to
be thrown away.

---

## 3. The import design (how we achieve the desired outcome)

### 3.1 PILLAR A — Capabilities: import the toolset model

**New module `src/tools/toolsets.ts`** (mirror of Hermes `toolsets` +
`toolset_validation.py`):

```ts
/** A named group of registry tools — the "capability" the user toggles. */
export interface ToolsetDef {
  name: string;                       // 'browser' | 'web-research' | 'mcp' | 'publish' | ...
  label: string;                      // human name for the dashboard
  description: string;
  /** Tool names from src/tools/registry.ts grouped into this toolset. */
  tools: string[];
  /** Toolsets that never have in-code tools (config-only), Hermes-style. */
  configOnly?: boolean;
  /** Optional provider/env contract surfaced by the config drawer. */
  provider?: { envVars: string[]; picker?: boolean };
  /** mcp:* special form — dynamically binds MCP server tools. */
  bindsMcpServers?: boolean;
}

/** Effective tool set: the registry filtered to ENABLED toolsets. */
export function effectiveTools(disabled: string[]): Tool[];
```

- **Persistence:** `tools.toolsets.<name>.enabled` in `~/.buff/buffconfig.json`
  (the same config `ConfigManager` already reads). Default all-enabled.
- **Schema gating (the Hermes capability gate):** when building the tool
  schema handed to native tool-calling providers, include only tools from
  enabled toolsets — `tool-loop.ts` / wherever `ToolJsonSchema[]` is assembled
  consults `effectiveTools()`. MCP tools bind to the `mcp` toolset.
- **Seed toolsets** from the existing categories: `core` (pipeline), `mcp`,
  `web-research`, `publish`, `document`/`artifact`, `ask-user` (experience).
- **Dashboard:** `ToolsPanel` = toolsets grid with switch + config drawer
  (mirrors `ToolsetConfigDrawer.tsx`) + per-tool schema accordion.

### 3.2 PILLAR B — Messaging: scale the existing J1 mirror

**Phase B1 (small, high value):** guaranteed delivery + hooks.

- `src/gateway/delivery.ts` — send queue with retry/backoff, persisted to
  `~/.buff/gateway/delivery.json` (mirror `delivery.py` + `delivery_ledger.py`).
  `ChannelAdapter.send()` failures enqueue; a ledger shows pending/failed.
- `src/gateway/hooks.ts` — hook registry (`post_tool_call`, `on_session_end`)
  wired to the existing `observability/event-bus.ts` consumers (we already
  have the bus — hooks become typed consumers).

**Phase B2 (medium):** platform registry + more channels.

- `src/gateway/registry.ts` already exists — promote it to the
  `ADDING_A_PLATFORM.md` pattern: a `PlatformAdapter` interface + per-platform
  files, so adding Signal/iMessage/Email/Matrix is one file + env vars, not a
  core edit. Seed with **email (SMTP/IMAP)** and **Signal** (the two most
  requested Hermes channels that map cleanly to pure-fetch adapters).
- Extend `ChannelDirectory` with Hermes' periodic rebuild + reachable-channels
  cache (`~/.buff/gateway/directory.json`) on top of today's alias store.

### 3.3 PILLAR C — Artifacts: adopt the tool→artifact convention

**Extend the existing `ContextVault.artifacts`:**

```ts
export type ArtifactKind = 'file' | 'doc' | 'log' | 'media' | 'data' | 'link';
export interface Artifact {
  id: string;
  kind: ArtifactKind;
  title: string;            // human title (e.g. 'deploy report')
  path: string;             // file path (vault-relative or absolute)
  mime?: string;
  sizeBytes?: number;
  preview?: string;         // truncated text / first lines
  source: 'tool' | 'agent' | 'manual';
  createdAt: number;
}
```

- **Tool convention (Hermes `run.py:1552` parity):** any tool whose output is
  a deliverable returns JSON `{ artifact: {...}, result: "...text..." }`; a
  small wrapper in the tool-execution loop auto-appends to the vault
  (`auto-append` when the model omits the artifact, Hermes `run.py:1496`
  parity). `log`/`doc` artifacts get previews via a
  `read_preview` helper (Hermes `read_preview_tool.py` parity).
- **Persistence + UI:** per-session artifact dir
  `~/.buff/memory/artifacts/<sessionId>/` + `artifacts.json` index (the
  dashboard already reads memory-dir JSON). Dashboard `ArtifactsPanel` lists
  artifacts per session with kind badges, preview, open-link.

### 3.4 PILLAR D — Consume Hermes-built tools & skills (ties into the existing plan)

| Hermes artifact | Import mechanism | Where planned |
|---|---|---|
| **Skills** (`SKILL.md`) | Runtime skill-index bridge + git-repo registry source | P0/P1 of [HERMES_ECOSYSTEM_INTEGRATION_PLAN.md](HERMES_ECOSYSTEM_INTEGRATION_PLAN.md) |
| **MCP servers** (`optional-mcps/*/manifest.yaml`) | Curated catalog + `buff mcp install`; our SDK already speaks stdio/Streamable-HTTP | P2 of the plan; **catalog ingestion may read a repo's `optional-mcps/` dir directly** (new: git repos often ship MCP manifests, not just skills) |
| **Hermes native Python tools** | ❌ Not importable directly; sanctioned path = consume their **MCP side** (Hermes serves tools over MCP itself — `tools/mcp_tool.py`) or port the tool's *schema* into our registry | Design note only |
| **Toolset configs** (providers, keys) | Map `~/.hermes` toolset config → our `tools.toolsets` config on a per-name basis; env vars carried over | Pillar A |

### 3.5 PILLAR E — Dashboard front end (one page, sections — the concept you liked)

A single **"Agent Hub"** page with four tabs, mirroring Hermes' page model:

| Tab | Panel | Backend (new routes in `src/web-dashboard/server.ts`) |
|---|---|---|
| **Skills** | 3 views: installed/indexed, toolsets summary, **hub browser** (search + install) | `GET /api/skills`, `POST /api/skills/toggle` (from P3 of the plan) |
| **Tools** | Toolset grid (switch + config drawer + provider/keys) + tool schema accordion | `GET /api/toolsets`, `POST /api/toolsets/toggle`, `PUT /api/toolsets/<name>/config` |
| **Channels** | Platform status (configured/reachable), aliases, send-test, delivery ledger | `GET /api/channels`, `POST /api/channels/send`, `GET /api/delivery` |
| **Artifacts** | Per-session artifact browser (kind badges, preview, open) | `GET /api/artifacts?session=…` |

All write routes follow the existing dashboard conventions: input validation,
admin-gated via `verifyAdmin` when `isAdminConfigured()`, try/catch → JSON
error, never crash the server. Toggles persist to `~/.buff/buffconfig.json` /
`~/.buff/mcp/*.json` and are **honored by the runtime** (Pillar A gating is the
single enforcement point — same lesson as the skills plan).

---

## 4. File map

### New files

| File | Pillar |
|---|---|
| `src/tools/toolsets.ts` | A — toolset defs + `effectiveTools()` gating |
| `src/tools/toolsets-config.ts` | A — read/write `tools.toolsets.*` in buffconfig |
| `src/gateway/delivery.ts` | B — send queue + ledger + retry |
| `src/gateway/hooks.ts` | B — hook registry → event-bus consumers |
| `src/gateway/platforms/email.ts`, `signal.ts` | B — new adapters (pure fetch) |
| `src/agents/artifact-types.ts` | C — `ArtifactKind`/`Artifact` types |
| `src/tools/artifact-append.ts` | C — tool→artifact JSON wrapper + auto-append |
| `src/web-dashboard/src/components/AgentHubPage.tsx` | E — 4-tab hub page |
| `src/web-dashboard/src/components/{ToolsetsPanel,ChannelsPanel,ArtifactsPanel}.tsx` | E |

### Modified files

| File | Change |
|---|---|
| `src/tools/registry.ts` | Add `toolset` field per Tool (or a parallel map) |
| tool-schema assembly site (`src/tools/tool-loop.ts`) | Gate schema by `effectiveTools()` |
| `src/agents/context-vault.ts` | Use extended `Artifact` type; keep API stable |
| `src/gateway/adapters.ts`, `channel-directory.ts` | Platform registry pattern + directory rebuild |
| `src/web-dashboard/server.ts` | 9 new routes |
| `src/web-dashboard/src/App.tsx`, `components/Layout.tsx` | Hub page route + nav |

---

## 5. Phasing & effort

| Phase | Pillar(s) | Deliverables | Effort | Depends on |
|---|---|---|---|---|
| **I1** | A (core) | `toolsets.ts` + gating + config | S–M | — |
| **I2** | B (delivery+hooks) | `delivery.ts`, `hooks.ts` | S–M | — |
| **I3** | C (artifacts) | artifact types + append wrapper + store | S–M | — |
| **I4** | A+B+C dashboard | read routes + 4-tab hub page (read-only) | M | I1–I3 |
| **I5** | A+B toggles | write routes, admin-gated; gating honored | S | I4 |
| **I6** | B2 channels | email + signal adapters, platform registry | M | I2 |
| **I7** | D | ties to skills-plan P0/P1/P2 (bridge, git-repo registry, MCP catalog) | (per plan) | plan P0–P2 |

Recommended order: **I1 → I2 → I3 → I4 → I5**, with I6/I7 parallel later.
I7 deliberately reuses the already-approved skills/MCP plan rather than
duplicating it.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Toolset gating breaks existing behavior | Default = all enabled; gating only filters *disabled*; full regression on tool-calling tests |
| Delivery ledger grows unbounded | Cap + prune window (keep last 500 entries), same as quota ledger |
| Artifact store disk bloat | Preview truncation + size cap; store index JSON, files stay in place |
| Python tool import expectation (Hermes native tools) | Set expectation in UI/CLI: consume via MCP; never promise Python import |
| Dashboard toggles ignored by runtime | Same rule as skills plan: runtime gating is the single enforcement point; toggles wired only after I1 |

---

## 7. Bottom line

- **Capabilities** = a toolset layer over our existing declarative registry
  (group → toggle → provider config → schema gating). New, small, high-value.
- **Messaging** = scaling our **already-Hermes-shaped** gateway: delivery
  ledger, hooks, platform registry, 2 more channels. No rewrite.
- **Artifacts** = a typed, auto-appended extension of the `ContextVault`
  artifacts we already carry through checkpoints/resume.
- **Front end** = one dashboard "Agent Hub" page (Skills/Tools/Channels/
  Artifacts) built on the existing pure-Node REST+SSE server, admin-gated
  writes, runtime-honored toggles.
- **Consuming Hermes-built assets** = the existing skills/MCP plan (P0–P2),
  plus one addition: MCP-catalog ingestion can read a repo's `optional-mcps/`
  manifests directly. Native Python tools remain MCP-only.

*Analysis grounded in direct reads of `~/.hermes/hermes-agent` and this
repo's `src/` on 2026-08-12. Design only — no code changed.*
