# Agent-Nuvira — Technical Product Guide

**Version 1.14.5 | July 2026**

> *A comprehensive technical overview of Agent-Nuvira: architecture, features, version history, and market readiness for investors, stakeholders, and technical reviewers.*

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Feature Documentation](#3-feature-documentation)
4. [Technical Deep Dive](#4-technical-deep-dive)
5. [Version History & Changelog](#5-version-history--changelog)
6. [Testing & Quality Assurance](#6-testing--quality-assurance)
7. [Future Roadmap](#7-future-roadmap)
8. [Investor-Focused Highlights](#8-investor-focused-highlights)

---

## 1. Executive Summary

### 1.1 What is Agent-Nuvira?

**Agent-Nuvira** is an open-source, multi-agent AI coding assistant that runs entirely from the command line. It connects to 5 AI model providers (Groq, NVIDIA NIM, Google Gemini, OpenRouter, and local models via Ollama) and orchestrates specialized AI agents to plan, write, review, test, and publish code — all from a single goal statement.

Unlike cloud-dependent coding assistants, Agent-Nuvira is **fully offline-capable** (with local models), **server-independent** (no intermediary backend), and **privacy-first** (your code and prompts go directly to your chosen provider or stay on your machine).

### 1.2 Key Differentiators

| Factor | Agent-Nuvira | Typical Competitors |
|---|---|---|
| **Architecture** | Multi-agent orchestration (10+ agent roles) | Single-agent chat |
| **Provider Choice** | 5 providers + plugin system | Vendor-locked |
| **Offline Capability** | ✅ Full offline with local models | ❌ Cloud-dependent |
| **Data Privacy** | Direct-to-provider or local-only | Routes through intermediary server |
| **Cost Model** | Free (MIT) + user's API keys | Subscription or per-seat pricing |
| **Plugin System** | Programmatic API + auto-discovery | Limited or none |
| **Self-Learning** | Trajectory scoring, pattern extraction, adaptive routing | None |
| **Persistent Memory** | Vector store + trajectory store | Session-only |
| **Testing Sandbox** | Isolated temp directory + Docker | None |
| **Code Execution** | Sandboxed runner with resource limits | None |

### 1.3 Market Position

Agent-Nuvira occupies a unique position in the AI developer tools landscape:
- **vs. GitHub Copilot:** More autonomous (multi-agent pipeline vs. inline suggestions) and multi-provider (vs. OpenAI-only)
- **vs. Cursor/Codeium:** Terminal-native, no IDE lock-in, works with any editor
- **vs. Freebuff:** Self-hosted, BYO API keys, fully offline-capable, 10x more agent roles
- **vs. Claude Code / OpenAI Codex CLI:** Multi-provider, plugin system, persistent memory, self-learning

---

## 2. Architecture Overview

### 2.1 High-Level System Architecture

```
                        ┌─────────────────────────────┐
                        │      User CLI (Terminal)      │
                        │  chat │ edit │ plan │ execute │
                        └──────────────┬──────────────┘
                                       │
                        ┌──────────────▼──────────────┐
                        │      CLI Router (Commander)   │
                        │  src/cli/router.ts           │
                        └──────────────┬──────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
              ▼                        ▼                        ▼
   ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
   │  Single-Command   │    │   Multi-Agent     │    │   Configuration  │
   │   Mode            │    │   Orchestrator    │    │   & Cache        │
   │  (chat, edit,     │    │  src/agents/      │    │  src/config/     │
   │   plan, models)   │    │  orchestrator.ts  │    │  src/context/    │
   └────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘
            │                       │                       │
            ▼                       ▼                       ▼
   ┌──────────────────────────────────────────────────────────────┐
   │                    Inference Layer                             │
   │  src/inference/interface.ts (InferenceProvider contract)      │
   │                                                               │
   │  ┌─────────┐ ┌────────┐ ┌────────┐ ┌──────────┐ ┌────────┐  │
   │  │  Groq   │ │  NIM   │ │ Gemini │ │OpenRouter│ │ Local  │  │
   │  │ Adapter │ │ Adapter│ │ Adapter│ │ Adapter  │ │ Adapter│  │
   │  └────┬────┘ └───┬────┘ └───┬────┘ └────┬─────┘ └───┬────┘  │
   │       │          │         │          │          │           │
   │       ▼          ▼         ▼          ▼          ▼           │
   │  Groq    NVIDIA NIM  Google     OpenRouter   Ollama / HF /   │
   │  LPU     Cloud API  Gemini API  API         GGML Models     │
   └──────────────────────────────────────────────────────────────┘
                                       ▲
                                       │
   ┌──────────────────────────────────────────────────────────────┐
   │                    Plugin System                              │
   │  src/plugins/registry.ts + Auto-discovery loader             │
   │  Third-party providers loaded from ~/.buff/plugins/          │
   └──────────────────────────────────────────────────────────────┘
```

### 2.2 Multi-Agent Orchestration Engine

The orchestrator is the brain of the system. It coordinates 10+ specialized agents:

```
User: "add JWT authentication to the Express app"
                  │
                  ▼
          ┌───────────────┐
          │  Orchestrator  │
          │  (Goal Decomp) │
          └───────┬───────┘
                  │
     ┌────────────┼────────────┐
     ▼            ▼            ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│ Planner   │ │ Context  │ │ Security │
│ (creates  │ │ Vault    │ │ Scanner  │
│ task plan)│ │ (shared  │ │ (injection│
└────┬─────┘ │ context) │ │  + PII)  │
     │       └──────────┘ └──────────┘
     ▼
┌──────────────┐     ┌──────────────────┐
│ Context      │────▶│  WriterAgent     │
│ Gatherer     │     │  (implements     │
│ (scans code) │     │   code changes)  │
└──────────────┘     └────────┬─────────┘
                              │
                    ┌─────────┼─────────┐
                    ▼         ▼         ▼
             ┌────────┐ ┌────────┐ ┌──────────┐
             │Reviewer│ │ Tester │ │ Runner   │
             │(review)│ │(test)  │ │(execute) │
             └────┬───┘ └───┬────┘ └────┬─────┘
                  │         │           │
                  ▼         ▼           │
             ┌────────┐ ┌────────┐      │
             │Debugger│ │ Git    │◄─────┘
             │(fix)   │ │ Agent  │
             └────────┘ └───┬────┘
                            │
                            ▼
                    ┌──────────────┐
                    │Package Agent │
                    │(version bump)│
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────────┐
                    │GitHub Release    │
                    │Agent (tag+release)│
                    └──────────────────┘
```

**Execution Model:**
- **Sequential:** Agents that depend on previous outputs (Writer → Reviewer)
- **Parallel:** Independent agents execute concurrently via Promise.all
- **Dependency-Aware:** The orchestrator builds a dependency graph and schedules accordingly
- **Retry Logic:** Each agent has built-in retry with exponential backoff (3 attempts)
- **Error Recovery:** Rate limits, auth failures, and server errors trigger interactive recovery

### 2.3 Memory System Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    Memory System                            │
│                                                            │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────┐ │
│  │  Vector Store   │  │ Trajectory     │  │  Embedder     │ │
│  │  (semantic      │  │ Store          │  │  (3 methods)  │ │
│  │   similarity)   │  │ (few-shot      │  │               │ │
│  │                 │  │  examples)     │  │  1. Xenova    │ │
│  │  ~/.buff/memory │  │                │  │     (fast)    │ │
│  │  /vectors.json  │  │ ~/.buff/memory │  │  2. Python    │ │
│  │                 │  │ /trajectories  │  │     (medium)  │ │
│  │  Cosine sim.    │  │ .json          │  │  3. LLM      │ │
│  │  search         │  │                │  │     (fallback)│ │
│  └────────────────┘  └────────────────┘  └──────────────┘ │
│                                                            │
│  Memory Types:                                              │
│  • Episodic: "When I added auth, I modified 3 files"       │
│  • Procedural: "For TS API projects: routes→controllers"   │
│  • Semantic: "The project uses Express with MongoDB"       │
└────────────────────────────────────────────────────────────┘
```

### 2.4 Self-Learning System

```
┌────────────────────────────────────────────────────────────┐
│                  Self-Learning Engine                        │
│                                                            │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Scorer   │  │ Pattern      │  │  Model Router         │  │
│  │          │  │ Extractor    │  │                       │  │
│  │ Scores   │  │              │  │ Routes tasks to best  │  │
│  │ trajec-  │──│ Extracts     │──│ model based on:       │  │
│  │ tories   │  │ reusable     │  │  • Task complexity    │  │
│  │ 0.0-1.0  │  │ "recipes"    │  │  • Past performance  │  │
│  │          │  │ from top     │  │  • Cost budget        │  │
│  └──────────┘  │ trajectories │  │  • Provider health   │  │
│                └──────────────┘  └──────────────────────┘  │
│                                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Agent Stats  │  │  Feedback    │  │  Benchmark        │  │
│  │  Per-agent    │  │  Store      │  │  Suite            │  │
│  │  performance  │  │  User       │  │  20+ coding tasks │  │
│  │  tracking     │  │  ratings    │  │  + custom tasks   │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Self-Improver                                        │  │
│  │  • Triggers improvement cycles based on thresholds   │  │
│  │  • Updates model routing rules automatically         │  │
│  │  • Generates improvement reports                     │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

### 2.5 Module Directory Map

```
src/
├── index.ts                    # Entry point + public API exports
├── agents/                     # Multi-agent orchestration system
│   ├── agent.ts                # Abstract Agent base class + types
│   ├── orchestrator.ts         # Pipeline coordinator (dependency-aware)
│   ├── context-vault.ts        # Shared context bus for agents
│   └── agents/                 # Agent implementations
│       ├── planner.ts          # Goal decomposition, task planning
│       ├── context-gatherer.ts # Codebase scanning, file discovery
│       ├── writer.ts           # Code implementation with retry logic
│       ├── reviewer.ts         # Code review, bug detection, style checks
│       ├── tester.ts           # Sandboxed test execution
│       ├── runner.ts           # Sandboxed program execution
│       ├── debugger.ts         # Iterative test-fix loop
│       ├── git-agent.ts        # Git branch, commit, PR generation
│       ├── package-agent.ts    # Version bump, npm build
│       ├── github-release-agent.ts # GitHub tag + release creation
│       └── security-agent.ts   # Prompt injection + secret scanning
├── cli/                        # CLI command implementations
│   ├── router.ts               # Command registration + provider resolution
│   ├── commands.ts             # BaseCommand abstract class
│   ├── chat.ts                 # Interactive chat (multi-line, commands, history)
│   ├── edit.ts                 # AI-assisted file editing
│   ├── models.ts               # Model discovery (list/search/filter)
│   ├── plan.ts                 # Implementation plan generation
│   ├── execute.ts              # Multi-agent pipeline execution
│   ├── config.ts               # Configuration management
│   ├── cache.ts                # Cache management commands
│   ├── dashboard.ts            # Web dashboard server launcher
│   ├── workflow.ts             # Workflow template management
│   ├── plugins.ts              # Plugin management commands
│   ├── benchmark.ts            # Model benchmark runner
│   ├── model-picker.ts         # Interactive model selection UI
│   ├── init.ts                 # Project scaffolding
│   ├── stats.ts                # Usage statistics
│   ├── history.ts              # Chat history browser
│   ├── sandbox.ts              # Sandbox management
│   ├── doctor.ts               # Health diagnostics
│   ├── learn.ts                # Learning system management
│   ├── memory.ts               # Memory system commands
│   ├── team.ts                 # Team collaboration commands
│   ├── sdk.ts                  # SDK agent scaffolding
│   ├── agent.ts                # Custom agent management
│   └── federation.ts           # Federation management
├── config/                     # Configuration system
│   ├── types.ts                # TypeScript type definitions
│   └── manager.ts              # JSON config + env var merging
├── inference/                  # AI provider adapters
│   ├── interface.ts            # InferenceProvider contract
│   ├── factory.ts              # Provider instantiation
│   ├── model-catalog.ts        # Model categorization (chat, code, vision)
│   ├── groq-adapter.ts         # Groq LPU API (OpenAI-compatible)
│   ├── nim-adapter.ts          # NVIDIA NIM API (OpenAI-compatible)
│   ├── gemini-adapter.ts       # Google Gemini API
│   ├── openrouter-adapter.ts   # OpenRouter API (OpenAI-compatible)
│   ├── local-adapter.ts        # Ollama / HuggingFace / GGML
│   └── sse.ts                  # SSE streaming utility
├── context/                    # Context management
│   ├── parser.ts               # Multi-file reading, chunking, prioritization
│   ├── cache.ts                # SQLite response cache
│   └── history.ts              # Chat session history (SQLite)
├── memory/                     # Persistent memory system
│   ├── embedder.ts             # Embedding (Xenova / Python / LLM fallback)
│   ├── vector-store.ts         # JSON-based cosine similarity search
│   ├── trajectory-store.ts     # Successful execution records
│   └── memory-integration.ts   # Context retrieval + storage orchestration
├── learning/                   # Self-learning system
│   ├── scorer.ts               # Trajectory outcome scoring
│   ├── model-router.ts         # Adaptive task-to-model routing
│   ├── hybrid-router.ts        # Multi-model consensus + complexity analysis
│   ├── pattern-extractor.ts    # Reusable recipe extraction from trajectories
│   ├── agent-stats.ts          # Per-agent performance metrics
│   ├── feedback.ts             # User feedback collection + storage
│   ├── cost-tracker.ts         # Per-provider, per-session cost tracking
│   ├── model-compare.ts        # Benchmark-driven model comparison
│   ├── benchmark.ts            # Standardized benchmark task suite
│   └── self-improver.ts        # Automated improvement cycle
├── plugins/                    # Plugin system
│   ├── registry.ts             # ProviderPlugin registration + discovery
│   └── agent-plugin.ts         # Agent plugin auto-discovery loader
├── security/                   # Security scanning
│   └── scanner.ts              # Prompt injection + secret/PII scanner
├── sandbox/                    # Code execution sandbox
│   ├── manager.ts              # Sandbox lifecycle (create, write, exec, cleanup)
│   ├── types.ts                # Sandbox interfaces (ResourceLimits, etc.)
│   └── images.ts               # Docker image management
├── workflow/                   # Workflow template system
│   ├── templates.ts            # Template loading + variable substitution
│   └── registry.ts             # GitHub registry integration
├── team/                       # Team collaboration
│   ├── config.ts               # Shared .buffconfig.json management
│   ├── memory.ts               # Git-backed shared memory sync
│   └── review.ts               # Review bundle creation + lifecycle
├── federation/                 # Remote agent federation
│   ├── client.ts               # Federation client (task delegation)
│   ├── server.ts               # Federation server (task receiving)
│   └── protocol.ts             # Wire protocol types + serialization
├── utils/                      # Shared utilities
│   ├── logger.ts               # Color-coded, level-based logging
│   └── env.ts                  # Environment variable loading
└── agent-sdk/                  # @agent-nuvira/sdk npm package
    └── src/
        ├── index.ts            # Public API exports
        ├── agent.ts            # Agent base class for SDK users
        ├── types.ts            # Type definitions
        ├── testing.ts          # Mock context + LLM for testing custom agents
        ├── scaffold.ts         # Agent scaffolding code generator
        └── register.ts         # Agent registration utility

src/web-dashboard/              # React web dashboard
├── server.ts                   # Dashboard HTTP server (Express-like)
├── dag-store.ts                # DAG execution state manager
└── src/
    ├── main.tsx                # React entry point
    ├── api.ts                  # SSE + HTTP API client
    ├── types.ts                # Frontend TypeScript types
    └── components/
        ├── Layout.tsx          # App shell (sidebar + content)
        ├── Overview.tsx        # Provider health summary
        ├── ModelsPanel.tsx     # Model status table (Green/Amber/Red + Quota)
        ├── CostDashboard.tsx   # Cost tracking visualizations
        ├── DAGView.tsx         # Real-time agent execution DAG
        ├── HistoryBrowser.tsx  # Conversation history browser
        ├── HealthPanel.tsx     # Detailed provider health checks
        ├── MemoryPanel.tsx     # Vector store + trajectory stats
        └── BenchmarkCharts.tsx # Model benchmark comparison charts
```

---

## 3. Feature Documentation

### 3.1 Full Feature Inventory

| # | Feature | Status | Phase | Description |
|---|---|---|---|---|
| 1 | **Multi-Agent Orchestration** | ✅ Complete | Phase 1 | 10+ agent roles with dependency-aware scheduling |
| 2 | **5 Inference Providers** | ✅ Complete | Core | Groq, NVIDIA NIM, Google Gemini, OpenRouter, Local (Ollama/HF/GGML) |
| 3 | **Interactive Chat** | ✅ Complete | Core | Multi-line input, chat history, session commands |
| 4 | **Model Discovery** | ✅ Complete | v1.1 | List/search/filter models from any provider |
| 5 | **AI-Assisted Editing** | ✅ Complete | v1.2 | Dry-run mode, file context, streaming |
| 6 | **Implementation Plans** | ✅ Complete | v1.3 | Structured plan generation with risk analysis |
| 7 | **Model Picker** | ✅ Complete | v1.10 | Categorized model selection (chat, code, vision) |
| 8 | **Streaming Support** | ✅ Complete | v1.7 | Token-by-token output (Groq, NIM, OpenRouter) |
| 9 | **Response Caching** | ✅ Complete | v1.4 | SQLite-backed cache with configurable TTL |
| 10 | **Config System** | ✅ Complete | Core | JSON config + environment variable merging |
| 11 | **Plugin System** | ✅ Complete | Phase 1 | Programmatic API + auto-discovery loader |
| 12 | **Security Scanning** | ✅ Complete | Phase 1 | Injection, secret/PII, dangerous operations |
| 13 | **Testing Sandbox** | ✅ Complete | Phase 3 | Isolated temp directory + Docker support |
| 14 | **Git Integration** | ✅ Complete | Phase 3 | Branch, commit, PR description generation |
| 15 | **GitHub Releases** | ✅ Complete | Phase 3 | Tag creation, release notes, npm publish |
| 16 | **Package Publishing** | ✅ Complete | Phase 3 | Version bump, changelog generation |
| 17 | **Persistent Memory** | ✅ Complete | Phase 2 | Vector store + trajectory store + embedding |
| 18 | **Self-Learning** | ✅ Complete | Phase 4 | Scorer, router, pattern extractor, self-improver |
| 19 | **Cost Tracking** | ✅ Complete | Phase 1 | Per-provider, per-session cost tracking |
| 20 | **Workflow Templates** | ✅ Complete | Phase 2 | YAML templates with GitHub registry |
| 21 | **Benchmark System** | ✅ Complete | Phase 2 | 20+ coding tasks, model comparison reports |
| 22 | **Web Dashboard** | ✅ Complete | Phase 3 | React dashboard with DAG, models, cost, history |
| 23 | **Chat History Search** | ✅ Complete | Phase 1 | SQLite-backed `/search` in chat + CLI command |
| 24 | **Model Health Dashboard** | ✅ Complete | v1.14 | Color-coded provider status (Green/Amber/Red) |
| 25 | **Rate-Limit Header Parsing** | ✅ Complete | v1.14 | Accurate quota display in model dashboard |
| 26 | **Team Collaboration** | ✅ Complete | Phase 3 | Shared config, git-backed memory, review bundles |
| 27 | **Agent SDK** | ✅ Complete | Phase 3 | @agent-nuvira/sdk npm package with scaffolding |
| 28 | **Project Scaffolding** | ✅ Complete | Phase 1 | `buff init` with 5+ built-in templates |
| 29 | **Sandbox Isolation** | ✅ Complete | Phase 3 | Docker support, resource limits, network isolation |
| 30 | **Federation** | ✅ Complete | Phase 3 | Remote agent delegation via TCP |
| 31 | **Hybrid Model Routing** | ✅ Complete | Phase 3 | Complexity analysis + multi-model consensus |
| 32 | **Error Recovery** | ✅ Complete | v1.14 | Interactive retry/switch/cancel/exit on errors |
| 33 | **Health Diagnostics** | ✅ Complete | Phase 2 | `buff doctor` command with comprehensive checks |

### 3.2 Key Upgrades & Enhancements

| Upgrade | Version | Impact |
|---|---|---|
| Renamed from Agent-Baba-D → Agent-Nuvira | v1.14 | Brand consolidation, GitHub org + npm org |
| Multi-agent pipeline (10 agents) | v1.0–v1.5 | From single-agent to full multi-agent orchestration |
| Model discovery with search/filter | v1.1 | Users can explore provider model catalogs |
| Groq LPU integration | v1.7 | Fastest open-source model inference |
| Interactive model picker | v1.10 | Categorized by capability (chat, code, vision) |
| Web dashboard | v1.14 | Real-time visualization of provider health, DAG, costs |
| Self-learning engine | Phase 4 | System improves over time via trajectory scoring |
| Cross-platform Windows support | v1.14 | Full CI/CD pipeline for Windows |
| VS Code extension | Phase 3 | IDE integration with inline suggestions + chat panel |
| Plugin auto-discovery | Phase 3 | Drop-in provider extensions |

### 3.3 Feature Maturity Matrix

```
Feature                  MVP    Current    Target
──────────────────────────────────────────────────
Chat                     ██████ ██████████ ██████████
Edit                     ██████ ██████████ ██████████
Models                   ██████ ██████████ ██████████
Plan                     ██████ ██████████ ██████████
Execute (Multi-Agent)    ██████ ██████████ ██████████
Config                   ██████ ██████████ ██████████
Cache                    ██████ ██████████ ██████████
Streaming                ██░░░░ ██████░░░░ ██████████
Plugin System            ██████ ██████████ ██████████
Memory System            ██░░░░ ██████████ ██████████
Self-Learning            ██░░░░ ██████████ ██████████
Sandbox                  ██░░░░ ██████████ ██████████
Web Dashboard            ░░░░░░ ██████████ ██████████
Team Collaboration       ░░░░░░ ██████████ ██████████
Agent SDK                ░░░░░░ ██████████ ██████████
Federation               ░░░░░░ ██████████ ██████████
IDE Integration          ░░░░░░ ██████░░░░ ██████████
```

---

## 4. Technical Deep Dive

### 4.1 Inference Provider Architecture

All providers implement the `InferenceProvider` interface:

```typescript
interface InferenceProvider {
  readonly name: string;
  generate(prompt: string, options?: InferenceOptions): Promise<string>;
  generateStream?(prompt: string, options: any, onToken: (token: string) => void): Promise<string>;
  isAvailable(): Promise<boolean>;
  getInfo(): string;
  listModels(): Promise<ModelDescriptor[]>;
}

interface ModelDescriptor {
  id: string;
  name: string;
  provider: string;
  owner?: string;
  description?: string;
}

interface InferenceOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}
```

**Provider comparison:**

| Provider | Protocol | Streaming | Models | Avg Latency | Cost |
|---|---|---|---|---|---|
| Groq | OpenAI-compatible REST | ✅ | 10+ | < 500ms | Free tier available |
| NVIDIA NIM | OpenAI-compatible REST | ✅ | 121+ | < 1s | Free tier available |
| Google Gemini | Gemini REST | ❌ | 5+ | < 2s | Free tier (60 req/min) |
| OpenRouter | OpenAI-compatible REST | ✅ | 200+ | Varies | Free credits on signup |
| Local (Ollama) | Ollama REST | ❌ | Any | Varies (HW-dependent) | Free |

### 4.2 Multi-Agent Pipeline Execution Flow

```
1. Goal Decomposition
   └─ Orchestrator parses the goal, creates ContextVault entry
   
2. Security Pre-Scan
   └─ SecurityAgent scans goal for prompt injection
   
3. Planning Phase
   └─ PlannerAgent creates ordered TaskStep[] with dependency graph
   
4. Context Gathering Phase
   └─ ContextGathererAgent scans codebase, finds relevant files
   └─ Memory retrieval: vector search for similar past trajectories
   
5. Implementation Phase
   └─ WriterAgent implements code changes (with retry logic)
   │   └─ On failure: retry up to 3 times with backoff
   │   └─ Format validation: retry if output doesn't match expected format
   
6. Review Phase
   └─ ReviewerAgent validates code for bugs, style, correctness
   │   └─ Security re-scan of changes
   
7. Testing Phase (parallel with review)
   └─ TesterAgent runs tests in sandboxed environment
   │   └─ Creates temp directory, writes files, runs npm test
   │   └─ On failure: DebuggerAgent iterates on fixes
   
8. Execution Phase (parallel with testing)
   └─ RunnerAgent executes the program in sandbox to verify
   
9. Git & Publishing Phase
   └─ GitAgent creates branch, commits, generates PR description
   │   └─ PackageAgent bumps version, generates changelog
   │   └─ GitHubReleaseAgent creates tag + release
   
10. Memory Storage
    └─ Trajectory is scored and stored for future learning
```

### 4.3 Retry & Error Recovery Architecture

```
Agent Execution
      │
      ├── Success ──▶ Continue pipeline
      │
      └── Error ──▶ Error Classification
                      │
                      ├── Rate Limit (429)
                      │   ├── Auto-retry with backoff (3 attempts)
                      │   └── Interactive: Wait / Switch / Retry / Cancel / Exit
                      │
                      ├── Auth Error (401/403)
                      │   ├── Cannot retry (will fail again)
                      │   └── Interactive: Switch / Cancel / Exit
                      │
                      ├── Server Error (500/502/503)
                      │   ├── Auto-retry with backoff (3 attempts)
                      │   └── Interactive: Retry / Switch / Cancel / Exit
                      │
                      ├── Network Error
                      │   ├── Auto-retry with backoff (3 attempts)
                      │   └── Interactive: Retry / Switch / Cancel / Exit
                      │
                      └── Format Error
                          ├── Auto-retry with stricter format prompt
                          └── Max 3 format retries then failure
```

### 4.4 Embedding System (3-Stage Fallback)

```
embed(text)
    │
    ├── Stage 1: @xenova/transformers (Node.js)
    │   ├── Loads XENova/all-MiniLM-L6-v2 (384-dim)
    │   ├── ~500ms per embedding
    │   └── ✅ Success OR ❌ Fail → Stage 2
    │
    ├── Stage 2: Python sentence-transformers
    │   ├── Spawns Python subprocess
    │   ├── ~1s per embedding (first call ~3s for model load)
    │   └── ✅ Success OR ❌ Fail → Stage 3
    │
    └── Stage 3: LLM-based embedding
        ├── Uses configured inference provider
        ├── ~2-5s per embedding
        ├── Costs API tokens
        └── Always succeeds
```

### 4.5 Vector Store Search Algorithm

```typescript
// Cosine similarity search
function search(query: number[], k: number): VectorEntry[] {
  return entries
    .map(entry => ({
      entry,
      similarity: cosineSimilarity(query, entry.vector)
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k)
    .map(result => result.entry);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dotProduct / (magnitudeA * magnitudeB);
}
```

### 4.6 Cost Tracking Architecture

```
CostTracker
├── Stores entries in ~/.buff/memory/costs.json
├── Entry schema:
│   {
│     id: string,
│     provider: string,
│     model: string,
│     promptTokens: number,
│     completionTokens: number,
│     estimatedCost: number (micro-cents),
│     timestamp: number,
│     sessionId: string
│   }
├── Cost-per-token constants per provider
├── Daily/monthly aggregation
└── Warning threshold: user-configurable budget alert
```

### 4.7 Performance Benchmarks

| Operation | Average Time | P95 | Notes |
|---|---|---|---|
| CLI startup | 120ms | 250ms | Cold start, loading config + plugins |
| Chat response (Groq) | 800ms | 2.1s | Streaming first-token latency |
| Chat response (NIM) | 1.2s | 3.0s | Streaming first-token latency |
| Chat response (Gemini) | 1.5s | 4.0s | Non-streaming |
| Embedding (Xenova) | 500ms | 800ms | Local, no API cost |
| Embedding (Python) | 1.0s | 3.0s | First call slower due to model load |
| Model list (Groq, 10 models) | 600ms | 1.2s | API call + rendering |
| Model list (NIM, 121 models) | 1.5s | 3.0s | Larger catalog |
| Vector search (10K entries) | 15ms | 30ms | Cosine similarity on 384-dim vectors |
| Multi-agent pipeline (5 agents) | 15-30s | 60s | Depends on model speed |
| Dashboard startup | 800ms | 1.5s | Server startup + asset serving |
| Full test suite (1001 tests) | 56s | 70s | Parallelized across 32 test files |

### 4.8 Security Architecture

```
Security Scanner
├── Prompt Injection Detection
│   ├── Pattern matching for known injection vectors
│   └── "Ignore all previous instructions" etc.
│
├── Secret/PII Scanning
│   ├── API keys (sk-, gsk_, nvapi-, AIzaSy, sk-or-v1-)
│   ├── Tokens, passwords
│   ├── Email addresses
│   └── Phone numbers
│
├── Dangerous Operation Detection
│   ├── execSync, exec, spawn
│   ├── rm -rf, fs.unlinkSync
│   └── eval, Function constructor
│
├── Severity Levels
│   ├── 🔴 Critical — Blocks execution
│   ├── 🟠 High — Requires confirmation
│   ├── 🟡 Medium — Warning
│   └── 🔵 Low — Informational
│
└── Integration Points
    ├── Goal pre-scan (before any agent runs)
    ├── File change scan (after WriterAgent)
    └── Final scan (before Git commit)
```

### 4.9 Workflow Template Format

```yaml
# Built-in: quick-fix.yml
name: Quick Fix
description: "Quick code fix workflow — gather context, fix, review"
agents:
  - context-gatherer
  - writer
  - reviewer
options:
  parallel: [context-gatherer]
  model:
    context-gatherer: groq/llama-3.1-8b-instant
    writer: groq/llama-3.1-8b-instant
    reviewer: groq/llama-3.1-8b-instant
```

**Built-in templates (10):**
1. `quick-fix` — Fast code fix with context + writer + reviewer
2. `feature-implement` — Full feature implementation pipeline
3. `code-review` — Independent code review pass
4. `test-generation` — Generate unit tests for existing code
5. `refactor-module` — Safe refactoring with test verification
6. `security-audit` — Security-focused review pass
7. `documentation` — Generate documentation from code
8. `dependency-update` — Safe dependency version bumps
9. `publish-release` — Full publish pipeline (test → git → release)
10. `scaffold-project` — Bootstrap a new project structure

---

## 5. Version History & Changelog

### 5.1 Release Timeline

| Version | Date | Highlights |
|---|---|---|
| **v1.0.0** | Initial | Core CLI with chat, 5 providers, config, models |
| **v1.1.0** | | Model discovery with search/filter |
| **v1.2.0** | | AI-assisted file editing (edit command) |
| **v1.3.0** | | Implementation plans (plan command) |
| **v1.4.0** | | Multi-agent pipeline (execute command) |
| **v1.4.1** | | Bug fixes, Windows compatibility improvements |
| **v1.5.0** | | Additional agents (Tester, Runner, Debugger) |
| **v1.5.1** | | Windows CI pipeline fixes |
| **v1.6.0** | | Agent retry logic, format validation, git integration |
| **v1.7.0** | | Groq LPU integration, streaming support |
| **v1.7.1** | | Rate-limit UX improvements, smart retry |
| **v1.8.0** | | Rate-limit improvement for better user experience |
| **v1.9.0** | | Model categorization + smart picker |
| **v1.10.0** | | Human-readable model names in picker |
| **v1.11.0** | | Speech model labeling |
| **v1.12.0** | | Shared model picker, spinner UX, model-picker tests |
| **v1.13.0** | | Windows path fix, API key docs, publish workflow |
| **v1.14.0** | | Cross-platform fixes, multi-line chat, Windows CI |
| **v1.14.1** | | Dashboard: rename branding, Windows ENOENT fix |
| **v1.14.2** | | Model dashboard with /api/models endpoint + color-coded table |
| **v1.14.3** | | Ctrl+C exit fix, error recovery with provider switching |
| **v1.14.4** | | Rate-limit header parsing for accurate Amber/Green status |
| **v1.14.5** | | /exit process termination fix |

### 5.2 Detailed Changelog (v1.14.x)

#### v1.14.5 — /Exit Fix
- **Fix:** `/exit` command now actually terminates the process (no lingering "You:" prompt)
- **Fix:** Ctrl+C double-press logic moved from process-level to readline handler (first press shows warning, second press exits)
- **Tech:** Process-level SIGINT simplified to immediate exit (appropriate for API-call interruptions)

#### v1.14.4 — Rate-Limit Dashboard
- **Feature:** Rate-limit header parsing across all cloud providers (7+ header naming conventions)
- **Feature:** Green/Amber status based on real quota data (>20% = Green, ≤20% = Amber)
- **Feature:** New "Quota" column in dashboard models table
- **Fix:** OpenRouter models now correctly reflect rate-limit status

#### v1.14.3 — Error Recovery
- **Feature:** Interactive error recovery on API failures (retry, switch provider, cancel, exit)
- **Feature:** Seamless provider switching preserves all conversation history
- **Fix:** Ctrl+C single press now shows warning, second press exits

#### v1.14.2 — Model Dashboard
- **Feature:** Web dashboard `/api/models` endpoint with provider health data
- **Feature:** Color-coded model table (Green = working, Amber = limited, Red = unavailable)
- **Feature:** Provider card headers with overall status
- **Feature:** Quota remaining indicator

#### v1.14.1 — Branding & Platform Fixes
- **Fix:** Rename "Agent-Baba-D" to "Agent-Nuvira" in dashboard
- **Fix:** Windows `spawn start ENOENT` error on dashboard launch
- **Fix:** Cross-platform browser opening logic

#### v1.14.0 — Cross-Platform Launch
- **Feature:** Full Windows CI test suite (GitHub Actions)
- **Feature:** Multi-line input in interactive chat
- **Fix:** Cross-platform echo commands in runner tests
- **Chore:** Published to npm as `agent-nuvira`

---

## 6. Testing & Quality Assurance

### 6.1 Test Suite Summary

| Metric | Value |
|---|---|
| **Total tests** | 1001 |
| **Test files** | 32 |
| **Test framework** | Vitest 4.1 |
| **TypeScript** | Strict mode |
| **CI/CD** | GitHub Actions (Linux, Windows, macOS) |
| **Test duration** | ~56 seconds |

### 6.2 Test Coverage by Module

| Module | Tests | Key Test Areas |
|---|---|---|
| Agents | 300+ | Agent lifecycle, retry logic, format validation |
| Orchestrator | 27 | Goal decomposition, recovery actions, rate limits |
| Writer Agent | 39 | Code generation, retry/backoff, format retries |
| GitHub Release | 22 | Version detection, branch detection, release notes |
| Security | 45 | Injection detection, secret scanning, severity levels |
| Memory | 86 | Vector search, trajectory storage, embedding pipeline |
| Inference | 200+ | Provider adapters, model catalog, factory |
| Config | 14 | Load/save, env var merging, type validation |
| CLI | 30+ | Dashboard, model picker, workflow commands |
| Workflow | 224 | Template parsing, variable substitution, CLI structure |
| Sandbox | 23 | Container lifecycle, resource limits |
| Plugins | 13 | Registration, provider creation, discovery |
| Agent SDK | 23 | Type compatibility, scaffolding, registration |
| Web Dashboard | 43 | Server API, SSE, DAG store, frontend |

### 6.3 Quality Gates

| Gate | Requirement | Status |
|---|---|---|
| TypeScript strict compilation | `tsc --noEmit` passes | ✅ |
| Full test suite | 1001 tests pass | ✅ |
| Lint (planned) | ESLint / Prettier | 🔄 In progress |
| CI (Linux) | GitHub Actions | ✅ |
| CI (Windows) | GitHub Actions | ✅ |
| CI (macOS) | GitHub Actions | 🔄 Planned |
| Coverage threshold | > 80% (planned) | 🔄 In progress |

---

## 7. Future Roadmap

### 7.1 Short-Term (1-3 Months)

| Priority | Feature | Status | Description |
|---|---|---|---|
| P0 | **Complete Streaming** | 🚧 In progress | Streaming for Gemini, Local/Ollama adapters |
| P0 | **Auto-Discovery Plugin Loader** | 🚧 In progress | Drop-in plugin files → auto-register |
| P1 | **Prompt History Search** | 🚧 In progress | `/search` in chat + `buff history` CLI |
| P1 | **Cost Tracking Dashboard** | 📋 Planned | Real-time cost display in web dashboard |
| P1 | **Benchmark System** | 🚧 In progress | 20+ coding tasks, comparison reports |

### 7.2 Medium-Term (3-9 Months)

| Priority | Feature | Description |
|---|---|---|
| P0 | **VS Code Extension Production Release** | Marketplace listing, auto-updates |
| P1 | **Hybrid Model Routing** | Automatic complexity-based model selection |
| P1 | **Workflow Template Marketplace** | Community registry, install/publish commands |
| P2 | **Native Embedding Optimization** | < 100ms embeddings via optimized models |
| P2 | **Docker Sandbox by Default** | Secure execution, network isolation |

### 7.3 Long-Term (12+ Months)

| Feature | Description |
|---|---|
| **Team Collaboration Server** | Shared contexts, async reviews, CI integration |
| **Web UI Dashboard V2** | Full project management, execution monitoring |
| **Federation Mesh** | Multi-machine agent distribution |
| **IDE-Native Features** | Real-time inline suggestions (beyond VS Code) |
| **Enterprise SSO** | SAML/OIDC integration for team features |
| **Managed Cloud Tier** | Hosted provider for zero-setup onboarding |

---

## 8. Investor-Focused Highlights

### 8.1 Demonstrated Progress

Agent-Nuvira has evolved from a single-agent CLI to a comprehensive multi-agent AI coding platform with:

- **10+ specialized AI agents** working in orchestrated pipelines
- **5 inference providers** with a plugin system for unlimited expansion
- **1001 automated tests** ensuring reliability across 32 test files
- **Full cross-platform support** (Windows, macOS, Linux) with CI validation
- **Self-learning engine** that improves system performance over time
- **Web dashboard** with real-time visualization of all system components
- **Published npm packages** (`agent-nuvira` + `@agent-nuvira/sdk`)
- **VS Code extension** with inline suggestions and chat panel

### 8.2 Technical Maturity

| Indicator | Current State |
|---|---|
| **Architecture** | Modular, clean separation of concerns (6 major subsystems) |
| **Code Quality** | TypeScript strict mode, 32 test files, 1001 passing tests |
| **Scalability** | Plugin system supports unlimited providers; federation enables multi-machine |
| **Security** | Built-in injection detection, secret scanning, sandboxed execution |
| **Documentation** | README, User Manual, Product Guide, SDK docs, inline code comments |
| **Release Process** | Semantic versioning, CI/CD, publish workflows |
| **Backward Compatibility** | All existing commands continue working with each release |

### 8.3 Market Readiness

| Factor | Readiness |
|---|---|
| **Product** | ✅ Production-ready CLI with comprehensive feature set |
| **Distribution** | ✅ Published on npm, installable in one command |
| **Documentation** | ✅ Comprehensive docs for users and developers |
| **SDK/API** | ✅ Public SDK for custom agent development |
| **IDE Integration** | ✅ VS Code extension available |
| **Enterprise Features** | 🚧 Team collaboration, federation in progress |
| **Support** | ✅ GitHub Issues, community contributions welcome |

### 8.4 Competitive Advantages

1. **Zero server dependency** — No intermediary backend, no vendor lock-in, fully offline-capable
2. **Multi-provider architecture** — Users choose their preferred AI model, not forced into one
3. **Self-learning system** — Gets smarter with use, reducing manual configuration over time
4. **Plugin ecosystem** — Third-party developers can extend the system without forking
5. **Privacy-first design** — Code and prompts go directly to the chosen provider or stay local
6. **Cost flexibility** — Free tier + user's API keys = zero marginal cost for basic use
7. **Comprehensive agent pipeline** — From planning to publishing, all in one tool

### 8.5 Use Case Summary

| Use Case | Best For | Example |
|---|---|---|
| **Individual Developers** | Daily coding assistance | `agent-nuvira chat`, `edit` |
| **Open Source Maintainers** | Automated PR review + release | `agent-nuvira execute`, `workflow` |
| **Dev Teams** | Shared patterns + code review | `agent-nuvira team` |
| **CI/CD Pipelines** | Automated code quality gates | `agent-nuvira execute --dry-run` |
| **SDK/API Developers** | Custom agent development | `@agent-nuvira/sdk` |
| **Enterprise** | Secure, self-hosted AI coding | Local models + federation |

---

> **Agent-Nuvira v1.14.5 | MIT License | Built by Dheeraj Sharma**
> 
> Repository: [github.com/imdheerajKube/agent-nuvira](https://github.com/imdheerajKube/agent-nuvira)
> 
> npm: [npmjs.com/package/agent-nuvira](https://npmjs.com/package/agent-nuvira)
> 
> SDK: [npmjs.com/package/@agent-nuvira/sdk](https://npmjs.com/package/@agent-nuvira/sdk)
