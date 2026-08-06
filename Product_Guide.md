# Agent-Nuvira — Technical Product Guide

**Version 1.55.0 | August 2026**

> *A comprehensive technical overview of Agent-Nuvira: architecture, features, version history, and market readiness for investors, stakeholders, and technical reviewers.*

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Feature Documentation](#3-feature-documentation)
4. [Technical Deep Dive](#4-technical-deep-dive)
5. [Version History & Changelog](#5-version-history--changelog)
6. [Testing & Quality Assurance](#6-testing--quality-assurance)
7. [Completed Roadmap](#7-completed-roadmap)
8. [Investor-Focused Highlights](#8-investor-focused-highlights)
9. [Strategy & Pitch Deck](#9-strategy-pitch-deck)

---

## 1. Executive Summary

### 1.1 What is Agent-Nuvira?

**Agent-Nuvira** is an open-source, multi-agent AI coding assistant that runs entirely from the command line. It connects to **17+ AI model providers** (5 built-in — Groq, NVIDIA NIM, Google Gemini, OpenRouter, and local models via Ollama — plus 12 more configurable via environment variables: OpenAI, Anthropic, Mistral, Cohere, Together, DeepInfra, Fireworks, Perplexity, Azure, LM Studio, Anyscale, vLLM) and orchestrates 17 specialized AI agents to plan, write, review, test, and publish code — all from a single goal statement.

Unlike cloud-dependent coding assistants, Agent-Nuvira is **fully offline-capable** (with local models), **server-independent** (no intermediary backend), and **privacy-first** (your code and prompts go directly to your chosen provider or stay on your machine).

### 1.2 Key Differentiators

| Factor | Agent-Nuvira | Typical Competitors |
|---|---|---|
| **Architecture** | Multi-agent orchestration (17 agent roles + management) | Single-agent chat |
| **Provider Choice** | 17+ providers (5 built-in + 12 configurable via env vars) + plugin system | Vendor-locked |
| **Offline Capability** | ✅ Full offline with local models | ❌ Cloud-dependent |
| **Data Privacy** | Direct-to-provider or local-only | Routes through intermediary server |
| **Cost Model** | Free (MIT) + user's API keys | Subscription or per-seat pricing |
| **Plugin System** | Programmatic API + auto-discovery | Limited or none |
| **Self-Learning** | Trajectory scoring, skill compilation, pattern extraction, adaptive routing | None |
| **Persistent Memory** | Vector store + trajectory store | Session-only |
| **Testing Sandbox** | Isolated temp directory + Docker | None |
| **Code Execution** | Sandboxed runner with resource limits | None |
| **Skill Compiler** | ✅ Auto-extracts reusable patterns from trajectories | ❌ Manual templates only |
| **Context Management** | ✅ Automatic token-aware pruning for long chains | ❌ Fixed context windows |
| **Model Switching** | ✅ Context-preserving mid-session switching | ❌ Restart required |
| **Project Scaffolding** | ✅ 5 built-in templates with provider wizard | ❌ Manual setup |
| **Docker Deployment** | ✅ 5-minute containerized onboarding | ❌ Manual environment setup |
| **Interactive Dev Mode** | ✅ Guided loop with session save/resume, failure analysis, suggestions | ❌ Static goal-in-goal-out |
| **Auto Error Repair** | ✅ Diagnosis & retry budgets for test failures | ❌ Manual debugging |
| **A2A Protocol** | ✅ Agent-to-Agent communication for federation | ❌ No standard |
| **MCP Integration** | ✅ Model Context Protocol with stdio + SSE transport | ❌ No protocol support |

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

The orchestrator is the brain of the system. It coordinates 17 specialized agents and management components:

```
User: "add JWT authentication to the Express app"
                  │
                  ▼
          ┌─────────────────┐
          │   Orchestrator   │
          │  (Goal Decomp)   │
          │  + Context       │
          │    Vault & Pruner │
          │  + MCP Manager   │
          └───────┬─────────┘
                  │
     ┌────────────┼──────────────────┐
     ▼            ▼                  ▼
┌──────────┐ ┌──────────┐   ┌────────────┐
│ Planner   │ │ Context  │   │Security    │
│ (creates  │ │ Vault    │   │Agent       │
│ task plan)│ │ (shared  │   │(pre-scan   │
└────┬─────┘ │ context) │   │ goal + PII)│
     │       │ + Pruner │   └────────────┘
     ▼       └──────────┘
┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ Context      │────▶│  WriterAgent     │◀───▶│    MCPAgent      │
│ Gatherer     │     │  (implements     │     │ (invokes ext.    │
│ (scans code) │     │   code changes)  │     │  tools via MCP)  │
└──────────────┘     └────────┬─────────┘     └──────────────────┘
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
                    ┌──────────────────┐
                    │  PackageAgent    │
                    │(version bump,    │
                    │ npm build,       │
                    │ changelog gen)   │
                    └──────┬───────────┘
                           │
                           ▼
                    ┌──────────────────┐
                    │GitHub Release    │
                    │Agent (tag+release│
                    │ notes + publish) │
                    └──────────────────┘

                     ┌──────────────────┐
                     │  Skill Compiler   │◄── Auto-compiles from
                     │  (LLM extracts    │    top trajectories
                     │   reusable steps) │
                     └────────┬─────────┘
                              │
                     ┌────────▼────────┐
                     │  Skill Runner   │
                     │  (injects steps │
                     │   into pipeline)│
                     └─────────────────┘
```

**Execution Model:**
- **Sequential:** Agents that depend on previous outputs (Writer → Reviewer)
- **Parallel:** Independent agents execute concurrently via Promise.all
- **Dependency-Aware:** The orchestrator builds a dependency graph and schedules accordingly
- **Retry Logic:** Each agent has built-in retry with exponential backoff (3 attempts)
- **Error Recovery:** Rate limits, auth failures, and server errors trigger interactive recovery
- **Interactive Dev Mode:** `buff execute` without a goal launches a guided loop with model picker, session tracking, failure analysis, follow-up suggestions, and /fix command
- **Session Save/Resume:** Save development sessions with `/save <name>` and restore with `/resume <name>` — full history and model state preserved

### 2.3 Memory System Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    Memory System                            │
│                                                            │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────┐ │
│  │  Vector Store   │  │ Trajectory     │  │  Embedder     │ │
│  │  (FAISS-backed) │  │ Store          │  │  (3 methods)  │ │
│  │  tiers:         │  │ (few-shot      │  │               │ │
│  │   1. faiss-     │  │  examples)     │  │  1. Xenova    │ │
│  │      native     │  │                │  │     (fast)    │ │
│  │   2. faiss-ivf  │  │ ~/.buff/memory │  │  2. Python    │ │
│  │   3. json       │  │ /trajectories  │  │     (medium)  │ │
│  │  (auto-selected)│  │ .json          │  │  3. LLM      │ │
│  │  Cosine sim.    │  │                │  │     (fallback)│ │
│  └────────────────┘  └────────────────┘  └──────────────┘ │
│                                                            │
│  Memory Types:                                              │
│  • Episodic: "When I added auth, I modified 3 files"       │
│  • Procedural: "For TS API projects: routes→controllers"   │
│  • Semantic: "The project uses Express with MongoDB"       │
└────────────────────────────────────────────────────────────┘
```

The **Vector Store** is now FAISS-backed with three pluggable tiers
(`src/memory/faiss-backend.ts`): `faiss-native` (`@faiss-node/native` real
FAISS, FLAT_IP + L2-normalized → cosine) → `faiss-ivf` (pure-JS IVF-flat ANN)
→ `json` (exact flat cosine, original behavior). Auto-selected per machine in
priority order with lazy resolution; `buff memory backend --check` reports the
active tier. See §4.5.

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
│   ├── module-registry.ts      # 17-agent registry (register/getModule/listModules)
│   └── agents/                 # Agent implementations (17 registered agents)
│       ├── planner.ts          # #1 Goal decomposition, task planning
│       ├── context-gatherer.ts # #2 Codebase scanning, file discovery
│       ├── writer.ts           # #3 Code implementation with retry logic
│       ├── reviewer.ts         # #4 Code review, bug detection, style checks
│       ├── runner.ts           # #5 Sandboxed program execution
│       ├── tester.ts           # #6 Sandboxed test execution
│       ├── debugger.ts         # #7 Iterative test-fix loop
│       ├── git-agent.ts        # #8 Git branch, commit, PR generation
│       ├── gitlab-agent.ts     # #9 Full GitLab REST API — MRs, issues, pipelines
│       ├── package-agent.ts    # #10 Dependency management / version bump
│       ├── github-release-agent.ts # #11 GitHub tag + release creation
│       ├── security-agent.ts   # #12 Prompt injection + secret scanning
│       ├── skill-runner.ts     # #13 Injects skill steps into execution plan
│       ├── mcp-agent.ts        # #14 MCP tool invocation (Model Context Protocol)
│       ├── pr-review-agent.ts  # #15 Inline code review on open PRs
│       ├── issue-triage-agent.ts # #16 Issue classification + prioritization
│       └── branch-automation-agent.ts # #17 Git hooks + auto-branch workflows
├── cli/                        # CLI command implementations
│   ├── router.ts               # Command registration + provider resolution
│   ├── commands.ts             # BaseCommand abstract class
│   ├── chat.ts                 # Interactive chat (multi-line, commands, history, /search)
│   ├── edit.ts                 # AI-assisted file editing
│   ├── models.ts               # Model discovery (list/search/filter)
│   ├── model.ts                # Context-preserving model switching
│   ├── skill.ts                # Skill compilation & execution
│   ├── init.ts                 # Project scaffolding
│   ├── plan.ts                 # Implementation plan generation
│   ├── execute.ts              # Multi-agent pipeline execution (with context pruning)
│   ├── config.ts               # Configuration management
│   ├── cache.ts                # Cache management commands
│   ├── dashboard.ts            # Web dashboard server launcher
│   ├── workflow.ts             # Workflow template management
│   ├── plugins.ts              # Plugin management commands
│   ├── benchmark.ts            # Model benchmark runner
│   ├── model-picker.ts         # Interactive model selection UI
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
│   └── history.ts              # Chat session history (JSON file)
├── memory/                     # Persistent memory system
│   ├── embedder.ts             # Embedding (Xenova / Python / LLM fallback)
│   ├── vector-store.ts         # VectorStore facade + backend resolution
│   ├── faiss-backend.ts        # FAISS-backed vector store tiers (native → IVF → JSON)
│   ├── faiss-node.d.ts         # Type declarations for @faiss-node/native
│   ├── trajectory-store.ts     # Successful execution records
│   └── memory-integration.ts   # Context retrieval + storage orchestration
├── learning/                   # Self-learning system
│   ├── skill-compiler.ts       # LLM-powered skill extraction from trajectories
│   ├── skill-store.ts          # Persistent skill storage with decay scoring
│   ├── skill-types.ts          # Skill type definitions
│   ├── context-pruner.ts       # Token-aware context compression (5 strategies)
│   ├── scorer.ts               # Trajectory outcome scoring
│   ├── model-router.ts         # Adaptive task-to-model routing
│   ├── hybrid-router.ts        # Multi-model consensus + complexity analysis
│   ├── pattern-extractor.ts    # Reusable recipe extraction from trajectories
│   ├── agent-stats.ts          # Per-agent performance metrics
│   ├── feedback.ts             # User feedback collection + storage
│   ├── cost-tracker.ts         # Per-provider, per-session cost tracking
│   ├── model-compare.ts        # Benchmark-driven model comparison
│   ├── benchmark.ts            # Standardized benchmark task suite
│   └── self-improver.ts        # Automated improvement cycle (triggers skill compilation)
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
| 2 | **17+ Inference Providers** | ✅ Complete | Core | 5 built-in (Groq, NVIDIA NIM, Google Gemini, OpenRouter, Local) + 12 configurable via env vars (OpenAI, Anthropic, Mistral, Cohere, Together, DeepInfra, Fireworks, Perplexity, Azure, LM Studio, Anyscale, vLLM) |
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
| 23 | **Chat History Search** | ✅ Complete | Phase 1 | JSON-backed `/search` in chat + `buff history` CLI |
| 24 | **Model Health Dashboard** | ✅ Complete | v1.14 | Color-coded provider status (Green/Amber/Red) |
| 25 | **Rate-Limit Header Parsing** | ✅ Complete | v1.14 | Accurate quota display in model dashboard |
| 26 | **Team Collaboration** | ✅ Complete | Phase 3 | Shared config, git-backed memory, review bundles |
| 27 | **Agent SDK** | ✅ Complete | Phase 3 | @agent-nuvira/sdk npm package with scaffolding |
| 28 | **Project Scaffolding** | ✅ Complete | Phase 1 | `buff init` with 5+ built-in templates |
| 29 | **Sandbox Isolation** | ✅ Complete | Phase 3 | Docker support, resource limits, network isolation |
| 30 | **Federation** | ✅ Complete | Phase 3 | Remote agent delegation via TCP |
| 31 | **Hybrid Model Routing** | ✅ Complete | Phase 3 | Complexity analysis + multi-model consensus |
| 32 | **Error Recovery** | ✅ Complete | v1.14 | Interactive retry/switch/cancel/exit on errors |
| 33 | **Native Embedding Support** | ✅ Complete | Phase 2 | 3-tier embedder (Xenova/Python/LLM) with LRU cache |
| 34 | **Skill Compiler System** | ✅ Complete | Phase 1 | Auto-extracts reusable patterns from trajectories into runnable skills |
| 35 | **Context-Window Memory Pruner** | ✅ Complete | Phase 1 | Automatic token-aware compression for long multi-agent chains |
| 36 | **Context-Preserving Model Switching** | ✅ Complete | Phase 1 | Switch providers mid-session without losing agent state |
| 37 | **Docker Compose Setup** | ✅ Complete | Phase 2 | 5-minute containerized onboarding |
| 38 | **Project Scaffolding (`buff init`)** | ✅ Complete | Phase 1 | 5 built-in templates with interactive provider selection |
| 39 | **Provider CLI (`buff provider list/health`)** | ✅ Complete | NextLevel | Color-coded provider status table + per-provider health diagnostics with `--verbose` and `--watch` modes |
| 40 | **Provider Fallback Routing** | ✅ Complete | NextLevel | Automatic failover between providers with configurable chain, circuit breaker (3 failures → 120s cooldown), and transparent logging |
| 41 | **Security Scan CLI** | ✅ Complete | NextLevel | `buff security scan` — PII, injection, and dangerous code detection with severity thresholds |
| 42 | **Feedback & Rating System** | ✅ Complete | NextLevel | `buff feedback` — user feedback collection with record/list/stats/clear lifecycle |
| 43 | **Marketplace Unified CLI** | ✅ Complete | NextLevel | `buff marketplace browse/search/install/info` — unified plugin + template discovery |
| 44 | **CI/CD Headless Mode** | ✅ Complete | Phase 4 | `buff ci execute/check/review` — structured JSON output, GitHub Actions annotations, exit codes for CI pipelines |
| 45 | **npm Publishing** | ✅ Published (v1.15.0) | Phase 4 | `npx buff` / `npx agent-nuvira` live on npm — 483 files, 1.3 MB, zero-setup onboarding |
| 46 | **Interactive Dev Mode** | ✅ Complete | Phase 5 | `buff execute` without goal — guided loop, session save/resume, /suggest, /history |
| 47 | **Session Persistence** | ✅ Complete | Phase 5 | `/save <name>` / `/resume <name>` — full history, model, and provider across restarts |
| 48 | **Failure Analysis** | ✅ Complete | Phase 5 | Per-agent-type diagnosis with specific recovery actions (rephrase, switch model, auto-fix) |
| 49 | **Follow-up Suggestions** | ✅ Complete | Phase 5 | LLM-powered contextual next-step recommendations after goal completion |
| 50 | **/fix Command** | ✅ Complete | Phase 5 | Retry last failed goal with failure context — shows post-execution analysis |
| 51 | **MCP SSE Transport** | ✅ Complete | Phase 4.1 | Server-Sent Events transport for remote MCP connections with Bearer auth |
| 52 | **Firecrawl Integration** | ✅ Complete | Phase 4.1 | Web search and scraping via Firecrawl MCP server |
| 53 | **Auto Error-Repair Engine** | ✅ Complete | Phase 4.3 | Automatic diagnosis and repair of test failures with configurable retry budgets |
| 54 | **A2A Protocol** | ✅ Complete | Phase 4.4 | Agent-to-Agent communication standard for multi-machine collaboration |
| 55 | **Enhanced Test Coverage** | ✅ Complete | Phase 5 | 1830+ tests across 55 test files — failure analysis, follow-ups, handlePostExecution |
| 56 | **Marketing Website** | ✅ Complete | Core | `website/` directory — full static landing page at agent-nuvira.com with hero, features, pipeline, providers, quickstart, comparison table, Netlify-ready deployment |
| 57 | **RecoverModule (Phase 1)** | ✅ Complete (v1.18.0) | Phase 6 | Extracted from ErrorRepairEngine — discriminated union strategies + RepairBudget (3 attempts with exponential backoff) |
| 58 | **ModuleRegistry (Phase 2)** | ✅ Complete (v1.18.0) | Phase 6 | Plugin-based agent loading — 14 built-in agent modules, `register()` / `load()` / `unload()` lifecycle |
| 59 | **EventBus (Phase 3)** | ✅ Complete (v1.19.0) | Phase 6 | Structured observability — 37+ typed events, 4 built-in consumers (Logger, Metrics, Audit, MetricsBuffer) |
| 60 | **ReportModule (Phase 4)** | ✅ Complete (v1.20.0) | Phase 6 | 4 output formats (markdown, JSON, summary, verbose) — extractable from buildResult() |
| 61 | **InspectModule (Phase 5)** | ✅ Complete (v1.20.0) | Phase 6 | Keyword scanning + LLM-based file classification — ContextGatherer wrapper with depth-limited walk |
| 62 | **VerifyModule (Phase 6)** | ✅ Complete (v1.21.0) | Phase 6 | 4 check types (security, goal-alignment, tests, code-quality) — configurable strictness, pass/fail scoring |
| 63 | **PlanModule + EditModule (Phase 7)** | ✅ Complete (v1.22.0) | Phase 6 | Goal decomposition + file change generation — AST validation, token budget, model-switch support, 75 tests |
| 64 | **ExecuteModule + TestModule (Phase 8)** | ✅ Complete (v1.23.0) | Phase 6 | Command execution + sandboxed testing — 5-strategy inference, multi-framework parsing, 51 tests |
| 65 | **SafeExecutionLayer (Phase 9)** | ✅ Complete (v1.26.0) | Phase 6 | 3-domain safety system — file validation (size, gitignore, syntax, security), Docker sandbox (resource limits, container lifecycle), safe LLM calls (injection guardrail, retry with backoff) |
| 66 | **CredentialStore (Phase 10)** | ✅ Complete (v1.29.0) | Phase 10 | Interactive Git/npm credential collection — GIT_ASKPASS setup, SSH agent, .npmrc token injection, auto-detection from env vars |
| 67 | **PhaseExecutionEngine (Phase 10)** | ✅ Complete (v1.29.0) | Phase 10 | Multi-goal project scope execution — save/resume across restarts, progress tracking, credential management |
| 68 | **`buff publish` (Phase 10)** | ✅ Complete (v1.29.0) | Phase 10 | 5-phase autonomous pipeline — test → version bump → git commit/tag/push → npm build/publish → GitHub release |
| 69 | **`buff phase` (Phase 10)** | ✅ Complete (v1.29.0) | Phase 10 | Phase-wise project execution CLI — create/execute/resume/status/list/delete with interactive pauses |
| 70 | **Cross-Platform Dependency Installer** | ✅ Complete (v1.38.0) | v1.38.0 | Runner auto-installs missing project dependencies (11 manifest types, lockfile-first priority) and bootstrap-installs missing package managers (npm, pip, bundler, cargo, go, composer, dart, brew) via brew/apt/dnf/yum/winget/choco/rustup — with failed-command fallback and honest PATH diagnostics |
| 71 | **Deps Installed Dashboard Metric** | ✅ Complete (v1.38.0) | v1.38.0 | Agent Evaluation section shows dependency-install success rate (`dependencyInstallRate`) alongside tests / composite / recovery / rollbacks |
| 72 | **Auto Model Routing** | ✅ Complete (v1.39.0) | v1.39.0 | `Auto` model selection — the agent picks the best provider/model per task across 5 dimensions (reasoning, speed, cost, privacy, reliability) weighted by detected complexity. Real per-token provider pricing feeds the cost dimension; benchmark quality + per-agent best-model stats adjust scores at runtime. `buff model switch auto`, per-message routing in `buff chat`, and per-task routing in `buff execute -m auto` / `--auto-route` |
| 73 | **Routing Eval Mode** | ✅ Complete (v1.40.0) | v1.40.0 | `buff eval --routing` evaluates the exact provider/model pairs the Auto router picks per eval task — each distinct pick runs the full Agent Evaluation framework (real pipeline + hidden tests) and is ranked by composite score, closing the routing→reliability loop |
| 74 | **Routing History Store** | ✅ Complete (v1.40.0) | v1.40.0 | `~/.buff/memory/routing-history.json` records every Auto router decision (chat, orchestrator, explain, benchmark, eval) — capped at 500, best-effort writes, powers the dashboard's usage stats and audit trail |
| 75 | **Routing Usage + Audit Trail Dashboard** | ✅ Complete (v1.40.0) | v1.40.0 | Routing panel gains two views: actual picks over time (totals, last-24h, per-provider/model/source counts) and a 30-entry audit timeline of explain snapshots + routing-mode picks |
| 76 | **Promotion Gate Dashboard** | ✅ Complete (v1.42.1) | v1.42.1 | The 🤖 Routing panel renders a live 🎖️ Promotion Gate card — bandit-vs-heuristic A/B verdict (quality >+2%, cost <+1%, latency <+5% criteria, promoted/collecting-data states) over `router-promotion.jsonl` trajectories; unmeasured latency shows a neutral chip |
| 77 | **Routing Component Tests + CI Guard** | ✅ Complete (v1.42.1) | v1.42.1 | First dashboard frontend unit tests (vitest 3 + jsdom + Testing Library) covering PromotionGateSection states; `test-linux.yml` gains a dedicated routing regression-guard step (bandit/promotion-gate/auto-router/tier-0) running before the full suite |
| 78 | **Learning-Router Escalation + Per-Model Priors** | ✅ Complete (v1.42.0) | v1.42.0 | ruflo ADR-149 mirror — the bandit learns per concrete **model** (`modelPriors[complexity][modelId]`), not just per provider; when the winner is unlearned (α+β < 8) Auto routing escalates to the next-ranked provider that HAS learned data, guarded by a 0.55 win-rate floor |
| 79 | **Promotion Gate / A/B Validation** | ✅ Complete (v1.42.0) | v1.42.0 | ruflo ADR-150 mirror — records BOTH the deterministic pick and the bandit pick per task, finalizes with the real outcome, and evaluates ruflo's three promotion criteria (quality ↑ >2%, cost regression <1%, latency <5%) over diverged decisions — answers "is the bandit actually better?" |
| 80 | **Startup Progress Feedback** | ✅ Complete (v1.43.0) | v1.43.0 | First launch never looks like a silent hang — a live spinner reports each startup phase (plugins → history & search → semantic index); Ora auto-suppresses when stdout isn't a TTY |
| 81 | **Auto-Mode Session Failover** | ✅ Complete (v1.43.0) | v1.43.0 | Providers whose key expires or rate-limits mid-session are remembered and routed around — auth failures excluded for the session, rate-limit failures for a 120s cooldown, 5xx/network through the circuit breaker; crash-proof re-route |
| 82 | **Central Quota Ledger** | ✅ Complete (v1.44.0) | v1.44.0 | Tokens/requests per provider × model with calendar-aware reset windows; exhausted providers **parked** until the window rolls (auto re-enable); write-through from CostTracker; persists to `quota-ledger.json` |
| 83 | **Predictive Quota-Aware Routing + Free/Local-First Gate** | ✅ Complete (v1.44.0) | v1.44.0 | Auto routing sinks parked providers below healthy candidates BEFORE a call; `routing.allowPaid: false` excludes paid providers for non-complex tasks |
| 84 | **Per-Subtask Complexity Labels** | ✅ Complete (v1.44.0) | v1.44.0 | The Planner emits a `complexity` label per TaskStep (trivial → critical); the orchestrator labels any unlabeled step and threads it into routing as `complexityHint` so each subtask routes by its OWN complexity |
| 85 | **Quota CLI + Cost Transparency** | ✅ Complete (v1.44.0–v1.45.2) | v1.45.x | `buff model quota` (status table, resets in, parked state, `--json`, `reset`) + cost summary (free/local vs paid tokens + estimated $ saved); dashboard Quota card shows free-tier share |
| 86 | **Checkpoint / Resume** | ✅ Complete (v1.45.0) | v1.45.0 | `buff execute --checkpoint` saves a resume-able snapshot after every task batch; `--resume [id]` rehydrates the vault and continues from the first pending step — crash/quota-kill/token-expiry continuity |
| 87 | **Quota Failover Timeline** | ✅ Complete (v1.45.3–v1.45.4) | v1.45.x | Persistent event log (`quota-events.jsonl`, capped 200) records park/re-enable/release/failover events; dashboard Failover Timeline card + `buff model quota` last-20; real-time `quota` SSE events |
| 88 | **Opt-in Failover Confirmation** | ✅ Complete (v1.45.5) | v1.45.5 | `routing.promptOnFailover: true` makes Auto mode ASK before a mid-session provider swap (switch recommended / pick manually) — interactive chat loop AND one-shot Auto prompts |
| 89 | **Always-On Dashboard Quota Watcher** | ✅ Complete (v1.46.0) | v1.46.0 | `routing.alwaysWatchQuota` arms the quota file watcher at server start, never disarmed by client count — Failover Timeline is current the moment a dashboard connects |
| 90 | **Vector Retrieval (Token-Efficient Context)** | ✅ Complete (v1.47.0) | v1.47.0 | Chunking (~512 tokens, paragraph-aware, 64 overlap) + local embeddings (`bge-small-en-v1.5`, 384-dim) + top-k reduction before the LLM call; small contexts pass through untouched; any failure fails over to full context. `buff retrieval index/query/stats/clear` + dashboard 🧠 Retrieval card |
| 91 | **VectorStore Namespaces** | ✅ Complete (v1.47.0) | v1.47.0 | Each namespace gets its own index file (`vectors-<ns>.json`) so repo retrieval chunks never pollute memory/history vectors; entry format unchanged so existing vectors survive upgrades |
| 92 | **VS Code Quota Ledger View** | ✅ Complete (v0.5.0–v0.6.1) | v0.6.x | VS Code extension renders the quota ledger (free/paid usage, parked providers, failover timeline) with live auto-refresh on ledger/timeline change + poll-fallback |
| 93 | **FAISS-Backed Vector Store** | ✅ Complete (v1.48.0) | v1.48.0 | `VectorStoreBackend` interface with pluggable tiers — **faiss-native** (`@faiss-node/native` real FAISS) → **faiss-ivf** (pure-JS IVF-flat ANN) → **json** (exact flat cosine, original behavior). Auto-selected in that priority order; lazy backend resolution, same JSON entry format, fully backward-compatible. `routing.vectorBackend` / `BUFF_VECTOR_BACKEND` overrides |
| 94 | **FAISS Benchmark + Recall Validation** | ✅ Complete (v1.49.0) | v1.49.0 | 2,000-vector corpus benchmark — exact JSON ground truth recall@5 ≥ 0.99, IVF recall@5 ≥ 0.9 / recall@1 ≥ 0.8, latency logged; hermetic memory test suite (temp BUFF_MEMORY_DIR) |
| 95 | **Native FAISS Tier Activation** | ✅ Complete (v1.49.1) | v1.49.1 | Native tier rewritten for the real `@faiss-node/native` v0.1.11 API (`FaissIndex` FLAT_IP, async add/search, L2-normalize → cosine) so the installed native module is actually used — was silently falling back to pure-JS IVF; `buff memory backend --check` diagnostics |
| 96 | **`buff memory backend` Diagnostics CLI** | ✅ Complete (v1.50.0) | v1.50.0 | `buff memory backend` shows the active vector-search backend (faiss-native / faiss-ivf / json) and why it was chosen; `--check` runs a native-FAISS availability probe with install guidance; `checkNativeFaiss()` exported from the package API |
| 97 | **README Core-Edge Marketing** | ✅ Complete (v1.50.0) | v1.50.0 | "Why Agent-Nuvira? (The Core Edge)" — punchy feature pitch covering 17+ providers, 17-agent swarm, learning router, tier-0 routing, FAISS indexing, MCP, team collaboration, and the no-server/no-telemetry promise |
| 98 | **Shared Failover Machinery (Nuvira-Router P0-M0.2)** | ✅ In progress (M0.2 complete) | next release | One `recordActionFailure()` composes EVERY LLM-call failure identically (session exclusion → quota-ledger park → per-action registry write-through → failover timeline → circuit breaker); one `runSingleShotAuto()` walks the auto-router's ranked candidates for any failure class. `buff chat`, `buff plan`, and `buff execute` (orchestrator per-task + follow-up suggestions) all route through them — a mid-pipeline 429 parks the provider so the next task skips it predictively, and a provider that failed earlier in a pipeline never wins a later task (resolve-time consultation). Full regression gate in CI |
| 99 | **Capability-Aware Scoring (Nuvira-Router P2-M2.1)** | ✅ Complete (M2.1) | next release | Soft task-type → capability fit signal in Auto routing: required model-catalog tags per task type (plan→reasoning, code-review→code+reasoning, quick edit→code…) matched against each provider's tags (static ∪ derived from its REAL capability profile; unknown providers stay neutral until real data). Clamped soft multiplier — nudges equally-scored candidates, never overturns dimension weights. Reversible `routing.capabilityFit` gate (default ON); `models explain` shows `🎯 fit N%` per ranked provider |
| 103 | **Context-Length Preflight (Nuvira-Router P2-M2.5)** | ✅ Complete (M2.5 + followup) | next release | The router scores each provider's nominal input context window against the task's estimated prompt size before picking — the genuine gap Copilot identified. Built-in per-model/per-provider window tables with `routing.contextWindows` overrides (model or provider keys); the estimate uses the caller's `contextHintTokens` when the real payload is known — chat (growing conversation + full prompt), `buff plan` (the actual built prompt incl. parsed codebase context), and the orchestrator's per-task workspace payload (goal + task description + stat-sized context files) — else the task text. SOFT, estimation-only, NEVER a hard block: neutral below 50% utilization (normal tasks never shift a ranking), ramp to a capped 35% penalty; models may exceed nominal windows. Reversible `routing.contextFit` gate (default ON). `models explain` shows a ⏳ ctx chip per ranked row + a Context-preflight section + JSON `context` (basis task|hint, per-provider window/utilization/fit); fallback chains carry `contextWindowTokens`; `buff config set routing.contextWindows.<model|provider> <tokens>`. A 500K-token payload flips privacy-first local → gemini (1M window) |
| 102 | **Governance Constraints (Nuvira-Router P2-M2.4)** | ✅ Complete (M2.4) | next release | Admin routing policy via `routing.governance` — provider allow/deny lists, model allow/deny lists (enforced against the model actually served: the configured pin wins over curated defaults, so a pinned violator dies even if a default would pass), admin per-call max-cost cap, and a PII-domain block (privacy ≥ `minPrivacyForPii`, local-only default). All are HARD eliminations: when a rule eliminates every candidate the router REFUSES to serve a violator (`PIIPolicyError` / `GovernancePolicyError` with the full `governanceBlocked` audit trail; only per-call soft options fall back benignly). `models explain` renders policy blocks cleanly (human audit trail + JSON error object); `buff plan` rethrows instead of degrading around a block; `buff models unblock` respects `allowUnblock: false` (admin-hard gate) and warns when the provider is on an admin deny list; dashboard Quota panel shows parked key-accounts; `buff config set providers.<name>.apiKeys` + `routing.governance.*` |
| 101 | **Multi-Account Key Rotation (Nuvira-Router P2-M2.3)** | ✅ Complete (M2.3) | next release | A provider can carry MULTIPLE API keys (`apiKeys: []` beside the primary `apiKey`); the shared failover walk rotates through every non-parked key BEFORE switching providers — a rate-limited/auth-dead ACCOUNT is parked by fingerprint (`accountIdForKey`, raw keys never persisted) and the next key is tried (`🔑 key#N` logging); the next run skips parked accounts predictively; `options.apiKey` overrides at the adapter level (Groq/NIM/Nuvira gateway); single-key/keyless behavior unchanged; hermetic E2E drives a mock gateway keyed on the Authorization header |
| 100 | **Wire-Token Cost Metering (Nuvira-Router P2-M2.2)** | ✅ Complete (M2.2) | next release | OpenAI-compatible adapters (Nuvira gateway, Groq, NIM) capture provider-reported `usage` (response body + final SSE chunk) and record EXACT tokens; Auto routing's cost scoring uses measured tokens instead of the TYPICAL estimate when real usage exists (`costSource: measured|estimated` in `models explain`); dashboard cost panel splits 📏 measured vs 📐 estimated spend per call + provider; hermetic E2E proves the loop against a mock gateway |

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
| **Skill Compiler System** | v1.14.6 | Auto-extract reusable patterns → runnable skills |
| **Context-Window Pruner** | v1.14.6 | Automatic token compression for long agent chains |
| **Model Switching** | v1.14.6 | Context-preserving mid-session provider switching |
| **Project Scaffolding** | v1.14.6 | 5 built-in templates with provider wizard |
| **Docker Compose Onboarding** | v1.14.6 | 5-minute containerized setup |
| **Security Scan CLI** | NextLevel | PII, injection, and dangerous code detection with severity thresholds and `--json` output |
| **Feedback & Rating System** | NextLevel | User feedback collection with record/list/stats/clear lifecycle and score impact for routing |
| **Marketplace Unified CLI** | NextLevel | Unified plugin + workflow template browsing, search, install, and info from a single entry point |
| **Cross-Platform Dependency Installer** | v1.38.0 | Runner bootstrap-installs missing package managers (brew/apt/winget/rustup) and installs project deps automatically |
| **Tool-Install Unit Tests** | v1.38.0 | 20 tests covering npm/pip/bundler/cargo/go/dart/brew bootstrap paths, failure propagation, PATH diagnostics |
| **Auto Model Routing** | v1.39.0 | `Auto` model selection — agent decides the best provider/model per task; 5-dimension scoring with complexity weights, real provider pricing, preference modes (balanced / performance-first / cost-first / privacy-first), circuit-breaker cooldown deprioritization, benchmark + agent-stats runtime adjustment |
| **Configurable Routing Pricing** | v1.39.2 | Override any provider's per-1K-token pricing via `buff config set pricing.<provider>.inputPer1K|outputPer1K` — real rates feed the Auto router's cost dimension (free tiers default to $0) |
| **Model Explain Command** | v1.39.2 | `buff model explain [task]` shows why Auto routing picked a provider/model — complexity, dimension weights, ranked providers, fallback chain; walks all 5 complexity levels without a task |
| **Dashboard Routing Insights** | v1.39.2 | New `GET /api/routing` endpoint + 🤖 Routing dashboard panel — per-provider benchmark quality, best model per agent, and Auto-router preference across complexity levels |
| **Routing Benchmark Mode** | v1.39.3 | `buff benchmark --routing` benchmarks the exact provider/model pairs the Auto router picks for each task, then ranks them by measured quality — closing the routing→quality loop (results feed runtime stats) |
| **Model Explain JSON** | v1.39.3 | `buff model explain "<task>" --json` emits a machine-readable payload (weights, ranked providers, winner, fallback chain, effective per-provider pricing with override flags) for scripting and CI |
| **Routing Eval Mode** | v1.40.0 | `buff eval --routing` evaluates each Auto router pick through the full Agent Evaluation framework and ranks picks by composite score — reliability, not just response quality |
| **Routing Usage + Audit Trail** | v1.40.0 | Dashboard Routing panel shows actual picks over time (usage stats) and a 30-entry audit timeline; every explain snapshot and routing-mode pick is persisted to `routing-history.json` |
| **Promotion Gate Dashboard** | v1.42.1 | Routing panel shows whether the learning bandit is actually better than the heuristic — quality/cost/latency A/B verdict over real trajectories |
| **Routing Component Tests + CI Guard** | v1.42.1 | Dashboard frontend unit tests (vitest 3 + jsdom + Testing Library) wired into CI; dedicated routing regression-guard step runs the learning-router tests before the full suite |
| **Learning-Router Escalation + Per-Model Priors** | v1.42.0 | Bandit learns per concrete model; unlearned winners escalate to the next-ranked learned provider (ruflo ADR-149 mirror) |
| **Promotion Gate / A/B Validation** | v1.42.0 | "Is the bandit actually better than the heuristic?" answered on real trajectories with quality/cost/latency criteria (ruflo ADR-150 mirror) |
| **Startup Progress Feedback** | v1.43.0 | Live per-phase startup spinner + model-picker loading progress with per-provider timeouts |
| **Auto-Mode Session Failover** | v1.43.0 | Expired keys / rate-limits mid-session are routed around automatically — no more stuck sessions |
| **Central Quota Ledger** | v1.44.0 | Calendar-aware reset windows, exhaustion parking, predictive quota-aware routing, free/local-first gate, `buff model quota` CLI |
| **Per-Subtask Complexity Labels** | v1.44.0 | Each TaskStep routes by its OWN complexity (trivial → critical) instead of the whole goal's |
| **Checkpoint / Resume** | v1.45.0 | Crash / quota-kill / token-expiry continuity — resume from the first pending step |
| **Quota Failover Timeline + SSE** | v1.45.3–v1.45.4 | Persistent failover event log + live dashboard timeline via real-time SSE pushes |
| **Opt-in Failover Confirmation** | v1.45.5 | Ask before mid-session provider swaps (interactive + one-shot) |
| **Always-On Dashboard Quota Watcher** | v1.46.0 | Quota state current the moment a dashboard connects |
| **Vector Retrieval** | v1.47.0 | Local embeddings + top-k chunk reduction save tokens, stretch free quotas; `buff retrieval` CLI + dashboard card |
| **FAISS-Backed Vector Store** | v1.48.0 | Pluggable backend tiers — real FAISS native bindings when built, pure-JS IVF ANN otherwise, exact JSON fallback; `buff memory backend --check` diagnostics |
| **VS Code Quota Ledger View** | v0.5.0–v0.6.1 | Live free/paid usage + failover timeline inside the editor |

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
Skill Compiler           ░░░░░░ ██████████ ██████████
Context Pruner           ░░░░░░ ██████████ ██████████
Model Switching          ░░░░░░ ██████████ ██████████
Project Scaffolding      ░░░░░░ ██████████ ██████████
Docker Deployment        ░░░░░░ ██████████ ██████████
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
| Google Gemini | Gemini REST | ✅ | 5+ | < 2s | Free tier (60 req/min) |
| OpenRouter | OpenAI-compatible REST | ✅ | 200+ | Varies | Free credits on signup |
| Local (Ollama) | Ollama REST | ✅ | Any | Varies (HW-dependent) | Free |
| **12 more via env vars** | OpenAI-compatible REST | ✅ | Varies | Varies | API-key-dependent |

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

### 4.5 Vector Store Search Algorithm (FAISS-Backed Tiers)

The vector store (`src/memory/vector-store.ts` + `faiss-backend.ts`) exposes a
pluggable backend, auto-selected per machine in priority order:

| Priority | Backend | Implementation | Notes |
|---|---|---|---|
| 1 | `faiss-native` | `@faiss-node/native` (`FaissIndex` FLAT_IP) | Vectors L2-normalized so inner product = cosine; requires the native addon to build + pass a load-time smoke test (v1.49.1 fixed the silent-fallback bug) |
| 2 | `faiss-ivf` | Pure-JS IVF-flat ANN (no native deps) | Default fast path when native is unavailable |
| 3 | `json` | Exact flat cosine over `vectors-<ns>.json` | Original behavior; always works; zero data migration |

**Exact JSON tier — cosine similarity search (original behavior):**

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

**Backend behaviors:**
- **Auto-selection** — `createFaissBackend()` tries `faiss-native` first; load
  or smoke-test failure falls back to `faiss-ivf`, then `json` (same entry
  format, no migration). Overridable via `routing.vectorBackend` /
  `BUFF_VECTOR_BACKEND`.
- **Diagnostics** — `buff memory backend` prints the active backend and why it
  was chosen; `--check` runs a native-FAISS availability probe;
  `checkNativeFaiss()` is exported from the package API.
- **Namespaced indexes** — `vectors-<ns>.json` per namespace, so repo retrieval
  chunks never pollute memory/history vectors.
- **Benchmark-validated** — 2,000-vector corpus: exact JSON recall@5 ≥ 0.99,
  IVF recall@5 ≥ 0.9 / recall@1 ≥ 0.8.

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
| Full test suite (1620 tests) | 58s | 70s | Parallelized across 47 test files |

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
| **v1.0.0** | Initial | Core CLI with chat, 5 built-in providers (expandable to 17+ via plugins), config, models |
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
| **v1.14.6** | | Skill Compiler, Context Pruner, Model Switching, Docker, `buff init` |
| **v1.15.0** | Aug 2026 | npm publishing — `npx agent-nuvira` / `npx buff` live on npm |
| **v1.15.1** | Aug 2026 | Interactive dev mode — model picker, session tracking, /save / /resume, /suggest |
| **v1.15.2** | Aug 2026 | Windows compatibility fixes for runner and sandbox |
| **v1.15.3** | Aug 2026 | Accessibility fix — `window.open` to native `<a>` tags |
| **v1.15.4** | Aug 2026 | Search/filter bar, column count toggle, speech provider section |
| **v1.15.5** | Aug 2026 | SSE header support for MCP |
| **v1.15.6** | Aug 2026 | Firecrawl integration for web search |
| **v1.16.0** | Aug 2026 | Comprehensive MCP README docs, SSE header support, Firecrawl integration |
| **v1.16.1** | Aug 2026 | Interactive dev mode enhancements — failure analysis, follow-up suggestions, /fix command, 35 new unit tests |
| **v1.17.0–v1.41.2** | Aug–Oct 2026 | Modular architecture Phases 6–11 (ModuleRegistry, EventBus, ReportModule, VerifyModule, SafeExecutionLayer, TS structural editing), provider fallback, Auto routing v1.39, routing eval + history v1.40, per-provider model drill-down v1.41 |
| **v1.42.0** | Aug 2026 | Learning-router escalation + per-model bandit priors + promotion gate (ruflo ADR-149/150 mirrors) |
| **v1.42.1** | Aug 2026 | Promotion-gate dashboard card + CI routing regression guard + first dashboard component tests |
| **v1.43.0** | Aug 2026 | Startup progress feedback, model-picker loading progress, 60s model-list cache, auto-mode failover on token expiry |
| **v1.44.0** | Aug 2026 | Central quota ledger (parking + window resets), predictive quota-aware routing, free/local-first gate, per-subtask complexity labels, `buff model quota` CLI |
| **v1.45.0** | Aug 2026 | Checkpoint / resume pipelines + dashboard quota cost-transparency card |
| **v1.45.1** | Aug 2026 | Fix: `--checkpoint` no longer silently resumes a stale completed checkpoint |
| **v1.45.2** | Aug 2026 | Quota cost-summary CLI (`getCostSummary`), checkpoint CLI smoke tests, sandbox skips npm install for zero-dep projects |
| **v1.45.3** | Aug 2026 | Quota failover timeline — persistent event log + dashboard Failover Timeline card + CLI timeline |
| **v1.45.4** | Aug 2026 | Real-time quota events over SSE — instant Failover Timeline updates |
| **v1.45.5** | Aug 2026 | Opt-in failover confirmation (`routing.promptOnFailover`) — control over every auto-mode swap |
| **v1.46.0** | Aug 2026 | Always-on dashboard quota watcher + single-shot Auto failover confirmation |
| **v1.47.0** | Aug 2026 | Vector retrieval — token-efficient context via local embeddings + pure-JS vector store; `buff retrieval` CLI + dashboard Retrieval card |
| **v1.48.0** | Aug 2026 | FAISS-backed vector store — pluggable backend tiers (faiss-native → faiss-ivf → json), lazy resolution, config override, backward-compatible entry format |
| **v1.49.0** | Aug 2026 | FAISS follow-ups — hermetic memory test suite, IVF-vs-exact recall benchmark, cross-session backend transparency |
| **v1.49.1** | Aug 2026 | Native FAISS tier actually activates — rewritten for the real `@faiss-node/native` v0.1.11 API; `buff memory backend --check` |
| **v1.50.0** | Aug 2026 | `buff memory backend` diagnostics CLI — active backend, why it was chosen, native-FAISS availability probe (`--check`) + install guidance |
| **v1.51.0** | Aug 2026 | Routing strategy super-enhancement — Thompson-sampling bandit, uncertainty escalation, per-model learning, promotion gate A/B, routing rules, hard constraints, credential-aware filtering, quota-ledger integration, runtime stats blending, verification escalation, free/local-first gate; 2,934 tests |
| **v1.51.1** | Aug 2026 | Docs patch — completed the published README version-history table (added v1.50.0 + v1.51.0 rows; historical v1.45.5 entry verified and kept) |
| **v1.52.0** | Aug 2026 | Predictive model-availability routing (model registry drives every pick — unkeyed/failed-health models skipped before scoring); web dashboard: scrubbable pipeline phase timeline + narrated routing walkthrough; 2,990 tests |
| **v1.53.0** | Aug 2026 | Per-action "learned from real usage" telemetry everywhere (every LLM call writes which provider × model it killed/verified; `models status --verbose` + dashboard per-action panel with daily timeline); recovery loop (a real success re-verifies + un-parks a recovered provider); hermetic E2E failover test proving "registry learns the block, next pick skips it"; 2,996 tests |
| **v1.54.0** | Aug 2026 | VS Code extension telemetry attribution — IDE-driven calls tagged `ide-chat` / `ide-inline` / `ide-<command>` via `BUFF_TELEMETRY_ACTION` at spawn, so IDE usage gets its own rows in the per-action registry log + dashboard panel; 3,002 tests |
| **v1.55.0** | Aug 2026 | `buff models unblock <provider>` escape hatch — manually release a registry-blocked provider (demote unavailable→unverified, clear quota parks + ledger cooldown, live re-probe with honest `stillBlocked`); also fixed pre-existing `models status --json` / `refresh --json` shadowing bug; 3,011 tests |
| **v1.58.9** | Aug 2026 | P7 M7.4 opt-in gateway telemetry/usage-health flags (`routing.gatewayTelemetry.enabled` / `healthFlags`, OFF by default, privacy-preserving — aggregates only) surfaced via `doctor --enterprise`; 3,232 tests |
| **v1.58.8** | Aug 2026 | **Permanent dashboard connectivity fix** — server binds IPv4 + IPv6 loopback; `localhost` (::1-first on macOS) can no longer refuse |
| **v1.58.7** | Aug 2026 | M4.4 conservative compression (lossless-for-code, off by default) · `partial` mid-stream telemetry · `buff doctor --enterprise` (gateway/secrets/audit/RBAC self-check) · upgrade guide (P7 M7.2) |
| **v1.58.6** | Aug 2026 | Fixed `routing.*` config dropped on reload — `config set routing.*` (bandit/quota/governance/nuviraSidecar) now persists across restarts |
| **v1.58.5** | Aug 2026 | P5 config-key support — `buff config set routing.nuviraSidecar.enabled\|image` |
| **v1.58.4** | Aug 2026 | Nuvira-Router **P5 sidecar** (compose profile + `buff doctor --nuvira`; nuvira in the router universe, keyless gateways) + **P4 resilience core** (mid-stream continuation retry, reasoning-replay cache, context-relay summaries); 3,300+ tests |
| **v1.58.3** | Aug 2026 | Nuvira-Router P3: dashboard Requests panel (per provider×model×action request stats — failures, avg/p50/p95/p99 latency, measured spend) + `models explain --since <ref>` decision diff (candidate score changes, winner changes); 3,161+ tests + 54 dashboard component tests |
| **v1.58.2** | Aug 2026 | Models dashboard "Failed to fetch" repeat fix — resilient panel fetch (per-request timeouts, independent health/registry fetches, backoff retry on transient network failures, self-healing re-poll after failure); 3,161 tests + 48 dashboard component tests |
| **v1.58.1** | Aug 2026 | Dashboard mirrors the CLI `model explain` guarantees — the Auto Router preference panel renders the M2.x chips (🎯 fit / 📏 measured·📐 estimated / ⏳ ctx) per provider, served by `/api/routing` + `/api/all`; `MODELS_EXPLAIN_DEMO.md` dashboard section; 3,161 tests + 45 dashboard component tests |
| **v1.58.0** | Aug 2026 | Nuvira-Router P2: capability-aware scoring (`routing.capabilityFit`), wire-token measured-cost inputs (provider-reported `usage` beats estimates; 📏 measured vs 📐 estimated in `models explain` + dashboard), multi-account key rotation (`apiKeys[]`, dead accounts parked + predictively skipped), governance constraints (`routing.governance` — allow/deny lists, admin max-cost cap, PII-domain block; policy violators refused via `PIIPolicyError`/`GovernancePolicyError`), context-length preflight (`routing.contextFit` — nominal window vs estimated payload, `⏳ ctx N%` chip); also carries the v1.57.0 dashboard `--force`/`--port` fixes (staged but never published); 3,159 tests + 42 dashboard component tests |
| **v1.57.0** | Aug 2026 | `buff dashboard --force` — detect a STALE dashboard on the port (API/SSE mismatch: /api/model-registry answers SPA HTML instead of JSON) and offer to restart it: probe classifies port state (never touches current dashboards or non-dashboard processes), confirms, kills the PID, waits for the port to free, and re-binds a fresh server; also fixed the pre-existing `--port` bug — the server bound the import-time 3030 default, now it resolves the bind at call time from explicit overrides; 3,032 tests + 42 dashboard component tests |
| **v1.56.1** | Aug 2026 | Dashboard Models-panel crash fix — stale-server HTML for an unknown /api/* route broke `res.json()` ("Unexpected token '<'"): unknown /api/* now returns JSON 404, all /api/* responses parse through a shared defensive helper, and `buff dashboard` surfaces a clear EADDRINUSE message; 3,011 tests + 42 dashboard component tests |
| **v1.56.0** | Aug 2026 | Dashboard per-action telemetry timeline is now scrubbable — drag across days, click a day, or use the range slider to see that day's exact verified/killed chips (which provider × model each action killed or verified), with ▶ play/pause day-by-day sweep; 3,011 tests + 39 dashboard component tests |
| **v0.5.0–v0.6.1** (VS Code ext) | Aug 2026 | VS Code quota ledger view — free/paid usage, parked providers, failover timeline, live auto-refresh + poll-fallback |

### 5.2 Detailed Changelog (v1.14.x – v1.16.x)

#### v1.14.6 — Skill Compiler, Context Pruner, Model Switching, Docker, `buff init`
- **Feature:** Skill Compiler — auto-extracts reusable patterns from successful trajectories into parameterized skill scripts
- **Feature:** Context-Window Memory Pruner — 5 strategies (metadata strip, file collapse, conversation truncation, artifact summarize, aggressive fallback) prevent long chains from exceeding token limits
- **Feature:** Context-Preserving Model Switching — `buff model switch` changes providers mid-session without losing agent state
- **Feature:** Docker Compose Setup — 5-minute onboarding with multi-stage Dockerfile, health checks, persistent volume
- **Feature:** Project Scaffolding — `buff init` with 5 built-in templates and interactive provider selection wizard
- **Tech:** Skill Store with decay scoring, garbage collection, and keyword search
- **Tech:** Token estimation heuristic with 1-token-per-4.5-char ratio
- **Tests:** 156 new tests (84 skill system + 72 context pruner), 1479 total

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
| **Total tests** | 1830+ |
| **Test files** | 55 |
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
| Skill System | 84 | Skill compiler, store, runner agent, parameter resolution |
| Context Pruner | 72 | All 5 pruning strategies, edge cases, threshold behavior |
| GitHub Release | 22 | Version detection, branch detection, release notes |
| Security | 45 | Injection detection, secret scanning, severity levels |
| Memory | 93 | Vector search, trajectory storage, embedder, memory integration |
| Inference | 200+ | Provider adapters, model catalog, factory |
| Config | 14 | Load/save, env var merging, type validation |
| CLI | 30+ | Dashboard, model picker, workflow commands |
| Workflow | 224 | Template parsing, variable substitution, CLI structure |
| Sandbox | 23 | Container lifecycle, resource limits |
| Plugins | 13 | Registration, provider creation, discovery |
| Agent SDK | 23 | Type compatibility, scaffolding, registration |
| Web Dashboard | 43 | Server API, SSE, DAG store, frontend |
| Chat History | 67 | Session storage, keyword/semantic search, pruning, retention |
| Team Collaboration | 70 | Shared config, git-synced memory, review lifecycle, error handling |
| Federation | 45 | Handshake, task delegation, cancellation, health, protocol |
| Hybrid Router | 35 | Complexity analysis, fallback chain, budget check, consensus |
| Embedder | 23 | Tier detection, caching, fallback chain, graceful degradation |
| Provider CLI | 18 | Provider list (7), health diagnostics (11) |
| Provider Fallback | 71 | Error classification, fallback chain, circuit breaker, callWithFallback, singleton |
| Security Scan CLI | 14 | Security scan: inline text, flags, file input, JSON output, edge cases |
| Feedback CLI | 20 | Feedback: record, list, stats, clear; skip, score impact, trajectory filter |
| Marketplace CLI | 18 | Marketplace: browse, search, install, info; network errors, not found, no results |

### 6.3 Quality Gates

| Gate | Requirement | Status |
|---|---|---|
| TypeScript strict compilation | `tsc --noEmit` passes | ✅ |
| Full test suite | 1830+ tests pass | ✅ |
| Lint (planned) | ESLint / Prettier | 🟡 In progress |
| CI (Linux) | GitHub Actions | ✅ |
| CI (Windows) | GitHub Actions | ✅ |
| CI (macOS) | GitHub Actions | ✅ Complete |
| Coverage threshold | > 80% | 🟡 In progress |

---

## 7. Completed Roadmap

All 30 planned phases have been implemented as of **August 2026**. See [UPGRADE_ROADMAP.md](./UPGRADE_ROADMAP.md) for the full implementation journey.

### 7.1 Phase 1: Quick Wins (8 items, all ✅ Complete)

| # | Feature | Description |
|---|---|---|
| 1.1 | **Auto-Discovery Plugin Loader** | Drop-in `.js` files → auto-register at startup |
| 1.2 | **Complete Streaming Support** | All 17+ providers support real-time token-by-token output |
| 1.3 | **Cost Tracking** | Per-provider/session/monthly costs with `buff stats cost` |
| 1.4 | **`buff init`** | Interactive project scaffolding with 5+ templates |
| 1.5 | **Prompt History Search** | Keyword + semantic search across past conversations |
| 1.6 | **Skill Compiler** | Auto-extracts reusable patterns from trajectories |
| 1.7 | **Context-Window Memory Pruner** | Token-aware compression for long agent chains |
| 1.8 | **Model Switching** | Context-preserving mid-session provider changes |

### 7.2 Phase 2: Structural Changes (6 items, all ✅ Complete)

| # | Feature | Description |
|---|---|---|
| 2.1 | **Native Embedding Support** | 3-tier embedder (Xenova/Python/LLM) for 10x faster search |
| 2.2 | **Workflow Template Marketplace** | 10 built-in templates + GitHub registry |
| 2.3 | **Model Benchmarking** | 21 coding tasks, scoring, and A/B comparison |
| 2.4 | **Docker Sandbox Isolation** | Resource-limited, network-isolated containers, 8 images |
| 2.5 | **Provider Health Dashboard** | `buff doctor` with color-coded status and watch mode |
| 2.6 | **Memory Compression & Pruning** | Automatic trajectory summarization with retention policies |

### 7.3 Phase 3: Major Upgrades (11 items, all ✅ Complete)

| # | Feature | Description |
|---|---|---|
| 3.1 | **VS Code Extension** | 9 commands, inline suggestions, diff viewer, agent panel |
| 3.2 | **Remote Agent Federation** | Multi-machine collaboration via TCP protocol |
| 3.3 | **Web UI Dashboard** | React dashboard with DAG, health, cost, history, benchmarks |
| 3.4 | **Hybrid Model Routing** | Complexity-based model selection with fallback chains |
| 3.5 | **Team Collaboration** | Git-synced config, memory, and review pipelines |
| 3.6 | **Agent SDK** | `@agent-nuvira/sdk` npm package with scaffolding CLI |
| 3.7 | **Provider CLI** | `buff provider list` (color-coded table) + `buff provider health` |
| 3.8 | **Provider Fallback Routing** | Auto-failover between providers with circuit breaker |
| 3.9 | **Security Scan CLI** | `buff security scan` — PII, injection, dangerous code detection |
| 3.10 | **Feedback & Rating System** | `buff feedback record/list/stats/clear` lifecycle |
| 3.11 | **Marketplace Unified CLI** | `buff marketplace browse/search/install/info` — unified discovery |

### 7.4 Phase 4: Industry Standards (6 items, all ✅ Complete)

| # | Feature | Description |
|---|---|---|
| 4.1 | **MCP Protocol Integration** | Model Context Protocol client/manager with stdio + SSE transport + Firecrawl |
| 4.2 | **AST-Aware Code Editing** | Structural analysis engine for JS/TS/Python/Go/Rust |
| 4.3 | **Auto Error-Repair Engine** | Automatic diagnosis and repair of test failures with retry budgets |
| 4.4 | **A2A Protocol** | Agent-to-Agent communication standard for inter-agent coordination |
| 4.5 | **CI/CD Headless Mode** | `buff ci` with structured JSON output and GitHub Actions integration |
| 4.6 | **npm Publishing** | `npx agent-nuvira` / `npx buff` — zero-setup one-line onboarding |

### 7.5 Phase 5: Interactive UX (5 items, all ✅ Complete)

| # | Feature | Description |
|---|---|---|
| 5.1 | **Interactive Dev Mode** | `buff execute` without goal — model picker, guided loop, session tracking |
| 5.2 | **Session Save/Resume** | `/save <name>` / `/resume <name>` — full history and model state across restarts |
| 5.3 | **Failure Analysis** | Per-agent-type diagnosis with specific recovery actions (rephrase, switch model, auto-fix) |
| 5.4 | **Follow-up Suggestions** | LLM-powered contextual next-step recommendations after goal execution |
| 5.5 | **/fix Command** | Retry last failed goal with failure context — shows post-execution analysis |

### 7.6 Phase 6: Architecture Migration (8 modules, all ✅ Complete)

| # | Module | Version | Description |
|---|---|---|---|
| 6.1 | **RecoverModule** | v1.18.0 | Extracted from ErrorRepairEngine — discriminated union strategies + RepairBudget (3 attempts with exponential backoff) |
| 6.2 | **ModuleRegistry** | v1.18.0 | Plugin-based agent loading — 14 built-in agent modules, `register()` / `load()` / `unload()` lifecycle, EventBus integration |
| 6.3 | **EventBus** | v1.19.0 | Structured observability — 37+ typed events, 4 built-in consumers (Logger, Metrics, Audit, MetricsBuffer), typed event schema |
| 6.4 | **ReportModule** | v1.20.0 | 4 output formats (markdown, JSON, summary, verbose) — extractable from buildResult(), 72 unit tests |
| 6.5 | **InspectModule** | v1.20.0 | Keyword scanning + LLM-based file classification — ContextGatherer wrapper with depth-limited walk, .buffignore support, 74 tests |
| 6.6 | **VerifyModule** | v1.21.0 | 4 check types (security, goal-alignment, tests, code-quality) — configurable strictness (low/medium/high), pass/fail scoring (0.5/0.7/0.9), 28 tests |
| 6.7 | **PlanModule + EditModule** | v1.22.0 | Goal decomposition (3 JSON parsing strategies) + file change generation (AST validation, token budget, model-switch support) — 75 tests |
| 6.8 | **ExecuteModule + TestModule** | v1.23.0 | Command execution (5-strategy inference, npm validation) + sandboxed test execution (vitest/jest/generic parsing) — 51 tests, EventBus events |

**Migration architecture:** 8 monolithic agents → 9 extracted modules with `interface` + `Default*` class pattern, optional EventBus injection, lifecycle event emissions, and comprehensive test coverage (126+ module tests).

### 7.7 Phase 9: Safe Execution Layer (1 module, ✅ Complete)

| # | Module | Version | Description |
|---|---|---|---|
| 9.1 | **SafeExecutionLayer** | v1.26.0 | 3-domain safety system wrapping all agent operations — file validation (size guard, gitignore check, AST syntax validation, security scan), Docker sandbox (SandboxManager integration with resource limits and container lifecycle), safe LLM calls (injection guardrail via `runAllScans`, prompt/response truncation, exponential backoff with circuit breaker for auth errors). 10 EventBus events (SAFE_EXEC_FILE_VALIDATED, SAFE_EXEC_SANDBOX_STARTING/CREATED/COMPLETED/FAILED, SAFE_EXEC_LLM_STARTING/BLOCKED/RETRY/COMPLETED/FAILED). 23 unit tests. |

**Safe execution architecture:** All LLM calls, file operations, and command execution pass through SafeExecutionLayer for consistent safety enforcement. The layer integrates with existing SecurityScanner (injection detection), SandboxManager (Docker execution), and AST validation engine.

### 7.8 Phase 10: Autonomous Publish & Phase-Wise Execution (4 items, ✅ Complete)

| # | Feature | Description |
|---|---|---|
| 10.1 | **CredentialStore** | Interactive secret-free credential collection — auto-detects `GITHUB_TOKEN`/`GH_TOKEN`/`NPM_TOKEN` from environment, sets up `GIT_ASKPASS` for HTTPS auth, integrates with SSH agent for password-protected keys, writes project-level `.npmrc` with auth tokens, cleans up credentials after publish. |
| 10.2 | **PhaseExecutionEngine** | Manages multi-goal project scopes with sequential phase execution — each phase is a self-contained goal executed via the Orchestrator. State is persisted to `~/.buff/phases/` for pause/resume across restarts. Credentials collected once, reused across all phases. |
| 10.3 | **`buff publish`** | Autonomous release pipeline — collects credentials once, then executes 5 phases: test verification → version bump (patch/minor/major) → git commit/tag/push → npm build/publish → GitHub release. Supports dry-run preview with `--dry-run`. |
| 10.4 | **`buff phase`** | Phase-wise project execution CLI — `create` scopes with ordered goals, `execute` all phases, `resume` after pause, `status` to view progress, `list` saved scopes, `delete` completed scopes. Built-in credential management for publish phases. |

### 7.9 v1.38.0: Cross-Platform Execution & Dependency Automation (3 items, ✅ Complete)

| # | Feature | Description |
|---|---|---|
| 11.1 | **Cross-Platform Dependency Installer** | Runner detects 11 manifest types (npm/pnpm/yarn lockfile-first, pip, bundler, cargo, go, composer, dart pub), installs missing deps on failed commands, and bootstrap-installs missing package managers — Homebrew (macOS), apt/dnf/yum/NodeSource (Linux), winget/choco/MSI (Windows), rustup (Rust), getcomposer.org → `$HOME/.local/bin` (PHP).
| 11.2 | **Command-Based Tool Detection** | Manifest-less directories: parses the failed command's first word (`python3 script.py` → pip) and installs the missing interpreter/tool.
| 11.3 | **Deps Installed Metric** | `dependencyInstallTool` / `dependencyInstallToolInstalled` telemetry on `RunResult` feeding the Agent Evaluation dashboard's `dependencyInstallRate` stat.

---

## 8. Investor-Focused Highlights

### 8.1 Demonstrated Progress

Agent-Nuvira has evolved from a single-agent CLI to a comprehensive multi-agent AI coding platform with:

- **15 specialized AI agents** working in orchestrated pipelines (Planner, Writer, Reviewer, Tester, Debugger, Runner, Git, Package, GitHubRelease, Security, SkillRunner, MCP, ContextGatherer, Agent, Orchestrator)
- **17+ inference providers** (5 built-in + 12 configurable via env vars) with a plugin system for unlimited expansion
- **1830+ automated tests** ensuring reliability across 55 test files
- **Full cross-platform support** (Windows, macOS, Linux) with CI validation
- **Self-learning engine** that improves system performance over time
- **Web dashboard** with real-time visualization of all system components
- **Published npm packages** (`agent-nuvira` + `@agent-nuvira/sdk`)
- **VS Code extension** with inline suggestions and chat panel

### 8.2 Technical Maturity

| Indicator | Current State |
|---|---|
| **Architecture** | Modular, clean separation of concerns (6 major subsystems) |
| **Code Quality** | TypeScript strict mode, 55 test files, 1830+ passing tests |
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
| **Enterprise Features** | ✅ Team collaboration, federation, SSO-ready |
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

## 9. Strategy & Pitch Deck

Strategic planning documents for stakeholders, investors, and team leads. These complement the technical Product Guide with market analysis, competitive positioning, and execution planning.

| Document | Purpose | Audience |
|---|---|---|
| **[PRODUCT_STRATEGY.md](./PRODUCT_STRATEGY.md)** | Product thesis, competitive landscape (pricing matrix, 22-dimension feature comparison, positioning map), target users, core differentiators, OKR framework (5 objectives, 19 key results), risk register | Investors, stakeholders, product leads |
| **[PITCH_DECK.md](./PITCH_DECK.md)** | 10-slide investor presentation outline with talking points, data visualizations, architecture diagrams, traction timeline, business model, and ask | Investors, partners, board presentations |

**Key highlights from the competitive analysis:**
- Agent-Nuvira is the **only tool** in the top-left quadrant (high autonomy + multi-provider flexibility) of the positioning map
- Leads on **16 of 22 feature dimensions** compared to Copilot, Cursor, Claude Code, Windsurf, Codex CLI, Freebuff, Ruflo, and Hermes
- One of only **3 open-source tools** (with Ruflo, Hermes) offering the full product for $0 with BYO API keys
- Only tool with **all six**: sandboxed testing, CI/CD mode, team workflows, self-learning, security scanning, and web dashboard

> **Agent-Nuvira v1.38.1 | MIT License | Built by Dheeraj Sharma**
> 
> Repository: [github.com/imdheerajKube/agent-nuvira](https://github.com/imdheerajKube/agent-nuvira)
> 
> npm: [npmjs.com/package/agent-nuvira](https://npmjs.com/package/agent-nuvira)
> 
> SDK: [npmjs.com/package/@agent-nuvira/sdk](https://npmjs.com/package/@agent-nuvira/sdk)
