# Changelog

All notable changes to **Agent-Nuvira** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.38.0] - 2026-07-31

### Added
- **Cross-platform dependency installer (Runner)** — `RunnerAgent` now auto-installs missing
  project dependencies and bootstrap-installs missing package managers:
  - **11 manifest types detected** — `package.json`/`pnpm-lock.yaml`/`yarn.lock` (lockfiles win),
    `requirements.txt`, `pyproject.toml`, `setup.py`, `Gemfile`, `Cargo.toml`, `go.mod`,
    `composer.json`, `pubspec.yaml`
  - **Tool bootstrapping on all platforms** — npm via brew/apt/dnf/yum/NodeSource/winget/choco/MSI;
    pip via `ensurepip` + Python install; Homebrew via official `NONINTERACTIVE=1` script;
    bundler via gem + Ruby; cargo via rustup; go via brew/apt/winget; composer via getcomposer.org
    into user-writable `$HOME/.local/bin` (no sudo, quoted, `USERPROFILE` fallback); dart via
    Homebrew / Google apt repo / winget
  - **Command-based tool detection** — when no manifest exists, missing interpreters referenced by
    the failing command (`python3`, `node`, `go`, `cargo`, etc.) are installed automatically
  - **Telemetry** — `dependencyInstallTool` / `dependencyInstallToolInstalled` on `RunResult`,
    feeding the eval framework's dependency-install success metric
- **Dashboard: Deps Installed stat** — Agent Evaluation section now shows dependency-install
  success rate alongside tests / composite / recovery / rollbacks; stat grid switched to
  `auto-fit` so both the 4-card benchmark and 5-card eval sections lay out evenly
- **Runner tests** — composer install paths ($HOME/.local/bin, PHP bootstrap, PHP-failure
  short-circuit), interpreter→tool mapping, and failed-command auto-install flow

---

## [1.37.1] - 2026-10-05

### Fixed
- **Provider crash in `buff plan`** — Running `agent-nuvira plan` with an unconfigured default
  provider (e.g., OpenRouter with no API key) crashed with a raw 401 JSON error. Now:
  - Auto-fallback via `getProviderFallback.callWithFallback()` for retryable errors
  - Interactive model picker when provider is unavailable or auth fails
  - Helpful error messages with actionable steps (set API key, run `buff model switch`, use local)
  - Correct env var names per provider (e.g., `nim` → `NVIDIA_NIM_API_KEY`)
- **Provider crash in `buff skill compile`** — Added auto-fallback to `callLLM` in `compileSkills()`
  so skill compilation doesn't crash with raw provider errors
- **Provider crash in `buff learn patterns --extract`** — Added auto-fallback to `callLLM` in
  `showPatterns()` so pattern extraction handles provider failures gracefully

### Security
- `plan.ts` now detects auth errors (401/403) and shows environment variable configuration hints
  instead of exposing raw API error JSON to the user

---

## [1.37.0] - 2026-10-05

### Added
- **Branch Automation Hooks (Pillar A4)** — Automated branch workflow with 4 trigger sources:
  - **Issue → Branch** — Auto-creates `feat/PROJ-123-description` branches from issue keys with
    configurable branch type (feat/fix/chore) and sanitized naming
  - **PR Label → Update** — Auto-commits changes and pushes to PR branch when labels like `wip`
    or `needs-work` are detected
  - **File Watch → Commit** — Background file-watch script with configurable polling interval
    (default: 60s) that auto-commits with conventional commit messages on change detection
  - **CI Status → Fix** — Analyzes CI failures from git context (recent commits, changed files)
    with LLM-powered diagnosis and actionable fix suggestions
- **Git hooks installer** — Installable post-checkout and pre-commit hooks that detect issue-based
  branches and enforce conventional commit format; hooks are self-identifying (contain 'Agent-Nuvira'
  marker) for clean removal
- **Conventional commit generator** — Rule-based commit type detection from changed files
  (test→test, docs→docs, fix→fix, feat→feat) with LLM fallback for contextual messages
- **`--auto-branch` flag** — New CLI flag for `buff execute` enabling branch automation workflows
- **Module registry** — `branch-automation` agent type registered in ModuleRegistry

### Files
| File | Change |
|---|---|
| `src/agents/agents/branch-automation-agent.ts` | **NEW** — BranchAutomationAgent (400+ lines)
| `src/agents/agents/branch-automation-hooks.ts` | **NEW** — Git hooks manager (250 lines)
| `src/agents/module-registry.ts` | **MODIFIED** — Added agent registration
| `src/cli/execute.ts` | **MODIFIED** — Added `--auto-branch` flag + `ExecuteOptions.autoBranch`

---

## [1.36.0] - 2026-10-04

### Added
- **Real-Time Token Streaming in AgentPanel (Pillar B2)** — Live streaming output with
  typewriter effect in the agent progress panel:
  - **Streaming display** — Streaming container with blinking cursor, animated live dot,
    and monospace output area appears below phase indicators when tasks run
  - **Real-time chunk emission** — `CLIManager` now emits `onStreamChunk` callbacks for
    every stdout data event, enabling token-by-token display
  - **Code block detection** — Chunks containing ``` markers are styled with specialized
    token coloring (`.token-code`, `.token-keyword`, `.token-string`, `.token-comment`,
    `.token-error`, `.token-emphasis`)
  - **Auto-scroll** — Output area auto-scrolls to show latest tokens as they arrive
  - **Completed indicator** — After streaming ends, the header label changes from
    "streaming" to "completed" in green, and content stays visible until next task
  - **Clean lifecycle** — `startStreaming()` before each task, `completeStreaming()`
    after both success and error paths, `clearAll()` resets streaming state

### Changed
- `vscode-extension/src/cliManager.ts` — Added `onStreamChunk` callback, emits chunks
  with code block detection on every stdout data event
- `vscode-extension/src/agentPanel.ts` — Added streaming container HTML/CSS/JS,
  `startStreaming()`, `updateStreaming()`, `completeStreaming()` methods
- `vscode-extension/src/commands.ts` — Wired streaming lifecycle: CLI → panel → webview

---

## [1.35.1] - 2026-10-04

### Fixed
- **Missing runtime dependency** — Moved `typescript` from `devDependencies` to `dependencies`
  in `package.json`. The `ts-adapter.ts` and `transform.ts` modules import the TypeScript
  Compiler API at runtime (`import * as ts from 'typescript'`), but it was only listed as a
  devDependency. When installed globally via `npm install -g`, devDependencies are skipped,
  causing `ERR_MODULE_NOT_FOUND`. Now correctly installed as a regular dependency.

### Dependency Audit
- Cross-referenced all `src/` imports against `package.json` — only `typescript` was
  misclassified; all other packages (commander, ora, inquirer, chalk, @huggingface/transformers)
  were correctly categorized.

---

## [1.35.0] - 2026-10-04

### Added
- **Chat Panel v2 — DAG Pipeline Visualization (Pillar B6)** — Live multi-agent pipeline
  visualization inline in chat messages for slash commands:
  - **SVG DAG renderer** — Standalone `dagRenderer.ts` ported from React DAGView to vanilla JS;
    renders colored agent nodes with icons, status badges, edge curves, step details table, and legend
  - **16 agent types** — Planned, gatherers, writers, reviewers, testers, debuggers, security, git,
    packages, releases, triage, PR review, GitLab, skills, MCP with distinct icons/colors
  - **Real-time pipeline detection** — Parses CLI output for agent markers (📋 planner, ✏️ writer,
    👁️ reviewer, 🧪 tester, ✅/❌ complete/fail) and builds DAG state incrementally
  - **Live indicator** — Animated glow for running nodes, pulsing LIVE badge, status summary bar
  - **Fade-in animations** — Smooth entry for pipeline container and node updates
  - **Empty state** — Helpful placeholder when no pipeline is active, with command suggestions
- **Issue Triage Engine (Pillar A3)** — Automated issue classification, prioritization, and labeling
  across GitHub and GitLab:
  - **LLM-based classification** — Classifies issues as bug, feature, question, docs, or chore using
    a structured JSON prompt with configurable temperature (0.2) and explicit classification guidelines
  - **Priority assignment** — Assigns critical, high, medium, or low priority with emoji indicators
  - **Difficulty estimation** — Estimates issue complexity: easy, medium, or hard
  - **Label management** — Suggests and auto-applies labels (creates missing labels on GitHub repos)
  - **Triage comments** — Posts structured markdown table comments with classification, priority,
    difficulty, reasoning, and suggested action
  - **Git blame expertise heuristic** — Infers suggested assignee from git blame on files mentioned
    in the issue body (extracts file paths from backtick references)
  - **Multiple operations**: `triage-all` (all unlabeled), `triage-specific` (#N), `classify` (#N),
    `list-unlabeled`
  - **Auto-source detection** — Detects GitHub vs GitLab from keywords, tokens, or git remote;
    auto mode tries both platforms with clear error messages
  - **Robust LLM response parsing** — Supports valid JSON, markdown-wrapped code blocks, and
    malformed responses with validation fallbacks for all classification fields
- **Module registration** — `issue-triage` agent type registered in ModuleRegistry with metadata

### Files
| File | Change |
|---|---|
| `src/agents/agents/issue-triage-agent.ts` | **NEW** — IssueTriageAgent (550 lines)
| `src/agents/module-registry.ts` | **MODIFIED** — Added agent registration
| `tests/agents/issue-triage-agent.test.ts` | **NEW** — 46 unit tests

---

## [1.34.0] - 2026-10-03

### Added
- **Code Lens Actions (Pillar B5)** — Clickable `$(sparkle) AI: <name>` lenses above functions and classes
  in VS Code. Click opens a quick pick menu with 4 agent actions:
  - **Test** — Generate unit tests for the function/class
  - **Review** — Review for bugs, security, and style issues
  - **Explain** — Explain the code in detail
  - **Quick Fix** — Fix issues in the code
- **Language support** — TypeScript, JavaScript, Python, Go, Rust, Java — with regex-based declaration
  detection and brace-counting body range extraction
- **Quick pick UX** — Single lens per declaration, menu-based action selection with descriptions
- **Error handling** — Try/catch wrapper with user-facing notification on CLI failures

### Changed
- `vscode-extension/src/extension.ts` — Registered CodeLensProvider, single `lensCommandId` handler
- `vscode-extension/package.json` — No menu additions (all interactions via CodeLens click)

### Files
| File | Change |
|---|---|
| `vscode-extension/src/codeLensProvider.ts` | **NEW** — CodeLensProvider with quick pick menu (1,243 lines)

---

## [1.33.0] - 2026-10-02

### Added
- **VS Code Chat Panel (Pillar B1)** — Multi-turn AI chat panel directly in VS Code:
  - Streaming responses via `agent-nuvira chat --stream --no-color` CLI subprocess
  - 6 slash commands: `/fix`, `/review`, `/test`, `/explain`, `/workflow`, `/help`
  - File context: "Add File" button attaches active editor content as context
  - Code block rendering with "Apply to File" button
  - Conversation history sidebar with session management (new, switch, delete)
  - Sessions persisted across restarts via `workspaceState`
  - Slash command autocomplete with arrow key navigation
  - Welcome screen with quick command buttons
  - Keybinding: `Ctrl+Shift+A C` (mac: `Cmd+Shift+A C`)
- **Diagnostic → AI Fix (Pillar B3)** — "Fix with Agent-Nuvira" in VS Code lightbulb menu:
  - Detects diagnostics (red squiggles) and groups by line
  - Captures error message, affected code range, and 3-line surrounding context
  - Sends targeted fix prompt to CLI
  - Shows diff preview with Apply/Reject workflow
  - Falls back to showing raw output as new editor document
  - Retry on failure with error notification

### Changed
- `vscode-extension/src/extension.ts` — Registered ChatPanel, DiagnosticFixProvider, CodeLensProvider
- `vscode-extension/package.json` — Added `openChat` command, `Ctrl+Shift+A C` keybinding, chat activity bar view
- Status bar now opens Chat Panel instead of old Agent Panel

### Files
| File | Change |
|---|---|
| `vscode-extension/src/chatPanel.ts` | **NEW** — Chat webview panel controller (280 lines)
| `vscode-extension/src/chatPanel.html` | **NEW** — Chat webview HTML+CSS+JS template (520 lines)
| `vscode-extension/src/chatProvider.ts` | **NEW** — Chat history provider with workspaceState persistence (260 lines)
| `vscode-extension/src/diagnosticFixer.ts` | **NEW** — Diagnostic fix CodeActionProvider (280 lines)
| `vscode-extension/src/extension.ts` | **MODIFIED** — Registered all B1+B3 components
| `vscode-extension/package.json` | **MODIFIED** — Commands, keybindings, views

---

## [1.31.0] - 2026-09-30

### Added
- **TS Compiler API Wrapper (Phase 11)** — `src/editing/ts-adapter.ts` — Proper TypeScript Compiler API
  integration with `parseSourceFile()`, `findStructuralNodes()`, `findNodeByName()`, `findNodeAtPosition()`,
  `nodeToRange()`, `getBodyRange()`, `validateTSSyntax()` (uses `parseDiagnostics`), `replaceNodeText()`, and
  `insertAt()` — provides parser-level accuracy for all TS/JS editing operations
- **Structural Transformations (Phase 11)** — `src/editing/transform.ts` — Real code transformations:
  `renameSymbol()` (regex word-boundary replacement), `extractFunction()`, `inlineFunction()`,
  `addParameter()`, `changeSignature()`, and `detectTransformType()` NLP heuristic mapper
- **Two-Tier Editing Engine (Phase 11)** — `src/editing/edit.ts` rewritten with `tryFindNodeTS()` helper:
  all 7 operations (replaceFunctionBody, addMethodToClass, insertBefore, insertAfter, deleteNode,
  performEdit, buildStructuralContext) try the TS Compiler API first, fall back to regex — giving
  TS/JS files parser-level accuracy while supporting Python/Go/Rust via regex
- **Phase 11 Unit Tests** — 66 new tests across two suites:
  - `tests/editing/ts-adapter.test.ts` (40 tests) — parsing, node finding, body ranges, validation, text manipulation
  - `tests/editing/transform.test.ts` (26 tests) — all 5 transformation operations + NLP detection

### Changed
- `src/editing/edit.ts` — Replaced all `await import()` dynamic imports with clean static imports;
  replaced fragile regex-based structural analysis with TS Compiler API tier (for TS/JS) + regex fallback
  (for Python/Go/Rust)
- Marked unused imports cleanup (nodeToRange, replaceNodeText, insertAt) in transform.ts

### Tests
- 66 new Phase 11 tests — all passing ✅
- Total module tests: ts-adapter (40) + transform (26) = **66 Phase 11 tests**

---

## [1.30.0] - 2026-09-30

### Added
- **Unit tests: CredentialStore** — 357-line test suite covering constructor auto-detection, canPush/canPublish getters, collectAll() flow, setupGitCredentials() (GIT_ASKPASS, SSH agent), setupNpmAuth() (.npmrc injection), cleanup(), and module-level helper functions
- **Unit tests: PhaseExecutionEngine** — 560-line test suite covering createScope(), getNextPhase(), getProgress(), saveScope()/loadScope(), listSavedScopes()/deleteScope(), executePhase() (success/failure/exception/edge cases), executeScope() (sequential/resume/failure/credential collection)
- **Phase 10 documentation** — README roadmap table (10.1-10.4), version history (v1.29.0), Phase-Wise Feature Summary (4 new entries)
- **Product_Guide Phase 10** — Feature inventory items 66-69, section 7.8 with detailed phase table
- **Website stats update** — Architecture highlights: 10/10 Phases Complete, 10/10 Modules Extracted

### Changed
- Updated README, Product_Guide, and website to reflect Phase 10 (Autonomous Publish & Phase-Wise Execution) progress

### Tests
- 80 new tests: 357 lines credential-store, 560 lines phase-engine — all passing ✅

---

## [1.29.0] - 2026-09-30

### Added
- **CredentialStore** — Interactive Git/npm credential collection with GIT_ASKPASS setup, SSH key passphrase handling, .npmrc token injection, and auto-detection from env vars | `src/agents/credential-store.ts`
- **PhaseExecutionEngine** — Multi-goal project scope execution with save/resume across restarts | `src/agents/phase-engine.ts`
- **Publish command** — `buff publish` — 5-phase autonomous pipeline: test verification → version bump → git commit/tag/push → npm build/publish → GitHub release | `src/cli/publish.ts`
- **Phase command** — `buff phase create/execute/resume/status/list/delete` — phase-wise project execution | `src/cli/phase.ts`
- **GitAgent: git push + tag push** — `pushToRemote()`, `createAndPushTag()`, `pushTagToRemote()`, `autoPush()` with credential-aware error messages (auth failures, missing remote, network errors)
- **PackageAgent: fullPublish pipeline** — `fullPublish()` chains version bump → build → publish with auto npm auth detection from env vars or .npmrc

### Changed
- GitAgent now supports `git push`, `git tag -a`, and `git push --tags` operations — previously only local commit was supported, no remote push capability
- PackageAgent now auto-detects npm auth via `NPM_TOKEN` env var or `.npmrc` before publishing, with clear error messages for auth failures
- CLI router registered `PublishCommand` and `PhaseCommand` as new top-level commands
- All new modules exported from `src/index.ts` for SDK access

---

## [1.28.0] - 2026-09-29

### Added
- **Phase 9 documentation** — README, Product_Guide, and User_Manual updated with SafeExecutionLayer entries
- **README roadmap table** — Added Phase 9: Safe Execution Layer (9.1 SafeExecutionLayer, 9.2 VerifyModule EventBus tests)
- **README version history** — v1.26.0 (Phase 9 SafeExecutionLayer + 32 tests) and v1.27.0 (website/SVG updates)
- **README Phase-Wise Feature Summary** — SafeExecutionLayer (Phase 9) entry with 3-domain safety system description
- **Product_Guide feature inventory** — Item 65 for SafeExecutionLayer, new section 7.7 with detailed module table
- **User_Manual Phase 6 table** — SafeExecutionLayer (Phase 9) entry added with full description

### Changed
- Product_Guide.md migration summary updated from "8 modules" to "9 modules"
- All 3 docs now consistently reference Phase 9 / SafeExecutionLayer across all section types

---

## [1.27.0] - 2026-09-29

### Added
- **Website v1.26.0 updates** — Phase progress updated to "9/9" phases and modules extracted; test count to 2,207; architecture header from Phase 1→8 to Phase 1→9
- **Migration roadmap SVG** — Added Phase 9 (SafeExecutionLayer) timeline circle, card with 3 capabilities, Row 11 comparison entry, extended metrics/footer
- OG/twitter meta descriptions updated to 2,207+ tests

---

## [1.26.0] - 2026-09-29

### Added
- **SafeExecutionLayer (Phase 9)** — `DefaultSafeExecutionLayer` unifying three safety domains:
  - **File validation** — file size guard (default: 100KB), .gitignore compliance detection, AST syntax
    validation (TS/JS/Python/Go/Rust), security scan of file content via `runAllScans()`
  - **Sandboxed execution** — Docker container isolation via `SandboxManager`, resource limits
    (CPU/memory), timeout enforcement, automatic container lifecycle (create/copy/exec/destroy)
  - **Safe LLM calls** — prompt injection guardrail (blocks injection patterns before sending),
    configurable prompt length cap (default: 128K chars), exponential backoff retry (up to 3),
    circuit breaker for auth errors (401/403), response length cap
- **EventBus events (10 new)** — `SAFE_EXEC_FILE_VALIDATED`, `SAFE_EXEC_SANDBOX_STARTING`/`CREATED`/
  `COMPLETED`/`FAILED`, `SAFE_EXEC_LLM_STARTING`/`BLOCKED`/`RETRY`/`COMPLETED`/`FAILED`
- **VerifyModule EventBus tests** — 9 new tests verifying `VERIFY_STARTING`, `VERIFY_CHECK` (all 4
  check types), and `VERIFY_COMPLETED` emissions

### Changed
- Response truncation in `DefaultSafeExecutionLayer.safeLLMCall()` now uses the `maxPromptLength`
  parameter consistently for both prompt and response capping

### Tests
- SafeExecutionLayer: 23 tests — 11 validateFile (size, gitignore, syntax, security, edge cases,
  events), 10 safeLLMCall (injection, retry, auth skip, truncation, events), 2 executeInSandbox
  (Docker unavailable, events)
- VerifyModule EventBus: 9 tests — event emissions for all verification check types

---

## [1.25.0] - 2026-09-29

### Added
- **Website v1.24.0 updates** — Hero metrics updated to 2,184 tests; Architecture section upgraded from "Phase 1→6" to "Phase 1→8", highlights updated to "8/8" phases, "8/8" modules extracted, "2,184" tests
- **README.md** — Added Phase 6 (Architecture Migration) to roadmap table with 8 sub-phases (6.1–6.8); added Phase 6 section to phase-wise feature summary with 10 module entries
- **Product_Guide.md** — Added feature inventory items 57–64 for all architecture modules; added section 7.6 with detailed 8-module migration table
- **User_Manual.md** — Added Phase 6: Architecture Migration section with 10 module entries (RecoverModule through TestModule)

### Changed
- All documentation now consistently references v1.24.0 release and 2,184+ test count

---

## [1.24.0] - 2026-09-29

### Added
- **ExecuteModule tests** — 24 new unit tests for `DefaultExecuteModule`: execute() with callLLM (happy path,
  npm test validation, command inference), execute() without callLLM (fallback), inferCommand (backtick,
  `Run:` prefix, `run <file>`, npm patterns, file extension), EventBus emissions
  (`EXECUTE_STARTING`/`EXECUTE_COMPLETED`/`EXECUTE_FAILED`)
- **TestModule tests** — 27 new unit tests for `DefaultTestModule`: runTests() with callLLM (vitest,
  jest, generic output formats), runTests() without callLLM (fallback), parseTestOutput (vitest,
  jest, generic, malformed/no match), detectFramework, detectTestCommand, EventBus emissions
  (`TEST_STARTED`/`TEST_COMPLETED`/`TEST_FAILURE`)
- **Migration roadmap SVG** — Updated to Phase 1-8 with Phase 7 (Plan+EditModule) and Phase 8
  (Execute+TestModule) timeline nodes and detail cards in second row; 10-row comparison table;
  updated metrics (8/8 phases, 150+ tests, 8 modules extracted)

### Changed
- Phase 5 badge in migration-roadmap.svg corrected from "IN PROG" to "DONE"

### Tests
- Total module tests: PlanModule (41) + EditModule (34) + ExecuteModule (24) + TestModule (27) = **126 module tests**

---

## [1.23.0] - 2026-09-29

### Added
- **ExecuteModule (Phase 8)** — `DefaultExecuteModule` extracted from `RunnerAgent`: pluggable command
  execution with 5-strategy command inference (backtick, `Run:` prefix, `run <file>`, npm patterns, file
  extension), npm test validation against `package.json`, structured `ExecuteResult` output (stdout, stderr,
  exit code, duration), EventBus integration with `EXECUTE_STARTING`/`EXECUTE_COMPLETED`/`EXECUTE_FAILED` events
- **TestModule (Phase 8)** — `DefaultTestModule` extracted from `TesterAgent`: pluggable sandboxed test
  execution with temp directory creation, project file copying (excluding `node_modules`/`.git`/etc.),
  file change application, dependency installation (npm install), multi-framework test output parsing
  (vitest, jest, generic), `TEST_STARTED`/`TEST_COMPLETED`/`TEST_FAILURE` events

### Changed
- `website/index.html` — Architecture section: `6/6` → `7/8` Phases Complete, `8 Modules Designed` →
  `5/8 Modules Extracted`, test count `2,058` → `2,133`

---

## [1.22.0] - 2026-09-28

### Added
- **PlanModule (Phase 7)** — `DefaultPlanModule` extracted from `PlannerAgent`: pluggable goal decomposition
  with prompt building (goal + file tree + memory context), 3-LLM-response parsing strategies (direct JSON,
  code block, array extraction), step normalization (numeric IDs, null dependsOn, missing fields),
  fallback plan when no `callLLM` provided, and `PLAN_STARTED`/`PLAN_STEP_CREATED`/`PLAN_COMPLETED` events
- **EditModule (Phase 7)** — `DefaultEditModule` extracted from `WriterAgent`: pluggable file change
  generation with prompt building (artifacts + goal + MCP tools), `filepath:` code block parsing,
  AST syntax validation, token-budget-aware file selection (prioritizes smaller files, max 10 files,
  16K char budget), 2-attempt retry loop with rate-limit handling (skip/abort/switch-model/retry),
  mutable `currentCallLLM` for model-switch support, and `EDIT_GENERATING`/`EDIT_WRITTEN`/`EDIT_SKIPPED` events

### Tests
- **PlanModule: 41 new tests** — plan() with/without callLLM, parsePlan (direct JSON/code block/array extraction/
  malformed responses), normalizeSteps (numeric IDs, null dependsOn, missing fields, step filtering),
  EventBus emissions (3 event types, source verification)
- **EditModule: 34 new tests** — edit() happy path (multi-file, new file, unchanged file),
  empty results, LLM errors, rate-limit handling (skip/abort/switch-model), parseFileChanges
  (filepath prefix, spaces, empty blocks), addFileChange (modified/created/identical content),
  validateChanges (valid syntax, syntax warnings, non-source files), token budget, EventBus emissions

---

## [1.21.0] - 2026-09-27

### Added
- **VerifyModule (Phase 6)** — Explicit verification pipeline with `security`, `goal-alignment`, `tests`,
  and `code-quality` check types; low/medium/high strictness levels; pass/fail scoring with configurable
  pass thresholds (0.5/0.7/0.9)
- **LLM-based file classification** — `DefaultInspectModule.classifyWithLLM()` dispatches files to
  specialized agents (debugger, reviewer, tester, mcp-agent, security-agent) based on file content analysis
- **EventBus LoggerConsumer** — Handlers for `VERIFY_STARTING`, `VERIFY_CHECK`, `VERIFY_COMPLETED` events
- **Pipeline PR summary SVG** — 14-agent pipeline flow diagram for the website
- `ROADMAP_TODO.md`, `spec.md`, `spec_roadmap.md`, `spec_upgrade.md` — roadmap and spec documentation

### Changed
- `DefaultInspectModule.scanByKeywords()` — improved walkAndScore with additive keyword scoring,
  depth-5 limit, directory-name matching, symlink skipping
- `DefaultInspectModule.parseClassifyResponse()` — robust JSON extraction with markdown-wrapped,
  malformed, and empty response fallbacks
- **Architecture migration (Phase 6)** — 8-module architecture designed (InspectModule, ReportModule,
  VerifyModule, PlanModule, EditModule, ExecuteModule, TestModule, RecoverModule) with 3 extracted;
  remaining 5 modules scheduled for future phases
- `.gitignore` — added `.DS_Store` to prevent macOS metadata clutter

### Fixed
- **Followup first-letter truncation** — broken regex `\U` (treated as literal `U`, creating range `0-U`
  that stripped letters `A`–`U`) → fixed with `\u{XXXX}` + `u` flag for proper emoji stripping
- **Followup auto-continue** — removed duplicate "What next?" prompt after followup execution;
  followup result now falls through cleanly to the main goal loop
- Redundant `printOrchestrationResult` call in followup dispatch handler (already handled by `runSingleGoal`)

### Tests
- InspectModule tests expanded from **41 → 74 tests** (event spy emissions, walkAndScore scoring,
  parseClassifyResponse edge cases, inspect error handling, symlink/symlink-permission scenarios)
- VerifyModule: **28 new tests** (all 4 check types, strictness levels, dedup, scoring)

---

## [1.20.0] - 2026-09-20

### Added
- **InspectModule (Phase 5)** — codebase scanning wrapper around ContextGathererAgent with keyword
  scoring (+3 name match, +1 path match), depth limiting (5), `.buffignore` pattern support,
  binary/symlink skipping, and LLM-based file classification
- **ReportModule (Phase 4)** — Pluggable report formatters (markdown, JSON, summary, verbose) with
  EventBus integration and 4 structured event types
- **Architecture roadmap SVG** — Visual migration timeline (Phase 1→6) for the website
- **Website provider showcase SVG** — Visual logo grid of 17+ supported AI providers

### Changed
- `DefaultInspectModule` — scanByKeywords now respects `.buffignore` patterns, depth limit (5),
  and skips binary/symlink files
- `website/index.html` — added Architecture Migration section with roadmap SVG and metric highlights
- `website/styles.css` — architecture-visual section with glow hover effects, responsive grid

### Tests
- InspectModule: 41 tests covering inspect(), scanByKeywords(), walkAndScore(),
  parseClassifyResponse(), and keyword-based file discovery

---

## [1.19.0] - 2026-09-15

### Added
- **EventBus** — Structured observability system with 37 typed events and 4 built-in consumers
  (LoggerConsumer, MetricsConsumer, AuditConsumer, MetricsBufferConsumer)
- **Architecture documentation** — `ARCHITECTURE.md` with full 8-module design, extensibility hooks,
  plug-and-play agent lifecycle, and event-driven observability
- **Mermaid architecture diagrams** — `ARCHITECTURE_DIAGRAMS.md` with 5 visual diagrams:
  Module Architecture, Extensibility, Execution Flow, Event Bus Data Flow, Migration Timeline

### Changed
- `DefaultOrchestrator` — wired to EventBus; emits 14 pipeline lifecycle events
- A2A tests — increased timeout to accommodate real Orchestrator initialization
- Documentation expanded with cross-references between ARCHITECTURE.md and all strategic docs

---

## [1.18.0] - 2026-08-29

### Added
- `PRODUCT_STRATEGY.md` — comprehensive product strategy with product thesis, competitive landscape (pricing matrix, 22-dimension feature comparison, positioning map, target user match, competitive advantages), OKR framework (5 objectives, 19 key results), and risk register
- `PITCH_DECK.md` — 10-slide investor presentation outline with talking points, architecture diagrams, traction timeline, business model (3-tier + marketplace), quarterly OKR roadmap, and partnership/investment ask
- `CONTRIBUTING.md` — quick-reference contributor guide with documentation map (12 linked docs), development setup, testing commands, contribution workflow, and area-idea table
- Cross-references to strategic docs in `README.md` (Roadmap callout box) and `Product_Guide.md` (§9 Strategy & Pitch Deck + TOC entry)
- PITCH_DECK.md references to both `README.md` and `Product_Guide.md` alongside existing PRODUCT_STRATEGY.md links

### Changed
- `README.md` — added strategic docs callout box in Roadmap section, extended with PITCH_DECK.md reference
- `Product_Guide.md` — added §9 Strategy & Pitch Deck with docs table and competitive highlights, updated TOC
- `Product_Guide.md` — fixed TOC anchor link for §9 (`strategy-pitch-deck`)

---

## [1.17.0] - 2026-08-28

### Added
- `CHANGELOG.md` — comprehensive version history from v1.0.0 to v1.17.0 following Keep a Changelog format
- Comprehensive Phase-Wise Feature Summary in README, Product Guide, and User Manual
- Version History table in README (v1.0.0 through v1.17.0)
- Agent Catalog table — 13 agent roles with type, description, and version introduced
- Release Phases overview mapping version ranges to development phases

### Changed
- **Product_Guide.md** — updated to v1.16.1 → v1.17.0 alignment, Phase 4 & 5 roadmap completed, version history extended, test counts updated (1620→1830+)
- **User_Manual.md** — updated to v1.16.1 → v1.17.0 alignment, added Phase-Wise Feature Summary, updated key concepts and glossary
- **README.md** — Phase 4 marked complete (6 items), new Phase 5 added (5 items), Version History extended through v1.17.0
- Architecture diagram updated to show all 14 agent roles
- Multi-agent pipeline section enhanced with table format and interactive dev mode documentation

### Fixed
- Product_Guide.md footer version (v1.14.6 → v1.17.0)
- Agent count consistency across all docs (10+ → 15 agent roles & management)

---

## [1.16.1] - 2026-08-27

### Added
- Interactive dev mode enhancements — failure analysis with per-agent-type recovery actions
- Follow-up suggestions — LLM-powered contextual next-step recommendations after goal execution
- `/fix` command — retry last failed goal with failure context, shows post-execution analysis
- 35 new unit tests for failure analysis, follow-up suggestions, and handlePostExecution methods
- Enhanced post-execution UX with dynamic choices (continue, switch model, history, exit, retry-fix, followup)

### Changed
- `/fix` command now shows post-execution actions (consistent with `retry-fix` behavior)
- Session history tracking via shared `handlePostExecution` method
- Comprehensive README update with Phase-Wise Feature Summary, Version History, and Agent Catalog

### Fixed
- ESM module mocking in tests — replaced `vi.spyOn` with `getProviderConfig` throw strategy
- Input validation test — fixed test data that was exceeding the 3-suggestion limit in fallback logic

---

## [1.16.0] - 2026-08-26

### Added
- Comprehensive MCP README documentation with stdio and SSE transport examples
- SSE header support for MCP — Bearer auth and custom headers for remote MCP connections

### Changed
- Firecrawl integration for web search via MCP

---

## [1.15.6] - 2026-08-25

### Added
- Firecrawl integration for web search and scraping

---

## [1.15.5] - 2026-08-24

### Added
- SSE (Server-Sent Events) header support for MCP transport
- Bearer token authentication for remote MCP servers

---

## [1.15.4] - 2026-08-23

### Added
- Search/filter bar for model discovery
- Column count toggle (3/4/5 columns) for model display
- Speech provider section in model picker

---

## [1.15.3] - 2026-08-22

### Fixed
- Accessibility fix — replaced `window.open` with native `<a>` tags in SpeechProviderSection

---

## [1.15.2] - 2026-08-21

### Fixed
- Windows compatibility fixes for runner and sandbox agents

---

## [1.15.1] - 2026-08-20

### Added
- Interactive development mode — `buff execute` without a goal launches a guided loop
- Model picker — interactive provider/model selection at dev mode start
- Session tracking — full goal history within a development session
- `/save <name>` — save development session state to disk
- `/resume <name>` — restore a previously saved session with full history
- `/suggest` — search past trajectories for similar goals

---

## [1.15.0] - 2026-08-19

### Added
- npm publishing — `npx agent-nuvira` / `npx buff` live on npm (1.3 MB package)
- Zero-setup onboarding for new users

---

## [1.14.6] - 2026-07-28

### Added
- Skill Compiler — auto-extracts reusable patterns from successful trajectories into parameterized skill scripts
- Context-Window Memory Pruner — 5 strategies (metadata strip, file collapse, conversation truncation, artifact summarize, aggressive fallback)
- Context-Preserving Model Switching — `buff model switch` changes providers mid-session without losing agent state
- Docker Compose Setup — 5-minute onboarding with multi-stage Dockerfile, health checks, persistent volume
- Project Scaffolding — `buff init` with 5 built-in templates and interactive provider selection wizard

### Technical
- Skill Store with decay scoring, garbage collection, and keyword search
- Token estimation heuristic with 1-token-per-4.5-char ratio
- 156 new tests (84 skill system + 72 context pruner), 1479 total

---

## [1.14.5] - 2026-07-22

### Fixed
- `/exit` command now actually terminates the process (no lingering "You:" prompt)
- Ctrl+C double-press logic moved from process-level to readline handler (first press shows warning, second press exits)
- Process-level SIGINT simplified to immediate exit (appropriate for API-call interruptions)

---

## [1.14.4] - 2026-07-20

### Added
- Rate-limit header parsing across all cloud providers (7+ header naming conventions)
- Green/Amber status based on real quota data (>20% = Green, ≤20% = Amber)
- New "Quota" column in dashboard models table

### Fixed
- OpenRouter models now correctly reflect rate-limit status

---

## [1.14.3] - 2026-07-18

### Added
- Interactive error recovery on API failures (retry, switch provider, cancel, exit)
- Seamless provider switching preserves all conversation history

### Fixed
- Ctrl+C single press now shows warning, second press exits

---

## [1.14.2] - 2026-07-16

### Added
- Web dashboard `/api/models` endpoint with provider health data
- Color-coded model table (Green = working, Amber = limited, Red = unavailable)
- Provider card headers with overall status
- Quota remaining indicator

---

## [1.14.1] - 2026-07-14

### Fixed
- Rename "Agent-Baba-D" to "Agent-Nuvira" in dashboard
- Windows `spawn start ENOENT` error on dashboard launch
- Cross-platform browser opening logic

---

## [1.14.0] - 2026-07-12

### Added
- Full Windows CI test suite (GitHub Actions)
- Multi-line input in interactive chat

### Fixed
- Cross-platform echo commands in runner tests

### Changed
- Published to npm as `agent-nuvira`

---

## [1.13.0] - 2026-07-10

### Added
- Hybrid model routing — complexity-based model selection with cost optimization
- Team collaboration — Git-synced shared config, memory, and review pipelines
- Agent SDK — `@agent-nuvira/sdk` npm package with scaffolding CLI
- Provider fallback routing — auto-failover with circuit breaker and configurable chain
- Security scan CLI — `buff security scan` for PII, injection, and dangerous code detection
- Feedback & rating system — `buff feedback record/list/stats/clear`
- Marketplace unified CLI — `buff marketplace browse/search/install/info`

---

## [1.12.0] - 2026-07-08

### Added
- VS Code extension — 9 commands, inline suggestions, diff viewer, agent progress panel
- Remote agent federation — multi-machine collaboration via TCP protocol
- Web UI dashboard — React dashboard with DAG, health, cost, history, benchmarks
- Shared model picker, spinner UX, model-picker tests

---

## [1.11.0] - 2026-07-06

### Added
- Skill compiler — auto-extracts reusable patterns from trajectories into runnable skills
- Context-window memory pruner — token-aware compression for long agent chains
- Context-preserving model switching — `buff model switch`
- Speech model labeling in model picker

---

## [1.10.0] - 2026-07-04

### Added
- Docker sandbox isolation — resource-limited, network-isolated containers, 8 base images
- Provider health dashboard — `buff doctor` with color-coded status and watch mode
- Human-readable model names in picker
- Categorized model selection (chat, code, vision)

---

## [1.9.0] - 2026-07-02

### Added
- Workflow template marketplace — 10 built-in templates + GitHub registry with install/publish
- Model benchmarking — 21 standardized coding tasks with scoring and A/B comparison
- Model categorization + smart picker

---

## [1.8.0] - 2026-06-30

### Added
- Native embedding support — 3-tier embedder (Xenova/Python/LLM) with LRU cache
- Vector store — cosine similarity search over embedded trajectories
- Trajectory store — few-shot example storage with quality scoring
- Memory integration — context retrieval + storage orchestration

---

## [1.7.1] - 2026-06-29

### Changed
- Rate-limit UX improvements with smart retry logic
- Better error messages for rate-limit errors

---

## [1.7.0] - 2026-06-28

### Added
- Groq LPU integration for fastest open-source model inference
- Streaming support — token-by-token output (Groq, NIM, OpenRouter)
- Plugin system — programmatic API + auto-discovery from `~/.buff/plugins/`
- Cost tracking — per-provider, per-session, monthly cost dashboards

---

## [1.6.0] - 2026-06-25

### Added
- Agent retry logic with exponential backoff (3 attempts)
- Format validation — auto-retry on malformed agent output
- Git integration — branch creation, commit with LLM-generated messages
- PR description generation from git diff

---

## [1.5.1] - 2026-06-20

### Fixed
- Windows CI pipeline fixes

---

## [1.5.0] - 2026-06-18

### Added
- TesterAgent — sandboxed test execution in isolated temp directory
- RunnerAgent — shell command execution with output capture
- DebuggerAgent — iterative test-fix loop using LLM (up to 3 iterations)
- SecurityAgent — prompt injection + secret/PII scanning

---

## [1.4.1] - 2026-06-15

### Fixed
- Bug fixes, Windows compatibility improvements

---

## [1.4.0] - 2026-06-12

### Added
- Multi-agent pipeline (`buff execute` command)
- PlannerAgent — goal decomposition and task planning
- WriterAgent — code implementation with retry logic
- ContextGathererAgent — codebase scanning and file discovery
- ReviewerAgent — code review, bug detection, style checks

---

## [1.3.0] - 2026-06-10

### Added
- Implementation plans (`buff plan` command)
- Codebase-aware plan generation with architecture impact analysis
- Structured plan output (summary, files, architecture, steps, risks, testing)

---

## [1.2.0] - 2026-06-08

### Added
- AI-assisted file editing (`buff edit` command)
- Dry-run mode for safe previews
- File context support

---

## [1.1.0] - 2026-06-05

### Added
- Model discovery — `buff models` with search/filter across all providers
- Provider-specific model listing (Groq, NIM, Gemini, OpenRouter)

---

## [1.0.0] - 2026-06-01

### Added
- Initial release
- Core CLI with 25+ commands via Commander.js
- 5 built-in inference providers (expandable to 17+ via env vars + plugin system): Groq, NVIDIA NIM, Google Gemini, OpenRouter, Local (Ollama/HuggingFace/GGML)
- Interactive chat with conversation history and `/` commands
- Configuration system — JSON config file + env vars + CLI flags priority chain
- SQLite-backed response caching with configurable TTL
- Plugin system foundation
- MIT License

---

## Agent Catalog

### Agent Roles (16)

| Agent | Type | Description | Version |
|-------|------|-------------|---------|
| **PlannerAgent** | Core | Goal decomposition, dependency-aware task planning | v1.4.0 |
| **ContextGathererAgent** | Core | Codebase scanning, file discovery, artifact identification | v1.4.0 |
| **WriterAgent** | Core | Code implementation with retry + format validation | v1.4.0 |
| **ReviewerAgent** | Core | Code review, bug detection, security + style checks | v1.4.0 |
| **RunnerAgent** | Execution | Shell command execution with output capture | v1.5.0 |
| **TesterAgent** | Testing | Sandboxed test execution (temp dir / Docker) | v1.5.0 |
| **DebuggerAgent** | Testing | Iterative test-fix loop via LLM (3 iterations) | v1.5.0 |
| **SecurityAgent** | Safety | Prompt injection, secret/PII, dangerous code scanning | v1.5.0 |
| **GitAgent** | Publishing | Branch creation, LLM commit messages, PR descriptions | v1.6.0 |
| **PackageAgent** | Publishing | Version bump, npm build, publish, changelog generation | v1.6.0 |
| **GitHubReleaseAgent** | Publishing | Tag creation, release notes, GitHub releases | v1.6.0 |
| **SkillRunnerAgent** | Learning | Execute compiled skill scripts as pre-built task plans | v1.11.0 |
| **MCPAgent** | Integration | Invoke MCP tools from connected servers (stdio/SSE) | v1.16.0 |
| **GitLabAgent** | Integration | GitLab MR management, issues, pipelines | v1.32.0 |
| **PRReviewAgent** | Review | GitHub PR review with inline comments + security scans | v1.32.0 |
| **IssueTriageAgent** | Management | Issue classification, prioritization, auto-labeling | v1.32.0 |

### Release Phases

| Phase | Versions | Description |
|-------|----------|-------------|
| **Phase 0: Foundation** | v1.0.0 – v1.3.0 | Core CLI, chat, edit, plan, 5 built-in providers (expandable to 17+) |
| **Phase 1: Quick Wins** | v1.4.0 – v1.7.0 | Multi-agent pipeline, plugins, streaming, cost tracking |
| **Phase 2: Structural Changes** | v1.8.0 – v1.10.0 | Memory system, workflows, benchmarks, Docker sandbox |
| **Phase 3: Major Upgrades** | v1.11.0 – v1.14.6 | Skills, pruner, VS Code, federation, dashboard, SDK |
| **Phase 4: Industry Standards** | v1.15.0 – v1.16.0 | MCP, A2A, CI/CD, npm publishing, error-repair |
| **Phase 5: Interactive UX** | v1.16.1 | Interactive dev mode, failure analysis, follow-up suggestions, /fix |
