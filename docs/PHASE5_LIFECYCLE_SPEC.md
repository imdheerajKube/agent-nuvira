# Phase 5 — Composable Lifecycle Graph

## Implementation Specification

| Field | Value |
|---|---|
| Status | Implementation-ready draft; code-validated; conditional go |
| Version | 1.1 |
| Depends on | Phases 0–4, especially workflow IR, durable runs, coding sessions, and the control service |
| Primary decision | Decision 11 — Lifecycle Composition |
| Parent plan | [`ENHANCE_CUSTOM_CAPABILITY.md`](./ENHANCE_CUSTOM_CAPABILITY.md) |
| Codebase validation | [`PHASE5_CODEBASE_VALIDATION.md`](./PHASE5_CODEBASE_VALIDATION.md) |
| Audience | Runtime, platform, security, dashboard, CLI, and enterprise engineering |
| Scope | Specification only. No runtime code is changed by this document. |

---

## 0. Document contract

This is the implementation-level specification for Phase 5. It turns the lifecycle sections of the parent plan into buildable contracts.

It is deliberately stricter than the parent plan and stricter than the Copilot draft in three areas:

1. **The existing pipeline is wrapped, not deleted.** `TaskExecutionPipeline` and `Orchestrator` remain protected stage implementations. Phase 5 adds a lifecycle boundary above them.
2. **A gate is a policy decision with evidence.** It is not a prompt asking a model to be careful, and it is not a log line that says “looks good.”
3. **Trust is provenance plus local policy.** A publisher badge never grants blanket `transform` or `gate` authority.

Where this document conflicts with the parent plan, this document wins for Phase 5 implementation. The parent plan remains the product and roadmap source of truth.

---

## 1. Objective

Ship a lifecycle runtime that lets an organization define, install, execute, inspect, and audit how software delivery happens, without weakening the safety properties of the existing agent.

The runtime must support:

- protected baseline stages that cannot be removed;
- user and package bindings to replaceable stage implementations;
- typed insertion points around stages;
- deterministic gate decisions;
- artifact lineage and invalidation;
- durable execution, resume, cancellation, and rollback;
- lifecycle packs distributed as versioned capability packages;
- CLI, dashboard, chat, and API parity through one control service;
- enterprise policy, roles, evidence, retention, and export;
- full failure handling with fail-closed behavior for required gates.

It must not become:

- a self-modifying orchestrator;
- a second workflow engine with different semantics;
- a marketplace of prompt snippets;
- a system where a package can grant itself authority;
- a system where a local model is silently substituted for a stronger approved model.

---

## 2. Success definition

Phase 5 is successful when this exact sequence works on a real repository:

1. A user installs a signed lifecycle pack.
2. The pack binds a security agent at `after:plan` in `gate` mode.
3. The plan is produced as an immutable artifact.
4. The security gate runs in a read-only sandbox.
5. A critical finding blocks implementation.
6. The run is marked `blocked`, with a remediation path and a trace ID.
7. No code is written and no PR is opened.
8. If the gate passes, implementation, tests, review, verification, and delivery run through protected stages.
9. The PR contains a redacted evidence manifest with the gate decision and artifact hashes.
10. The CLI, dashboard, and audit export show the same run, definition hash, capability versions, cost, and decision.
11. A restart resumes the run from the last committed checkpoint without duplicating side effects.
12. Removing the lifecycle pack leaves the repository and prior run records intact.

The second success case is equally important: a gate that crashes must **not** let delivery continue. It must fail closed, record why, and expose a retry or escalation path.

---

## 3. Current code baseline

Phase 5 must be designed against the code that exists, not an imaginary greenfield.

### 3.1 Existing execution paths

| Component | Current behavior | Phase 5 use |
|---|---|---|
| `src/agents/task-execution-pipeline.ts` | Fixed six steps: `plan → inspect → edit → test → verify → summarize`; audit trail; edit/verify retry loop | Legacy `coding/legacy` stage adapter only inside an isolated worktree; not the lifecycle authority |
| `src/agents/orchestrator.ts` | Fixed preflight, context, reasoner, planner, dependency-ordered task batches, verification, report; checkpoints; steering between batches; review mode | Planner/implement/review engine; stage adapters require a new plan/task/review seam |
| `src/agents/module-registry.ts` | Global agent type registration and override; no stage binding, scope, or artifact contract | Capability resolver uses it only after trust, permission, and compatibility checks |
| `src/gateway/hook-contract.ts` | Four tool/session seams; `deny`, `notify`, `scan-args` | Remains a separate native safety layer; never called a lifecycle gate |
| `src/workflow/templates.ts` | Fixed `agentType` step lists with `dependsOn`; no typed I/O | Legacy workflow adapter; not a lifecycle definition |
| `src/workflow/registry.ts` | GitHub-backed template registry | Reused distribution pattern, not the lifecycle trust model |
| `src/tools/worktree.ts` | Isolated worktree, base commit, branch, diff, dirty-source report | Required workspace primitive for session-backed runs |
| `src/agents/artifact-verification.ts` | Checks declared files exist and are non-empty | Stage-level delivery evidence, not a substitute for typed artifacts |
| `src/observability/event-bus.ts` | Typed events, history, CLI/dashboard consumers | Add lifecycle events; do not overload existing task events |
| `src/config/paths.ts` | `resolveNuviraConfigDir()` and `resolveNuviraDataPath()` honor `NUVIRA_CONFIG_DIR` | Every new persistent path must use these helpers |
| `src/config/workspace.ts` | `node:sqlite` `DatabaseSync` with JSON fallback; its schema is a project registry, not a run store | Reuse the storage **pattern** for a dedicated lifecycle metadata DB; do not overload `workspaces.db` |

### 3.2 Codebase validation verdict

The live-code review is recorded in [`PHASE5_CODEBASE_VALIDATION.md`](./PHASE5_CODEBASE_VALIDATION.md). The short version:

- The upgrade path is real: the orchestrator, routing, repair, review, worktree, scanners, audit chain, and agent registry are reusable.
- The “wrap” claim is not yet true at stage level: there is no public plan-only or task-batch API.
- The pipeline and orchestrator write to the live tree; lifecycle writes must run in an isolated worktree.
- `VerificationResult` is a thresholded quality score, not a lifecycle gate; the gate and evidence contracts must be separate.
- Existing checkpoints are best-effort JSON, `workspaces.db` is a project registry, and the event bus is in-memory; lifecycle runs need a dedicated durable store and journal.
- The existing agent-plugin loader executes untrusted JavaScript in-process; it must not be used for lifecycle packs.
- Local RBAC is not SSO/SCIM; the enterprise claim must be scoped honestly.

This is a **conditional go**, not an unconditional approval of the original estimate. The conditions are in §24 and in the validation report.

### 3.3 What is missing

- No typed plan, diff, test, review, verification, or delivery artifact contract.
- No stage binding or slot resolver.
- No `LifecycleIR`, compiler, or deterministic scheduler.
- No gate result schema or fail-closed policy.
- No artifact store with lineage and invalidation.
- No lifecycle pack distribution format.
- No run explorer for lifecycle stages.
- No policy precedence engine for lifecycle definitions.
- No evidence attachment to a PR.
- No durable lifecycle queue or lease. Coding sessions are planned in Phase 3, not present today.

### 3.4 Integration strategy: wrap, do not replace

Phase 5 introduces `LifecycleRunner` as a new boundary. The existing pipeline and orchestrator become stage adapters.

```text
CLI / chat / dashboard / gateway / API
                  │
          Control service
                  │
       Lifecycle definition + policy
                  │
          LifecycleCompiler
                  │
            LifecycleIR
                  │
          LifecycleRunner
        ┌─────────┼──────────┐
        │         │          │
   StageAdapter  GateEngine  ArtifactStore
        │         │          │
  Orchestrator  Capability  Content-addressed
  Pipeline      sandbox     evidence
```

Rules:

- `TaskExecutionPipeline` is not deleted in Phase 5. It is selectable as a legacy stage implementation with explicit limitations.
- `Orchestrator.execute()` is a **whole-run** entry point today, not a stage API. Phase 5 must add a plan-only/task-batch/review stage seam, or a `LifecycleStageHost` that owns those boundaries, before an `after:plan` gate can block implementation. A whole-run adapter is valid for shadow observation only.
- `TaskExecutionPipeline` writes through `applyChanges()` and its test step runs in `workingDirectory`; `dryRun` tests the unchanged tree. It must run inside an isolated worktree with writes enabled there, never in the operator's repository.
- `ModuleRegistry` remains the agent factory. The lifecycle resolver does not import arbitrary modules; it resolves only installed capabilities whose trust, permissions, and compatibility have passed.
- The existing `~/.nuvira/agents/` plugin loader runs dynamic `import()` in-process and can override built-ins. It is **not** a lifecycle package runtime; untrusted packs require a signed manifest and a child-process/container boundary.
- Existing event names remain. New `lifecycle:*` events carry lifecycle-specific data and are additive; the in-memory event bus is not the durable audit journal.
- Existing hooks remain unchanged. A lifecycle gate is not a hook and a hook is not a gate.

---

## 4. Terminology

| Term | Meaning |
|---|---|
| **Capability** | A versioned, installable unit with a manifest, permissions, trust state, and one or more executable surfaces |
| **Capability package** | The distribution and trust unit installed into the immutable package store |
| **Lifecycle definition** | Data describing bindings, insertions, policies, artifact contracts, and budgets for a lifecycle |
| **Lifecycle pack** | A capability package that ships a lifecycle definition plus the agents, evals, and docs it references. “Method pack” is a catalog label, not a separate runtime primitive |
| **Lifecycle IR** | The immutable, resolved execution plan compiled from a definition, policy, and lockfile |
| **Stage** | A protected phase of delivery: intake, inspect, plan, implement, test, review, verify, deliver, learn |
| **Slot** | A typed insertion point such as `after:plan` or `before:merge` |
| **Binding** | A replacement for a declared replaceable role, such as choosing an implementer |
| **Extension** | A capability inserted at a slot in `observe`, `advise`, `gate`, or `transform` mode |
| **Artifact** | A typed, content-addressed output consumed by later stages or gates |
| **Gate** | A capability that returns a typed `pass`, `warn`, or `block` decision about an artifact |
| **Evidence** | Redacted proof attached to a run or PR: decision, findings, hashes, command output, versions, timestamps |
| **Run** | One execution of a lifecycle definition against a project or coding session |
| **Session** | The durable orchestration record from Phase 3 that may own one or more lifecycle runs |
| **Organization trust** | A local policy decision that a given package/version is trusted inside one org; not a public badge |

### 4.1 Capability types

Phase 5 supports these executable capability types:

```text
agent
workflow
tool
mcp-server
trigger
```

Package types are separate:

```text
capability package
lifecycle pack
```

A `lifecycle-pack` is a **package type**, not an executable that receives `LifecycleContext` directly. This is a deliberate correction to the Copilot draft: not every capability has the same execution contract.

A lifecycle pack contains:

```text
manifest.json
lifecycle.json
agents/
evals/
docs/
```

It may reference signed capabilities from other packages by exact version. It must not vendor an unsigned executable.

### 4.2 No method-pack primitive in v1

The marketplace may display a lifecycle pack as a “methodology pack.” The runtime must not create a second artifact, trust model, or install path for a `MethodPack` type. A method pack is a lifecycle pack with presentation metadata:

```json
{ "category": "method", "label": "FinTech delivery method" }
```

This keeps one package store, one lockfile, one permission model, and one answer to “what is installed?”

---

## 5. Protected lifecycle graph

### 5.1 Core stages

```text
intake
  → inspect
  → plan
  → implement
  → test
  → review
  → verify
  → deliver
  → learn
```

### 5.2 Protection levels

| Stage | Protected | Replaceable implementation | Notes |
|---|---:|---:|---|
| `intake` | Yes | No | Normalizes request, repo, constraints, work item |
| `inspect` | Yes | Yes, within adapter contract | Must produce repository context |
| `plan` | Yes | Yes, within adapter contract | Must produce a typed plan |
| `implement` | Yes | Yes, with approval | Must produce a patch artifact; no direct branch writes |
| `test` | Yes | Yes, but cannot be removed or skipped | Must record commands, exit codes, and output |
| `review` | Yes | Additional reviewers allowed; baseline reviewer remains | Must produce review findings and verdict |
| `verify` | Yes | No replacement | Must compute evidence-based completion |
| `deliver` | Yes | Yes, but cannot be bypassed | PR/report/artifact/notification/merge gate |
| `learn` | Optional | Yes | Captures metrics and trajectory feedback |

“Protected” means:

- it always exists in the resolved IR;
- it cannot be disabled by a package, user, or project;
- it cannot be reordered before a stage it depends on;
- its mandatory checks cannot be marked `pass` by a model’s prose;
- an org policy may add stricter checks, never remove platform checks.

### 5.3 Slots

Supported slots:

```text
before:intake
after:intake
before:inspect
after:inspect
before:plan
after:plan
before:implement
after:implement
before:test
after:test
before:review
after:review
before:verify
after:verify
before:deliver
after:deliver
on_failure
on_retry
before_merge
after_merge
```

There is no generic `on_success`. Success-dependent behavior belongs at the slot that produced the success. `after:deliver` is the success boundary; `on_failure` and `on_retry` are failure boundaries.

`before_merge` and `after_merge` are session-only slots. They are invalid for a local non-session run.

### 5.4 Slot ordering

Within a single slot:

1. higher policy precedence first;
2. then declared `priority` (lower number first);
3. then stable capability ID;
4. then version.

A definition cannot create an edge that reverses a protected stage order. A definition cannot create a cycle. The compiler rejects either.

### 5.5 Binding contract

A binding replaces the implementation of a replaceable stage. It does not remove the stage.

```json
{
  "bindings": {
    "implement": "acme/senior-implementer@2.1.0",
    "review": ["builtin/reviewer", "acme/security-reviewer@1.0.0"]
  }
}
```

The baseline reviewer is always present. `review` bindings are additive. The lifecycle may allow a verified package to select the implementer only when the project policy grants `lifecycle.bind.implement`.

---

## 6. Lifecycle definition schema

The canonical file is `lifecycle.json`. It is validated with Zod or an equivalent JSON Schema at compile time.

### 6.1 Top-level shape

```jsonc
{
  "schemaVersion": 1,
  "id": "acme/regulated-delivery",
  "version": "1.2.0",
  "extends": "coding/v1",
  "owner": "acme/platform",
  "description": "Threat modelling and release evidence for regulated services",
  "compatibility": {
    "agentNuvira": ">=5.0.0 <6.0.0",
    "lifecycle": "coding/v1"
  },
  "activation": "shadow",
  "stages": {},
  "bindings": {},
  "inserts": [],
  "policies": {},
  "budgets": {},
  "evidence": {},
  "metadata": {}
}
```

### 6.2 Field rules

| Field | Required | Rule |
|---|---:|---|
| `schemaVersion` | Yes | Integer; this document defines `1` |
| `id` | Yes | `<namespace>/<name>`, lowercase, stable |
| `version` | Yes | SemVer; immutable once published |
| `extends` | Yes | Base lifecycle ID and major version |
| `owner` | Yes | Publisher identity, not a free-text display name |
| `activation` | Yes | `suggest`, `shadow`, or `enforce`; package default may not exceed its trust policy |
| `stages` | No | Only declared replaceable roles and additional reviewers |
| `bindings` | No | Stage → capability version |
| `inserts` | No | Slot extensions |
| `policies` | No | Additive constraints, never a safety override |
| `budgets` | No | Run/stage cost and time ceilings |
| `evidence` | No | Attachment and redaction rules |
| `metadata` | No | Labels, category, documentation URL |

### 6.3 Insert schema

```jsonc
{
  "id": "threat-model",
  "at": "after:plan",
  "capability": "acme/security-architect@1.3.0",
  "mode": "gate",
  "priority": 100,
  "required": true,
  "when": {
    "goalContainsAny": ["auth", "payment", "pii"]
  },
  "inputs": [
    { "type": "plan", "schemaVersion": 1 }
  ],
  "outputs": [
    { "type": "threat-model", "schemaVersion": 1 },
    { "type": "findings", "schemaVersion": 1 }
  ],
  "onFailure": "block",
  "budget": {
    "maxUsd": 1.5,
    "timeoutSec": 300,
    "maxAttempts": 2
  },
  "evidence": {
    "attachTo": "pull_request",
    "include": ["decision", "findings", "artifactHashes"],
    "redact": ["secrets", "tokens", "rawPrompts"]
  }
}
```

### 6.4 Predicate language

No user-authored regex, `eval`, or arbitrary expression language is allowed.

Allowed predicates:

```jsonc
{ "always": true }
{ "goalContainsAny": ["auth", "payment", "pii"] }
{ "pathGlobAny": ["src/auth/**", "src/payments/**"] }
{ "tagAny": ["security", "regulated"] }
{ "artifactFieldEquals": { "type": "plan", "field": "risk", "value": "high" } }
{ "all": [ /* predicates */ ] }
{ "any": [ /* predicates */ ] }
{ "not": { /* predicate */ } }
```

Semantics:

- string matching is case-insensitive literal matching;
- glob matching is bounded and does not traverse outside declared fields;
- no predicate may read process environment, secrets, or arbitrary files;
- an invalid predicate fails validation, not at runtime;
- an evaluation error blocks a required extension and warns for an advisory.

### 6.5 Policy block

```jsonc
{
  "policies": {
    "requireHumanApprovalFor": ["deliver", "before_merge"],
    "minimumReviewers": 1,
    "allowedImplementers": ["builtin/*", "acme/*"],
    "maxExtensionsPerStage": 8,
    "maxTransformDepth": 2,
    "allowCommunityTransform": false,
    "dataClassification": "internal"
  }
}
```

Policies can tighten. They cannot:

- remove a protected stage;
- reduce platform safety;
- grant a permission the capability manifest did not declare;
- turn a `gate` into `pass`;
- allow a community package to transform a protected artifact.

### 6.6 Activation semantics

| State | Behavior |
|---|---|
| `suggest` | The lifecycle is visible; nothing runs automatically |
| `shadow` | It runs observationally; records would-be decisions and cost; does not block or mutate |
| `enforce` | It runs and its required gates block |

A package manifest may request `enforce`, but the effective activation is the minimum of package request, trust tier, project policy, and org policy. A community package cannot become `enforce` without an explicit operator approval.

---

## 7. Artifact contract

### 7.1 Envelope

Every artifact is stored as a content-addressed object with an envelope:

```ts
interface ArtifactEnvelope<T> {
  id: string;                 // art_...
  type: ArtifactType;         // plan, patch, test-result, ...
  schemaVersion: number;
  runId: string;
  stageId: string;
  producer: {
    capabilityId: string;
    capabilityVersion: string;
    trust: 'official' | 'verified' | 'organization' | 'community';
  };
  createdAt: string;          // ISO 8601
  hash: string;               // sha256 of canonical payload bytes
  uri: string;                // artifact://sha256/<hash>
  mediaType: string;
  sensitivity: 'public' | 'internal' | 'confidential' | 'restricted';
  redaction: string[];
  payload: T;
}
```

### 7.2 Core artifact types

| Type | Produced by | Required fields |
|---|---|---|
| `intake` | `intake` | goal, repo, baseRef, constraints, workItem |
| `inspection` | `inspect` | files, languages, framework, testCommands, git state |
| `plan` | `plan` | objective, tasks, risks, dependencies, acceptanceCriteria |
| `patch` | `implement` | changedFiles, diff, baseCommit, commits |
| `test-result` | `test` | commands, exitCodes, passed, failed, outputRef |
| `review` | `review` | findings, verdict, reviewer, scope |
| `verification` | `verify` | passed, checks, blockers, evidence |
| `delivery` | `deliver` | pr, checks, evidenceManifest, mergeState |
| `learning` | `learn` | outcome, metrics, capabilityStats |

### 7.3 Storage rules

- Canonical JSON is serialized deterministically before hashing.
- Large payloads are stored once and referenced by `artifact://sha256/<hash>`.
- Artifacts are immutable. A transform produces a new envelope with `parentHash`.
- Secrets and raw prompt text are never stored in artifacts. Prompt references may be stored as hashes.
- Access checks happen before resolving an artifact URI.
- Artifact reads are scoped to the run’s project, org, and classification.
- Deleting a run requires an explicit retention action; normal uninstall does not delete artifacts.

### 7.4 Artifact lineage and invalidation

```text
plan@A
  ├── threat-model@B  (depends on A)
  ├── patch@C         (depends on A, B)
  ├── test-result@D   (depends on C)
  └── review@E        (depends on A, C, D)
```

If a transform produces `plan@A2`:

- every decision whose `inputHashes` contains `A` becomes `stale`;
- downstream gates must re-run;
- old evidence is retained for audit but is not valid for delivery;
- the run records an `artifact_invalidated` event with the reason and new hash.

`test-result`, `review`, and `verification` artifacts are not transformable. A review verdict cannot be edited by a later capability. A new review round creates a new artifact.

---

## 8. Lifecycle IR and compiler

### 8.1 Compilation phases

```text
parse → schema validate → policy resolve → capability resolve
→ artifact contract validate → graph expand → topo sort
→ budget validate → freeze → hash
```

Compilation is pure relative to its inputs: definition, policy snapshot, trust snapshot, and lockfile. It performs no model calls and no filesystem writes outside a temporary compile workspace.

### 8.2 IR shape

```ts
interface LifecycleIR {
  graphId: string;
  definitionId: string;
  definitionVersion: string;
  definitionHash: string;
  baseLifecycle: string;
  stages: ResolvedStage[];
  nodes: ResolvedNode[];
  edges: Array<{ from: string; to: string; kind: 'depends' | 'slot' }>;
  policies: ResolvedPolicySet;
  lock: LifecycleLock;
  budgets: RunBudget;
  evidence: EvidencePolicy;
  compiledAt: string;
}
```

### 8.3 Node kinds

```text
stage
binding
extension
gate
transform
delivery
```

An extension is not a new stage. It is a node attached to a stage boundary.

### 8.4 Deterministic order

Order is determined by:

1. protected stage order;
2. slot class order (`before` before stage, `after` after stage);
3. semantic priority;
4. capability ID;
5. capability version;
6. insertion ID.

No map iteration order, random ID, or model output may decide execution order.

### 8.5 Compiler errors

All errors are structured:

```jsonc
{
  "code": "LC001",
  "severity": "error",
  "path": "inserts[0].at",
  "message": "Unknown lifecycle slot",
  "remediation": "Use one of the declared slots in the lifecycle contract"
}
```

Required error classes:

| Code | Meaning |
|---|---|
| `LC001` | Unknown stage or slot |
| `LC002` | Protected stage removal or replacement attempt |
| `LC003` | Dependency cycle |
| `LC004` | Capability not installed |
| `LC005` | Version incompatible |
| `LC006` | Permission not declared |
| `LC007` | Input/output artifact mismatch |
| `LC008` | Predicate invalid |
| `LC009` | Transform target not transformable |
| `LC010` | Budget exceeds policy ceiling |
| `LC011` | Trust insufficient for requested activation |
| `LC012` | Lower-precedence weakening attempt |
| `LC013` | Duplicate binding of a non-additive role |
| `LC014` | Session-only slot used outside a session |
| `LC015` | Definition hash or lock mismatch |

A compile failure leaves the previously active IR in force. It never partially applies.

### 8.6 Lockfile

```jsonc
{
  "lockVersion": 1,
  "definitionHash": "sha256:...",
  "capabilities": [
    {
      "id": "acme/security-architect",
      "version": "1.3.0",
      "integrity": "sha256:...",
      "source": "marketplace",
      "trust": "verified"
    }
  ],
  "policySnapshot": "sha256:...",
  "createdAt": "..."
}
```

A run records the lock hash. Re-running uses the lock unless the operator explicitly upgrades. An upgrade is a new compilation, not a mutation of an old run.

---

## 9. Precedence and governance

### 9.1 Precedence order

```text
platform safety
  > organization policy
  > project policy
  > user preference
  > package default
```

This is not “higher precedence wins” in the naïve sense. The correct rule is:

> **A lower layer may add stricter requirements. It may never weaken a higher-layer requirement.**

Examples:

- an org may require a second reviewer; a project may add a third;
- a project may not remove the org’s second reviewer;
- a user may choose a different implementer if the org allows implementation binding;
- a package may propose a gate, but cannot activate it outside the trust policy;
- platform safety cannot be waived by any layer.

### 9.2 Resolved policy

The resolver produces:

```ts
interface ResolvedPolicySet {
  requiredStages: string[];
  requiredChecks: string[];
  minimumReviewers: number;
  allowedImplementers: string[];
  allowedNetworkHosts: string[];
  allowedDataClasses: string[];
  maxExtensionsPerStage: number;
  maxTransformDepth: number;
  requireHumanApprovalFor: string[];
  allowedCommunityModes: CapabilityMode[];
}
```

### 9.3 Trust and authority

| Trust tier | Observe | Advise | Gate | Transform |
|---|---:|---:|---:|---:|
| `official` | Yes | Yes | Yes | Yes, if declared |
| `verified` | Yes | Yes | Yes, after permission review | Yes, if declared and reviewed |
| `organization-trusted` | Yes | Yes | Yes, for that org | Yes, if org policy allows |
| `community` | Yes | Yes | Shadow/suggest only until promoted | No transform of protected artifacts |

Trust tier is necessary but not sufficient. The effective authority is:

```text
trust tier
∩ declared permissions
∩ lifecycle mode
∩ project/org policy
∩ artifact sensitivity
```

A verified package does not automatically get `transform`. A community package cannot become `enforce` merely because the user installed it.

### 9.4 Organization trust is scoped

`organization-trusted` is not a fourth global publisher badge. It is a local policy overlay:

- scoped to an org ID;
- approved by an org admin/security role;
- has an expiry and reviewer;
- can elevate a community package for that org;
- never changes the package’s public trust tier;
- is shown with the org name in every surface.

### 9.5 Approval rules

- A package cannot approve itself.
- An agent cannot approve a lifecycle change it drafted.
- A lifecycle change is a reviewed diff: stages, capabilities, permissions, data classes, budgets, and expected cost.
- A waiver requires a role, reason, scope, and expiry. A waiver is not a `pass`.
- Platform safety changes require the platform owner, not an org admin.

---

## 10. Execution engine

### 10.1 Runner responsibilities

`LifecycleRunner`:

- loads a compiled IR and lock;
- creates or resumes a durable run record;
- acquires a lease;
- creates the isolated workspace;
- executes stages and slots in deterministic order;
- persists artifacts and events after every committed step;
- enforces budgets and cancellation;
- stops at required gate failures;
- hands delivery to the PR adapter;
- records learning metrics.

The runner does **not**:

- call a model to decide what runs next;
- import a package into the host process;
- guess a missing artifact;
- convert an error into success;
- allow a package to mutate the IR.

### 10.2 Run state machine

```text
queued
  → compiling
  → ready
  → running
  → verifying
  → review_ready
  → delivering
  → completed

Any state may become:
  blocked | failed | cancelled | paused
```

Rules:

- `blocked` is a policy outcome, not an infrastructure error.
- `failed` is an execution error after retries.
- `cancelled` is user/operator intent.
- `paused` waits for approval, budget, or manual resume.
- `completed` requires `deliver` success and a verification artifact.
- A run with a failing required check cannot be `completed`.

### 10.3 Stage context

```ts
interface StageContext {
  runId: string;
  stageId: string;
  projectRoot: string;
  workspace: {
    dir: string;
    baseCommit: string;
    branch: string;
    sourceDirty: number;
  } | null;
  artifacts: ArtifactReader;
  policy: ResolvedPolicySet;
  budget: BudgetHandle;
  signal: AbortSignal;
  logger: StageLogger;
  evidence: EvidenceWriter;
}
```

No stage receives `process.env` wholesale. Secrets are brokered per declared capability and host.

### 10.4 Adapters

| Adapter | Wraps | Contract |
|---|---|---|
| `PlanStageAdapter` | `Orchestrator` planning or `PlannerAgent` | emits `plan` artifact; no edits |
| `ImplementStageAdapter` | `Orchestrator` writer/tool-calling path | emits `patch`; writes only to isolated worktree |
| `TestStageAdapter` | runner/tester modules | emits `test-result` with commands, exit codes, output ref |
| `ReviewStageAdapter` | reviewer / `PRReviewAgent` | emits `review` with findings and verdict |
| `VerifyStageAdapter` | `DefaultVerifyModule` | emits `verification` with blockers and evidence |
| `DeliverStageAdapter` | PR/git adapter | emits `delivery`; no merge without policy |
| `LearnStageAdapter` | metrics/eval store | emits `learning`; never blocks delivery by default |

Adapters must be idempotent at the stage boundary. A repeated `implement` on the same input and workspace must not create a second branch or duplicate commit.

### 10.5 Workspace isolation

Use `createIsolatedWorktree()` from `src/tools/worktree.ts`.

Required properties:

- `base` commit recorded before any edit;
- branch recorded in the run;
- `sourceDirty` recorded and surfaced;
- no write to the source tree;
- containerized execution for untrusted capabilities;
- dependency installation from lockfile, not from an arbitrary postinstall script;
- workspace retained until artifacts and diff are persisted;
- teardown failure recorded as a warning, not silently ignored.

For session runs, the lifecycle run attaches to the existing `CodingSession` and does not create a second branch.

### 10.6 Concurrency

- One writer per branch/workspace.
- `gate` nodes execute after their input artifact is stable.
- `observe`/`advise` nodes at the same slot may run in parallel.
- Two gates at the same slot may run in parallel only if they read the same immutable artifact and their results are merged deterministically.
- Transform and its downstream gates are serial.
- The runner enforces `maxConcurrentExtensions` per run and per org.

### 10.7 Budgets and cancellation

Every run has:

- max wall clock;
- max model spend;
- max tool spend;
- max artifact bytes;
- max extension count;
- max transform depth;
- max retries per node.

On budget exhaustion:

- `gate`: fail closed;
- `advise`/`observe`: record `budget_exhausted` and continue only if policy allows;
- `transform`: fail closed;
- `deliver`: block and require operator action.

Cancellation is cooperative: `AbortSignal` reaches stages, sandboxes, and model calls. The runner waits for a bounded grace period, kills the sandbox, persists partial artifacts, and marks the run `cancelled`.

### 10.8 Idempotency

Every side effect uses an idempotency key:

```text
runId : stageId : nodeId : artifactHash
```

Applies to:

- gate results;
- PR creation;
- PR comments;
- evidence upload;
- check-run creation;
- commit creation;
- notification delivery.

A retry returns the prior result if the key and input hash match. A changed input hash creates a new result.

### 10.9 Checkpoints and resume

The run record is committed after:

- stage start;
- artifact write;
- gate decision;
- external side effect acknowledgement;
- stage completion;
- block/fail/cancel.

Resume reads the last committed checkpoint and revalidates:

- definition hash and lock;
- artifact hashes;
- workspace base commit;
- external side-effect receipts.

A stale lock or workspace mismatch fails with `LR014`; it does not silently continue.

---

## 11. Gate contract

### 11.1 Result schema

```ts
interface GateResult {
  decision: 'pass' | 'warn' | 'block';
  summary: string;
  reasons: string[];
  findings: Array<{
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    code: string;
    message: string;
    path?: string;
    line?: number;
  }>;
  evidence: Array<{
    kind: 'artifact' | 'command' | 'rule' | 'url';
    ref: string;
    hash?: string;
  }>;
  capability: {
    id: string;
    version: string;
  };
  evaluatedAt: string;
  inputHashes: string[];
}
```

Rules:

- unknown fields are rejected;
- `decision` is required;
- a `block` must have at least one reason or finding;
- a `pass` with no evidence is invalid for a required gate;
- `warn` is not `pass`; merge policy decides whether it can proceed;
- model prose is not a decision. If an agent produces prose, an adapter must convert it to this schema and validate it.

### 11.2 Gate failure behavior

| Situation | Required gate | Advisory gate |
|---|---|---|
| Crash | Retry, then `blocked` | Record warning; continue |
| Timeout | Retry, then `blocked` | Warning |
| Invalid output | `blocked` | Warning |
| Missing evidence | `blocked` | Warning |
| Permission denied | `blocked` | Warning |
| Budget exhausted | `blocked` | Warning |
| Stale input | Re-run; if still stale, `blocked` | Re-run or drop |
| `block` decision | `blocked` | Warning unless policy elevates |

### 11.3 Waivers

A waiver is a separate object:

```jsonc
{
  "gateId": "acme/threat-model",
  "runId": "run_...",
  "reason": "Accepted risk for a documented migration window",
  "scope": "this-run",
  "approvedBy": "user_...",
  "approvedAt": "...",
  "expiresAt": "...",
  "ticket": "SEC-1234"
}
```

- only an authorized approver can waive;
- the gate cannot waive itself;
- the policy can forbid waivers for a gate;
- the evidence shows `waived`, not `pass`;
- a waiver expires and is re-evaluated on the next run;
- org policy can require a second approver.

### 11.4 Evidence attachment

The PR evidence manifest includes:

- lifecycle ID, version, definition hash;
- run ID and session ID;
- each required gate, decision, and capability version;
- artifact hashes for plan, patch, test, review, verification;
- command exit codes;
- waived gates and approvers;
- model/provider used for each agent;
- cost and duration;
- trace ID.

Raw logs remain in the session data root. The PR gets a redacted manifest and a link/hash, not secrets. If attachment fails, the merge gate stays closed.

---

## 12. Transform semantics

Transform is the most dangerous mode. It is intentionally narrow.

A transform may only target artifacts declared transformable:

```text
plan
documentation
release-notes
```

It may not target:

```text
test-result
review
verification
security-finding
delivery
policy
audit
```

A transform:

1. reads the current artifact;
2. writes a new artifact with `parentHash`;
3. emits `artifact_transformed`;
4. invalidates decisions whose `inputHashes` includes the old hash;
5. forces downstream gates to run again;
6. records the transform capability, model, prompt hash, and diff.

Transform limits:

- max depth 2 by default;
- no transform can run after `verify` and change the verified artifact;
- no transform can change a PASS to a different result;
- a transform that fails leaves the previous artifact active and marks the node failed;
- community transform is disabled by default.

---

## 13. Security model

### 13.1 Execution classes

| Class | Runs in | Allowed |
|---|---|---|
| First-party reviewed | In-process only if explicitly marked | Read-only or bounded tools |
| Verified local package | Child worker | Declared tools, scoped workspace |
| Community/untrusted | Container | No host filesystem, deny-by-default network |
| Remote capability | Isolated runner | Explicit network and data policy |

There is no host-execution fallback when Docker or the sandbox is unavailable. A failed prerequisite blocks untrusted execution.

### 13.2 Permissions

Every capability declares:

- filesystem read/write scope;
- network hosts;
- secret names;
- model use;
- external side effects;
- artifact types;
- max concurrency;
- whether it may spawn sub-agents.

An undeclared access is denied at runtime and recorded. A permission expansion requires re-approval.

### 13.3 Prompt injection and untrusted content

- Repository files, issues, PR comments, web pages, and tool output are data, not instructions.
- A gate cannot be instructed by repository text to mark itself passed.
- A capability cannot read an artifact outside its declared input types.
- A gate result is validated against a schema; free-form model output cannot become authority.
- Secrets are injected per capability and never included in prompts or artifacts.

### 13.4 Supply chain

- signed package manifests and artifacts;
- checksums in the lockfile;
- no postinstall execution;
- dependency SBOM;
- quarantine before indexing;
- revocation list;
- immutable versions;
- source and publisher provenance;
- reproducible build or pinned digest.

### 13.5 Threat model highlights

| Threat | Control |
|---|---|
| Malicious lifecycle pack | Sandbox, permission review, quarantine, signed versions |
| Gate bypass by prompt injection | Typed inputs, schema validation, protected stages |
| Secret exfiltration | Scoped broker, redaction, no ambient env |
| Stale approval after transform | Artifact hash lineage and revalidation |
| Agent self-approval | Separate approver identity and role check |
| Evidence tampering | Hash manifest, append-only audit, signed run record |
| Cost denial of service | Per-run/stage budgets, concurrency and retry caps |
| Cross-session contamination | One worktree/branch per writer, read-only reviewers |

---

## 14. Enterprise governance

### 14.1 Roles

| Role | Can |
|---|---|
| `owner` | Platform policy, emergency revocation, break-glass |
| `admin` | Org policy, trust decisions, member roles |
| `operator` | Apply/enable lifecycles, approve waivers, cancel runs |
| `author` | Author packages and lifecycle definitions |
| `reviewer` | Review lifecycle diffs and package permissions |
| `approver` | Approve protected-stage waivers and merges |
| `auditor` | Read-only audit, evidence export, no mutation |

Roles are enforced server-side. The dashboard cannot do anything the CLI cannot do.

### 14.2 Enterprise controls matrix

| Control | Phase 5 requirement | Status |
|---|---|---|
| SSO / SCIM | Organization identity and group mapping | Required for enterprise tier |
| RBAC | Roles above, scoped by org/project | Required |
| Audit export | JSONL/CSV to SIEM or object storage | Required |
| Data residency | Execution and artifacts remain in chosen region/machine | Required |
| On-prem / VPC runner | Same session contract, no hosted dependency | Supported by adapter |
| Secret broker | OS keychain / Vault / cloud secret manager | Required |
| Policy precedence | Platform > org > project > user > package | Required |
| Evidence retention | Configurable, immutable manifest, export | Required |
| Break-glass | Time-bound emergency override, two approvers | Required |
| Support bundle | Redacted run export with trace IDs | Required |
| SLOs | Compile, gate latency, run recovery | Defined in §18 |

### 14.3 Compliance evidence

The system produces evidence that can support SOC 2, ISO 27001, and internal controls. It does **not** claim certification. Each control should state:

- the control objective;
- the event/artifact that proves it;
- the retention period;
- the reviewer/approver;
- the export format.

### 14.4 Retention

Defaults:

- run summaries and evidence manifests: 1 year;
- raw logs: 30 days;
- artifacts: 90 days, configurable;
- waivers and approvals: 7 years or org policy;
- audit events: append-only, org policy.

Deletion is an explicit, audited operation. App update and uninstall never delete the lifecycle data root.

---

## 15. Management surfaces

### 15.1 Control service

All mutations go through one control service. The dashboard must not write lifecycle files directly.

Minimum operations:

```text
lifecycle.list
lifecycle.inspect
lifecycle.validate
lifecycle.compile
lifecycle.simulate
lifecycle.apply
lifecycle.enable
lifecycle.disable
lifecycle.rollback
lifecycle.export
lifecycle.import
run.start
run.pause
run.resume
run.cancel
run.inspect
run.evidence
policy.get
policy.set
trust.approve
trust.revoke
```

### 15.2 CLI

```bash
nuvira lifecycle list
nuvira lifecycle inspect coding/v1
nuvira lifecycle init --preset regulated
nuvira lifecycle validate ./lifecycle.json
nuvira lifecycle compile ./lifecycle.json --output ./build
nuvira lifecycle simulate ./lifecycle.json --goal "add OAuth login" --shadow 5
nuvira lifecycle apply ./lifecycle.json --scope project
nuvira lifecycle enable --scope project
nuvira lifecycle disable --scope project
nuvira lifecycle rollback --to <definition-id>
nuvira lifecycle export <id> --output ./pack
nuvira lifecycle import ./pack

nuvira run list --state blocked
nuvira run show <run-id>
nuvira run evidence <run-id> --format json
nuvira run resume <run-id>
nuvira run cancel <run-id>
```

Exit codes:

| Code | Meaning |
|---|---|
| `0` | success |
| `2` | validation/compile failure |
| `3` | policy block |
| `4` | capability/runtime failure |
| `5` | approval required |
| `6` | budget exhausted |
| `7` | conflict/stale lock |

### 15.3 Dashboard — Lifecycle Studio

Required views:

- protected graph with non-removable stages;
- slot list with installed capabilities filtered by compatibility and trust;
- permission, data-class, cost, and time preview before apply;
- diff between active and proposed lifecycle;
- shadow results and would-have-blocked evidence;
- run explorer with stage timeline, artifacts, gate decisions, cost, and failures;
- evidence viewer with hashes and redactions;
- approval and waiver queue;
- rollback and audit history.

### 15.4 Chat

The agent can:

- draft a lifecycle definition;
- explain a gate decision;
- propose a binding;
- show a simulation;
- start a run when the user has authority.

The agent cannot:

- apply an enforcing lifecycle;
- approve its own draft;
- waive a gate;
- edit a protected stage;
- grant a permission.

### 15.5 API

Stable API surface for enterprise embedding:

```text
POST /api/lifecycle/validate
POST /api/lifecycle/compile
POST /api/lifecycle/apply
GET  /api/lifecycle/:id
GET  /api/runs/:id
GET  /api/runs/:id/evidence
POST /api/runs/:id/cancel
POST /api/runs/:id/resume
```

All endpoints use the same authorization and audit path as CLI/dashboard. No endpoint returns a raw secret.

---

## 16. Storage and data model

### 16.1 Data root

Use `resolveNuviraDataPath()` for every path.

```text
<data-root>/lifecycle/
  definitions/
    <org>/<name>/<version>/
      lifecycle.json
      manifest.json
      lock.json
      README.md
  active/
    project/<project-id>.json
    org/<org-id>.json
  runs/
    <run-id>/
      run.json
      events.jsonl
      lock.json
      ir.json
      artifacts/
      evidence/
      logs/
  packs/
    <namespace>/<name>/<version>/
  trust/
    org/<org-id>.json
  index.db
  backups/
```

### 16.2 Metadata store

Use the existing `node:sqlite` `DatabaseSync` pattern with JSON fallback from `src/config/workspace.ts`, but create a **dedicated lifecycle database** rather than adding lifecycle tables to `workspaces.db`. The existing database is a project registry (`projects` table plus run summary); it has no run, stage, artifact, gate, approval, lease, or outbox schema. Do not add a second database dependency for Phase 5.

Tables:

```text
lifecycle_definitions
lifecycle_versions
lifecycle_active
lifecycle_runs
lifecycle_run_events
lifecycle_artifacts
lifecycle_gate_results
lifecycle_evidence
lifecycle_approvals
lifecycle_waivers
lifecycle_trust
lifecycle_locks
```

Artifacts themselves are files in the content-addressed store, not BLOBs in SQLite.

### 16.3 Run record

```jsonc
{
  "schemaVersion": 1,
  "id": "run_01J...",
  "sessionId": "ses_01J...",
  "projectId": "github:acme/app",
  "definitionId": "acme/regulated-delivery",
  "definitionVersion": "1.2.0",
  "definitionHash": "sha256:...",
  "lockHash": "sha256:...",
  "state": "blocked",
  "workspace": {
    "dir": "...",
    "base": "...",
    "branch": "nuvira/...",
    "sourceDirty": 0
  },
  "stages": [],
  "gates": [],
  "artifacts": [],
  "evidenceManifest": null,
  "budget": { "maxUsd": 10, "usedUsd": 1.23 },
  "blockedReason": {
    "code": "GATE_BLOCK",
    "gateId": "acme/threat-model",
    "message": "No threat model for a new token exchange"
  },
  "createdAt": "...",
  "updatedAt": "..."
}
```

### 16.4 Migrations

- schema version on every persisted object;
- forward migration with dry-run;
- backup before migration;
- rollback on failure;
- no migration writes outside the data root;
- old runs readable after upgrade;
- a failed migration leaves the previous pointer active.

---

## 17. Observability and Run Explorer

### 17.1 New events

Add to `EventNames`; do not reuse task events.

```text
lifecycle:compiled
lifecycle:compile-failed
lifecycle:run-queued
lifecycle:run-started
lifecycle:run-resumed
lifecycle:stage-started
lifecycle:stage-completed
lifecycle:stage-failed
lifecycle:slot-started
lifecycle:slot-completed
lifecycle:artifact-produced
lifecycle:artifact-invalidated
lifecycle:gate-evaluated
lifecycle:gate-blocked
lifecycle:gate-waived
lifecycle:evidence-attached
lifecycle:run-blocked
lifecycle:run-paused
lifecycle:run-completed
lifecycle:run-failed
lifecycle:run-cancelled
lifecycle:budget-exhausted
```

Every event includes `runId`, `stageId`, `nodeId`, `traceId`, and `timestamp`. No event includes a secret.

### 17.2 Run Explorer

The run view must answer:

- which definition and lock ran;
- which stages ran, in what order;
- which capability version produced each artifact;
- which gate blocked and why;
- which evidence was attached;
- what was retried, skipped, waived, or cancelled;
- what it cost and how long it took;
- what would have happened in shadow mode.

Replay means replaying the **recorded decisions and artifacts**, not re-calling models. A re-run creates a new run.

### 17.3 Metrics

- compile latency p50/p95;
- lifecycle overhead vs direct pipeline;
- gate latency p50/p95;
- block rate and false-positive rate;
- evidence attachment success;
- resume success;
- duplicate side-effect rate;
- cost per accepted change;
- escaped defects where available;
- shadow-to-enforce promotion rate.

No performance or quality claim is published without a measured baseline.

---

## 18. Error handling and recovery

### 18.1 Error taxonomy

```text
LC###  compiler/definition error
LR###  runner/execution error
LG###  gate error
LA###  artifact error
LP###  policy/permission error
LE###  evidence/delivery error
```

Examples:

| Code | Meaning | Retryable |
|---|---|---:|
| `LR001` | workspace creation failed | Yes, after prerequisite check |
| `LR002` | base commit changed | No; re-provision |
| `LR003` | stale lock | No; recompile |
| `LR004` | stage crashed | Yes, bounded |
| `LR005` | stage timeout | Yes, bounded |
| `LR006` | budget exhausted | No; operator action |
| `LR007` | duplicate side effect detected | No; return prior receipt |
| `LG001` | gate invalid result | No; fail closed |
| `LG002` | gate missing evidence | No; fail closed |
| `LG003` | gate stale input | Yes, re-run |
| `LA001` | artifact hash mismatch | No; quarantine |
| `LA002` | artifact schema mismatch | No; fail |
| `LP001` | undeclared permission | No; block |
| `LP002` | policy conflict | No; require review |
| `LE001` | PR creation failed | Yes, idempotent |
| `LE002` | evidence attachment failed | Yes; merge stays blocked |

### 18.2 Structured error

```jsonc
{
  "code": "LE002",
  "severity": "error",
  "runId": "run_...",
  "stageId": "deliver",
  "artifactHash": "sha256:...",
  "retryable": true,
  "message": "Evidence upload failed",
  "remediation": "Retry evidence attachment or ask an operator to waive with a ticket",
  "traceId": "..."
}
```

### 18.3 Recovery rules

- A crashed runner resumes from the last committed checkpoint.
- A failed external effect is retried with the same idempotency key.
- A missing artifact is never reconstructed from prose.
- A stale artifact invalidates decisions rather than silently reusing them.
- A failed evidence upload blocks merge; it does not produce a false success.
- A failed workspace teardown is a warning and is retried at startup.
- A failed migration restores the previous schema and active pointer.

### 18.4 External effects outbox

PR creation, comments, check runs, notifications, and evidence upload use an outbox:

```text
intent recorded → side effect attempted → receipt stored → marked delivered
```

On restart, undelivered intents resume. A receipt prevents duplicate PRs/comments.

### 18.5 User-facing failure

Every block/failure shows:

- what happened;
- why;
- which stage/artifact;
- what the user can do;
- whether a retry is safe;
- how to export evidence;
- trace ID for support.

---

## 19. Performance and scale

### 19.1 Targets

These are design targets, measured before publication.

| Metric | Target |
|---|---|
| Compile p50 | < 100 ms for a definition with 20 nodes |
| Compile p95 | < 500 ms |
| Lifecycle overhead | < 5% of a normal coding run, excluding added gates |
| Gate scheduling overhead | < 50 ms |
| Resume | < 2 s to first resumed stage |
| Duplicate PR/comment rate | 0 |
| Artifact write | < 100 ms for < 10 MB |
| Run Explorer load | < 1 s for 100 stages/artifacts |

### 19.2 Scale limits

- max 100 extensions per definition;
- max 8 extensions per stage by default;
- max 32 concurrent runs per org (configurable);
- max 1 writer per branch;
- max artifact size 100 MB by default;
- max evidence bundle 10 MB for PR attachment;
- large evidence by reference, not inline.

### 19.3 Benchmark plan

- baseline: current `TaskExecutionPipeline` and `Orchestrator`;
- lifecycle: same goal, same model, same repo, same tests;
- measure compile, run, gate, cost, and recovery;
- record all results in the benchmark docs, not marketing copy.

---

## 20. Compatibility and migration

### 20.1 Existing pipeline

`TaskExecutionPipeline` remains available as:

```text
coding/legacy
```

It is a protected adapter with the six existing steps. It cannot be used as proof that lifecycle composition exists. It is a compatibility path.

### 20.2 Existing orchestrator

`Orchestrator.execute()` remains the default plan/implement/review engine behind adapters, but it is a whole-run entry point. A plan-only/task-batch/review seam is a Phase 5 prerequisite for an `after:plan` gate that blocks before implementation. Its `OrchestratorOptions` are mapped to a `StageContext`; lifecycle-only options do not leak into unrelated call sites.

### 20.3 Existing workflow templates

A `WorkflowTemplate` is converted to a lifecycle **stage implementation** only when it fits the adapter contract. It is not automatically treated as a lifecycle pack. Templates with no typed outputs remain legacy.

### 20.4 Existing agents

Custom JS agents remain loadable through `ModuleRegistry`. Phase 5 requires a package manifest and sandbox before one can be used in a lifecycle. The legacy in-process loader is not a trust grant.

### 20.5 Existing hooks

Hooks remain the cheap native safety layer. They are not lifecycle gates, do not receive typed artifacts, and cannot be used to claim lifecycle compliance.

### 20.6 Versioning

- lifecycle definitions use SemVer;
- lifecycle IR schema version is independent;
- artifact schemas are versioned;
- capability compatibility ranges are checked at compile;
- a major lifecycle change requires a new ID or a migration;
- old runs remain readable with their lock and schema version.

### 20.7 Migration sequence

1. install new code without enabling lifecycle;
2. index existing workflows/agents as legacy capabilities;
3. compile built-in lifecycle definitions in shadow;
4. validate artifact adapters against real runs;
5. enable for design partners;
6. enable for projects that opt in;
7. keep `coding/legacy` selectable;
8. remove legacy only after a major version and a migration tool.

---

## 21. Testing and certification

### 21.1 Test layers

| Layer | What it proves |
|---|---|
| Unit | schema, predicates, compiler, resolver, ordering |
| Property | no cycle, no stage removal, deterministic hash |
| Contract | artifact schemas, gate result, adapter outputs |
| Integration | CLI/API/dashboard parity; worktree; artifact store |
| Security | sandbox escape, secret leakage, prompt injection, permission denial |
| Chaos | crash/restart, provider failure, timeout, disk full, partial PR |
| Performance | compile, overhead, concurrency, artifact I/O |
| Migration | old definitions, old runs, rollback |
| Enterprise | roles, org trust, retention, audit export |

### 21.2 Mandatory fixtures

- clean repository;
- repo with critical security finding;
- repo with a failing test;
- repo with a transformable plan;
- repo with an untrusted community lifecycle pack;
- repo with a stale artifact;
- repo with a protected branch;
- restart during gate;
- restart during PR creation;
- duplicate evidence upload;
- no Docker;
- missing artifact.

### 21.3 Acceptance matrix

#### Lifecycle

- [ ] Baseline stages always appear.
- [ ] Protected stage removal fails compile.
- [ ] Protected stage reordering fails compile.
- [ ] Binding changes implementation without removing the stage.
- [ ] Slots execute in deterministic order.
- [ ] A cycle is rejected.
- [ ] A definition cannot mutate the IR at runtime.

#### Execution

- [ ] A run compiles, starts, and completes in shadow.
- [ ] A required gate blocks implementation.
- [ ] A blocking gate produces no patch/PR.
- [ ] A warning is visible and policy decides mergeability.
- [ ] Transform invalidates downstream gates.
- [ ] Restart resumes without duplicate side effects.
- [ ] Cancellation stops the sandbox and preserves evidence.
- [ ] Budget exhaustion fails closed for required gates.

#### Evidence

- [ ] PR contains the evidence manifest.
- [ ] Evidence attachment failure keeps merge blocked.
- [ ] Raw logs are not attached if they contain secrets.
- [ ] Evidence hashes match artifacts.
- [ ] A waived gate is shown as waived, not passed.

#### Trust

- [ ] Community pack defaults to suggest/shadow.
- [ ] Community pack cannot enforce without approval.
- [ ] Verified package still needs permission review.
- [ ] Organization trust is scoped and audited.
- [ ] A package cannot self-approve.
- [ ] A lower policy layer cannot weaken a higher one.

#### Surfaces

- [ ] CLI and dashboard show the same definition hash and run state.
- [ ] Dashboard cannot bypass the control service.
- [ ] Chat cannot apply/approve a lifecycle.
- [ ] Export/import reproduces the definition and lock.

### 21.4 Release gates

Phase 5 cannot ship until:

- all mandatory fixtures pass;
- a security review signs off on sandbox and secret paths;
- a real design-partner repo passes the end-to-end security-gate scenario;
- crash/restart tests pass;
- evidence attachment failure blocks merge;
- rollback restores the prior active definition;
- performance targets are measured, not assumed.

---

## 22. Rollout plan

The parent plan’s two-week estimate is not credible for this scope, and the original 4–6 week estimate assumed thin stage adapters that the code does not yet expose. Use a **6–8 engineer-week** program for the enterprise-complete scope, with a **2–3 week** thin vertical slice first.

### 22.1 — Contract and threat model (3–5 days)

- freeze schemas;
- write compiler/resolver rules;
- approve error taxonomy;
- approve protected-stage invariants;
- approve artifact and evidence formats;
- security review of sandbox and secrets.

Exit: signed spec, no runtime change.

### 22.2 — Artifact store and compiler (1 week)

- content-addressed artifacts;
- `ArtifactEnvelope`;
- lifecycle definition schema;
- compiler and lockfile;
- deterministic ordering tests.

Exit: compile a definition to IR with no execution.

### 22.3 — Runner in shadow mode (1 week)

- `LifecycleRunner`;
- stage adapters around orchestrator/pipeline;
- worktree integration;
- checkpoints and events;
- shadow run records.

Exit: real run produces a shadow lifecycle record; no blocking.

### 22.4 — Gates, evidence, and failure handling (1 week)

- gate contract;
- required/advisory behavior;
- artifacts and lineage;
- evidence manifest;
- PR attachment;
- failure matrix and outbox.

Exit: security-gate scenario blocks before implementation and attaches evidence after pass.

### 22.5 — Management surfaces (1 week)

- control service;
- CLI;
- Lifecycle Studio;
- run explorer;
- approval/waiver queue.

Exit: CLI/dashboard parity on a real run.

### 22.6 — Packs, trust, and enterprise policy (1 week)

- lifecycle pack package;
- signing/quarantine hooks;
- org trust overlay;
- policy precedence;
- export/import;
- audit export.

Exit: a signed pack installs in shadow; org-trusted pack can enforce; community cannot.

### 22.7 — Hardening and design partners (1 week)

- chaos tests;
- performance measurement;
- migration from legacy;
- two design-partner repos;
- docs and support runbook.

Exit: Phase 5 acceptance matrix passes.

### Rollout controls

- feature flag `lifecycle.enabled` default false;
- project allowlist;
- shadow-first policy;
- kill switch per run, project, and org;
- rollback to prior definition;
- no public marketing claim before the acceptance matrix and measured evidence.

---

## 23. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Replacing the pipeline too early | Regresses existing reliability | Wrap first; keep `coding/legacy`; shadow before enforce |
| Gate false positives | Users disable the product | Shadow mode, measured precision, waiver policy |
| Gate bypass | Trust collapse | Protected stages, typed artifacts, no self-approval |
| Artifact incompatibility | Silent misrouting | Schema validation at compile and runtime; versioned artifacts |
| Runaway cost | Enterprise rejection | Per-run/stage budgets, hard stops, cost preview |
| Duplicate PRs/comments | Repository noise | Idempotency keys and outbox receipts |
| Evidence loss | Audit failure | Manifest hashes, attachment retry, merge blocked on failure |
| Community pack malware | Security incident | Sandbox, quarantine, signatures, no transform |
| Policy conflict | Unpredictable outcomes | Precedence resolver, strictness rule, compile rejection |
| Dashboard writes state | Split-brain | Control service only; server-side auth |
| Unsupported enterprise identity | Procurement block | SSO/SCIM and RBAC as enterprise-tier requirements |
| Performance overhead | Users bypass lifecycle | Measure and cap; no model calls in compiler |
| Vendor-specific integrations | Limited market | Adapter contract for GitHub/GitLab/Bitbucket/Azure DevOps |

---

## 24. Decisions required before implementation

1. **Baseline stage protection:** confirm `intake`, `inspect`, `plan`, `implement`, `test`, `review`, `verify`, `deliver` are protected; `learn` optional.
2. **Review binding:** confirm additional reviewers are additive and the baseline reviewer cannot be removed.
3. **Implement binding:** confirm a verified package may supply the implementer only with project policy approval.
4. **Default activation:** confirm new packs are `shadow`, not `enforce`.
5. **Organization trust:** confirm it is a scoped overlay, not a global tier.
6. **Evidence retention:** confirm raw logs 30 days and manifests 1 year as defaults.
7. **PR evidence:** confirm attachment failure blocks merge.
8. **Lifecycle pack naming:** confirm “lifecycle pack” is the runtime term; “method pack” is catalog-only.
9. **Phase scope:** confirm the 6–8 week enterprise estimate and the 2–3 week thin-slice sequence.
10. **Enterprise identity:** confirm SSO/SCIM is in Phase 5 enterprise scope or explicitly Phase 6. Local `rbac.json` roles are not SSO.
11. **Stage seam:** approve a public plan-only/task-batch/review seam or a `LifecycleStageHost`; a whole-run adapter is shadow-only.
12. **Worktree enforcement:** confirm every write-capable lifecycle stage runs in an isolated worktree with no live-tree fallback.
13. **Dedicated lifecycle store:** confirm a separate lifecycle DB and audit journal; do not overload `workspaces.db` or checkpoint JSON.
14. **Package runtime:** confirm lifecycle packs never use the existing in-process `~/.nuvira/agents/` dynamic-import loader.
15. **Migration parity:** confirm golden-run parity and rollback are release gates, not post-launch work.

---

## 25. Comparison with Copilot’s Phase 5 draft

Copilot’s draft is a strong product outline. It is not yet an implementation specification. The correct response is to keep its clarity, reject its semantic shortcuts, and add the operational depth the codebase requires.

### 25.1 What Copilot got right

| Strength | Why it matters |
|---|---|
| Protected core lifecycle | Correct starting point and correct marketing story |
| Four modes (`observe`, `advise`, `gate`, `transform`) | Clear authority model |
| Typed artifacts | The right unit of composition |
| Lifecycle IR and deterministic execution | Prevents model-driven scheduling |
| Transform revalidation | Prevents stale approvals |
| Gate result contract | Makes gates machine-checkable |
| Run Explorer and replay | Essential for enterprise trust |
| Solo/team modes | Good onboarding and enterprise progression |
| Lifecycle packs | Correct distribution unit |
| Clear non-goals | Prevents scope drift |
| “Programmable delivery lifecycles” positioning | Better than “plugins” |

### 25.2 What Copilot got wrong or left unsafe

| Issue | Why it is a problem | Correction |
|---|---|---|
| Every capability implements one `execute(context)` interface | Tools, workflows, packs, triggers, and agents have different execution and trust contracts | Separate `CapabilityDefinition`, `ExecutableCapability`, and `LifecyclePack`; only executable surfaces receive a stage context |
| “Higher precedence wins” | Ambiguous and can imply an org can override platform safety | Precedence is a strictness rule: lower layers may tighten, never weaken |
| Trust table grants `transform` by publisher tier | Trust is not authority; a verified package may still be unsafe for transforms | Authority = trust ∩ permissions ∩ mode ∩ policy ∩ artifact sensitivity |
| Community gates shown as “shadow” without a defined shadow model | Shadow can still spend money and produce misleading confidence | Explicit shadow run record, cost caps, would-have-blocked evidence, promotion gate |
| `on_success` generic slot | Creates ambiguous ordering and potential loops | Use stage-specific `after:*`, `after:deliver`; no generic success hook |
| `LifecyclePack` as both executable type and package type | Blurs packaging with runtime | Pack is a package; its agents are executables |
| No `on_retry`, `before_merge`, `after_merge` | Misses real coding-session control points | Add session slots and retry boundary |
| “Replace fixed pipeline” | Risks throwing away proven behavior | Wrap the pipeline as `coding/legacy`; add a new runner above it |
| No artifact lineage or storage model | Evidence cannot be trusted or replayed | Add content-addressed envelopes, hashes, parent links, invalidation |
| No failure taxonomy | “Proper error handling” is absent | Add `LC/LR/LG/LA/LP/LE` codes and fail-closed matrix |
| No idempotency or outbox | Retries duplicate PRs/comments | Add side-effect keys and receipts |
| No policy for waivers | A blocked gate has no governed escape hatch | Waiver object, role, expiry, audit; never `pass` |
| No concrete enterprise controls | SSO, audit export, retention, on-prem are unspecified | Add enterprise matrix and SLOs |
| No migration of existing workflows/agents/hooks | Phase 5 would break the installed base | Add adapters and `coding/legacy` |
| Acceptance criteria are too shallow | They check presence, not evidence or failure behavior | Add restart, duplicate, stale, budget, attachment, and parity tests |
| “2 weeks” implied | Not credible for this scope | 6–8 engineer-weeks with a 2–3 week vertical slice |

### 25.3 What the best merged version adds beyond both drafts

1. **Real code seams.** The spec names the actual orchestrator, pipeline, worktree, event bus, module registry, and path resolver.
2. **Artifact lineage.** Every decision points to an immutable artifact hash.
3. **Evidence delivery.** PR attachment is part of the gate outcome, not a reporting afterthought.
4. **Failure-first design.** A gate that crashes cannot pass; a missing artifact cannot be reconstructed from prose.
5. **Durable side effects.** Idempotency and an outbox prevent duplicate PRs, comments, and evidence uploads.
6. **Enterprise governance.** Roles, org trust, retention, audit export, and on-prem execution are explicit.
7. **Migration safety.** Existing pipeline, orchestrator, workflows, agents, and hooks keep working.
8. **Measured performance.** No claim without a baseline, and a defined benchmark method.
9. **Trust as a composition.** Publisher tier is not permission.
10. **A realistic delivery plan.** A thin vertical slice proves the security-gate scenario before the full platform.

### 25.4 Scorecard

| Dimension | Copilot draft | This spec |
|---|---:|---:|
| Product clarity | 9/10 | 9/10 |
| Lifecycle semantics | 7/10 | 9/10 |
| Codebase integration | 3/10 | 9/10 |
| Artifact/evidence model | 5/10 | 9/10 |
| Failure handling | 3/10 | 9/10 |
| Enterprise governance | 6/10 | 9/10 |
| Security model | 6/10 | 9/10 |
| Migration/compatibility | 2/10 | 9/10 |
| Testability | 4/10 | 9/10 |
| Implementation readiness | 4/10 | 8/10 |

The scores are comparative judgment, not measurements.

### 25.5 Final recommendation

Use Copilot’s draft for the **narrative**:

> Programmable delivery lifecycles, protected core, typed stages, governed extension.

Use this specification for the **implementation**:

> Wrap the existing engine, type the artifacts, make gates fail closed, attach evidence, persist lineage, enforce trust as a composition, and migrate the installed base.

Do not merge the drafts by adding more sections to both. Replace the Copilot implementation assumptions with the contracts in this document, keep its concise positioning, and build the thin slice in §22 first.

---

## 26. Appendix A — Minimal lifecycle pack

```jsonc
{
  "schemaVersion": 1,
  "id": "acme/secure-api",
  "version": "1.0.0",
  "extends": "coding/v1",
  "owner": "acme/platform",
  "description": "Threat modelling and security review for API changes",
  "compatibility": {
    "agentNuvira": ">=5.0.0 <6.0.0",
    "lifecycle": "coding/v1"
  },
  "activation": "shadow",
  "inserts": [
    {
      "id": "threat-model",
      "at": "after:plan",
      "capability": "acme/security-architect@1.0.0",
      "mode": "gate",
      "required": true,
      "inputs": [{ "type": "plan", "schemaVersion": 1 }],
      "outputs": [
        { "type": "threat-model", "schemaVersion": 1 },
        { "type": "findings", "schemaVersion": 1 }
      ],
      "onFailure": "block",
      "evidence": {
        "attachTo": "pull_request",
        "include": ["decision", "findings", "artifactHashes"],
        "redact": ["secrets", "tokens"]
      }
    },
    {
      "id": "security-review",
      "at": "before:review",
      "capability": "acme/security-reviewer@1.0.0",
      "mode": "advise",
      "inputs": [{ "type": "patch", "schemaVersion": 1 }],
      "outputs": [{ "type": "findings", "schemaVersion": 1 }],
      "onFailure": "warn"
    }
  ],
  "budgets": {
    "maxUsd": 5,
    "timeoutSec": 1800
  }
}
```

## 27. Appendix B — Run and evidence example

```jsonc
{
  "runId": "run_01J...",
  "definitionHash": "sha256:...",
  "state": "blocked",
  "stages": [
    { "id": "intake", "state": "completed" },
    { "id": "inspect", "state": "completed" },
    { "id": "plan", "state": "completed" },
    { "id": "after:plan/threat-model", "state": "blocked" }
  ],
  "gate": {
    "capability": "acme/security-architect@1.0.0",
    "decision": "block",
    "finding": "AUTH-014",
    "artifact": "plan@sha256:...",
    "remediation": "Add a threat model and token-lifetime decision"
  },
  "evidenceManifest": null,
  "blockedReason": "Critical security finding"
}
```

After a pass, the manifest is attached to the PR:

```jsonc
{
  "runId": "run_01J...",
  "lifecycle": {
    "id": "acme/secure-api",
    "version": "1.0.0",
    "definitionHash": "sha256:..."
  },
  "gates": [
    {
      "id": "threat-model",
      "decision": "pass",
      "capability": "acme/security-architect@1.0.0",
      "inputHash": "sha256:...",
      "evidence": ["artifact://sha256/..."]
    }
  ],
  "artifacts": {
    "plan": "sha256:...",
    "patch": "sha256:...",
    "tests": "sha256:...",
    "review": "sha256:...",
    "verification": "sha256:..."
  },
  "redactions": ["secrets", "tokens", "rawPrompts"],
  "traceId": "..."
}
```

## 28. Appendix C — Error response example

```jsonc
{
  "code": "LG002",
  "severity": "error",
  "runId": "run_01J...",
  "stageId": "after:plan",
  "message": "Required gate returned pass without evidence",
  "remediation": "Fix the gate capability or attach its evidence, then retry",
  "retryable": false,
  "traceId": "..."
}
```

## 29. Appendix D — Glossary

| Term | Meaning |
|---|---|
| **Advise** | Adds recommendations; cannot block or mutate |
| **Artifact** | Immutable typed output with a hash |
| **Binding** | Replaces a replaceable stage implementation |
| **Block** | Required gate decision that prevents progress |
| **Community** | Public package with automated checks only |
| **Compile** | Resolve definition/policy/lock into immutable IR |
| **Evidence** | Redacted proof of a decision or result |
| **Gate** | Typed policy decision about an artifact |
| **IR** | Immutable resolved execution plan |
| **Lifecycle pack** | Capability package containing a lifecycle definition and its dependencies |
| **Observe** | Records evidence/metrics; cannot block or mutate |
| **Organization trust** | Scoped local approval, not a public badge |
| **Protected stage** | Stage that cannot be removed, replaced, or bypassed |
| **Shadow** | Runs observationally without blocking or mutating |
| **Slot** | Named insertion point around a stage |
| **Transform** | Creates a new artifact version and invalidates downstream decisions |
| **Waiver** | Audited, expiring exception; never a `pass` |
