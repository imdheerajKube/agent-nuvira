# Agent-Nuvira — User Manual

**Version 1.58.8 | August 2026**

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
| **Agent** | A specialized AI worker role (Planner, Writer, Reviewer, Tester, Runner, Debugger, etc.) |
| **Orchestrator** | The engine that coordinates multiple agents to complete a goal |
| **Workflow** | A predefined sequence of agent steps, configurable via YAML templates |
| **Skill** | A reusable, parameterized script auto-extracted from successful agent trajectories |
| **Context Pruner** | Automatic token-aware compression that prevents long chains from exceeding context windows |
| **Model Switch** | Change inference providers mid-session without losing agent state or conversation history |
| **Interactive Dev Mode** | `buff execute` without a goal — guided loop with model picker, session tracking, /fix, and follow-up suggestions |
| **Session Save/Resume** | Save and restore entire development sessions with `/save <name>` and `/resume <name>` |
| **Failure Analysis** | Automatic per-agent-type diagnosis with specific recovery actions (rephrase, switch model, auto-fix) |
| **Follow-up Suggestions** | LLM-powered contextual next-step recommendations after goal completion |
| **Branch Automation** | Automated git branch workflow with installable hooks — auto-create issue branches, auto-commit file changes, and auto-update PRs |
| **Issue Triage** | Automated issue classification, prioritization, and labeling across GitHub and GitLab via LLM |
| **DAG Pipeline Visualization** | Live multi-agent pipeline visualization inline in chat messages showing agent progress |
| **Real-Time Streaming** | Typewriter-effect token streaming with blinking cursor in the agent progress panel |

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
| `retrieval` | Index, query, and manage local vector retrieval | `agent-nuvira retrieval [command]` |

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
  --auto-branch              Enable branch automation hooks and auto-workflows
  --checkpoint               Save a resume-able snapshot after every task batch
  --resume [id]              Resume from a saved checkpoint (id optional — auto-finds for goal + cwd)
  --checkpoint-list          List saved checkpoints with progress

Examples:
  agent-nuvira execute "add JWT authentication"
  agent-nuvira execute "refactor database layer" --verbose
  agent-nuvira execute "add tests" --memory
  agent-nuvira execute "fix login bug" --dry-run
  agent-nuvira execute "build microservice" --context-limit 256000 --context-prune medium
  agent-nuvira execute "add JWT authentication" --checkpoint   # save after every batch
  agent-nuvira execute "add JWT authentication" --resume       # continue after a crash/quota kill
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
  quota              Inspect the central quota ledger (tokens/requests, parked providers, cost summary)
  bandit             Inspect learning-router Thompson-sampling state (α/β priors + promotion gate)

Examples:
  agent-nuvira model                           # Show current + switch prompt
  agent-nuvira model list                      # All providers with status
  agent-nuvira model switch                    # Interactive categorized picker
  agent-nuvira model switch groq               # Switch to Groq
  agent-nuvira model switch groq/llama-3.3-70b # Switch to specific model
  agent-nuvira model switch auto                # Auto routing — agent picks the best model per task
  agent-nuvira model explain "your task"        # Why Auto picked a model (weights, ranking, fallback)
  agent-nuvira model quota                     # Free vs paid tokens + estimated $ saved
  agent-nuvira model bandit                    # α/β priors per provider × complexity bucket
```

Switching preserves all conversation history and agent state — seamless mid-session migration.

### Auto Model Routing

Selecting **Auto** (option 1 in the picker, or `agent-nuvira model switch auto`) tells Agent-Nuvira to **use the right model for the right task** instead of pinning one model for everything:

- **Fast planning with small models** — trivial/simple tasks route to fast, cheap providers (e.g., Groq)
- **Deep reasoning with larger models** — complex/critical tasks route to stronger providers (e.g., Gemini, OpenRouter)
- **Local models for private tasks** — `privacy-first` mode routes to the local provider

**Cost scoring uses real pricing.** Each provider is scored against its actual per-1K-token list price (free tiers count as $0). You can override any provider's pricing to match your negotiated or self-hosted rates:

```bash
buff config set pricing.gemini.inputPer1K 0.00125
buff config set pricing.gemini.outputPer1K 0.005
buff config       # see the AUTO ROUTING PRICING section
```

**Decisions are runtime-adjusted.** Benchmark quality from `buff benchmark` runs is blended into the reasoning dimension, and the proven best model for each agent type (from agent stats) gets a reliability boost.

**Understand every decision** with `buff model explain "<task>"` — it shows the detected complexity, the dimension weights, the full ranked provider table with reasons, and the fallback chain. With no task it walks through all five complexity levels. The web dashboard's **Routing** panel (nav: 🤖 Routing) visualizes the same data.

For scripting and CI, `buff model explain "<task>" --json` emits a machine-readable payload (task, complexity, weights, ranked providers, winner, fallback chain, effective per-provider pricing with override flags).

**Close the routing → quality loop** with `buff benchmark --routing` — it asks the Auto router which provider/model it would pick for each benchmark task, then runs the suite against every distinct pick and ranks them by measured quality, feeding those results back into the router's runtime stats.

**Validate the router's picks end-to-end** with `buff eval --routing` — the same idea, but each pick runs the full Agent Evaluation framework (real multi-agent pipeline + hidden tests in an isolated workspace), then ranks the picks by composite score. This measures *reliability*, not just response quality.

**Every routing decision is recorded.** Live chat auto-routing, orchestrator task routing, `model explain` snapshots (human and `--json`), `benchmark --routing`, and `eval --routing` all append to `~/.buff/memory/routing-history.json`. The dashboard's **Routing** panel (nav: 🤖 Routing) turns this into two new views:
- **Routing Usage — actual picks over time** — totals, last-24h activity, per-provider pick counts, per-source breakdown (chat / orchestrator / explain / benchmark / eval), and most-picked models
- **Audit Trail — routing decision timeline** — the 30 most recent decisions with source badge, winner provider/model, complexity, task, and relative time
- **Cloud models for high-complexity tasks** — critical production/security work favors reliability + reasoning

Selection scores every configured provider across **5 dimensions** — reasoning, speed, cost, privacy, and reliability — weighted by the detected task complexity. Providers in circuit-breaker cooldown are deprioritized, and a fallback chain keeps the pipeline running if the primary provider fails.

**Where it applies:**
- `buff chat` — routes every message (switch mid-session with `/model` → Auto)
- `buff execute "<goal>" -m auto` or `--auto-route` — routes each agent task independently
- `buff plan`, `buff run`, and any command reading the active model state

### Promotion Gate — is the bandit actually better?

With `routing.bandit` enabled, the Auto router doesn't just learn — it **proves it improves routing before you trust it**. The **Promotion Gate** (ruflo ADR-150 mirror) A/B-tests the bandit router against the deterministic heuristic router on real trajectories and reports whether the bandit has *earned* promotion:

```bash
# 1. Enable bandit learning so both routers produce picks
agent-nuvira config set routing.bandit true

# 2. Run auto-routed tasks (chat with Auto, execute -m auto, --auto-route)
#    — each task records BOTH the heuristic pick and the bandit pick, then
#    finalizes with the real outcome (success/failure, latency, cost)
```

Each finalized decision is appended to `~/.buff/memory/router-promotion.jsonl` (honors `BUFF_MEMORY_DIR`). The gate evaluates only **diverged** decisions — tasks where the bandit picked a different provider/model than the heuristic. A pick both routers agree on carries no promotion signal.

**Read the verdict** in the dashboard's 🎖️ **Promotion Gate** card (Routing panel, `GET /api/routing` → `promotion`) or via `agent-nuvira model bandit`:

| State | Meaning |
|---|---|
| **Collecting data…** | Fewer than 20 diverged decisions yet (`minDecisions: 20`) — the gate needs a sample before judging |
| **✅ Promoted** | Bandit is a genuine improvement: quality delta **> +2%**, cost regression **< +1%**, latency regression **< +5%** |
| **Criteria detail** | Each pass/fail (`quality` / `cost` / `latency`) is listed with its measured delta, so you can see exactly which criterion blocked promotion |

Latency is treated as **neutral** until real latency measurements exist — missing telemetry never blocks a quality/cost win, but it doesn't count as a win either. The gate is a *go/no-go signal*: it reports whether the bandit is better but does **not** disable the bandit at runtime.

### Central Quota Ledger — free/local-first routing with reset windows

Every Auto-routed call is write-through recorded into a **central quota ledger** (`~/.buff/memory/quota-ledger.json`): tokens/requests per provider × model with calendar-aware reset windows (daily/hourly free-tier limits). The ledger powers four things:

1. **Exhaustion parking** — a provider that hits its configured window limit is **parked** (excluded from Auto routing) until the window rolls — automatic re-enable at the exact reset boundary, no timers. Auth failures stay permanent (never re-enabled).
2. **Predictive routing** — Auto routing sinks quota-parked providers below healthy candidates **before** a call is made (previously only reactive failover).
3. **Free/local-first gate** — `routing.allowPaid: false` excludes PAID providers for non-complex tasks (trivial/simple/moderate) so free/local models win unless complexity demands otherwise; complex/critical tasks may still use paid high-capacity models.
4. **Cost transparency** — `buff model quota` shows free vs paid tokens and an **estimated $ saved** figure (what the free-tier usage would have cost at a typical paid rate).

```bash
# Set per-provider quota limits (requests per reset window)
agent-nuvira config set routing.quota.gemini.requestsPerWindow 1500
agent-nuvira config set routing.quota.groq.requestsPerWindow 14400
agent-nuvira config set routing.quota.groq.tokensPerWindow 1000000
agent-nuvira config set routing.quota.groq.windowMs 86400000   # 24h reset window

# Inspect the ledger
agent-nuvira model quota        # tokens/requests per provider × model, resets in, parked state, cost summary
agent-nuvira model quota --json # machine-readable for scripting/CI
agent-nuvira model quota reset  # clear the ledger
```

**Failover timeline (transparency: when failover occurred).** Every park, window-reset re-enable, manual release, and mid-session failover is appended to `~/.buff/memory/quota-events.jsonl` (capped at 200). The dashboard's Quota card renders it as a **Failover Timeline**, and `buff model quota` prints the last 20 events. The timeline is **live**: the dashboard watches the files on disk and pushes a `quota` SSE event the moment a failover is written.

**One shared failover walk for every action (Nuvira-Router).** Chat, plan, and the execute orchestrator all route through the same single-shot failover machinery: the auto router picks the best provider, and if that call fails — for **any** reason (expired key, exhausted quota, deprecated model, timeout) — the ranked candidate list is walked until one answers, with every attempt written through the full shared bookkeeping (session exclusion + quota-ledger park + model-availability registry + failover timeline + circuit breaker). That means `buff plan` and `buff execute` fail over across providers exactly like `buff chat` does, and a dead provider × model is learned **predictively** so the next pick skips it instead of failing into it again.

### Checkpoint / Resume — continuity across crashes and quota kills

`buff execute "<goal>" --checkpoint` saves a resume-able snapshot after every task batch (task plan with per-step statuses, artifacts, file changes, metadata) to `~/.buff/memory/checkpoints/` (honors `BUFF_MEMORY_DIR`). A crash / quota kill / token expiry mid-pipeline no longer restarts the whole plan:

```bash
agent-nuvira execute "add JWT authentication" --checkpoint   # save after every batch
agent-nuvira execute "add JWT authentication" --resume       # continue from first pending step
agent-nuvira execute "<goal>" --resume <id>                  # resume a specific saved run
agent-nuvira execute "<goal>" --checkpoint-list              # list saved checkpoints with progress
```

A resumed run rehydrates the vault and continues from the first pending step, skipping completed steps and the planner entirely. Bare `--resume` auto-finds the id for the current goal + cwd.

### Vector Retrieval — token-efficient context (saves tokens, complements the quota ledger)

Large gathered contexts are chunked (~512 tokens, paragraph-aware, 64-token overlap), embedded locally with `bge-small-en-v1.5` (via @huggingface/transformers — zero new deps, 384-dim so the vector schema is unchanged) and reduced to the top-k semantically-relevant chunks before the LLM call. It complements the quota ledger: **retrieval saves tokens, the ledger manages quotas**.

| Policy | Behavior |
|---|---|
| **Router policy** | Context ≤ threshold (12k tokens) → **direct call, zero overhead**; larger → embed + retrieve; any failure → **failover to full context** (never breaks the LLM call) |
| **Wiring** | `chat --file` (chunk reduction) + `buff execute` (post-gather semantic file ranking for the writer + token-savings stats) |
| **Transparency** | `🧠 Retrieved 5 chunks — reduced context 20k → 3k tokens` + `buff retrieval stats` + dashboard Retrieval card |

```bash
agent-nuvira retrieval index .                # index the current repo into the local store
agent-nuvira retrieval query "how does login with JWT work?"   # top-k relevant chunks
agent-nuvira retrieval stats                  # tokens saved, avg reduction, repo chunks, latest hits
agent-nuvira retrieval clear                  # wipe the repo index
```

**Config** (`routing.retrieval`): `enabled` (default true), `topK` (default 5), `chunkTokens` (default 512), `overlapTokens` (default 64), `thresholdTokens` (default 12,000 — contexts above this trigger retrieval), and `model` (default `bge-small-en-v1.5`).

### Vector Search Backend — FAISS-backed similarity search

The vector store that powers memory, history, and repo retrieval is **backend-pluggable** (v1.48.0+). Agent-Nuvira auto-selects the fastest available tier in this priority order:

| Tier | Engine | When used |
|---|---|---|
| `faiss-native` | Real [FAISS](https://github.com/facebookresearch/faiss) via `@faiss-node/native` (C++ bindings, `FLAT_IP` + L2-normalization = exact cosine) | When the native module is installed and built — fastest, hardware-accelerated |
| `faiss-ivf` | Pure-JS IVF-flat approximate nearest neighbor (no native deps) | Fallback on machines without native bindings — 100x faster than brute force on large corpora |
| `json` | Exact flat cosine over the original JSON index | Final fallback — the original v1.47 behavior, always works |

Every tier reads/writes the **same** JSON entry format, so switching backends never loses existing vectors. Resolution is lazy (per call), with the chosen tier logged in `--verbose` mode and shown in the dashboard Memory card.

```bash
agent-nuvira memory backend --check   # show the active backend + why it was chosen
agent-nuvira memory stats             # Backend: faiss-native (or faiss-ivf / json)
```

**Config:** set `routing.vectorBackend` to `auto` (default), `native`, `ivf`, or `json` — or the `BUFF_VECTOR_BACKEND` env var. `auto` probes native availability once per process and falls back gracefully; an unavailable explicit tier also falls back rather than erroring.

> **Tip:** `@faiss-node/native` is an optional dependency — install it and run `npm rebuild` to get the hardware-accelerated tier. The pure-JS IVF tier keeps CI and fresh installs fast with zero native toolchain requirements.

### Auto-mode failover confirmation — control over every swap

`routing.promptOnFailover: true` makes Auto mode **ask** before a mid-session provider swap: when a provider dies (expired key, exhausted quota, deprecated model), the CLI shows the next-ranked candidate and offers **switch (recommended)** or **pick a provider myself** instead of silently auto-switching. Default stays silent auto-failover (never get stuck). Applies to both the interactive chat loop and one-shot Auto prompts (`buff chat "..." -m auto`).

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
  --routing              Benchmark the exact provider/model pairs the Auto router picks
                         (closes the routing→quality loop; provider/model flags ignored)

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

### 7.4 Marketing Website

Agent-Nuvira ships with a complete static marketing website in the `website/` directory, deployed at **agent-nuvira.com**. This is a full landing page designed for Netlify or Cloudflare Pages deployment with zero configuration.

**Website structure:**

| File | Purpose |
|---|---|
| `website/index.html` | Full landing page with hero, features, pipeline visualization, provider cards, quickstart guide, extensions, and comparison table |
| `website/styles.css` | Complete styling with gradient text, animated particles, responsive grid, and dark theme |
| `website/script.js` | Interactive elements: scroll animations, copy-to-clipboard, mobile nav toggle, particle system |
| `website/_redirects` | Netlify/Cloudflare Page redirect rules |
| `website/_headers` | Custom HTTP security and cache headers |
| `website/assets/` | Hero images, screenshots, and OG meta assets |

Deploy with a single drag-and-drop or `npx netlify-cli deploy --dir=website`.

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

### 7.8 Branch Automation

Agent-Nuvira's **Branch Automation** feature installs git hooks and provides automated branch workflows. It is designed to remove the overhead of manual git operations during development.

#### Step 1: Install Hooks

```bash
buff execute "install branch hooks" --auto-branch
```

This installs three hooks in your repository's `.git/hooks/`:

| Hook | Purpose |
|------|---------|
| **post-checkout** | Detects issue-based branches on checkout and loads context |
| **pre-commit** | Enforces conventional commit format with auto-detection |
| **file-watch.sh** | Background script that polls for file changes and triggers auto-commits |

Each hook is self-identifying (contains an 'Agent-Nuvira' marker) for clean removal.

#### Step 2: Check Automation Status

```bash
buff execute "check branch status" --auto-branch
```

Shows which hooks are currently installed and whether file-watch is active.

#### Workflow 1: Issue → Branch

Automatically create a branch with conventional naming from an issue key:

```bash
buff execute "auto-create branch from issue PROJ-123" --auto-branch
# Creates: feat/PROJ-123-implement-user-authentication
```

Branch naming follows the convention: `<type>/<ISSUE-KEY>-<sanitized-title>` where type defaults to `feat`.

#### Workflow 2: Auto-Commit File Changes

```bash
buff execute "auto-commit changes" --auto-branch
```

This stages all changed files (`git add -A`) and generates a conventional commit message:

```
<type>(<scope>): <description>

Type detection: test → test, docs → docs, fix → fix, feat → feat, or defaults to 'chore'
Scope: auto-detected from the changed file paths (e.g., `src/cli/` → `cli`)
Description: LLM-generated based on the diff
```

#### Workflow 3: Start File-Watch Mode

```bash
buff execute "start file watch" --auto-branch
```

Starts a background script that polls for file changes (default interval: 60 seconds) and auto-commits them with conventional messages. Exits gracefully with `Ctrl+C`.

#### Workflow 4: PR Label → Update

When a PR has labels like `wip` or `needs-work`, the agent auto-commits and pushes changes to the PR branch:

```bash
buff execute "update PR branch" --auto-branch
```

#### Workflow 5: CI Status → Fix

Analyzes CI failures from the latest commits and provides LLM-powered diagnosis:

```bash
buff execute "check CI for PR #42" --auto-branch
```

This inspects the commit history, identifies what changed, and provides a targeted fix suggestion.

#### Remove Hooks

```bash
buff execute "remove branch hooks" --auto-branch
```

Removes only hooks containing the 'Agent-Nuvira' marker, leaving any pre-existing hooks intact.

### 7.9 Automatic Dependency Installation

When a command fails because a module, package, or interpreter is missing, the **RunnerAgent** automatically installs the missing dependencies and retries — closing tasks that would otherwise fail with "cannot find module" or "command not found".

**How it works:**

1. **Manifest detection** — The runner scans the working directory for supported manifests:
   `package.json` / `pnpm-lock.yaml` / `yarn.lock` (lockfiles win), `requirements.txt`,
   `pyproject.toml`, `setup.py`, `Gemfile`, `Cargo.toml`, `go.mod`, `composer.json`, `pubspec.yaml`
2. **Dependency install** — Runs the correct command (`npm install`, `pip install -r requirements.txt`,
   `bundle install`, `cargo build`, `go mod download`, `composer install`, `dart pub get`, …)
3. **Tool bootstrap** — If the package manager itself is missing, it is installed first:

| Tool | Install strategy |
|---|---|
| npm / yarn / pnpm | Node.js via Homebrew (macOS), apt/dnf/yum or NodeSource (Linux), winget/choco/MSI (Windows) |
| pip | `ensurepip` when Python exists; Python installed via brew/apt/winget otherwise |
| bundler | `gem install bundler`; Ruby installed via brew/apt/winget otherwise |
| cargo | rustup (`sh.rustup.rs -y`) |
| go | Homebrew (macOS), apt/dnf (Linux), winget (Windows) |
| composer | PHP via brew/apt/winget, then the getcomposer.org installer into `$HOME/.local/bin` |
| dart | Homebrew / Google apt repo (Linux) / winget (Windows) |
| brew | Official Homebrew install script (`NONINTERACTIVE=1`) |

4. **Retry** — After a successful install, the original command is re-run automatically.

**Command-based fallback:** When no manifest exists, the runner parses the failed command
itself (`python3 script.py` → install Python) and installs the missing interpreter/tool.

**Opt out:** Set `"autoInstallTools": false` in context metadata to only attempt the install
command without installing missing tools.

**Telemetry:** Each run records `dependencyInstallTool` / `dependencyInstallToolInstalled`,
feeding the Agent Evaluation dashboard's *Deps Installed* success-rate metric.

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
| **Interactive Dev Mode** | Guided development loop with model picker, session history, /fix, /save, /resume, /suggest |
| **Failure Analysis** | Per-agent-type diagnosis with recovery actions — rephrase goal, switch model, or auto-fix |
| **Follow-up Suggestions** | LLM-generated contextual recommendations for what to do next after goal completion |
| **MCP** | Model Context Protocol — connect to external tools and data sources via stdio or SSE transport |
| **A2A** | Agent-to-Agent protocol — standard for inter-agent communication across machines |
| **Branch Automation** | Automated git workflow with installable hooks — issue-to-branch creation, auto-commit with conventional messages, file-watch auto-commit, and CI failure diagnosis |
| **Issue Triage** | Automated issue classification (bug/feature/question), priority assignment, auto-labeling, and assignee suggestions across GitHub and GitLab |
| **DAG Pipeline Visualization** | Live multi-agent pipeline visualization inline in chat messages showing colored agent nodes with real-time status updates |
| **Real-Time Streaming** | Typewriter-effect token streaming with blinking cursor and animated progress indicator in the VS Code agent panel |
| **Conventional Commit** | Structured git commit format `<type>(<scope>): <description>` with auto-detection of type from changed files |

---

## 11. Phase-Wise Feature Summary

### Phase 0: Foundation — Core CLI & Provider Layer
| Feature | Description |
|---------|-------------|
| **17+ Inference Providers** | 5 built-in (Groq, NVIDIA NIM, Google Gemini, OpenRouter, Local) + 12 configurable via env vars (OpenAI, Anthropic, Mistral, Cohere, Together, DeepInfra, Fireworks, Perplexity, Azure, LM Studio, Anyscale, vLLM) |
| **Unified CLI** | 25+ commands via Commander.js with shared options |
| **Config System** | JSON config file + env vars + CLI flags priority chain |
| **Streaming** | Real-time token-by-token output for all 17+ providers |
| **Response Caching** | SQLite-backed cache with configurable TTL |
| **Chat Interface** | Interactive chat with conversation history and `/` commands |
| **File Editing** | AI-assisted file editing with dry-run mode |
| **Implementation Plans** | Codebase-aware plan generation with architecture impact analysis |

### Phase 1: Quick Wins — Developer Experience
| Feature | Description |
|---------|-------------|
| **Plugin System** | Programmatic API + auto-discovery from `~/.buff/plugins/` |
| **Project Scaffolding** | `buff init` with 5 built-in templates + interactive provider wizard |
| **Model Discovery** | `buff models` with search/filter across all providers |
| **Model Switching** | Context-preserving provider/model switch mid-session |
| **Cost Tracking** | Per-provider, per-session, and monthly cost dashboards |
| **History Search** | Keyword + semantic search across past conversations |
| **Skill Compiler** | Auto-extracts reusable patterns from trajectories into runnable skills |
| **Context Pruner** | 5-strategy token compression for long agent chains |

### Phase 2: Structural Changes — Memory & Infrastructure
| Feature | Description |
|---------|-------------|
| **Vector Store** | Cosine similarity search over embedded trajectories |
| **Trajectory Store** | Few-shot example storage with quality scoring |
| **3-Tier Embedder** | Xenova (fast) → Python (medium) → LLM (fallback) |
| **Workflow Marketplace** | 10 built-in templates + GitHub registry with install/publish |
| **Model Benchmarking** | 21 standardized coding tasks with scoring and A/B comparison |
| **Docker Sandbox** | 8 base images, resource limits, network-isolated execution |
| **Provider Health** | `buff doctor` with color-coded status, watch mode, auto-fix |
| **Memory Compression** | Automatic trajectory summarization with configurable retention |

### Phase 3: Major Upgrades — Advanced Agent Systems
| Feature | Description |
|---------|-------------|
| **VS Code Extension** | 9 commands, inline suggestions, diff viewer, agent progress panel |
| **Agent Federation** | Multi-machine collaboration via A2A protocol, server, and client |
| **Web Dashboard** | React + Recharts + DAG visualization, model health, cost charts |
| **Hybrid Model Routing** | Complexity-based model selection with cost optimization |
| **Team Collaboration** | Git-synced shared config, memory, and review pipelines |
| **Agent SDK** | `@agent-nuvira/sdk` npm package with scaffolding CLI |
| **Provider CLI** | `buff provider list/health` with per-provider diagnostics |
| **Provider Fallback** | Auto-failover with circuit breaker and configurable chain |
| **Security Scanner** | Detects PII, prompt injections, and dangerous code patterns |
| **Feedback System** | `buff feedback record/list/stats/clear` drives self-improvement |
| **Marketplace CLI** | Unified `buff marketplace browse/search/install/info` |

### Phase 4: Industry Standards — Protocol & Integration
| Feature | Description |
|---------|-------------|
| **MCP Protocol** | Model Context Protocol client/manager with stdio + SSE transport |
| **AST Editing Engine** | Structural code analysis for JS/TS/Python/Go/Rust |
| **Auto Error-Repair** | Automatic diagnosis and repair with configurable retry budgets |
| **A2A Protocol** | Agent-to-Agent communication standard for federation |
| **CI/CD Headless** | `buff ci` for automated pipelines with GitHub Actions |
| **npm Publishing** | `npx agent-nuvira` / `npx buff` for zero-setup onboarding |

### Phase 5: Interactive UX — Developer Experience
| Feature | Description |
|---------|-------------|
| **Interactive Dev Mode** | Guided loop with model picker, session management, and goal tracking |
| **Session Save/Resume** | Save and restore development sessions with full history |
| **Failure Analysis** | Per-agent-type diagnosis with specific recovery actions |
| **Follow-up Suggestions** | LLM-powered contextual next-step recommendations |
| **/fix Command** | Retry last failed goal with failure context |

### Phase 6: Platform Integration — GitLab, GitHub PR, Issue Triage & Branch Automation
| Feature | Description |
|---------|-------------|
| **GitLab Integration** | Full GitLab agent for MR management, issue discovery, pipeline monitoring, and code review comments |
| **GitHub PR Review Agent** | Automatic inline code review on open PRs with security/quality verification and inline review comments |
| **Issue Triage Engine** | Automated issue classification (bug/feature/question/docs/chore), priority assignment, difficulty estimation, auto-labeling, and assignee suggestions |
| **Branch Automation Hooks** | Installable git hooks for automated branch workflows — issue-driven branch creation, auto-commit with conventional messages, file-watch mode, PR updates, and CI failure diagnosis |

### Phase 7: Architecture Migration — Modular Plugin Architecture
| Feature | Description |
|---------|-------------|
| **RecoverModule (Phase 1)** | Extracted from ErrorRepairEngine — discriminated union strategies + RepairBudget (3 attempts with exponential backoff) |
| **ModuleRegistry (Phase 2)** | Plugin-based agent loading — 14 built-in agent modules, `register()` / `load()` / `unload()` lifecycle, EventBus integration |
| **EventBus (Phase 3)** | Structured observability — 37+ typed events, 4 built-in consumers (Logger, Metrics, Audit, MetricsBuffer), typed event schema |
| **ReportModule (Phase 4)** | 4 output formats (markdown, JSON, summary, verbose) — extractable from buildResult() |
| **InspectModule (Phase 5)** | Keyword scanning + LLM-based file classification — ContextGatherer wrapper with depth-limited walk, .buffignore support |
| **VerifyModule (Phase 6)** | 4 check types (security, goal-alignment, tests, code-quality) — configurable strictness (low/medium/high), pass/fail scoring |
| **PlanModule (Phase 7)** | Goal decomposition — 3 JSON parsing strategies, step normalization, fallback plan, EventBus events |
| **EditModule (Phase 7)** | File change generation — AST syntax validation, token-budget-aware file selection, 2-attempt retry loop, model-switch support |
| **ExecuteModule (Phase 8)** | Command execution — 5-strategy command inference (backtick, Run prefix, npm patterns, file extension), npm test validation |
| **TestModule (Phase 8)** | Sandboxed test execution — temp directory, multi-framework output parsing (vitest, jest, generic), EventBus events |
| **SafeExecutionLayer (Phase 9)** | 3-domain safety system — file validation (size, gitignore, syntax, security scan), Docker sandbox (resource limits, container lifecycle), safe LLM calls (injection guardrail, prompt/response truncation, exponential backoff with circuit breaker) |

### Agent Catalog — 17 Agent Roles & Management
| Agent/Component | Type | Description |
|-----------------|------|-------------|
| **PlannerAgent** | Core | Analyzes goals, creates dependency-aware task plans |
| **ContextGathererAgent** | Core | Scans codebase, identifies relevant files and artifacts |
| **WriterAgent** | Core | Implements code changes based on plan and gathered context |
| **ReviewerAgent** | Core | Validates changes for bugs, security, and style |
| **RunnerAgent** | Execution | Executes shell commands and captures output; auto-installs missing project dependencies and bootstrap-installs missing package managers (npm, pip, bundler, cargo, go, composer, dart) cross-platform |
| **TesterAgent** | Testing | Runs tests in sandboxed temp directory or Docker container |
| **DebuggerAgent** | Testing | Iteratively diagnoses and fixes test failures via LLM |
| **GitAgent** | Publishing | Creates branches, commits with LLM messages, generates PR descriptions |
| **PackageAgent** | Publishing | Bumps version, builds, publishes to npm, generates changelogs |
| **GitHubReleaseAgent** | Publishing | Creates tags, release notes, and GitHub releases via `gh` CLI or API |
| **SecurityAgent** | Safety | Scans for PII, prompt injection, and dangerous code patterns |
| **SkillRunnerAgent** | Learning | Executes compiled skill scripts as pre-built task plans |
| **MCPAgent** | Integration | Invokes MCP tools from connected servers via stdio or SSE transport |
| **GitLabAgent** | Integration | GitLab MR management, issue discovery, pipeline monitoring |
| **PRReviewAgent** | Review | GitHub PR review with inline comments + security scans |
| **IssueTriageAgent** | Management | Issue classification, prioritization, auto-labeling |
| **BranchAutomationAgent** | Publishing | Auto-create issue branches, file-watch commits, PR updates |
| **Orchestrator** | Management | Coordinates all agents with dependency-aware scheduling, parallel execution, context pruning, and interactive recovery |

---

> **Agent-Nuvira v1.38.1 | MIT License | Built by Dheeraj Sharma**
> 
> *[github.com/imdheerajKube/agent-nuvira](https://github.com/imdheerajKube/agent-nuvira)*
