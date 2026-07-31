# Change Log

All notable changes to the Agent-Baba-D VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
