# Agent-Nuvira for VS Code

[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/dheerajsharma.agent-nuvira-vscode)](https://marketplace.visualstudio.com/items?itemName=dheerajsharma.agent-nuvira-vscode)
[![Visual Studio Marketplace Downloads](https://img.shields.io/visual-studio-marketplace/d/dheerajsharma.agent-nuvira-vscode)](https://marketplace.visualstudio.com/items?itemName=dheerajsharma.agent-nuvira-vscode)
[![Open VSX Registry](https://img.shields.io/open-vsx/v/dheerajsharma/agent-nuvira-vscode)](https://open-vsx.org/extension/dheerajsharma/agent-nuvira-vscode)

> **This is not just a VS Code extension — it's the full Agent-Nuvira development agent, on your editor *and* on the CLI.**
>
> Agent-Nuvira is a complete, open-source multi-agent AI coding assistant that runs entirely from your terminal (`agent-nuvira` on npm — `npx agent-nuvira`). The VS Code extension is the editor surface for the **same 17-agent engine**: every agent, every routing decision, every vector-store lookup in this extension is powered by the CLI, and every feature below is equally available — and more powerful — from the command line.
>
> ```bash
> # The full agent, no editor required
> npx agent-nuvira execute "implement user authentication with JWT"
> ```
>
> ---
>
> ## Features

### 🤖 17 Specialized Agents
Agent-Nuvira orchestrates 17 AI agents that collaborate to accomplish complex coding tasks — in VS Code *and* from the CLI:

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
| **GitLab** | Full GitLab REST API — MRs, issues, pipelines |
| **Package** | Manages npm/pip dependencies |
| **GitHub Release** | Creates releases and changelogs |
| **PR Review** | Inline code review on open PRs |
| **Issue Triage** | Classifies and prioritizes issues |
| **Branch Automation** | Git hooks, auto-branch workflows |
| **Skill Runner** | Runs compiled reusable skills |
| **MCP** | Invokes external tools via Model Context Protocol |

### 🎯 Smart Code Assistance
- **Inline Code Suggestions** — As-you-type completions powered by AI agents (debounced, context-aware)
- **Quick Fix** — Apply agent-powered fixes to the current file
- **Code Review** — Full file review with actionable suggestions
- **Explain Code** — Get detailed explanations of selected code
- **Generate Tests** — Automatically create unit tests for files or selections

### 🔌 17+ Multiple AI Providers
Supports 17+ providers (5 built-in + 12 configurable via env vars) plus custom plugins:
- **Local** — Ollama, HuggingFace, GGML, LM Studio (fully offline, free)
- **Groq** — Fast cloud inference, generous free tier
- **NVIDIA NIM** — Enterprise-grade models
- **Google Gemini** — Free tier available
- **OpenRouter** — Access to 100+ models
- **OpenAI · Anthropic · Mistral · Cohere · Together · DeepInfra · Fireworks · Perplexity · Azure · LM Studio · Anyscale · vLLM** — configurable via environment variables
- **Auto routing** — a Thompson-sampling bandit learns which provider/model wins per task type and picks the best one automatically (free/local-first via the quota ledger), with mid-session failover when a key expires or a quota resets

### 🎛️ Model & Provider Switcher
- **Status-bar model indicator** — shows the active provider/model; click to switch
- **Switch Model / Provider...** — pick from all available providers (with availability status) or enable **Auto routing**; picking a provider lists its **actual models** (`buff models`) in a **searchable quick-pick** (native type-to-filter matches model names *and* ids — handy for providers with 100+ models like OpenRouter), so you can choose a specific one, or keep the provider default
- **Chat Panel dropdown** — a provider/model dropdown in the chat sidebar header switches the active provider (or enables Auto routing) without leaving the chat, and refreshes the status-bar indicator
- **Check Model Health** — runs `agent-nuvira model health` for the active provider and shows the report
- **Auto routing toggle** — when enabled, every AI flow routes each request to the best provider/model automatically: chat, execute, inline suggestions, code-lens actions, and diagnostic fixes. Note: inline completions are latency-sensitive — if suggestions feel slower with auto-routing enabled, pin a fast provider instead
- **Quota Ledger View** — a quota status-bar indicator (alert count when providers are parked) plus `Agent-Nuvira: Show Quota Ledger` opens a webview with free/local vs paid token usage, estimated savings, per-provider window tables (tokens, requests, time-to-reset, parked state), and the failover timeline (parked → failover → re-enabled). **Live updates**: the panel watches the CLI memory dir and auto-refreshes the moment a failover/park/window-reset is written by any process sharing it (CLI, chat, dashboard) — no manual Refresh needed, with a periodic 60s poll as a safety net for platforms where file watching is unreliable
- **IDE usage telemetry** — every LLM call the extension drives is attributed in the CLI's Model Availability Registry per-action "learned from real usage" log (and the `buff dashboard` Models panel) via the `BUFF_TELEMETRY_ACTION` env tag at spawn: chat panel → `ide-chat`, inline suggestions → `ide-inline`, execute/edit/workflow/review → `ide-<command>`. A provider killed by an IDE action is skipped predictively by every other action (CLI + IDE alike); run `buff models status --verbose` to see the learned blocks

### 🧠 FAISS Vector Store + Team Collaboration
- **Local FAISS-backed vector store** — semantic code search with a native FAISS backend (pure-JS fallback) that respects `.gitignore`; large contexts are chunked, embedded locally, and reduced to the top-k relevant chunks so free quotas stretch further
- **Real-Time Team Collaboration** — Git-synced shared config, memory, and review pipelines across your team
- **`buff memory backend --check`** — see which vector backend (faiss-native / faiss-ivf / json) is active on your machine

### 📊 Visual Feedback
- **Agent Progress Panel** — Real-time webview showing agent execution status, logs, and diffs
- **Diff Viewer** — Preview proposed changes with VS Code's native diff editor before accepting
- **Status Bar** — Quick access to agent commands and the active model indicator

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

### 3. Switch Providers / Models

Click the model indicator in the status bar (e.g. `chip Groq/llama-3.3-70b`) or run **Agent-Nuvira: Switch Model / Provider...**:

1. Choose **Auto routing** to let the agent decide per task, or
2. Pick a specific provider (status icons show ✅ available / ⚠️ unreachable / ⏳ needs key)

> If **Auto routing** is enabled in settings, the extension asks for confirmation before pinning a specific provider, since auto routing overrides pinned choices for chat/execute.

### 4. Use Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+A E` | Execute Goal |
| `Ctrl+Shift+A Q` | Quick Fix current file |
| `Ctrl+Shift+A R` | Review current file |
| `Ctrl+Shift+A P` | Show Agent Panel |
| `Ctrl+Shift+A A` | Accept all changes |
| `Ctrl+Shift+A R` | Reject all changes |

### 5. Right-Click in Explorer

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
| `agent-nuvira.useAutoRouting` | `false` | Auto model routing — pick the best provider/model per task (applies to chat, execute, inline suggestions, code-lens actions & diagnostic fixes) |

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
| `Agent-Nuvira: Switch Model / Provider...` | Switch the active provider/model or enable Auto routing |
| `Agent-Nuvira: Check Model Health` | Run a health check on the active provider |
| `Agent-Nuvira: Show Quota Ledger` | View quota usage, parked providers, and the failover timeline |

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
