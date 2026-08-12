# Project Document — Hermes Ecosystem Integration

> **Document:** `HERMES_ECOSYSTEM_INTEGRATION_PLAN.md`
> **Date:** 2026-08-12
> **Status:** Approved-for-planning (P0-P2 scope). No code from this plan is
> implemented yet; the assessment it derives from is complete.
> **Predecessor:** [ASSESSMENT_HERMES_ECOSYSTEM.md](ASSESSMENT_HERMES_ECOSYSTEM.md)
> (gitignored internal reference — direct inspection of the NousResearch
> hermes-agent install and this repo).
> **Companion docs:** [ARCHITECTURE.md](ARCHITECTURE.md),
> [UPGRADE_ROADMAP.md](UPGRADE_ROADMAP.md), [ROADMAP_TODO.md](ROADMAP_TODO.md),
> [ASSESSMENT_WEBSITE_DEPLOY.md](ASSESSMENT_WEBSITE_DEPLOY.md).

---

## 0. Executive summary

Agent-Nuvira must be able to **leverage the open Agent Skills ecosystem** —
the same `SKILL.md`-based skills that Hermes, OpenClaude, Claude Code, Codex
and the `agentskills.io` community produce — as **first-class runtime
capabilities**, not just files on disk. The format compatibility already
exists (our Skills Hub installs standard `SKILL.md`); the missing piece is a
**runtime skill-index bridge** that makes installed skills matchable and
injectable into the planner, exactly like our bundled/compiled skills already
are.

This document is the implementation plan. It is organized in **four phases**
plus a deferred GUI phase, each with file-level changes, data contracts, test
plans, and a definition of done:

| Phase | Name | Effort | Outcome |
|---|---|---|---|
| **P0** | Runtime skill-index bridge | Small–Medium | `.agents/skills/*/SKILL.md` become real, matchable, injectable skills |
| **P1** | Multi-source registry (browse-hub equivalent) | Small | `buff skills search` across GitHub raw + `browse.sh` + git repos + local dirs |
| **P2** | Curated MCP catalog + installer | Small | `buff mcp catalog` / `buff mcp install` over Nous-approved pins |
| **P3** | Dashboard Skills/MCP/Tools pages | Medium | The 3-view management UI (read-only first, then enable/disable) — **Skills part shipped** (I4/I5 pre-built the tabs; P3 round adds the per-skill enable/disable surface + `skills.disabled[]` toggle route; MCP/Tools panels deferred to the GUI release) |
| **P4** | Full GUI release (browse wizards, OAuth, plugin installs) | Large | Deferred — see §12 |
| **I1–I7** | **Import pillars** — capabilities (toolsets), messaging (delivery+hooks+channels), artifacts, Agent Hub dashboard | M–L total | Design in [HERMES_IMPORT_DESIGN.md](HERMES_IMPORT_DESIGN.md); phasing in §8.1 |

**Success criteria (top line):** a goal like *"Use the `github-pr-workflow`
skill to open a PR"* matches an installed hub skill, injects its methodology,
and the pipeline executes it — with zero hand-editing of skill files.

---

## 0.1 Coverage matrix — will this make agent-nuvira consume Hermes-built skills & tools?

The short answer: **yes for skills and MCP-served tools; no (deferred) for native
Python plugins**. "Git repos developed for Hermes" ship three kinds of things —
this is how each is (or isn't) covered:

| Hermes-repo artifact | Consumable? | Via what | Caveat |
|---|---|---|---|
| **Skills** (`<name>/SKILL.md`, the bulk of the ecosystem) | ✅ **Yes** | P0 bridge (match + inject) + P1 `git-repo` registry source (shallow clone → index `skills/` → install) | Repos vary in layout (`skills/`, root, `.claude/skills/`, per-plugin). P1 adapter must probe multiple layouts — see §12 R2 / §5.2 refinement |
| **MCP servers** (portable Agent Plugins v1.0.0 — `plugin.json` → stdio/Streamable-HTTP MCP) | ✅ **Yes — works today** | Our `MCPClient` already runs the official MCP SDK with `stdio` + Streamable HTTP (`src/mcp/client.ts:2,25-26`) — same transports Hermes uses. P2 adds a curated catalog + `buff mcp install` convenience | `MCPServerConfig.enabled` already exists (`src/mcp/types.ts:189`) — the dashboard toggle has a backend to write to |
| **Skill `scripts/`** (python/bash helpers referenced by SKILL.md) | 🟡 **Partial** | The bridge never executes scripts directly (security), but the **runner** runs them as normal commands when the injected SKILL.md says so (`python scripts/foo.py`) | Exactly how Hermes skills behave too — skills are instructions, the agent invokes the tools |
| **Native Python plugins** (`plugin.yaml` + `register(ctx)` + `tools.py`/`schemas.py`) | ❌ **Deferred** | Not in P0–P3. Most plugin capabilities map to native features (cron, memory hooks, tools registry); Hermes' own portable `plugin.json` → MCP bridge is the viable future adapter | If a must-have Hermes plugin appears, consume its MCP side, not the Python side |

**Bottom line for this question:** the plan makes agent-nuvira able to consume
**skills** (the primary value of Hermes git repos — 71 on this machine alone
plus the whole agentskills.io ecosystem) and **MCP-served tools** (already
functional; P2 polishes it). The only deliberate gap is **native Python
plugins**, which are explicitly out of P0–P3 with a documented bridge path.

---

## 1. Context & background

### 1.1 What Hermes is (installed at `~/.hermes`)

- **NousResearch/hermes-agent** git checkout (Python agent + TUI + web UI +
  desktop app) with **71 installed skills** in `~/.hermes/skills/` across 13
  categories.
- Skills follow the **Agent Skills open standard**: `<name>/SKILL.md` with YAML
  frontmatter (`name`, `description`, `version`, `author`, `license`,
  `platforms`, `tags`, `metadata.*`, `prerequisites.commands`) + optional
  `scripts/`, `references/`, `assets/`, `examples/`.
- Extension model: skills (SKILL.md), plugins (`plugin.yaml` + Python),
  MCP servers (curated `optional-mcps/` catalog), browse hub (`hermes skills
  browse|search` against `browse.sh`).
- Web UI: **SkillsPage with 3 views (`skills` / `toolsets` / `hub`)** + a
  **"Browse hub"** button; **McpPage** with enable/disable/test/OAuth;
  `ToolsetConfigDrawer` for backend config (toggle, provider, API keys, install
  hooks).

### 1.2 What agent-nuvira already has

| Surface | File(s) | Runtime role |
|---|---|---|
| Compiled SkillStore (trajectory + bundled skills) | `src/learning/skill-store.ts`, `src/skills/bundled-skills.ts` | ✅ `findMatch()` → planner skill-guidance injection |
| Skills Hub (community SKILL.md installer) | `src/learning/skills-hub.ts`, `src/cli/skills.ts` | ⚠️ Installs to `.agents/skills/` — **never read at runtime** |
| Tools registry | `src/tools/registry.ts`, `src/cli/tools.ts` | ✅ Built-in tools |
| MCP manager | `src/mcp/manager.ts`, `src/cli/mcp.ts` | ✅ Stdio/SSE/HTTP discovery + invocation |
| Marketplace / plugins | `src/cli/marketplace.ts`, `src/cli/plugins.ts` | ✅ Native plugins + workflow templates |
| Web dashboard | `src/web-dashboard/` | ⚠️ Read-only telemetry; no skills/tools/MCP pages |

### 1.3 The core gap (confirmed by code search)

`agents/skills` and `SKILL.md` appear **only** in `src/learning/skills-hub.ts`
and `src/cli/skills.ts`. Nothing in `src/agents/*`, `src/cli/*` (runtime), or
`src/learning/skill-store.ts` reads them. **Installed hub skills are dead
weight today.**

---

## 2. Goals, non-goals, success criteria

### 2.1 Goals

1. **P0:** Make installed `SKILL.md` skills first-class runtime capabilities
   (catalog → match → inject → execute).
2. **P1:** Let users discover skills from more than one registry.
3. **P2:** Give users a curated, vetted MCP server catalog.
4. **P3:** Manage skills/tools/MCP from the web dashboard (the 3-view concept).
5. Keep the existing security posture (sandboxed names, checksums, provenance,
   quarantine) and the "skill guidance never leaks literal commands" guardrail.

### 2.2 Non-goals (for this plan)

- Python plugin interop (Hermes `plugin.yaml`) — **deferred** (§12.1).
- Full OAuth flows / browser-based install wizards — **P4**.
- Multi-user / server deployment of the dashboard.
- Replacing our compiled SkillStore — the hub bridge **complements** it.

### 2.3 Success criteria

| # | Criterion | How to verify |
|---|---|---|
| S1 | `buff skills install <name>` → the skill is immediately matchable by `buff execute "<goal>"` | End-to-end test with a local fixture registry |
| S2 | Matched hub skill injects its SKILL.md methodology into the planner (L1), with only name+description in the catalog (L0) | Planner prompt snapshot in test |
| S3 | `skills.disabled` config excludes a skill from matching | Unit test on the catalog filter |
| S4 | `buff skills search <q> --source browse-sh` returns external results | Live test against `browse.sh` API |
| S5 | `buff mcp install <name>` from the catalog writes `~/.buff/mcp/<name>.json` | Unit + integration test |
| S6 | Dashboard `/skills` shows the 3 views and toggles persist | Component tests + manual run |

---

## 3. Architecture (current → target)

### 3.1 Current state

```
user goal
   │
   ▼
orchestrator ──► SkillStore.findMatch() ──► (bundled/compiled JSON skills only)
   │                                          │
   │                                          ▼
   │                                 planner (skill-guidance injection)
   │
   └──► [.agents/skills/*]  ✗ NOT READ AT RUNTIME (install-only)
```

### 3.2 Target state (after P0–P2)

```
user goal
   │
   ▼
orchestrator ──► SkillIndex.lookup(goal)          ◄── unifies:
   │                ├─ SkillStore (compiled/bundled)     existing path
   │                └─ HubSkillCatalog (SKILL.md)        NEW (P0)
   │                      ▲ scan/parse .agents/skills + ~/.buff/skills
   │                      ▲ filter: skills.disabled[]
   │                      ▲ cache with mtime invalidation
   │                      ▼
   │               planner (L0 catalog + L1 SKILL.md body on match)
   │
   ├──► buff skills search --source <registry list>      (P1)
   ├──► buff mcp catalog | install <name>                (P2)
   └──► dashboard /skills /mcp /tools pages              (P3)
```

---

## 4. PHASE 0 — Runtime skill-index bridge

### 4.1 New module: `src/learning/hub-skill-index.ts`

The single most important artifact of the whole plan.

```ts
// ─── Types ────────────────────────────────────────────────────────────────

/** A skill discovered on disk, indexed from its SKILL.md frontmatter. */
export interface IndexedHubSkill {
  /** Frontmatter `name` (must equal directory name, per the standard). */
  name: string;
  /** Frontmatter `description` — drives matching. */
  description: string;
  /** Optional structured tags (frontmatter `tags` array or `metadata.*`). */
  tags: string[];
  /** Semantic version (default '0.0.0' if absent). */
  version: string;
  /** License, author, platforms, prerequisites — surfaced in UI/CLI. */
  license?: string;
  author?: string;
  platforms?: string[];
  prerequisites?: { commands?: string[] };
  /** Absolute path to the SKILL.md file. */
  path: string;
  /** Source root this skill was discovered from: 'project' | 'user' | 'hermes'. */
  origin: HubSkillOrigin;
  /** mtime of SKILL.md at last index — cache invalidation. */
  mtimeMs: number;
  /** True when the skill is enabled (not in skills.disabled[]). */
  enabled: boolean;
}

export type HubSkillOrigin = 'project' | 'user' | 'hermes';
```

**Discovery roots** (ordered, first-match wins on duplicate names):

| Root | Path | Notes |
|---|---|---|
| project | `<project>/.agents/skills/` | What `buff skills install` already writes |
| user | `~/.buff/skills/` | NEW — user-global skills |
| hermes (optional) | `$HERMES_SKILLS_DIR` or `~/.hermes/skills/` | Read-only interop: reuse the 71 installed skills **without copying**; flagged in the UI as "external origin" |

**Frontmatter parser** — implement a small YAML-lite extractor (do NOT add a
yaml dependency unless already present; the frontmatter is flat keys + simple
arrays). Parse the block between the leading `---` lines. Required fields:
`name`, `description`. Tolerate Hermes extensions (`metadata.hermes.tags`,
`prerequisites.commands`) by flattening `metadata.*.tags` → `tags`.

**Catalog cache:** in-memory `Map<string, IndexedHubSkill>` rebuilt on
`refreshHubIndex()`; a directory mtime/scan-on-demand strategy so a fresh
`buff skills install` is visible immediately (see S1).

**Matching** — `findHubMatch(goal: string): IndexedHubSkill | null`:

1. Tokenize the goal (lowercase, split non-alphanumerics — same normalization
   `SkillStore.findMatch` uses).
2. Score candidates: full `name` hit > any token in `name` > token in
   `description` > token in `tags`. Weighted, with a confidence floor (reuse
   the same threshold approach as the existing matcher).
3. Skip `enabled === false` skills before scoring.
4. Return the best candidate above the floor, else `null`.

**Enable/disable store** — read `skills.disabled: string[]` from
`~/.buff/buffconfig.json` (same config the dashboard and CLI already read via
`ConfigManager`). Default empty. A `setSkillEnabled(name, bool)` helper updates
the array. **The bridge is the single place that honors this** — so a future
dashboard toggle is not cosmetic.

### 4.2 Integration points (minimal, surgical)

| File | Change |
|---|---|
| `src/learning/skill-store.ts` | Add `lookupSkill(goal)` that tries compiled/bundled skills **then** `HubSkillCatalog.findHubMatch(goal)` — or export a small facade the orchestrator calls. Prefer a **facade in the new module** (`lookupSkill(goal)`) so `skill-store.ts` is untouched. |
| `src/agents/orchestrator.ts` | Replace/augment the pre-planning skill-match call (the exact seam that logs `🧠 Matched skill …`) to call the facade. Thread the matched hub skill's guidance through the same `matchedSkill` variable already used for injection. |
| `src/agents/agents/planner.ts` | The existing skill-guidance injection already handles "instructions as context, never emit literal commands" — hub skills flow through unchanged. L0: include catalog entries (name + description) for all enabled skills (cap at N=25 to bound tokens); L1: on match, include the SKILL.md body (truncate to ~8 KB). |
| `src/cli/skills.ts` | `buff skills list` gains an `--indexed` column/flag (`indexed` / `not-indexed`); new `buff skills status <name>` (enabled? origin? version?). |

### 4.3 Security model (unchanged guarantees)

- Names remain sandboxed at install (`^[a-z0-9-]+$`, no traversal) — already in
  `skills-hub.ts`.
- SKILL.md content is **instructions only**: the bridge never executes
  `scripts/` — the agent's runner executes commands through the existing
  shell/repair pipeline, exactly as it does today for bundled skills.
- Provenance + checksum + quarantine on mismatch remain the install path's
  contract.
- `skills.disabled` is defense-in-depth, not the security boundary.

### 4.4 Phase 0 tests

`tests/learning/hub-skill-index.test.ts`:

1. Frontmatter parser: valid, missing `name`, missing `description`, Hermes
   `metadata.hermes.tags`, `prerequisites.commands`, CRLF, no frontmatter.
2. Discovery: project root + user root + duplicate-name precedence.
3. `findHubMatch`: exact name > token-in-name > description > tags; below-floor
   returns null; disabled excluded.
4. Cache invalidation: SKILL.md mtime bump after install → visible (S1).
5. Planner injection: matched hub skill's body present in prompt; catalog
   entries at L0 capped; "NEVER emit literal" guardrail preserved (S2).
6. `setSkillEnabled` round-trip through config (S3).

**DoD-P0:** S1, S2, S3 green; typecheck; full suite still green; manual demo —
`buff skills install` a fixture → `buff execute` a goal referencing it.

---

## 5. PHASE 1 — Multi-source registry (browse-hub equivalent)

### 5.1 Configuration

```jsonc
// ~/.buff/buffconfig.json
{
  "skills": {
    "disabled": ["some-skill"],
    "registries": [
      "https://raw.githubusercontent.com/imdheerajKube/agent-nuvira/main/.agents/skills",
      "https://browse.sh/api/skills",          // browse-hub adapter
      "file:///Users/me/shared-team-skills"     // local/team dir
    ]
  }
}
```

`BUFF_SKILLS_REGISTRY` env var stays as the **legacy single-value override**;
when `registries[]` exists it wins. Order = priority; first registry with the
skill wins on install; install records `source` (already in provenance).

### 5.2 Source adapters (`src/learning/skills-registry.ts`, new)

```ts
export interface SkillRegistrySource {
  id: string;            // 'github-raw' | 'browse-sh' | 'git-repo' | 'local-dir'
  base: string;
  fetchIndex(): Promise<HubSkillEntry[]>;
  fetchSkill(name: string): Promise<string | null>;   // SKILL.md text
}
```

- **github-raw** — existing behavior (`{base}/index.json`, `{base}/{name}/SKILL.md`).
- **browse-sh** — adapter to `browse.sh` API shape (map response → `HubSkillEntry`).
- **git-repo** — clone into `~/.buff/skills-hub/repos/<hash>/` (shallow, pinned
  commit or branch), index `skills/` dir; refresh via `git fetch` on `--refresh`.
- **local-dir** — existing local-registry path.

### 5.3 CLI surface

`buff skills search <q> [--source <id>]` — search all configured sources (or
one); results tagged with source. `buff skills install <name> --source <id>`
pins the source (provenance already records `source`).

### 5.4 Tests

Adapter fixtures for each source type (no network in unit tests; live
`browse-sh` verified manually once). Merge/dedupe behavior: same name in two
sources → priority order wins (S4).

**DoD-P1:** S4 green; search + install across ≥ 2 sources in a manual demo.

---

## 6. PHASE 2 — Curated MCP catalog

### 6.1 Catalog artifact

New `src/mcp/catalog.ts` (or JSON asset `src/mcp/catalog.json`) mirroring
Hermes' `optional-mcps/<name>/manifest.yaml` policy:

```jsonc
{
  "version": 1,
  "servers": [
    {
      "name": "github-mcp",
      "description": "GitHub API via MCP (repos, issues, PRs)",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github@0.6.2"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "prompt-secret" },
      "pins": { "npx": "exact-version" },
      "vettedBy": "nous-catalog"
    }
  ]
}
```

Policy (copied from Hermes, adapted): entries only via PR; exact-version pins;
2-week-old minimum for pin freshness; secrets prompted at install → written to
`~/.buff/.env` (never the config file); servers never auto-update.

**Seed set:** port the Nous-approved Hermes manifests (they're Apache/MIT
shipped manifests; re-verify licenses on port).

### 6.2 CLI surface (`src/cli/mcp.ts`)

- `buff mcp catalog [--search <q>]` — list catalog entries (installed badge).
- `buff mcp install <name>` — resolve manifest → prompt for `prompt-secret`
  env vars → write `~/.buff/mcp/<name>.json` (existing `MCPManager` config
  format) → `buff mcp test <name>`.
- `buff mcp uninstall <name>`.

### 6.3 Tests

Manifest → config writer (env placeholder resolution, no secrets in JSON);
install skips already-installed; test-command generation. **DoD-P2:** S5 green.

---

## 7. PHASE 3 — Dashboard Skills/MCP/Tools pages (the 3-view concept)

### 7.1 Server (`src/web-dashboard/server.ts` — pure-Node HTTP, no deps)

New routes (route table lives in the existing request handler):

| Route | Method | Purpose |
|---|---|---|
| `/api/skills` | GET | Indexed hub skills (from the P0 catalog) + compiled skills + install state + `skills.disabled` |
| `/api/skills/toggle` | POST | `{ name, enabled }` → `setSkillEnabled` (persisted to buffconfig) |
| `/api/skills/hub/search` | GET | Proxy `buff skills search --source …` (read-only, no tokens) |
| `/api/mcp` | GET | `MCPManager` discovered servers + enabled flags + catalog entries |
| `/api/mcp/toggle` | POST | `{ name, enabled }` → update `~/.buff/mcp/<name>.json` |
| `/api/tools` | GET | Tool registry list + schemas (existing `buff tools list` data) |

Follow the existing pattern exactly: `readJSON()` over memory-dir/state files +
`fetchWithTimeout` for outbound; every route try/catch → 500 JSON, never crash
the server. Write routes validate input (`name` allowlist regex) and are
admin-gated if `isAdminConfigured()` (reuse `verifyAdmin` from `admin-auth.ts`
— the dashboard already has this plumbing).

### 7.2 Frontend (`src/web-dashboard/src/`)

- **`components/SkillsPanel.tsx`** — **3 views** mirroring Hermes:
  `skills` (installed + indexed list, enable/disable switch), `toolsets`
  (grouped tools with schema view + config drawer placeholder), `hub`
  (search box + result list + install button). Reuses the `Switch`-style
  affordances already in the dashboard CSS.
- **`components/McpPanel.tsx`** — server list, enabled switch, `test` button
  (shows tool count), add-server form (name + command/url + env).
- **`components/ToolsPanel.tsx`** — registry list with input-schema accordion
  (read-only).
- Wire into `App.tsx` routes: `/skills`, `/mcp`, `/tools`; add nav entries in
  `Layout.tsx`.
- Component tests follow existing `*.test.tsx` conventions (mock `dashboardAPI`).

### 7.3 Why read-only first

The P0 bridge must exist and honor `skills.disabled` **before** the toggle is
wired — otherwise the dashboard lies. Build order within P3: read-only views →
verify → wire toggles.

**DoD-P3:** S6 green; manual run: install a skill via CLI, see it in `/skills`,
toggle it off, confirm `buff execute` no longer matches it.

> ✅ **P3 skills-toggles shipped (this session):** the Agent Hub Skills tab now
> mirrors the Tools tab — enabled/disabled summary cards + a per-skill switch
> on every compiled AND hub skill. `PUT /api/admin/hub/skills/<name>`
> (admin-gated, routing.operate) writes the SAME `skills.disabled[]` config
> the runtime reads, so a toggle is never cosmetic:
> - `src/learning/hub-skill-catalog.ts` — `setSkillEnabled()` (typo-safe writer,
>   whole-list semantics, validates against compiled + installed-hub ids)
> - `src/agents/orchestrator.ts` — the `skills.disabled[]` gate now ALSO
>   filters compiled `findMatch` results (previously hub-only), closing the
>   gap so both skill kinds honor the dashboard toggle
> - `src/web-dashboard/hub-data.ts` — `HubSkill.enabled` + `enabled/disabled`
>   counts derived from live config; `server.ts` route; `api.ts` client;
>   `AgentHub.tsx` switches + queue-behind-login behavior (same as toolsets)
> - Verified live: disable hub skill → `null` match; disable compiled
>   `skill-website-deploy` → `null` match; re-enable → matchable again
> - Tests: `setSkillEnabled` (disable/enable/unknown-id), hub-data count
>   reflection, Session 37 server route (401 / 400 / 200 write / 403 viewer)

---

## 7.1 Import pillars (capabilities / messaging / artifacts / Agent Hub) — I1–I7

> Full design: [HERMES_IMPORT_DESIGN.md](HERMES_IMPORT_DESIGN.md) — direct code
> analysis of the NousResearch hermes-agent install. Summary:

| # | Pillar | What | Files (new → modified) | Effort | Status |
|---|---|---|---|---|---|
| I1 | **Capabilities (toolsets)** | Toolset groups over `tools/registry.ts`; enable/disable + provider config in buffconfig; **schema gating** (model sees enabled groups only, Hermes capability-gate parity) | `src/tools/toolsets.ts` → `tool-loop.ts`, `cli/tools.ts`, `config/types.ts`, `config/manager.ts` | S–M | 🟢 Implemented (this session) |
| I2 | **Messaging: delivery + hooks** | Send queue with retry/backoff (`~/.buff/gateway/delivery.json`), hook registry → event-bus consumers (`tool:called`, session-end) | `src/gateway/delivery.ts`, `hooks.ts` → `registry.ts`, `tool-loop.ts`, `cli/gateway.ts`, `event-bus.ts` | S–M | 🟢 Implemented (this session) |
| I3 | **Artifacts** | Artifact kinds + tool→artifact JSON convention + auto-append + per-session store (`~/.buff/memory/artifacts/`) | `src/tools/artifact-types.ts`, `artifact-append.ts`, `artifact-store.ts` → `tool-loop.ts`, `chat.ts`, `registry.ts` | S–M | 🟢 Implemented (this session) |
| I4 | **Dashboard read views** | Agent Hub `/hub` — Skills/Tools/Channels/Artifacts tabs fed by `GET /api/hub` (`hub-data.ts` aggregation) | `src/web-dashboard/hub-data.ts` + `server.ts` + `AgentHub.tsx` | M | 🟢 Implemented (this session) |
| I5 | **Dashboard toggles** | `PUT /api/admin/hub/toolsets/<name>` (admin-gated, routing.operate), honored by I1 gating | `server.ts` + `AgentHub.tsx` | S | 🟢 Implemented (this session) |
| I6 | **More channels** | Email/Signal adapters + platform-registry pattern | `src/gateway/platforms/*` | M | ✅ shipped |
| I7 | **Hermes-asset consumption** | Skills bridge + git-repo registry + MCP catalog (incl. reading a repo's `optional-mcps/`) | per P0–P2 | (per plan) | ✅ P0–P2 shipped |
| I8 | **WhatsApp as a messaging platform** | `whatsapp` = personal Baileys bridge (QR pair, JID send/receive — Hermes' own layer, NO paid API); existing Meta Cloud adapter becomes the opt-in `whatsapp_cloud` platform (Hermes platforms.py parity). Session at `~/.buff/whatsapp/session/` (same creds.json layout as Hermes) | `src/gateway/whatsapp/{bridge,baileys-bridge,session}.ts` + `src/cli/whatsapp.ts` → `adapters.ts`, `channel-directory.ts`, `cli/gateway.ts`, `router.ts` | S–M | ✅ shipped (this session) |

> **I8 note (dogfood-driven):** the user's WhatsApp test exposed that our
> existing `WhatsAppAdapter` was the *paid* Meta Cloud API — Hermes' default is
> its own QR-paired Baileys bridge under the `whatsapp` platform. Shipped:
> `buff whatsapp pair|status`, `WhatsAppBridgeAdapter` (injectable bridge),
> `buff gateway send whatsapp:<number|jid>`, live `isPlatformConfigured('whatsapp')`
> (session presence, not env), send-before-open barrier, 0700 session dir.
> `baileys@7.0.0-rc14` pinned exact (prerelease).

| I9 | **All the other Hermes messaging connectors** | Webhook/REST outbound adapters for DingTalk, Feishu, WeCom, Mattermost, Matrix (homeserver API), generic Webhook, BlueBubbles (iMessage bridge, macOS) — Hermes `platforms.py`/`gateway/config.py` platform parity. Send-only; inbound stays on the shared WebhookReceiver (discord/slack/whatsapp_cloud) | `src/gateway/adapters.ts` → `channel-directory.ts`, `cli/gateway.ts` + `tests/gateway/connectors.test.ts` | S | ✅ shipped (this session) |
| I10 | **Thin send connectors — ntfy / Teams / Google Chat / Weixin** | Four more Hermes-parity send platforms: ntfy (push to topic, `BUFF_NTFY_TOPIC`, base defaults to ntfy.sh), Teams (incoming webhook, `{text}`), Google Chat (space webhook, `{text}`), Weixin (thin send-only client for WeChat's official iLink bot API — `{base}/ilink/bot/sendmessage`, `MSG_TYPE_BOT=2`/`MSG_STATE_FINISH=2`/`ITEM_TEXT=1` payload, `authorizationtype: ilink_bot_token` header, `randomUUID` client_id — Hermes `gateway/platforms/weixin.py` parity; inbound get_updates protocol deferred). Also adds the `extraHeaders()` hook to `WebhookChannelAdapter` (protocol-marker headers) | `src/gateway/adapters.ts` → `channel-directory.ts`, `cli/gateway.ts` + `tests/gateway/connectors.test.ts`, `hub-data.test.ts` | S | ✅ shipped (this session) |
| I11 | **Dashboard channel send-test** | The Agent Hub Channels tab can send a test message through the SAME gateway the CLI uses: `POST /api/admin/hub/channels/send` (admin + routing.operate, body `{target,text}` validated target≤128/text≤4000) resolves via `ChannelDirectory` and sends via `GatewayRegistry` + `createConfiguredAdapters`; 15s server-side send bound; error hints list the platform's real env vars (`PLATFORM_ENV_VARS`). Lazy `GatewayRegistry` import so the heavy pipeline chain (pipeline-tool → cli/router) never loads at server-import time (keeps fs-mocked test collections working) | `src/web-dashboard/server.ts` → `api.ts`, `components/AgentHub.tsx`, `styles/dashboard.css` + `tests/web-dashboard/server.test.ts` (Session 38), `components/AgentHub.test.tsx` | S | ✅ shipped (this session) |
| I12 | **SMS (Twilio)** | The #1 priority from the deferred-connector assessment — Hermes `plugins/platforms/sms` parity. Outbound `SmsAdapter` (ChannelAdapter like Signal): form-encoded `POST {sid}/Messages.json` with Basic auth, `From/To/Body`, 1600-char cap; SAME `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_PHONE_NUMBER` env vars as Hermes so existing creds work in both agents. Inbound (Twilio webhook + signature validation) deferred. Picked up automatically by the I11 dashboard send-test | `src/gateway/adapters.ts` → `channel-directory.ts`, `cli/gateway.ts` + `tests/gateway/connectors.test.ts`, `hub-data.test.ts` | S | ✅ shipped (this session) |
| I13 | **IRC** | The #2 priority from the deferred-connector assessment — Hermes `plugins/platforms/irc` parity. Outbound `IrcAdapter` (ChannelAdapter) over a **connect-per-send RFC 1459 client** (`ircSend`, node:net/tls like `smtpSend`): PASS → NICK → USER → wait 001 RPL_WELCOME → optional NickServ IDENTIFY → JOIN channel targets (confirmed by 366 End-of-NAMES, settle-timer fallback) → PRIVMSG line(s) → grace window for error numerics (401/404/442…) → QUIT. Hermes `_split_message` parity: byte-aware ≤510-byte wire lines (binary-search char boundary, prefer space), markdown strip. SAME `IRC_SERVER`/`IRC_PORT`/`IRC_NICKNAME`/`IRC_CHANNEL`/`IRC_USE_TLS`/`IRC_SERVER_PASSWORD`/`IRC_NICKSERV_PASSWORD` env vars as Hermes. CRLF-injection rejected pre-connect. Inbound (full-time relay + receive loop) deferred. Picked up automatically by the I11 dashboard send-test | `src/gateway/adapters.ts` → `channel-directory.ts`, `cli/gateway.ts` + `tests/gateway/adapters.test.ts` (mock IRC server), `hub-data.test.ts` | S | ✅ shipped (this session) |
| I14 | **SimpleX** | The #3 priority from the deferred-connector assessment — Hermes `plugins/platforms/simplex` parity. Outbound `SimplexAdapter` over a **connect-per-send client for the local simplex-chat daemon's WebSocket API** (`simplexSend`, Node's built-in global WebSocket — zero deps): sends `{"corrId":"hermes-…","cmd":…}` chat-command frames — DMs via the `@<id> text` form, groups via the structured `/_send #<id> json [{"msgContent":{"type":"text","text":…}}]` form (the bracket `#[<id>]` syntax is parsed as a display-name lookup and silently drops). Fire-and-forget like Hermes (the daemon doesn't always reply to chat commands), with a short grace window watching for `chatCmdError` responses; 10s connect timeout. SAME `SIMPLEX_WS_URL` env var as Hermes (default `ws://127.0.0.1:5225`); daemon started separately (`simplex-chat -p 5225` or the official Docker image). Inbound (contact-request auto-accept + relay) deferred. Picked up automatically by the I11 dashboard send-test | `src/gateway/adapters.ts` → `channel-directory.ts`, `cli/gateway.ts` + `tests/gateway/adapters.test.ts` (fake WS), `hub-data.test.ts` | S | ✅ shipped (this session) |
| I15 | **Home Assistant** | Next from the heavy-connector assessment (its 607 ln is mostly the inbound WS event bus — the SEND path is two thin REST POSTs, so it ports as a light adapter). Outbound `HomeAssistantAdapter`: `POST {url}/api/services/notify/notify` with `{message, target: channelId}` when a target is given, else `persistent_notification/create` with `{title, message}` (Hermes' default send); `Authorization: Bearer <HASS_TOKEN>`, 4096-char cap (Hermes MAX_MESSAGE_LENGTH). SAME `HASS_TOKEN`/`HASS_URL` env vars as Hermes (URL defaults to `http://homeassistant.local:8123`). Inbound (WS event-bus subscription with per-entity cooldowns) deferred. Picked up automatically by the I11 dashboard send-test | `src/gateway/adapters.ts` → `channel-directory.ts`, `cli/gateway.ts` + `tests/gateway/connectors.test.ts`, `hub-data.test.ts` | S | ✅ shipped (this session) |
| I16 | **SimpleX inbound** | Full-time receive for the I14 adapter — `SimplexAdapter.start()` now opens a **persistent WS listener** (Hermes `plugins/platforms/simplex` receive parity): auto-accepts contact requests (`/accept <id>`, gated by `SIMPLEX_AUTO_ACCEPT`, default on), filters our own echoes (`hermes-` corrIds + `directSnd`/`groupSnd` chat directions), parses `newChatItems`/`newChatItem` events (`chatInfo.type` direct→contactId / group→`group:<id>`, `rcvMsgContent` + `msgContent.text` only), applies allowlists (`SIMPLEX_ALLOWED_USERS` contact allowlist; groups **ignored unless** `SIMPLEX_GROUP_ALLOWED` — Hermes' safer default), and **reconnects with a backoff** when the daemon drops the WS. Deliberate divergence documented: contacts are allowed by default when the allowlist is unset (local gateway; triggers further gated by `BUFF_GATEWAY_ALLOW_IDS`). Send stays connect-per-send (independent WS). Two-way platform — agent listens AND replies on SimpleX | `src/gateway/adapters.ts` (SimplexAdapter start/stop + options) + `tests/gateway/adapters.test.ts` (8 receive tests: relay, echo/non-text filters, auto-accept on/off, contact+group allowlists, `*`, reconnect-delivers, stop-cleans) | S | ✅ shipped (this session) |

> **I11/I12 note (assessed, then shipped):** the remaining Hermes connectors
> were measured before choosing what to build next — `sms` (539 ln),
> `homeassistant` (607 ln, tool-flavored) — ✅ shipped as I15, `irc` (998 ln), `simplex`
> (1385 ln) are thin/moderate; `qqbot` (4837 ln), `yuanbao` (5298 ln),
> `weixin` inbound (2419 ln), `api_server` (7188 ln) are heavy protocols
> (signing/crypto/redirects); `cron` is already native (`src/gateway/cron.ts`);
> **`line` does NOT exist in Hermes** (no platform files — the deferral was
> mistaken). Priority if any become must-haves: **1) sms** ✅ shipped (I12),
> **2) irc** (free, self-hostable) — ✅ shipped as I13, **3) simplex** (privacy messaging) — ✅ shipped as I14; heavy
> ones would need a protocol port, not a thin adapter. I12 = Twilio REST
> outbound (`plugins/platforms/sms` parity — same `TWILIO_ACCOUNT_SID` /
> `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` env vars so the same creds work
> in both agents): form-encoded `Messages.json` POST with Basic auth, 1600-char
> cap (Hermes chunks into segments — documented divergence), inbound webhook
> deferred. The dashboard send-test route picks sms up automatically via
> `createConfiguredAdapters()`.

> **I9/I10 note:** agent-nuvira now exposes the full Hermes messaging surface —
> telegram, discord, slack, whatsapp (bridge), whatsapp_cloud, email, signal
> + dingtalk, feishu, wecom, mattermost, matrix, webhook, bluebubbles, ntfy,
> teams, google_chat, weixin (18 platforms in `buff gateway status`, all
> resolvable as `buff gateway send <platform>:<channel> …` and aliasable).
> Payload shapes match each vendor's documented API; URL-keyed robots send no
> Bearer header; signed-robot HMAC mode documented as unsupported (plain
> webhook URLs only); Weixin is send-only (iLink get_updates inbound deferred).
> Deferred (heavier bridges): qqbot, yuanbao, line,
> api_server, cron — the same bridge/adapter pattern applies if any
> becomes a must-have.

**Ordering rule (inherited):** runtime capability before presentation — I1/I2/I3
before I4/I5, so a dashboard toggle is never cosmetic.

**Dogfood finding (this session):** trying to use a WhatsApp skill exposed a
real I7 gap — `buff skills search/install` never constructed a ConfigManager,
so buffconfig `skills.registries[]` was silently ignored (only
`BUFF_SKILLS_REGISTRY` or the default registry worked). Fixed in
`src/cli/skills.ts` (both actions now pass `cm: new ConfigManager()`; the
`update` path deliberately stays source-faithful to provenance). Also
confirmed: no WhatsApp skill exists in bundled skills, the registry, or
Hermes' 263 skills — the iMessage skill even redirects WhatsApp to "the
appropriate gateway channel". Authored + installed a whatsapp SKILL.md
(Cloud API + Baileys paths) and verified the runtime bridge matches it
for a WhatsApp goal (search → install → match, all in a temp project).

---

## 8. PHASE 4 — Full GUI release (deferred)

Browse wizards with preview/scan (Hermes' HubBrowser), OAuth flows for MCP,
plugin install UX, install logs streaming. **Explicitly out of this plan** —
tracked in [ROADMAP_TODO.md](ROADMAP_TODO.md) for the GUI release. §12.2
lists what "GUI release" should not repeat (the order-of-operations lesson:
capability before presentation).

---

## 9. File map

### New files

| File | Phase | Purpose |
|---|---|---|
| `src/learning/hub-skill-index.ts` | P0 | Catalog scan/parse/match + facade `lookupSkill(goal)` |
| `src/learning/skills-registry.ts` | P1 | Multi-source registry adapters |
| `src/mcp/catalog.json` + `src/mcp/catalog.ts` | P2 | Curated MCP catalog + loader |
| `src/web-dashboard/src/components/SkillsPanel.tsx` | P3 | 3-view skills page |
| `src/web-dashboard/src/components/McpPanel.tsx` | P3 | MCP management page |
| `src/web-dashboard/src/components/ToolsPanel.tsx` | P3 | Tools registry page |
| `tests/learning/hub-skill-index.test.ts` | P0 | Phase 0 test suite |
| `tests/learning/skills-registry.test.ts` | P1 | Registry adapter tests |
| `tests/mcp/catalog.test.ts` | P2 | Catalog tests |

### Modified files

| File | Phase | Change |
|---|---|---|
| `src/agents/orchestrator.ts` | P0 | Skill-match call → facade; matched-skill threading unchanged |
| `src/agents/agents/planner.ts` | P0 | L0 catalog block + L1 body (reuse existing injection) |
| `src/cli/skills.ts` | P0/P1 | `--indexed`, `status`, `--source` |
| `src/cli/mcp.ts` | P2 | `catalog`, `install`, `uninstall` |
| `src/web-dashboard/server.ts` | P3 | 6 routes (read + toggle) |
| `src/web-dashboard/src/App.tsx`, `components/Layout.tsx` | P3 | Routes + nav |

---

## 10. API contracts (stable surface)

```ts
// P0 facade — the one call everything above uses
export async function lookupSkill(goal: string, opts?: {
  includeHermes?: boolean;      // default false; opt-in interop
  maxCatalogEntries?: number;   // default 25 (L0 token cap)
  maxBodyChars?: number;        // default 8000 (L1 cap)
}): Promise<{ skill: IndexedHubSkill; body?: string } | null>;

export function refreshHubIndex(): void;
export function setSkillEnabled(name: string, enabled: boolean): void;
export function getSkillStatus(name: string):
  { indexed: boolean; enabled: boolean; origin: HubSkillOrigin; version: string } | null;
```

All bridge functions are **synchronous** over a lazily-built in-memory cache
(no await in the planner path); the cache is refreshed (a) at process start,
(b) after `buff skills install/update`, (c) on `setSkillEnabled`.

---

## 11. Milestones & effort

| Milestone | Deliverables | Effort | Ordering dependency |
|---|---|---|---|
| M0 | P0 bridge + facade + tests | S–M | none |
| M1 | P0 CLI (`--indexed`, `status`) + E2E demo | S | M0 |
| M2 | P1 registries + `--source` | S | M1 (shares CLI file) |
| M3 | P2 MCP catalog + installer | S | independent |
| M4 | P3 dashboard read routes + 3 panels | M | M0 (toggles need bridge) |
| M5 | P3 toggle wiring + admin gate + tests | S | M4 |
| M6 | Full regression (typecheck + suite + build) | S | M0–M5 |

Recommended execution order: **M0 → M1 → M2 → M3 → M4 → M5 → M6** (M2/M3
can parallelize).

---

## 12. Risks & mitigations

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | Scope creep into a GUI rewrite | High | P3 is read-only first; P4 explicitly deferred |
| R2 | Frontmatter variance across community skills | Medium | Tolerant parser + `status` command surfaces parse failures; unknown fields ignored |
| R3 | Catalog token bloat in planner prompts | Medium | L0 capped (25 entries), L1 body capped (8 KB), disabled-filtered |
| R4 | External registry supply-chain | Medium | Provenance + checksum + quarantine already enforced; new sources marked `community` in provenance |
| R5 | Dashboard toggles ignored by runtime | High if ordered wrong | Bridge is the single enforcement point; toggles wired only after M0 |
| R6 | License issues porting Hermes manifests | Low | Re-verify on port; catalog entries carry `vettedBy` + license field |

### 12.1 Explicitly deferred (tracked separately)

- Python plugin interop (`plugin.yaml`) — most plugin capabilities map to
  native features (cron, memory hooks, tool registry). Revisit only if a
  must-have Hermes plugin appears.
- Hermes external_dirs live-sync — `includeHermes: false` by default; opt-in
  read-only interop only (no writes into `~/.hermes`).

### 12.2 Lesson carried from ASSESSMENT_WEBSITE_DEPLOY

The website-deploy exercise proved the ordering principle that this plan
encodes: **capability first, presentation second** (the deploy failed because
execution capability was hijacked before the skill even ran; here, the UI
without the bridge would be the same failure in a different costume).

---

## 13. Out of scope (explicit)

- Multi-user/server dashboard deployment
- Native execution of skill `scripts/`
- Writing skills *back* to `~/.hermes`
- A compiled-graph workflow DSL (see [ASSESSMENT_VALIDATION_COPILOT.md])
- Any change to the repair loop / runner / shell (already stabilized in the
  website-deploy work)

---

## 14. Definition of done (project level)

1. All DoDs for P0–P3 green (S1–S6 verified, typecheck + full test suite +
   `npm run build` clean).
2. Manual demo script (below) recorded/verified once:

```bash
# 1. local fixture registry → install → match → execute
mkdir -p /tmp/skillreg/skills/demo-fix
cat > /tmp/skillreg/skills/demo-fix/SKILL.md <<'EOF'
---
name: demo-fix
description: "Fix a demo lint issue in the current project."
---
# Demo Fix
Run `node -e "console.log('demo-ok')"` to verify the environment, then report.
EOF
BUFF_SKILLS_REGISTRY=file:///tmp/skillreg buff skills install demo-fix
buff skills status demo-fix            # indexed: true, enabled: true
buff execute "use the demo-fix skill"  # matches + injects + executes
buff skills list --indexed             # shows indexed status
```

3. Dashboard `/skills` shows the fixture with a working toggle; toggling off
   makes `buff execute` no longer match it.
4. This plan's file map is fully reflected in the codebase, and this document
   is updated to mark phases shipped.

---

## Shipped-status notes

- **I1–I5 shipped**: Agent Hub dashboard (Tools / Channels / Artifacts /
  Skills tabs), gateway runtime gate, delivery ledger, artifact store, skills
  hub UI — full suite + live dashboard smoke green.
- **I6 shipped** (2026-08-12): Email (minimal SMTP over `node:net`/`tls`, no
  nodemailer) + Signal (signal-cli-rest-api, pure fetch) adapters, platform
  plumbing in `channel-directory.ts`, CLI status, Hub Channels-tab platforms,
  and 12 adapter tests incl. a real in-process mock SMTP server.
- **I6 lesson — regex literal escapes in the test transform**: an SMTP
  dot-stuffing bug shipped because `/^\./gm` (escaped-dot literal) was mangled
  by the vitest/oxc transform into `/^\\\./gm` at runtime (byte-confirmed:
  `94,92,92,46`), silently matching a literal backslash and letting servers
  terminate multi-part bodies early. Fix: write the pattern as a character
  class `/^[.]/gm` — identical semantics, immune to escape mangling. **Use
  `[.]` (and character classes generally) instead of escaped-dot regex
  literals in `src/` code exercised by vitest.**
- **I7 shipped** (P0–P2): (P0) `src/learning/hub-skill-catalog.ts` — installed
  SKILL.md skills are first-class runtime capabilities (scan `.agents/skills`
  + `~/.buff/skills`, `skills.disabled[]` gate, keyword match → SKILL.md body
  injected into the planner); orchestrator now falls back to the hub catalog
  when no compiled skill matches. (P1) `src/learning/skills-registry.ts` —
  multi-source adapters (github-raw / local-dir / browse-sh / git-repo
  shallow-clone) behind `skills.registries[]`; `buff skills search`/
  `install --source <kind>`. (P2) `src/mcp/catalog.ts` + `buff mcp
  catalog|install|uninstall` — vetted exact-pin catalog writing the standard
  `~/.buff/mcp/<name>.json`. P3 (dashboard 3-view) largely pre-shipped in
  I4/I5 (Skills tab shows hub skills); full browse wizards stay deferred to
  the GUI release.

---

*Plan authored 2026-08-12. Grounded in the gitignored internal assessment
(`ASSESSMENT_HERMES_ECOSYSTEM.md`) and direct code reads of this repo. Update
this header's Status field as phases ship.*
