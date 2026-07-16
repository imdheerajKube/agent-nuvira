# Change Log

All notable changes to the Agent-Baba-D VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
