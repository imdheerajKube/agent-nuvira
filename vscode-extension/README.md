# Agent-Nuvira for VS Code

[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/dheerajsharma.agent-nuvira-vscode)](https://marketplace.visualstudio.com/items?itemName=dheerajsharma.agent-nuvira-vscode)
[![Visual Studio Marketplace Downloads](https://img.shields.io/visual-studio-marketplace/d/dheerajsharma.agent-nuvira-vscode)](https://marketplace.visualstudio.com/items?itemName=dheerajsharma.agent-nuvira-vscode)
[![Open VSX Registry](https://img.shields.io/open-vsx/v/dheerajsharma/agent-nuvira-vscode)](https://open-vsx.org/extension/dheerajsharma/agent-nuvira-vscode)

> **Multi-agent AI coding assistant** — plan, write, review, test, and publish code using local or cloud AI models, all from within VS Code.

---

## Features

### 🤖 11+ Specialized Agents
Agent-Nuvira orchestrates multiple AI agents that collaborate to accomplish complex coding tasks:

| Agent | Role |
|-------|------|
| **Planner** | Breaks down goals into ordered execution plans |
| **Context Gatherer** | Scans and understands your codebase |
| **Writer** | Generates and modifies code files |
| **Reviewer** | Reviews code for bugs, security, and best practices |
| **Tester** | Writes and runs unit tests |
| **Debugger** | Diagnoses and fixes test failures |
| **Runner** | Executes commands and captures output |
| **Security** | Audits code for vulnerabilities |
| **Git** | Commits, branches, and manages version control |
| **Package** | Manages npm/pip dependencies |
| **GitHub Release** | Creates releases and changelogs |

### 🎯 Smart Code Assistance
- **Inline Code Suggestions** — As-you-type completions powered by AI agents (debounced, context-aware)
- **Quick Fix** — Apply agent-powered fixes to the current file
- **Code Review** — Full file review with actionable suggestions
- **Explain Code** — Get detailed explanations of selected code
- **Generate Tests** — Automatically create unit tests for files or selections

### 🔌 Multiple AI Providers
Supports 5 built-in providers plus custom plugins:
- **Local** — Ollama, HuggingFace, GGML (fully offline, free)
- **Groq** — Fast cloud inference
- **NVIDIA NIM** — Enterprise-grade models
- **Google Gemini** — Free tier available
- **OpenRouter** — Access to 100+ models

### 📊 Visual Feedback
- **Agent Progress Panel** — Real-time webview showing agent execution status, logs, and diffs
- **Diff Viewer** — Preview proposed changes with VS Code's native diff editor before accepting
- **Status Bar** — Quick access to agent commands

---

## Installation

### From VS Code Marketplace

1. Open VS Code
2. Press `Ctrl+Shift+X` (or `Cmd+Shift+X` on macOS) to open the Extensions view
3. Search for "Agent-Nuvira"
4. Click **Install**

Or install from the command line:

```bash
code --install-extension dheerajsharma.agent-nuvira-vscode
```

### From VSIX Package

Download the latest `.vsix` from the [Releases page](https://github.com/imdheerajKube/agent-nuvira/releases) and install:

```bash
code --install-extension agent-nuvira-vscode.vsix
```

### Prerequisites

The extension requires the [agent-nuvira CLI](https://www.npmjs.com/package/agent-nuvira) to be installed:

```bash
npm install -g agent-nuvira
```

> **Note:** The extension communicates with the `agent-nuvira` CLI via child process. Make sure `agent-nuvira` is available in your PATH, or configure the path in extension settings.

---

## Quick Start

### 1. Configure a Provider

Set your preferred AI provider. The extension uses the same configuration as the CLI:

```bash
agent-nuvira config set defaultProvider groq
export GROQ_API_KEY=gsk_your_key_here
```

Or configure directly in VS Code settings (`Ctrl+,` → search "agent-nuvira").

### 2. Run a Goal

1. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS) to open the command palette
2. Type "Agent-Nuvira: Execute Goal" and press Enter
3. Enter your goal (e.g., "Add authentication to the login route")
4. Watch agents collaborate in the progress panel

### 3. Use Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+A E` | Execute Goal |
| `Ctrl+Shift+A Q` | Quick Fix current file |
| `Ctrl+Shift+A R` | Review current file |
| `Ctrl+Shift+A P` | Show Agent Panel |
| `Ctrl+Shift+A A` | Accept all changes |
| `Ctrl+Shift+A R` | Reject all changes |

### 4. Right-Click in Explorer

Right-click any source file to **Review File**, **Quick Fix**, or **Generate Tests**.

---

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `agent-nuvira.cliPath` | `agent-nuvira` | Path to the `agent-nuvira` CLI executable |
| `agent-nuvira.defaultProvider` | `""` | Default AI provider (overrides config) |
| `agent-nuvira.defaultModel` | `""` | Default model (overrides config) |
| `agent-nuvira.autoApplyChanges` | `false` | Auto-apply agent changes without preview |
| `agent-nuvira.maxTokens` | `4096` | Max tokens for agent responses |
| `agent-nuvira.showProgressPanel` | `true` | Auto-show panel when tasks start |

---

## Commands

| Command | Description |
|---------|-------------|
| `Agent-Nuvira: Execute Goal...` | Run a multi-agent pipeline |
| `Agent-Nuvira: Quick Fix` | Apply quick agent fix |
| `Agent-Nuvira: Review File` | Review current file |
| `Agent-Nuvira: Explain Code` | Explain selected code |
| `Agent-Nuvira: Generate Test` | Generate unit tests |
| `Agent-Nuvira: Show Agent Panel` | Open progress panel |
| `Agent-Nuvira: Run Workflow...` | Run workflow template |
| `Agent-Nuvira: Accept All Changes` | Accept proposed changes |
| `Agent-Nuvira: Reject All Changes` | Reject proposed changes |

---

## Requirements

- **VS Code** >= 1.85.0
- **Node.js** >= 18.0.0
- **agent-nuvira CLI** (`npm install -g agent-nuvira`)
- **API key** for at least one cloud provider, or **Ollama** for local inference

---

## Development

```bash
# Clone the repository
git clone https://github.com/imdheerajKube/agent-nuvira.git
cd agent-nuvira/vscode-extension

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode
npm run watch

# Package into .vsix
npm run package
```

---

## Marketplace Listings

- [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=dheerajsharma.agent-nuvira-vscode)
- [Open VSX Registry](https://open-vsx.org/extension/dheerajsharma/agent-nuvira-vscode)

---

## License

[MIT](https://github.com/imdheerajKube/agent-nuvira/blob/main/LICENSE)
