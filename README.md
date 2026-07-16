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

## Features

- **Unified interface** across 5 providers: local (Ollama, HuggingFace, GGML), Groq, NVIDIA NIM, Google Gemini, and OpenRouter
- **Model discovery** — `agent-nuvira models` lists available models from any configured provider, with search/filter support
- **Interactive chat** with conversation history, file context, and session commands
- **AI-assisted file editing** with dry-run mode for safe previews
- **Codebase planning** that analyzes directory structure and generates implementation plans
- **Multi-agent orchestration** — `agent-nuvira execute "goal"` runs a pipeline of planner, gatherer, writer, reviewer, tester, and more
- **Response caching** via SQLite to reduce costs and latency
- **Plugin system** for adding custom inference providers
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
  chat [options] [prompt]  Start an interactive chat session with AI
  edit [options] <file>    Edit a file using AI assistance
  models [options]         List available models from inference providers
  plan [options] [target]  Generate an implementation plan for a codebase task
  execute [options] <goal> Execute a multi-agent pipeline for a goal
  config                   Manage Buff configuration
  cache                    Manage inference cache
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
```

The pipeline runs these agents in sequence (with parallelization where possible):
1. **Planner** — Analyzes the goal, creates a task plan
2. **Context Gatherer** — Scans the codebase for relevant files
3. **Writer** — Implements the code changes
4. **Reviewer** — Validates the changes for bugs and style (optional)
5. **Tester** — Runs tests in a sandbox (optional)
6. **Runner** — Executes the program to verify it works (optional)
7. **Debugger** — Iterates on test failures (optional)
8. **Git Agent** — Commits changes to a branch (optional)
9. **Package Agent** — Bumps versions and generates changelogs (optional)
10. **GitHub Release Agent** — Creates tags and releases (optional)

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

         ┌──────────────────────────┐
         │   Multi-Agent System     │
         │  ┌────────────────────┐  │
         │  │  Orchestrator      │  │
         │  │  ├─ Planner       │  │
         │  │  ├─ ContextGather │  │
         │  │  ├─ Writer        │  │
         │  │  ├─ Reviewer      │  │
         │  │  ├─ Tester        │  │
         │  │  ├─ Runner        │  │
         │  │  ├─ Debugger      │  │
         │  │  └─ GitAgent      │  │
         │  └────────────────────┘  │
         │                          │
         │  ┌────────────────────┐  │
         │  │  Memory System     │  │
         │  │  ├─ Vector Store   │  │
         │  │  ├─ Trajectory     │  │
         │  │  └─ Embedder      │  │
         │  └────────────────────┘  │
         │                          │
         │  ┌────────────────────┐  │
         │  │  Self-Learning     │  │
         │  │  ├─ Model Router   │  │
         │  │  ├─ Pattern Extr.  │  │
         │  │  └─ Scorer        │  │
         │  └────────────────────┘  │
         │                          │
         │  ┌────────────────────┐  │
         │  │ SQLite Cache       │  │
         │  │ Multi-file Parser  │  │
         │  │ Token Chunking     │  │
         │  └────────────────────┘  │
         └──────────────────────────┘
```

### Key Modules

| Module | Path | Purpose |
|---|---|---|
| **CLI Router** | `src/cli/router.ts` | Registers commands and resolves providers |
| **Config Manager** | `src/config/manager.ts` | Loads/saves config, merges env vars |
| **Inference Interface** | `src/inference/interface.ts` | `InferenceProvider` contract (`generate`, `isAvailable`, `getInfo`, `listModels`) |
| **Provider Factory** | `src/inference/factory.ts` | Instantiates the right adapter |
| **Adapters** | `src/inference/*-adapter.ts` | One per provider (Groq, NIM, Gemini, OpenRouter, Local) |
| **Model Discovery** | `src/cli/models.ts` | Lists and searches models from all providers |
| **Orchestrator** | `src/agents/orchestrator.ts` | Multi-agent pipeline coordinator |
| **Context Cache** | `src/context/cache.ts` | SQLite-backed response caching |
| **Context Parser** | `src/context/parser.ts` | Multi-file reading, chunking, prioritization |
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

> **Note:** The plugin system is a *programmatic* API. To make plugins load automatically from a directory (discovery), you would add a plugin loader script that scans a `~/.buff/plugins/` directory and registers any plugins found.

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
├── index.ts              # Entry point
├── cli/
│   ├── router.ts         # Command registration & provider resolution
│   ├── commands.ts       # Base command class
│   ├── chat.ts           # Interactive chat
│   ├── edit.ts           # File editing
│   ├── models.ts         # Model discovery (list/search models)
│   ├── plan.ts           # Implementation plans
│   ├── config.ts         # Configuration management
│   ├── execute.ts        # Multi-agent orchestration
│   └── cache.ts          # Cache management
├── agents/
│   ├── agent.ts          # Abstract Agent + types
│   ├── orchestrator.ts   # Multi-agent pipeline coordinator
│   ├── context-vault.ts  # Shared context bus
│   └── agents/
│       ├── planner.ts    # PlannerAgent
│       ├── context-gatherer.ts
│       ├── writer.ts     # WriterAgent
│       ├── reviewer.ts   # ReviewerAgent
│       ├── runner.ts     # RunnerAgent
│       ├── tester.ts     # TesterAgent
│       ├── debugger.ts   # DebuggerAgent
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
│   ├── groq-adapter.ts   # Groq LPU
│   ├── nim-adapter.ts    # NVIDIA NIM
│   ├── gemini-adapter.ts # Google Gemini
│   ├── openrouter-adapter.ts # OpenRouter
│   └── local-adapter.ts  # Ollama / HuggingFace / GGML
├── context/
│   ├── cache.ts          # SQLite response cache
│   └── parser.ts         # Multi-file context parsing
├── plugins/
│   └── registry.ts       # Plugin registration system
├── learning/
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
# Run all tests (115+ tests)
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

- [x] **Groq integration** — fast LPU inference for open-source models
- [x] **Multi-agent orchestration** — plan, write, review, test, and publish
- [x] **Model discovery** — search and filter across all providers
- [ ] **Streaming support** — real-time token-by-token output in chat mode
- [ ] **Auto-discovery plugin loader** — scan `~/.buff/plugins/` for `.js` plugin files
- [ ] **Hybrid routing** — automatically route small prompts to local models and complex ones to cloud
- [ ] **Local telemetry** — usage logs stored locally (no server upload)
- [ ] **Provider health checks** — `agent-nuvira doctor` to verify all configured providers

---

## License

MIT
