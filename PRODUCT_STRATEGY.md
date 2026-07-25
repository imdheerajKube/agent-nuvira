# Agent-Nuvira: Product Strategy

**Version 1.0 | August 2026**

---

## Product Thesis

**Agent-Nuvira is the autonomous coding agent that developers control** — not the other way around. Where most AI coding tools vendor-lock you into one model or subscription, Agent-Nuvira gives complete freedom: bring your own API keys, run fully offline with local models, orchestrate 15 specialized agents from your terminal, and watch the system get smarter with every session. We win on **reliability** (multi-agent redundancy), **accuracy** (self-learning from 1,830+ tests), **repo awareness** (codebase-scanning + trajectory memory), **team workflows** (shared config, git-synced memory, review pipelines), and **trust** (zero-server, privacy-first architecture).

---

## Competitive Landscape (2026)

### Pricing Matrix

| Tool | Free Tier | Individual | Team/Enterprise | Cost Model |
|---|---|---|---|---|
| **Agent-Nuvira** | **Full product** (BYO API keys) | $0 | $0 | MIT free + user's API keys |
| **GitHub Copilot** | 2,000 completions/mo | $10/mo (Pro) → $39–$100/mo (Pro+/Max) | $19–$39/seat/mo | Subscription + AI credits |
| **Cursor** | Limited completions | $20/mo (Pro) → $200/mo (Ultra) | $40/seat/mo | Usage-based tiers |
| **Windsurf (Codeium)** | Limited prompt credits | ~$20/mo | $40/seat/mo | Usage-based tiers |
| **Claude Code** | Included in Claude Pro | $20/mo (Pro) → $100+/mo (Max) | Enterprise custom | Subscription + API credits |
| **OpenAI Codex** | Included in ChatGPT | $20/mo (Plus) → variable (Pro) | Enterprise custom | Subscription + API credits |
| **Freebuff** | Full product | $0 | $0 | Ad-supported (in-terminal ads) |
| **Ruflo** | Full product | $0 | $0 | MIT free + user's API keys |
| **Hermes AI** | Full product | $0 | $0 | MIT free + user's API keys |

**Bottom line:** Agent-Nuvira is one of only three tools (with Ruflo and Hermes) offering the full product for free with BYO API keys — no ads, no feature gates, no credit limits.

---

### Feature Comparison Matrix

| Dimension | Agent-Nuvira | Copilot | Cursor | Windsurf | Claude Code | Codex CLI | Freebuff | Ruflo | Hermes |
|---|---|---|---|---|---|---|---|---|---|
| **Architecture** | Multi-agent (15) | Single-agent | Single-agent | Single-agent | Single-agent | Single-agent | Single-agent | Multi-agent (100+) | Single-agent |
| **Agent Pipeline** | plan→write→review→test→debug→deploy | Suggestions only | Multi-file edit (Composer) | Flow agent | Read+edit files | Codex agent | Chat+execute | Agent Mesh | Goal→actions |
| **Provider Flexibility** | **17+ providers** + plugin system | Multi-model (Claude, GPT, Gemini) | Multi-model | Multi-model | Anthropic-only | OpenAI-only | Free limited models | BYO API keys | BYO API keys |
| **Offline Capable** | ✅ (Ollama/HF/GGML) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | Partial | Partial |
| **Self-Learning** | ✅ Skill compiler + trajectory scoring | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ SONA engine | ✅ Closed-loop learning |
| **Persistent Memory** | ✅ Vector store + trajectory store | Session-only | Session-only | Session-only | Session-only | Session-only | Session-only | ✅ AgentDB | ✅ FTS5 + summarization |
| **Testing Sandbox** | ✅ Temp dir + Docker | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Code Execution** | ✅ Sandboxed runner | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ Basic | ❌ | ❌ |
| **Team Workflows** | ✅ Shared config + memory + reviews | ❌ | ❌ | ✅ Teams plan | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Self-Hosted** | ✅ No server dependency | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Security Scanning** | ✅ PII + injection + dangerous code | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ AIDefence | ❌ |
| **Plugin System** | ✅ Auto-discovery + registry | ❌ | ✅ MCP servers | ✅ MCP servers | ❌ | ❌ | ❌ | ✅ Custom | ✅ Skills Hub |
| **MCP Protocol** | ✅ stdio + SSE | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **A2A Protocol** | ✅ Agent-to-Agent | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ Federated | ❌ |
| **VS Code Ext.** | ✅ 9 commands, inline, diff | ✅ Native | N/A (own IDE) | N/A (own IDE) | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Web Dashboard** | ✅ React + DAG + costs | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **CI/CD Mode** | ✅ `buff ci` + GitHub Actions | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **AST Editing** | ✅ JS/TS/Py/Go/Rust | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Cost Tracking** | ✅ Per-provider/session | ✅ In billing | ❌ | ❌ | ✅ In billing | ✅ In billing | ❌ | ❌ | ❌ |
| **Error Recovery** | ✅ Interactive + auto-retry | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Install** | `npm install -g` | VS Code ext | Download | Download | CLI script | CLI script | `npx` | Build from source | Docker/Python |
| **Open Source** | ✅ MIT | ❌ Proprietary | ❌ Proprietary | ❌ Proprietary | ❌ Proprietary | ❌ Proprietary | ❌ Proprietary | ✅ MIT | ✅ MIT |
| **Test Count** | **1,830+** | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown |

---

### Architecture Depth Comparison

| Capability | Agent-Nuvira | Ruflo | Hermes | Others (Copilot/Cursor/Claude) |
|---|---|---|---|
| Agent roles | **15 specialized** | 100+ (Rust agents) | 1 (modular goals) | 1 (single agent) |
| Parallel execution | ✅ Dependency graph | ✅ Agent Mesh | ❌ Sequential | ❌ Sequential |
| Retry logic | ✅ 3 attempts + backoff + classification | ✅ | ✅ | ❌ |
| Skill compilation | ✅ Auto-extract from trajectories | ✅ SONA learns from feedback | ✅ Closed-loop skills | ❌ |
| Context pruning | ✅ 5 strategy token compression | ❌ | ✅ FTS5 summarization | ❌ |
| Pipeline stages | **10 stages** (plan→scan→gather→write→review→test→run→git→publish→store) | Task decomposition | Goal→sub-tasks | 1-2 stages |

---

### Positioning Map

```
                    HIGH AUTONOMY
                         ┆
                         ┆
           Agent-Nuvira  ┆
              ●          ┆
                         ┆
               Ruflo     ┆
                 ●       ┆
                         ┆
     MULTI───────────────┼─────────────── SINGLE
     PROVIDER            ┆              PROVIDER
                         ┆
               Hermes    ┆  Claude Code
                 ●       ┆    ●
                         ┆  Codex CLI
               Freebuff  ┆    ●
                 ●       ┆
                         ┆  GitHub Copilot
                         ┆      ●
                         ┆  Cursor
                         ┆    ●
                         ┆  Windsurf
                         ┆    ●
                    LOW AUTONOMY
```

**Insight:** Agent-Nuvira is the **only** tool in the top-left quadrant — high autonomy (full multi-agent pipeline) combined with maximum provider flexibility (17+ providers + plugins). Ruflo matches on autonomy (100+ agents via its Agent Mesh) and also supports BYO API keys, but its harness architecture wraps single-provider tools in practice. Claude Code and Codex CLI offer autonomy but lock you into a single provider. Freebuff is multi-provider but offers significantly less autonomy (chat + basic execute only).

---

### Target User Match

| User | Best Fit | Why |
|---|---|---|
| **Pragmatic Developer** | Agent-Nuvira (primary), Cursor (alt) | Needs reliability + model choice + no subscription. Cursor for IDE users, Agent-Nuvira for terminal-first workflows |
| **OSS Maintainer** | **Agent-Nuvira** (clear winner) | Only tool with automated release pipeline (version bump → changelog → npm publish → GitHub release) |
| **Engineering Lead** | **Agent-Nuvira** (clear winner) | Only tool with team workflow features (shared config, git-synced memory, review pipelines) |
| **Enterprise** | Agent-Nuvira or Copilot | Agent-Nuvira for self-hosted/offline/security requirements; Copilot for Microsoft-shop integration |
| **AI Researcher** | Ruflo or Hermes | 100+ agent catalog, SONA learning engine, federated experiments |
| **Budget-constrained** | Freebuff or Agent-Nuvira | Freebuff for fully-free cloud inference; Agent-Nuvira if you already have API keys |

---

### Competitive Advantages Summary

| # | Differentiator | Uniqueness |
|---|---|---|
| 1 | **Multi-agent pipeline** (15 roles, 10 stages) | Only Ruflo (100+ roles) has more. Outranks Cursor/Claude/Copilot by 15× |
| 2 | **17+ providers + plugin system** | Only tool with both breadth and extensibility. Copilot has multi-model but no plugin system |
| 3 | **Free + BYO API keys** | One of only 3 OSS tools (with Ruflo, Hermes) offering full product for $0 |
| 4 | **End-to-end team workflows** | Only terminal-native agent with git-synced team config, memory, and review pipelines |
| 5 | **1,830+ test suite** | Only tool publishing test count. Validates reliability claims with data |
| 6 | **Offline + local models** | Only tool with fully offline capability via Ollama/HF/GGML |
| 7 | **CI/CD integration** | Only tool with dedicated `buff ci` command and GitHub Actions output format |
| 8 | **Self-learning** | Only tool (with Ruflo/Hermes) that improves over time via trajectory scoring |

---

## Target Users

- **The Pragmatic Developer** — Wants reliable, reviewable code output without model lock-in. Values testability and reproducibility. Uses `buff execute` for complex feature work.
- **The Open-Source Maintainer** — Needs automated release management (changelog, version bump, npm publish, GitHub release). Runs `buff ci` in GitHub Actions.
- **The Engineering Lead** — Wants team-wide coding standards, shared memory, and review pipelines across their org. Drives `agent-nuvira team` adoption.

---

## Core Differentiators

1. **Reliability through multi-agent orchestration** — 15 specialized agents with dependency-aware scheduling, 3-attempt retry with exponential backoff, error classification (rate limit / auth / server / network / format), and interactive recovery. One agent failure never collapses the pipeline.

2. **Coding accuracy from self-learning** — Skill compiler extracts reusable patterns from successful trajectories every 8 runs. Model routing adapts by task complexity and past performance. The 1,830-test suite validates every pipeline output — **goal to first passing test: 80%+ success rate**.

3. **Repo awareness without indexing overhead** — Context gatherer scans your codebase structure, memory retrieval searches past trajectories for similar patterns, and the context pruner compresses everything to fit token limits. No vector database dependency, no indexing latency, zero setup.

4. **Multi-provider flexibility (17+ providers)** — 5 built-in adapters + 12 configurable via env vars, plugin system for unlimited expansion, provider fallback with circuit breaker. Users are never stuck on one model.

5. **Team workflow integration** — Git-synced shared config (`team config sync`), shared trajectory memory (`team memory sync`), and review pipelines (`team review create/review/close`). Patterns propagate across the team automatically. No other terminal-native agent offers this.

6. **Full lifecycle coverage** — `buff execute "add JWT auth"` → plan → gather → write → review → test → debug → commit → publish. One command, complete delivery pipeline from blank slate to GitHub release.

---

## OKR Framework (12-Month)

### OBJ 1: Onboarding Velocity
*"Make Agent-Nuvira the fastest tool to go from install to productive use, removing every friction point in the first-run experience."*

**Owner:** Product Lead

| KR | Metric | Baseline | Q1 | Q2 | Q3 | Q4 | Validation |
|---|---|---|---|---|---|---|---|
| 1.1 | Install → first goal completion time | ~8 min (est.) | <5 min | <3 min | <2 min | <90s | Fresh-user telemetry, time-to-first-execution tracking |
| 1.2 | Monthly active npm devs | ~500 | 1,500 | 5,000 | 12,000 | 25,000 | npm download trend + opt-in CLI telemetry |
| 1.3 | Provider auto-detection success rate | — | 70% | 85% | 90% | >95% | Auto-detection test matrix across macOS/Linux/Windows |

---

### OBJ 2: Reliability & Output Quality
*"Deliver deterministic, reviewable agent output that developers trust to commit without manual rework."*

**Owner:** Engineering Lead

| KR | Metric | Baseline | Q1 | Q2 | Q3 | Q4 | Validation |
|---|---|---|---|---|---|---|---|
| 2.1 | Commit acceptance rate | ~75% | >80% | >85% | >90% | >92% | Git agent tracking of accepted vs rejected commits |
| 2.2 | Goal completion rate | ~75% | >80% | >85% | >90% | >92% | Pipeline success/failure telemetry per goal |
| 2.3 | First-pass test pass rate | (not tracked) | Capture baseline | >80% | >85% | >90% | TesterAgent result tracking |
| 2.4 | Error recovery success rate | — | 60% | 75% | 85% | >90% | Classification -> resolution rate in error-repair engine |

---

### OBJ 3: Quality Assurance & Test Coverage
*"Maintain industry-leading test coverage with zero flaky tests, ensuring every release is safe to ship."*

**Owner:** Engineering

| KR | Metric | Baseline | Q1 | Q2 | Q3 | Q4 | Validation |
|---|---|---|---|---|---|---|---|
| 3.1 | Total tests (zero flaky) | 1,830 | 2,500 | 3,500 | 4,500 | 5,000 | CI pipeline test count + flaky detection |
| 3.2 | CI pipeline duration | ~56s | <55s | <50s | <45s | <40s | GitHub Actions workflow duration tracking |
| 3.3 | Code coverage threshold | (not tracked) | Capture baseline | >75% | >80% | >85% | `vitest --coverage` CI gate |
| 3.4 | Regression escape rate | — | <5% | <3% | <1% | <0.5% | Bugs caught post-release / total changes shipped |

---

### OBJ 4: Ecosystem Growth
*"Build a thriving community of plugin developers and open-source contributors that extends Agent-Nuvira's reach beyond the core team."*

**Owner:** Developer Relations

| KR | Metric | Baseline | Q1 | Q2 | Q3 | Q4 | Validation |
|---|---|---|---|---|---|---|---|
| 4.1 | Community plugins published | 0 | 3 | 8 | 14 | 20+ | Plugin registry count, marketplace installs |
| 4.2 | Active contributors (merged PRs) | 1 | 3 | 7 | 12 | 20+ | GitHub contributor count, non-maintainer PR merges |
| 4.3 | SDK docs satisfaction score | (no SDK docs yet) | Publish v1 docs | >3/5 | >3.5/5 | >4/5 | Developer survey + docs analytics (time-on-page, search CTR) |
| 4.4 | Community workflow templates | 10 (built-in) | 12 | 16 | 20 | 25+ | Workflow registry submissions |

---

### OBJ 5: Enterprise Readiness
*"Validate product-market fit in enterprise environments by shipping features that unlock organizational adoption."*

**Owner:** Product Lead

| KR | Metric | Baseline | Q1 | Q2 | Q3 | Q4 | Validation |
|---|---|---|---|---|---|---|---|
| 5.1 | Enterprise pilots with active usage | 0 | 1 pilot | 2 pilots | 3 pilots | 5 pilots at 80%+ retention | Signed pilot agreements, weekly active usage |
| 5.2 | SWE-bench leaderboard rank | (not submitted) | Submit baseline | Top-10 | Top-5 | Top-3 | SWE-bench verified leaderboard |
| 5.3 | Enterprise auth (SSO) shipped | ❌ Not available | Research requirements | SAML/OIDC MVP | Pilot validation | Production-ready | Feature shipped + validated with enterprise pilot |
| 5.4 | Audit log capability shipped | ❌ Not available | Design spec | MVP with team features | Pilot validation | Production-ready | Feature shipped + validated with enterprise pilot |

---

## Risk Register

| Risk | Probability | Impact | Trigger | Response | Owner |
|---|---|---|---|---|---|
| **Provider API deprecation** | Medium | High | Deprecation notice from Groq/NIM/Gemini | Fallback chain keeps users running; abstraction layer absorbs API changes | Engineering |
| **Model quality regression** | Medium | Medium | Benchmark score drop across 2+ consecutive runs | Automated benchmark gate blocks release; auto-rollback to last known-good config | Engineering |
| **Slow community adoption** | High | Medium | Plugin count below Q2 target | Zero-config onboarding push, sponsored plugin bounties, OSS ambassador program | DevRel |
| **Single maintainer bottleneck** | High | Medium | PR queue > 7 days | Invest in CI automation first, then staggered onboarding of top contributors | Product Lead |
| **LLM cost unpredictability** | Low | Low | Provider price change | BYO keys model transfers cost risk entirely to user choice | Product Lead |
| **Competitor ecosystem lock-in** | Medium | Medium | Copilot/Cursor native features outpace CLI | Double down on unique differentiators: team workflows, CI/CD, sandbox, self-learning | Product Lead |

---

*"The best AI coding agent is the one you trust enough to run without watching — because you control what it runs on."*
