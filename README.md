# Buff CLI

**Flexible AI inference tool** — run large language models locally or route to cloud APIs through a unified CLI.

```
buff chat "explain recursion in Rust"
buff edit main.go --instruction "add input validation"
buff plan . --task "implement user authentication"
buff config list
```

---

## Features

- **Unified interface** across 4 providers: local (Ollama, HuggingFace, GGML), NVIDIA NIM, Google Gemini, and OpenRouter
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
# Clone the repo
git clone <your-repo-url> buff
cd buff

# Install dependencies
npm install

# Build
npm run build

# Link globally (optional)
npm link
```

### Verify

```bash
node dist/index.js --help
# or if linked:
buff --help
```

You should see:

```
Usage: buff [options] [command]

Flexible AI inference CLI tool — local models & cloud APIs

Options:
  -V, --version  output the version number
  -d, --debug    enable debug logging
  -h, --help     display help for command

Commands:
  chat [options] [prompt]  Start an interactive chat session with AI
  edit [options] <file>    Edit a file using AI assistance
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
buff config

# Set the default provider
buff config set defaultProvider gemini

# Set a provider's model
buff config set providers.nim.model "meta/llama-3.1-70b-instruct"

# List all providers with their status
buff config list
```

### Default Configuration

```json
{
  "defaultProvider": "local",
  "providers": {
    "nim": {
      "model": "meta/llama-3.1-70b-instruct",
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

### `buff chat` — Interactive Chat

Start a terminal-based chat session with any provider.

```bash
# Interactive mode (default provider)
buff chat

# One-shot prompt
buff chat "what is the difference between TCP and UDP?"

# Specify provider and model
buff chat --provider gemini --model gemini-2.0-flash-exp

# Include a file as context
buff chat --file ./src/main.ts "explain this code"

# Disable caching
buff chat --no-cache
```

**Interactive commands** within a chat session:

| Command | Action |
|---|---|
| `/exit` or `/quit` | End the session |
| `/clear` | Clear conversation history |
| `/info` | Show current provider details |
| `/help` | Show available commands |

### `buff edit` — AI-Assisted File Editing

Edit a file using natural language instructions. The AI reads the file, applies your instruction, and writes the result back.

```bash
# Edit with default instruction ("Review and improve this code")
buff edit src/server.ts

# Provide a specific instruction
buff edit src/server.ts --instruction "add rate limiting middleware"

# Use a specific provider
buff edit src/server.ts --provider openrouter --model openai/gpt-4o

# Preview changes without modifying the file
buff edit src/server.ts --instruction "add error handling" --dry-run
```

### `buff plan` — Implementation Plans

Analyze a directory or file and generate a structured implementation plan.

```bash
# Plan for the current directory
buff plan

# Plan for a specific target with a task description
buff plan ./src --task "add user authentication with JWT"

# Use a cloud provider for complex planning
buff plan . --task "refactor to microservices" --provider gemini

# Verbose mode shows the full context sent to the model
buff plan -v
```

The plan includes:
1. **Summary** — high-level overview
2. **Files to Modify** — specific files and changes
3. **Architecture Changes** — structural modifications
4. **Implementation Steps** — ordered guide
5. **Potential Risks** — edge cases and breaking changes
6. **Testing Strategy** — verification approach

### `buff config` — Configuration Management

```bash
# Show full config
buff config

# Set a value
buff config set defaultProvider openrouter

# Get a specific value
buff config get providers.nim.model

# List all providers with their status
buff config list

# Initialize (show defaults)
buff config init
```

### `buff cache` — Cache Management

Inference responses are cached in a local SQLite database (`~/.buff/cache.db`) with a default TTL of 1 hour.

```bash
# Show cache statistics
buff cache stats

# Clear all cached responses
buff cache clear
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

# Use with Buff
buff chat --provider local --model llama2
```

**Runners:**

| Runner | Description | Requirements |
|---|---|---|
| `ollama` (default) | Ollama HTTP API | [Ollama](https://ollama.ai) installed and running |
| `huggingface` | HuggingFace Transformers via Python | Python 3, `pip install transformers torch` |
| `ggml` | GGML/GGUF models via llama.cpp | `llama-cli` binary, model file |

Configure the runner:

```bash
buff config set providers.local.runner huggingface
buff config set providers.local.model "microsoft/phi-2"
```

### NVIDIA NIM

Connects to the **NVIDIA NIM** OpenAI-compatible API.

```bash
# Set your API key
export NVIDIA_NIM_API_KEY="nvapi-..."

# Use it
buff chat --provider nim
```

The NIM adapter uses `https://integrate.api.nvidia.com/v1` by default. You can override the base URL for self-hosted NIM deployments:

```bash
buff config set providers.nim.baseUrl "http://your-nim-host:8000/v1"
```

### Google Gemini

Connects to the **Google Gemini API** free tier.

```bash
# Set your API key
export GEMINI_API_KEY="AIzaSy..."

# Use it (supports 8K+ token context)
buff chat --provider gemini --model gemini-2.0-flash-exp
```

### OpenRouter

Routes through **OpenRouter** for access to 200+ models from multiple providers.

```bash
# Set your API key
export OPENROUTER_API_KEY="sk-or-v1-..."

# Use a specific model
buff chat --provider openrouter --model openai/gpt-4o

# Different model
buff chat --provider openrouter --model anthropic/claude-3-haiku
```

---

## Architecture

```
CLI Commands (chat, edit, plan, config, cache)
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
| **Inference Interface** | `src/inference/interface.ts` | `InferenceProvider` contract |
| **Provider Factory** | `src/inference/factory.ts` | Instantiates the right adapter |
| **Adapters** | `src/inference/*-adapter.ts` | One per provider (NIM, Gemini, OpenRouter, Local) |
| **Context Cache** | `src/context/cache.ts` | SQLite-backed response caching |
| **Context Parser** | `src/context/parser.ts` | Multi-file reading, chunking, prioritization |
| **Plugin Registry** | `src/plugins/registry.ts` | Pluggable third-party provider system |
| **Logger** | `src/utils/logger.ts` | Colored, level-based logging |

---

## Plugin System: Adding a New Provider

The plugin system allows you to add custom inference providers without modifying Buff's core code.

### Step 1: Implement `InferenceProvider`

Create a class that implements the `InferenceProvider` interface:

```typescript
import { InferenceProvider } from 'buff';
import { InferenceOptions, ProviderConfig } from 'buff';

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
}
```

### Step 2: Create a Plugin Wrapper

```typescript
import { ProviderPlugin, ProviderConfig, PluginMetadata } from 'buff';
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
import { getPluginRegistry } from 'buff';
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
buff chat --provider anthropic
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
# Type-check without emitting files
npx tsc --noEmit

# Build
npm run build

# Run the CLI
node dist/index.js --help
```

---

## Hybrid Mode

You can use different providers for different tasks by specifying `--provider` on each command:

```bash
# Use local models for quick, small edits
buff edit README.md --instruction "fix typos" --provider local

# Use cloud models for complex planning
buff plan . --task "design the database schema" --provider gemini

# Use OpenRouter for diverse model selection
buff chat --provider openrouter --model openai/gpt-4o
```

---

## Future Roadmap

- [ ] **Auto-discovery plugin loader** — scan `~/.buff/plugins/` for `.js` plugin files
- [ ] **Streaming support** — real-time token-by-token output in chat mode
- [ ] **Hybrid routing** — automatically route small prompts to local models and complex ones to cloud
- [ ] **Local telemetry** — usage logs stored locally (no server upload)
- [ ] **Provider health checks** — `buff doctor` to verify all configured providers

---

## License

MIT
