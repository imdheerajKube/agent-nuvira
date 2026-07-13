# Buff CLI — `agent-baba-d`

**Flexible AI inference tool** — run large language models locally (Ollama) or route to cloud APIs (NVIDIA NIM, Google Gemini, OpenRouter) through a unified CLI. Discover available models, chat interactively, edit files with AI, and plan codebase changes — all from the terminal.

```bash
# Quick examples
agent-baba-d chat "explain recursion in Rust"
agent-baba-d models --provider nim
agent-baba-d edit main.go --instruction "add input validation"
agent-baba-d plan . --task "implement user authentication"
agent-baba-d config list
```

---

## Features

- **Unified interface** across 4 providers: local (Ollama, HuggingFace, GGML), NVIDIA NIM, Google Gemini, and OpenRouter
- **Model discovery** — `agent-baba-d models` lists available models from any configured provider, with search/filter support
- **Interactive chat** with conversation history, file context, and session commands
- **AI-assisted file editing** with dry-run mode for safe previews
- **Codebase planning** that analyzes directory structure and generates implementation plans
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
npm install -g agent-baba-d

# Or clone and build from source
git clone <your-repo-url> buff
cd buff
npm install
npm run build
npm link
```

### Verify

```bash
agent-baba-d --help
```

You should see:

```
Usage: agent-baba-d [options] [command]

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
  config                   Manage Buff configuration
  cache                    Manage inference cache
```

---

## Configuration

### Config File

Configuration lives at `~/.buff/buffconfig.json`. It is created with sensible defaults on first use.

You can inspect and modify it through the CLI:

```bash
# Show full configuration
agent-baba-d config

# Set the default provider
agent-baba-d config set defaultProvider gemini

# Set a provider's model
agent-baba-d config set providers.nim.model "meta/llama-3.1-8b-instruct"

# List all providers with their status
agent-baba-d config list
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

| Variable | Provider | Required? |
|---|---|---|
| `NVIDIA_NIM_API_KEY` | NVIDIA NIM | Yes, unless using local |
| `GEMINI_API_KEY` | Google Gemini | Yes, unless using local |
| `OPENROUTER_API_KEY` | OpenRouter | Yes, unless using local |

You can place a `.env` file in the project root or at `~/.buff/.env`:

```env
# ~/.buff/.env
NVIDIA_NIM_API_KEY=nvapi-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GEMINI_API_KEY=AIzaSyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## CLI Commands

### `agent-baba-d models` — Model Discovery (New in v1.1.0)

List available models from any configured provider. Query each provider's model catalog without leaving the terminal.

```bash
# List models from the default provider
agent-baba-d models

# List models from a specific provider
agent-baba-d models --provider nim
agent-baba-d models --provider openrouter

# Search for models by keyword
agent-baba-d models --search deepseek
agent-baba-d models --search llama

# Show all providers (even unconfigured ones)
agent-baba-d models --all
```

**Examples:**

```bash
# See all 121 models on NVIDIA NIM
agent-baba-d models --provider nim

# Find DeepSeek models across all configured providers
agent-baba-d models --search deepseek

# Output:
# ════════════════════════════════════════════
# 📋 Available Models (3)
# ════════════════════════════════════════════
#
# NVIDIA NIM:
# ----------------------------------------
#   deepseek-ai/deepseek-v4-pro [deepseek]
#   deepseek-ai/deepseek-v4-flash [deepseek]
#   deepseek-ai/deepseek-coder-6.7b-instruct [deepseek]
#
# ════════════════════════════════════════════
```

Use a discovered model immediately:

```bash
agent-baba-d chat --provider nim --model deepseek-ai/deepseek-v4-flash
agent-baba-d edit src/server.ts --provider openrouter --model openai/gpt-4o
```

---

### `agent-baba-d chat` — Interactive Chat

Start a terminal-based chat session with any provider.

```bash
# Interactive mode (default provider)
agent-baba-d chat

# One-shot prompt
agent-baba-d chat "what is the difference between TCP and UDP?"

# Specify provider and model
agent-baba-d chat --provider gemini --model gemini-2.0-flash-exp

# Include a file as context
agent-baba-d chat --file ./src/main.ts "explain this code"

# Disable caching
agent-baba-d chat --no-cache
```

**Interactive commands** within a chat session:

| Command | Action |
|---|---|
| `/exit` or `/quit` | End the session |
| `/clear` | Clear conversation history |
| `/info` | Show current provider details |
| `/help` | Show available commands |

---

### `agent-baba-d edit` — AI-Assisted File Editing

Edit a file using natural language instructions. The AI reads the file, applies your instruction, and writes the result back.

```bash
# Edit with default instruction ("Review and improve this code")
agent-baba-d edit src/server.ts

# Provide a specific instruction
agent-baba-d edit src/server.ts --instruction "add rate limiting middleware"

# Use a specific provider
agent-baba-d edit src/server.ts --provider openrouter --model openai/gpt-4o

# Preview changes without modifying the file
agent-baba-d edit src/server.ts --instruction "add error handling" --dry-run
```

---

### `agent-baba-d plan` — Implementation Plans

Analyze a directory or file and generate a structured implementation plan.

```bash
# Plan for the current directory
agent-baba-d plan

# Plan for a specific target with a task description
agent-baba-d plan ./src --task "add user authentication with JWT"

# Use a cloud provider for complex planning
agent-baba-d plan . --task "refactor to microservices" --provider gemini

# Verbose mode shows the full context sent to the model
agent-baba-d plan -v
```

The plan includes:
1. **Summary** — high-level overview
2. **Files to Modify** — specific files and changes
3. **Architecture Changes** — structural modifications
4. **Implementation Steps** — ordered guide
5. **Potential Risks** — edge cases and breaking changes
6. **Testing Strategy** — verification approach

---

### `agent-baba-d config` — Configuration Management

```bash
# Show full config
agent-baba-d config

# Set a value
agent-baba-d config set defaultProvider openrouter

# Get a specific value
agent-baba-d config get providers.nim.model

# List all providers with their status
agent-baba-d config list

# Initialize (show defaults)
agent-baba-d config init
```

---

### `agent-baba-d cache` — Cache Management

Inference responses are cached in a local SQLite database (`~/.buff/cache.db`) with a default TTL of 1 hour.

```bash
# Show cache statistics
agent-baba-d cache stats

# Clear all cached responses
agent-baba-d cache clear
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
agent-baba-d chat --provider local --model llama2
```

**Runners:**

| Runner | Description | Requirements |
|---|---|---|
| `ollama` (default) | Ollama HTTP API | [Ollama](https://ollama.ai) installed and running |
| `huggingface` | HuggingFace Transformers via Python | Python 3, `pip install transformers torch` |
| `ggml` | GGML/GGUF models via llama.cpp | `llama-cli` binary, model file |

Configure the runner:

```bash
agent-baba-d config set providers.local.runner huggingface
agent-baba-d config set providers.local.model "microsoft/phi-2"
```

### NVIDIA NIM

Connects to the **NVIDIA NIM** OpenAI-compatible API at `https://integrate.api.nvidia.com/v1`.

```bash
# Set your API key
export NVIDIA_NIM_API_KEY="nvapi-..."

# List available models (121 models)
agent-baba-d models --provider nim

# Chat with any model
agent-baba-d chat --provider nim --model meta/llama-3.1-8b-instruct
agent-baba-d chat --provider nim --model deepseek-ai/deepseek-v4-flash
```

The NIM adapter uses `https://integrate.api.nvidia.com/v1` by default. You can override the base URL for self-hosted NIM deployments:

```bash
agent-baba-d config set providers.nim.baseUrl "http://your-nim-host:8000/v1"
```

### Google Gemini

Connects to the **Google Gemini API** free tier.

```bash
# Set your API key
export GEMINI_API_KEY="AIzaSy..."

# Use it (supports 8K+ token context)
agent-baba-d chat --provider gemini --model gemini-2.0-flash-exp
```

### OpenRouter

Routes through **OpenRouter** for access to 200+ models from multiple providers.

```bash
# Set your API key
export OPENROUTER_API_KEY="sk-or-v1-..."

# List available models
agent-baba-d models --provider openrouter

# Use a specific model
agent-baba-d chat --provider openrouter --model openai/gpt-4o
agent-baba-d chat --provider openrouter --model anthropic/claude-3-haiku
```

---

## Architecture

```
CLI Commands (chat, edit, plan, models, config, cache)
         │
         ▼
   Inference Layer (InferenceProvider interface)
         │
  ┌──────┼──────────────┬──────────────┐
  │      │              │              │
  ▼      ▼              ▼              ▼
 NIM   Gemini      OpenRouter       Local
Adapter Adapter     Adapter        Adapter
  │      │              │              │
  ▼      ▼              ▼              ▼
NVIDIA Google        OpenRouter   Ollama / HF /
 NIM   Gemini (free)   APIs        GGML Models

         ┌──────────────────────────┐
         │     Context Management   │
         │  ┌────────────────────┐  │
         │  │ SQLite Cache       │  │
         │  │ Multi-file Parser  │  │
         │  │ Token Chunking     │  │
         │  └────────────────────┘  │
         └──────────────────────────┘

         ┌──────────────────────────┐
         │    Plugin Registry       │
         │  (custom providers)      │
         └──────────────────────────┘
```

### Key Modules

| Module | Path | Purpose |
|---|---|---|
| **CLI Router** | `src/cli/router.ts` | Registers commands and resolves providers |
| **Config Manager** | `src/config/manager.ts` | Loads/saves config, merges env vars |
| **Inference Interface** | `src/inference/interface.ts` | `InferenceProvider` contract (`generate`, `isAvailable`, `getInfo`, `listModels`) |
| **Provider Factory** | `src/inference/factory.ts` | Instantiates the right adapter |
| **Adapters** | `src/inference/*-adapter.ts` | One per provider (NIM, Gemini, OpenRouter, Local) |
| **Model Discovery** | `src/cli/models.ts` | Lists and searches models from all providers |
| **Context Cache** | `src/context/cache.ts` | SQLite-backed response caching |
| **Context Parser** | `src/context/parser.ts` | Multi-file reading, chunking, prioritization |
| **Plugin Registry** | `src/plugins/registry.ts` | Pluggable third-party provider system |
| **Logger** | `src/utils/logger.ts` | Colored, level-based logging |

---

## Workflow Examples

### Discover and Chat with a Model

```bash
# Step 1: See what's available on NIM
agent-baba-d models --provider nim

# Step 2: Narrow down by keyword
agent-baba-d models --search deepseek

# Step 3: Chat with a found model
agent-baba-d chat --provider nim --model deepseek-ai/deepseek-v4-flash
```

### Hybrid Provider Usage

Use different providers for different tasks:

```bash
# Use local models for quick, small edits
agent-baba-d edit README.md --instruction "fix typos" --provider local

# Use cloud models for complex planning
agent-baba-d plan . --task "design the database schema" --provider gemini

# Use OpenRouter for diverse model selection
agent-baba-d chat --provider openrouter --model openai/gpt-4o
```

---

## Plugin System: Adding a New Provider

The plugin system allows you to add custom inference providers without modifying the CLI's core code.

### Step 1: Implement `InferenceProvider`

Create a class that implements the `InferenceProvider` interface:

```typescript
import { InferenceProvider } from 'agent-baba-d';
import { InferenceOptions, ProviderConfig } from 'agent-baba-d';

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
import { ProviderPlugin, ProviderConfig, PluginMetadata } from 'agent-baba-d';
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
import { getPluginRegistry } from 'agent-baba-d';
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
agent-baba-d chat --provider anthropic
```

> **Note:** The plugin system is a *programmatic* API. To make plugins load automatically from a directory (discovery), you would add a plugin loader script that scans a `~/.buff/plugins/` directory and registers any plugins found.

---

## Development

### Setup

```bash
git clone <repo-url>
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
│   └── cache.ts          # Cache management
├── config/
│   ├── types.ts          # TypeScript types
│   └── manager.ts        # Config load/save/env merging
├── inference/
│   ├── interface.ts      # InferenceProvider contract
│   ├── factory.ts        # Provider instantiation
│   ├── nim-adapter.ts    # NVIDIA NIM
│   ├── gemini-adapter.ts # Google Gemini
│   ├── openrouter-adapter.ts # OpenRouter
│   └── local-adapter.ts  # Ollama / HuggingFace / GGML
├── context/
│   ├── cache.ts          # SQLite response cache
│   └── parser.ts         # Multi-file context parsing
├── plugins/
│   └── registry.ts       # Plugin registration system
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

- [ ] **Auto-discovery plugin loader** — scan `~/.buff/plugins/` for `.js` plugin files
- [ ] **Streaming support** — real-time token-by-token output in chat mode
- [ ] **Hybrid routing** — automatically route small prompts to local models and complex ones to cloud
- [ ] **Local telemetry** — usage logs stored locally (no server upload)
- [ ] **Provider health checks** — `agent-baba-d doctor` to verify all configured providers
- [ ] **Interactive model picker** — fuzzy-select a model from search results during chat

---

## License

MIT
