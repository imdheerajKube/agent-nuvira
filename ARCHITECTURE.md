# Agent-Nuvira: Core Agent Execution Engine — Modular Architecture

**Design Document v1.0 | August 2026**

> 🎨 **Visual diagrams available:** See [ARCHITECTURE_DIAGRAMS.md](./ARCHITECTURE_DIAGRAMS.md) for Mermaid-rendered versions of all diagrams below (Module Architecture, Extensibility System, Safe Execution Layer, Data Flow, and Observability Bus) with a color legend. These render natively on GitHub.

---

## 1. Design Principles

| Principle | Meaning |
|---|---|
| **Separation of concerns** | Each module owns one capability. No module crosses into another's domain. |
| **Plugin architecture** | Every module defines a clear interface. New implementations can be swapped in without touching other modules. |
| **Observability by default** | Every module emits structured events. The execution engine can be introspected at any point. |
| **Safe by construction** | Code execution is sandboxed. File changes are validated before write. All external calls are guarded. |

---

## 2. High-Level Module Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Execution Engine                              │
│    (Orchestrator — dependency-aware task scheduler)                  │
└───┬───────┬───────┬───────┬───────┬───────┬───────┬───────┬─────────┘
    │       │       │       │       │       │       │       │
    ▼       ▼       ▼       ▼       ▼       ▼       ▼       ▼
┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────────┐
│ Plan │ │ Inspect│ │ Edit │ │ Test │ │Recover│ │Verify │ │Report│ │Ext.     │
│Module│ │Module │ │Module │ │Module│ │Module │ │Module │ │Module│ │Integ.   │
└──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘ └──────────┘
   │        │        │        │        │        │        │
   └────────┴────────┴────────┴────────┴────────┴────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │   Shared Context     │
                    │   Bus (Event Store)  │
                    └─────────────────────┘
```

**Key insight:** The engine is not a linear pipeline — it's a dependency graph. Modules are scheduled by the orchestrator based on their declared dependencies, not by position in a list.

---

## 3. Module Specifications

### 3.1 Plan Module

**Purpose:** Decompose a user goal into an ordered, dependency-aware execution plan.

**Interface:**
```typescript
interface PlanModule {
  createPlan(params: {
    goal: string;
    projectFileTree?: string;
    memoryContext?: string;
    mcpTools?: McpToolEntry[];
    modelRouting?: Record<string, string>;
  }): Promise<ExecutionPlan>;
}

interface ExecutionPlan {
  steps: PlanStep[];
  estimatedComplexity: 'simple' | 'moderate' | 'complex';
  suggestedProvider?: string;
}

interface PlanStep {
  id: string;
  description: string;
  module: 'inspect' | 'edit' | 'test' | 'verify' | 'execute' | 'integrate';
  config?: Record<string, unknown>;
  dependsOn: string[];
}
```

**Dependency validation:** The orchestrator rejects plans with dependency cycles, dangling references (a step depends on a non-existent step ID), or orphaned steps (steps that no other step depends on and that the goal doesn't reference). Plans are validated before any module execution begins.

**Extensibility:** New planners can be registered without modifying the orchestrator. A custom planner might use a local model for simple tasks and a frontier model for complex ones.

**Observability:** Every `createPlan` call emits:
- `plan:started` — goal + project tree hash
- `plan:step-created` — step ID + module type
- `plan:completed` — step count + complexity score

---

### 3.2 Inspect Module (Repository Inspection)

**Purpose:** Scan the codebase to discover relevant files, extract structural context, and identify dependencies.

**Interface:**
```typescript
interface InspectModule {
  inspect(params: {
    goal: string;
    workingDirectory: string;
    taskSteps: PlanStep[];
    maxFiles?: number;
  }): Promise<InspectionResult>;

  /**
   * Synchronous fallback — called by `inspect()` internally when the LLM
   * call fails or times out. Scans files by keyword matching against the
   * goal string. Returns file paths matching `InspectionResult.relevantPaths`.
   */
  scanByKeywords(goal: string, dir: string): string[];
}

interface InspectionResult {
  artifacts: Artifact[];
  fileTree: string;
  relevantPaths: string[];
  stats: {
    totalFiles: number;
    inspectedFiles: number;
    errors: number;
    llmFallbackUsed: boolean;
  };
}
```

**Safe execution:**
- Respects `.gitignore` patterns to avoid inspecting sensitive files
- Caps read size per file (default: 100KB) to prevent context overflow
- Binary file detection — skips images, archives, and compiled binaries

**Extensibility:** Language-specific inspectors (e.g., `TypeScriptInspector`, `PythonInspector`) can register custom logic for extracting module dependencies, class hierarchies, and test-file mappings.

**Observability:** Emits:
- `inspect:scanning` — directory being traversed
- `inspect:file-found` — path + extension + size
- `inspect:llm-classify` — LLM used for relevance classification
- `inspect:completed` — artifact count + total bytes

---

### 3.3 Edit Module

**Purpose:** Generate and apply code changes with validation before writing to disk.

**Interface:**
```typescript
interface EditModule {
  edit(params: {
    goal: string;
    artifacts: Artifact[];
    instructions: string;
    existingCode?: string;
    language?: string;
  }, callLLM: LLMCallFn): Promise<EditResult>;

  dryRun(params: EditParams): Promise<EditPreview>;
}

interface EditResult {
  preview: EditPreview;       // Includes all preview fields + validation
  appliedCount: number;        // Number of changes actually written
  skippedChanges: FileChange[];// Changes that were in the preview but not applied
}

interface EditPreview {
  changes: FileChange[];
  warnings: string[];
  estimatedImpact: string[];
  validation: {
    syntaxValid: boolean;
    astIssues: string[];
    securityWarnings: string[];
  };
}
```

**Safe execution:**
- **Pre-write validation:** Every edit is validated for syntax errors (via AST engine) before disk write
- **Dry-run mode:** `EditModule.dryRun()` returns preview without touching disk
- **Atomic writes:** Files are written to a temp path and atomically renamed on success
- **Rollback capability:** Original content is preserved in context for undo

**Extensibility:** 
- Language-specific formatters auto-run after write (Prettier for JS/TS, `go fmt` for Go, `ruff` for Python)
- Custom edit strategies can be registered (e.g., `RegexEditStrategy`, `PatchEditStrategy`)

**Observability:** Emits:
- `edit:generating` — file path + language
- `edit:validating` — syntax check result
- `edit:written` — file path + bytes written
- `edit:skipped` — reason (no changes, validation failed)

---

### 3.4 Test Module

**Purpose:** Execute tests in an isolated sandbox and capture results.

**Interface:**
```typescript
interface TestModule {
  runTests(params: {
    workingDirectory: string;
    testCommand?: string;
    framework?: 'vitest' | 'jest' | 'pytest' | 'go-test' | 'auto-detect';
    useDockerSandbox?: boolean;
    timeoutMs?: number;
  }): Promise<TestResult>;

  getAvailableFrameworks(): Promise<DetectedFramework[]>;
}

interface TestResult {
  success: boolean;
  passed: number;
  failed: number;
  total: number;
  failures: TestFailure[];
  durationMs: number;
  sandboxPath?: string;
  log?: string;
}

interface TestFailure {
  name: string;
  file: string;
  line?: number;
  message: string;
  output?: string;
}
```

**Safe execution:**
- Tests run in an isolated temp directory (local) or Docker container (sandboxed)
- Resource limits: 512MB memory, 1 CPU core, 30s timeout default
- Network access restricted in sandbox mode to prevent exfiltration
- Container auto-destroyed after execution (configurable retention)

**Extensibility:** Framework detectors auto-configure the test command. Custom runners can be registered for non-standard test frameworks.

**Observability:** Emits:
- `test:started` — framework detected + sandbox type
- `test:failure` — per-test failure with stack trace
- `test:completed` — pass/fail/total + duration
- `test:sandbox-created` — container ID (if Docker)

---

### 3.5 Recover Module (Error Recovery)

**Purpose:** Diagnose failures and apply targeted repair strategies with configurable retry budgets.

**Interface:**
```typescript
interface RecoverModule {
  repair(params: {
    taskId: string;
    failure: AgentFailure;
    context: AgentContext;
    callLLM: LLMCallFn;
    executeAgent: (ctx: AgentContext, llm: LLMCallFn) => Promise<AgentResult>;
    budget: RepairBudget;
    fallbackModels?: string[];
  }): Promise<RepairResult>;

  classifyError(error: string): ErrorClassification;
}

interface RepairBudget {
  maxAttempts: number;
  currentAttempt: number;
  exhaustedModels: string[];
}

interface RepairResult {
  success: boolean;
  attempts: RepairAttempt[];
  finalError?: string;
  switchedModel?: string;
}

interface RepairAttempt {
  attempt: number;
  strategy: RepairStrategy;
  outcome: 'success' | 'failed' | 'skipped';
  durationMs: number;
  error?: string;
}

type RepairStrategy =
  | { type: 'retry-same' }
  | { type: 'rephrase-prompt'; newPrompt: string }
  | { type: 'switch-model'; model: string }
  | { type: 'simplify-goal'; simplifiedGoal: string }
  | { type: 'split-task'; subTasks: string[] }
  | { type: 'bypass'; reason: string };
```

**Safe execution:**
- `RepairBudget` prevents infinite retry loops (configurable cap, default: 3)
- Model switching respects provider rate limits via circuit breaker
- `bypass` strategy allows graceful degradation when recovery is impossible
- Sensitive error details are sanitized in logs

**Extensibility:** Custom repair strategies can be registered (e.g., `CacheWarmStrategy` for cold-start issues, `RetryWithBackoffStrategy` for transient failures).

**Observability:** Emits:
- `recover:classified` — error category + strategy selected
- `recover:attempt` — attempt number + strategy type
- `recover:model-switch` — old model → new model (if applicable)
- `recover:budget-exhausted` — final state after all attempts
- `recover:result` — success/failure + total duration

---

### 3.6 Verify Module

**Purpose:** Validate that changes meet quality standards before proceeding.

**Interface:**
```typescript
interface VerifyModule {
  verify(params: {
    changes: FileChange[];
    artifacts: Artifact[];
    goal: string;
    testResults?: TestResult;
    runResults?: RunResult;
    strictness: 'low' | 'medium' | 'high';
  }, callLLM: LLMCallFn): Promise<VerificationResult>;
}

interface VerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
  overallScore: number; // 0.0 – 1.0
  blockers: string[];
  suggestions: string[];
}

type VerificationCheck = {
  type: 'syntax' | 'tests' | 'security' | 'goal-alignment' | 'code-quality';
  passed: boolean;
  details: string;
  severity: 'blocking' | 'warning' | 'info';
};
```

**Safe execution:**
- Security scan runs as a blocking check — injection patterns or secrets block verification
- Goal-alignment check uses LLM to verify the changes actually address the user's goal
- Strictness levels control whether warnings are treated as failures (high) or advisory (low)

**Extensibility:** Custom verification checks can be registered (e.g., `LintCheck`, `CoverageCheck`, `LicenseCheck`, `AccessibilityCheck`).

**Observability:** Emits:
- `verify:starting` — number of checks to run
- `verify:check` — check type + pass/fail
- `verify:completed` — score + blocker count

---

### 3.7 Report Module

**Purpose:** Produce structured summaries of what happened, what changed, and what's next.

**Interface:**
```typescript
interface ReportModule {
  generate(params: {
    goal: string;
    agentResults: AgentResultSummary[];
    fileChanges: FileChange[];
    testResults?: TestResult;
    runOutput?: string;
    verificationResult?: VerificationResult;
    durationMs: number;
    memoryTrajectoryId?: string;
    reviewId?: string;
  }): Promise<ExecutionReport>;

  format(report: ExecutionReport, format: 'text' | 'json' | 'markdown' | 'github-annotation'): string;
}

interface ExecutionReport {
  success: boolean;
  summary: string;
  details: {
    goal: string;
    tasksCompleted: number;
    tasksTotal: number;
    duration: string;
    agentBreakdown: Array<{ agent: string; status: 'passed' | 'failed' | 'skipped'; summary: string }>;
    fileChanges: Array<{ path: string; status: string }>;
    testSummary?: string;
    verificationScore?: number;
    error?: string;
  };
  followUp?: {
    suggestedActions: string[];
    confidence: 'high' | 'medium' | 'low';
  };
}
```

**Extensibility:** Custom formatters can be registered (e.g., `GitHubActionsFormatter` for CI annotations, `SlackFormatter` for notifications, `HTMLFormatter` for dashboards).

**Observability:** This is the terminal node — it consumes observability events and produces the final human-readable output. Every report has a unique ID and can be re-generated from stored trajectory data. Emits:
- `report:generated` — report ID + format

---

## 4. Cross-Cutting Concerns

### 4.1 Extensibility System

```
┌──────────────────────────────────────────────────────────┐
│                   Module Registry                          │
│                                                           │
│  registerModule(name: string, factory: ModuleFactory)     │
│  getModule<T>(name: string): T                            │
│  listModules(type: ModuleType): ModuleMetadata[]          │
│                                                           │
│  Built-in: Plan | Inspect | Edit | Test | Recover         │
│            | Verify | Report                              │
│                                                           │
│  Custom:   CustomPlan | CustomVerify | ...                │
└──────────────────────────────────────────────────────────┘
```

Any module can be replaced at the orchestrator level:
```typescript
const engine = new ExecutionEngine();
engine.modules.register('plan', new MyCustomPlanner());
```

**17-Agent Registry** — the engine-level module system above composes with the
**17 registered agents** in `src/agents/module-registry.ts`, which the
orchestrator uses to build task plans:

| # | Agent type | Role |
|---|---|---|
| 1 | `planner` | Decompose goal into an ordered, dependency-aware task plan |
| 2 | `context-gatherer` | Scan the codebase, discover relevant files (wraps InspectModule) |
| 3 | `writer` | Generate and apply code changes (wraps EditModule incl. Tier-0 routing) |
| 4 | `reviewer` | Code review, bug detection, style checks (wraps VerifyModule) |
| 5 | `runner` | Sandboxed command execution |
| 6 | `tester` | Sandboxed test execution (wraps TestModule) |
| 7 | `debugger` | Iterative test-fix loop (wraps RecoverModule) |
| 8 | `git` | Commit, branch, PR generation |
| 9 | `gitlab` | Full GitLab REST API — MRs, issues, pipelines |
| 10 | `package` | Dependency management / package publishing |
| 11 | `github-release` | Tag + release creation, npm publish |
| 12 | `security` | Prompt-injection + secret/PII scanning |
| 13 | `skill-runner` | Inject compiled skills into the execution plan |
| 14 | `mcp` | Invoke external tools via Model Context Protocol |
| 15 | `pr-review` | Inline code review on open PRs |
| 16 | `issue-triage` | Issue classification, prioritization, labeling |
| 17 | `branch-automation` | Git hooks, auto-branch workflows, CI diagnosis |

Every agent is registered with `registry.register(name, factory, metadata)`;
plugins and SDK users can register additional agents or override built-ins
(`registerOrOverride`), which is how custom agent roles enter the pipeline.

### 4.2 Observability Bus

Every module emits structured events on a shared EventBus:

```typescript
interface EventBus {
  on(event: string, handler: EventHandler): void;
  emit(event: string, data: unknown): void;
  getHistory(filter?: EventFilter): EventRecord[];
}

// Built-in consumers:
// 1. LoggerConsumer — writes events to console (--verbose flag)
// 2. DAGConsumer — pushes events to web dashboard DAG visualization
// 3. TelemetryConsumer — aggregates metrics for performance monitoring
// 4. DebugConsumer — dumps full event history on failure for debugging
```

This enables:
- **Real-time DAG visualization** in the web dashboard
- **Post-mortem debugging** from event history replay
- **Performance analytics** — slowest module, most retried step, etc.
- **CI/CD annotations** — structured output for GitHub Actions

### 4.3 Safe Execution Layer

```
┌──────────────────────────────┐
│      Safe Execution Layer     │
│                               │
│  File Operations:             │
│  ├─ Atomic writes (temp→atom) │
│  ├─ Rollback snapshot         │
│  ├─ Max file size guard       │
│  └─ .gitignore compliance     │
│                               │
│  Code Execution:              │
│  ├─ Docker sandbox isolation  │
│  ├─ Resource limits (CPU/mem) │
│  ├─ Network restrictions      │
│  └─ Timeout enforcement       │
│                               │
│  LLM Calls:                   │
│  ├─ Injection guardrail       │
│  ├─ Retry with backoff        │
│  ├─ Circuit breaker           │
│  └─ Content length cap        │
└──────────────────────────────┘
```

### 4.4 Data Flow

```
User Goal
    │
    ▼
┌──────────────┐     ┌──────────────────┐
│   PlanModule  │────▶│  ExecutionPlan    │
│  (decompose)  │     │  (step[] + deps)  │
└──────────────┘     └────────┬─────────┘
                              │
                    Orchestrator resolves dependencies
                    and schedules parallel execution
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
   ┌──────────┐        ┌──────────┐         ┌──────────┐
   │Inspect   │        │  Edit    │         │  Test    │
   │Module    │        │  Module  │         │  Module  │
   └────┬─────┘        └────┬─────┘         └────┬─────┘
        │                   │                    │
        ▼                   ▼                    ▼
   Artifacts           FileChanges          TestResult
        │                   │                    │
        └───────────────────┴────────────────────┘
                            │
                            ▼
                     ┌──────────────┐
                     │ RecoverModule │◄── On failure, retry
                     │ (error-repair)│     with strategies
                     └──────┬───────┘
                            │ (success)
                            ▼
                     ┌──────────────┐
                     │ VerifyModule │
                     │ (validate)   │
                     └──────┬───────┘
                            │
                            ▼
                     ┌──────────────┐
                     │ ReportModule │
                     │ (summarize)  │
                     └──────────────┘
```

**Data flow with retrieval (token-efficient context):** before an LLM call, the
context assembler may route the gathered context through the vector store —
chunk → embed → top-k retrieval — and the reduced context feeds the EditModule
/ planner. The retrieval layer sits between the Inspect/Context-Gatherer stage
and the model call, and is fully transparent to the pipeline above (see §4.5).

### 4.5 Vector Store — Pluggable Backend Tiers (FAISS-backed)

The memory/retrieval subsystem (`src/memory/`) exposes a **pluggable vector-store
backend** with three tiers, auto-selected per machine in priority order:

| Priority | Backend | Implementation | Notes |
|---|---|---|---|
| 1 | `faiss-native` | `@faiss-node/native` real FAISS (`FaissIndex` FLAT_IP, L2-normalized → cosine) | Fastest; activates only when the native addon builds and passes a load-time smoke test (v1.49.1 fixed the silent-fallback bug) |
| 2 | `faiss-ivf` | Pure-JS IVF-flat ANN (no native deps) | Fast approximate search; default when native is unavailable |
| 3 | `json` | Exact flat cosine over `vectors-<ns>.json` | Original behavior; always works; zero data migration |

```
┌─────────────────────────────────────────────────────────────┐
│                 VectorStore (facade)                         │
│  createFaissBackend() → lazily-resolved backend             │
└────────────────────────┬────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ faiss-native │ │  faiss-ivf   │ │    json      │
│ (FAISS addon)│ │ (pure-JS IVF)│ │ (exact flat) │
└──────────────┘ └──────────────┘ └──────────────┘
```

**Key behaviors:**
- **Auto-selection** — resolution tries `faiss-native` first; any load/smoke-test
  failure falls back to `faiss-ivf`, then `json` (same entry format, no
  migration). `routing.vectorBackend` / `BUFF_VECTOR_BACKEND` override the
  priority.
- **Backend diagnostics** — `buff memory backend` prints the active backend and
  why it was chosen; `--check` runs a native-FAISS availability probe with
  install guidance; `checkNativeFaiss()` is exported from the package API.
- **Namespaced indexes** — each namespace has its own file
  (`vectors-<ns>.json`) so repo retrieval chunks never pollute memory/history
  vectors.
- **Retrieval integration** — gathered contexts are chunked (~512 tokens,
  paragraph-aware), embedded locally (`bge-small-en-v1.5`, 384-dim), reduced to
  top-k relevant chunks, and the reduced context is sent to the model — small
  contexts pass through untouched, and any retrieval failure fails over to the
  full context (graceful degradation).
- **Benchmark-validated** — 2,000-vector corpus: exact JSON recall@5 ≥ 0.99,
  IVF recall@5 ≥ 0.9 / recall@1 ≥ 0.8.

---

## 5. Current State vs. Target Architecture

| Aspect | Current (v1.50.0) | Target |
|---|---|---|
| **Module boundaries** | 17-agent `ModuleRegistry` with plugin-based loading (v1.18.0+) | Registry-driven loading for all modules, incl. custom plugins |
| **Error recovery** | `ErrorRepairEngine` class called from specific agent failure paths | `RecoverModule` as first-class pipeline stage with configurable budgets |
| **Verification** | Implicit (ReviewerAgent checks code) | Explicit `VerifyModule` with check pipeline |
| **Reporting** | Hardcoded text summary in Orchestrator | Pluggable `ReportModule` with multiple output formats |
| **Observability** | Optional `--verbose` flag + DAG module loaded on demand | Built-in EventBus with pre-registered consumers |
| **Safe execution** | Docker sandbox, AST validation, injection guardrail — all separate | Unified `SafeExecutionLayer` wrapping all operations |
| **Planner** | Single `PlannerAgent` class with hardcoded prompt | Pluggable planners — local for simple, frontier for complex |
| **Inspect** | `ContextGathererAgent` with LLM + keyword fallback | `InspectModule` with language-specific file matchers |

---

## 6. Migration Path

| Phase | Changes | Impact |
|---|---|---|
| **Phase 1** | Extract `RecoverModule` interface from `ErrorRepairEngine` | No breaking changes — class becomes module |
| **Phase 2** | Build `ModuleRegistry` and refactor `createAgent()` to use registry | Agents can now be registered by plugins |
| **Phase 3** | Build `EventBus` and wire all modules to emit events | Full observability without performance overhead |
| **Phase 4** | Extract `ReportModule` from Orchestrator's `buildResult()` using EventBus events | Multiple output formats without touching engine |
| **Phase 5** | Build `InspectModule` wrapper around `ContextGathererAgent` | Language-specific inspectors added |
| **Phase 6** | Extract `VerifyModule` from `ReviewerAgent` + security scan | Verification becomes an explicit pipeline stage |

Each phase is backwards-compatible — the old classes continue working until the new module system is ready. Phase 3 (EventBus) is deliberately placed before Phase 4 (ReportModule) so that extracted modules can immediately emit typed events from day one.
