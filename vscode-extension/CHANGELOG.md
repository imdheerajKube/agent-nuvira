# Change Log

All notable changes to the Agent-Nuvira VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.56.1] — 2026-08-05

> Version aligned with the CLI release cycle — this extension release ships
> alongside **CLI v1.56.1** (the extension drives the same `agent-nuvira` CLI).

### Added
- **IDE usage telemetry attribution** — every LLM call the extension drives is
  written through to the CLI's Model Availability Registry "learned from real
  usage" log **with its own action tag** via `BUFF_TELEMETRY_ACTION` at spawn:
  chat panel → `ide-chat`, inline suggestions → `ide-inline`, and
  execute/edit/workflow/review/code-lens actions → `ide-<command>`. IDE usage
  now gets its own rows in the per-action dashboard **Models** panel and in
  `buff models status --verbose`; a provider killed by an IDE action is
  skipped predictively by every other action (CLI + IDE alike), and a later
  real success re-verifies + un-parks it. Proven by a new `cliManager` test
  asserting the env tag at spawn

### Fixed (CLI v1.56.1 — inherited by the bundled CLI)
- **Dashboard stale-server crash fix** — "Failed to execute 'json' on
  'Response': Unexpected token '<'" when an older dashboard instance answers
  newer `/api/*` routes with SPA HTML: unknown `/api/*` now returns a
  parseable **JSON 404**, all `/api/*` responses parse through a shared
  defensive helper (Content-Type check + try/catch), and `buff dashboard`
  logs a clear **EADDRINUSE** message (with restart hints) instead of
  crashing on an unhandled error event
- `buff models unblock <provider>` escape hatch — manually release a
  registry-blocked provider (demote unavailable → unverified, clear quota
  parks + ledger cooldown, live re-probe) — plus the `models status --json` /
  `refresh --json` flag-shadowing fix
- Dashboard per-action telemetry timeline is now **scrubbable** — drag across
  days, click a day, or use the range slider to see that day's exact
  verified/killed chips, with ▶ play/pause day-by-day sweep

## [0.6.2] — 2026-08-03

### Changed
- **Marketplace README refresh** — the extension listing now leads with a
  banner clarifying that Agent-Nuvira is **not just an editor extension — it's
  the full 17-agent development agent** that also runs from the terminal
  (`npx agent-nuvira execute "<goal>"`). Agent table expanded 11 → **17 agents**
  (added GitLab, PR Review, Issue Triage, Branch Automation, Skill Runner,
  MCP), provider list expanded to **17+** (5 built-in + 12 configurable,
  LM Studio included), and a new **FAISS Vector Store + Team Collaboration**
  section documents the local vector backend (`buff memory backend --check`)
  and Git-synced team memory

## [0.6.1] — 2026-08-03

### Added
- **Poll-fallback auto-refresh** — on top of the file watcher, the Quota
  Ledger view now runs a modest periodic refresh (60s) as a safety net for
  platforms where `fs.watch` silently drops events (network drives, FUSE
  mounts, some containers). The watcher stays the fast path; the poll just
  bounds the worst-case staleness so the ledger always eventually catches up.
  Injectable `pollMs` (tests use a tiny value) and disarmed with the watcher on
  panel close

## [0.6.0] — 2026-08-02

### Added
- **Live quota updates** — the Quota Ledger view now watches the CLI memory
  dir (`fs.watch`, `BUFF_MEMORY_DIR`-aware) and **auto-refreshes the moment**
  `quota-ledger.json` or `quota-events.jsonl` changes, so a failover / park /
  window-reset written by any process sharing the memory dir (CLI, chat,
  dashboard) appears instantly without clicking Refresh. Debounced 150ms,
  basename-normalized filter (macOS FSEvents full-path safe), null-filename
  treated as trigger, ENOENT-safe watch arm, and the watcher is disarmed on
  panel close

---

## [0.5.0] — 2026-08-02

### Added
- **Quota Ledger View** — new `Agent-Nuvira: Show Quota Ledger` command (and a
  quota status-bar indicator) opens a webview panel that visualizes the central
  quota ledger (`~/.buff/memory/quota-ledger.json` + `quota-events.jsonl`):
  summary cards for free/local vs paid token usage and estimated savings, a
  per-provider window table (tokens, requests, time-to-reset, parked state), and
  a failover timeline (parked → failover → re-enabled). Honors `BUFF_MEMORY_DIR`
  like the CLI/dashboard. The status-bar item shows a parked-provider alert count
  (or `quota ok` when all healthy); the panel has a manual Refresh button
- **Searchable model picker** — the per-provider model quick-pick now uses
  `createQuickPick` with native type-to-filter matching against both the model
  name and its id, so long lists (e.g. OpenRouter's 100+ models) can be filtered
  by typing; Esc still keeps the provider default
- **Chat Panel model switcher** — a provider/model dropdown in the chat sidebar
  header lets you switch the active provider (or enable Auto routing) without
  leaving the chat. Selecting an option runs `buff model switch`, re-syncs the
  dropdown, and refreshes the status-bar indicator via the shared onModelChanged
  callback

---

## [0.4.0] — 2026-07-31

### Added
- **Model & Provider Switcher** — new status-bar model indicator (click to switch)
  and `Agent-Nuvira: Switch Model / Provider...` command that lists all providers
  with availability status (from `buff model list --json`) plus an **Auto routing**
  option. Picking a provider drills into its **actual models** (`buff models --json`)
  so you can select a specific model or keep the provider default (Esc). Switching
  updates the CLI's active-model state and refreshes the indicator.
- **Check Model Health** — `Agent-Nuvira: Check Model Health` runs `buff model health`
  for the active provider and shows the report in a side document
- **Auto Model Routing** — new `agent-nuvira.useAutoRouting` setting: when enabled,
  chat commands use `--model auto` and execute commands use `--auto-route` so the
  agent picks the best provider/model per task. A confirmation prompt warns before
  pinning a specific provider while auto-routing is enabled
- **Auto routing everywhere** — inline suggestions also use `--model auto`, and
  code-lens actions + diagnostic fixes pick up auto routing (via the shared CLI
  manager). Runtime config changes now propagate to inline suggestions,
  code-lens actions, and diagnostic fixes immediately (no reload needed)
- **CLI integration** — `buff model list --json` structured output for reliable
  provider parsing in the extension, plus new `buff models --json` output for
  per-provider model listing (includes `providerType` for switching)

### Tests
- 8 new tests for model management: `listModels` (JSON parsing + error fallbacks),
  `switchModel` (auto/provider/provider-model arg building), `checkModelHealth`
  (provider flag handling), `getActiveModel` (valid/corrupt/missing state file),
  auto-routing in `buildArgs`, and the `switchModel` command flow (quick pick,
  auto-routing confirmation, error handling, missing-CLI fallback)
- 4 new inline-suggestion auto-routing tests (incl. `updateConfig` transition and
  `npx` prefix), 4 new `CodeLensProvider` tests, and 2 new `DiagnosticFixProvider`
  tests for `updateCliManager` swapping (initial manager, single/multiple swaps,
  unsupported-language guard)

---

## [0.3.0] — 2026-07-31

### Added
- **Chat Panel** — multi-turn AI chat with streaming responses, slash commands
  (`/fix`, `/review`, `/test`, `/explain`, `/workflow`, `/help`), file context,
  code blocks with "Apply to File", and persisted conversation history
- **Pipeline DAG Visualization** — live SVG diagram of multi-agent pipeline
  progress inside chat messages (agent nodes, status badges, edges, legend)
- **Diagnostic → AI Fix** — "Fix with Agent-Nuvira" lightbulb action with diff
  preview and Apply/Reject workflow
- **Code Lens Actions** — clickable `$(sparkle) AI: <name>` lenses above functions
  and classes with quick-pick menu (Test / Review / Explain / Quick Fix)
- **Real-Time Token Streaming** — live typewriter streaming output with code
  block detection in the agent progress panel

### Changed
- Chat webview template (`chatPanel.html`) is now included in the packaged VSIX
  (previously excluded by `.vscodeignore`) — fixes "template not found" fallback
- Status bar now opens the Chat Panel (`Ctrl+Shift+A C`) instead of the old panel

## [0.2.0] — 2026-07-16

### Added
- Inline code suggestions from agents (Copilot-style completions with 800ms debounce)
- Agent progress panel with real-time execution visualization
- Diff viewer for reviewing proposed file changes before accepting
- 9 commands with context menu integration (explorer, editor, title)
- Custom keybindings (`Ctrl+Shift+A` prefix) for all common operations
- VS Code configuration settings (CLI path, provider, model, auto-apply)
- Activity bar view container with agent progress webview

### Changed
- Enhanced CLI communication with streaming progress, timeouts, and cancellation
- Improved `resolveCliCommand` for cross-platform compatibility (`npx`, `npx.cmd`)

## [0.1.0] — 2026-07-10

### Added
- Initial MVP release
- `Agent-Baba-D: Execute Goal` command
- `Agent-Baba-D: Quick Fix`, `Review File`, `Explain Code`, `Generate Test` commands
- Basic CLI integration via child process
- Status bar integration
- Right-click context menu for source files
