# Agent-Nuvira: Comprehensive Upgrade Roadmap

> **Vision:** Transform agent-nuvira from a powerful single-machine CLI into a federated, 
> IDE-integrated, self-optimizing multi-agent coding platform — fully offline-capable, 
> community-extensible, and enterprise-ready.

---

## 📋 Table of Contents

1. [Current State & Comparison](#-current-state--comparison)
2. [Phase 1: Quick Wins (1–3 months)](#-phase-1-quick-wins-13-months)
3. [Phase 2: Structural Changes (3–9 months)](#-phase-2-structural-changes-39-months)
4. [Phase 3: Major Strategic Upgrades (12+ months)](#-phase-3-major-strategic-upgrades-12-months)
5. [Phase 4: Industry Standards & Autonomous Polish](#-phase-4-industry-standards--autonomous-polish)
6. [Risk Matrix](#-risk-matrix)
6. [Success Criteria & KPIs](#-success-criteria--kpis)
7. [Architecture Evolution](#-architecture-evolution)

---

## 📊 Current State & Comparison

### Agent-Nuvira vs Freebuff — Feature Matrix

| Feature | Freebuff | Agent-Nuvira | Advantage |
|---|---|---|---|
| **Architecture** | Multi-agent (4 roles) | Multi-agent (10+ roles) | Agent-Nuvira |
| **Inference Providers** | Freebuff servers only | 5: Local, Groq, NIM, Gemini, OpenRouter | Agent-Nuvira |
| **Server Dependency** | Yes — requires cloud | None — BYO API keys, offline-capable | Agent-Nuvira |
| **Multi-Agent Pipeline** | Sequential only | Sequential + parallel (dependency-aware) | Agent-Nuvira |
| **Self-Learning** | None | Scorer, model-router, pattern-extractor, agent-stats, self-improver | Agent-Nuvira |
| **Persistent Memory** | Session-only | Vector store + trajectory store + embedding | Agent-Nuvira |
| **Streaming** | Unknown | Partial (Groq, NIM) | Partial |
| **Plugin System** | Custom agents (TypeScript) | Programmatic plugin API | Similar |
| **Testing Sandbox** | None | TesterAgent with temp dir sandbox | Agent-Nuvira |
| **Git Integration** | None | GitAgent, PackageAgent, GitHubReleaseAgent | Agent-Nuvira |
| **Security Scanning** | Privacy-focused only | Injection scanner, PII scanner, security agent | Agent-Nuvira |
| **Code Execution** | None | RunnerAgent with sandboxed execution | Agent-Nuvira |
| **Workflow Templates** | None | YAML-based workflow templates | Agent-Nuvira |
| **Model Discovery** | None | `buff models` with search/filter | Agent-Nuvira |
| **Cost** | Free (ad-supported) | Free + user API keys or local models | Agent-Nuvira |
| **Data Privacy** | Routes through cloud | Fully offline with local models | Agent-Nuvira |
| **Setup Friction** | Zero (install & run) | Requires API keys or Ollama | Freebuff |

### Gap Analysis — Agent-Nuvira Improvements Needed

| Gap | Severity | Current Workaround |
|---|---|---|
| ~~No auto-discovery plugin loader~~ | ✅ Resolved | `runAutoDiscovery()` on startup |
| ~~Streaming incomplete (3/5 providers)~~ | ✅ Resolved | All 5 providers streaming |
| ~~No cost tracking~~ | ✅ Resolved | CostTracker with per-adapter integration |
| ~~No project scaffolding~~ | ✅ Resolved | `buff init` with 5+ templates |
| ~~No prompt history search~~ | ✅ Resolved | Keyword + semantic search in chat/CLI |
| ~~No benchmark system~~ | ✅ Resolved | 21-task benchmark with scoring |
| ~~No Docker sandbox isolation~~ | ✅ Resolved | Docker sandbox with resource limits |
| ~~No IDE integration~~ | ✅ Resolved | VS Code extension with 9 commands |
| ~~No remote federation~~ | ✅ Resolved | Protocol + server + client |
| ~~No web UI~~ | ✅ Resolved | React dashboard with 8 panels |
| ~~No team collaboration~~ | ✅ Resolved | Git-synced config + memory + review |
| ~~No security scan CLI~~ | ✅ Resolved | `buff security scan` with PII/injection/code patterns |
| ~~No feedback/rating system~~ | ✅ Resolved | `buff feedback` with record/list/stats/clear |
| ~~No unified marketplace~~ | ✅ Resolved | `buff marketplace browse/search/install/info` |
| ~~No sandbox execute flag~~ | ✅ Resolved | `buff execute --sandbox` for Docker sandbox |
| ~~No preference routing~~ | ✅ Resolved | PreferenceMode + runtime stats in hybrid-router |

---

## ⚡ Phase 1: Quick Wins (1–3 months)

### 1.1 Auto-Discovery Plugin Loader

**Objective:** Allow users to drop provider plugin files into `~/.buff/plugins/` and have them automatically loaded at startup — no manual registration required.

**Status:** ✅ Completed

#### What was built

| Component | File(s) | Purpose |
|---|---|---|
| **Startup Auto-Discovery** | `src/index.ts`, `src/cli/router.ts` | `runAutoDiscovery()` called at startup; scans `~/.buff/plugins/` for `.js` files |
| **Plugin Auto-Loader** | `src/plugins/registry.ts` | Validates `ProviderPlugin` interface before loading; wraps each plugin in try/catch |
| **Agent Plugin Discovery** | `src/plugins/agent-plugin.ts` | Scans `~/.buff/agents/` for custom agent plugins; auto-registers in agent factory |
| **CLI Commands** | `src/cli/plugins.ts` | `buff plugins list` (show discovered), `buff plugins discover` (force re-scan) |

#### CLI Usage

```bash
buff plugins list           # Show all auto-discovered plugins
buff plugins discover       # Force re-scan of ~/.buff/plugins/
buff chat --provider <plugin>  # Use a discovered plugin provider
```

---

### 1.2 Complete Streaming Support

**Objective:** All 5 providers support real-time token-by-token streaming in chat mode.

**Status:** ✅ Completed

#### What was built

| Component | File(s) | Purpose |
|---|---|---|
| **Gemini Streaming** | `src/inference/gemini-adapter.ts` | `generateStream()` using Gemini's native `streamGenerateContent` SSE endpoint |
| **OpenRouter Streaming** | `src/inference/openrouter-adapter.ts` | `generateStream()` using OpenAI-compatible SSE streaming |
| **Local/Ollama Streaming** | `src/inference/local-adapter.ts` | `generateStream()` using Ollama's newline-delimited JSON streaming |
| **NVIDIA NIM Streaming** | `src/inference/nim-adapter.ts` | `generateStream()` using NIM's SSE streaming |
| **Groq Streaming** | `src/inference/groq-adapter.ts` | `generateStream()` using Groq's SSE streaming |
| **SSE Utility** | `src/inference/sse.ts` | SSE parser supporting multiple streaming dialects |
| **CLI Integration** | `src/cli/chat.ts`, `src/cli/edit.ts`, `src/cli/plan.ts` | Streaming progress shown in chat, edit, and plan commands |

#### CLI Usage

```bash
buff chat --provider gemini         # Streaming tokens in real-time
buff edit --provider nim <file>     # Streaming via NIM
buff plan <target>                  # Streaming progress available
```

---

### 1.3 Model Cost & Usage Tracking

**Objective:** Track API costs per provider per session and provide actionable cost visibility.

**Status:** ✅ Completed

#### What was built

| Component | File(s) | Purpose |
|---|---|---|
| **Cost Tracker** | `src/learning/cost-tracker.ts` | Tracks per-call costs with configurable per-token rates; stores in `~/.buff/memory/cost-tracker.json` |
| **Adapter Integration** | All 5 adapters | Each adapter calls `getCostTracker().recordCallEstimated()` with token usage data |
| **Cost Estimation** | `src/learning/cost-tracker.ts` | Estimates costs from prompt length when API token counts unavailable; stores costs as micro-cents for precision |
| **CLI Command** | `src/cli/stats.ts` | `buff stats cost` shows session/daily/monthly costs per provider |
| **Cost Warnings** | `src/cli/chat.ts`, `src/cli/execute.ts` | Shows per-session cost estimate before expensive operations |

#### CLI Usage

```bash
buff stats cost              # Show session/daily/monthly costs
buff stats cost --provider groq  # Filter by provider
```

---

### 1.4 Interactive `buff init` Command

**Objective:** Scaffold new projects from the CLI with configurable templates and provider presets.

**Status:** ✅ Completed

#### What was built

| Component | File(s) | Purpose |
|---|---|---|
| **CLI Command** | `src/cli/init.ts` | `buff init [project-name]` with interactive prompts, interactive template + provider selection, `--template` and `--template-dir` options |
| **Built-in Templates** | Ship with CLI | 5+ templates: Node.js CLI, TS library, React app, Python, Go — with variables and post-creation instructions |
| **Custom Templates** | `~/.buff/templates/` | Users can create custom templates; use via `buff init --template-dir ~/.buff/my-templates/` |
| **Provider Selection** | `src/cli/init.ts` + model picker | Interactive provider selection wizard during init; generates `.buffconfig.json` |

#### CLI Usage

```bash
buff init my-app                     # Interactive scaffolding with template + provider selection
buff init my-app --template ts-library  # Skip template selection
buff init my-app --template-dir ~/.buff/templates/  # Use custom templates
buff init --list-templates           # List available templates
```

---

### 1.5 Prompt History Search

**Objective:** Allow users to search past chat conversations by keyword or semantic similarity.

**Status:** ✅ Completed

#### What was built

| Component | File(s) | Purpose |
|---|---|---|
| **ChatHistory** | `src/context/history.ts` | Full session management: `storeSession()`, `search()` (keyword with TF-IDF scoring), `prune()` (retention), `formatSessionSummary()` |
| **Semantic Search** | `src/context/history.ts` | `searchSemantic()` using native embeddings via VectorStore; `reindexSemantic()` rebuilds index; auto-indexing on `storeSession` |
| **In-Chat Search** | `src/cli/chat.ts` | `/search <query>` and `/search --semantic <query>` commands in interactive chat |
| **CLI Command** | `src/cli/history.ts` | `buff history list`, `search`, `search --semantic`, `prune`, `reindex` |
| **Configurable Retention** | `src/config/manager.ts` | `buff config set history.retentionDays 30` — auto-prune on CLI startup; `buff config set history.semanticSearch true/false` |
| **SQLite Storage** | `src/context/cache.ts` | Chat sessions stored in SQLite; pagination and indexing for performance |
| **Unit Tests** | `tests/context/history.test.ts` | 67 tests covering store, search, semantic search, prune, retention, edge cases |

#### CLI Usage

```bash
buff history                          # Show chronological conversation log
buff history search "JWT auth"        # Keyword search
buff history search --semantic "authentication patterns"  # Semantic search
buff history prune                    # Prune old history by retention policy
buff history reindex                  # Rebuild semantic search index
buff config set history.retentionDays 30
buff config set history.semanticSearch false
# Inside interactive chat:
/search "add authentication"
/search --semantic "error handling patterns"
```

---

### 1.6 Skill Compiler System

**Objective:** Automatically convert successful agent execution trajectories into reusable, parameterized skill scripts that can be invoked directly via `buff skill run`.

**Status:** ✅ Completed

#### What was built

| Component | File(s) | Purpose |
|---|---|---|
| **Skill Types** | `src/learning/skill-types.ts` | `Skill`, `SkillStep`, `SkillParameter`, `CompilationResult` type definitions |
| **Skill Store** | `src/learning/skill-store.ts` | Persistent storage in `~/.buff/skills/` with decay scoring, GC, keyword search, match finding |
| **Skill Compiler** | `src/learning/skill-compiler.ts` | LLM-powered engine that extracts reusable patterns from high-scoring trajectories → parameterized skill definitions with `{{param}}` placeholders |
| **Self-Improver Integration** | `src/learning/self-improver.ts` | Auto-triggers skill compilation every 8 successful orchestration runs using the top 5 trajectories |
| **Skill Runner Agent** | `src/agents/agents/skill-runner.ts` | Parses skill references from task descriptions, resolves parameter placeholders, injects steps into the execution plan |
| **Orchestrator Registration** | `src/agents/orchestrator.ts` | Registered `SkillRunnerAgent` in the agent factory |
| **CLI Command** | `src/cli/skill.ts` | `buff skill list`, `show`, `run`, `compile`, `search`, `gc`, `quality`, `clear` — `run` directly invokes the Orchestrator |
| **Unit Tests** | `tests/learning/skill-store.test.ts`, `tests/learning/skill-compiler.test.ts`, `tests/agents/agents/skill-runner.test.ts` | 84 tests covering CRUD, search, decay scoring, LLM error handling, parameter resolution, injection logic |

#### How it works

1. **Auto-compilation:** Every 8 successful orchestration runs, the SelfImprover calls the SkillCompiler with the 5 highest-scoring trajectories
2. **LLM extraction:** The compiler sends a structured prompt asking the LLM to identify reusable patterns and parameterize them with `{{parameterName}}` placeholders
3. **Persistence:** Skills are saved as individual JSON files in `~/.buff/skills/` with an index for fast lookup
4. **Execution:** `buff skill run "Add CLI Command" --params commandName=deploy --params description="Deploy to production"` produces a pre-built task plan and executes it via the Orchestrator

#### Key Files Created

| File | Lines |
|---|---|
| `src/learning/skill-types.ts` | ~80 |
| `src/learning/skill-store.ts` | ~280 |
| `src/learning/skill-compiler.ts` | ~250 |
| `src/agents/agents/skill-runner.ts` | ~200 |
| `src/cli/skill.ts` | ~300 |

---

### 1.7 Context-Window Memory Pruner

**Objective:** Prevent long multi-agent chains from exceeding model context windows by automatically compressing the shared `AgentContext` bus between agent steps.

**Status:** ✅ Completed

#### What was built

| Component | File(s) | Purpose |
|---|---|---|
| **ContextPruner** | `src/learning/context-pruner.ts` | Estimates token counts per context component, applies 5 configurable pruning strategies, logs detailed metrics |
| **Orchestrator Integration** | `src/agents/orchestrator.ts` | Prunes context at 3 points: after Planner, before each task batch, after each agent step |
| **CLI Flags** | `src/cli/execute.ts` | `--context-limit <tokens>` and `--context-prune <mode>` (soft/medium/aggressive) |
| **Public Exports** | `src/index.ts` | Exposes `ContextPruner`, `ContextPrunerOptions`, `ContextTokenBreakdown`, `PruneResult`, `PruneDetail` |
| **Unit Tests** | `tests/learning/context-pruner.test.ts` | 72 tests covering all strategies, edge cases, threshold behavior, and integration scenarios |

#### Pruning Strategies

| # | Strategy | What it does | Typical savings |
|---|---|---|---|
| 1 | **Strip metadata** | Removes non-essential metadata keys (keeps `projectFileTree`, `memoryContext`, `patternContext`, `runResult`, `sandboxPath`) | Up to 10K tokens |
| 2 | **Collapse file changes** | Drops `newContent`/`originalContent` from already-applied file changes (path + status preserved for summary) | 50K+ tokens |
| 3 | **Truncate conversations** | Keeps last N messages (soft=10, medium=5, aggressive=2) | 5–20K tokens |
| 4 | **Summarize artifacts** | Truncates oversized artifact content to 2K chars with a truncation notice | 10–100K tokens |
| 5 | **Aggressive conversation** | If still over threshold after all strategies, keeps only last 2 messages | Last resort |

#### CLI Usage

```bash
buff execute "goal" --context-limit 1000000 --context-prune medium
buff execute "goal" --context-limit 128000 --context-prune aggressive
```

---

### 1.8 Context-Preserving Model Switching (`buff model`)

**Objective:** Allow users to switch inference providers/models mid-session without losing conversation history, agent state, or session continuity.

**Status:** ✅ Completed

#### What was built

| Component | File(s) | Purpose |
|---|---|---|
| **CLI Command** | `src/cli/model.ts` | `buff model list`, `switch`, `info`, `recommend`, `health` — 5 subcommands + default interactive prompt |
| **Active Model State** | `src/cli/model.ts` | Persists the active provider/model to `~/.buff/active-model.json`; `applyActiveModel()` exported for use by `chat.ts` and `execute.ts` |
| **Chat Integration** | `src/cli/chat.ts` | Auto-applies active model from `buff model switch` on session start |
| **Execute Integration** | `src/cli/execute.ts` | Auto-applies active model from `buff model switch` on orchestration start |
| **Priority Chain** | `src/cli/model.ts` | CLI `--provider`/`--model` flags → active model state → default config |
| **Router Registration** | `src/cli/router.ts` | Registered `buff model` as a top-level command |

#### CLI Usage

```bash
buff model                              # Show current config + prompt to switch
buff model list                         # Table of all providers with status
buff model switch                       # Interactive categorized model picker
buff model switch groq                  # Switch to provider with default model
buff model switch groq/llama-3.3-70b   # Switch to specific provider/model
buff model info                         # Detailed active configuration
buff model recommend                    # Model routing recommendations
buff model health                       # Quick health check for active provider
```

---

## 🏗️ Phase 2: Structural Changes (3–9 months)

### 2.1 Native Embedding Support

**Objective:** Replace expensive LLM-based embeddings with a lightweight local embedding model for 10x faster and more accurate semantic search.

**Status:** ✅ Completed

#### What was built

| Component | File(s) | Purpose |
|---|---|---|
| **Embedder Tier 1: Xenova** | `src/memory/embedder.ts` | Fast local 384-dim embeddings via `@huggingface/transformers` (`all-MiniLM-L6-v2`) — runs in-browser via ONNX runtime, free and 10x faster than LLM |
| **Embedder Tier 2: Python** | `src/memory/embedder.ts` | Subprocess fallback using `sentence-transformers` for the same `all-MiniLM-L6-v2` model |
| **Embedder Tier 3: LLM** | `src/memory/embedder.ts` | LLM-based embedding fallback when local models unavailable; parses JSON/code-block/text responses |
| **Embedding Cache** | `src/memory/embedder.ts` | In-memory LRU cache (200 entries) keyed by MD5 hash of lowercase text; avoids redundant computation |
| **Tier Detection** | `src/memory/embedder.ts` | Auto-detects available tiers (`isXenovaAvailable()`, `isPythonAvailable()`) with forced fallback (`setForceLLM()`) |
| **Semantic Search in ChatHistory** | `src/context/history.ts` | `searchSemantic(query, limit)` — embeds query and searches VectorStore; `reindexSemantic()` rebuilds index; auto-indexing on `storeSession` |
| **CLI Integration** | `src/cli/chat.ts`, `src/cli/history.ts` | `/search --semantic <query>` in chat; `buff history search --semantic <query>` for CLI |
| **Tier 1 Mock Tests** | `tests/memory/embedder.test.ts` | 7 new tests for tier detection, `setForceLLM`, fallthrough, graceful degradation |
| **Semantic Search Tests** | `tests/context/history.test.ts` | 8 new tests for `searchSemantic` (empty query, basic match, zero-vector fallback, limit, error fallback, reindex) |

#### Architecture

```
User query "add JWT auth"
    │
    ▼
ChatHistory.searchSemantic(query)
    │
    ├─ embed(query) → 384-dim vector
    │    ├─ [Tier 1] @huggingface/transformers  ←  < 500ms, free
    │    ├─ [Tier 2] Python sentence-transformers
    │    └─ [Tier 3] LLM fallback  ────────────  < 2-5s, may cost
    │
    ▼
VectorStore.search(vector, k, filterFn)
    │  (only entries with id starting with 'session-')
    │
    ├─ cosineSimilarity(queryVector, storedVector)
    │
    ▼
Load full HistorySession from history.json
    │
    ▼
Return ranked HistorySession[]

Fallback chain: embed fails → returns zero vector → ChatHistory.search(query) (keyword)
```

#### Downstream consumers

- **`buff chat`**: `/search --semantic "natural language query"` for semantic history search
- **`buff history`**: `buff history search --semantic "query"` from CLI
- **TrajectoryStore**: Uses `embed()` for trajectory similarity search (pre-existing)

#### Key Files

| File | Lines Changed | Purpose |
|---|---|---|
| `src/memory/embedder.ts` | — | Pre-existing; all 3 tiers + cache + detection |
| `src/context/history.ts` | +95 | `searchSemantic()`, `reindexSemantic()`, `indexSessionForSearch()`, `import embed/getVectorStore` |
| `src/cli/chat.ts` | +25 | `/search --semantic` support |
| `src/cli/history.ts` | +10 | `buff history search --semantic` support |
| `src/cli/model.ts` | +2 | Fix pre-existing `const registry` redeclaration |
| `tests/memory/embedder.test.ts` | +80 | 7 Tier 1 mock tests |
| `tests/context/history.test.ts` | +90 | 8 searchSemantic/reindexSemantic tests |

#### Test Counts

| File | Before | After |
|---|---|---|
| `tests/memory/embedder.test.ts` | 16 | 23 |
| `tests/context/history.test.ts` | 60 | 67 |
| **Total** | 76 | 90 |

---

### 2.2 Workflow Template Marketplace

**Objective:** Create a community-driven marketplace for workflow templates with install/publish commands.

**Status:** ✅ Completed

#### What was built

| Component | File(s) | Purpose |
|---|---|---|
| **10 Built-in Templates** | `src/workflow/templates.ts` | quick-fix, create-and-run, feature-implement, publish-release, api-scaffold, security-audit, refactor-module, code-review, bug-hunt, test-generation — each with agent steps, recommended models, and dependency declarations |
| **Registry Client** | `src/workflow/registry.ts` | Fetches registry index from GitHub with TTL caching (1h), validates templates on install, saves to `~/.buff/workflows/registry/` |
| **CLI Commands** | `src/cli/workflow.ts` | `list`, `run`, `search`, `install`, `publish`, `info`, `upgrade` — full marketplace lifecycle management |
| **Template Validation** | `src/workflow/registry.ts` | `validateForPublish()` checks required fields, step structure, ID format; `prepareForPublish()` generates registry-ready JSON |
| **Version & Dependency Resolution** | `src/workflow/registry.ts` | `compareVersions()`, `versionSatisfies()`, `resolveDependencies()`, `checkForUpgrades()` — semver comparison, ^/~ constraint support, dependency chain resolution |
| **Workflow Engine** | `src/workflow/templates.ts` | `buildTaskPlanFromTemplate()` converts template steps → orchestrator task plan with stable IDs; `buildWorkflowOptions()` merges recommended models with user overrides |
| **Unit Tests** | `tests/workflow/templates.test.ts` | 224 tests covering template structure, engine logic, CLI structure, and option parsing |

#### Architecture

```
User runs: buff workflow install security-audit
    │
    ▼
installTemplate("security-audit")
    ├─ fetchRegistryIndex() → cache hit? → return cached
    │                                    └─ cache miss? → fetch from GitHub
    ├─ getRegistryEntry("security-audit") → found?
    ├─ download template JSON from GitHub
    ├─ isValidWorkflowTemplate(template)? → validate structure
    └─ save to ~/.buff/workflows/registry/security-audit.json

User runs: buff workflow run quick-fix "fix login bug"
    ├─ getWorkflowTemplate("quick-fix") → built-in or installed
    ├─ buildTaskPlanFromTemplate(template, goal) → TaskStep[]
    ├─ buildWorkflowOptions(template, userOptions) → OrchestratorOptions
    └─ Orchestrator.execute(goal, { prefillPlan, ...options })

Publishing flow:
    buff workflow publish my-template
    ├─ validateForPublish("my-template") → checks fields, structure, ID format
    ├─ prepareForPublish("my-template") → generates registry-ready JSON
    └─ prints PR instructions with getPublishUrl()
```

#### CLI Usage

```bash
buff workflow list                              # 10 built-in + installed
buff workflow run quick-fix "fix login bug"     # Run a workflow with pre-built plan
buff workflow search "security"                 # Search GitHub registry (TTL-cached)
buff workflow install security-audit            # Install from registry
buff workflow publish my-template               # Validate + prepare for PR
buff workflow info template-name                # Show template details
buff workflow upgrade                           # Check for updates
```

#### External Dependency

A GitHub registry repo (`imdheerajKube/agent-nuvira`) with an `index.json` and `templates/` directory is needed to go live. The code is fully ready to consume it.

#### Test Coverage

| File | Tests |
|---|---|
| `tests/workflow/templates.test.ts` | 224 |

---

### 2.3 Automatic Model Benchmarking

**Objective:** Create a standardized benchmark system to compare models on real coding tasks.

**Status:** ✅ Completed

#### What was built

| Component | File(s) | Purpose |
|---|---|---|
| **21 Benchmark Tasks** | `src/learning/benchmark.ts` | 21 coding tasks across 10 categories (code-gen, refactoring, debugging, testing, documentation, security, optimization, comprehension, translation) with difficulty levels and expected patterns |
| **Benchmark Runner** | `src/learning/benchmark.ts` | `runBenchmark()` with progress callback, budget support, task filtering (by ID or time estimate), cost tracking |
| **Scoring Engine** | `src/learning/benchmark.ts` | `scoreQuality()` heuristic — rewards pattern matches, penalizes anti-patterns, length bonuses, code block detection; clamped 0–1 |
| **Report Formatters** | `src/learning/benchmark.ts` | `formatBenchmarkReport()` (text table), `formatBenchmarkJSON()` (machine-readable), `formatBenchmarkMarkdown()` (documentation) |
| **Model Comparison** | `src/learning/model-compare.ts` | `compareModelRuns()` with per-metric winners, `compareAndRecommend()` auto-updates routing, `findBestModelForAgent()` finds best model per agent |
| **CLI Command** | `src/cli/benchmark.ts` | `buff benchmark`, `list`, `results` (--last/--compare/--format), `clear` — spinner progress, file export |
| **Unit Tests** | `tests/learning/benchmark.test.ts` | 24 tests covering scoring, task listing, report formatting, comparison, persistence |

#### CLI Usage

```bash
buff benchmark                           # Run full suite
buff benchmark --provider groq           # Specific provider
buff benchmark --model llama-3.3-70b    # Specific model
buff benchmark --tasks quick             # Filter by speed
buff benchmark --budget 0.50             # Cost cap
buff benchmark list                      # List all tasks
buff benchmark results --last            # Last run details
buff benchmark results --compare         # A/B comparison
buff benchmark results --format markdown # Export as markdown
buff benchmark clear                     # Clear all data
```

#### Test Coverage

| File | Tests |
|---|---|
| `tests/learning/benchmark.test.ts` | 24 |

---

### 2.4 Sandbox Isolation Enhancements

**Objective:** Strengthen code execution sandbox with Docker support and resource limits.

**Status:** ✅ Completed

#### What was built

| Component | File(s) | Purpose |
|---|---|---|
| **Docker Sandbox Manager** | `src/sandbox/manager.ts` | Full container lifecycle: create (with resource limits), exec commands, copy project files (tar-based bulk copy), destroy — with timeout enforcement and stale cleanup |
| **Network Isolation** | `src/sandbox/types.ts`, `src/sandbox/manager.ts` | `networkAccess: false` default; `--network none` Docker flag; configurable via CLI |
| **Resource Limits** | `src/sandbox/types.ts`, `src/sandbox/manager.ts` | Memory (`--memory`), CPU (`--cpus`), Disk (`--storage-opt`), PIDs (`--pids-limit`), Timeout (SIGTERM → SIGKILL) — all configurable |
| **Base Images (8)** | `src/sandbox/images.ts` | Node.js 20 (slim/full), Node.js 18, Python 3.12/3.11, Go 1.22, Rust 1.77, Ubuntu 22.04 — with `detectProjectImage()` auto-detection from project files |
| **Security Hardening** | `src/sandbox/manager.ts` | Read-only root FS, `--cap-drop ALL`, `--security-opt no-new-privileges`, non-root user, tmpfs for /tmp |
| **CLI Command** | `src/cli/sandbox.ts` | `buff sandbox status`, `config`, `images`, `run <cmd>`, `cleanup` — full lifecycle management |
| **Execute Sandbox Flag** | `src/cli/execute.ts`, `src/agents/orchestrator.ts` | `buff execute <goal> --sandbox` — wires `useDockerSandbox: true` to orchestrator vault metadata, triggers Docker sandbox in runner/tester agents |
| **Config Persistence** | `src/sandbox/types.ts` | `~/.buff/sandbox-config.json` with `getSandboxConfig()`/`setSandboxConfig()` |
| **Streaming Output** | `src/sandbox/manager.ts` | `runCommandWithOutput()` with `onChunk` callback for long-running commands |
| **Unit Tests** | `tests/sandbox/manager.test.ts` | 23 tests covering Docker availability, config loading, image resolution, project detection |

#### CLI Usage

```bash
buff sandbox status                    # Check Docker + sandbox config
buff sandbox config --enable           # Enable Docker sandbox
buff sandbox config --memory 2g --cpu 2 # Set resource limits
buff sandbox config --network          # Enable network access
buff sandbox images                    # List 8 pre-defined images
buff sandbox run "npm test"            # Run command in sandbox container
buff sandbox run "go test ./..." --image golang:1.22
buff sandbox cleanup                   # Destroy all active containers
```

#### Test Coverage

| File | Tests |
|---|---|
| `tests/sandbox/manager.test.ts` | 23 |

---

### 2.5 Provider Health Dashboard (`buff doctor`)

**Objective:** One-command diagnosis of all provider configurations.

**Status:** ✅ Completed

#### What was built

| Component | File(s) | Purpose |
|---|---|---|
| **Doctor Command** | `src/cli/doctor.ts` | Full `buff doctor` CLI with `--provider <name>`, `--verbose`, `--watch`, `--fix` flags |
| **Provider Tests** | `src/cli/doctor.ts` | 5 checks per provider: API key presence, provider module loading, endpoint availability (`isAvailable()`), model listing, quick generation test |
| **Health Report** | `src/cli/doctor.ts` | Color-coded ✅/⚠️/❌ icons, per-check messages, fix suggestions, summary section |
| **System Checks** | `src/cli/doctor.ts` | Config directory, memory directory, Docker availability, plugin directories, internet connectivity |
| **Watch Mode** | `src/cli/doctor.ts` | `--watch` flag refreshes every 30s with `console.clear()`, graceful Ctrl+C handling |
| **Auto-Fix Mode** | `src/cli/doctor.ts` | `--fix` creates missing `~/.buff/` directories, warns about missing API keys |
| **Timeout Handling** | `src/cli/doctor.ts` | 10s per check, 30s total per provider, Promise.race-based timeout |
| **Plugin Support** | `src/cli/doctor.ts` | Also checks auto-discovered plugin providers from `~/.buff/plugins/` |

#### CLI Usage

```bash
buff doctor                              # Full health check on all providers
buff doctor --provider groq              # Check specific provider
buff doctor --verbose                    # Show model listing + generation test
buff doctor --watch                      # Continuous monitoring (30s refresh)
buff doctor --fix                        # Auto-fix common issues
```

---

### 2.6 Agent Memory Compression & Pruning

**Objective:** Automatically optimize the memory store to prevent bloat and maintain search quality.

**Status:** ✅ Completed

#### What was built

| Component | File(s) | Purpose |
|---|---|---|
| **Trajectory Summarization** | `src/memory/trajectory-store.ts` | `summarize()` merges groups of similar old trajectories (by project fingerprint) into a single compact representation, keeping highest-scoring as representative |
| **Configurable Retention Policy** | `src/memory/trajectory-store.ts` | `pruneByPolicy()` with 3 modes: age-based (default 90d), score-based (default min 0.1), count-based (default max 500) |
| **Trajectory Merging** | `src/memory/trajectory-store.ts` | `mergeFileChanges()` with status priority (modified > created > deleted > read) |
| **Compression Analysis** | `src/memory/trajectory-store.ts` | `getCompressionStats()` reports old/low-score/mergeable trajectories and estimated optimization % |
| **Auto-Prune on Save** | `src/memory/trajectory-store.ts` | `pruneIfNeeded()` removes oldest when > 500 trajectories; cleans up VectorStore entries |
| **CLI Command** | `src/cli/memory.ts` | `buff memory stats`, `optimize` (--dry-run/--aggressive), `prune`, `summarize`, `info`, `clear --force` |
| **Self-Improver Integration** | `src/learning/self-improver.ts` | Auto-runs pattern extraction (every 5 runs) and skill compilation (every 8 runs) on successful trajectories |
| **Pattern Store GC** | `src/learning/pattern-extractor.ts` | `garbageCollect()` removes low-quality unused patterns during optimize |
| **Memory Tests** | `tests/memory/` | 93 tests across trajectory store, vector store, embedder, and memory integration |

#### Optimize Workflow (3 phases)

1. **Prune** — Remove old/low-score/excess trajectories by policy
2. **Summarize** — Merge similar old trajectories by project fingerprint
3. **GC** — Clean up low-quality coding patterns

#### CLI Usage

```bash
buff memory                             # Quick stats overview
buff memory stats                       # Detailed memory statistics
buff memory optimize                    # Auto compress + prune (3-phase)
buff memory optimize --dry-run          # Preview changes
buff memory optimize --aggressive       # Max savings (14d retention, 0.2 min score)
buff memory prune --max-age 30          # Remove trajectories older than 30 days
buff memory prune --min-score 0.2       # Remove low-quality trajectories
buff memory summarize --retention 14    # Merge similar old trajectories
buff memory info                        # Full compression analysis
buff memory clear --force               # Wipe everything
```

#### Test Coverage

| File | Tests |
|---|---|
| `tests/memory/trajectory-store.test.ts` | 18 |
| `tests/memory/vector-store.test.ts` | 24 |
| `tests/memory/embedder.test.ts` | 23 |
| `tests/memory/memory-integration.test.ts` | 28 |
| **Total** | **93** |

---

## 🚀 Phase 3: Major Strategic Upgrades (12+ months)

### 3.1 VS Code Extension

**Objective:** Bring Agent-Nuvira's multi-agent power directly into the editor.

**Status:** ✅ Completed

#### What was built

| Component | File(s) | Purpose |
|---|---|---|
| **Extension Entry Point** | `vscode-extension/src/extension.ts` | Activates on workspace open; registers 9 commands, inline completion provider, status bar, config watcher; CLI child process lifecycle management |
| **Command Registry** | `vscode-extension/src/commands.ts` | 9 commands: execute goal, quick fix, review file, explain code, generate tests, run workflow, accept/reject changes, show panel |
| **Inline Code Suggestions** | `vscode-extension/src/inlineSuggest.ts`, `inlineSuggestUtils.ts` | Copilot-style `InlineCompletionItemProvider` with 800ms debounce, context-aware prefix matching, multi-line diff suggestions |
| **Agent Progress Panel** | `vscode-extension/src/agentPanel.ts` | WebView panel with 3 phases, animated spinners, phase indicators, expandable logs, accept/reject buttons |
| **Diff Viewer** | `vscode-extension/src/diffViewer.ts` | VS Code native diff editor, temporary file management, batch apply/reject |
| **CLI Manager** | `vscode-extension/src/cliManager.ts` | Child process management, config hot-reload, timeout protection, cancellation |
| **Output Parser** | `vscode-extension/src/outputParser.ts` | Parses CLI stdout for file changes, summaries, errors |
| **Custom Keybindings** | `vscode-extension/package.json` | `Ctrl+Shift+A` prefix, 9 keybindings |
| **Context Menus** | `vscode-extension/package.json` | Right-click: Quick Fix, Review, Generate Tests |
| **Unit Tests** | `vscode-extension/src/test/` | 131 tests across all components |

#### Commands Available

| Command | Keybinding | Action |
|---|---|---|
| `agent-nuvira.executeGoal` | `Ctrl+Shift+A E` | Run multi-agent pipeline |
| `agent-nuvira.quickFix` | `Ctrl+Shift+A F` | Quick fix file/selection |
| `agent-nuvira.reviewFile` | `Ctrl+Shift+A R` | Review file |
| `agent-nuvira.explainCode` | `Ctrl+Shift+A X` | Explain selected code |
| `agent-nuvira.generateTest` | `Ctrl+Shift+A T` | Generate tests |
| `agent-nuvira.runWorkflow` | `Ctrl+Shift+A W` | Run workflow template |
| `agent-nuvira.acceptChanges` | `Ctrl+Shift+A A` | Accept all proposed changes |
| `agent-nuvira.rejectChanges` | `Ctrl+Shift+A D` | Reject all proposed changes |
| `agent-nuvira.showPanel` | `Ctrl+Shift+A P` | Show agent progress panel |

#### Test Coverage

| File | Tests |
|---|---|
| `vscode-extension/src/test/commands.test.ts` | 27 |
| `vscode-extension/src/test/cliManager.test.ts` | 24 |
| `vscode-extension/src/test/cliManager.integration.test.ts` | 27 |
| `vscode-extension/src/test/inlineSuggest.test.ts` | 23 |
| `vscode-extension/src/test/inlineSuggest.integration.test.ts` | 30 |
| **Total** | **131** |

#### CLI Usage

```bash
agent-nuvira execute "refactor auth module"   # Full multi-agent pipeline
agent-nuvira chat                             # Interactive chat mode
agent-nuvira edit src/auth.ts                 # Single-file targeted edit
```

---

### 3.2 Remote Agent Collaboration (Federation)

**Objective:** Allow multiple machines to collaborate on the same goal via federated agents.

**Status:** ✅ Completed

#### What was built

| Component | File(s) | Purpose |
|---|---|---|
| **Protocol Types** | `src/federation/protocol.ts` | Full protocol specification with handshake, task delegation, SSE events, health types |
| **Federation Server** | `src/federation/server.ts` | HTTP server with SSE streaming: handshake auth, task delegation, cancellation, health checks — zero external deps |
| **Federation Client** | `src/federation/client.ts` | Connect/disconnect, task delegation with SSE + polling fallback, cancellation, health checks |
| **CLI Command** | `src/cli/federation.ts` | `status`, `start`, `connect`, `disconnect`, `run`, `health`, `config` — full lifecycle management |

#### CLI Usage

```bash
buff federation start                    # Start server
buff federation connect 192.168.1.50 --secret mykey
buff federation run "Fix bug" --agent debugger
buff federation health
buff federation status
buff federation disconnect
```

### 3.3 Web UI Dashboard

**Objective:** Optional web-based dashboard for visualizing agent execution and system status.

**Status:** ✅ Completed

#### What was built

| Component | File(s) | Purpose |
|---|---|---|
| **React Dashboard** | `src/web-dashboard/src/` | React 18 + React Router + Recharts + Vite + TypeScript — dark GitHub-inspired theme |
| **DAG Visualization** | `DAGView.tsx` | SVG-based execution pipeline with topological layout, node status colors |
| **History Browser** | `HistoryBrowser.tsx` | Conversation sessions with summary, provider, model, message count |
| **Model Health Panel** | `ModelsPanel.tsx` | Real-time provider checks with rate limit parsing |
| **Cost Dashboard** | `CostDashboard.tsx` | Cost by provider/model with bar charts |
| **Benchmark Charts** | `BenchmarkCharts.tsx` | Pass rate, latency, cost charts via Recharts |
| **Memory Panel** | `MemoryPanel.tsx` | Trajectory count by project, avg score |
| **System Health** | `HealthPanel.tsx` | Patterns, feedback, vector index, agent stats |
| **Overview Page** | `Overview.tsx` | Stats grid, cost by provider chart |
| **Dashboard Server** | `src/web-dashboard/server.ts` | 8 REST endpoints + SSE (init/refresh/dag events, heartbeat) |
| **SSE Real-time Updates** | `api.ts`, `server.ts` | Server-sent events every 10s, auto-reconnect on disconnect |
| **CLI Command** | `src/cli/dashboard.ts` | `buff dashboard` with `--port`, `--host`, `--no-open`, `--build` flags |

#### CLI Usage

```bash
buff dashboard                        # Start on port 3030
buff dashboard --port 8080            # Custom port
buff dashboard --build                # Build then start
```

---

### 3.4 Hybrid Model Routing Engine

**Objective:** Intelligent model selection that considers task complexity, cost, availability, and historical performance.

**Status:** ✅ Completed

#### What was built

| Component | File(s) | Purpose |
|---|---|---|
| **Complexity Analysis** | `src/learning/hybrid-router.ts` | 5 complexity levels (trivial→critical) with keyword detection |
| **Cost Budget Awareness** | `src/learning/hybrid-router.ts` | Budget-aware model selection using CostTracker data |
| **Multi-Model Consensus** | `src/learning/hybrid-router.ts` | Parallel execution on 2 models with Jaccard similarity comparison |
| **Automatic Fallback Chains** | `src/learning/hybrid-router.ts` | 3-level chain (primary→secondary→tertiary), per-model error handling |
| **Routing Decision Exposure** | `src/learning/hybrid-router.ts` | `RoutingDecision` with `userOverridden` flag; verbose mode logging |
| **Model Router Integration** | `src/learning/model-router.ts` | `recommendModel()`, `buildAgentModelMap()`, `isProviderSuitable()` |
| **PreferenceMode Type** | `src/learning/hybrid-router.ts` | `'balanced' | 'performance-first' | 'cost-first' | 'privacy-first'` — drives provider selection per mode |
| **Mode-Aware Selection** | `src/learning/hybrid-router.ts` | `providerForComplexity()` adjusted per mode: privacy-first → `local`, cost-first → `local`/`groq`, performance-first → `groq`/`gemini`/`openrouter` |
| **Runtime Stats Integration** | `src/learning/hybrid-router.ts` | `resolveRouting()` imports `getAgentStats().getBestModel(agentType)` to override primary model with historically best performer |
| **Quality Boost per Mode** | `src/learning/hybrid-router.ts` | `+0.1` for performance-first, `-0.05` for privacy-first; scored in routing explanation |
| **PreferenceMode Export** | `src/index.ts` | Exported alongside `HybridRouterOptions` for CLI config use |

#### CLI Usage

```bash
buff model                              # View current model routing
buff model select --provider gemini     # Manually select provider
buff model recommend --agent writer     # Get AI recommendation for agent
buff model providers                    # List all configured providers
buff model inspect                      # Show routing decision details

# Preference modes are set via HybridRouterOptions:
const router = new HybridModelRouter({ preferenceMode: 'privacy-first', useRuntimeStats: true });
```

---

### 3.5 Team Collaboration Features

**Objective:** Enable team workflows with shared configuration, memory, and review pipelines.

**Status:** ✅ Completed

#### What was built

| Component | File(s) | Purpose |
|---|---|---|
| **Project-Level Config** | `src/team/config.ts` | `findProjectConfig()` — config priority chain (project → user → defaults) |
| **Git-Synced Team Memory** | `src/team/memory.ts` | `initTeamMemory()`, `syncTeamMemory()` (pull+push), `shareTrajectories()`, `getTeamMemoryStats()` |
| **Review Workflow** | `src/team/review.ts` | `createReview()`, `addReviewComment()` (approve/request-changes), `mergeReview()`, `rejectReview()` |
| **CLI Command** | `src/cli/team.ts` | `init`, `join <url>`, `sync`, `status`, `share`, `review list/show/approve/reject/merge/create` |

#### CLI Usage

```bash
buff team init --repo https://github.com/team/repo
buff team join https://github.com/team/repo
buff team sync                          # Pull + push team memory
buff team status                        # Config + memory + reviews overview
buff team share                         # Share local trajectories
buff team review list                   # List review bundles
buff team review approve <id> -m "LGTM"
buff team review merge <id>             # Apply approved changes
buff team review reject <id> <reason>
buff team review create "Title" "Goal"  # Create review from files
```

---

### 3.6 Agent SDK for Custom Agent Development

**Objective:** Enable third-party developers to build, test, and publish custom agents.

**Status:** ✅ Completed

#### What was built

| Component | File(s) | Purpose |
|---|---|---|
| **npm Package** | `packages/sdk/` | `@agent-nuvira/sdk` with dual entry points (main, agent, testing) |
| **Base Agent Class + Types** | `packages/sdk/src/agent.ts` | Abstract `Agent`, `AgentContext`, `AgentResult`, `LLMCallFn`, `FileChange` |
| **Testing Utilities** | `packages/sdk/src/testing.ts` | `MockLLM`, `createTestContext()`, `createMockCallLLM()`, `assertAgentResult()` |
| **Scaffolding CLI** | `src/cli/sdk.ts`, `src/agent-sdk/src/scaffold.ts` | 3 templates: basic-agent, full-agent, agent-pack |
| **Plugin Auto-Discovery** | `src/plugins/agent-plugin.ts` | Agents in `~/.buff/agents/` auto-discovered |
| **SDK Documentation** | `packages/sdk/README.md` | Quick start, step-by-step guide, full API reference |
| **Type Compatibility Tests** | `tests/agent-sdk/type-compatibility.test.ts` | 23 tests verifying SDK ↔ main type compatibility |

#### CLI Usage

```bash
buff sdk init                           # Interactive scaffolding
buff sdk init --type basic-agent        # Minimal agent template
buff sdk init --type full-agent         # Full agent with tests
buff sdk init --type agent-pack         # Multi-agent plugin pack
```

### 3.7 Provider CLI (`buff provider list/health`)

**Status:** ✅ Completed (July 2026)

**Objective:** Provide dedicated CLI commands for provider visibility — listing all providers with color-coded status and running per-provider health diagnostics.

#### What was built

| Component | File | Description |
|---|---|---|
| **Provider list command** | `src/cli/provider.ts` | Color-coded table of all 5 providers + plugins, showing status (Available/Unreachable/Not configured), API key preview, and configured model |
| **Provider health command** | `src/cli/provider.ts` | Detailed per-provider diagnostics: API key check, module loading, endpoint reachability, model info, verbose model listing, fix suggestions |
| **Router registration** | `src/cli/router.ts` | Registered `buff provider` as a top-level CLI command |

#### CLI Usage

```bash
buff provider list                        # Show all providers with status table
buff provider list --all                  # Include unconfigured providers
buff provider health                      # Check all providers
buff provider health groq                 # Check a specific provider
buff provider health --verbose            # Include model listing
buff provider health --watch              # Continuous monitoring (30s refresh)
```

#### Test Coverage

| File | Tests |
|---|---|
| `tests/cli/provider.test.ts` | 18 (list: 7, health: 11) |

### 3.8 Provider Fallback Routing

**Status:** ✅ Completed (July 2026)

**Objective:** Automatically fail over between providers when one is unavailable or returns an error, with configurable fallback chains, circuit breaker, and transparent logging.

#### What was built

| Component | File | Description |
|---|---|---|
| **ProviderFallback class** | `src/learning/provider-fallback.ts` | Core fallback engine with prioritized chain, circuit breaker (3 failures → 120s cooldown), provider caching, and automatic retry |
| **Error classification** | `src/learning/provider-fallback.ts` | Classifies errors into auth/rate-limit/server/network/timeout — only non-auth errors trigger auto-fallback |
| **Chat integration** | `src/cli/chat.ts` | Auto-fallback in streaming and non-streaming paths before prompting user for manual recovery |
| **Edit integration** | `src/cli/edit.ts` | Auto-fallback on `generate()` failure |
| **Config support** | `src/config/types.ts`, `src/config/manager.ts` | `FallbackConfig` in `BuffConfig` with defaults: enabled=true, providers=[groq, nim, gemini, openrouter, local], maxAttempts=3 |
| **Exports** | `src/index.ts` | Public API: `ProviderFallback`, `getProviderFallback`, `resetProviderFallback`, `classifyFallbackError`, `isRetryableError` |

#### How It Works

1. User sends a message or edits a file using a primary provider
2. If the provider call fails with a retryable error (rate-limit, server, network, timeout):
   - The fallback engine tries the next provider in the configured chain
   - Failed providers are tracked in a circuit breaker (3 failures in 60s → 120s cooldown)
   - On success, the provider is swapped transparently and the user sees a success message
3. If all providers in the chain fail, the user is prompted for manual recovery (retry, switch, cancel, exit)
4. Auth errors are never auto-retried (they'd fail on all providers)

#### CLI Configuration

```bash
# Fallback is enabled by default. Configure via buffconfig.json:
{
  "fallback": {
    "enabled": true,
    "providers": ["groq", "nim", "gemini", "openrouter", "local"],
    "maxAttempts": 3,
    "retryDelayMs": 1000
  }
}

# Or via config commands (coming soon):
buff config set fallback.enabled true
buff config set fallback.providers "groq,nim,gemini"
```

---

### 3.9 Security Scan CLI (`buff security scan`)

**Status:** ✅ Completed (July 2026)

**Objective:** Built-in security audit CLI to detect prompt injection, PII leaks, and dangerous code patterns before execution.

#### What was built

| Component | File | Description |
|---|---|---|
| **CLI Command** | `src/cli/security.ts` | `buff security scan` with file/stdin/argument input modes and `--prompt`/`--code`/`--pii` scan filters |
| **Scanner Engine** | `src/security/scanner.ts` | PII detection (emails, API keys, SSNs, credit cards, phones), injection patterns (ignore all instructions, role-play, etc.), dangerous code patterns (eval, exec, child_process, etc.) |
| **Output Formats** | `src/cli/security.ts` | Human-readable with severity icons (🔴🟠🟡🔵) or `--json` for machine parsing |
| **Severity Control** | `src/cli/security.ts` | `--strict` fails on medium+ severity (default: high+); `--generated` lowers severity for eval/network patterns |
| **Router Registration** | `src/cli/router.ts` | Registered as top-level `buff security` command |
| **Unit Tests** | `tests/cli/security.test.ts` | 14 tests covering inline text, flags, file input, JSON output, and edge cases (SSN, credit card, no input, file errors) |

#### CLI Usage

```bash
buff security scan "Check this code for secrets"     # Scan inline text
buff security scan --file ./script.js                 # Scan a file
cat payload.txt | buff security scan --stdin          # Pipe input
buff security scan --prompt "ignore all instructions" # Injection check only
buff security scan --code "eval(userInput)"           # Code patterns only
buff security scan --pii "email@example.com"          # PII check only
buff security scan --json --strict "sensitive data"   # JSON output, strict mode
buff security scan --generated "require('child_process')"  # Generated code (lower severity)
```

#### Test Coverage

| File | Tests |
|---|---|
| `tests/cli/security.test.ts` | 14 |

---

### 3.10 Feedback & Rating System (`buff feedback`)

**Status:** ✅ Completed (July 2026)

**Objective:** Capture user feedback on agent execution quality to drive self-improvement and routing decisions.

#### What was built

| Component | File | Description |
|---|---|---|
| **CLI Command** | `src/cli/feedback.ts` | `buff feedback record/list/stats/clear` — full feedback lifecycle |
| **Feedback Store** | `src/learning/feedback.ts` | `FeedbackStore` with JSON persistence, 1000-entry limit, stats aggregation (avg score, trend direction), and automatic score delta computation |
| **Rating Modes** | `src/cli/feedback.ts` | CLI flags (`--positive`, `--negative`, `--neutral`) or interactive inquirer prompt for guided rating |
| **Score Impact** | `src/learning/feedback.ts` | `ratingToScoreDelta()`: positive → `+0.3`, negative → `-0.3`, neutral → `0` |
| **Stats Visualization** | `src/cli/feedback.ts` | Visual bar chart (🟢🔴⚪), trend direction arrows (📈📉📊), trajectory filtering |
| **Router Registration** | `src/cli/router.ts` | Registered as top-level `buff feedback` command |
| **Unit Tests** | `tests/cli/feedback.test.ts` | 20 tests covering record (with flags, interactive, skip, score impact), list (empty, with data, trajectory, limit), stats (empty, with data), clear (confirmed, cancelled) |

#### CLI Usage

```bash
buff feedback record traj-001 --positive              # Record positive rating
buff feedback record traj-002 --negative --comment "Wrong approach"
buff feedback record                                   # Interactive rating prompt
buff feedback list                                     # Show recent entries
buff feedback list --limit 20 --trajectory traj-001    # Filtered listing
buff feedback stats                                    # Aggregated statistics
buff feedback clear                                    # Clear with confirmation
```

#### Test Coverage

| File | Tests |
|---|---|
| `tests/cli/feedback.test.ts` | 20 |

---

### 3.11 Marketplace Unified CLI (`buff marketplace`)

**Status:** ✅ Completed (July 2026)

**Objective:** Unified browsing experience for workflow templates and plugin providers — search, install, and discover from a single CLI entry point.

#### What was built

| Component | File | Description |
|---|---|---|
| **CLI Command** | `src/cli/marketplace.ts` | `buff marketplace browse/search/install/info` — unified entry point wrapping workflow registry + plugin discovery |
| **Browse** | `src/cli/marketplace.ts` | Displays built-in templates, installed registry templates, and plugin providers together in categorized sections |
| **Search** | `src/cli/marketplace.ts` | Cross-searches built-in templates (`WorkflowTemplate.name`), GitHub registry (`searchRegistry()`), and plugin registry (`getAllPlugins()`) |
| **Install** | `src/cli/marketplace.ts` | Delegates to `workflow/registry.ts` for template installation with spinner and error handling |
| **Info** | `src/cli/marketplace.ts` | Shows detailed metadata for built-in templates, plugins (name, version, description, author), or registry entries |
| **Router Registration** | `src/cli/router.ts` | Registered as top-level `buff marketplace` command |
| **Unit Tests** | `tests/cli/marketplace.test.ts` | 18 tests covering browse (all items, workflows only, plugins only, no plugins, refresh), search (built-in match, registry match, network error, no results), install (success, not found, network failure), info (built-in, plugin, registry) |

#### CLI Usage

```bash
buff marketplace browse                               # Show all items
buff marketplace browse --workflows                   # Workflow templates only
buff marketplace browse --plugins                     # Plugins only
buff marketplace browse --refresh                     # Refresh registry cache
buff marketplace search "deploy"                      # Search all sources
buff marketplace install security-audit               # Install from registry
buff marketplace info quick-fix                       # Built-in template details
buff marketplace info "Custom AI"                     # Plugin details
```

#### Test Coverage

| File | Tests |
|---|---|
| `tests/cli/marketplace.test.ts` | 18 |

---

## 🌐 Phase 4: Industry Standards & Autonomous Polish

**Vision:** Bridge the last critical gaps vs. the 2026 competitive landscape by adopting industry-standard protocols (MCP, A2A), adding structural code precision (AST-aware editing), building autonomous error-repair loops, and making the tool one-command installable via `npx`.

### 4.1 MCP (Model Context Protocol) Integration

**Status:** ✅ Completed (August 2026)

**Objective:** Make Agent-Nuvira MCP-compatible so agents can connect to databases, APIs, documentation sites, and any MCP-compatible tool server during execution.

#### What was built

| Component | File | Description |
|---|---|---|
| **MCP Protocol Types** | `src/mcp/types.ts` | JSON-RPC 2.0 messages, Tool/Resource/Prompt descriptors, Content types (Text, Image, EmbeddedResource), server config and connection state |
| **MCP Client (stdio)** | `src/mcp/client.ts` | Subprocess spawn with JSON-RPC over stdin/stdout; initialize handshake, tool/resource/prompt discovery, tool invocation with pending request tracking and timeout |
| **MCP Client (SSE)** | `src/mcp/client.ts` | HTTP fetch + SSE response parsing for remote MCP servers; full JSON-RPC lifecycle |
| **MCP Manager** | `src/mcp/manager.ts` | Discovers server configs from `~/.buff/mcp/*.json`, manages connection pool (connect/disconnect/reconnect), unified tool lookup across all connected servers |
| **CLI Command** | `src/cli/mcp.ts` | `buff mcp list`, `connect` (by name or `--all`), `call` (with `--server` and `--args`), `info`, `refresh` — full lifecycle management |
| **MCP Agent** | `src/agents/agents/mcp-agent.ts` | Agent that invokes MCP tools during orchestration — reads tool requests from context metadata or parses from task descriptions, executes via MCP Manager, stores results back in context |
| **Orchestrator Integration** | `src/agents/orchestrator.ts` | Auto-connects MCP servers on pipeline start (step 2c), injects `mcpTools` + `mcpToolsFormatted` into vault metadata, registers `mcp` agent type, `enableMcp` option (default true), cleanup on pipeline end |
| **WriterAgent Integration** | `src/agents/agents/writer.ts` | Injects formatted MCP tool descriptions into the Writer prompt so LLM knows what external tools are available |
| **Planner Integration** | `src/agents/agents/planner.ts` | Valid `mcp` agent type listed in planner's system prompt — Planner can schedule MCP tool invocation steps |
| **Config Examples** | `examples/mcp/filesystem.json`, `examples/mcp/README.md` | Built-in filesystem server config example + documentation with field descriptions, usage, and links to official MCP servers |
| **Public Exports** | `src/index.ts` | Exports `MCPClient`, `MCPManager`, `MCPCommand`, `MCPAgent`, `McpToolEntry`, `McpToolResult`, all protocol types |

#### Architecture

```
User: buff mcp call get_weather --args '{"location":"NYC"}'
    │
    ▼
MCPManager.callTool("get_weather")
    │  (searches all connected servers)
    ├── MCPClient (weather-server)
    │     ├─ JSON-RPC: tools/call { name: "get_weather", arguments: {...} }
    │     ├─ [stdio] ChildProcess.stdin.write(message)
    │     │         └─ ChildProcess.stdout → parse JSON-RPC response
    │     └─ [sse]  HTTP POST → parse SSE response
    │
    ▼
CallToolResult { content: [{ type: "text", text: "..." }], isError: false }
```

#### CLI Usage

```bash
# Connect to MCP servers
buff mcp connect filesystem              # Connect to a filesystem MCP server
buff mcp connect --all                   # Connect to all discovered servers

# List tools
buff mcp list                            # Show servers, status, and tool counts

# Call tools
buff mcp call read_file --args '{"path":"/tmp/test.txt"}'
buff mcp call get_weather --server weather --args '{"location":"NYC"}'

# Server info
buff mcp info filesystem                 # Show server details and tool list

# Refresh
buff mcp refresh                         # Re-discover and reconnect all servers
```

#### Server Configuration

MCP servers are configured via JSON files in `~/.buff/mcp/`. Example (`filesystem.json`):

```json
{
  "name": "filesystem",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/project"],
  "enabled": true
}
```

#### Test Coverage

| File | Tests |
|---|---|
| `tests/mcp/mcp-client.test.ts` | 30 (constructor, stdio/SSE transport, tool discovery, invocation, timeout, JSON-RPC errors, readResource, getPrompt, error events) |
| `tests/mcp/mcp-manager.test.ts` | 31 (config discovery, connection management, tool management, singleton, partial failure, error propagation) |
| `tests/mcp/mcp-e2e.test.ts` | 7 (real subprocess: connect, tool discovery, greet/echo calls, listTools, disconnect/reconnect, post-disconnect rejection) |
| **Total MCP Tests** | **68** (passed, 100%) |

> 📖 **Test documentation:** See [`tests/README.md`](tests/README.md) for a full walkthrough of all MCP test files, architecture, mock patterns, and run commands.

#### E2E Real Server Verification

Tested against the live `@modelcontextprotocol/server-filesystem` via `npx`:

| Test | Result | Detail |
|---|---|---|
| Auto-download via npx | ✅ | Server fetched and started on-the-fly |
| Protocol handshake | ✅ | `initialize` → `tools/list` → `resources/list` → `prompts/list` |
| Tool discovery | ✅ | 14 tools discovered (`read_file`, `write_file`, `list_directory`, etc.) |
| Tool invocation | ✅ | `read_file` returned `package.json` content; `list_directory` listed project root |
| Resource listing | ⚠️ | `Method not found` — expected, filesystem server doesn't expose resources |

#### Key Files

| File | Lines | Purpose |
|---|---|---|
| `src/mcp/types.ts` | ~140 | MCP protocol type definitions |
| `src/mcp/client.ts` | ~320 | MCP client with stdio and SSE transports |
| `src/mcp/manager.ts` | ~180 | MCP server pool manager with config discovery |
| `src/cli/mcp.ts` | ~310 | CLI commands for MCP lifecycle management |
| `src/agents/agents/mcp-agent.ts` | ~200 | MCP tool invocation agent for orchestrator pipelines |
| `tests/mcp/mcp-client.test.ts` | ~450 | Unit tests (30) for MCPClient |
| `tests/mcp/mcp-manager.test.ts` | ~400 | Unit tests (31) for MCPManager |
| `tests/mcp/mcp-e2e.test.ts` | ~150 | Integration tests (7) with real subprocess |
| `examples/mcp/filesystem.json` | ~15 | Built-in filesystem server config example |
| `examples/mcp/README.md` | ~60 | Documentation for MCP config examples |

---

### 4.2 AST-Aware Code Editing Engine

**Status:** ✅ Completed (August 2026)

**Objective:** Replace naive text-based file editing with structural code understanding for safer, more precise changes.

#### What was built

| Component | File | Description |
|---|---|---|
| **Language Types & Configs** | `src/editing/types.ts` | `SupportedLanguage` enum, `StructuralNode` interface, `ASTEdit` types, `LanguageConfig` per language (JS, TS, Python, Go, Rust), utility functions for position/offset conversion |
| **Structural Analyzer** | `src/editing/ast.ts` | Multi-language regex-based analyzer: finds functions, classes, methods, interfaces, traits, type aliases, imports across 5 languages; brace-balanced syntax validation; nested child detection (methods in classes) |
| **Diff & Conflict Engine** | `src/editing/diff.ts` | 8 edit operations (replace-node, replace-body, insert-before/after, insert-child, delete-node, add-import, raw); overlap/priority-based conflict detection; syntax validation post-edit |
| **High-Level Operations** | `src/editing/edit.ts` | `replaceFunctionBody()`, `addMethodToClass()`, `addImport()`, `insertBefore()`, `insertAfter()`, `deleteNode()`, `buildStructuralContext()` |
| **WriterAgent Integration** | `src/agents/agents/writer.ts` | Structural context injected into LLM prompt (file overview with function/class line ranges); syntax validation on LLM output |
| **Public Exports** | `src/index.ts` | All 15+ editing functions and 10+ types exported for external use |

#### Architecture

```
User goal → WriterAgent.buildPrompt()
    │
    ├─ Existing: file content + task description
    └─ NEW: buildStructuralContext(file) → structural overview
         │  (functions, classes, methods with line ranges)
         │
         ▼
    LLM generates modified file content
         │
         ▼
    WriterAgent.parseFileChanges()
         │
         └─ NEW: validateSyntax(code, language) → true/false
              │  (balanced braces, brackets, parentheses)
              │
              ▼
    FileChange[] stored in context bus
```

#### Key Design Decisions

- **No native dependencies**: Tree-sitter native bindings couldn't compile on the target system (`node-gyp-build` blocked). The regex-based structural analyzer provides equivalent practical value for an AI coding assistant where the LLM handles code intelligence.
- **Heuristic, not exact**: The structural analyzer finds function/class boundaries using language-aware regex patterns rather than a full parser. This is sufficient for the WriterAgent's needs (providing structural context for the LLM, validating syntax).
- **Graceful degradation**: Unknown languages fall back to the existing full-file replacement approach. No functionality is blocked.

#### Supported Languages

| Language | Functions | Classes | Interfaces | Imports | Types | Methods |
|---|---|---|---|---|---|---|
| JavaScript | ✅ | ✅ | — | ✅ | — | ✅ |
| TypeScript | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Python | ✅ | ✅ | — | ✅ | — | — |
| Go | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Rust | ✅ | ✅ (struct/enum) | ✅ (trait) | ✅ | ✅ | — |

---

### 4.3 Auto Error-Repair Loop

**Status:** ✅ Completed (August 2026)

**Objective:** Build a self-healing pipeline that automatically retries failed agent steps with different repair strategies, with configurable budget and human-approval gates.

#### What was built

| Component | File | Description |
|---|---|---|
| **Error Classification** | `src/learning/error-repair.ts` | `classifyError()` — categorizes errors into 7 types: `llm-error`, `provider-error`, `process-error`, `injection-blocked`, `context-limit`, `budget-exhausted`, `unknown` via keyword matching |
| **Repair Strategy Engine** | `src/learning/error-repair.ts` | `selectStrategy()` — picks best strategy (re-prompt, switch-model, adjust-temperature, retry-tool, skip-step) based on error category + attempt number |
| **Repair Budget Tracker** | `src/learning/error-repair.ts` | `RepairBudget` — per-task and total attempt tracking with configurable max (default: 3), off mode support |
| **Human-Approval Gate** | `src/learning/error-repair.ts` | `needsApproval()` — allows destructive strategies to require user consent in `prompt` mode |
| **Repair Engine** | `src/learning/error-repair.ts` | `ErrorRepairEngine.repair()` — full repair loop: classify → check budget → select strategy → execute → loop; with non-repairable skip and budget exhaustion handling |
| **Orchestrator Integration** | `src/agents/orchestrator.ts` | Integrated into `executeSingleTask()` — auto-repair for writer, planner, reviewer, security, git, package, MCP, and skill-runner agents (excludes debugger/runner/tester which have own retry logic) |
| **CLI Flags** | `src/cli/execute.ts` | `--max-repairs <N>`, `--repair-mode <auto|prompt|off>`, `--repair-fallback-models <comma-list>` |
| **Public Exports** | `src/index.ts` | Exports `ErrorRepairEngine`, `RepairBudget`, `classifyError`, `isRepairable`, `selectStrategy`, `needsApproval`, `formatRepairSummary`, all type definitions |
| **Unit Tests** | `tests/learning/error-repair.test.ts` | 39 tests covering classification, repairability, strategy selection, human-approval gate, budget, full repair loop, and format helpers |

#### Repair Strategies

| Strategy | When applied | What it does |
|---|---|---|
| `re-prompt` | LLM errors, unknown errors | Re-invokes LLM with error context appended to the goal |
| `switch-model` | Provider errors, persistent LLM failures (with fallbacks) | Retries with an alternative model from `--repair-fallback-models` |
| `adjust-temperature` | LLM errors at attempt 2+ (no fallbacks) | Lowers temperature to 0.2 for more deterministic output |
| `retry-tool` | Provider errors (retry), process errors | Retries the same operation after a brief delay |
| `skip-step` | Budget exhausted or non-repairable | Gracefully skips the failing step |

#### Error Classification

| Category | Examples | Repairable? |
|---|---|---|
| `llm-error` | JSON parse failure, invalid output format | ✅ Re-prompt or adjust temperature |
| `provider-error` | Rate limit, server 5xx, timeout, network error | ✅ Switch model or retry |
| `process-error` | Subprocess crashed, ENOENT, non-zero exit | ⚠️ Conditionally repairable (retry) |
| `injection-blocked` | Security guardrail triggered | ❌ Not repairable (abort) |
| `context-limit` | Context too large, token limit exceeded | ✅ Repairable (re-prompt after prune) |
| `budget-exhausted` | Retry budget used up | ❌ Not repairable |
| `unknown` | Unclassifiable error | ⚠️ Try generic re-prompt |

#### CLI Usage

```bash
buff execute "refactor auth module" --max-repairs 5
buff execute "fix bug" --repair-mode prompt          # Ask before each repair
buff execute "add tests" --repair-mode off          # Disable auto-repair
buff execute "deploy" --repair-fallback-models "groq/llama3,nim/mistral"
```

#### Test Coverage

| File | Tests |
|---|---|
| `tests/learning/error-repair.test.ts` | 39 |

---

### 4.4 A2A Protocol Support

**Status:** ✅ Completed (August 2026)

**Objective:** Add A2A (Agent-to-Agent) protocol compatibility so Agent-Nuvira can collaborate with other A2A-compliant agents across organizational boundaries.

#### What was built

| Component | File | Description |
|---|---|---|
| **A2A Protocol Types** | `src/federation/a2a-types.ts` | Full A2A type definitions: AgentCard, AgentCapability, AgentSkill, A2ATask, A2ATaskResult, A2ATaskRequest, A2ATaskResponse, A2AHealth, A2ADiscoveryResult — following Google A2A spec |
| **Default AgentCard Generator** | `src/federation/a2a-types.ts` | `createDefaultAgentCard()` — generates a comprehensive AgentCard with 6 capabilities, 4 skills, input/output schemas, and authentication metadata |
| **A2A HTTP Server** | `src/federation/a2a-server.ts` | Express-free HTTP server with 5 endpoints: `GET /.well-known/agent-card`, `GET /a2a/agent-card`, `POST /a2a/task` (202 Accepted with async execution), `GET /a2a/task/:id` (status polling), `GET /a2a/health` — in-memory task store, CORS headers, timeout enforcement |
| **A2A HTTP Client** | `src/federation/a2a-client.ts` | `fetchAgentCard()` (dual-path discovery), `delegateTask()` (POST with validation), `pollTaskStatus()` (with 404 throw, progress logging), `delegateAndWait()` (combined), `checkA2AHealth()` — all with configurable timeouts |
| **CLI A2A Subcommands** | `src/cli/federation.ts` | `buff federation a2a discover <url>`, `start`, `status <url>`, `run <url> <goal>` — full lifecycle with formatted output |
| **Public Exports** | `src/index.ts` | All types, client functions, server functions, and default AgentCard generator exported |
| **Unit Tests** | `tests/federation/a2a.test.ts` | 22+ tests covering types/constants, AgentCard generation, server HTTP endpoints (AgentCard, health, task delegation, validation, CORS, 404s), client functions (discovery, delegation, polling, health) |

#### A2A Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/.well-known/agent-card` | GET | Standard discovery endpoint (AgentCard) |
| `/a2a/agent-card` | GET | Alternative discovery endpoint |
| `/a2a/task` | POST | Delegate a task (returns 202 with taskId) |
| `/a2a/task/:id` | GET | Poll task status/result |
| `/a2a/health` | GET | Health check |

#### CLI Usage

```bash
buff federation a2a start                              # Start A2A server
buff federation a2a discover http://192.168.1.50:8375  # Discover remote agent
buff federation a2a status http://other-node:8375      # Check health
buff federation a2a run http://other-node:8375 "fix login bug" --agent writer
buff federation a2a run http://other-node:8375 "review code" --skill review-code
```

#### Architecture

```
A2A Client (this node)          A2A Server (remote node)
    │                                │
    ├─ fetchAgentCard() ──────────►  GET /.well-known/agent-card
    │                                │  Returns AgentCard (6 capabilities, 4 skills)
    │◄────────────────────────────── ┘
    │
    ├─ delegateAndWait() ─────────►  POST /a2a/task
    │                                │  202: { taskId, status: "running", statusEndpoint }
    │◄────────────────────────────── ┘
    │                                │  [background] executeTask(goal, agentType)
    │                                │    ├─ ConfigManager → Orchestrator.execute()
    │                                │    └─ Promise.race with A2A_TASK_TIMEOUT_MS
    │                                │
    ├─ pollTaskStatus() ──────────►  GET /a2a/task/:id
    │                                │  { status: "completed"| "failed", result: {...} }
    │◄────────────────────────────── ┘

Why it matters: A2A is becoming the standard for cross-ecosystem agent collaboration. Supporting both custom federation (for internal networks) and A2A (for interop) future-proofs the platform.

---

### 4.5 CI/CD Headless Mode (`buff ci`)

**Status:** ✅ Completed (August 2026)

**Objective:** Run Agent-Nuvira deterministically in CI pipelines with structured JSON output suitable for GitHub Actions, GitLab CI, etc.

#### What was built

| Component | File | Description |
|---|---|---|
| **`buff ci execute`** | `src/cli/ci.ts` | Executes a goal via the Orchestrator, emits structured JSON to stdout (`CIExecuteResult` with success, goal, summary, tasksCompleted, fileChanges, error, durationMs, provider/model), exits with code 0/1 |
| **`buff ci check`** | `src/cli/ci.ts` | Gate check mode — runs orchestrator and exits 0/1 with minimal output; `--verbose` flag to emit full JSON for debugging |
| **`buff ci review`** | `src/cli/ci.ts` | Reviews one or more files using `ReviewerAgent`, parses the LLM output into structured findings (`CIReviewFinding[]`) with severity, line number, message, and suggestion |
| **GitHub Actions Integration** | `src/cli/ci.ts` | `--github-annotations` flag on execute/review emits GitHub Actions annotation format (`::error file=...,line=...::message`) to stderr for inline PR annotations |
| **Output Parsing Engine** | `src/cli/ci.ts` | `parseReviewOutput()` — parses structured findings from reviewer text output supporting ERROR/WARNING/INFO prefixes, emoji indicators (❌⚠️💡), checklist items, line numbers, and suggestions |
| **CLI Registration** | `src/cli/router.ts` | Registered as top-level `buff ci` command with 3 subcommands |
| **Public Exports** | `src/index.ts` | Exports `CICommand`, `CIExecuteResult`, `CIReviewResult`, `CIReviewFinding`, `CICheckResult` types |
| **Unit Tests** | `tests/cli/ci.test.ts` | 23 tests covering type shapes, parseReviewOutput (ERROR/WARNING/INFO, emoji, checklists, line numbers, suggestions, edge cases), CLI registration, and edge cases |

#### Subcommands

| Subcommand | Arguments | Key Flags | Exit Codes |
|---|---|---|---|
| `buff ci execute` | `<goal>` | `--provider`, `--model`, `--memory`, `--sandbox`, `--context-limit`, `--github-annotations` | 0 = success, 1 = failure |
| `buff ci check` | `<goal>` | `--provider`, `--model`, `--verbose` | 0 = pass, 1 = fail |
| `buff ci review` | `<files...>` | `--provider`, `--model`, `--format` (json/github), `--context` | 0 = no errors, 1 = errors found |

#### JSON Output Examples

**buff ci execute "add tests":**
```json
{
  "success": true,
  "goal": "add tests to auth module",
  "summary": "Created auth.test.ts with unit tests for login, logout, and refreshToken",
  "tasksCompleted": 3,
  "tasksTotal": 3,
  "durationMs": 12450,
  "provider": "groq",
  "model": "llama-3.3-70b"
}
```

**buff ci review src/auth.ts:**
```json
{
  "success": false,
  "filesReviewed": 1,
  "totalFindings": 3,
  "errors": 1,
  "warnings": 1,
  "infos": 1,
  "findings": [
    {
      "file": "src/auth.ts",
      "severity": "error",
      "line": 42,
      "message": "Hardcoded JWT secret detected",
      "suggestion": "Move to environment variable"
    },
    {
      "file": "src/auth.ts",
      "severity": "warning",
      "line": 15,
      "message": "Type 'any' used"
    }
  ],
  "durationMs": 3200
}
```

**buff ci check "is the build ready for production?":**
```json
{
  "passed": true,
  "summary": "All security checks pass and test coverage is adequate",
  "durationMs": 8500
}
```

#### GitHub Actions Integration

```yaml
# .github/workflows/agent-review.yml
name: Agent-Nuvira Code Review
on: [pull_request]
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run AI code review
        run: |
          npx agent-nuvira ci review src/*.ts --format github --provider groq
        env:
          GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}

  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Check production readiness
        run: |
          npx agent-nuvira ci check "is this ready for production?" --provider groq
        env:
          GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
```

**Why it matters:** This opens enterprise adoption — teams can add Agent-Nuvira as a CI step for automated code review, test fixing, and dependency updates.

---

### 4.6 npm Publishing & One-Line Install

**Status:** ✅ Completed (August 2026)

**Objective:** Make `npx agent-nuvira` work out of the box with zero setup friction.

#### Action Items

| # | Task | Complexity |
|---|---|---|
| 4.6.1 | Clean up `package.json` for npm publishing (exclude dev deps from bundle) | Low |
| 4.6.2 | Publish to npm under `@agent-nuvira/cli` | Low |
| 4.6.3 | Ensure `buff init` flow works post-`npx` | Low |

**Why it matters:** `npx agent-nuvira` is the lowest-friction onboarding. Currently requires manual clone/build.

---

## 🛡️ Risk Matrix

| Initiative | Risk Level | Key Risk | Mitigation |
|---|---|---|---|
| **Phase 1** | | | |
| 1.1 Auto-discovery plugin loader | 🟢 Low ✅ | Malicious plugins | Validate interfaces; opt-in confirmation |
| 1.2 Complete streaming | 🟢 Low ✅ | Varying SSE formats | Normalize via SSE utility |
| 1.3 Cost tracking | 🟢 Low ✅ | API cost changes | Configurable rates |
| 1.4 `buff init` | 🟢 Low ✅ | Template maintenance | Simple file-based templates |
| 1.5 Prompt history search | 🟢 Low ✅ | Privacy concerns | Local-only storage; clear command |
| **1.6 Skill Compiler** | 🟢 Low ✅ | LLM parsing failures | Graceful fallback; empty result handling |
| **1.7 Context Pruner** | 🟢 Low ✅ | Over-pruning critical data | Strategies applied least-destructive first |
| **1.8 `buff model` switch** | 🟢 Low ✅ | Invalid provider names | Fallback to default provider with warning |
| **Phase 2** | | | |
| **2.1 Native embeddings** | 🟡 Medium ✅ | npm dependency bloat | Optional dep; fallback chain |
| **2.2 Workflow marketplace** | 🟡 Medium ✅ | Low adoption | Quality built-in templates |
| **2.3 Model benchmarking** | 🟡 Medium ✅ | API costs for benchmarks | `--budget` flag; small models default |
| **2.4 Docker sandbox** | 🟡 Medium ✅ | Docker dependency | Keep tmpdir as default |
| **2.5 Provider health dashboard** | 🟢 Low ✅ | Sequential checks slow | Parallel checks with timeout |
| **2.6 Memory compression** | 🟡 Medium ✅ | Context loss | Keep originals until verified |
| **Phase 3** | | | |
| **3.1 VS Code extension** | 🔴 High ✅ | Engineering effort | Iterative MVP |
| **3.2 Remote federation** | 🔴 High ✅ | Security, network issues | Local-only default; opt-in |
| **3.3 Web UI dashboard** | 🔴 High ✅ | Scope creep | Minimal MVP; iterate |
| **3.4 Hybrid routing** | 🟡 Medium ✅ | Complex decision logic | Verbose mode; manual override |
| **3.5 Team collaboration** | 🔴 High ✅ | Shared state conflicts | Git-based sync |
| **3.6 Agent SDK** | 🟡 Medium ✅ | API stability | Semantic versioning |
| **3.7 Provider CLI** | 🟢 Low ✅ | Provider API changes | Timeout + graceful degradation |
| **3.8 Fallback Routing** | 🟡 Medium ✅ | Fallback loops | Circuit breaker; max attempts |
| **3.9 Security Scan** | 🟢 Low ✅ | False positives | Severity threshold config |
| **3.10 Feedback System** | 🟢 Low ✅ | Low engagement | Passive prompts after actions |
| **3.11 Marketplace CLI** | 🟢 Low ✅ | Registry unavailable | Graceful fallback to local results |
| **Phase 4** | | | |
| **4.1 MCP Integration** | 🟡 Medium ✅ | Protocol changes | Abstract transport layer; spec version pinned |
| **4.2 AST editing** | 🔴 High ✅ | Complex implementation | Iterative per-language support |
| **4.3 Auto error-repair** | 🟡 Medium ✅ | Infinite loops | Max retry budget; human-approval gate |
| **4.4 A2A protocol** | 🟡 Medium ✅ | Competing standards | Abstraction layer; support both |
| **4.5 CI/CD headless** | 🟢 Low ✅ | Determinism | STDIN-based scripting |
| **4.6 npm publishing** | 🟢 Low ✅ | Package size | Tree-shaking; minimal deps |

---

## 🎯 Success Criteria & KPIs

### Phase 1 Metrics (1–3 months)

| Metric | Target | Measurement |
|---|---|---|
| Plugin adoption | 5+ community plugins within 3 months | `buff plugins list` stats |
| Streaming coverage | 100% of providers | Automated test |
| Cost tracking accuracy | Within 10% of actual charges | Weekly validation |
| Template quality | 5+ built-in templates | Manual review |
| Search speed | < 1s for 10,000 entries | Benchmarked |
| Skill quality | 80%+ pass rate on compiled skills | `buff skill quality` command |
| Context pruning coverage | < 10% orchestrator failures from OOM | Automated |
| Model switch reliability | 100% session continuity | Integration test |

### Phase 2 Metrics (3–9 months)

| Metric | Target | Measurement |
|---|---|---|
| Embedding speed | < 500ms (10x improvement) | Benchmarked |
| Workflow adoption | 10+ community templates | GitHub registry stats |
| Benchmark coverage | 20+ coding tasks | Automated |
| Doctor speed | < 10s full check | Benchmarked |
| Memory reduction | 60%+ compression | Automated |

### Phase 3 Metrics (12+ months)

| Metric | Target | Measurement |
|---|---|---|
| VS Code adoption | 20% of CLI users | Telemetry (opt-in) |
| Federation reliability | 99.9% uptime | Automated monitoring |
| Routing accuracy | < 10% override rate | Logged |
| Custom agents | 5+ community | GitHub stats |

### Overall Project Health

| Metric | Current | Target |
|---|---|---|
| GitHub stars | — | 100+ |
| npm downloads/month | — | 500+ |
| Test coverage | ~60% | >80% |
| Open issues resolved | — | Within 7 days |
| PR merge time | — | < 48 hours |

---

## 🏛️ Architecture Evolution

### Current Architecture (v1.x)

```
CLI (chat, edit, plan, models, config, cache, execute, run, workflow, plugins, learn)
  │
  ├── Agents (planner, gatherer, writer, reviewer, tester, debugger, runner, git, package, release, security)
  ├── Inference (5 providers: local, groq, nim, gemini, openrouter)
  ├── Memory (vector store, trajectory store, embedder, memory integration)
  ├── Learning (scorer, model-router, pattern-extractor, agent-stats, self-improver)
  ├── Context (parser, cache/SQLite)
  ├── Security (injection scanner, PII scanner)
  ├── Plugins (programmatic API)
  └── Config (JSON config + env vars)
```

### Target Architecture (v3.x)

```
Interfaces
  ├── CLI (terminal) — primary
  ├── VS Code Extension — secondary
  └── Web Dashboard — complementary

CLI Commands
  ├── chat, edit, plan, models, config, cache (existing)
  ├── execute, run, workflow (existing multi-agent)
  ├── init, history, doctor, benchmark (Phase 1-2 new)
  └── team, federation, dashboard (Phase 3 new)

Orchestrator (enhanced)
  ├── Agent Pool (10+ built-in + custom plugins)
  ├── Hybrid Model Router (Phase 3)
  ├── Federation Protocol (Phase 3)
  └── Team Sync (Phase 3)

Inference Layer
  ├── Local (Ollama, HuggingFace, GGML + streaming)
  ├── Groq (streaming ✅)
  ├── NVIDIA NIM (streaming ✅)
  ├── Google Gemini (streaming)
  ├── OpenRouter (streaming)
  └── Auto-discovered plugins

Memory & Learning
  ├── Vector Store (native embeddings)
  ├── Trajectory Store (compression)
  ├── Pattern Extractor
  ├── Scorer + Agent Stats
  ├── Cost Tracker
  └── Benchmark Engine

Infrastructure
  ├── Auto-discovery (~/.buff/plugins/, ~/.buff/agents/, ~/.buff/workflows/)
  ├── Docker Sandbox (opt-in)
  ├── Git-based Team Sync
  └── Agent SDK
```

---

## 📋 Implementation Order

```
Phase 1.1 ───► Phase 1.2 ───► Phase 1.3 ───► Phase 1.4 ───► Phase 1.5 ───► Phase 1.6 ───► Phase 1.7 ───► Phase 1.8
    ✅               ✅               ✅               ✅               ✅               ✅               ✅               ✅
    │
    ▼
Phase 2.1 ───► Phase 2.2 ───► Phase 2.3 ───► Phase 2.4 ───► Phase 2.5 ───► Phase 2.6
    ✅               ✅               ✅               ✅               ✅               ✅
    │
    ├────────────────────────────────────────────────────────────────────┤
    ▼                                                                    ▼
Phase 3.1 ───► Phase 3.2 ───► Phase 3.3 ───► Phase 3.4 ───► Phase 3.5 ───► Phase 3.6 ───► Phase 3.7 ───► Phase 3.8 ───► Phase 3.9 ───► Phase 3.10 ───► Phase 3.11
    ✅               ✅               ✅               ✅               ✅               ✅               ✅               ✅               ✅               ✅               ✅
    │
    ▼
Phase 4.1 ───► Phase 4.2 ───► Phase 4.3 ───► Phase 4.4 ───► Phase 4.5 ───► Phase 4.6
    ✅               ✅               ✅               ✅               ✅               ✅

**Phase 1–3: 25 phases completed as of July 2026 | Phase 4: 6/6 completed (All items ✅)**
```

**Within each phase, items can be implemented in parallel where dependencies allow.**

> ✅ = Phases 1–3 completed (25/25) | Phase 4 fully completed (6/6 — all items ✅)

---

*Last updated: August 2026 — Phases 1–3: 25/25 completed · Phase 4: 6/6 completed (all items ✅)*
*Author: Dheeraj Sharma*
