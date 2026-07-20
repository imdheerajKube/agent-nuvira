# Agent-Nuvira — User Manual

**Version 1.14.6 | July 2026**

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
- **Switch providers mid-session** without losing conversation state
- **Auto-compile skills** from successful execution trajectories
- **Scaffold new projects** with interactive templates
- **Monitor provider health** via a web dashboard
- **Federate agents** across multiple machines for distributed task execution
- **Benchmark models** with a 21-task evaluation suite to compare quality, speed, and cost
- **Search conversation history** with keyword or semantic (embedding-based) search
- **Security scan** code and prompts for PII leaks, injection attempts, and dangerous patterns
- **Rate agent outcomes** with `buff feedback` to drive self-improvement
- **Browse, search, and install** workflow templates and plugins via `buff marketplace`

### 1.2 Key Concepts

| Concept | Description |
|---|---|
| **Provider** | An AI model service (Groq, NVIDIA NIM, Google Gemini, OpenRouter, or local/Ollama) |
| **Agent** | A specialized AI worker role (Planner, Writer, Reviewer, Tester, etc.) |
| **Orchestrator** | The engine that coordinates multiple agents to complete a goal |
| **Workflow** | A predefined sequence of agent steps, configurable via YAML templates |
| **Skill** | A reusable, parameterized script auto-extracted from successful agent trajectories |
| **Context Pruner** | Automatic token-aware compression that prevents long chains from exceeding context windows |
| **Model Switch** | Change inference providers mid-session without losing agent state or conversation history |

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
# Expected output: 1.14.6

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

### 3.4 Docker Installation (Alternative — No Node.js Required)

```bash
# Clone the repository
git clone https://github.com/imdheerajKube/agent-nuvira.git
cd agent-nuvira

# Create environment file
cp .env.example .env
# Edit .env with your API keys

# Build and launch
# Default: dashboard at http://localhost:3030
docker compose up

# For local inference with Ollama:
docker compose --profile ollama up

# Run one-shot commands:
docker compose run --rm agent-nuvira chat "explain recursion in Rust"
docker compose run --rm agent-nuvira execute "add health check"
docker compose run --rm agent-nuvira models --provider groq
```

### 3.5 Verify Installation

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

**Option A: npm install (standard)**

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

**Option B: Docker (no Node.js required)**

```bash
docker compose up        # Start dashboard at http://localhost:3030
docker compose run --rm agent-nuvira chat "Hello!"
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
| `/model` | Switch providers mid-session (shortcut for `buff model switch`) |

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

### 5.3 Search & History Configuration

```bash
# Set how many days to keep chat history (auto-pruned on CLI startup)
agent-nuvira config set history.retentionDays 30

# Enable or disable automatic semantic embedding on every chat session
agent-nuvira config set history.semanticSearch true

# Disable semantic search (keyword-only, faster, no embedding costs)
agent-nuvira config set history.semanticSearch false

# View current history settings
agent-nuvira config get history.retentionDays
agent-nuvira config get history.semanticSearch
```

When `history.semanticSearch` is enabled, every chat session is automatically embedded using the native 3-tier embedder (Xenova → Python → LLM fallback). This enables semantic `/search --semantic` queries without manual reindexing. Run `agent-nuvira history reindex` to rebuild the semantic index from existing sessions.

### 5.4 Environment Variables

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

### 5.5 Provider-Specific Configuration

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
| `model` | Switch providers and manage models | `agent-nuvira model [command]` |
| `skill` | List, compile, and run reusable skills | `agent-nuvira skill [command]` |
| `init` | Scaffold new projects | `agent-nuvira init [project-name]` |
| `learn` | Manage learning data | `agent-nuvira learn [command]` |
| `doctor` | Run health checks | `agent-nuvira doctor` |
| `team` | Team collaboration | `agent-nuvira team [command]` |
| `sdk` | SDK tools | `agent-nuvira sdk [command]` |
| `federation` | Federation management | `agent-nuvira federation [command]` |
| `provider` | List providers and check health | `agent-nuvira provider [command]` |
| `security` | Security scan for PII, injection, dangerous code | `agent-nuvira security scan [input] [options]` |
| `feedback` | Record, list, and analyze user feedback ratings | `agent-nuvira feedback [command]` |
| `marketplace` | Browse, search, install marketplace items | `agent-nuvira marketplace [command]` |

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
  --context-limit <tokens>   Max tokens before pruning activates (default: 128000)
  --context-prune <mode>     Prune aggressiveness: soft | medium | aggressive (default: soft)

Examples:
  agent-nuvira execute "add JWT authentication"
  agent-nuvira execute "refactor database layer" --verbose
  agent-nuvira execute "add tests" --memory
  agent-nuvira execute "fix login bug" --dry-run
  agent-nuvira execute "build microservice" --context-limit 256000 --context-prune medium
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

### 6.8 Model Command — Context-Preserving Provider Switching

```bash
agent-nuvira model [command] [options]

Commands:
  (no subcommand)    Show current config + prompt to switch
  list               Table of all providers with status
  switch [provider]  Interactive or direct provider/model switch
  info               Detailed active configuration
  recommend          Model routing recommendations
  health             Quick health check for active provider

Examples:
  agent-nuvira model                           # Show current + switch prompt
  agent-nuvira model list                      # All providers with status
  agent-nuvira model switch                    # Interactive categorized picker
  agent-nuvira model switch groq               # Switch to Groq
  agent-nuvira model switch groq/llama-3.3-70b # Switch to specific model
```

Switching preserves all conversation history and agent state — seamless mid-session migration.

### 6.9 Skill Command — Reusable Skill Scripts

```bash
agent-nuvira skill [command] [options]

Commands:
  list                         List all compiled skills
  show <name>                  Show a skill's definition and steps
  run <name>                   Run a skill with the orchestrator
  compile                      Manually trigger skill compilation
  search <keyword>             Search skills by keyword
  quality                      Show skill quality scores
  gc                           Garbage-collect old/low-quality skills

Examples:
  agent-nuvira skill list
  agent-nuvira skill show "Add CLI Command"
  agent-nuvira skill run "Add CLI Command" --params commandName=deploy
  agent-nuvira skill search "test"
  agent-nuvira skill quality
```

Skills are auto-compiled from the top 5 highest-scoring trajectories every 8 successful orchestration runs.

### 6.10 Init Command — Project Scaffolding

```bash
agent-nuvira init [project-name] [options]

Options:
  --template <name>         Template to use (node-cli, ts-library, node-api, python-cli, minimal)
  --list                    List all available templates
  --template-dir <path>     Custom template directory

Examples:
  agent-nuvira init                           # Interactive mode
  agent-nuvira init my-app                    # Name + interactive
  agent-nuvira init my-app --template node-api # Fully non-interactive
  agent-nuvira init --list                     # Show available templates
```

Generates a complete starter project with `.buffconfig.json` configured with your chosen provider and model.

### 6.11 Dashboard

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

### 6.12 Federation Command — Multi-Machine Collaboration

```bash
agent-nuvira federation [command]

Commands:
  start                    Start a federation server (default port)
  connect <host>           Connect to a remote federation server
  disconnect               Disconnect from the current federation
  run <goal>               Delegate a task to a remote agent
  health                   Check federation connection health
  status                   Show federation connection status
  config                   View or edit federation configuration

Examples:
  agent-nuvira federation start                        # Start server
  agent-nuvira federation connect 192.168.1.50 --secret mykey
  agent-nuvira federation run "Fix bug" --agent debugger
  agent-nuvira federation health
  agent-nuvira federation status
  agent-nuvira federation disconnect
```

Federation enables multiple machines to collaborate on the same goal by delegating agent tasks to remote peers. The protocol uses SSE streaming for real-time progress updates with automatic polling fallback.

### 6.13 Benchmark Command — Model Evaluation Suite

```bash
agent-nuvira benchmark [options]

Options:
  --provider <provider>  Run benchmarks against a specific provider
  --model <model>        Run benchmarks against a specific model
  --tasks <filter>       Filter tasks by speed (quick, medium, all)
  --budget <amount>      Cost cap in USD (default: no limit)

Commands:
  (no subcommand)        Run the full benchmark suite interactively
  list                   List all 21 benchmark tasks
  results                Show last run results
    --last               Show details from the most recent run
    --compare            Compare two recent runs (A/B)
    --format <format>    Output format: text, json, markdown
  clear                  Clear all benchmark data

Examples:
  agent-nuvira benchmark                            # Run full suite
  agent-nuvira benchmark --provider groq             # Specific provider
  agent-nuvira benchmark --model llama-3.3-70b      # Specific model
  agent-nuvira benchmark --tasks quick --budget 0.50 # Fast + cost-capped
  agent-nuvira benchmark list                       # List all tasks
  agent-nuvira benchmark results --last             # Most recent results
  agent-nuvira benchmark results --compare          # A/B comparison
  agent-nuvira benchmark results --format markdown   # Export as markdown
```

The benchmark suite includes 21 tasks across 10 categories: code generation, refactoring, debugging, testing, documentation, security, optimization, comprehension, translation, and shell scripting. Each task is scored heuristically (0–1) based on pattern matching, anti-pattern detection, and code quality.

### 6.14 History Command — Conversation Search & Management

```bash
agent-nuvira history [command]

Commands:
  (no subcommand)        Show chronological conversation log
  search <query>         Keyword search across past conversations
    --semantic           Use semantic (embedding-based) search
  prune                  Remove old conversations by retention policy
  reindex                Rebuild semantic search index from scratch
  list                   List recent sessions

Examples:
  agent-nuvira history                              # Show conversation log
  agent-nuvira history search "JWT auth"            # Keyword search
  agent-nuvira history search --semantic "authentication patterns"
  agent-nuvira history prune                        # Prune by retention policy
  agent-nuvira history reindex                      # Rebuild semantic index
  agent-nuvira history list                         # List recent sessions
```

History is stored in `~/.buff/history/`. Retention is configurable via `buff config set history.retentionDays 30`. Semantic search uses native embeddings (Xenova → Python → LLM fallback) and requires the semantic index to exist — run `buff history reindex` to build it from existing sessions.

### 6.15 Security Scan Command — PII, Injection & Code Safety

```bash
agent-nuvira security scan [input] [options]

Options:
  --file <path>       Scan a file instead of inline text
  --stdin             Read input from stdin (pipe mode)
  --prompt            Scan for prompt injection patterns only
  --code              Scan for dangerous code patterns only
  --pii               Scan for PII (emails, API keys, SSNs, credit cards) only
  --json              Output machine-readable JSON
  --strict            Fail on medium+ severity (default: high+)
  --generated         Lower severity for eval/network patterns (for AI-generated code)

Examples:
  agent-nuvira security scan "Check this code for secrets"
  agent-nuvira security scan --file ./script.js
  cat payload.txt | agent-nuvira security scan --stdin
  agent-nuvira security scan --prompt "ignore all previous instructions"
  agent-nuvira security scan --code "eval(userInput)"
  agent-nuvira security scan --pii "email@example.com"
  agent-nuvira security scan --json --strict "sensitive data"
```

Scans detect:
- **Prompt injection:** "Ignore all instructions", role-play attempts, jailbreak patterns
- **Secrets & PII:** API keys (sk-, gsk_, nvapi-), emails, SSNs, credit card numbers, phone numbers
- **Dangerous code:** `eval()`, `exec()`, `child_process`, `rm -rf`, unsafe `require()`

Severity levels: 🔴 Critical → 🟠 High → 🟡 Medium → 🔵 Low

### 6.16 Feedback Command — Rating & Self-Improvement

```bash
agent-nuvira feedback [command]

Commands:
  record [trajectory-id] [options]  Record a rating (interactive or via flags)
    --positive                      Mark as positive
    --negative                      Mark as negative
    --neutral                       Mark as neutral
    --comment <text>                Optional comment about the rating
  list                              List recent feedback entries
    --limit <n>                     Maximum entries to show (default: 10)
    --trajectory <id>               Filter by trajectory ID
  stats                             Show aggregated feedback statistics
  clear                             Clear all feedback data (requires confirmation)

Examples:
  agent-nuvira feedback record traj-001 --positive
  agent-nuvira feedback record traj-002 --negative --comment "Wrong approach"
  agent-nuvira feedback record                    # Interactive rating prompt
  agent-nuvira feedback list                       # Most recent 10 entries
  agent-nuvira feedback list --limit 20 --trajectory traj-001
  agent-nuvira feedback stats                      # Bar chart + trend
  agent-nuvira feedback clear                      # With confirmation
```

Feedback scores influence the Hybrid Model Router — positive ratings improve a provider/model's routing score, negative ratings decrease it. The Feedback Store is capped at 1,000 entries with automatic trimming.

### 6.17 Marketplace Command — Unified Plugin & Template Discovery

```bash
agent-nuvira marketplace [command]

Commands:
  browse [options]          Show all available items
    --workflows             Show workflow templates only
    --plugins               Show plugin providers only
    --refresh               Force refresh of registry cache
  search <query>            Cross-search built-in templates, registry, and plugins
  install <name>            Install a template from the registry
  info <name>               Show detailed information about an item

Examples:
  agent-nuvira marketplace browse                    # All items
  agent-nuvira marketplace browse --workflows         # Workflows only
  agent-nuvira marketplace browse --plugins           # Plugins only
  agent-nuvira marketplace browse --refresh           # Fresh registry fetch
  agent-nuvira marketplace search "deploy"            # Search everything
  agent-nuvira marketplace install security-audit    # Install from registry
  agent-nuvira marketplace info quick-fix             # Built-in template
  agent-nuvira marketplace info "Custom AI"           # Plugin details
```

The marketplace is a unified entry point that combines:
- **10 built-in workflow templates** (quick-fix, feature-implement, code-review, etc.)
- **Installed registry templates** from the GitHub template registry
- **Plugin providers** from `~/.buff/plugins/`

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

#### Workflow 7: Switch Provider Mid-Session

```bash
# Start chatting with one provider
agent-nuvira chat --provider gemini

# In the chat, switch to a different provider
# /model

# Or from the command line
agent-nuvira model switch groq
agent-nuvira model switch groq/llama-3.3-70b-versatile
```

All conversation history is preserved when switching — seamless migration.

#### Workflow 8: Scaffold a New Project

```bash
# Create a new Node.js API project
agent-nuvira init my-api --template node-api

# List available templates first
agent-nuvira init --list

# Interactive: pick template and provider
agent-nuvira init my-app
```

#### Workflow 9: Run a Compiled Skill

```bash
# List available skills (auto-compiled from past runs)
agent-nuvira skill list

# Run a skill with parameters
agent-nuvira skill run "Add CLI Command" --params commandName=deploy

# Search for relevant skills
agent-nuvira skill search "test"
```

#### Workflow 10: Use Docker for Quick Setup

```bash
# Build and start the dashboard
docker compose up

# Run one-shot commands
docker compose run --rm agent-nuvira execute "add authentication" --context-prune medium

# With local inference
docker compose --profile ollama up
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

### 8.4 Docker-Specific Issues

#### Docker build fails during npm ci

**Cause:** Missing `package-lock.json` in build context.

**Solution:** Ensure `.dockerignore` does NOT exclude `package-lock.json`. The file is required in Stage 1 of the multi-stage build.

#### "Connection refused" when using Ollama from Docker

**Cause:** Ollama runs on the host machine but Docker can't reach it.

**Solution:**
```bash
# Linux: Use host network mode (or set OLLAMA_HOST explicitly)
export OLLAMA_HOST=http://host.docker.internal:11434

# Or use the Ollama profile:
docker compose --profile ollama up
```

#### Dashboard not accessible

**Solution:**
```bash
# Check container is running
docker ps

# View logs
docker compose logs agent-nuvira

# Restart
docker compose down && docker compose up
```

### 8.5 Getting Help

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
| **Skill** | A reusable, parameterized script auto-extracted from successful agent trajectories; can be invoked via `buff skill run` |
| **Skill Compiler** | An LLM-powered engine that converts high-scoring execution trajectories into parameterized skill definitions |
| **SQLite** | A lightweight, file-based database used for caching |
| **SSE** | Server-Sent Events — a streaming protocol used for real-time token output |
| **Trajectory** | A record of a completed agent execution, including the goal, steps taken, and outcomes |
| **Workflow** | A predefined YAML template defining a sequence of agent steps for a common task |
| **Vector Store** | A database that stores embedding vectors for semantic similarity search |

---

> **Agent-Nuvira v1.14.6 | MIT License | Built by Dheeraj Sharma**
> 
> *[github.com/imdheerajKube/agent-nuvira](https://github.com/imdheerajKube/agent-nuvira)*
