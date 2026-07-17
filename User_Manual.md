# Agent-Nuvira — User Manual

**Version 1.14.5 | July 2026**

> *Agent-Nuvira: Multi-agent AI coding CLI — plan, write, review, test, and publish code with local models (Ollama) or cloud APIs (Groq, NVIDIA NIM, Google Gemini, OpenRouter).*

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Prerequisites](#2-prerequisites)
3. [Installation](#3-installation)
4. [Getting Started](#4-getting-started)
5. [Configuration](#5-configuration)
6. [CLI Commands](#6-cli-commands)
7. [Usage Guide](#7-usage-guide)
8. [Troubleshooting](#8-troubleshooting)
9. [FAQ](#9-faq)
10. [Glossary](#10-glossary)

---

## 1. Introduction

### 1.1 What is Agent-Nuvira?

Agent-Nuvira is a **multi-agent AI coding assistant** that runs entirely from your terminal. It connects to 5 different AI model providers (or runs models locally) to help you:

- **Chat interactively** with AI models
- **Edit files** using natural language instructions
- **Plan codebase changes** with structured implementation plans
- **Execute multi-agent pipelines** that autonomously plan, write, review, test, and publish code
- **Discover models** across all connected providers
- **Monitor provider health** via a web dashboard

### 1.2 Key Concepts

| Concept | Description |
|---|---|
| **Provider** | An AI model service (Groq, NVIDIA NIM, Google Gemini, OpenRouter, or local/Ollama) |
| **Agent** | A specialized AI worker role (Planner, Writer, Reviewer, Tester, etc.) |
| **Orchestrator** | The engine that coordinates multiple agents to complete a goal |
| **Workflow** | A predefined sequence of agent steps, configurable via YAML templates |

### 1.3 Supported Platforms

| Platform | Status | Notes |
|---|---|---|
| macOS (Intel & Apple Silicon) | ✅ Fully supported | Tested on macOS 14+ |
| Linux (Ubuntu, Debian, Fedora) | ✅ Fully supported | Requires Node.js 21.7+ |
| Windows (10, 11) | ✅ Fully supported | PowerShell, CMD, Git Bash, WSL |

---

## 2. Prerequisites

### 2.1 Hardware Requirements

| Component | Minimum | Recommended |
|---|---|---|
| CPU | Dual-core, 2.0 GHz | Quad-core, 2.5 GHz |
| RAM | 2 GB | 8 GB |
| Storage | 100 MB free | 500 MB free (for local models) |
| Internet | Required for cloud providers | Broadband connection |

**For local models (Ollama):**
- 8 GB+ RAM recommended
- GPU optional but beneficial
- Additional 5–20 GB storage for model files

### 2.2 Software Requirements

| Software | Version | Required For |
|---|---|---|
| **Node.js** | ≥ 21.7.0 | Core runtime |
| **npm** | ≥ 10.0 | Package management |
| **Git** | ≥ 2.0 (optional) | Git operations, agent features |
| **Ollama** | Latest (optional) | Running local models |
| **Docker** | Latest (optional) | Secure sandbox execution |

### 2.3 API Keys (for Cloud Providers)

You need at least one API key to use cloud-based AI models:

| Provider | Get Key | Free Tier |
|---|---|---|
| **Groq** | [console.groq.com](https://console.groq.com) | ✅ Yes — generous rate limits |
| **NVIDIA NIM** | [build.nvidia.com](https://build.nvidia.com) | ✅ Yes — 121+ models |
| **Google Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | ✅ Yes — generous free tier |
| **OpenRouter** | [openrouter.ai/keys](https://openrouter.ai/keys) | ✅ Yes — free credits on sign-up |

---

## 3. Installation

### 3.1 Install via npm (Recommended — All Platforms)

```bash
npm install -g agent-nuvira
```

Verify the installation:

```bash
agent-nuvira --version
# Expected output: 1.14.5

agent-nuvira --help
# Shows all available commands
```

### 3.2 Install from Source

For developers who want the latest unreleased changes:

```bash
# Clone the repository
git clone https://github.com/imdheerajKube/agent-nuvira.git
cd agent-nuvira

# Install dependencies
npm install

# Build the project
npm run build

# Make globally available
npm link
```

### 3.3 Platform-Specific Instructions

#### macOS

```bash
# Using Homebrew for Node.js (recommended)
brew install node

# Install Agent-Nuvira
npm install -g agent-nuvira

# (Optional) Install Ollama for local models
brew install ollama
ollama serve
ollama pull llama2
```

#### Linux (Ubuntu/Debian)

```bash
# Install Node.js 21+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Agent-Nuvira
npm install -g agent-nuvira

# (Optional) Install Ollama for local models
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama2
```

#### Windows

**Option A: Command Prompt / PowerShell**

```bash
# Install Node.js from https://nodejs.org (v21.7+)
# Then:
npm install -g agent-nuvira
```

**Option B: Git Bash (Recommended for best experience)**

```bash
# Install Node.js from https://nodejs.org
# Open Git Bash and run:
npm install -g agent-nuvira
```

**Option C: WSL (Windows Subsystem for Linux)**

```bash
# Follow the Linux instructions above in your WSL terminal
```

> **Note:** On Windows, if you encounter `ENOENT` errors with the `dashboard` command, ensure `start` is available in your PATH. The dashboard uses platform-specific browser launch commands.

### 3.4 Verify Installation

Run these commands to confirm everything is working:

```bash
# Check version
agent-nuvira --version

# Check that all commands are available
agent-nuvira --help

# Set your API key (example with Groq)
export GROQ_API_KEY="gsk_your_key_here"

# Test with a simple chat
agent-nuvira chat "Hello! What can you do?" --provider groq
```

---

## 4. Getting Started

### 4.1 First Run — 5-Minute Quickstart

```bash
# Step 1: Set your API key
export GROQ_API_KEY="gsk_your_key_here"

# Step 2: Configure the default provider
agent-nuvira config set defaultProvider groq

# Step 3: Start chatting
agent-nuvira chat

# Step 4: Try the model explorer
agent-nuvira models --provider groq

# Step 5: Edit a file with AI
agent-nuvira edit README.md --instruction "add a badge section"
```

### 4.2 The Interactive Chat Experience

When you run `agent-nuvira chat`, you enter an interactive session:

```
🧠 Buff Chat — Groq
Model: llama-3.3-70b-versatile
Type your messages, or /help for commands, /exit to quit.
💡 Tip: Ask me to "create" something and I'll offer to switch to developer mode!

You: write a Python function to reverse a string
  >
```

**Chat Commands:**

| Command | Action |
|---|---|
| `/exit` or `/quit` | Exit the chat session |
| `/clear` | Clear conversation history |
| `/info` | Show current provider and model |
| `/help` | Show available commands |
| `/dev` | Toggle developer mode (auto-create files) |
| `/search <query>` | Search past conversations |

**Multi-line Input:** 
- Type your message on the first line
- Press **Enter** for more lines (prompt changes to `  > `)
- Press **Enter** on an empty line to submit
- Commands starting with `/` submit immediately

**Ctrl+C Behavior:**
- First press on empty line: Shows warning — *"Press Ctrl+C again to exit"*
- Second press within 2 seconds: Exits the chat
- While typing: Cancels the current input

---

## 5. Configuration

### 5.1 Configuration File

Configuration is stored at `~/.buff/buffconfig.json`. It is created automatically with sensible defaults on first use.

```json
{
  "defaultProvider": "local",
  "providers": {
    "nim": {
      "model": "meta/llama-3.1-8b-instruct",
      "temperature": 0.7,
      "maxTokens": 4096
    },
    "gemini": {
      "model": "gemini-2.0-flash-exp",
      "temperature": 0.7,
      "maxTokens": 8192
    },
    "openrouter": {
      "model": "mistralai/mistral-7b-instruct",
      "temperature": 0.7,
      "maxTokens": 4096
    },
    "groq": {
      "model": "llama-3.3-70b-versatile",
      "temperature": 0.7,
      "maxTokens": 4096
    },
    "local": {
      "runner": "ollama",
      "model": "llama2",
      "temperature": 0.7,
      "maxTokens": 4096
    }
  }
}
```

### 5.2 CLI Configuration Commands

```bash
# Show full configuration
agent-nuvira config

# Set default provider
agent-nuvira config set defaultProvider gemini

# Set a provider's model
agent-nuvira config set providers.nim.model "meta/llama-3.1-8b-instruct"

# Set a provider's temperature
agent-nuvira config set providers.groq.temperature 0.3

# Get a specific value
agent-nuvira config get providers.gemini.model

# List all providers with their status
agent-nuvira config list

# Show default configuration
agent-nuvira config init
```

### 5.3 Environment Variables

API keys can be set via environment variables. They take **priority** over the config file.

| Variable | Provider | Example Value |
|---|---|---|
| `GROQ_API_KEY` | Groq | `gsk_xxxxxxxx...` |
| `NVIDIA_NIM_API_KEY` | NVIDIA NIM | `nvapi-xxxxxxxx...` |
| `GEMINI_API_KEY` | Google Gemini | `AIzaSyxxxxxxxx...` |
| `OPENROUTER_API_KEY` | OpenRouter | `sk-or-v1-xxxxxxxx...` |

**Setting environment variables:**

```bash
# Temporarily (current terminal session)
export GROQ_API_KEY="gsk_your_key_here"

# Permanently — add to your shell profile (~/.bashrc, ~/.zshrc)
echo 'export GROQ_API_KEY="gsk_your_key_here"' >> ~/.zshrc

# Using a .env file (create at ~/.buff/.env)
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
NVIDIA_NIM_API_KEY=nvapi-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 5.4 Provider-Specific Configuration

#### Local (Ollama)

```bash
# Ensure Ollama is running
ollama serve

# Pull a model
ollama pull llama2
ollama pull mistral

# Use with Agent-Nuvira
agent-nuvira chat --provider local --model llama2

# Configure HuggingFace runner
agent-nuvira config set providers.local.runner huggingface
agent-nuvira config set providers.local.model "microsoft/phi-2"
```

#### Groq

```bash
export GROQ_API_KEY="gsk_your_key_here"
agent-nuvira chat --provider groq --model llama-3.3-70b-versatile
# Available: llama-3.3-70b-versatile, gemma2-9b-it, deepseek-ai/deepseek-v4-flash, mixtral-8x7b-32768
```

#### NVIDIA NIM

```bash
export NVIDIA_NIM_API_KEY="nvapi_your_key_here"
agent-nuvira chat --provider nim --model meta/llama-3.1-8b-instruct
# 121+ models available

# For self-hosted NIM:
agent-nuvira config set providers.nim.baseUrl "http://your-nim-host:8000/v1"
```

#### Google Gemini

```bash
export GEMINI_API_KEY="AIzaSy_your_key_here"
agent-nuvira chat --provider gemini --model gemini-2.0-flash-exp
```

#### OpenRouter

```bash
export OPENROUTER_API_KEY="sk-or-v1_your_key_here"
agent-nuvira chat --provider openrouter --model openai/gpt-4o
# 200+ models available
```

---

## 6. CLI Commands

### 6.1 Command Reference

| Command | Description | Usage |
|---|---|---|
| `chat` | Interactive chat session | `agent-nuvira chat [prompt] [options]` |
| `edit` | Edit a file with AI | `agent-nuvira edit <file> [options]` |
| `models` | List available models | `agent-nuvira models [options]` |
| `plan` | Generate implementation plan | `agent-nuvira plan [target] [options]` |
| `execute` | Run multi-agent pipeline | `agent-nuvira execute <goal> [options]` |
| `config` | Manage configuration | `agent-nuvira config [command]` |
| `cache` | Manage inference cache | `agent-nuvira cache [command]` |
| `dashboard` | Launch web dashboard | `agent-nuvira dashboard [options]` |
| `workflow` | Manage workflow templates | `agent-nuvira workflow [command]` |
| `plugins` | Manage plugins | `agent-nuvira plugins [command]` |
| `benchmark` | Run model benchmarks | `agent-nuvira benchmark [options]` |
| `sandbox` | Manage execution sandbox | `agent-nuvira sandbox [command]` |
| `stats` | View usage statistics | `agent-nuvira stats [command]` |
| `history` | View chat history | `agent-nuvira history [command]` |
| `init` | Scaffold new projects | `agent-nuvira init [project-name]` |
| `learn` | Manage learning data | `agent-nuvira learn [command]` |
| `doctor` | Run health checks | `agent-nuvira doctor` |
| `team` | Team collaboration | `agent-nuvira team [command]` |
| `sdk` | SDK tools | `agent-nuvira sdk [command]` |
| `federation` | Federation management | `agent-nuvira federation [command]` |

### 6.2 Global Options

| Option | Description |
|---|---|
| `-V, --version` | Show version number |
| `-d, --debug` | Enable debug logging |
| `-h, --help` | Show help |

### 6.3 Chat Options

```bash
agent-nuvira chat [prompt] [options]

Options:
  -f, --file <path>   Include file content as context
  -p, --provider <provider>  Inference provider
  -m, --model <model>  Model to use
  --no-cache          Disable response caching
  -d, --dev           Auto-enable developer mode

Examples:
  agent-nuvira chat                              # Interactive mode
  agent-nuvira chat "explain recursion"           # One-shot prompt
  agent-nuvira chat --file ./src/main.ts "review this"
  agent-nuvira chat --provider gemini --model gemini-2.0-flash-exp
```

### 6.4 Edit Options

```bash
agent-nuvira edit <file> [options]

Options:
  -i, --instruction <text>  What to change
  -p, --provider <provider> Inference provider
  -m, --model <model>       Model to use
  --dry-run                 Preview changes without writing

Examples:
  agent-nuvira edit src/server.ts
  agent-nuvira edit src/server.ts --instruction "add rate limiting"
  agent-nuvira edit src/server.ts --dry-run --instruction "refactor"
  agent-nuvira edit README.md --provider openrouter --model openai/gpt-4o
```

### 6.5 Models Options

```bash
agent-nuvira models [options]

Options:
  -p, --provider <provider>  Provider to query
  -s, --search <keyword>     Search models by keyword
  --all                      Show all providers (including unconfigured)

Examples:
  agent-nuvira models                         # Default provider
  agent-nuvira models --provider nim           # NVIDIA NIM models
  agent-nuvira models --search deepseek        # Search for DeepSeek models
  agent-nuvira models --all                    # All providers
```

### 6.6 Execute (Multi-Agent Pipeline) Options

```bash
agent-nuvira execute <goal> [options]

Options:
  -v, --verbose              Show agent details
  -p, --provider <provider>  Provider for all agents
  --dry-run                  Show plan without executing
  --agent-model <map>        Per-agent model config (e.g., planner=gemini,writer=groq)
  --memory                   Use persistent memory across sessions
  --review                   Create review bundle (don't apply changes)

Examples:
  agent-nuvira execute "add JWT authentication"
  agent-nuvira execute "refactor database layer" --verbose
  agent-nuvira execute "add tests" --memory
  agent-nuvira execute "fix login bug" --dry-run
```

### 6.7 Workflow Options

```bash
agent-nuvira workflow [command]

Commands:
  list              List available workflows
  run <name> [goal] Run a workflow template
  install <name>   Install a workflow from registry
  publish           Publish a workflow template
  show <name>       Show workflow details

Examples:
  agent-nuvira workflow list
  agent-nuvira workflow run quick-fix "fix typo in README"
  agent-nuvira workflow install code-review
```

### 6.8 Dashboard

```bash
agent-nuvira dashboard [options]

Options:
  -p, --port <port>    Server port (default: 3030)
  --host <host>        Server host (default: 127.0.0.1)
  --no-open            Don't open browser automatically
  --build              Rebuild dashboard before starting

Launches a web-based dashboard at http://localhost:3030 with:
- Provider health overview
- Model status table (Green/Amber/Red)
- Cost tracking charts
- Agent execution DAG visualization
- Conversation history browser
- Benchmark results
```

---

## 7. Usage Guide

### 7.1 Common Workflows

#### Workflow 1: Quick Code Question

```bash
agent-nuvira chat "How do I implement a binary search tree in Python?"
```

#### Workflow 2: Edit an Existing File

```bash
agent-nuvira edit src/api/routes.ts --instruction "add input validation for all POST endpoints"
```

#### Workflow 3: Plan a Feature

```bash
agent-nuvira plan . --task "implement user authentication with JWT"
```

#### Workflow 4: Full Multi-Agent Pipeline

```bash
agent-nuvira execute "create a health check endpoint with tests" --verbose
```

This triggers the autonomous pipeline:
1. **Planner** — Analyzes the goal, creates a task plan
2. **Context Gatherer** — Scans the codebase for relevant files
3. **Writer** — Implements the code changes
4. **Reviewer** — Validates the changes
5. **Tester** — Runs tests in a sandbox
6. **Git Agent** — Commits changes to a branch

#### Workflow 5: Hybrid Provider Strategy

```bash
# Use local models for quick edits
agent-nuvira edit README.md --instruction "fix typos" --provider local

# Use Groq for fast code generation
agent-nuvira edit src/routes.ts --instruction "add validation" --provider groq

# Use Gemini for complex planning
agent-nuvira plan . --task "design database schema" --provider gemini

# Use OpenRouter for diverse model selection
agent-nuvira chat --provider openrouter --model openai/gpt-4o
```

#### Workflow 6: Model Discovery

```bash
# See all available models
agent-nuvira models --provider groq

# Search for specific models
agent-nuvira models --search llama
agent-nuvira models --search deepseek

# Then use a discovered model
agent-nuvira chat --provider groq --model deepseek-ai/deepseek-v4-flash
```

### 7.2 Error Recovery

When an AI provider returns an error (rate limit, auth failure, server error), Agent-Nuvira shows an interactive recovery menu:

```
⚠️  Rate limit error from Groq:
    Rate limit exceeded for API key

⚡ How would you like to proceed?
  🔄  Switch to a different provider/model
  🔁  Retry with same provider
  ⏳  Wait a moment and retry
  ❌  Cancel this message
  🚪  Exit chat
```

All conversation history is preserved when switching providers — seamless migration.

### 7.3 Using the Web Dashboard

Start the dashboard with:

```bash
agent-nuvira dashboard
```

Opens at **http://localhost:3030**. The dashboard features:

| Tab | Description |
|---|---|
| **Overview** | Summary of all providers and model health |
| **Models** | Color-coded model table with Quota column (Green 🟢 / Amber 🟡 / Red 🔴) |
| **Cost** | Per-provider cost tracking charts |
| **DAG** | Real-time agent execution pipeline visualization |
| **History** | Past conversation browser with search |
| **Memory** | Vector store stats and trajectory summaries |
| **Benchmarks** | Model comparison charts and scores |

### 7.4 Team Collaboration

Agent-Nuvira supports team-based workflows via shared `.buffconfig.json` files:

```bash
# Join a team project
agent-nuvira team join

# Sync shared memory
agent-nuvira team sync

# Create a review bundle
agent-nuvira team review

# Share trajectories with the team
agent-nuvira team share
```

### 7.5 Creating Custom Agents (SDK)

The `@agent-nuvira/sdk` package lets you build custom agents:

```bash
# Install the SDK
npm install @agent-nuvira/sdk

# Scaffold a new agent
npx @agent-nuvira/sdk scaffold my-agent

# Or via CLI
agent-nuvira sdk scaffold my-agent
```

Example custom agent:

```typescript
import { Agent, AgentContext, AgentResult } from '@agent-nuvira/sdk';

export class CodeFormatterAgent extends Agent {
  name = 'Code Formatter';
  description = 'Formats code according to project style';

  async execute(context: AgentContext): Promise<AgentResult> {
    // Your agent logic here
    return { status: 'completed', artifacts: [] };
  }
}
```

### 7.6 Using Workflow Templates

```yaml
# quick-fix.yml — Built-in workflow template
name: Quick Fix
steps:
  - agent: context-gatherer
  - agent: writer
  - agent: reviewer
options:
  model:
    context-gatherer: groq/llama-3.1-8b-instant
    writer: groq/llama-3.1-8b-instant
    reviewer: groq/llama-3.1-8b-instant
```

Run it:

```bash
agent-nuvira workflow run quick-fix "fix typo in documentation"
```

### 7.7 Cache Management

```bash
# Show cache statistics
agent-nuvira cache stats

# Clear all cached responses
agent-nuvira cache clear
```

Responses are cached in `~/.buff/cache.db` (SQLite) with a default TTL of 1 hour.

---

## 8. Troubleshooting

### 8.1 Common Issues

#### "Provider is not available"

**Cause:** API key not set or invalid.

**Solution:**
```bash
# Check if the key is set
echo $GROQ_API_KEY

# Set it
export GROQ_API_KEY="gsk_your_key_here"

# Check provider status
agent-nuvira doctor
```

#### "Port 3030 already in use"

**Cause:** Another dashboard instance is running.

**Solution:**
```bash
# Use a different port
agent-nuvira dashboard --port 3031

# Or kill the existing process
lsof -ti:3030 | xargs kill
```

#### "spawn start ENOENT" on Windows

**Cause:** Windows-specific browser launch issue.

**Solution:** Update to v1.14.1+ which includes the Windows fix. If persists, use `--no-open`:

```bash
agent-nuvira dashboard --no-open
```

Then manually navigate to `http://localhost:3030`.

#### Chat stays open after typing /exit

**Cause:** Version older than 1.14.5.

**Solution:** Update to latest:
```bash
npm update -g agent-nuvira
```

#### "npm ERR! code EINTEGRITY" during install

**Solution:**
```bash
npm cache clean --force
npm install -g agent-nuvira
```

### 8.2 Diagnostics

Run the built-in health check:

```bash
agent-nuvira doctor
```

This checks:
- Node.js version compatibility
- Configuration file validity
- All configured providers (API key presence, connectivity)
- Cache integrity
- Plugin validity
- Git availability
- Ollama status (if configured)

### 8.3 Debug Mode

Enable verbose logging:

```bash
agent-nuvira chat --debug
# Or set globally:
export BUFF_DEBUG=true
agent-nuvira chat
```

### 8.4 Getting Help

| Resource | Where |
|---|---|
| CLI Help | `agent-nuvira --help` or `agent-nuvira <command> --help` |
| GitHub Issues | [github.com/imdheerajKube/agent-nuvira/issues](https://github.com/imdheerajKube/agent-nuvira/issues) |
| Documentation | README, User Manual, Product Guide |

---

## 9. FAQ

**Q: Do I need an internet connection?**

A: For cloud providers (Groq, NIM, Gemini, OpenRouter), yes. For local models via Ollama, you can work fully offline.

**Q: Is my data sent to external servers?**

A: Only to the AI provider you choose (Groq, NVIDIA, Google, or OpenRouter). There is no intermediary server — Agent-Nuvira connects directly to your chosen provider. Local models stay entirely on your machine.

**Q: How much does it cost?**

A: Agent-Nuvira itself is free and open source (MIT). You pay only for the AI provider API usage. Most providers offer generous free tiers:
- **Groq:** Free tier with rate limits
- **NVIDIA NIM:** Free tier available
- **Google Gemini:** Free tier with 60 requests/minute
- **OpenRouter:** Free credits on sign-up
- **Local (Ollama):** Completely free

**Q: What programming languages does it support?**

A: All of them. Agent-Nuvira works with any programming language. The AI models it connects to are trained on code across all major languages including JavaScript, TypeScript, Python, Rust, Go, Java, C++, Ruby, and more.

**Q: Can I use multiple providers at the same time?**

A: Yes! You can switch between providers per-command or even mid-session using the error recovery menu. The `execute` command also supports per-agent provider configuration.

**Q: Is there a VS Code extension?**

A: Yes, there is a VS Code extension available that integrates Agent-Nuvira's multi-agent capabilities directly into the editor with inline suggestions and chat panels.

**Q: How do I update?**

A: ```bash
npm update -g agent-nuvira
```

**Q: How do I uninstall?**

A: ```bash
npm uninstall -g agent-nuvira
rm -rf ~/.buff   # Remove all configuration and cached data
```

---

## 10. Glossary

| Term | Definition |
|---|---|
| **Agent** | A specialized AI worker role (e.g., Planner, Writer, Reviewer) that performs a specific task in the multi-agent pipeline |
| **Agent-Nuvira** | The multi-agent AI coding CLI tool described in this manual |
| **API Key** | A secret token used to authenticate with cloud AI providers |
| **Artifact** | A piece of data produced by an agent (e.g., a file change, a plan) |
| **CLI** | Command-Line Interface — the terminal-based interface for interacting with Agent-Nuvira |
| **Context Vault** | The shared data bus that agents use to communicate with each other |
| **DAG** | Directed Acyclic Graph — the dependency graph used for parallel agent execution |
| **Inference** | The process of an AI model generating a response |
| **Inference Provider** | A service that offers AI model inference (Groq, NVIDIA, Google, OpenRouter, or local) |
| **LLM** | Large Language Model — the AI model that powers chat and code generation |
| **Multi-Agent Pipeline** | A sequence of specialized AI agents working together to complete a goal |
| **Ollama** | A local model runner that allows running AI models on your own hardware |
| **Orchestrator** | The engine that coordinates multiple agents, resolves dependencies, and synthesizes results |
| **Plugin** | A third-party extension that adds a new inference provider or agent type |
| **Provider** | See **Inference Provider** |
| **Sandbox** | An isolated environment (temporary directory or Docker container) for safely running code |
| **SQLite** | A lightweight, file-based database used for caching and history storage |
| **SSE** | Server-Sent Events — a streaming protocol used for real-time token output |
| **Trajectory** | A record of a completed agent execution, including the goal, steps taken, and outcomes |
| **Workflow** | A predefined YAML template defining a sequence of agent steps for a common task |
| **Vector Store** | A database that stores embedding vectors for semantic similarity search |

---

> **Agent-Nuvira v1.14.5 | MIT License | Built by Dheeraj Sharma**
> 
> *[github.com/imdheerajKube/agent-nuvira](https://github.com/imdheerajKube/agent-nuvira)*
