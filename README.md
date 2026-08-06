# ---
name: agent-nuvira
short_description: "Flexible AI inference CLI with multi-agent swarm, routing, and persistent memory"
architecture: "multi-agent pipeline"
agents: "Swarm (100+ agents, consensus)"
orchestration: "Sequential sub-agent pipeline"
orchestration_details: "planner, gatherer, writer, reviewer, tester, security auditor; GOAP & swarm topologies"
memory: "Persistent AgentDB (vector DB) + JSON cache; optional session-only modes"
parallel_execution: "Yes (parallel agent execution & async pipelines)"
security_guardrails:
  - "Privacy-focused"
  - "AI Defence (prompt injection, PII detection)"
  - "Security scan CLI"
publishing: "Standalone eject available; npm publishing & npx installer"
features:
  - "multi-provider routing"
  - "native FAISS backend"
  - "checkpoint and resume"
  - "plugin marketplace"
---

# Buff CLI — `agent-nuvira`

**Flexible AI inference tool** — run large language models locally (Ollama) or route to cloud APIs (Groq, NVIDIA NIM, Google Gemini, OpenRouter) through a unified CLI. Discover available models, chat interactively, edit files with AI, and plan codebase changes — all from the terminal.

```bash
# Quick examples
agent-nuvira chat "explain recursion in Rust"
agent-nuvira models --provider groq
agent-nuvira edit main.go --instruction "add input validation"
agent-nuvira plan . --task "implement user authentication"
agent-nuvira config list
```

---

## Feature Matrix (concise)

This table highlights core capabilities for quick machine parsing and comparison.

| Feature | Agent-Nuvira |
|---|---|
| Architecture | Multi-agent pipeline; Swarm (100+ agents, consensus) |
| Orchestration | Sequential sub-agent pipeline; GOAP & swarm topologies |
| Memory | Persistent AgentDB (vector DB) + JSON cache; optional session-only modes |
| Parallel execution | Yes — parallel agent execution and async pipelines |
| Security guardrails | Privacy-focused; PII detection; prompt-injection defenses; security scan CLI |
| Publishing | Standalone eject & npm publishing (`npx agent-nuvira`) |
| **Routing strategy** | **Thompson-sampling bandit + uncertainty escalation + per-model learning + promotion gate A/B + routing rules + hard constraints** |
| **Test suite** | **3,161 tests across 106 files — 100% passing** |
| **Vector backend** | **Native FAISS (automatic), pure-JS IVF fallback, exact JSON fallback** |


## Why Agent-Nuvira? (The Core Edge)

- **🪙 Smart Multi-Provider Token Routing** — stop paying flat premium fees. Nuvira dynamically routes every sub-task across **17+ providers** — local models (Ollama, LM Studio), free tiers (Groq, Google Gemini), and paid/high-capacity clouds (OpenAI, Anthropic, Mistral, Cohere, Together, DeepInfra, Fireworks, Perplexity, NVIDIA NIM, OpenRouter, Azure, Anyscale, vLLM) — so you maximize free-use limits and pay only when complexity demands it. A **central quota ledger** tracks tokens per provider × model with calendar-aware reset windows, parks exhausted providers until free quota resets, and **auto-fails-over mid-session** when a token expires or a rate limit hits — never a stuck session, never a quota error thrown at you
- **🐝 17 Specialized Agent Swarm** — no generic single-prompt boxes. Your goal is decomposed into a DAG of tasks handled by dedicated agents working in parallel: Planner, Context-Gatherer, Writer, Reviewer, Runner, Tester, Debugger, Security Auditor, Git/GitLab specialist, Package installer, PR Reviewer, Issue Triage, Branch Automation, and more
- **🧠 Learning Router that gets better with use** — a Thompson-sampling bandit learns per provider × complexity bucket from *real* task outcomes (cost-adjusted rewards), with hard constraints (`maxCostUsd`, `minSpeed`, `minReasoning`), regex routing rules, uncertainty-driven escalation when the bandit has no data, and **promotion gates** that only keep router changes that measurably improve quality without regressing cost
- **⚡ Deterministic Tier-0 routing** — mechanical edits (remove `console.log`, rename symbols, dedupe imports) complete in **<1ms for $0**, AST-validated before apply, and never touch an LLM unless the goal genuinely needs one
- **🧠 Local FAISS Context Indexing** — blazing-fast, private, semantic code search and retrieval with an optional **native FAISS backend** (pure-JS fallback) that strictly respects your `.gitignore`. Retrieval shrinks a 20k-token gathered context to the top-k relevant chunks — saving tokens so free quotas stretch further
- **🔌 First-Class MCP Integration** — seamlessly connect to Jira, Slack, PostgreSQL, GitHub Issues, and file systems using standard Model Context Protocol servers with SSE transport
- **👥 Real-Time Team Collaboration** — share context, synchronized vector indices, custom agents, and review pipelines across your engineering team via Git-synced config and memory
- **🛡️ No server, no telemetry, no subscriptions** — everything runs locally on your machine

---

## Features

- **Unified interface** across 17+ providers: 5 built-in (local/Ollama, Groq, NVIDIA NIM, Google Gemini, OpenRouter) + 12 configurable via environment variables (OpenAI, Anthropic, Mistral, Cohere, Together, DeepInfra, Fireworks, Perplexity, Azure, LM Studio, Anyscale, vLLM)
- **Model discovery** — `agent-nuvira models` lists available models from any configured provider, with search/filter support
- **Interactive chat** with conversation history, file context, and session commands
- **AI-assisted file editing** with dry-run mode for safe previews
- **Codebase planning** that analyzes directory structure and generates implementation plans
- **Multi-agent orchestration** — `agent-nuvira execute "goal"` runs a pipeline of planner, gatherer, writer, reviewer, tester, and more
- **Response caching** via SQLite to reduce costs and latency
- **Plugin system** with auto-discovery — drop `.js` files into `~/.buff/plugins/` for automatic loading
- **Project scaffolding** — `agent-nuvira init` generates starter projects with interactive template + provider selection
- **Context-preserving model switching** — `agent-nuvira model switch` changes providers mid-session without losing agent state
- **Auto model routing** — `agent-nuvira model switch auto` lets the agent pick the best provider/model for every task based on complexity, cost, latency, privacy, and reliability (with fallback chains + circuit-breaker awareness). Cost scoring uses **real per-1K-token provider pricing** (overridable via `buff config set pricing.<provider>.inputPer1K`), adjusted at runtime by **benchmark quality + per-agent best-model stats**. See why a decision was made with `agent-nuvira model explain` (or `--json` for CI) — walk through a full decision with the 🎯 fit / 📏 measured / ⏳ ctx chips in [`MODELS_EXPLAIN_DEMO.md`](MODELS_EXPLAIN_DEMO.md). Benchmark the router's exact picks with `agent-nuvira benchmark --routing`, validate them end-to-end with `agent-nuvira eval --routing`, and track actual picks + a full audit trail in the dashboard's **Routing** panel
- **Learned-from-real-usage telemetry** — every LLM call (chat, execute, plan, edit, skill, learn, ci, doctor) writes through to the Model Availability Registry **with its action tag**, so the registry learns which provider × model each action **killed** (predictive skip) or **verified** (routable) from real usage — not just probes. `buff models status --verbose` prints registry-blocked providers + per-action verified/killed chips, and the dashboard's **Models** panel shows the same per-action feed with a daily timeline chart. A provider killed by ANY action is skipped predictively by all others; a later real success re-verifies it and un-parks it (the recovery loop), and `buff models unblock <provider>` is the manual escape hatch (demotes the block, clears quota parks + ledger cooldown, then re-probes the live API with an honest `stillBlocked` verdict — `--json` for CI). Proven end-to-end by a hermetic `tests/e2e/` test (mock 429 provider → registry learns → next pick skips). The **VS Code extension** attributes its usage too — every IDE-driven call (chat panel → `ide-chat`, inline suggestions → `ide-inline`, execute/edit/workflow → `ide-<command>`) is tagged via `BUFF_TELEMETRY_ACTION` at spawn, so the same per-action panel shows IDE usage as its own rows
- **Skill compiler** — automatically extracts reusable patterns from successful agent runs into executable skills (`agent-nuvira skill run`)
- **Context-window memory pruner** — prevents long multi-agent chains from exceeding model token limits
- **Complete streaming support** — all 17+ providers support real-time token-by-token output
- **Cost tracking** — per-provider/session/monthly costs with `agent-nuvira stats cost`
- **Prompt history search** — keyword and semantic search across past conversations (`/search`, `buff history`)
- **Native embedding support** — 3-tier embedder with `@huggingface/transformers` for 10x faster semantic search
- **Workflow template marketplace** — 10 built-in templates + GitHub registry with install/publish lifecycle
- **Model benchmarking** — 21 standardized coding tasks with scoring and A/B comparison
- **Docker sandbox isolation** — resource-limited, network-isolated container execution with 8 base images
- **Provider health dashboard** — `agent-nuvira doctor` with color-coded status, watch mode, and auto-fix
- **Memory compression & pruning** — automatic trajectory summarization with configurable retention policies
- **VS Code extension** — Chat Panel with streaming responses, slash commands, and session history;
  Diagnostic → AI Fix from lightbulb menu; Code Lens actions (Test/Review/Explain/Fix) above functions
  and classes; 9 commands, inline code suggestions, diff viewer, agent progress panel
- **Remote agent federation** — multi-machine collaboration with protocol, server, and client
- **Web UI dashboard** — React dashboard with DAG visualization, model health, cost charts, and history browser
- **Hybrid model routing** — intelligent model selection based on task complexity, cost, and availability
- **Team collaboration** — Git-synced shared config, memory, and review pipelines
- **Agent SDK** — `@agent-nuvira/sdk` npm package for building custom agents with scaffolding CLI
- **Provider CLI** — `buff provider list` with color-coded status table, `buff provider health` with per-provider diagnostics
- **Provider fallback routing** — automatic failover between providers with circuit breaker and configurable chain
- **Startup progress feedback** — first launch never looks like a silent hang: a live spinner reports each startup phase (plugins → history & search → semantic index) as it runs
- **Auto-mode session failover** — in Auto routing, a provider whose API key/token expires or rate-limits mid-session is automatically swapped for the next-best provider (auth failures excluded for the session, rate-limit failures for a 120s cooldown, 5xx/network through the circuit breaker) — no more stuck sessions on a dead key
- **Central quota ledger** — tokens/requests per provider × model with calendar-aware reset windows; exhausted providers are **parked** until the window rolls (auto re-enable, no timers), and Auto routing sinks parked providers below healthy candidates **before** a call — plus an optional free/local-first `allowPaid` gate and a `buff model quota` CLI with a cost summary (free vs paid tokens + estimated $ saved)
- **Learning Router CLI** — `buff model bandit` inspects the Thompson-sampling state (α/β priors per provider × complexity bucket, expected win %, learning history, `--json` for CI) and `buff model bandit reset` clears it; routing decisions record a `routedBy` source (`heuristic | rule | bandit`) for full auditability
- **Routing rules & hard constraints** — regex/string task-pattern rules force a provider/model before scoring (first match wins); per-call filters (`routing.maxCostUsd`, `routing.minSpeed`, `routing.minReasoning`) *eliminate* violating providers with a safe fallback when constraints would remove everything
- **Deterministic Tier-0 routing** — mechanical edits short-circuit the LLM entirely (strip `console.*` lines, word-boundary symbol renames, import dedupes) with AST validation and graceful fallthrough to the LLM when a goal isn't mechanical — `$0` and `<1ms` per edit
- **Native FAISS vector backend** — `buff memory backend` shows the active backend (`faiss-native` / `faiss-ivf` / `json`) and why it was chosen; `--check` runs a native-FAISS availability probe with install guidance, and `@faiss-node/native` is used automatically whenever it builds
- **Vector retrieval (token-efficient context)** — large gathered contexts are chunked, embedded locally (`bge-small-en-v1.5` via @huggingface/transformers, zero new deps) and reduced to the top-k semantically-relevant chunks before the LLM call — saving tokens so free quotas stretch further. Complements the quota ledger: **retrieval saves tokens, the ledger manages quotas**. Small contexts pass through untouched (zero overhead); any retrieval failure fails over to full context. `buff retrieval index/query/stats/clear` + a dashboard Retrieval card show the savings
- **Checkpoint / resume** — `buff execute "<goal>" --checkpoint` saves a resume-able snapshot after every task batch; `--resume [id]` rehydrates the plan and continues from the first pending step (a crash / quota kill / token expiry mid-pipeline no longer restarts the whole plan); `--checkpoint-list` shows saved pipelines
- **Security scan CLI** — `buff security scan` detects PII, prompt injections, and dangerous code patterns
- **Feedback & rating system** — `buff feedback record/list/stats/clear` drives self-improvement scoring
- **Marketplace unified CLI** — `buff marketplace browse/search/install/info` for workflow templates + plugins
- **MCP (Model Context Protocol) integration** — connect to databases, APIs, and file systems via MCP servers with SSE transport support
- **AST-aware code editing** — structural analysis engine understands functions, classes, methods across JS/TS/Python/Go/Rust
- **Auto error-repair engine** — automatic diagnosis and repair of test failures with configurable retry budgets
- **Cross-platform dependency installer (Runner)** — auto-detects 11 manifest types (npm/pnpm/yarn with
  lockfile-first priority, pip, bundler, cargo, go, composer, dart pub), installs missing project dependencies
  on failed commands, and bootstrap-installs missing package managers (npm, pip, bundler, cargo, go, composer,
  dart, Homebrew) via brew/apt/dnf/yum/winget/choco/rustup — no manual setup required
- **A2A (Agent-to-Agent) Protocol** — inter-agent communication standard for multi-machine collaboration
- **CI/CD headless mode** — `buff ci` for automated pipelines with GitHub Actions integration
- **npm publishing & one-line install** — `npx agent-nuvira` and `npx buff` for zero-setup onboarding
- **Marketing website** — `website/` directory with a full landing page, SEO meta tags, and Netlify-ready deployment config
- **Branch Automation Hooks (Pillar A4)** — `buff execute "install branch hooks" --auto-branch` installs
  git post-checkout and pre-commit hooks for automated branch workflows; issue-driven branch creation
  (`feat/PROJ-123-description`), PR label-triggered updates, file-watch auto-commit with conventional
  commit messages, and CI failure detection with LLM diagnosis
- **Issue Triage Engine (Pillar A3)** — Automated issue classification, prioritization, and labeling
  across GitHub and GitLab via `buff execute "triage issues"` with LLM-powered analysis
- **GitHub PR Review Agent (Pillar A2)** — Automatic inline code review on open PRs; reads diffs,
  runs security/quality verification, and posts inline review comments via GitHub API
- **GitLab API Integration (Pillar A1)** — Full GitLab agent for merge request management, issue
  discovery, pipeline monitoring, and code review comments
- **Chat Panel DAG Pipeline Visualization (Pillar B6)** — Live multi-agent pipeline visualization
  inline in chat messages for slash commands, showing agent nodes with real-time status updates
- **Real-Time Token Streaming in AgentPanel (Pillar B2)** — Live typewriter-effect token streaming
  with blinking cursor and animated progress indicator in the agent progress panel
- **Interactive development mode** — `buff execute` without a goal launches a guided interactive loop with session save/resume, follow-up suggestions, and failure analysis
- **Session persistence** — save and resume development sessions across CLI restarts with full history
- **Failure analysis** — automatic diagnosis of agent failures with specific recovery options per agent type
- **Follow-up suggestions** — LLM-powered contextual next-step recommendations after goal completion
- **Configuration** via JSON config file + environment variables
- **No server dependency** — no telemetry, no subscriptions, no outbound calls to a hosted backend

---

## Quick Start

### Prerequisites

- **Node.js** 20+ and **npm**
- **TypeScript** knowledge for development; none required to use the CLI

### Install

```bash
# Install globally
npm install -g agent-nuvira

# Or clone and build from source
git clone https://github.com/imdheerajKube/agent-nuvira.git buff
cd buff
npm install
npm run build
npm link
```

### Native FAISS acceleration (optional, recommended)

Agent-Nuvira includes an optional native FAISS backend for faster semantic retrieval. The runtime prefers this backend automatically when the native addon can build successfully; if that path is unavailable, it falls back to the pure-JS IVF implementation and then the exact JSON backend so your workflow stays reliable.

> **How the auto-selection works:** At load time, `createFaissBackend()`
> attempts to import `@faiss-node/native` and run a 1-vector smoke test.
> If the native addon exists and passes the smoke test, the backend is
> `faiss-native`. If the import fails (not installed, build error, or wrong
> API), it falls back to the pure-JS IVF-flat ANN (`faiss-ivf`). If that
> also fails to initialize, the exact JSON backend (`json`) is used as the
> final safety net — semantic search NEVER breaks.

For npm-installed users, the setup is:

```bash
# 1) Install the CLI
npm install -g agent-nuvira

# 2) Install the native build prerequisites (macOS example)
brew install faiss libomp openblas

# 3) Rebuild the optional native addon
npm rebuild @faiss-node/native

# 4) Enable the FAISS-style backend (or leave it on 'auto' to prefer it automatically)
#    'auto' (default) — tries native FAISS first, then pure-JS IVF, then JSON
#    'faiss'         — prefer FAISS-style (native or pure-JS IVF); JSON fallback
#    'json'          — exact flat cosine (the original behavior, no FAISS at all)
agent-nuvira config set memory.vectorBackend auto
# or force it explicitly:
# agent-nuvira config set memory.vectorBackend faiss
```

If you want to confirm the backend in use:

```bash
agent-nuvira memory stats                    # Shows active backend
agent-nuvira memory backend                  # Active backend name + why it was chosen
agent-nuvira memory backend --check          # Same + native availability probe + install guidance
```

### Understanding the FAISS tiers

| Tier | Backend name | When it's used | Performance |
|---|---|---|---|
| **1 — Native FAISS** | `faiss-native` | `@faiss-node/native` installed AND built successfully | Fastest — real FAISS C++ bindings |
| **2 — Pure-JS IVF** | `faiss-ivf` | Native not available; runs TypeScript port of FAISS IndexIVFFlat | Approximate ANN; sub-linear search for large indexes |
| **3 — Exact JSON** | `json` | Both FAISS paths unavailable; flat cosine scan | Exact results; O(n) linear scan |

The pure-JS IVF tier uses deterministic k-means++ clustering (nlist=sqrt(n)),
inner product of L2-normalized vectors (= cosine similarity), and nprobe probe
lists. For small indexes (≤ 512 entries) it runs an exact scan so results are
identical to the JSON backend. Filter-aware probe expansion ensures that
metadata filters don't miss results.

If the native addon cannot be built on your machine, Agent-Nuvira will continue to work using the pure-JS fallback path.

### Verify

```bash
agent-nuvira --help
```

You should see:

```
Usage: agent-nuvira [options] [command]

Flexible AI inference CLI tool — local models & cloud APIs

Options:
  -V, --version  output the version number
  -d, --debug    enable debug logging
  -h, --help     display help for command

Commands:
  chat [options] [prompt]       Start an interactive chat session with AI
  edit [options] <file>         Edit a file using AI assistance
  models [options]              List available models from inference providers
  plan [options] [target]       Generate an implementation plan for a codebase task
  execute [options] <goal>      Execute a multi-agent pipeline for a goal
  model                         Switch providers and manage active models
  skill                         List, compile, and run reusable skill scripts
  init [name]                   Scaffold a new project from a template
  history                       Search and manage chat history
  doctor                        Provider health dashboard
  benchmark                     Run model benchmarks
  workflow                      Workflow template marketplace
  federation                    Remote agent federation
  team                          Team collaboration
  dashboard                     Launch web UI dashboard
  memory                        Memory compression and stats
  provider                      Provider list and health diagnostics
  security                      Security scan for PII, injections, and dangerous code
  feedback                      Feedback and rating system
  marketplace                   Browse, search, and install plugins and workflows
  mcp                           Model Context Protocol — connect to MCP servers
  plugins                       Manage auto-discovered plugins
  sandbox                       Docker sandbox management
  sdk                           Agent SDK scaffolding
  config                        Manage Buff configuration
  cache                         Manage inference cache
```

---

## Getting API Keys

Each cloud provider requires an API key. Sign up and get your key from the links below.

### 🔷 Groq (Fast — LPU Cloud Inference)

Groq runs open-source models at blazing speeds on their custom LPU hardware.

1. Sign up at **[console.groq.com](https://console.groq.com)** (free tier available)
2. Go to **API Keys** → **Create API Key**
3. Copy your key (starts with `gsk_`)

```bash
export GROQ_API_KEY="gsk_xxxxxxxxxxxxxxxx"
```

### 🔶 NVIDIA NIM

NVIDIA NIM provides hosted API access to a wide catalog of models (121+ models).

1. Sign up at **[build.nvidia.com](https://build.nvidia.com)** (free tier with rate limits)
2. Generate an API key from the **Get API Key** button
3. Copy your key (starts with `nvapi-`)

```bash
export NVIDIA_NIM_API_KEY="nvapi-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

### 🔷 Google Gemini

Google's Gemini API has a generous free tier with competitive models.

1. Visit **[aistudio.google.com/apikey](https://aistudio.google.com/apikey)** and click **Create API Key**
2. Select your Google Cloud project or create one
3. Copy your key (starts with `AIzaSy`)

```bash
export GEMINI_API_KEY="AIzaSyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

### 🟣 OpenRouter

OpenRouter gives you access to 200+ models from OpenAI, Anthropic, Google, Meta, and more — all through one API.

1. Sign up at **[openrouter.ai/keys](https://openrouter.ai/keys)** (free credits on sign-up)
2. Click **Create Key**
3. Copy your key (starts with `sk-or-v1-`)

```bash
export OPENROUTER_API_KEY="sk-or-v1-xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

## MCP (Model Context Protocol) Configuration

MCP servers extend your agent's capabilities by connecting to external tools and data sources — databases, APIs, file systems, search engines, code repositories, and more. Agent-Nuvira supports the MCP standard for discovering and invoking tools from connected servers.

### Configuration Files

MCP server configs are JSON files placed in '~/.buff/mcp/'. Each file defines one server connection. Files are auto-discovered at startup.

```bash
mkdir -p ~/.buff/mcp
```

### Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique name for this server connection |
| `transport` | `"stdio"` or `"sse"` | Yes | Transport protocol (stdio for local subprocess, sse for remote HTTP) |
| `command` | string | For stdio | The command to run (e.g., `npx`, `node`, a binary path) |
| `args` | string[] | For stdio | Command arguments |
| `url` | string | For sse | The SSE endpoint URL (e.g., `https://example.com/mcp`) |
| `headers` | object | Optional | Custom HTTP headers for SSE transport (e.g., `Authorization`) |
| `env` | object | Optional | Environment variables for the stdio subprocess |
| `enabled` | boolean | Yes | Set to `false` to temporarily disable the server |

### Transport Types

#### stdio (Local Subprocess)

Spawns a local process (Node.js, Python, Go binary, etc.) and communicates via stdin/stdout using JSON-RPC 2.0.

```json
{
  "name": "filesystem",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
  "enabled": true
}
```

#### sse (Remote HTTP)

Connects to a remote HTTP endpoint using Server-Sent Events (SSE). Supports custom headers for authentication.

```json
{
  "name": "exa",
  "transport": "sse",
  "url": "https://websetsmcp.exa.ai/mcp",
  "headers": {
    "Authorization": "Bearer YOUR_EXA_API_KEY"
  },
  "enabled": true
}
```

### Examples

#### 1. Filesystem Server

Read/write files and directories on your local machine.

```json
{
  "name": "filesystem",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/your/project"],
  "enabled": true
}
```

```bash
buff mcp connect filesystem
buff mcp call read_file --server filesystem --args '{"path":"/path/to/file.txt"}'
```

#### 2. GitHub Server

Search repositories, issues, PRs, and code on GitHub. Requires a GitHub Personal Access Token.

**Setup:**
1. Build the binary: `git clone https://github.com/github/github-mcp-server.git && cd github-mcp-server && go build -o github-mcp-server ./cmd/github-mcp-server/`
2. Move it to your PATH: `mv github-mcp-server /usr/local/bin/`
3. Create a GitHub PAT at https://github.com/settings/tokens
4. Add the config below to '~/.buff/mcp/github.json'

```json
{
  "name": "github",
  "transport": "stdio",
  "command": "/usr/local/bin/github-mcp-server",
  "args": ["stdio"],
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "github_pat_xxxxxxxxxxxx"
  },
  "enabled": true
}
```

```bash
buff mcp connect github
buff mcp list
# Tools include: search_repositories, search_issues, search_code, search_pull_requests, etc.
buff mcp call search_repositories --server github --args '{"query":"react","limit":5}'
```

#### 3. Exa WebSets Server (SSE with Bearer Auth)

Search and enrich web entities (companies, people, research papers) using Exa's AI-powered search API. Uses SSE transport with Bearer token authentication.

**Setup:**
1. Get your Exa API key at https://dashboard.exa.ai
2. Add the config below to '~/.buff/mcp/exa.json'

```json
{
  "name": "exa",
  "transport": "sse",
  "url": "https://websetsmcp.exa.ai/mcp",
  "headers": {
    "Authorization": "Bearer YOUR_EXA_API_KEY"
  },
  "enabled": true
}
```

```bash
buff mcp connect exa
buff mcp list
# Tools include: create_webset, create_search, create_enrichment, list_websets, etc.
```

### CLI Commands

| Command | Description |
|---------|-------------|
| `buff mcp list` | List all discovered MCP servers and their tools |
| `buff mcp connect <name>` | Connect to a specific MCP server |
| `buff mcp connect --all` | Connect to all discovered MCP servers |
| `buff mcp call <tool> --server <name> --args '{"key":"val"}'` | Call a tool on a connected server |
| `buff mcp info <name>` | Show detailed information for an MCP server |
| `buff mcp refresh` | Re-discover and reconnect to all MCP servers |

### Auto-Discovery with the Orchestrator

When you run `buff execute`, the orchestrator automatically:

1. Scans '~/.buff/mcp/' for JSON config files
2. Connects to all enabled MCP servers
3. Injects tool descriptions into the agent's context
4. The planner can schedule MCP tool calls as pipeline steps

### Finding More MCP Servers

Browse the official MCP server directory at **[modelcontextprotocol.io/servers](https://modelcontextprotocol.io/servers)**. Popular servers include:

- **Filesystem** — Read/write local files
- **GitHub** — Repository, issue, PR, and code search
- **PostgreSQL** — Query databases
- **SQLite** — Query SQLite databases
- **Brave Search** — Web search
- **Docker** — Container management
- **Puppeteer** — Browser automation
- **Slack** — Channel and message access



---

## Configuration

### Config File

Configuration lives at `~/.buff/buffconfig.json`. It is created with sensible defaults on first use.

You can inspect and modify it through the CLI:

```bash
# Show full configuration
agent-nuvira config

# Set the default provider
agent-nuvira config set defaultProvider gemini

# Set a provider's model
agent-nuvira config set providers.nim.model "meta/llama-3.1-8b-instruct"

# List all providers with their status
agent-nuvira config list
```

### Default Configuration

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

### Environment Variables

API keys can be set via environment variables instead of the config file. They take **priority** over the config file.

| Variable | Provider | Required? | Get Your Key |
|---|---|---|---|
| `GROQ_API_KEY` | Groq | Yes, unless using local | [console.groq.com](https://console.groq.com) |
| `NVIDIA_NIM_API_KEY` | NVIDIA NIM | Yes, unless using local | [build.nvidia.com](https://build.nvidia.com) |
| `GEMINI_API_KEY` | Google Gemini | Yes, unless using local | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `OPENROUTER_API_KEY` | OpenRouter | Yes, unless using local | [openrouter.ai/keys](https://openrouter.ai/keys) |

You can place a `.env` file in the project root or at `~/.buff/.env`:

```env
# ~/.buff/.env
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NVIDIA_NIM_API_KEY=nvapi-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GEMINI_API_KEY=AIzaSyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## CLI Commands

### `agent-nuvira models` — Model Discovery (New in v1.1.0)

List available models from any configured provider. Query each provider's model catalog without leaving the terminal.

```bash
# List models from the default provider
agent-nuvira models

# List models from a specific provider
agent-nuvira models --provider nim
agent-nuvira models --provider groq
agent-nuvira models --provider openrouter

# Search for models by keyword
agent-nuvira models --search deepseek
agent-nuvira models --search llama

# Show all providers (even unconfigured ones)
agent-nuvira models --all
```

**Examples:**

```bash
# See all models on Groq
agent-nuvira models --provider groq

# Find DeepSeek models across all configured providers
agent-nuvira models --search deepseek

# Output:
# ════════════════════════════════════════════
# 📋 Available Models (3)
# ════════════════════════════════════════════
#
# Groq:
# ----------------------------------------
#   deepseek-ai/deepseek-v4-pro [deepseek]
#   deepseek-ai/deepseek-v4-flash [deepseek]
#   deepseek-ai/deepseek-coder-6.7b-instruct [deepseek]
#
# ════════════════════════════════════════════
```

Use a discovered model immediately:

```bash
agent-nuvira chat --provider groq --model deepseek-ai/deepseek-v4-flash
agent-nuvira edit src/server.ts --provider openrouter --model openai/gpt-4o
```

**Model Availability Registry** — the registry is the sub-ms FAISS/JSON store
routing reads on every pick. `models status` shows verified / unavailable /
quota-parked models; `--verbose` adds the two things routing learned from real
usage: which providers are **registry-blocked** (skipped predictively — with the
learned reason for each blocked model) and the **per-action telemetry** (which
action verified/killed which provider × model):

```bash
# Show the registry (verified / unavailable / quota-parked)
agent-nuvira models status

# Same + registry-blocked providers (why routing skips them) + per-action
# "learned from real usage" telemetry (chat/execute/plan/edit verified/killed)
agent-nuvira models status --verbose

# The dashboard's Models panel charts the same feed per action — scrub across
# days (drag / click / range slider / ▶ play) to see each day's exact
# verified vs killed provider × model chips
agent-nuvira dashboard

# Probe + spot-check now (proactive health, not reactive)
agent-nuvira models refresh
# Background maintenance daemon
agent-nuvira models watch

# Escape hatch: manually release a registry-blocked provider (demotes
# unavailable → unverified, clears quota parks + ledger cooldown, then
# re-probes the live API to re-learn the truth — honest stillBlocked output)
agent-nuvira models unblock gemini
# Same, but skip the live re-probe (demote + un-park only)
agent-nuvira models unblock nim --no-spot-check
# Machine-readable for CI
agent-nuvira models unblock groq --json
```

---

### `agent-nuvira chat` — Interactive Chat

Start a terminal-based chat session with any provider.

```bash
# Interactive mode (default provider)
agent-nuvira chat

# One-shot prompt
agent-nuvira chat "what is the difference between TCP and UDP?"

# Specify provider and model
agent-nuvira chat --provider gemini --model gemini-2.0-flash-exp

# Include a file as context
agent-nuvira chat --file ./src/main.ts "explain this code"

# Disable caching
agent-nuvira chat --no-cache
```

**Interactive commands** within a chat session:

| Command | Action |
|---|---|
| `/exit` or `/quit` | End the session |
| `/clear` | Clear conversation history |
| `/info` | Show current provider details |
| `/help` | Show available commands |

---

### `agent-nuvira edit` — AI-Assisted File Editing

Edit a file using natural language instructions. The AI reads the file, applies your instruction, and writes the result back.

```bash
# Edit with default instruction ("Review and improve this code")
agent-nuvira edit src/server.ts

# Provide a specific instruction
agent-nuvira edit src/server.ts --instruction "add rate limiting middleware"

# Use a specific provider
agent-nuvira edit src/server.ts --provider openrouter --model openai/gpt-4o

# Preview changes without modifying the file
agent-nuvira edit src/server.ts --instruction "add error handling" --dry-run
```

---

### `agent-nuvira plan` — Implementation Plans

Analyze a directory or file and generate a structured implementation plan.

```bash
# Plan for the current directory
agent-nuvira plan

# Plan for a specific target with a task description
agent-nuvira plan ./src --task "add user authentication with JWT"

# Use a cloud provider for complex planning
agent-nuvira plan . --task "refactor to microservices" --provider gemini

# Verbose mode shows the full context sent to the model
agent-nuvira plan -v
```

The plan includes:
1. **Summary** — high-level overview
2. **Files to Modify** — specific files and changes
3. **Architecture Changes** — structural modifications
4. **Implementation Steps** — ordered guide
5. **Potential Risks** — edge cases and breaking changes
6. **Testing Strategy** — verification approach

---

### `agent-nuvira config` — Configuration Management

```bash
# Show full config
agent-nuvira config

# Set a value
agent-nuvira config set defaultProvider openrouter

# Get a specific value
agent-nuvira config get providers.nim.model

# List all providers with their status
agent-nuvira config list

# Initialize (show defaults)
agent-nuvira config init
```

---

### `agent-nuvira cache` — Cache Management

Inference responses are cached in a local SQLite database (`~/.buff/cache.db`) with a default TTL of 1 hour.

```bash
# Show cache statistics
agent-nuvira cache stats

# Clear all cached responses
agent-nuvira cache clear
```

---

### `agent-nuvira model` — Context-Preserving Model Switching

Switch inference providers and models on the fly without losing conversation history, agent state, or session continuity. The active model persists across CLI restarts.

```bash
# Show current active model + prompt to switch
agent-nuvira model

# List all providers with their status
agent-nuvira model list

# Interactive categorized model picker
# (choose "Browse by provider" to drill into ONE provider's full model list,
#  e.g. OpenRouter's 100+ models, and pick a specific one)
agent-nuvira model switch

# Switch to a provider with its default model
agent-nuvira model switch groq

# Switch to a specific provider/model pair
agent-nuvira model switch groq/llama-3.3-70b-versatile

# Auto routing — agent decides the best provider/model per task
# (fast cheap models for simple work, stronger models for complex tasks,
#  local models for private tasks)
agent-nuvira model switch auto

# Show detailed active configuration
agent-nuvira model info

# Get model routing recommendations
agent-nuvira model recommend

# Explain why Auto routing picks a model for a task (transparency/debugging)
agent-nuvira model explain "implement JWT auth with refresh tokens"
agent-nuvira model explain                  # walks 5 sample complexities
agent-nuvira model explain --agent writer "your task"
agent-nuvira model explain "your task" --json  # machine-readable (scripting/CI)

# Walk through a narrated decision (the 🎯 fit / 📏 measured / ⏳ ctx chips)
# → see MODELS_EXPLAIN_DEMO.md for a full annotated example

# Benchmark the exact provider/model pairs the Auto router picks
agent-nuvira benchmark --routing

# Evaluate the Auto router's picks end-to-end (full multi-agent pipeline + hidden tests)
agent-nuvira eval --routing

# Every explain snapshot + routing-mode pick is recorded to the dashboard's audit trail
# (Routing panel → 'Audit Trail — routing decision timeline')

# Quick health check for the active provider
agent-nuvira model health
```

**Priority chain:** CLI `--provider`/`--model` flags → `buff model switch` active state → default config file — the most specific wins.

#### Learning Router — Thompson-sampling bandit + hard constraints (v1.51.0 Enhanced)

Auto routing can **learn from real outcomes** (ruflo-inspired `model-router` math, generalized to all providers). The routing engine scores providers across 5 weighted dimensions (reasoning, speed, cost, privacy, reliability) with per-complexity weight matrices for all 5 levels.

```bash
# Enable bandit learning — each provider's score is multiplied by a Beta draw
# learned per complexity bucket from actual task successes/failures
agent-nuvira config set routing.bandit true

# Hard per-call budget (USD) — providers whose typical call exceeds this are
# eliminated, not just scored lower
agent-nuvira config set routing.maxCostUsd 0.005

# Minimum capability floors for auto-routed tasks (0–1)
agent-nuvira config set routing.minSpeed 0.5
agent-nuvira config set routing.minReasoning 0.6
```

#### How the routing engine works (v1.51.0)

**5 scoring dimensions:** Every provider has a static capability profile (0–1) for reasoning, speed, cost, privacy, reliability. The cost dimension is computed from **real per-1K-token pricing** (free tiers = $0) — configurable via `buff config set pricing.<provider>.inputPer1K`.

**5 complexity levels:** The task description is analyzed for keywords to determine complexity (trivial → critical). Each level has a distinct weight matrix that shifts dominance:
- **Trivial/simple:** cost + speed dominate (fast small model)
- **Moderate:** balanced
- **Complex/critical:** reasoning + reliability dominate (deep reasoning with larger model)

**4 preference modes:** `balanced`, `performance-first`, `cost-first`, `privacy-first` — each applies additive weight adjustments that shift the routing decision predictably.

**1. Thompson-sampling bandit** — Each provider keeps a **Beta(α, β) prior per complexity bucket** so learning is task-type-local. Final score = `deterministicScore × θ` where `θ ~ Beta(α, β)`. Cold start `Beta(1,1)` behaves like the plain heuristic router until outcomes accumulate. The orchestrator **records every auto-routed task's outcome** (success/failure) into the bandit. Success rewards are **cost-adjusted** — a cheap provider's success is worth the most. State persists to `~/.buff/memory/router-bandit.json`.

**2. Uncertainty-driven escalation** — When the bandit's winner has no learned data (α+β < default 8 samples), routing escalates to the next-ranked provider that HAS learned data with a ≥55% win-rate floor. This prevents a cold-start winner from committing to a coin flip.

**3. Per-modelId learning** — Both provider-level and model-level Beta priors track which concrete model won (e.g., `llama-3.3-70b-versatile` ≠ `openai/gpt-oss-20b` on the same provider). Cold start keeps the configured pin; learned models prefer the best Thompson-sampled one.

**4. Promotion gate A/B** — Every auto-routed task records both the deterministic heuristic pick and the bandit pick for the same task. The `buff model bandit` command evaluates 3 criteria (quality improvement >2%, cost regression ≤1%, p95 latency regression ≤5%) before promoting the bandit over the heuristic.

**5. Routing rules** — Regex/string task-pattern rules force a specific provider/model before scoring (first match wins). Rules also note the forced provider for correct bandit outcome attribution.

**6. Hard constraints** — `routing.maxCostUsd`, `routing.minSpeed`, `routing.minReasoning` eliminate violating providers with graceful fallback when constraints would remove everything.

**7. Credential-aware filtering** — Auto routing never picks a provider without configured credentials. The ModelRegistry fast path verifies usable models; explicit `allowedProviders` always win.

**8. Quota-ledger integration** — Exhausted providers sink below healthy ones like circuit-breaker cooldown, only picked when every candidate is parked.

**9. Runtime stats blending** — Benchmark quality scores (30%) + per-agent best-model stats adjust provider capability scores in real time.

**10. Verification-aware escalation** — Verification-heavy tasks (deploy, security audit) boost reasoning+reliability weights and reorder candidates so the strongest provider for verification is tried first.

**11. Free/local-first gate** — `routing.allowPaid: false` keeps paid providers out of trivial/simple/moderate tasks; complex/critical tasks may still use high-capacity models.

Inspect and manage the bandit from the CLI:

```bash
# Show the bandit state (α/β priors + expected win % per provider × complexity bucket)
agent-nuvira model bandit

# Machine-readable snapshot (priors, expected win rates, learning history)
agent-nuvira model bandit --json

# Reset all Beta priors back to Beta(1,1)
agent-nuvira model bandit reset
```

The dashboard's 🤖 **Routing** panel shows the same bandit live — an α/β heatmap plus a learning-history timeline (enable `routing.bandit` and run auto-routed tasks to populate it). It also renders a live **🎖️ Promotion Gate** card: an A/B verdict on whether the bandit is actually **better than the deterministic heuristic**, judged on real trajectories (`router-promotion.jsonl`) — quality must improve >2% while cost and latency don't regress.

**Routing rules** — force a specific provider/model for task patterns (regex/string, evaluated before scoring, first match wins):

```jsonc
// ~/.buff/buffconfig.json
{
  "routing": {
    "bandit": true,
    "maxCostUsd": 0.005,
    "rules": [
      { "name": "marketing → groq", "pattern": "email|sales|copy", "provider": "groq" },
      { "name": "refactor → local", "pattern": "refactor", "provider": "local" }
    ]
  }
}
```

Every decision records a `routedBy` source (`heuristic` | `rule` | `bandit`) in the dashboard's routing audit trail so you can see exactly how each pick was produced. The `routedBy` field is also exposed in the `AutoRouteResult` for programmatic access.

#### Auto-mode session failover — providers that die mid-session get swapped automatically

A provider can look healthy at pick time and still fail mid-session: Gemini's
`token limit exceeded`, OpenRouter 401s, quota exhaustion, or a rate limit on a
free tier. In Auto mode, `chat` now **remembers failed providers for the session**
and routes around them instead of getting stuck:

| Failure kind | Handling |
|---|---|
| **Auth** (expired/invalid key, 401) | Provider excluded from Auto routing for the **whole session** — re-picked routes skip it entirely |
| **Rate limit** (429, quota exceeded, `token limit`, `insufficient_quota`, `resource has been exhausted`) | Provider parked for a **120s cooldown** (aligned with the circuit breaker), then automatically re-admitted |
| **5xx / network** | Flows through the shared **circuit breaker** (3 failures in 60s → 120s cooldown); never session-excluded |

On failure the chat loop prints `⚠️ <provider> failed — automatically switching to
<provider> (<model>)` and transparently re-routes to the next-best candidate.
In-cooldown providers are deprioritized by router scoring (via circuit-breaker
state), the final fallback always prefers a provider that hasn't failed this
session, and the failover path is crash-proof — a throwing re-route can't kill
the interactive loop. Works for both streaming and non-streaming responses.

#### Deterministic Tier-0 routing — mechanical edits without an LLM

Simple mechanical edits never touch an LLM (ruflo's `enhanced-model-router` Tier-1 codemod idea, built on agent-nuvira's editing engine):

| Goal pattern | Deterministic transform | Cost |
|---|---|---|
| `remove all console.log statements` / `clean up debug logging` | Strips standalone `console.*` lines | **$0 · <1ms** |
| `rename foo to bar` (symbol present in context) | Word-boundary rename across all references | **$0 · <1ms** |
| `remove duplicate imports` | Deduplicates same-module import lines | **$0 · <1ms** |

- Runs **before** the LLM in the edit pipeline; every transformed file is **AST-validated** first, so tier-0 never emits broken code.
- If the goal isn't mechanical (or validation fails), the pipeline **falls through to the LLM** unchanged.
- Tier-0 results flow through the same safe-apply pipeline (dry-run, sandbox, review bundles) and emit `edit:written` events tagged `via: tier0`.
- Disable per call with `useTier0: false` in the EditModule API.

#### Central quota ledger — free/local-first routing with reset windows

Every Auto-routed call is write-through recorded into a **central quota ledger** (tokens/requests per provider × model). The ledger powers four things:

1. **Calendar-aware reset windows** — daily/hourly free-tier limits with automatic re-enable exactly when the window rolls (no arbitrary timers).
2. **Predictive parking** — a provider that exhausts its window is **parked** and sinks below healthy candidates **before** the next call, not after a reactive failure.
3. **Free/local-first gate** — `routing.allowPaid: false` keeps paid providers out of trivial/simple/moderate tasks; complex/critical tasks may still use paid high-capacity models.
4. **Cost transparency** — `buff model quota` shows free vs paid tokens and an **estimated $ saved** figure (what the free-tier usage would have cost at a typical paid rate).

```bash
# Set per-provider quota limits (requests per reset window)
agent-nuvira config set routing.quota.gemini.requestsPerWindow 1500
agent-nuvira config set routing.quota.groq.requestsPerWindow 14400
agent-nuvira config set routing.quota.groq.tokensPerWindow 1000000
agent-nuvira config set routing.quota.groq.windowMs 86400000   # 24h reset window

# Free/local-only unless complexity demands paid (assessment-gap gate)
agent-nuvira config set routing.allowPaid false

# Inspect the ledger (tokens/requests per provider × model, resets in, parked state)
# and the cost summary (free vs paid tokens + estimated $ saved)
agent-nuvira model quota

# Same data machine-readable (costSummary field) for scripting/CI
agent-nuvira model quota --json

# Clear all ledger entries
agent-nuvira model quota reset
```

The dashboard's 📒 **Quota Ledger** card shows the same data live — per-entry status plus a free/local-first cost split (free tokens = savings, paid tokens = actual spend) with an estimated $ saved badge.

**Failover timeline (transparency: when failover occurred).** Every park, window-reset re-enable, manual release, and mid-session failover is appended to `~/.buff/memory/quota-events.jsonl` (capped at 200). The dashboard's Quota card renders it as a **Failover Timeline**, and `buff model quota` prints the last 20 events:

```bash
agent-nuvira model quota
#   ── Failover Timeline (last 20) ──
#    ⚡ failover    gemini        (rate-limit)  8/2/2026, 5:10:02 PM
#    ⏸ parked      gemini        (rate-limit)  8/2/2026, 5:10:02 PM
#    🔁 re-enabled  groq          (window reset) 8/2/2026, 5:09:00 PM
```

The timeline is also **live**: the dashboard watches `quota-events.jsonl` /
`quota-ledger.json` on disk and pushes a `quota` SSE event the moment a failover
or park lands — so the card updates in real time, no page refresh or 10s wait.
(The watcher arms while a dashboard is connected and disarms when the last one
disconnects.) To keep it armed from server start — so the timeline is already
current the moment a dashboard connects, even after the server sat idle between
viewing sessions — enable always-on mode:

```bash
# Keep the quota watcher armed from server start (never disarms on client count)
agent-nuvira config set routing.alwaysWatchQuota true
```

Always-on trades a tiny idle fs watch for instant-up-to-date quota state.

#### Vector retrieval — token-efficient context (saves tokens, complements the quota ledger)

Agent-Nuvira can **vectorize large context** with a local embedding model + the
pure-JS vector store — no FAISS/native deps, no server. The retrieval layer
saves tokens (stretching free quotas), while the quota ledger manages limits:

| Piece | What it does |
|---|---|
| **Chunking** | Large files split into ~512-token chunks (64-token overlap, paragraph-aware) |
| **Embedding** | `bge-small-en-v1.5` (384-dim) via @huggingface/transformers — local, free, offline, cached |
| **Vector store** | Pure-JS cosine-similarity index in `~/.buff/memory/vectors-repo.json` (honors `BUFF_MEMORY_DIR`), isolated from memory/history vectors |
| **Retrieval** | Goal/subtask embedded → top-k chunks (default 5) → reduced context |
| **Router policy** | Context ≤ threshold (12k tokens) → **direct call, zero overhead**; larger → embed + retrieve; any failure → **failover to full context** (never breaks the LLM call) |
| **Transparency** | `🧠 Retrieved 5 chunks — reduced context 20k → 3k tokens` + `buff retrieval stats` + dashboard Retrieval card |

```bash
# Pre-index a repo so Auto runs are instant (first run downloads the ~130MB
# model once, then cached locally)
agent-nuvira retrieval index .

# Semantic search over the indexed repo
agent-nuvira retrieval query "how does login with JWT work?"

# Token-savings transparency
agent-nuvira retrieval stats

# Wipe index + stats
agent-nuvira retrieval clear
```

Where retrieval applies (honest split):
- **`buff chat --file <large-file>`** — the file is chunked, embedded, and
  reduced to the top-k relevant chunks before the LLM call (big token savings).
- **`buff execute` pipelines** — after the context-gatherer collects files, the
  orchestrator indexes them and produces a **semantic file ranking** for the
  writer (relevance over size when selecting which files fit the token budget),
  and records the retrieval into the token-savings stats.

**Config** (`routing.retrieval`):

```bash
# Master switch (default true)
agent-nuvira config set routing.retrieval.enabled false

# Top-k chunks (default 5), chunk size (default 512 tokens), vectorize threshold (default 12000 tokens)
agent-nuvira config set routing.retrieval.topK 8
agent-nuvira config set routing.retrieval.chunkTokens 640
agent-nuvira config set routing.retrieval.thresholdTokens 20000
```

**Vector search backend** (`memory.vectorBackend`):

```bash
# Show which backend is active
agent-nuvira memory stats        # ... Backend: faiss-ivf (FAISS-style IVF-flat ANN)

# Choose the backend explicitly
agent-nuvira config set memory.vectorBackend auto   # default: native FAISS when built, else pure-JS IVF
agent-nuvira config set memory.vectorBackend faiss  # prefer FAISS-style; JSON fallback on native failure
agent-nuvira config set memory.vectorBackend json   # exact flat cosine (the original behavior)
```

- **`auto` (default)** — uses the **FAISS-style backend**: real `@faiss-node/native`
  bindings when the user has installed AND built them (smoke-tested at load),
  otherwise a **pure-JS IVF-flat ANN** — a faithful TypeScript port of FAISS's
  `IndexIVFFlat` (nlist inverted lists via deterministic k-means++, nprobe
  probe lists, cosine = inner product of L2-normalized vectors). Small indexes
  (≤ 512 entries) use an EXACT scan so results are identical to the JSON
  backend; large indexes get sub-linear approximate search with filter-aware
  probe expansion. Any native failure falls back gracefully — semantic search
  never breaks.
- **Why native FAISS is not the hard default (decision):** `@faiss-node/native`
  ships no prebuilt binaries and requires compiling FAISS from source
  (cmake + OpenBLAS + libomp) at install time — verified to fail on a stock
  macOS dev box. Making it a required dependency would break zero-setup
  `npx agent-nuvira`. The pure-JS IVF-flat backend provides the same
  FAISS-style approximate-NN behavior with zero native deps; users who build
  the native package automatically get the real thing.

**Roadmap (Step 6 — future enhancements):**
1. **Hybrid retrieval** — combine embeddings with keyword/BM25 scoring for
   exact-match-sensitive queries.
2. **Embedding caching** — the embedder already caches in-memory; a persistent
   on-disk embedding cache would skip re-embedding unchanged chunks across
   sessions.
3. **Multi-vector routing** — different embedding models for code vs natural
   language (the store already supports namespaced indexes, so this is a
   config-level addition).

**Opt-in failover confirmation.** By default Auto mode fails over silently
(never get stuck). If you'd rather approve each mid-session swap, enable:

```bash
# Ask before Auto mode switches providers mid-session
agent-nuvira config set routing.promptOnFailover true
```

With this on, a failed provider shows the next-ranked candidate and lets you
choose "switch (recommended)" or "pick a provider myself" — so every swap is
an informed decision, not a silent surprise.

This also applies to **single-shot Auto prompts** (`buff chat "ask something"`
with `-m auto`): before Auto mode silently hops to the next candidate, the CLI
asks; picking "manual" surfaces the original provider error instead of
switching behind your back.

#### Checkpoint / resume — crash-proof multi-agent pipelines

Long `buff execute` pipelines can be killed by a crash, quota exhaustion, or a token expiry mid-run. Checkpoints serialize the pipeline state so work is never lost:

```bash
# Save a resume-able checkpoint after every task batch (in ~/.buff/memory/checkpoints/)
agent-nuvira execute "build the API" --checkpoint

# Resume the latest checkpoint for this goal + cwd (skips completed steps + the planner)
agent-nuvira execute "build the API" --resume

# Resume a specific checkpoint
agent-nuvira execute "build the API" --resume cp-3f9a2c1d0b7e

# List saved checkpoints (goal, progress %, saved-at)
agent-nuvira execute --checkpoint-list
```

How it works:
- After **every task batch** the orchestrator saves a snapshot of the task plan (per-step statuses), artifacts, file changes, and metadata.
- `--resume` rehydrates the vault, **skips completed steps and the planner**, and continues from the first pending step — on whatever provider/model is now available.
- `--checkpoint` alone always starts **fresh** (it never silently resumes a stale checkpoint); only an explicit `--resume` loads.
- State persists across sessions, so a provider that died mid-pipeline can resume on the next-best provider with zero rework (assessment item #6: continuity across models).

---

### `agent-nuvira execute --auto-branch` — Branch Automation

Automate your entire git workflow with trigger-based hooks. Install once, then let the agent handle branch creation, commits, and PR updates automatically.

```bash
# Step 1: Install branch automation hooks
buff execute "install branch hooks" --auto-branch

# Step 2: Check automation status
buff execute "check branch status" --auto-branch

# Step 3: Auto-create a branch from an issue
buff execute "auto-create branch from issue PROJ-123" --auto-branch

# Step 4: Auto-commit changes with a conventional message
buff execute "auto-commit changes" --auto-branch

# Step 5: Start file-watch mode (auto-commits on file changes)
buff execute "start file watch" --auto-branch

# Step 6: Diagnose CI failures
buff execute "check CI for PR #42" --auto-branch
```

**Trigger Sources:**

| Trigger | Action | Description |
|---------|--------|-------------|
| **Issue → Branch** | `feat/PROJ-123-description` | Auto-creates branches with conventional naming when issues are assigned |
| **PR Label → Update** | `git push origin <branch>` | Commits and pushes changes when labels like `wip` or `needs-work` are detected |
| **File Watch → Commit** | `git commit -m "feat(scope): ..."` | Background polling detects file changes and auto-commits with conventional messages |
| **CI Status → Fix** | LLM diagnosis + fix plan | Analyzes CI failures from recent commits and suggests targeted fixes |

**Conventional Commit Format:**

```
<type>(<scope>): <description>

Types: feat, fix, refactor, docs, style, test, chore, perf
Scope: module/area affected (auto-detected from changed files)
```

**Installed Hooks:**

| Hook | Purpose |
|------|---------|
| `post-checkout` | Detects issue-based branches on checkout and loads context |
| `pre-commit` | Enforces conventional commit format with auto-detection |
| `file-watch.sh` | Background script that polls for changes and triggers auto-commits |

---

### `agent-nuvira skill` — Skill Compiler System

Automatically convert successful agent execution trajectories into reusable, parameterized skill scripts. Skills are extracted by an LLM from high-scoring runs, saved to `~/.buff/skills/`, and invoked directly via the orchestrator.

```bash
# List all compiled skills
agent-nuvira skill list

# Show a skill's definition and steps
agent-nuvira skill show "Add CLI Command"

# Run a skill with parameters (invokes the orchestrator)
agent-nuvira skill run "Add CLI Command" --params commandName=deploy --params description="Deploy to production"

# Manually trigger skill compilation from recent trajectories
agent-nuvira skill compile

# Search skills by keyword
agent-nuvira skill search "cli"

# Show skill quality scores
agent-nuvira skill quality

# Garbage-collect old/low-quality skills
agent-nuvira skill gc
```

**How it works:** Every 8 successful orchestration runs, the Self-Improver automatically feeds the top-5 trajectories to the Skill Compiler. The LLM identifies reusable patterns and parameterizes them with `{{paramName}}` placeholders. Skills act as pre-built task plans that the orchestrator can execute on demand.

---

### `agent-nuvira init` — Project Scaffolding

Scaffold new projects from built-in templates with interactive prompts and provider selection. Supports custom template directories.

```bash
# Interactive: name, template, and provider prompts
agent-nuvira init

# Name from CLI, interactive for template and provider
agent-nuvira init my-app

# Fully non-interactive
agent-nuvira init my-app --template node-api

# List all available templates
agent-nuvira init --list

# Use a custom template from a local directory
agent-nuvira init my-app --template custom --template-dir ~/my-templates
```

**Built-in templates:**

| Template | Description |
|---|---|
| `node-cli` | Node.js CLI app with Commander + TypeScript |
| `ts-library` | TypeScript library with Vitest |
| `node-api` | Express REST API with TypeScript |
| `python-cli` | Python CLI app with Click + Poetry |
| `minimal` | Minimal TypeScript project (1 file) |

The command also generates a `.buffconfig.json` with your chosen provider and model, ready to use immediately.

---

## Docker Compose (5-Minute Onboarding)

Get the full Agent-Nuvira dashboard and CLI running with a single command — no Node.js or TypeScript setup required.

```bash
# Clone and go
cp .env.example .env       # Fill in your API keys
docker compose up           # Build & launch at http://localhost:3030
```

### What you get

- **Dashboard UI** at `http://localhost:3030` — provider health, cost tracking, model benchmarks, memory browser
- **CLI** accessible via `docker compose run --rm agent-nuvira <command>`
- **Persistent data** — config, memory, cache, and history stored in a named volume
- **Health checks** — automatic dashboard status verification

### Examples

```bash
# Quick one-shot commands via Docker
docker compose run --rm agent-nuvira chat "explain recursion in Rust"
docker compose run --rm agent-nuvira models --provider groq
docker compose run --rm agent-nuvira execute "add a health check endpoint"

# With local inference (requires Ollama on host)
docker compose --profile ollama up
```

### Docker Compose Structure

| Feature | Details |
|---|---|
| **Base image** | `node:22-alpine` — slim, secure |
| **Stages** | 3-stage build: TypeScript compile → Vite dashboard → runtime |
| **Layer caching** | Dependency manifests copied before source for cache reuse |
| **Ollama profile** | `--profile ollama` adds an Ollama container; defaults to `host.docker.internal` |
| **Volume** | `agent-nuvira-data` at `/root/.buff` preserves all data |
| **Port** | `3030` mapped to dashboard server |
| **Health** | Node `fetch()` verifies dashboard API every 30s |

### Configuration via Docker

Set API keys in `.env` (see `.env.example`) or pass them as environment variables:

```bash
docker compose run --rm -e GROQ_API_KEY=gsk_xxx agent-nuvira chat "hello"
```

---

## Provider Details

### Local (Ollama)

Uses the **Ollama HTTP API** running at `http://localhost:11434`.

```bash
# Ensure Ollama is running
ollama serve

# Pull a model
ollama pull llama2

# Use with the CLI
agent-nuvira chat --provider local --model llama2
```

**Runners:**

| Runner | Description | Requirements |
|---|---|---|
| `ollama` (default) | Ollama HTTP API | [Ollama](https://ollama.ai) installed and running |
| `huggingface` | HuggingFace Transformers via Python | Python 3, `pip install transformers torch` |
| `ggml` | GGML/GGUF models via llama.cpp | `llama-cli` binary, model file |

Configure the runner:

```bash
agent-nuvira config set providers.local.runner huggingface
agent-nuvira config set providers.local.model "microsoft/phi-2"
```

### Groq

Connects to **Groq** — the fastest inference API for open-source models, running on custom LPU hardware.

```bash
# Set your API key
export GROQ_API_KEY="gsk_..."

# List available models (Llama, Mixtral, Gemma, DeepSeek, and more)
agent-nuvira models --provider groq

# Chat with any model
agent-nuvira chat --provider groq --model llama-3.3-70b-versatile
agent-nuvira chat --provider groq --model deepseek-ai/deepseek-v4-flash

# Edit with Groq's fast inference
agent-nuvira edit src/server.ts --provider groq --model llama-3.3-70b-versatile
```

The Groq adapter uses `https://api.groq.com/openai/v1` by default.

**Get a free API key:** [console.groq.com](https://console.groq.com)

### NVIDIA NIM

Connects to the **NVIDIA NIM** OpenAI-compatible API at `https://integrate.api.nvidia.com/v1`.

```bash
# Set your API key
export NVIDIA_NIM_API_KEY="nvapi-..."

# List available models (121 models)
agent-nuvira models --provider nim

# Chat with any model
agent-nuvira chat --provider nim --model meta/llama-3.1-8b-instruct
agent-nuvira chat --provider nim --model deepseek-ai/deepseek-v4-flash
```

The NIM adapter uses `https://integrate.api.nvidia.com/v1` by default. You can override the base URL for self-hosted NIM deployments:

```bash
agent-nuvira config set providers.nim.baseUrl "http://your-nim-host:8000/v1"
```

### Google Gemini

Connects to the **Google Gemini API** free tier.

```bash
# Set your API key
export GEMINI_API_KEY="AIzaSy..."

# Use it (supports 8K+ token context)
agent-nuvira chat --provider gemini --model gemini-2.0-flash-exp
```

### OpenRouter

Routes through **OpenRouter** for access to 200+ models from multiple providers.

```bash
# Set your API key
export OPENROUTER_API_KEY="sk-or-v1-..."

# List available models
agent-nuvira models --provider openrouter

# Use a specific model
agent-nuvira chat --provider openrouter --model openai/gpt-4o
agent-nuvira chat --provider openrouter --model anthropic/claude-3-haiku
```

---

## Multi-Agent Orchestration (`agent-nuvira execute`)

The `execute` command runs an autonomous multi-agent pipeline that can plan, gather context, write code, review changes, run tests, and publish — all from a single goal.

```bash
# Execute a multi-agent pipeline
agent-nuvira execute "add JWT authentication to the Express app"

# With verbose logging to see each agent's work
agent-nuvira execute "add a health check endpoint" --verbose

# Use a specific provider for all agents
agent-nuvira execute "refactor the database layer" --provider groq

# Dry-run mode (shows what would change without writing)
agent-nuvira execute "add rate limiting" --dry-run

# Configure models per agent type
agent-nuvira execute "add tests" --agent-model planner=gemini --agent-model writer=groq

# Use persistent memory across sessions
agent-nuvira execute "fix the login bug" --memory

# Set a custom context window limit (default: 128,000 tokens)
agent-nuvira execute "refactor large codebase" --context-limit 256000

# Adjust pruning aggressiveness for long chains
agent-nuvira execute "build entire microservice" --context-prune medium
agent-nuvira execute "migrate database schema" --context-prune aggressive
```

**Context pruning flags:**

| Flag | Purpose | Default |
|---|---|---|
| `--context-limit <tokens>` | Max tokens before automatic pruning activates | 128000 |
| `--context-prune <mode>` | Prune aggressiveness: `soft` \| `medium` \| `aggressive` | `soft` |

The pruner automatically compresses the shared agent context between pipeline steps using 5 strategies: metadata stripping, file change collapsing, conversation truncation, artifact summarization, and aggressive fallback.


The pipeline runs these agents in dependency-aware order with parallelization:

| # | Agent | Type | Description |
|---|-------|------|-------------|
| 1 | **Planner** | Core | Analyzes the goal, creates a dependency-aware task plan |
| 2 | **Context Gatherer** | Core | Scans the codebase for relevant files and artifacts |
| 3 | **Security Scanner** | Safety | Scans for PII, prompt injection, and dangerous patterns |
| 4 | **Writer** | Core | Implements the code changes based on plan and context |
| 5 | **Reviewer** | Quality | Validates changes for bugs, security, and code style |
| 6 | **Tester** | Testing | Runs tests in a sandboxed temp directory or Docker container |
| 7 | **Debugger** | Testing | Iteratively diagnoses and fixes test failures via LLM |
| 8 | **Runner** | Execution | Executes shell commands to verify the program works |
| 9 | **MCP Agent** | Integration | Invokes external tools from connected MCP servers |
| 10 | **Skill Runner** | Learning | Executes compiled skill scripts as pre-built task plans |
| 11 | **Git Agent** | Publishing | Creates branches, commits with LLM-generated messages |
| 12 | **PR Description** | Publishing | Generates PR descriptions from git diff via LLM |
| 13 | **Package Agent** | Publishing | Bumps versions, builds, publishes to npm |
| 14 | **GitHub Release** | Publishing | Creates tags, release notes, and GitHub releases |

**Parallel execution:** Independent agents (e.g., Reviewer + Tester) run concurrently via `Promise.all()`. Exclusive agents (Runner, Debugger) get dedicated access. Results are merged with conflict resolution.

**Interactive development mode:** `buff execute` without a goal launches an interactive loop with:
- **Model picker** — Choose your provider/model interactively
- **Session tracking** — Full history of goals executed in the session
- **Failure analysis** — Per-agent-type diagnosis with recovery actions
- **Follow-up suggestions** — LLM-powered contextual next steps
- **/fix** — Retry the last failed goal with failure context
- **/save / /resume** — Save and restore sessions across restarts
- **/suggest** — Search past trajectories for similar goals

---

## Architecture

```
CLI Commands (chat, edit, plan, models, config, cache, execute)
         │
         ▼
   Inference Layer (InferenceProvider interface)
         │
  ┌──────┼──────┬──────────┬─────────────┐
  │      │      │          │             │
  ▼      ▼      ▼          ▼             ▼
 Groq   NIM   Gemini    OpenRouter     Local
Adapter Adapter Adapter   Adapter      Adapter
  │      │      │          │             │
  ▼      ▼      ▼          ▼             ▼
 Groq  NVIDIA Google      OpenRouter  Ollama / HF /
 LPU   NIM   Gemini (free) APIs       GGML Models

         ┌──────────────────────────────┐
         │       Core Pipeline          │
         │  ┌────────────────────────┐  │
         │  │   Orchestrator         │  │
         │         │  │  ├─ Planner             │  │
         │  │  ├─ ContextGatherer    │  │
         │  │  ├─ Writer             │  │
         │  │  ├─ Reviewer           │  │
         │  │  ├─ Tester             │  │
         │  │  ├─ Runner             │  │
         │  │  ├─ Debugger           │  │
         │  │  ├─ GitAgent           │  │
         │  │  ├─ PackageAgent       │  │
         │  │  ├─ GitHubReleaseAgent │  │
         │  │  ├─ SecurityAgent      │  │
         │  │  ├─ SkillRunner        │  │
         │  │  ├─ MCPAgent           │  │
         │  │  └─ PRDescriptionAgent │  │
         │  └────────────────────────┘  │
         │                              │
         │  ┌────────────────────────┐  │
         │  │   Memory System        │  │
         │  │  ├─ Vector Store       │  │
         │  │  ├─ Trajectory/Store   │  │
         │  │  └─ Embedder           │  │
         │  └────────────────────────┘  │
         │                              │
         │  ┌────────────────────────┐  │
         │  │   Self-Learning        │  │
         │  │  ├─ Model Router       │  │
         │  │  ├─ Pattern Extractor  │  │
         │  │  ├─ Scorer             │  │
         │  │  └─ Skill Compiler     │  │
         │  └────────────────────────┘  │
         │                              │
         │  ┌────────────────────────┐  │
         │  │   Context Mgmt         │  │
         │  │  ├─ ContextPruner      │  │
         │  │  ├─ SQLite Cache       │  │
         │  │  ├─ Multi-file Parser  │  │
         │  │  └─ Token Chunking     │  │
         │  └────────────────────────┘  │
         │                              │
         │  ┌────────────────────────┐  │
         │  │   CLI Layer            │  │
         │  │  ├─ buff init          │  │
         │  │  ├─ buff model         │  │
         │  │  └─ buff skill         │  │
         │  └────────────────────────┘  │
         │                              │
         │  ┌────────────────────────┐  │
         │  │   Docker Deployment    │  │
         │  │  └─ docker-compose.yml  │  │
         │  └────────────────────────┘  │
         └──────────────────────────────┘
```

### Website (Marketing Site)

The `website/` directory contains a complete static landing page for Agent-Nuvira (`agent-nuvira.com`):

| File | Purpose |
|---|---|
| `index.html` | Full marketing landing page with hero, features, pipeline visualization, provider cards, quickstart guide, extensions, and comparison table |
| `styles.css` | Complete styling with gradient text, animated particles, responsive grid, and dark theme |
| `script.js` | Interactive elements: scroll animations, copy-to-clipboard, mobile nav toggle, particle system |
| `_redirects` | Netlify/Cloudflare Page redirect rules |
| `_headers` | Custom HTTP security and cache headers |
| `assets/` | Hero images, screenshots, and OG meta assets |

The site is pre-configured for Netlify deployment with zero-configuration.

### Key Modules

| Module | Path | Purpose |
|---|---|---|
| **CLI Router** | `src/cli/router.ts` | Registers commands and resolves providers |
| **Config Manager** | `src/config/manager.ts` | Loads/saves config, merges env vars |
| **Inference Interface** | `src/inference/interface.ts` | `InferenceProvider` contract (`generate`, `isAvailable`, `getInfo`, `listModels`) |
| **Provider Factory** | `src/inference/factory.ts` | Instantiates the right adapter |
| **Adapters** | `src/inference/*-adapter.ts` | One per provider (Groq, NIM, Gemini, OpenRouter, Local) |
| **Model Discovery** | `src/cli/models.ts` | Lists and searches models from all providers |
| **Model Switch** | `src/cli/model.ts` | Context-preserving provider/model switching |
| **Project Scaffold** | `src/cli/init.ts` | Interactive project scaffolding with templates |
| **Skill Commands** | `src/cli/skill.ts` | List, compile, search, and run skill scripts |
| **Orchestrator** | `src/agents/orchestrator.ts` | Multi-agent pipeline coordinator (with context pruning) |
| **Context Cache** | `src/context/cache.ts` | SQLite-backed response caching |
| **Context Parser** | `src/context/parser.ts` | Multi-file reading, chunking, prioritization |
| **Context Pruner** | `src/learning/context-pruner.ts` | Token-aware context compression for long agent chains |
| **Skill Compiler** | `src/learning/skill-compiler.ts` | LLM-powered extraction of reusable patterns from trajectories |
| **Skill Store** | `src/learning/skill-store.ts` | Persistent skill storage with decay scoring |
| **Skill Runner Agent** | `src/agents/agents/skill-runner.ts` | Injects skill steps into the execution plan |
| **Plugin Registry** | `src/plugins/registry.ts` | Pluggable third-party provider system |
| **Logger** | `src/utils/logger.ts` | Colored, level-based logging |

---

## Workflow Examples

### Discover and Chat with a Model

```bash
# Step 1: See what's available on Groq
agent-nuvira models --provider groq

# Step 2: Narrow down by keyword
agent-nuvira models --search deepseek

# Step 3: Chat with a found model
agent-nuvira chat --provider groq --model deepseek-ai/deepseek-v4-flash
```

### Hybrid Provider Usage

Use different providers for different tasks:

```bash
# Use local models for quick, small edits
agent-nuvira edit README.md --instruction "fix typos" --provider local

# Use Groq for fast code generation
agent-nuvira edit src/routes.ts --instruction "add validation" --provider groq

# Use cloud models for complex planning
agent-nuvira plan . --task "design the database schema" --provider gemini

# Use OpenRouter for diverse model selection
agent-nuvira chat --provider openrouter --model openai/gpt-4o
```

### Multi-Agent Pipeline

```bash
# Let the multi-agent system handle everything
agent-nuvira execute "add input validation for all API routes"

# With verbose logging to see each step
agent-nuvira execute "create a health check endpoint" --verbose

# Use Groq for fast agent execution
agent-nuvira execute "refactor login logic" --provider groq
```

---

## Plugin System: Adding a New Provider

The plugin system allows you to add custom inference providers without modifying the CLI's core code.

### Step 1: Implement `InferenceProvider`

Create a class that implements the `InferenceProvider` interface:

```typescript
import { InferenceProvider } from 'agent-nuvira';
import { InferenceOptions, ProviderConfig } from 'agent-nuvira';

export class AnthropicAdapter implements InferenceProvider {
  readonly name = 'Anthropic';
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async generate(prompt: string, options?: InferenceOptions): Promise<string> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new Error('Anthropic API key not configured');
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options?.model || 'claude-3-haiku-20240307',
        max_tokens: options?.maxTokens || 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    return data.content[0].text;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.config.apiKey;
  }

  getInfo(): string {
    return `Provider: Anthropic Claude\nModel: ${this.config.model || 'default'}\nStatus: ${this.config.apiKey ? '✅' : '❌'}`;
  }

  async listModels(): Promise<Array<{ id: string; name: string; provider: string; owner?: string; description?: string }>> {
    if (!this.config.apiKey) return [];
    // Fetch models from Anthropic API
    return [{ id: 'claude-3-haiku-20240307', name: 'claude-3-haiku-20240307', provider: 'Anthropic' }];
  }
}
```

### Step 2: Create a Plugin Wrapper

```typescript
import { ProviderPlugin, ProviderConfig, PluginMetadata } from 'agent-nuvira';
import { AnthropicAdapter } from './anthropic-adapter';

export const AnthropicPlugin: ProviderPlugin = {
  metadata: {
    name: 'Anthropic Claude',
    version: '1.0.0',
    description: 'Anthropic Claude API integration',
    author: 'You',
  },

  getProviderType(): string {
    return 'anthropic';
  },

  createProvider(config: ProviderConfig): AnthropicAdapter {
    return new AnthropicAdapter(config);
  },
};
```

### Step 3: Register the Plugin

At your application's entry point:

```typescript
import { getPluginRegistry } from 'agent-nuvira';
import { AnthropicPlugin } from './anthropic-plugin';

const registry = getPluginRegistry();
registry.register(AnthropicPlugin);
```

### Step 4: Configure and Use

Add the provider to your `buffconfig.json`:

```json
{
  "defaultProvider": "anthropic",
  "providers": {
    "anthropic": {
      "apiKey": "sk-ant-...",
      "model": "claude-3-haiku-20240307",
      "temperature": 0.7,
      "maxTokens": 4096
    }
  }
}
```

Then use it:

```bash
agent-nuvira chat --provider anthropic
```

> **Note:** Plugins placed in `~/.buff/plugins/` are **auto-discovered** at CLI startup — no manual registration required. Programmatic registration via the Plugin Registry API is also supported for advanced use cases.

---

## Development

### Setup

```bash
git clone https://github.com/imdheerajKube/agent-nuvira.git
cd buff
npm install
```

### Build

```bash
npm run build          # Compile TypeScript to dist/
npm run dev            # Build and run with tsx (fast)
```

### Project Structure

```
src/
├── index.ts              # Entry point & public exports
├── cli/
│   ├── router.ts         # Command registration & provider resolution
│   ├── commands.ts       # Base command class
│   ├── chat.ts           # Interactive chat
│   ├── edit.ts           # File editing
│   ├── models.ts         # Model discovery (list/search models)
│   ├── model.ts          # Context-preserving model switching
│   ├── skill.ts          # Skill compilation & execution
│   ├── init.ts           # Project scaffolding
│   ├── plan.ts           # Implementation plans
│   ├── config.ts         # Configuration management
│   ├── execute.ts        # Multi-agent orchestration (with context pruning)
│   └── cache.ts          # Cache management
├── agents/
│   ├── agent.ts          # Abstract Agent + types
│   ├── orchestrator.ts   # Multi-agent pipeline coordinator
│   ├── context-vault.ts  # Shared context bus
│   └── agents/
│       ├── planner.ts       # PlannerAgent
│       ├── context-gatherer.ts
│       ├── writer.ts        # WriterAgent
│       ├── reviewer.ts      # ReviewerAgent
│       ├── runner.ts        # RunnerAgent
│       ├── tester.ts        # TesterAgent
│       ├── debugger.ts      # DebuggerAgent
│       ├── skill-runner.ts  # SkillRunnerAgent (injects skill steps)
│       ├── git-agent.ts
│       ├── package-agent.ts
│       ├── github-release-agent.ts
│       └── security-agent.ts
├── config/
│   ├── types.ts          # TypeScript types
│   └── manager.ts        # Config load/save/env merging
├── inference/
│   ├── interface.ts      # InferenceProvider contract
│   ├── factory.ts        # Provider instantiation
│   ├── sse.ts            # Server-sent events streaming
│   ├── groq-adapter.ts   # Groq LPU
│   ├── nim-adapter.ts    # NVIDIA NIM
│   ├── gemini-adapter.ts # Google Gemini
│   ├── openrouter-adapter.ts # OpenRouter
│   └── local-adapter.ts  # Ollama / HuggingFace / GGML
├── context/
│   ├── cache.ts          # SQLite response cache
│   ├── parser.ts         # Multi-file context parsing
│   └── history.ts        # Chat history persistence
├── plugins/
│   └── registry.ts       # Plugin registration system
├── learning/
│   ├── skill-compiler.ts # LLM-powered skill extraction from trajectories
│   ├── skill-store.ts    # Persistent skill storage with decay scoring
│   ├── skill-types.ts    # Skill type definitions
│   ├── context-pruner.ts # Token-aware context compression
│   ├── model-router.ts   # Adaptive model routing
│   ├── scorer.ts         # Trajectory scoring
│   ├── pattern-extractor.ts
│   ├── agent-stats.ts
│   └── self-improver.ts
├── memory/
│   ├── embedder.ts       # LLM-based embeddings
│   ├── vector-store.ts   # Cosine similarity search
│   ├── trajectory-store.ts
│   └── memory-integration.ts
├── security/
│   └── scanner.ts        # Prompt injection / secret scanner
└── utils/
    ├── env.ts            # Environment variable loader
    └── logger.ts         # Colored logging
```

### Testing

```bash
# Run all tests (3,002 tests across 98 test files)
# Plus 6 dashboard component tests (src/web-dashboard)
npm test

# Watch mode
npm run test:watch

# With coverage
npm run test:coverage

# Type-check without emitting files
npx tsc --noEmit
```

---

## Roadmap

**Phases 1–11 are complete** — from Foundation (Phase 0) through TS Compiler API-Aware Structural Editing (Phase 11). See [UPGRADE_ROADMAP.md](./UPGRADE_ROADMAP.md) for the full implementation journey.

> 📊 **Architecture, strategy & contribution materials:** [ARCHITECTURE.md](./ARCHITECTURE.md) — Modular execution engine design with 7 module specifications, extensibility/observability systems, and phased migration plan. [ARCHITECTURE_DIAGRAMS.md](./ARCHITECTURE_DIAGRAMS.md) — Mermaid-rendered versions of all architecture diagrams (Module Architecture, Extensibility, Safe Execution, Data Flow, Observability Bus). [PRODUCT_STRATEGY.md](./PRODUCT_STRATEGY.md) — Competitive landscape, positioning map, OKR framework, and risk register. [PITCH_DECK.md](./PITCH_DECK.md) — 10-slide investor presentation outline with talking points and data. [CONTRIBUTING.md](./CONTRIBUTING.md) — Quick-reference contributor guide with docs map, dev setup, and contribution workflow.

| Phase | Feature | Status |
|---|---|---|
| **Phase 1: Quick Wins** | | |
| 1.1 | Auto-discovery plugin loader — drop `.js` into `~/.buff/plugins/` | ✅ Complete |
| 1.2 | Complete streaming support — all 17+ providers | ✅ Complete |
| 1.3 | Cost tracking — per-provider/session/monthly | ✅ Complete |
| 1.4 | `buff init` — interactive project scaffolding | ✅ Complete |
| 1.5 | Prompt history search — keyword + semantic | ✅ Complete |
| 1.6 | Skill compiler — auto-extract reusable patterns from trajectories | ✅ Complete |
| 1.7 | Context-window memory pruner — prevent OOM in long chains | ✅ Complete |
| 1.8 | Context-preserving model switching — mid-session provider changes | ✅ Complete |
| **Phase 2: Structural Changes** | | |
| 2.1 | Native embedding support — 3-tier embedder (Xenova/Python/LLM) | ✅ Complete |
| 2.2 | Workflow template marketplace — 10 templates + registry | ✅ Complete |
| 2.3 | Model benchmarking — 21 tasks, scoring, A/B comparison | ✅ Complete |
| 2.4 | Docker sandbox isolation — resource limits, network isolation, 8 images | ✅ Complete |
| 2.5 | Provider health dashboard — `buff doctor` | ✅ Complete |
| 2.6 | Memory compression & pruning — trajectory summarization | ✅ Complete |
| **Phase 3: Major Upgrades** | | |
| 3.1 | VS Code extension — 9 commands, inline suggestions, diff viewer, agent progress panel | ✅ Complete |
| 3.2 | **B1: Chat Panel** — Multi-turn chat with streaming, 6 slash commands, session history, file context | ✅ Complete (v1.33.0) |
| 3.3 | **B3: Diagnostic → AI Fix** — "Fix with Agent-Nuvira" in lightbulb menu on red squiggles | ✅ Complete (v1.33.0) |
| 3.4 | **B5: Code Lens Actions** — Test/Review/Explain/Fix actions above functions and classes | ✅ Complete (v1.34.0) |
| 3.5 | Remote agent federation — multi-machine collaboration | ✅ Complete |
| 3.3 | Web UI dashboard — React + Recharts + DAG visualization | ✅ Complete |
| 3.4 | Hybrid model routing — complexity-based model selection | ✅ Complete |
| 3.5 | Team collaboration — shared config, memory, and review pipelines | ✅ Complete |
| 3.6 | Agent SDK — `@agent-nuvira/sdk` npm package + scaffolding | ✅ Complete |
| 3.7 | Provider CLI (`buff provider list/health`) | ✅ Complete |
| 3.8 | Provider fallback routing — auto-failover with circuit breaker | ✅ Complete |
| 3.9 | Security scan CLI (`buff security scan`) | ✅ Complete |
| 3.10 | Feedback & rating system (`buff feedback`) | ✅ Complete |
| 3.11 | Marketplace unified CLI (`buff marketplace browse/search/install`) | ✅ Complete |
| **Phase 4: Industry Standards** | | |
| 4.1 | MCP (Model Context Protocol) — client/manager/CLI with SSE transport + Firecrawl | ✅ Complete |
| 4.2 | AST-aware code editing — structural analysis engine (JS/TS/Python/Go/Rust) | ✅ Complete |
| 4.3 | Auto error-repair engine — diagnosis & retry budgets for test failures | ✅ Complete |
| 4.4 | A2A (Agent-to-Agent) Protocol — inter-agent communication standard | ✅ Complete |
| 4.5 | CI/CD headless mode — `buff ci` with GitHub Actions integration | ✅ Complete |
| 4.6 | npm publishing & one-line install — `npx agent-nuvira` / `npx buff` | ✅ Complete |
| **Phase 5: Interactive UX** | | |
| 5.1 | Interactive dev mode — guided loop with model picker, session save/resume | ✅ Complete |
| 5.2 | Failure analysis — per-agent-type diagnosis with recovery actions | ✅ Complete |
| 5.3 | Follow-up suggestions — LLM-powered contextual next-step recommendations | ✅ Complete |
| 5.4 | /fix command — retry last failed goal with failure context | ✅ Complete |
| 5.5 | Test coverage — 3,002 tests across 98 test files (+6 dashboard component tests) | ✅ Complete |
| **Phase 6: Architecture Migration** | | |
| 6.1 | RecoverModule — extracted from ErrorRepairEngine with RepairBudget | ✅ Complete (v1.18.0) |
| 6.2 | ModuleRegistry — plugin-based agent loading replacing createAgent() | ✅ Complete (v1.18.0) |
| 6.3 | EventBus — structured observability with 37+ typed events | ✅ Complete (v1.19.0) |
| 6.4 | ReportModule — 4 output formats (text/JSON/MD/GHA) | ✅ Complete (v1.20.0) |
| 6.5 | InspectModule — keyword + LLM codebase scanning | ✅ Complete (v1.20.0) |
| 6.6 | VerifyModule — security scan + explicit verification pipeline | ✅ Complete (v1.21.0) |
| 6.7 | PlanModule + EditModule — goal decomposition + file change generation | ✅ Complete (v1.22.0) |
| 6.8 | ExecuteModule + TestModule — command execution + sandboxed testing | ✅ Complete (v1.23.0) |
| **Phase 9: Safe Execution Layer** | | |
| 9.1 | SafeExecutionLayer — file validation, Docker sandbox, safe LLM calls, EventBus integration | ✅ Complete (v1.26.0) |
| 9.2 | VerifyModule EventBus tests — 9 emission tests for SAFE_EXEC_* events | ✅ Complete (v1.26.0) |
| **Phase 10: Autonomous Publish** | | |
| 10.1 | CredentialStore — interactive Git/npm credential collection, GIT_ASKPASS, SSH agent, .npmrc injection | ✅ Complete (v1.29.0) |
| 10.2 | PhaseExecutionEngine — multi-goal project scopes with save/resume across restarts | ✅ Complete (v1.29.0) |
| 10.3 | `buff publish` — 5-phase pipeline: tests → version → git → npm → GitHub release | ✅ Complete (v1.29.0) |
| 10.4 | `buff phase` — create/execute/resume/status/list scopes with credential management | ✅ Complete (v1.29.0) |
| **Phase 11: TS Compiler API-Aware Structural Editing** | | |
| 11.1 | TS Compiler API Wrapper (`ts-adapter.ts`) — parse, find nodes, validate syntax via real TS parser | ✅ Complete (v1.31.0) |
| 11.2 | Structural Transformations (`transform.ts`) — rename, extract, inline, add param, change signature | ✅ Complete (v1.31.0) |
| 11.3 | Two-Tier Editing Engine (`edit.ts` rewrite) — TS API-first, regex fallback for all 7 operations | ✅ Complete (v1.31.0) |
| 11.4 | Phase 11 Tests — 66 tests (40 ts-adapter + 26 transform), all passing | ✅ Complete (v1.31.0) |

---

## Version History

| Version | Date | Key Changes |
|---------|------|-------------|
| **v1.0.0** | Apr 2026 | Initial release — Core CLI with chat, 5 built-in providers (expandable to 17+ via plugins), config, models |
| **v1.1.0** | Apr 2026 | Model discovery with search/filter |
| **v1.2.0** | Apr 2026 | AI-assisted file editing (edit command) |
| **v1.3.0** | May 2026 | Implementation plans (plan command) |
| **v1.4.0** | May 2026 | Multi-agent pipeline (execute command) with Planner, Writer, ContextGatherer |
| **v1.5.0** | May 2026 | Additional agents — Tester, Runner, Debugger |
| **v1.6.0** | Jun 2026 | Agent retry logic, format validation, git integration |
| **v1.7.0** | Jun 2026 | Phase 1 features — plugin system, cost tracking, logging |
| **v1.8.0** | Jun 2026 | Native embeddings, vector store, trajectory memory |
| **v1.9.0** | Jul 2026 | Workflow templates, model benchmarking |
| **v1.10.0** | Jul 2026 | Docker sandbox, provider health dashboard |
| **v1.11.0** | Jul 2026 | Skill compiler, context pruner, model switching |
| **v1.12.0** | Jul 2026 | VS Code extension, web dashboard, agent federation |
| **v1.13.0** | Jul 2026 | Hybrid model routing, team collaboration, Agent SDK |
| **v1.14.0** | Jul 2026 | Provider fallback, security scan, feedback system, marketplace CLI |
| **v1.14.6** | Jul 2026 | Skill compiler system, context-window pruner, Docker Compose onboarding |
| **v1.15.0** | Aug 2026 | npm publishing — `npx buff` / `npx agent-nuvira` live on npm (1.3 MB) |
| **v1.15.1** | Aug 2026 | Interactive dev mode — model picker, session tracking, /save / /resume, /suggest |
| **v1.15.2** | Aug 2026 | Windows compatibility fixes |
| **v1.15.3** | Aug 2026 | Accessibility fix — `window.open` → native `<a>` tags |
| **v1.15.4** | Aug 2026 | Search/filter bar, column count toggle, speech provider section |
| **v1.15.5** | Aug 2026 | SSE header support for MCP |
| **v1.15.6** | Aug 2026 | Firecrawl integration for web search |
| **v1.16.0** | Aug 2026 | Comprehensive MCP README docs, SSE header support |
| **v1.16.1** | Aug 2026 | Interactive dev mode enhancements — failure analysis, follow-up suggestions, /fix command, 35 new unit tests |
| **v1.26.0** | Aug 2026 | Phase 9 — SafeExecutionLayer module (file validation, Docker sandbox, safe LLM calls) + 32 new tests (23 SafeExec + 9 Verify Bus) |
| **v1.27.0** | Aug 2026 | Website + SVG — Phase 9 SafeExecutionLayer, phase progress 9/9, 2,207 tests |
| **v1.29.0** | Sep 2026 | Phase 10 — Autonomous publish + phase-wise execution (CredentialStore, PhaseEngine, `buff publish`, `buff phase`, git push, npm auth) + 86 new tests |
| **v1.30.0** | Sep 2026 | Phase 10 tests + docs — 80 unit tests (CredentialStore + PhaseExecutionEngine), README/Product_Guide/website updated with Phase 10 progress |
| **v1.31.0** | Sep 2026 | Phase 11 — TS Compiler API-Aware Structural Editing (ts-adapter.ts, transform.ts, edit.ts rewrite, 66 new tests), proper parser-level accuracy for TS/JS edits |
| **v1.32.0** | Oct 2026 | Pillar A — GitLab Agent (MRs, issues, pipelines) + PR Review Agent (inline review, security scans) + website Git & PR section |
| **v1.33.0** | Oct 2026 | Pillar B1+B3 — VS Code Chat Panel with streaming, slash commands, session history + Diagnostic → AI Fix from lightbulb menu |
| **v1.34.0** | Oct 2026 | Pillar B5 — VS Code Code Lens actions (Test/Review/Explain/Fix) via quick pick menu above functions and classes |
| **v1.42.0** | Aug 2026 | Learning-router escalation + per-model bandit priors + Promotion Gate (ruflo ADR-149/150 mirrors) |
| **v1.43.0** | Aug 2026 | Startup progress feedback + Auto-mode session failover on token expiry |
| **v1.44.0** | Aug 2026 | Central quota ledger, per-subtask complexity labels, free/local-first gate |
| **v1.45.0** | Aug 2026 | Checkpoint/resume pipelines + quota cost-transparency card |
| **v1.45.5** | Aug 2026 | Opt-in Auto failover confirmation (interactive + one-shot) |
| **v1.46.0** | Aug 2026 | Always-on dashboard quota watcher |
| **v1.47.0** | Aug 2026 | Vector retrieval — token-efficient context via local embeddings + pure-JS vector store |
| **v1.48.0** | Aug 2026 | FAISS-style vector search backend — pluggable `VectorStore` (pure-JS IVF-flat ANN + optional native tier) |
| **v1.49.0** | Aug 2026 | Hermetic memory tests, IVF-vs-exact recall/latency benchmark, cross-session backend transparency |
| **v1.49.1** | Aug 2026 | Native FAISS tier actually activates — rewritten for the real `@faiss-node/native` v0.1.11 API; `buff memory backend --check` |
| **v1.50.0** | Aug 2026 | `buff memory backend --check` diagnostics — active backend, why it was chosen, native-FAISS availability probe + install guidance |
| **v1.51.0** | Aug 2026 | Routing strategy super-enhancement — Thompson-sampling bandit, uncertainty escalation, per-model learning, promotion gate A/B, routing rules, hard constraints, credential-aware filtering, quota-ledger integration, runtime stats blending, verification escalation, free/local-first gate; 2,934 tests |
| **v1.51.1** | Aug 2026 | Docs patch — completed the published README version-history table (added v1.50.0 + v1.51.0 rows) |
| **v1.52.0** | Aug 2026 | Predictive model-availability routing (registry drives every pick — dead/unkeyed providers skipped before scoring, no more wasted first calls); web dashboard: scrubbable pipeline phase timeline + narrated "why did the router pick this?" walkthrough; 2,990 tests |
| **v1.53.0** | Aug 2026 | Per-action "learned from real usage" telemetry everywhere (chat/execute/plan/edit/skill/learn/ci/doctor all write the registry; dashboard panel + `models status --verbose` show who killed/verified what); daily timeline chart in the dashboard; recovery loop (a later real success un-parks + re-verifies a recovered provider); hermetic E2E failover test (`tests/e2e/`) proving "registry learns the block, next pick skips it"; 2,996 tests |
| **v1.54.0** | Aug 2026 | VS Code extension telemetry attribution — the extension tags every IDE-driven LLM call with `BUFF_TELEMETRY_ACTION` (`ide-chat` / `ide-inline` / `ide-<command>`) so IDE usage gets its own rows in the per-action "learned from real usage" registry log + dashboard panel; 3,002 tests |
| **v1.55.0** | Aug 2026 | `buff models unblock <provider>` escape hatch — manually release a registry-blocked provider (demote unavailable→unverified, clear quota parks + ledger cooldown, live re-probe with honest `stillBlocked`); also fixed the pre-existing `models status --json` / `refresh --json` flag-shadowing bug; 3,011 tests |
| **v1.59.4** | Aug 2026 | P6 M6.6 Software Bill of Materials: `buff sbom` (CycloneDX 1.5 from lockfile, `--reproducible` pins), `sbom verify` (drift/tamper), `sbom licenses` (copyleft/unknown audit), `doctor --enterprise` Supply Chain check; 3,313 tests |
| **v1.59.5** | Aug 2026 | Dashboard surfaces mid-stream flakiness end-to-end: violet `⏸ flaky N%` chips on registry rows (mirroring the CLI's `model explain` chip), `⏸ N flaky` provider badges, and a **Flaky mid-stream** stats card — the exact signal `routing.partialFlakiness` uses to deprioritize providers; 3,313 root tests |
| **v1.59.7** | Aug 2026 | P6 M6.1 **RBAC** — `buff admin role add/remove/list` + `whoami` (admin/operator/viewer permission matrix over the admin surface; OIDC adapter interface; legacy single-user stays permissive until roles assigned) + dashboard **governance policy card** (live `routing.governance.*`) + CLI **flakiness trend tags** (`healing`/`worsening` in `models status`); 3,348 root tests |
| **v1.59.6** | Aug 2026 | P6 M6.5 **Admin governance API** (`buff admin policy/allow/deny/allow-model/deny-model/max-cost/pii-min/unblock/clear` over the M2.4 policy) + dashboard **flakiness healing sparklines** (per-entry `partialHistory` trajectory, never hard-wiped) + Requests panel `⏸ N` partial chips (partials excluded from error rate); 3,328 root tests |
| **v1.59.3** | Aug 2026 | `config set routing.<gate>` now accepts the boolean soft-signal keys (`capabilityFit`, `contextFit`, `partialFlakiness`); 3,286 tests |
| **v1.59.2** | Aug 2026 | P4 M4.4 partial flakiness now feeds the ROUTER: registry `partialRate` EMA (bumped by mid-stream interruptions, healed by clean successes, never flips status) → reliability penalty (capped 40%) gated by `routing.partialFlakiness` (default ON) + transparent `⏸ flaky` chip in `models explain`; 3,284 tests |
| **v1.59.1** | Aug 2026 | Dashboard: P4 M4.4 partial mid-stream interruption chips surface end-to-end (violet `⏸` timeline segment, day chips with streamed-chunk tooltip, per-action Partial section + stat); 3,276 tests |
| **v1.59.0** | Aug 2026 | P6 Enterprise Hardening begins: M6.2 secret-redaction scrubber (every log + audit line scrubbed; `BUFF_NO_REDACT` debug escape) + M6.3 tamper-evident SHA-256 hash-chained audit (`buff audit verify/export`, sidecar head state, legacy-compat) — `doctor --enterprise` audit checks now detect tampering with the exact line; 3,275 tests |
| **v1.58.9** | Aug 2026 | P7 M7.4 opt-in gateway telemetry/usage-health flags (`routing.gatewayTelemetry.enabled` + `healthFlags`, OFF by default, privacy-safe — aggregates only, never prompt content) surfaced via `doctor --enterprise`; 3,232 tests |
| **v1.58.8** | Aug 2026 | **Permanent fix for the persistent dashboard "server unreachable / Failed to fetch" issue** — server now binds BOTH IPv4 + IPv6 loopback (macOS resolves `localhost` → ::1 first), CLI opens deterministic 127.0.0.1 |
| **v1.58.7** | Aug 2026 | M4.4 conservative compression (lossless-for-code, off by default) + `partial` mid-stream telemetry + `buff doctor --enterprise` self-check (gateway, secrets, audit, RBAC) + upgrade guide (P7 M7.2) |
| **v1.58.6** | Aug 2026 | Fixed `routing.*` config never surviving a reload — `loadConfig` now merges the routing section (bandit/quota/governance/contextWindows/nuviraSidecar), so `buff config set routing.*` persists across restarts (regression test) |
| **v1.58.5** | Aug 2026 | P5 config-key support — `buff config set routing.nuviraSidecar.enabled\|image` (additive M5.4 keys; 2 new config tests) |
| **v1.58.4** | Aug 2026 | Nuvira-Router **P5 sidecar** (docker-compose.nuvira.yml profile + `buff doctor --nuvira` probe; nuvira joins the auto-router provider universe with a neutral profile; keyless gateways supported) + **P4 resilience core** (mid-stream continuation retry — buffered tokens + bounded continue-note on chat auto-failover, reasoning-replay cache with SSE `reasoning_content` capture, context-relay summaries); 3,300+ tests |
| **v1.58.3** | Aug 2026 | Nuvira-Router P3: dashboard **Requests panel** (per provider×model×action request stats — failures, avg/p50/p95/p99 latency, measured spend from the cost ledger) + **`models explain --since <ref>` decision diff** (before→after candidate score changes, winner changes); 3,161+ tests + 54 dashboard component tests |
| **v1.58.2** | Aug 2026 | Models dashboard "Failed to fetch" repeat fix — the panel fetch is now resilient: per-fetch timeouts, independent health/registry fetches (one failing never hides the other), auto-retry with backoff on transient network failures, and fast self-healing re-poll after a failure (no more stuck error banner); 3,161 tests + 48 dashboard component tests |
| **v1.58.1** | Aug 2026 | Dashboard mirrors the CLI `model explain` guarantees — the Auto Router panel renders the M2.x chips (🎯 fit / 📏 measured·📐 estimated / ⏳ ctx) on every provider row, served by `/api/routing` + `/api/all`; docs sync (`MODELS_EXPLAIN_DEMO.md` dashboard section); 3,161 tests + 45 dashboard component tests |
| **v1.58.0** | Aug 2026 | Nuvira-Router P2: capability-aware scoring (`routing.capabilityFit` gate), wire-token measured-cost inputs (real `usage` tokens beat the 2,000/500 estimate; `models explain` shows 📏 measured vs 📐 estimated), multi-account key rotation (multiple `apiKeys` per provider, dead accounts parked + skipped, `tests/e2e/key-rotation`), governance constraints (`routing.governance` — provider/model allow-allow & deny lists, admin per-call max-cost cap, PII-domain block; hard policy violations refuse to serve with `PIIPolicyError`/`GovernancePolicyError`), context-length preflight (`routing.contextFit` — nominal window vs estimated payload, `⏳ ctx N%` chip in `models explain`); also ships the dashboard `--force` + `--port` fixes previously staged as v1.57.0 (never published); 3,159 tests + 42 dashboard component tests |
| **v1.57.0** | Aug 2026 | `buff dashboard --force` — detect a STALE dashboard on the port (API/SSE mismatch: /api/model-registry answers SPA HTML instead of JSON) and offer to restart it: probe classifies port state (current dashboards and non-dashboard processes are never touched), confirms, finds the PID, kills it, waits for the port to free, and re-binds a fresh server; also fixed the pre-existing `--port` bug — the server bound the import-time 3030 default, now it resolves the bind at call time from explicit overrides; 3,032 tests + 42 dashboard component tests |
| **v1.56.1** | Aug 2026 | Dashboard Models-panel crash fix — "Failed to execute 'json' on 'Response': Unexpected token '<'" when a stale dashboard server returns SPA HTML for an unknown /api/* route: unknown /api/* now returns a JSON 404, all /api/* responses parse through a shared defensive helper (Content-Type check + try/catch, optional sections degrade to hidden), and `buff dashboard` logs a clear EADDRINUSE message instead of crashing; 3,011 tests + 42 dashboard component tests |
| **v1.56.0** | Aug 2026 | Dashboard per-action telemetry timeline is now scrubbable — drag across days, click a day, or use the range slider to see that day's exact verified/killed chips (which provider × model each action killed or verified), with ▶ play/pause day-by-day sweep; timeline day buckets carry deduped raw events end-to-end; 3,011 tests + 39 dashboard component tests |

---

## Phase-Wise Feature Summary

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
| **VS Code Extension** | Chat Panel (streaming, slash commands), Diagnostic→AI Fix, Code Lens actions, 9 commands, inline suggestions, diff viewer, agent progress panel |
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
| **Graceful Error Recovery** | Rate-limit handling, auth failures, and network error recovery |

### Phase 6: Architecture Migration — Modular Plugin Architecture
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
| **CredentialStore (Phase 10)** | Interactive Git/npm credential collection — auto-detection from env vars (GITHUB_TOKEN, GH_TOKEN, NPM_TOKEN), GIT_ASKPASS setup for HTTPS auth, SSH agent integration with passphrase support, .npmrc token injection |
| **PhaseExecutionEngine (Phase 10)** | Multi-goal project scope execution — sequential phase execution with save/resume across restarts, credential management, progress tracking |
| **`buff publish` (Phase 10)** | Autonomous 5-phase publish pipeline — test verification → version bump → git commit/tag/push → npm build/publish → GitHub release |
| **`buff phase` (Phase 10)** | Phase-wise project execution CLI — create/execute/resume/status/list/delete scopes with interactive pauses and credential collection |
| **TS Compiler API Wrapper (Phase 11)** | Proper TypeScript Compiler API integration — parser-level accuracy with parseSourceFile, findStructuralNodes, validateTSSyntax, replaceNodeText, and insertAt |
| **Structural Transformations (Phase 11)** | Real code transformations — renameSymbol, extractFunction, inlineFunction, addParameter, changeSignature with NLP-based detection |
| **Two-Tier Editing Engine (Phase 11)** | All 7 edit operations try TS Compiler API first (for TS/JS), fall back to regex (for Python/Go/Rust) — AST-aware `tryFindNodeTS()` helper |

### Agent Catalog — 15 Agent Roles & Management
| Agent/Component | Type | Description |
|-----------------|------|-------------|
| **PlannerAgent** | Core | Analyzes goals, creates dependency-aware task plans |
| **ContextGathererAgent** | Core | Scans codebase, identifies relevant files and artifacts |
| **WriterAgent** | Core | Implements code changes based on plan and gathered context |
| **ReviewerAgent** | Core | Validates changes for bugs, security, and style |
| **RunnerAgent** | Execution | Executes shell commands and captures output |
| **TesterAgent** | Testing | Runs tests in sandboxed temp directory or Docker container |
| **DebuggerAgent** | Testing | Iteratively diagnoses and fixes test failures via LLM |
| **GitAgent** | Publishing | Creates branches, commits with LLM messages, generates PR descriptions |
| **PackageAgent** | Publishing | Bumps version, builds, publishes to npm, generates changelogs |
| **GitHubReleaseAgent** | Publishing | Creates tags, release notes, and GitHub releases via `gh` CLI or API |
| **SecurityAgent** | Safety | Scans for PII, prompt injection, and dangerous code patterns |
| **SkillRunnerAgent** | Learning | Executes compiled skill scripts as pre-built task plans |
| **MCPAgent** | Integration | Invokes MCP tools from connected servers via stdio or SSE transport |
| **Orchestrator** | Management | Coordinates all agents with dependency-aware scheduling, parallel execution, context pruning, and interactive recovery |

## License

MIT
