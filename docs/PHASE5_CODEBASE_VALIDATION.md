# Phase 5 — Codebase Validation and CIO Approval Review

| Field | Value |
|---|---|
| Status | Completed static review; no runtime code changed |
| Verdict | **Conditional GO** — upgrade the existing agent, not a rewrite |
| Decision owner | CIO / Solution Architect review |
| Scope | Phase 5 lifecycle graph against the live `agent-nuvira` codebase |
| Parent plan | [`ENHANCE_CUSTOM_CAPABILITY.md`](./ENHANCE_CUSTOM_CAPABILITY.md) |
| Phase 5 spec | [`PHASE5_LIFECYCLE_SPEC.md`](./PHASE5_LIFECYCLE_SPEC.md) |
| Method | Static code inspection, call-graph tracing, type/interface review, test inventory |
| Runtime tests | Not run; this is a plan-review artifact, not an implementation test report |

---

## 1. Executive decision

Phase 5 is **approved to proceed as an upgrade of the existing agent**, subject to the conditions in §8. It is **not approved as a drop-in wrapper**, and the original 4–6 engineer-week estimate is **not approved for the full enterprise scope**.

The existing agent already contains most of the execution intelligence Phase 5 needs:

- planning and dependency-aware task execution;
- model routing, repair, checkpointing, and steering;
- tool-calling writers and reviewers;
- worktree isolation primitives;
- security scanning and artifact verification;
- review bundles, RBAC, audit chaining, and a typed event bus.

What it does **not** contain is the control plane Phase 5 describes:

- a stage-addressable execution API;
- typed artifacts with hashes and lineage;
- a fail-closed gate contract;
- durable lifecycle runs and leases;
- a signed, sandboxed package runtime;
- a lifecycle compiler and resolver.

That is the correct division. Phase 5 should add the control plane around the existing execution substrate. It should not reimplement planning, routing, repair, or code generation.

**CIO position:**

> Proceed with a thin, measured upgrade. Do not describe it as a wrapper until the stage seam exists. Do not expose lifecycle packs to the existing in-process agent-plugin loader. Do not call the local RBAC file “SSO.” Approve the architecture direction, not the current delivery estimate.

---

## 2. What was reviewed

The review traced the live paths, not only the specification’s descriptions.

| Area | Files inspected | What was checked |
|---|---|---|
| Main execution | `src/cli/execute.ts`, `src/tools/pipeline-tool.ts`, `src/agents/orchestrator.ts` | Which engine actually runs, and whether stages are addressable |
| Fixed pipeline | `src/agents/task-execution-pipeline.ts` | Step boundaries, disk writes, dry-run behavior, retry loop |
| Agent contract | `src/agents/agent.ts` | `AgentContext`, `TaskStep`, `Artifact`, `FileChange`, `AgentResult` |
| Agent registry | `src/agents/module-registry.ts`, `src/plugins/agent-plugin.ts` | Global registration, override behavior, plugin execution |
| Verification | `src/agents/verify-module.ts`, `src/agents/artifact-verification.ts` | Whether “verify” is a gate or a score |
| Workspace | `src/tools/worktree.ts` | Isolation, base commit, diff, cleanup |
| Persistence | `src/agents/checkpoint-store.ts`, `src/config/workspace.ts` | Whether checkpoints and workspace SQLite are durable run stores |
| Events | `src/observability/event-bus.ts` | Typed events versus durable audit |
| Configuration | `src/config/paths.ts` | Data-root and config-dir correctness |
| Sessions | `src/cli/session.ts` | Chat/project continuity versus coding sessions |
| Workflows | `src/workflow/templates.ts`, `src/workflow/registry.ts` | Legacy workflow shape and registry trust |
| Hooks | `src/gateway/hook-contract.ts` | Native safety seams and their limits |
| Review | `src/team/review.ts` | Human review bundle and merge path |
| Enterprise | `src/enterprise/rbac.ts`, `src/enterprise/audit-chain.ts` | Roles, identity, audit evidence |
| Tests | pipeline, orchestrator, workflow, worktree test inventory | Existing coverage and missing validation surfaces |

The review was static. No repository code was modified, and no runtime test was executed for this report.

---

## 3. Actual execution topology

### 3.1 The main path is the orchestrator

The CLI does not construct `TaskExecutionPipeline`. It calls `runPipelineTool()` (`src/cli/execute.ts` around line 2273), which drives the orchestrator. `TaskExecutionPipeline` is exported from `src/index.ts` but has no internal `new TaskExecutionPipeline()` call.

That matters because the Phase 5 spec must not treat the six-step pipeline as the primary engine. The orchestrator is the primary engine. The pipeline is a **package-level legacy surface**, not the production path the CLI uses.

### 3.2 The orchestrator is a whole-run API

`Orchestrator.execute(goal, options)` is the public entry (`src/agents/orchestrator.ts:688`). It calls the private `executeCorrelated()` and then `executePipeline()` (`:793`).

Inside `executePipeline()` the orchestrator performs:

1. checkpoint load and reconciliation;
2. context-vault setup;
3. pre-flight inspection;
4. memory and MCP setup;
5. reasoner and planner;
6. task-plan creation and DAG publication;
7. task batches with dependency ordering;
8. review mode or file application;
9. learning, reporting, and result synthesis.

There is **no public `runPlanPhase()`**, `runTaskBatch()`, `runReviewPhase()`, or equivalent stage seam. There is no `planOnly` option. `dryRun` suppresses some writes and runner commands, but it still executes the workflow.

The separate `nuvira plan` command is not the same thing. It builds a context string and asks a provider for a single-shot markdown plan. It does not produce the orchestrator’s typed `TaskStep[]` plan and does not share the orchestrator’s planner path.

### 3.3 The fixed pipeline writes directly

`TaskExecutionPipeline.execute()` (`:209`) runs the six steps. The edit step writes through `applyChanges()` (`:973`) unless `config.dryRun` is true.

The test step then runs in `workingDirectory` (`stepTest`, around `:563`). If `dryRun` is true, the test runs against the **unchanged** tree. That makes `dryRun` unusable as a combined implement-and-test adapter: it either writes to the real tree, or it tests code that was never applied.

The lifecycle adapter must therefore run the pipeline inside an **isolated worktree** and treat that worktree as `workingDirectory`, with writes enabled there. It must not run it in the operator’s repository and rely on `dryRun`.

### 3.4 The existing worktree is usable, but not wired into the orchestrator

`src/tools/worktree.ts` provides:

- `createIsolatedWorktree()` at `:237`;
- base commit and branch;
- source-dirty reporting;
- `worktreeDiff()` at `:343`;
- refusal rather than silent fallback;
- cleanup and `node_modules` linking.

It is used by the subagent spawner. It is **not** wired into the main orchestrator’s write path. The orchestrator’s `applyFileChanges()` at `:4258` writes to `process.cwd()`.

This is a strong reusable primitive, but Phase 5 must add the wiring. “The worktree exists” is not the same as “lifecycle writes are isolated.”

### 3.5 The agent/plugin path is not a safe package runtime

`ModuleRegistry` is a global singleton. `registerOrOverride()` can replace a built-in agent type. `src/plugins/agent-plugin.ts` discovers `.js` files from `~/.nuvira/agents/` and loads them with `await import(pluginPath)` around `:258`. `installAgentPlugins()` registers them with `registerOrOverride()` around `:223` and explicitly warns when a plugin shadows a built-in.

There is no signature check, no sandbox, no manifest permission check, and no process boundary for those plugins. A lifecycle pack must **not** reuse this loader. It needs a separate package runtime with a signed manifest, declared permissions, a child process or container, and no in-process `import()` of untrusted code.

### 3.6 “Verify” is a score, not a policy gate

`DefaultVerifyModule` returns `VerificationResult` with:

- `passed: boolean`;
- `overallScore`;
- `checks: VerificationCheck[]`;
- `blockers`;
- `suggestions`.

Pass/fail is computed from blocking checks and a strictness threshold (`low` 0.5, `medium` 0.7, `high` 0.9). That is useful quality verification. It is not the lifecycle gate contract:

- no `pass | warn | block` typed result;
- no evidence object with hashes and capability versions;
- no waiver identity or expiry;
- no fail-closed distinction for malformed/crashed gates;
- no separation between a policy decision and a model score.

The lifecycle gate must be a separate contract. It may **call** the verify module as one input, but it must not treat `VerificationResult.passed` as the lifecycle decision.

### 3.7 Artifacts are untyped content

The current `Artifact` is `{ path, content, description }` (`src/agents/agent.ts`). `FileChange` is `{ path, originalContent?, newContent?, status }`.

There is no hash, media type, schema version, parent hash, producer capability, or lineage. The fixed pipeline’s `EditOutput` and `VerificationResult` are similarly plain step outputs.

Phase 5 can wrap these, but it must create its own `ArtifactEnvelope` and hash the content. It cannot claim the existing `Artifact` is already the typed artifact contract.

### 3.8 Persistence is not a durable run store

`saveCheckpoint()` (`src/agents/checkpoint-store.ts:78`) writes a JSON file under the memory directory. It is explicitly best-effort and returns `null` on failure. It is keyed by goal plus working directory and contains a serialized `AgentContext`.

`WorkspaceStore` (`src/config/workspace.ts`) uses `node:sqlite` with a JSON fallback and a `projects` table (`CREATE TABLE ... projects` around `:88`). It records project continuity and the last run summary. It is **not** a lifecycle run table, queue, lease table, artifact index, or evidence store.

The spec’s original statement that `workspace.ts` is the “metadata/index backend for lifecycle runs” is too strong. The correct statement is:

- reuse the **pattern** (`node:sqlite` with JSON fallback, WAL, lazy open, corruption tolerance);
- create a **dedicated lifecycle database** and schema;
- do not overload `workspaces.db` or the checkpoint JSON files with lifecycle state.

The event bus is also in-memory: `history` is an array capped at 10,000 records. It is a live observability bus, not an audit journal. Lifecycle audit needs its own append-only persisted stream.

### 3.9 Enterprise identity is partial

`src/enterprise/rbac.ts` has three local roles: `admin`, `operator`, `viewer`. It maps OS users through a local `rbac.json`. `OidcAdapter` is an interface with a `NoOidcAdapter` placeholder. There is no SSO/SCIM integration.

`src/enterprise/audit-chain.ts` does provide hash-chained, tamper-evident JSONL audit records. That is a genuine reusable asset for lifecycle evidence.

The spec’s enterprise matrix is therefore directionally correct but must not imply that SSO/SCIM exists. It must be scoped as a Phase 5 enterprise deliverable or explicitly deferred. Local RBAC is not enterprise identity.

### 3.10 Some existing paths bypass the data-root contract

`resolveNuviraDataPath()` and `resolveNuviraConfigDir()` correctly honor `NUVIRA_CONFIG_DIR`. But `src/workflow/registry.ts` still uses `resolveNuviraHome()` for its cache/install directory, which ignores the config-dir override. `checkpoint-store.ts` also uses `resolveNuviraHome()` with a separate memory-dir override.

New lifecycle storage must not copy those shortcuts. Every new path should resolve through `resolveNuviraDataPath()` or an explicitly scoped memory-dir helper, and tests should assert isolation under `NUVIRA_CONFIG_DIR`.

### 3.11 Hooks are genuinely separate and should stay separate

`src/gateway/hook-contract.ts` is declarative, with a fixed allow-list: `deny`, `notify`, `scan-args`. It cannot run a command, script, or MCP server. It binds to four tool/session seams.

That is the correct native safety layer. It is not a lifecycle gate, and lifecycle gates are not hooks. The spec’s separation is validated. Do not merge the two to simplify the UI.

### 3.12 Review bundles are a useful human gate, not a policy gate

`src/team/review.ts` creates a review bundle, supports approve/request-changes/reject, and `mergeReview()` applies the changes. It is a genuine human review surface.

It lacks:

- role-bound approval;
- evidence hash linkage;
- waiver expiry;
- protected-stage enforcement;
- a typed gate result;
- immutable audit linkage.

Use it as a UI/approval adapter only. The lifecycle record must own the authoritative approval and evidence state.

---

## 4. Claim-by-claim validation

| Phase 5 claim | Code evidence | Verdict |
|---|---|---|
| `TaskExecutionPipeline` is the fixed six-step execution path | `execute()` at `task-execution-pipeline.ts:209`; steps plan/inspect/edit/test/verify/summarize | Accurate as a component description; it is **not** the main CLI path |
| `Orchestrator` is a fixed pipeline with checkpoints, steering, review mode | `execute()` `:688`, `executePipeline()` `:793`, checkpoint saves `:1701/:1741`, review `:1763`, apply `:1793` | Accurate |
| The orchestrator can be wrapped by `PlanStageAdapter` / `ImplementStageAdapter` | No public plan-only or stage API; only whole-run `execute()` | **Not accurate today.** Requires a new seam or a limited whole-run adapter |
| `dryRun` can serve as a safe implement/test adapter | Pipeline writes only when `!dryRun`; test still runs against `workingDirectory` | **Not accurate.** Use an isolated worktree with writes enabled |
| `TaskExecutionPipeline` can be a legacy stage adapter | It writes to disk at `:973` and tests in place | Possible only inside a worktree; not a pure in-memory adapter |
| `ModuleRegistry` is a safe capability factory | Global singleton; `registerOrOverride()` can replace built-ins; no scoping or permissions | Registry is a factory, **not** a trust boundary |
| Agent plugins can host lifecycle packs | Dynamic `import()` from `~/.nuvira/agents/`; no sandbox or signature | **Reject.** Build a separate package runtime |
| Verification is a gate | `VerificationResult` is threshold-based, no evidence/waiver contract | Use as an input to a gate, not as the gate |
| `Artifact` is a typed artifact | `{ path, content, description }`; `FileChange` has no hash/lineage | Need `ArtifactEnvelope` and content-addressed store |
| `WorkspaceStore` can store lifecycle runs | Only a `projects` table and run summary; no queue/lease/artifact/evidence tables | **Not accurate.** Use the pattern, not the schema |
| Checkpoints are a durable lifecycle queue | JSON files, best-effort writes, no lease/idempotency/outbox | Not sufficient; new durable store required |
| Event bus can be the audit log | In-memory array, 10,000-record cap | Add a persisted event journal |
| Enterprise RBAC is available | Three local roles; OIDC adapter is a placeholder; no SSO/SCIM | Partial; enterprise identity is not built |
| Hooks and lifecycle gates are separate | Fixed allow-list; declarative; no script execution | Accurate and should remain |
| Review mode can support lifecycle approval | Review bundle approve/merge exists | Useful adapter; authoritative gate state must move to lifecycle |
| Existing workflows can be adapted | `WorkflowTemplate` has `agentType`, `dependsOn`, no typed I/O | Adapter is feasible; typed artifacts must be added |
| Worktree isolation is available | `createIsolatedWorktree`, `worktreeDiff`, cleanup; used by subagent spawner | Strong primitive; not wired into main orchestrator |
| Data-root helpers are used consistently | `resolveNuviraDataPath` exists; workflow registry/checkpoint store bypass it | New lifecycle code must use the helper; fix drift where touched |

---

## 5. What this means for “upgrade versus reimplement”

### Reuse

- `Orchestrator` for planning, implementation, review, repair, routing, and long-form work.
- `Agent` / `AgentContext` / `ContextVault` as adapter inputs and outputs.
- `ModuleRegistry` as an agent factory **after** trust and permission checks.
- `DefaultVerifyModule` and `src/security/scanner.ts` as gate inputs.
- `verifyArtifacts()` for declared-file evidence.
- `createIsolatedWorktree()` / `worktreeDiff()` for write isolation.
- `EventBus` for live events, with a new persisted journal beside it.
- `hook-contract.ts` as the native safety layer.
- `review.ts` as a review UI/approval adapter.
- `enterprise/rbac.ts` as a local authorization input, not an enterprise identity system.
- `enterprise/audit-chain.ts` for tamper-evident evidence records.
- `config/paths.ts` for every new persistent path.
- `node:sqlite`/JSON fallback pattern for a new lifecycle DB.

### Wrap

- `TaskExecutionPipeline` as `coding/legacy`, inside a worktree.
- `Orchestrator.execute()` as a **whole-run** adapter for the first shadow slice.
- Existing `WorkflowTemplate` definitions as legacy workflow capabilities.
- Existing review bundles as a review-stage adapter.
- Existing verification results as gate evidence, not gate authority.

### Build

- `LifecycleDefinition` schema and `LifecycleIR` compiler.
- `LifecycleRunner` with durable state, leases, idempotency, and outbox.
- `ArtifactEnvelope` and content-addressed artifact store.
- Typed `GateResult` with `pass | warn | block`, waiver, and fail-closed behavior.
- Dedicated lifecycle metadata DB and append-only event journal.
- Signed lifecycle pack format and lockfile.
- Sandboxed package runtime for untrusted capabilities.
- Policy precedence resolver and organization-trust overlay.
- Lifecycle Studio / run explorer / evidence export.
- Migration parity harness and golden-run comparison.

### Refactor

- Add a public stage seam to the orchestrator, or introduce a `LifecycleStageHost` that owns the plan/task/review boundaries without forking the orchestrator.
- Wire worktree creation into the lifecycle write path.
- Add a lifecycle-owned approval/evidence record rather than overloading the review bundle.
- Route new storage through `resolveNuviraDataPath()`.
- Extract a clean `AgentCapabilityAdapter` around `ModuleRegistry` so a package cannot register or override arbitrary agent types.

The ratio is not “new agent versus old agent.” The agent’s execution engine remains. The new code is the governance and composition layer around it.

---

## 6. Blocking findings

### F1 — No stage seam for `after:plan` (blocker)

**Impact:** The headline success case — a security gate after planning that blocks before implementation — cannot be implemented by calling `Orchestrator.execute()` alone.

**Required:** Add a stage-addressable boundary:

```text
prepare -> plan -> implement -> test -> review -> verify -> deliver
```

At minimum, expose a plan-only result and a task-batch executor, or build a `LifecycleStageHost` that composes the existing planner, task runner, and review path. A whole-run adapter is acceptable only for shadow observation, not for pre-implementation blocking.

**Decision:** Do not claim “wrap” until this exists.

### F2 — Pipeline writes to the live tree (blocker)

**Impact:** A lifecycle implement/test stage could modify the operator’s repository before the gate, review, or evidence step.

**Required:** Create a worktree for every lifecycle write run; pass its `dir` as `workingDirectory`; measure the diff against its base; apply to the real repository only after delivery approval.

**Decision:** Worktree isolation is mandatory, not optional, for the security-gate scenario.

### F3 — Verification is not a gate (blocker)

**Impact:** A model score or strictness threshold could be mistaken for a policy decision, and the evidence contract would be missing.

**Required:** Introduce a separate `GateResult` and `Evidence` object. `VerificationResult` is one input. The gate must be allowed to block independently of the verification score.

**Decision:** No lifecycle gate may be implemented by returning `VerificationResult.passed`.

### F4 — Package execution is in-process (blocker for public packs)

**Impact:** Untrusted lifecycle packs using the existing agent-plugin loader would execute arbitrary JavaScript inside the agent process.

**Required:** A package runtime with:

- signed manifest and checksum;
- declared permissions;
- child process or container;
- no host filesystem by default;
- no network by default;
- no `import()` of untrusted package code in the host process.

**Decision:** The existing `~/.nuvira/agents/` plugin path is explicitly out of bounds for lifecycle packs.

### F5 — Persistence is not durable enough (blocker)

**Impact:** A crash mid-gate, duplicate PR/comment, or lost evidence cannot be prevented with JSON checkpoints and an in-memory event bus.

**Required:** Dedicated lifecycle DB with runs, stages, artifacts, gate decisions, approvals, outbox, leases, and schema migrations; append-only event journal; content-addressed artifact files.

**Decision:** Do not overload `workspaces.db` or the checkpoint store.

### F6 — Enterprise identity is not enterprise-ready (scope condition)

**Impact:** Calling local `rbac.json` “SSO/SCIM” would be inaccurate in procurement.

**Required:** Either scope SSO/SCIM as a Phase 5 enterprise deliverable with an explicit adapter, or label the Phase 5 enterprise tier as “local RBAC + audit chain; SSO/SCIM in Phase 6.” Do not claim both.

**Decision:** State the limitation in the spec and dashboard.

### F7 — Storage paths drift (condition)

**Impact:** Lifecycle data could leak into the real user profile during isolated tests, or ignore the operator’s configured data root.

**Required:** Route new paths through `resolveNuviraDataPath()`; add an isolation test for `NUVIRA_CONFIG_DIR`. Do not copy the `resolveNuviraHome()` pattern used by the workflow registry.

**Decision:** Every lifecycle path gets a path test.

### F8 — The whole-run adapter can hide semantic regressions (condition)

**Impact:** A lifecycle wrapper around whole-run orchestrator calls may appear to work while bypassing the intended stage boundary. Planning, implementation, and review could all happen before an “after:plan” gate is evaluated.

**Required:** Golden-run parity tests that prove:

- no writer runs before an `after:plan` gate blocks;
- no PR is opened when a gate blocks;
- the plan artifact’s hash is the one the gate evaluated;
- restart after a block does not resume into implementation.

**Decision:** Add these to the Phase 5 acceptance matrix before calling the header scenario done.

---

## 7. Non-blocking findings

- `TaskExecutionPipeline` is exported but unused by the main CLI. Keep it as a compatibility surface, not as the canonical engine.
- The orchestrator’s `reviewMode` is a useful starting point for human approval, but its status is not role-bound or evidence-bound.
- The event bus is a good live feed; do not reuse its in-memory history as audit evidence.
- The workflow registry is a GitHub raw fetch with shape validation, no signatures, and no checksum verification. It is a distribution precedent, not a trust model.
- Skill provenance and quarantine exist in the skill subsystem, but they are not a lifecycle-pack signature or install model.
- The local RBAC roles do not match the lifecycle roles in the spec (`owner`, `admin`, `operator`, `author`, `reviewer`, `approver`, `auditor`). Either map them deliberately or introduce a lifecycle role layer; do not assume the existing three roles are equivalent.
- `resolveNuviraHome()` remains in a few older paths. New lifecycle code should not inherit that drift.

---

## 8. CIO approval conditions

Phase 5 may proceed under these conditions. They are release conditions, not optional polish.

1. **Stage seam approved.** A public plan-only and task-batch seam exists, or a `LifecycleStageHost` demonstrably prevents implementation before an `after:plan` gate decision.
2. **Worktree mandatory.** Every write-capable lifecycle stage runs in an isolated worktree; no fallback to the live tree.
3. **Gate contract separate.** `GateResult` and evidence are lifecycle-owned; `VerificationResult` is only an input.
4. **Dedicated lifecycle store.** Runs, artifacts, gates, approvals, leases, and outbox have their own schema and migrations.
5. **No in-process packs.** Untrusted lifecycle capabilities run in a child process or container; no dynamic `import()` in the host.
6. **Migration parity.** Existing orchestrator, pipeline, workflow, agent, and hook paths keep working; golden-run parity is measured.
7. **Enterprise claim discipline.** SSO/SCIM is either delivered or explicitly deferred; local RBAC is not presented as enterprise SSO.
8. **Path isolation.** New storage uses `resolveNuviraDataPath()` and passes an isolated-profile test.
9. **Evidence failure blocks merge.** No “success with missing evidence.”
10. **Estimate corrected.** Full enterprise scope is 6–8 engineer-weeks; the 2–3 week thin slice is the only near-term commitment.

---

## 9. Revised delivery estimate

The original 4–6 week estimate assumed stage adapters could be thin wrappers around existing code. The code does not provide the stage boundary, and the package runtime is not sandboxed. The corrected estimate is:

| Slice | Scope | Estimate |
|---|---|---:|
| Thin vertical slice | One project, shadow mode, security gate after plan, evidence manifest, no public packs | 2–3 weeks |
| Stage seam and adapters | Plan-only boundary, task-batch boundary, worktree wiring, golden-run parity | 1–2 weeks |
| Artifact/gate/store | Artifact store, typed gate, evidence, dedicated DB, event journal | 2 weeks |
| Surfaces and enterprise | CLI, Studio, approvals, RBAC mapping, audit export, retention | 1–2 weeks |
| Packs and hardening | Signed packs, sandbox runtime, lockfile, quarantine, chaos/security tests | 1–2 weeks |
| **Enterprise-complete** | Full acceptance matrix | **6–8 engineer-weeks** |

This is an engineering estimate, not a promise. It assumes the existing orchestrator is reused and the lifecycle runner is added around it. It does not assume a second agent implementation.

---

## 10. Final CIO recommendation

**Conditional GO.** The architecture is sound and the upgrade path is real. The existing agent is the execution substrate; Phase 5 is the control plane that makes delivery composable, auditable, and governable.

Do not approve:

- “wrap the orchestrator” without a stage seam;
- “use the existing plugin loader” for lifecycle packs;
- “use `workspaces.db`” for lifecycle runs;
- “SSO/SCIM” when only local RBAC exists;
- a 4–6 week full-scope estimate.

Approve:

- the thin vertical slice first;
- the stage seam and worktree wiring;
- a separate gate/artifact/evidence plane;
- a sandboxed package runtime;
- golden-run migration parity;
- the 6–8 week enterprise estimate.

That is the difference between **upgrading the existing agent** and **reimplementing it without knowing what it already does**. This review finds the former is achievable, but only with the conditions above.
