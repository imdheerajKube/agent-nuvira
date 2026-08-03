# Architecture Diagrams — Agent-Nuvira Execution Engine

Visual diagrams generated from [ARCHITECTURE.md](./ARCHITECTURE.md) using Mermaid. These render natively on GitHub and other Mermaid-compatible markdown viewers.

---

## 1. High-Level Module Architecture (ARCHITECTURE.md §2)

```mermaid
flowchart TB
    subgraph Engine["Execution Engine"]
        Orchestrator["Orchestrator\n(dependency-aware task scheduler)"]
    end

    Orchestrator -.-> Plan
    Orchestrator -.-> Inspect
    Orchestrator -.-> Edit
    Orchestrator -.-> Test
    Orchestrator -.-> Recover
    Orchestrator -.-> Verify
    Orchestrator -.-> Report
    Orchestrator -.-> Ext

    subgraph Modules["Core Modules"]
        Plan["📋 Plan Module\nDecompose goal into plan"]
        Inspect["🔍 Inspect Module\nScan repo for context"]
        Edit["✏️ Edit Module\nGenerate & apply changes"]
        Test["🧪 Test Module\nRun tests in sandbox"]
        Recover["🔧 Recover Module\nDiagnose & repair failures"]
        Verify["✅ Verify Module\nValidate quality standards"]
        Report["📊 Report Module\nSummarize execution"]
    end

    subgraph Integration["External Integration"]
        Ext["🔌 External\nIntegration"]
    end

    Plan -.->|emits events to| Bus
    Inspect -.->|emits events to| Bus
    Edit -.->|emits events to| Bus
    Test -.->|emits events to| Bus
    Recover -.->|emits events to| Bus
    Verify -.->|emits events to| Bus
    Report -.->|emits events to| Bus

    Bus["📡 Shared Context Bus\n(Event Store)"]

    style Engine fill:#1a1a2e,stroke:#e94560,color:#fff,stroke-width:2px
    style Modules fill:#16213e,stroke:#0f3460,color:#fff
    style Integration fill:#1a1a2e,stroke:#e94560,color:#fff
    style Bus fill:#e94560,stroke:#fff,color:#fff,stroke-width:2px
    style Orchestrator fill:#533483,stroke:#e94560,color:#fff,stroke-width:2px
```

**Key insight:** The engine is not a linear pipeline — it's a dependency graph. Modules are scheduled by the orchestrator based on their declared dependencies, not by position in a list.

---

## 2. Extensibility System — Module Registry (ARCHITECTURE.md §4.1)

```mermaid
flowchart LR
    subgraph Registry["Module Registry"]
        direction TB
        API["API"]
        Methods["registerModule(name, factory)\ngetModule&lt;T&gt;(name)\nlistModules(type)"]
        Builtins["Built-in Modules\nPlan | Inspect | Edit | Test\nRecover | Verify | Report"]
        Custom["Custom Modules\nCustomPlan | CustomVerify | ..."]
    end

    Client["Execution Engine"] -->|registers / looks up| Registry
    Registry -->|provides| Modules["Module Instance"]

    style Registry fill:#16213e,stroke:#0f3460,color:#fff,stroke-width:2px
    style Client fill:#1a1a2e,stroke:#e94560,color:#fff
    style Modules fill:#e94560,stroke:#fff,color:#fff
    style API fill:#533483,stroke:#0f3460,color:#fff
    style Methods fill:#1a1a2e,stroke:#0f3460,color:#ccc
    style Builtins fill:#1a1a2e,stroke:#0f3460,color:#ccc
    style Custom fill:#1a1a2e,stroke:#0f3460,color:#ccc
```

Any module can be replaced at the orchestrator level:
```typescript
const engine = new ExecutionEngine();
engine.modules.register('plan', new MyCustomPlanner());
```

---

## 3. Safe Execution Layer (ARCHITECTURE.md §4.3)

```mermaid
flowchart TB
    subgraph SafeLayer["Safe Execution Layer"]
        direction TB

        subgraph FileOps["File Operations"]
            F1["Atomic writes (temp → atom)"]
            F2["Rollback snapshot"]
            F3["Max file size guard"]
            F4[".gitignore compliance"]
        end

        subgraph CodeExec["Code Execution"]
            C1["Docker sandbox isolation"]
            C2["Resource limits (CPU / mem)"]
            C3["Network restrictions"]
            C4["Timeout enforcement"]
        end

        subgraph LLMCalls["LLM Calls"]
            L1["Injection guardrail"]
            L2["Retry with backoff"]
            L3["Circuit breaker"]
            L4["Content length cap"]
        end
    end

    FileOps --- CodeExec --- LLMCalls

    style SafeLayer fill:#16213e,stroke:#0f3460,color:#fff,stroke-width:2px
    style FileOps fill:#1a1a2e,stroke:#e94560,color:#fff
    style CodeExec fill:#1a1a2e,stroke:#e94560,color:#fff
    style LLMCalls fill:#1a1a2e,stroke:#e94560,color:#fff
```

---

## 4. Data Flow — Full Execution Pipeline (ARCHITECTURE.md §4.4)

```mermaid
flowchart TB
    UserGoal["🎯 User Goal"]

    UserGoal --> PlanModule

    subgraph PlanStage["Planning Stage"]
        PlanModule["📋 PlanModule\n(decompose goal)"]
        ExecutionPlan["📄 ExecutionPlan\n(step[] + dependencies)"]
        PlanModule -->|produces| ExecutionPlan
    end

    ExecutionPlan --> OrchestratorResolve

    OrchestratorResolve["⚡ Orchestrator\nresolves dependencies\nschedules parallel execution"]

    OrchestratorResolve --> InspectModule
    OrchestratorResolve --> EditModule
    OrchestratorResolve --> TestModule

    subgraph ExecStage["Execution Stage"]
        InspectModule["🔍 InspectModule\n(scan repository)"]
        EditModule["✏️ EditModule\n(generate changes)"]
        TestModule["🧪 TestModule\n(run tests)"]

        InspectModule -->|produces| Artifacts["📁 Artifacts"]
        EditModule -->|produces| FileChanges["📝 FileChanges"]
        TestModule -->|produces| TestResult["📊 TestResult"]
    end

    Artifacts --> RecoverModule
    FileChanges --> RecoverModule
    TestResult --> RecoverModule

    subgraph RecoveryStage["Recovery Stage"]
        RecoverModule["🔧 RecoverModule\n(error-repair)"]
        RetryLoop["🔄 On failure:\n retry with strategies"]
        RecoverModule -.->|failure| RetryLoop
        RetryLoop -.->|re-attempt| InspectModule
    end

    RecoverModule -->|success| VerifyModule

    subgraph VerifyStage["Verification Stage"]
        VerifyModule["✅ VerifyModule\n(validate changes)"]
    end

    VerifyModule --> ReportModule

    subgraph ReportStage["Reporting Stage"]
        ReportModule["📊 ReportModule\n(summarize execution)"]
    end

    ReportModule --> Result["📋 Execution Report"]

    style PlanStage fill:#16213e,stroke:#0f3460,color:#fff
    style ExecStage fill:#1a1a2e,stroke:#e94560,color:#fff
    style RecoveryStage fill:#16213e,stroke:#0f3460,color:#fff
    style VerifyStage fill:#16213e,stroke:#0f3460,color:#fff
    style ReportStage fill:#16213e,stroke:#0f3460,color:#fff
    style UserGoal fill:#e94560,stroke:#fff,color:#fff,stroke-width:2px
    style OrchestratorResolve fill:#533483,stroke:#e94560,color:#fff,stroke-width:2px
    style Result fill:#e94560,stroke:#fff,color:#fff,stroke-width:2px
    style RetryLoop fill:#533483,stroke:#e94560,color:#fff,stroke-dasharray: 5 5
    style ExecutionPlan fill:#533483,stroke:#0f3460,color:#fff
    style PlanModule fill:#533483,stroke:#e94560,color:#fff
    style InspectModule fill:#533483,stroke:#e94560,color:#fff
    style EditModule fill:#533483,stroke:#e94560,color:#fff
    style TestModule fill:#533483,stroke:#e94560,color:#fff
    style RecoverModule fill:#533483,stroke:#e94560,color:#fff
    style VerifyModule fill:#533483,stroke:#e94560,color:#fff
    style ReportModule fill:#533483,stroke:#e94560,color:#fff
    style Artifacts fill:#1a1a2e,stroke:#0f3460,color:#ccc
    style FileChanges fill:#1a1a2e,stroke:#0f3460,color:#ccc
    style TestResult fill:#1a1a2e,stroke:#0f3460,color:#ccc
```

---

## 5. 17-Agent Registry (ARCHITECTURE.md §4.1)

```mermaid
flowchart LR
    subgraph Orchestrator["⚡ Orchestrator"]
        O["builds task plan\nvia ModuleRegistry"]
    end

    subgraph Registry["ModuleRegistry — 17 built-in agents"]
        direction TB
        A1["📋 planner"]
        A2["📁 context-gatherer"]
        A3["✏️ writer"]
        A4["🔍 reviewer"]
        A5["🏃 runner"]
        A6["🧪 tester"]
        A7["🐛 debugger"]
        A8["🌿 git"]
        A9["🦊 gitlab"]
        A10["📦 package"]
        A11["🚀 github-release"]
        A12["🛡️ security"]
        A13["⚙️ skill-runner"]
        A14["🔌 mcp"]
        A15["👀 pr-review"]
        A16["🏷️ issue-triage"]
        A17["🔀 branch-automation"]
    end

    O -->|register / lookup| Registry
    Registry -->|agent instance| Pipeline["🔄 Execution Pipeline"]

    style Orchestrator fill:#1a1a2e,stroke:#e94560,color:#fff
    style Registry fill:#16213e,stroke:#0f3460,color:#fff,stroke-width:2px
    style Pipeline fill:#e94560,stroke:#fff,color:#fff,stroke-width:2px
```

Every agent is registered via `registry.register(name, factory, metadata)`;
plugins and SDK users can add or override agents with
`registerOrOverride`. The 17 built-ins wrap the engine modules (e.g. `writer`
→ EditModule, `tester` → TestModule, `debugger` → RecoverModule,
`reviewer` → VerifyModule).

---

## 6. Vector Store — FAISS-Backed Backend Tiers (ARCHITECTURE.md §4.5)

```mermaid
flowchart TB
    Query["🔎 Query / gathered context"]

    subgraph Facade["VectorStore facade"]
        Resolve["createFaissBackend()\n(lazily-resolved)"]
    end

    Query --> Resolve
    Resolve -->|tier 1| Native["faiss-native\n@faiss-node/native\nFLAT_IP + L2 → cosine"]
    Resolve -->|tier 2| Ivf["faiss-ivf\npure-JS IVF-flat ANN"]
    Resolve -->|tier 3| Json["json\nexact flat cosine"]

    Native -->|top-k| Out["📦 top-k relevant chunks\n→ reduced LLM context"]
    Ivf -->|top-k| Out
    Json -->|top-k| Out

    Native -.->|load / smoke-test fails| Ivf
    Ivf -.->|unavailable| Json

    Diag["buff memory backend --check"] --> Resolve

    style Facade fill:#16213e,stroke:#0f3460,color:#fff,stroke-width:2px
    style Native fill:#533483,stroke:#e94560,color:#fff
    style Ivf fill:#533483,stroke:#e94560,color:#fff
    style Json fill:#533483,stroke:#e94560,color:#fff
    style Out fill:#e94560,stroke:#fff,color:#fff,stroke-width:2px
    style Diag fill:#1a1a2e,stroke:#0f3460,color:#ccc
```

Priority order: `faiss-native` → `faiss-ivf` → `json` (same entry format,
zero migration). Overridable via `routing.vectorBackend` /
`BUFF_VECTOR_BACKEND`. Retrieval chunks (~512 tokens) → local embeddings
(`bge-small-en-v1.5`) → top-k reduction before the model call; any failure
fails over to full context.

---

## 7. Observability Bus — Event Flow (ARCHITECTURE.md §4.2)

```mermaid
flowchart LR
    subgraph Modules["Emitting Modules"]
        PlanEv["📋 Plan"]
        InsEv["🔍 Inspect"]
        EditEv["✏️ Edit"]
        TestEv["🧪 Test"]
        RecEv["🔧 Recover"]
        VerEv["✅ Verify"]
        RepEv["📊 Report"]
    end

    subgraph EventBus["📡 EventBus"]
        On["on(event, handler)"]
        Emit["emit(event, data)"]
        History["getHistory(filter)"]
    end

    subgraph Consumers["Built-in Consumers"]
        Logger["📝 LoggerConsumer\n→ console (--verbose)"]
        DAG["📊 DAGConsumer\n→ web dashboard"]
        Telemetry["📈 TelemetryConsumer\n→ performance metrics"]
        Debug["🐛 DebugConsumer\n→ full dump on failure"]
    end

    Modules -->|emit structured events| EventBus
    EventBus -->|dispatch to| Consumers

    style Modules fill:#16213e,stroke:#0f3460,color:#fff
    style EventBus fill:#e94560,stroke:#fff,color:#fff,stroke-width:2px
    style Consumers fill:#1a1a2e,stroke:#0f3460,color:#fff
```

This enables:
- **Real-time DAG visualization** in the web dashboard
- **Post-mortem debugging** from event history replay
- **Performance analytics** — slowest module, most retried step, etc.
- **CI/CD annotations** — structured output for GitHub Actions

---

## Color Legend

| Color | Element |
|---|---|
| 🟣 `#533483` | Modules / Active components |
| 🔵 `#16213e` | Stage / Subsystem containers |
| ⚫ `#1a1a2e` | Supporting components / Data objects |
| 🔴 `#e94560` | Central bus / User input / Output |
| ⚪ `#0f3460` | Container borders |

---

> Generated from [ARCHITECTURE.md](./ARCHITECTURE.md) §2, §4.1, §4.2, §4.3, §4.4, §4.5.
