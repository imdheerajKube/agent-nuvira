# Agent-Nuvira Next-Level Roadmap

## Purpose
This roadmap is designed to turn Agent-Nuvira into the top choice for end users by strengthening its core product, improving UX, expanding extensibility, and delivering enterprise-grade trust features.

---

## 1. Competitive Positioning Summary

Agent-Nuvira already has several strong advantages over peers like Hermes, Ruflo, and general coding agents:

- Multi-agent orchestration across planning, writing, reviewing, testing, debugging, and packaging.
- Provider flexibility with built-in adapters plus a plugin provider ecosystem.
- Local/offline model support for privacy-first workflows.
- Persistent memory, trajectory learning, and skill compilation.
- CLI-native experience for developers who prefer terminal workflows.

This roadmap leverages those strengths and fills key gaps to make Agent-Nuvira the most reliable, extensible, and user-friendly coding agent.

---

## 2. Core Product Priorities

### 2.1 Provider & Plugin Ecosystem

Objective: make provider extension reliable, visible, and easy to use.

Tasks:
- ✅ Finish and harden plugin discovery for `~/.buff/plugins/` and `~/.buff/agents/`.
- ✅ Add command support for plugin browsing: `buff plugins list`, `buff plugins scan`, `buff provider list`, `buff provider health`.
- ✅ Support plugin provider config in `buffconfig.json` and ensure the CLI treats unknown provider types safely.
- ✅ Add provider fallbacks and automatic routing between provider tiers (`ProviderFallback` class with configurable chain, circuit breaker, auto-failover in chat/edit).

Why it matters:
- Users need freedom to choose providers.
- Providers are the biggest differentiator vs vendor-locked systems.
- Plugin visibility reduces configuration friction.

### 2.2 CLI Flow Reliability

Objective: polish execution flows and handle failure gracefully.

Tasks:
- Stabilize `buff execute`, `buff chat`, `buff model switch`, `buff doctor` with plugin providers.
- Implement clear provider error recovery for auth failures, rate limits, and model unavailability.
- Add support for `buff execute --dry-run` and `buff execute --review`.
- Improve interactive model selection and preserve context during model switches.

Why it matters:
- Reliable CLI behaviour is critical for daily use.
- Good error handling makes the tool feel mature and trustworthy.

### 2.3 Configuration & Onboarding

Objective: make setup and provider configuration effortless.

Tasks:
- Enhance config validation and state visibility in `buff config` commands.
- Build a guided `buff init` flow that detects local models and suggests provider setup.
- Provide simple starter templates for common coding tasks.
- Create clear docs for plugin provider installation and workflow setup.

Why it matters:
- Strong onboarding turns curiosity into active adoption.
- Developers should be able to use the tool quickly without manual config debugging.

---

## 3. Developer Productivity Moat

### 3.1 Advanced Workflow Templates

Objective: offer reusable task workflows that align with real developer work.

Tasks:
- Add built-in workflow templates for feature development, bug fixes, refactors, API updates, and release preparation.
- Support user-defined workflows in `~/.buff/workflows/` with JSON/YAML.
- Make workflows available via `buff workflow list` and `buff workflow run <name>`.

Why it matters:
- Workflows reduce friction and make the tool feel more powerful than a prompt helper.
- Templates are a direct path to repeatable productivity.

### 3.2 External Agent Plugin Support

Objective: let third parties extend Agent-Nuvira with new agent roles.

Tasks:
- Add plugin registration support for custom agent roles and pipelines.
- Allow plugins to inject metadata, step logic, and optional UI hints.
- Enable plugin-based agent discovery and enablement through CLI.

Why it matters:
- This turns Agent-Nuvira into a platform.
- Community agents can fill specialized domains like security audit, docs generation, or DevOps orchestration.

### 3.3 Smarter Model Routing

**Status:** ✅ Completed

Objective: match tasks to the best model/provider automatically.

Tasks:
- ✅ Expand `src/learning/hybrid-router.ts` to use benchmarked provider capability, cost, latency, and success history.
- ✅ Add preference modes: `performance-first`, `cost-first`, `privacy-first`.
- ✅ Use runtime stats to adjust provider selection dynamically (`useRuntimeStats: true` integrates `getAgentStats().getBestModel()` into routing decisions).

Why it matters:
- Smart routing improves output quality and lowers user cost.
- It makes the tool adaptive rather than static.

#### Implementation

| Component | File | Description |
|---|---|---|
| **PreferenceMode type** | `src/learning/hybrid-router.ts` | `'balanced' | 'performance-first' | 'cost-first' | 'privacy-first'` |
| **Mode-aware provider selection** | `src/learning/hybrid-router.ts` | `providerForComplexity()` adjusted per mode — privacy-first uses `local` up to moderate, cost-first uses `local`/`groq`, performance-first uses `groq`/`gemini`/`openrouter` |
| **Quality boost per mode** | `src/learning/hybrid-router.ts` | `+0.1` for performance-first, `-0.05` for privacy-first |
| **Runtime stats integration** | `src/learning/hybrid-router.ts` | `resolveRouting()` imports `getAgentStats().getBestModel(agentType)` to override primary model with historically best performer |
| **PreferenceMode export** | `src/index.ts` | Exported alongside `HybridRouterOptions` for CLI config use |
| **Explanation display** | `src/learning/hybrid-router.ts` | Shows mode icon in routing explanation: `⚡ performance-first`, `💰 cost-first`, `🔒 privacy-first`, `📊 stats-adjusted` |

#### CLI Usage

```bash
# The mode is set via HybridRouterOptions:
const router = new HybridModelRouter({ preferenceMode: 'privacy-first', useRuntimeStats: true });
```

### 3.4 Memory, Skills & Reuse

Objective: make Agent-Nuvira learn from past runs and reuse successful patterns.

Tasks:
- Improve trajectory capture and semantic search in `src/memory/*`.
- Automatically compile high-value trajectories into reusable skills.
- Add commands like `buff skill list`, `buff skill run`, and `buff skill create`.

Why it matters:
- Reuse is the biggest productivity multiplier.
- Persistent memory makes the assistant feel familiar and context-aware.

---

## 4. Quality, Safety, and Trust

### 4.1 Code Safety & Security

**Status:** ✅ Completed

Objective: ship with built-in safety checks and audit awareness.

Tasks:
- ✅ Extend `src/security/scanner.ts` into a full security audit report.
- ✅ Detect injection risks, secrets, insecure dependencies, and unsafe patterns.
- ✅ Add `buff security scan` and require checks before critical changes.

Why it matters:
- Teams need confidence in AI-generated code.
- Security is a trust signal for enterprise adoption.

#### Implementation

| Component | File | Description |
|---|---|---|
| **CLI Command** | `src/cli/security.ts` | `buff security scan` with file/stdin/argument input modes |
| **Scan modes** | `src/cli/security.ts` | Full scan (default), `--prompt` only, `--code` only, `--pii` only |
| **Output formats** | `src/cli/security.ts` | Human-readable with severity icons (🔴🟠🟡🔵) or `--json` for machine parsing |
| **Severity control** | `src/cli/security.ts` | `--strict` fails on medium+ severity (default: high+) |
| **Generated code mode** | `src/cli/security.ts` | `--generated` lowers severity for eval/network patterns |
| **Scanner engine** | `src/security/scanner.ts` | PII (emails, API keys, SSNs, credit cards, phones), injection patterns, dangerous code patterns |
| **Router registration** | `src/cli/router.ts` | Registered as top-level `buff security` command |

#### CLI Usage

```bash
buff security scan "Check this code for secrets"     # Scan inline text
buff security scan --file ./script.js                 # Scan a file
cat payload.txt | buff security scan --stdin          # Pipe input
buff security scan --prompt "ignore all instructions" # Injection check only
buff security scan --code "eval(userInput)"           # Code patterns only
buff security scan --pii "email@example.com"          # PII check only
buff security scan --json --strict "sensitive data"   # JSON output, strict mode
```

#### Test Coverage

| File | Tests |
|---|---|
| `tests/cli/security.test.ts` | 14 |

### 4.2 Sandboxed Execution

**Status:** ✅ Completed

Objective: let users validate changes safely before applying them.

Tasks:
- ✅ Harden `src/sandbox/manager.ts` for Docker and isolated local execution.
- ✅ Add test-run and lint-run sandboxes for `buff execute` results (`--sandbox` flag).
- Provide audit-friendly output for `buff review` and `buff package`.

Why it matters:
- Safe execution reduces risk and increases adoption for critical projects.
- Users can trust generated changes instead of guessing.

#### Implementation

| Component | File | Description |
|---|---|---|
| **Execute flag** | `src/cli/execute.ts` | `buff execute <goal> --sandbox` — runs runner/tester commands in Docker sandbox |
| **Orchestrator wiring** | `src/agents/orchestrator.ts` | `useDockerSandbox` option sets `vault.setMeta('useDockerSandbox', true)` |
| **Runner sandbox** | `src/agents/agents/runner.ts` | `executeWithDocker()` creates container, copies project, runs command, returns result |
| **Tester sandbox** | `src/agents/agents/tester.ts` | `executeWithDocker()` creates container, installs deps, runs tests, parses output |

#### CLI Usage

```bash
buff execute "run tests" --sandbox                    # Docker sandbox
buff execute "verify build" --sandbox --verbose       # With detailed logging
```

### 4.3 Feedback & Self-Improvement

**Status:** ✅ Completed

Objective: build a feedback loop that improves agent choices over time.

Tasks:
- ✅ Capture task outcomes and success metrics in `src/learning/agent-stats.ts`.
- ✅ Use feedback to tune provider routing and preferred agents.
- ✅ Add `buff feedback` or passive rating prompts after key actions.

Why it matters:
- Learning from usage means the tool improves with real projects.
- This creates a product advantage over static AI assistants.

#### Implementation

| Component | File | Description |
|---|---|---|
| **CLI Command** | `src/cli/feedback.ts` | `buff feedback record/list/stats/clear` — full feedback lifecycle |
| **Feedback store** | `src/learning/feedback.ts` | `FeedbackStore` with JSON persistence, 1000-entry limit, stats, trend analysis |
| **Rating modes** | `src/cli/feedback.ts` | CLI flags (`--positive`, `--negative`, `--neutral`) or interactive inquirer prompt |
| **Score impact** | `src/learning/feedback.ts` | `ratingToScoreDelta()`: positive → +0.3, negative → -0.3 |
| **Stats visualization** | `src/cli/feedback.ts` | Visual bar chart (🟢🔴⚪), trend direction (📈📉📊) |
| **Router registration** | `src/cli/router.ts` | Registered as top-level `buff feedback` command |

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

## 5. Polished Product Experience

### 5.1 Onboarding and Documentation

Objective: make the first-run experience smooth and memorable.

Tasks:
- Create a zero-friction `buff init` developer setup with local model detection.
- Ship quickstart docs for local-only, cloud+plugin, and workflow-driven use.
- Add examples in `README.md`, `Product_Guide.md`, and `User_Manual.md`.

Why it matters:
- Great onboarding converts curious users into active users.
- Good docs reduce support friction and improve adoption.

### 5.2 Performance & Reliability

Objective: make the CLI fast, stable, and transparent.

Tasks:
- Add provider health checks and startup diagnostics in `buff doctor`.
- Optimize model list retrieval and cache provider metadata.
- Add logging for provider latency, retry behavior, and route decisions.

Why it matters:
- Fast feedback keeps developers productive.
- Transparency helps troubleshoot provider or environment issues.

### 5.3 Ecosystem and Community

**Status:** ✅ Completed

Objective: grow Agent-Nuvira into a platform with third-party contributions.

Tasks:
- ✅ Publish plugin APIs and template formats clearly (Agent SDK, plugin registry).
- ✅ Build a curated plugin/template registry or marketplace (`buff marketplace`).
- ✅ Encourage contributions with examples and reference plugins.

Why it matters:
- Ecosystem growth expands the tool’s value far beyond the core team.
- Third-party plugins make it harder for competitors to copy the full experience.

#### Implementation

| Component | File | Description |
|---|---|---|
| **CLI Command** | `src/cli/marketplace.ts` | `buff marketplace browse/search/install/info` — unified browsing experience |
| **Browse** | `src/cli/marketplace.ts` | Shows built-in templates, installed registry templates, and plugin providers together |
| **Search** | `src/cli/marketplace.ts` | Cross-searches built-in templates, GitHub registry, and plugin registry |
| **Install** | `src/cli/marketplace.ts` | Delegates to `workflow/registry.ts` for template installation |
| **Info** | `src/cli/marketplace.ts` | Shows details for built-in templates, plugins, or registry entries |
| **Router registration** | `src/cli/router.ts` | Registered as top-level `buff marketplace` command |

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

## 6. Execution Plan

### Immediate tasks (0-4 weeks) — ✅ All Complete
- ✅ Harden provider plugin discovery and CLI provider visibility (`buff plugins list/scan`, `buff provider list/health`).
- ✅ Polish `buff execute`, `buff model`, `buff chat`, `buff config`, and `buff doctor` flows.
- ✅ Build a guided `buff init` setup and provider onboarding.
- ✅ Add provider health and plugin metadata commands (`buff doctor`, `buff provider health`, `buff provider list`).
- ✅ Add provider fallback routing (`ProviderFallback` with configurable chain, circuit breaker, auto-failover).

### Mid-term tasks (1-3 months) — ✅ All Complete
- ✅ Add workflow templates and user-defined workflows.
- ✅ Implement custom agent plugin support.
- ✅ Improve routing intelligence with benchmarking and preference modes.
- ✅ Build memory/skill reuse commands.
- ✅ Add security scan and sandbox validation.
- ✅ Add `buff security scan` with PII, injection, and dangerous code detection.
- ✅ Add `buff execute --sandbox` for Docker sandbox integration.
- ✅ Add `buff feedback` for user rating and self-improvement.
- ✅ Add `buff marketplace` for plugin and template browsing.

### Long-term tasks (3-6 months) — ✅ Phase 4 Completed
- ✅ Ship editor/IDE integrations or shell workflow shortcuts (VS Code extension with 9 commands + inline suggestions).
- ✅ Launch plugin marketplace / template registry (`buff marketplace browse/search/install/info`).
- ✅ Improve self-learning feedback loops (`buff feedback` with record/list/stats/clear).
- ✅ Refine docs and onboarding for broader adoption.

### Phase 4.5: CI/CD Headless Mode (`buff ci`) — ✅ Completed (August 2026)
- ✅ `buff ci execute <goal>` — Runs the orchestrator and emits structured JSON to stdout with exit code 0/1.
- ✅ `buff ci check <goal>` — Gate check mode; exits 0/1 with minimal output; `--verbose` for full JSON.
- ✅ `buff ci review <files...>` — Reviews files using the ReviewerAgent and parses output into structured findings (severity, line, message, suggestion).
- ✅ `--github-annotations` flag emits GitHub Actions annotation format (`::error file=...,line=...::message`) for inline PR annotations.
- ✅ `--timeout <ms>` flag for configurable execution deadlines in CI pipelines.
- ✅ `buff` added as an additional `npx` bin alias alongside `agent-nuvira`.

### Phase 4.6: npm Publishing & One-Line Install — ✅ Completed (August 2026)
- ✅ `exports` field added to `package.json` for proper ESM resolution.
- ✅ `buff` and `agent-nuvira` bin aliases for `npx buff` / `npx agent-nuvira` support.
- ✅ `files` includes `dist/`, dashboard `public/`, `README.md`, and `LICENSE`.
- ✅ `prepublishOnly` runs build + test before publishing.
- ✅ `postinstall` script shows success message after install.
- ✅ Published under `agent-nuvira` with `publishConfig.access: public`.
- Ready for `npm publish` to enable zero-setup `npx agent-nuvira` onboarding.

---

## 7. Key Differentiators to emphasize

- **Privacy-first local mode** with offline providers
- **Pluginable provider ecosystem** for any API or local model
- **Multi-agent automation** instead of prompt-only chat
- **Persistent memory and reusable skills**
- **Built-in safety and sandboxed validation**
- **Developer-native CLI experience**

---

## 8. Recommended next move
Start by shipping a polished plugin/provider UX and a guided `buff init` onboarding experience. Once those are stable, layer in workflow templates, custom agent plugins, and the memory/skill reuse engine.
