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
5. [Risk Matrix](#-risk-matrix)
6. [Success Criteria & KPIs](#-success-criteria--kpis)
7. [Architecture Evolution](#-architecture-evolution)

---

## 📊 Current State & Comparison

### Agent-Baba-d vs Freebuff — Feature Matrix

| Feature | Freebuff | Agent-Baba-d | Advantage |
|---|---|---|---|
| **Architecture** | Multi-agent (4 roles) | Multi-agent (10+ roles) | Agent-Baba-d |
| **Inference Providers** | Freebuff servers only | 5: Local, Groq, NIM, Gemini, OpenRouter | Agent-Baba-d |
| **Server Dependency** | Yes — requires cloud | None — BYO API keys, offline-capable | Agent-Baba-d |
| **Multi-Agent Pipeline** | Sequential only | Sequential + parallel (dependency-aware) | Agent-Baba-d |
| **Self-Learning** | None | Scorer, model-router, pattern-extractor, agent-stats, self-improver | Agent-Baba-d |
| **Persistent Memory** | Session-only | Vector store + trajectory store + embedding | Agent-Baba-d |
| **Streaming** | Unknown | Partial (Groq, NIM) | Partial |
| **Plugin System** | Custom agents (TypeScript) | Programmatic plugin API | Similar |
| **Testing Sandbox** | None | TesterAgent with temp dir sandbox | Agent-Baba-d |
| **Git Integration** | None | GitAgent, PackageAgent, GitHubReleaseAgent | Agent-Baba-d |
| **Security Scanning** | Privacy-focused only | Injection scanner, PII scanner, security agent | Agent-Baba-d |
| **Code Execution** | None | RunnerAgent with sandboxed execution | Agent-Baba-d |
| **Workflow Templates** | None | YAML-based workflow templates | Agent-Baba-d |
| **Model Discovery** | None | `buff models` with search/filter | Agent-Baba-d |
| **Cost** | Free (ad-supported) | Free + user API keys or local models | Agent-Baba-d |
| **Data Privacy** | Routes through cloud | Fully offline with local models | Agent-Baba-d |
| **Setup Friction** | Zero (install & run) | Requires API keys or Ollama | Freebuff |

### Gap Analysis — Agent-Baba-d Improvements Needed

| Gap | Severity | Current Workaround |
|---|---|---|
| No auto-discovery plugin loader | High | Manual plugin registration |
| Streaming incomplete (3/5 providers) | High | Falls back to non-streaming |
| No cost tracking | Medium | Manual API dashboard checks |
| No project scaffolding | Medium | Manual file creation |
| No prompt history search | Medium | Session-only history |
| No benchmark system | Medium | Manual model comparison |
| No Docker sandbox isolation | Low | Temp directory (less secure) |
| No IDE integration | Low | Terminal-only workflow |
| No remote federation | Low | Single-machine only |
| No web UI | Low | Terminal-only interface |
| No team collaboration | Low | Single-user focus |

---

## ⚡ Phase 1: Quick Wins (1–3 months)

### 1.1 Auto-Discovery Plugin Loader

**Objective:** Allow users to drop provider plugin files into `~/.buff/plugins/` and have them automatically loaded at startup — no manual registration required.

#### Action Items

| # | Task | File(s) | Complexity |
|---|---|---|---|
| 1.1.1 | Create `~/.buff/plugins/` directory watcher at startup | `src/index.ts`, `src/cli/router.ts` | Small |
| 1.1.2 | Implement auto-loader for `.js` files exporting `ProviderPlugin` | `src/plugins/registry.ts` | Medium |
| 1.1.3 | Add `buff plugins list` to show auto-discovered plugins | `src/cli/plugins.ts` | Small |
| 1.1.4 | Add `buff plugins discover` to force re-scan | `src/cli/plugins.ts` | Small |
| 1.1.5 | Validate plugin interface before loading with error reporting | `src/plugins/registry.ts` | Small |

#### Dependencies
- Existing plugin registry (`src/plugins/registry.ts`)
- Existing agent-plugin discovery (`src/plugins/agent-plugin.ts`)

#### Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Malicious plugins loaded automatically | Low | Validate `ProviderPlugin` interface before loading; add opt-in confirmation for first load |
| Plugin errors crash startup | Medium | Wrap each plugin load in try/catch; log errors per plugin |
| Dynamic `import()` path resolution issues | Medium | Use `import()` with absolute paths resolved via `path.resolve` |

#### Expected Outcomes
- ✅ Users can drop a `.js` file into `~/.buff/plugins/` and use the new provider immediately
- ✅ `buff plugins list` shows all auto-discovered plugins
- ✅ Plugin errors don't crash the CLI
- ✅ Test: Place a mock plugin, verify it appears in `buff plugins list`

#### Success Criteria
- **Functional:** Drop a valid plugin → `buff plugins list` shows it → `buff chat --provider <plugin>` works
- **Error handling:** Drop an invalid plugin → error message shown → CLI doesn't crash
- **Performance:** Adding 20 plugins adds < 100ms to startup time

---

### 1.2 Complete Streaming Support

**Objective:** All 5 providers support real-time token-by-token streaming in chat mode.

#### Action Items

| # | Task | File(s) | Complexity |
|---|---|---|---|
| 1.2.1 | Implement `generateStream()` for Gemini adapter (Gemini API SSE) | `src/inference/gemini-adapter.ts` | Medium |
| 1.2.2 | Implement `generateStream()` for OpenRouter adapter (OpenAI-compatible SSE) | `src/inference/openrouter-adapter.ts` | Small |
| 1.2.3 | Implement `generateStream()` for Local/Ollama adapter (Ollama SSE) | `src/inference/local-adapter.ts` | Medium |
| 1.2.4 | Ensure `edit`, `plan` commands show streaming progress when available | `src/cli/edit.ts`, `src/cli/plan.ts` | Small |
| 1.2.5 | Add tests for streaming on each adapter | `tests/inference/*.test.ts` | Medium |

#### Dependencies
- Existing SSE utility (`src/inference/sse.ts`)
- Existing `generateStream()` interface in `InferenceProvider`

#### Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Gemini streaming API format differs from OpenAI | Medium | Use Gemini's native `streamGenerateContent` endpoint; parse SSE differently |
| Ollama streaming format differs | Medium | Ollama uses newline-delimited JSON, not SSE; write a dedicated parser |
| SSE utility doesn't handle all formats | Medium | Refactor `sse.ts` to support multiple SSE dialects |

#### Expected Outcomes
- ✅ Chat mode shows streaming tokens for all 5 providers
- ✅ `edit` and `plan` commands use streaming when available
- ✅ Fall back to non-streaming gracefully when streaming fails

#### Success Criteria
- **Functional:** `buff chat --provider gemini` shows tokens as they arrive
- **Performance:** Time-to-first-token < 2s for all cloud providers
- **Reliability:** Streaming works in 95%+ of API calls

---

### 1.3 Model Cost & Usage Tracking

**Objective:** Track API costs per provider per session and provide actionable cost visibility.

#### Action Items

| # | Task | File(s) | Complexity |
|---|---|---|---|
| 1.3.1 | Add cost-per-token constants for each provider | `src/config/types.ts` or new `src/learning/cost-tracker.ts` | Small |
| 1.3.2 | Parse API response headers for usage data (token counts) | Each adapter's `generate()` method | Medium |
| 1.3.3 | Store session costs in `~/.buff/memory/cost-tracker.json` | New `src/learning/cost-tracker.ts` | Medium |
| 1.3.4 | Add `buff stats cost` CLI command | New `src/cli/stats.ts` | Small |
| 1.3.5 | Show per-session cost estimate before expensive operations | `src/cli/chat.ts`, `src/cli/execute.ts` | Small |

#### Dependencies
- Existing memory directory structure (`~/.buff/memory/`)
- Config system for provider rate configuration

#### Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| APIs change cost structures | Medium | Make cost configurable via config file |
| Token counts not always available in API responses | High | Estimate costs from prompt length when counts unavailable |
| Floating-point precision for micro-costs | Low | Store costs as integers (micro-cents) |

#### Expected Outcomes
- ✅ `buff stats cost` shows session/daily/monthly costs per provider
- ✅ Warning shown before expensive operations
- ✅ Cost data persisted across CLI restarts

#### Success Criteria
- **Functional:** `buff stats cost` shows accurate costs within 10% of actual API charges
- **Performance:** Cost calculation adds < 1ms to each request
- **Storage:** < 1MB for 10,000 tracked requests

---

### 1.4 Interactive `buff init` Command

**Objective:** Scaffold new projects from the CLI with configurable templates and provider presets.

#### Action Items

| # | Task | File(s) | Complexity |
|---|---|---|---|
| 1.4.1 | Create `buff init [project-name]` command | New `src/cli/init.ts` | Medium |
| 1.4.2 | Define template format (JSON/YAML) with variables | New `src/cli/init-templates.ts` | Small |
| 1.4.3 | Ship 5 built-in templates (Node.js CLI, TS lib, React app, Python, Go) | `src/cli/templates/` | Medium |
| 1.4.4 | Allow custom template directories (`~/.buff/templates/`) | `src/cli/init.ts` | Small |
| 1.4.5 | Generate initial `.buffconfig.json` with provider selection wizard | `src/cli/init.ts` | Small |

#### Dependencies
- Existing config manager for provider wizard
- Node.js `fs` module for file operations

#### Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Template maintenance burden | Medium | Store templates as simple JSON file structures, not complex generators |
| Provider selection wizard complexity | Low | Reuse existing model picker UI (`src/cli/model-picker.ts`) |

#### Expected Outcomes
- ✅ `buff init my-app` creates a working starter project in under 5 seconds
- ✅ Interactive provider selection during init
- ✅ Custom templates supported via `~/.buff/templates/`

#### Success Criteria
- **Functional:** `buff init api-server` generates a fully functional Node.js/Express project
- **Coverage:** 5+ built-in templates at launch
- **Speed:** Project scaffolding completes in < 5 seconds for small templates

---

### 1.5 Prompt History Search

**Objective:** Allow users to search past chat conversations by keyword or semantic similarity.

#### Action Items

| # | Task | File(s) | Complexity |
|---|---|---|---|
| 1.5.1 | Store chat history in SQLite (reuse cache module) | `src/context/cache.ts` | Small |
| 1.5.2 | Add `/search <query>` command in interactive chat | `src/cli/chat.ts` | Medium |
| 1.5.3 | Support keyword search on past conversations | `src/context/history.ts` (new) | Medium |
| 1.5.4 | Add `buff history` CLI command | New `src/cli/history.ts` | Small |
| 1.5.5 | Configurable retention via `buff config set history.retentionDays 30` | Config system | Small |

#### Dependencies
- Existing SQLite cache module (`src/context/cache.ts`)
- Chat conversation model

#### Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Privacy concerns with storing prompts | Medium | Store locally only; add `buff cache clear --history` option |
| SQLite performance with large history | Low | Add pagination and search indexing |

#### Expected Outcomes
- ✅ Users can `/search "add authentication"` and find past conversations
- ✅ `buff history` shows chronological conversation log
- ✅ Automatic cleanup of old history (configurable)

#### Success Criteria
- **Functional:** Search returns relevant past conversations in < 1s for 10,000 entries
- **Privacy:** All data stored locally; no outbound network calls
- **Configurability:** Retention period is user-configurable

---

## 🏗️ Phase 2: Structural Changes (3–9 months)

### 2.1 Native Embedding Support

**Objective:** Replace expensive LLM-based embeddings with a lightweight local embedding model for 10x faster and more accurate semantic search.

#### Action Items

| # | Task | File(s) | Complexity |
|---|---|---|---|
| 2.1.1 | Integrate `@xenova/transformers` for local embedding generation | `src/memory/embedder.ts` | Medium |
| 2.1.2 | Add Python subprocess fallback using `sentence-transformers` | `src/memory/embedder.ts` | Medium |
| 2.1.3 | Keep LLM-based embedding as fallback when local models unavailable | `src/memory/embedder.ts` | Small |
| 2.1.4 | Increase embedding dimensionality from 64 to 384 | `src/memory/embedder.ts` | Small |
| 2.1.5 | Create benchmark suite comparing embedding methods | `tests/memory/embedder.test.ts` | Medium |

#### Dependencies
- Optional `@xenova/transformers` npm package
- Existing embedder module

#### Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| @xenova/transformers adds ~15MB | Medium | Make it an optional peer dependency |
| Python subprocess reliability | Medium | Auto-install script; clear error messages |

#### Expected Outcomes
- ✅ Embedding generation is 10x faster (< 500ms vs 2-5s)
- ✅ Improved search relevance (measured by recall@k)
- ✅ Graceful fallback chain: local → Python → LLM

#### Success Criteria
- **Speed:** 10x improvement over LLM-based embedding
- **Accuracy:** 30% improvement in trajectory search relevance
- **Battery:** Zero additional cost per embedding

---

### 2.2 Workflow Template Marketplace

**Objective:** Create a community-driven marketplace for workflow templates with install/publish commands.

#### Action Items

| # | Task | Complexity |
|---|---|---|
| 2.2.1 | Create GitHub registry repo (`agent-nuvira/workflows`) | Small |
| 2.2.2 | Add `buff workflow install <template>` command | Medium |
| 2.2.3 | Add `buff workflow publish` for sharing templates | Medium |
| 2.2.4 | Support template versioning and dependency declarations | Medium |
| 2.2.5 | Ship 10 built-in starter templates | Medium |

#### Dependencies
- Phase 1.1 auto-discovery plugin loader
- Existing workflow system (`src/workflow/templates.ts`)

#### Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Low community adoption | Medium | Ship 5+ high-quality built-in templates; promote in README |
| Template compatibility across versions | Medium | Semantic versioning for template format |

#### Success Criteria
- **Adoption:** 10+ community-published templates within 6 months
- **Quality:** Built-in templates pass automated tests
- **Usability:** `buff workflow install quick-fix` works in one command

---

### 2.3 Automatic Model Benchmarking

**Objective:** Create a standardized benchmark system to compare models on real coding tasks.

#### Action Items

| # | Task | Complexity |
|---|---|---|
| 2.3.1 | Design benchmark suite of 20+ coding tasks | Medium |
| 2.3.2 | Implement `buff benchmark` command runner | Medium |
| 2.3.3 | Measure: success rate, quality, latency, cost | Medium |
| 2.3.4 | Generate markdown/JSON benchmark reports | Small |
| 2.3.5 | Store results in `~/.buff/memory/benchmarks.json` | Small |

#### Dependencies
- Phase 1.3 cost tracking
- Existing model router

#### Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Benchmarking costs money on API models | High | Default to small models; add `--budget N` flag |
| Benchmark tasks become outdated | Low | Version benchmark suite; allow custom tasks |

#### Success Criteria
- **Coverage:** 20+ standardized coding tasks
- **Actionability:** Users get model recommendations based on their stack
- **Cost control:** `--budget` flag prevents unexpected API charges

---

### 2.4 Sandbox Isolation Enhancements

**Objective:** Strengthen code execution sandbox with Docker support and resource limits.

#### Action Items

| # | Task | Complexity |
|---|---|---|
| 2.4.1 | Add Docker-based sandbox option | Medium |
| 2.4.2 | Implement network isolation for sandboxed code | Medium |
| 2.4.3 | Add configurable resource limits (CPU, memory, time) | Medium |
| 2.4.4 | Support base images for different language runtimes | Medium |

#### Dependencies
- Docker CLI (optional)
- Existing TesterAgent

#### Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Docker dependency adds complexity | Medium | Keep tmpdir as default; Docker as opt-in (`--sandbox docker`) |
| Docker not available on all platforms | High | Auto-detect Docker; fall back to tmpdir |

#### Success Criteria
- **Security:** `--sandbox docker` provides full isolation
- **Compatibility:** Works on Linux, macOS, Windows
- **Performance:** Docker container startup < 3s

---

### 2.5 Provider Health Dashboard (`buff doctor`)

**Objective:** One-command diagnosis of all provider configurations.

#### Action Items

| # | Task | Complexity |
|---|---|---|
| 2.5.1 | Create `buff doctor` command | Medium |
| 2.5.2 | Test each provider: API key, endpoint, model, rate limits | Medium |
| 2.5.3 | Color-coded health report with fix suggestions | Small |
| 2.5.4 | `--watch` mode for continuous monitoring | Small |

#### Dependencies
- Existing config manager
- Inference factory

#### Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Sequential checks are slow | Medium | Run checks in parallel with timeout |
| False negatives from transient errors | Medium | Retry failed checks once |

#### Success Criteria
- **Speed:** Complete health check in < 10s for all providers
- **Actionability:** Suggest specific fixes (e.g., "Run `ollama serve`")
- **Reliability:** < 5% false positive/negative rate

---

### 2.6 Agent Memory Compression & Pruning

**Objective:** Automatically optimize the memory store to prevent bloat and maintain search quality.

#### Action Items

| # | Task | Complexity |
|---|---|---|
| 2.6.1 | Implement automatic trajectory summarization | Medium |
| 2.6.2 | Add configurable retention policy | Small |
| 2.6.3 | Implement trajectory merging | Medium |
| 2.6.4 | Add `buff memory optimize` command | Small |

#### Dependencies
- Existing memory system (vector store, trajectory store)
- Pattern extraction module

#### Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Compression loses important context | Medium | Keep originals until verified; add rollback |

#### Success Criteria
- **Efficiency:** 60%+ memory reduction without search quality degradation
- **Safety:** Rollback available via `buff memory restore`

---

## 🚀 Phase 3: Major Strategic Upgrades (12+ months)

### 3.1 VS Code Extension

**Objective:** Bring Agent-Baba-d's multi-agent power directly into the editor.

#### Action Items

| # | Task | Complexity |
|---|---|---|
| 3.1.1 | Build VS Code extension (`agent-nuvira-vscode`) | High |
| 3.1.2 | Inline code suggestions from agents | High |
| 3.1.3 | File editing via right-click context menu | Medium |
| 3.1.4 | Agent progress panel in VS Code | Medium |
| 3.1.5 | Diff viewer for proposed changes | Medium |
| 3.1.6 | Custom keybindings for common operations | Small |

#### Dependencies
- VS Code Extension API
- Existing CLI as backend (communicate via child_process or LSP)

#### Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| 2-3 months engineer effort for MVP | High | Start with simple command wrapper; iterate |
| VS Code API changes | Low | Pin to stable API |

#### Success Criteria
- **Baseline:** 20% of CLI users also install the extension
- **Functionality:** Run multi-agent pipelines entirely from VS Code
- **UX:** Diff viewer shows changes before applying

---

### 3.2 Remote Agent Collaboration (Federation)

**Objective:** Allow multiple machines to collaborate on the same goal via federated agents.

#### Action Items

| # | Task | Complexity |
|---|---|---|
| 3.2.1 | Design agent-to-agent HTTP/SSE protocol | High |
| 3.2.2 | Delegate tasks to remote agent instances | High |
| 3.2.3 | Multi-machine parallel execution | High |
| 3.2.4 | Secure authentication (pre-shared keys) | Medium |
| 3.2.5 | Add `buff federation join <url>` command | Medium |

#### Dependencies
- Phase 2 sandbox isolation
- Network module

#### Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Network security concerns | High | Local-only default; opt-in with explicit key exchange |
| Latency across machines | Medium | Only delegate CPU-bound tasks remotely |

#### Success Criteria
- **Functionality:** Two machines split tasks (e.g., test on one, lint on another)
- **Security:** End-to-end encryption for agent communication
- **Resilience:** Graceful degradation if remote agent disconnects

---

### 3.3 Web UI Dashboard

**Objective:** Optional web-based dashboard for visualizing agent execution and system status.

#### Action Items

| # | Task | Complexity |
|---|---|---|
| 3.3.1 | Build React-based web dashboard | High |
| 3.3.2 | Real-time execution visualization (DAG) | High |
| 3.3.3 | Conversation history browser | Medium |
| 3.3.4 | Provider health and cost dashboard | Medium |
| 3.3.5 | Model benchmark charts | Medium |
| 3.3.6 | Launch on `buff dashboard` command | Small |

#### Dependencies
- Node.js HTTP server
- WebSocket support

#### Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| UI feature creep | High | MVP shows execution graph + history only; iterate |
| Maintenance burden of dual UI | Medium | Terminal remains primary; dashboard is complementary |

#### Success Criteria
- **MVP:** Visualize agent pipelines and browse history in browser
- **Performance:** Dashboard auto-launches in < 2s

---

### 3.4 Hybrid Model Routing Engine

**Objective:** Intelligent model selection that considers task complexity, cost, availability, and historical performance.

#### Action Items

| # | Task | Complexity |
|---|---|---|
| 3.4.1 | Route based on task complexity + cost budget | High |
| 3.4.2 | Multi-model consensus for critical operations | High |
| 3.4.3 | Automatic fallback chains | Medium |
| 3.4.4 | Expose routing decisions for user override | Small |

#### Dependencies
- Phase 2 benchmarking data
- Phase 1.3 cost tracking
- Existing model router

#### Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Complex routing confuses users | Medium | Show decisions in verbose mode; manual override always available |

#### Success Criteria
- **Accuracy:** 90%+ routing accuracy (measured by user override rate)
- **Cost savings:** 30% average cost reduction vs fixed model

---

### 3.5 Team Collaboration Features

**Objective:** Enable team workflows with shared configuration, memory, and review pipelines.

#### Action Items

| # | Task | Complexity |
|---|---|---|
| 3.5.1 | Project-level `.buffconfig.json` support | Medium |
| 3.5.2 | Shared team memory (read-only shared trajectories) | High |
| 3.5.3 | `buff team` commands (join, sync, review, share) | High |
| 3.5.4 | Review workflow (agent PR → review → merge) | High |
| 3.5.5 | Project-level patterns via git | Medium |

#### Dependencies
- Phase 2.2 federation protocol
- Git integration

#### Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Shared state conflicts | High | Use git-based sync, not live sync |

#### Success Criteria
- **Functionality:** Two developers collaborate on same goal
- **Workflow:** PR → review → merge cycle works end-to-end

---

### 3.6 Agent SDK for Custom Agent Development

**Objective:** Enable third-party developers to build, test, and publish custom agents.

#### Action Items

| # | Task | Complexity |
|---|---|---|
| 3.6.1 | Create `@agent-nuvira/sdk` npm package | High |
| 3.6.2 | SDK: base Agent class, types, ContextVault API, testing utilities | High |
| 3.6.3 | Add `buff agent create <name>` scaffolding command | Medium |
| 3.6.4 | SDK documentation with examples | Medium |
| 3.6.5 | GitHub template repo for agent plugins | Small |

#### Dependencies
- Phase 1.1 auto-discovery
- Existing Agent interface

#### Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| API stability — breaking changes break custom agents | Medium | Semantic versioning; backward compat for major versions |

#### Success Criteria
- **Developer experience:** Build + test a custom agent in < 30 minutes
- **Adoption:** 5+ community agents within 6 months of SDK launch

---

## 🛡️ Risk Matrix

| Initiative | Risk Level | Key Risk | Mitigation |
|---|---|---|---|
| **Phase 1** | | | |
| 1.1 Auto-discovery plugin loader | 🟢 Low | Malicious plugins | Validate interfaces; opt-in confirmation |
| 1.2 Complete streaming | 🟢 Low | Varying SSE formats | Normalize via SSE utility |
| 1.3 Cost tracking | 🟢 Low | API cost changes | Configurable rates |
| 1.4 `buff init` | 🟢 Low | Template maintenance | Simple file-based templates |
| 1.5 Prompt history search | 🟢 Low | Privacy concerns | Local-only storage; clear command |
| **Phase 2** | | | |
| 2.1 Native embeddings | 🟡 Medium | npm dependency bloat | Optional dep; fallback chain |
| 2.2 Workflow marketplace | 🟡 Medium | Low adoption | Quality built-in templates |
| 2.3 Model benchmarking | 🟡 Medium | API costs for benchmarks | `--budget` flag; small models default |
| 2.4 Docker sandbox | 🟡 Medium | Docker dependency | Keep tmpdir as default |
| 2.5 Provider health dashboard | 🟢 Low | Sequential checks slow | Parallel checks with timeout |
| 2.6 Memory compression | 🟡 Medium | Context loss | Keep originals until verified |
| **Phase 3** | | | |
| 3.1 VS Code extension | 🔴 High | Engineering effort (2-3 months) | Iterative MVP |
| 3.2 Remote federation | 🔴 High | Security, network issues | Local-only default; opt-in |
| 3.3 Web UI dashboard | 🔴 High | Scope creep | Minimal MVP; iterate |
| 3.4 Hybrid routing | 🟡 Medium | Complex decision logic | Verbose mode; manual override |
| 3.5 Team collaboration | 🔴 High | Shared state conflicts | Git-based sync |
| 3.6 Agent SDK | 🟡 Medium | API stability | Semantic versioning |

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
  ├── Google Gemini (streaming in Phase 1)
  ├── OpenRouter (streaming in Phase 1)
  └── Auto-discovered plugins (Phase 1)

Memory & Learning
  ├── Vector Store (native embeddings in Phase 2)
  ├── Trajectory Store (compression in Phase 2)
  ├── Pattern Extractor (enhanced)
  ├── Scorer + Agent Stats
  ├── Cost Tracker (Phase 1)
  └── Benchmark Engine (Phase 2)

Infrastructure
  ├── Auto-discovery (~/.buff/plugins/, ~/.buff/agents/, ~/.buff/workflows/)
  ├── Docker Sandbox (Phase 2, opt-in)
  ├── Git-based Team Sync (Phase 3)
  └── Agent SDK (Phase 3)
```

---

## 📋 Implementation Order

```
Phase 1.1 ───► Phase 1.2 ───► Phase 1.3 ───► Phase 1.4 ───► Phase 1.5
    │               │               │               │               │
    ▼               ▼               ▼               ▼               ▼
Phase 2.1 ───► Phase 2.2 ───► Phase 2.3 ───► Phase 2.4 ───► Phase 2.5 ───► Phase 2.6
    │               │               │               │
    ▼               ▼               ▼               ▼
Phase 3.1 ───► Phase 3.2 ───► Phase 3.4 ───► Phase 3.5 ───► Phase 3.6
    │               │
    ▼               ▼
Phase 3.3 ───► (Dashboard ties everything together)
```

**Within each phase, items can be implemented in parallel where dependencies allow.**

---

*Last updated: July 2026*
*Author: Dheeraj Sharma*
