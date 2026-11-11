# Enhance Custom Capability — from workflows to a capability ecosystem

**Status:** PROPOSAL · revision 3 · planning only · no implementation started
**Date:** 2026-11-10
**Scope:** Agent-Nuvira runtime, authoring surface, registry, triggers, lifecycle, management, durable data, Copilot-class orchestration, and quality model
**Decision needed:** confirm the revised decisions in §15 before coding begins
**Inputs incorporated:** Docker is a required runtime with a guided install; all gateway channels are in launch scope; the marketplace is public from day one.

---

## 1. The ask, stated plainly

Make Agent-Nuvira able to:

1. **Develop heavy capabilities**, not only JSON workflow templates. A capability may contain real code, typed inputs and outputs, branching, loops, parallel work, retries, state, human approvals, and sub-workflows.
2. **Develop agents** that are installable, versioned, testable, and reusable — not one-off source edits.
3. **Consume those capabilities as its own offering.** Once installed, a capability should be discoverable and invocable by the agent, the CLI, the dashboard, the gateway, schedules, webhooks, and lifecycle events.
4. **Let end users author and manage capabilities**, then have Agent-Nuvira use them at its own discretion within the user's policy.
5. **Trigger capabilities from any meaningful input point**: a messaging channel, a webhook, a schedule, a repository event, an agent lifecycle event, or an explicit request.
6. **Support a large, high-quality ecosystem**, with provenance, permissions, testing, certification, versioning, and safe isolation.
7. **Preserve the existing brainstorming** so earlier recommendations are not lost.
8. **Manage the whole lifecycle from both the CLI and the dashboard** — one control plane, one audit trail, not two half-features.
9. **Keep developed capabilities and their data across Agent-Nuvira updates and reinstalls** — app code and user data are separate, and update/install must never erase authored work.
10. **Match Copilot-class coding orchestration** — durable work-item sessions, isolated branches, plan/execute/test/review loops, pull requests, steering, and human merge gates — in addition to the capability ecosystem.
11. **Let users and packages compose the lifecycle itself** — bind agents to stages and insert governed agents between planning, implementation, testing, review, and delivery, without weakening the baseline safety gates.

### Verdict

**Possible — but this is a platform layer, not a feature.** It requires seven things to be true at the same time:

- a real **capability package format**;
- a **unified registry** that makes packages discoverable;
- a **sandboxed runtime** that can execute code safely;
- an **orchestration layer** that turns a work item into a durable, reviewable coding session, with a **typed lifecycle graph** that governs where user agents may run;
- a **trigger and lifecycle layer** that can invoke capabilities from many surfaces;
- a **control plane** that gives the CLI and dashboard the same safe management operations;
- a **trust and quality system** that prevents the ecosystem from becoming a supply-chain or remote-code-execution problem.

Without all seven, the result is either a catalog of templates that the agent cannot really use, an unsafe plugin loader, or a system whose management UI and update path can quietly destroy the user's work.

---

## 2. What a "capability" means here

The word is currently overloaded. This plan uses one taxonomy.

| Term | Meaning | Examples |
|---|---|---|
| **Capability** | A versioned, installable unit of behavior with a declared contract | release-audit workflow, PDF agent, deployment tool |
| **Capability package** | The directory + manifest that ships one or more capabilities | `@acme/release-audit@1.2.0` |
| **Kind** | The execution shape of a capability | `skill`, `workflow`, `agent`, `tool`, `trigger`, `bundle` |
| **Offering** | The set of capabilities currently installed, enabled, and visible to the agent | "what Nuvira can do for this user" |
| **Invocation** | One execution of a capability | a single workflow run |
| **Work item** | The unit of intent assigned to the orchestrator | issue #42, a PR comment, a chat request |
| **Coding session** | A durable, resumable orchestration of one work item through plan, edits, checks, review, and a pull request | a session that opens a PR for review |
| **Control plane** | The single service the CLI, dashboard, and agent tools call to inspect or change capability state | `capability install`, the Hub install button |
| **Lifecycle graph** | The protected stages every run passes through and the typed slots where extensions may run | intake → inspect → plan → implement → test → review → deliver |
| **Lifecycle extension** | A versioned set of stage bindings and slot insertions shipped by a user or package | a security gate after planning, an a11y reviewer after testing |
| **Trigger** | The input event that starts an invocation | Slack message, cron, webhook, lifecycle event |
| **Capability index** | The searchable projection of everything invocable | tools + skills + workflows + agents + MCP + triggers |

A package may be **composite**: one manifest can ship a code workflow, a custom agent used by that workflow, a skill that documents it, and a webhook trigger. This is the unit users publish and install.

### The seven planes

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. AUTHORING     agent or user writes a package, tests it locally   │
├─────────────────────────────────────────────────────────────────────┤
│ 2. PACKAGE       manifest + code + tests + docs + provenance        │
├─────────────────────────────────────────────────────────────────────┤
│ 3. TRUST         validate → scan → preview → approve → sign         │
├─────────────────────────────────────────────────────────────────────┤
│ 4. ORCHESTRATION work item → session → plan → branches → review → PR│
├─────────────────────────────────────────────────────────────────────┤
│ 5. RUNTIME       sandboxed workers, durable runs, policy gates      │
├─────────────────────────────────────────────────────────────────────┤
│ 6. CONTROL PLANE one service for CLI, dashboard, and agent tools    │
├─────────────────────────────────────────────────────────────────────┤
│ 7. SURFACES      chat, CLI, dashboard, gateway, cron, HTTP, events  │
└─────────────────────────────────────────────────────────────────────┘
```

The agent should never consume a package directly from a directory. It consumes the **index**, asks the **policy layer** whether it may run, and the **runtime** executes it. Management surfaces do not edit files directly either: they call the **control plane**, which validates, authorizes, and audits every change.

---

## 3. What exists today (honest baseline)

This section is deliberately specific: it is the difference between a plan and a wish.

### 3.1 Skills

- `skill_manage` creates a draft `SKILL.md`; the user sees a preview card and must accept it.
- Accepted skills land under `~/.nuvira/skills/<name>/` and become runtime-matchable.
- Skill execution supports Python, JavaScript, shell, Ruby, Go, and Rust.
- `src/skills/sandbox-executor.ts` can run scripts in Docker with no network, read-only filesystem, CPU/memory/time limits, and cleanup.
- `src/skills/execution-approval.ts` contains approval logic and a hardcoded trusted-skill list.
- **This is the strongest existing self-extension loop:** draft → approve → live.

**Limit:** skills extend methodology and scripts. They do not add new tool schemas, typed workflow steps, triggers, or agent lifecycle behavior.

### 3.2 Workflows

- `WorkflowTemplate` is JSON with `steps[]`, where each step has `agentType`, `description`, and `dependsOn`.
- Built-ins include quick-fix, feature-implement, publish-release, security-audit, bug-hunt, and others.
- `workflow install` writes registry templates under `~/.nuvira/workflows/registry/`.
- `workflow run` checks built-ins, then installed registry templates, builds a pre-filled task plan, and runs the existing orchestrator.
- **This is real and useful for composing known agents.**

**Limits:**

- The schema is only "known agent type + description + dependency". There is no typed input/output, no code step, no branch, no loop, no parallel map, no retry policy, no durable state, and no trigger.
- `~/.nuvira/workflows/*.json` is scanned by `discoverWorkflowPlugins()`, but the result is counted rather than installed into the execution path. The runner reads built-ins and `workflows/registry/`, not the parent directory. A user-authored file there is discoverable but not runnable.
- The chat agent does not index workflows as selectable capabilities and has no dedicated workflow tool. A workflow is something the user invokes explicitly, not something the agent chooses.

### 3.3 Custom agents

- `~/.nuvira/agents/*.js` is auto-discovered at startup.
- A plugin exports `metadata` with `agentTypes` and an `execute(context, callLLM)`.
- `installAgentPlugins()` registers the types into the module registry, so a plan step or workflow can name the custom type.
- The SDK supports `defineAgent`, `scaffold`, and `registerAgent`.
- `registerAgent` edits a source checkout; it is not a runtime registry call.

**Limits:**

- Load is startup-only. There is no hot reload or per-package activation.
- Plugin code runs in-process with host privileges. There is no sandbox.
- A custom agent gets `AgentContext` and `callLLM` only. It has **no tool calling, no filesystem access, and no shell**, by design.
- It cannot register a new tool or trigger.
- `agentTypes` can shadow built-ins, which is visible but still a broad override.

### 3.4 Tools and MCP

- `registerTool` is compile-time. There is no userland tool-plugin API.
- MCP is the practical runtime extension path: connect a server, discover its tools, and expose them.
- `capability-registry.ts` normalizes tools, skills, MCP tools, and curated actions into one `Capability` shape.
- **This is the right shape for discovery, but the index omits workflows and custom agents.**

**Limit:** MCP tools are callable, but an MCP server is not a workflow, an agent, a trigger, or a lifecycle participant.

### 3.5 Triggers and surfaces

- The gateway supports 22 messaging platforms, including Telegram, Slack, Discord, WhatsApp, email, Matrix, Signal, and generic webhooks.
- Inbound messages currently route through NLU into the same planner/writer/runner/reviewer pipeline. There is no "this message starts this capability" typed router.
- `gateway/cron.ts` schedules a **registry tool** invocation, optionally delivering the result to a channel. It cannot schedule a workflow or capability package.
- The event bus already emits `orchestrator:pipeline-started`, `plan-ready`, `task-started`, `task-completed`, `tool:called`, `pipeline-completed`, delegation events, and cron events.
- Declarative hooks exist on four seams (`before_tool_call`, `after_tool_call`, `failed_tool_call`, `on_session_end`) with three actions (`deny`, `notify`, `scan-args`). They are rules, not code. That is a safety feature and should stay.

**Limit:** there is no trigger registry that maps `(source, filter, input schema)` to a capability. Every surface has its own path.

### 3.6 Embedding in another app

- The SDK can define and run custom agents programmatically.
- SDK agents do not receive Nuvira's toolset, filesystem, or workflow engine.
- There is no stable public "invoke a capability" API for a host application.

**Limit:** the SDK is an agent-authoring SDK, not a capability-embedding API.

### 3.7 Existing seams worth reusing, not replacing

| Need | Existing seam |
|---|---|
| Tool execution and schemas | `src/tools/registry.ts`, `toolsets.ts` |
| Capability normalization | `src/tools/capability-registry.ts` |
| Skill storage and drafts | `src/learning/skill-drafts.ts`, `src/skills/` |
| Sandboxed execution | `src/skills/sandbox-executor.ts` |
| Workflow templates and registry | `src/workflow/templates.ts`, `src/workflow/registry.ts` |
| Custom agent loading | `src/plugins/agent-plugin.ts`, `src/agents/module-registry.ts` |
| MCP tools | `src/mcp/manager.ts`, `catalog.ts`, `custom-server.ts` |
| Lifecycle events | `src/observability/event-bus.ts` |
| Messaging and channel routing | `src/gateway/` |
| Scheduled jobs | `src/gateway/cron.ts` |
| Declarative guardrails | `src/gateway/hook-contract.ts` |
| Dashboard and API | `src/web-dashboard/` |

### 3.7 Coding orchestration

The existing orchestrator is a stronger foundation than a generic chat loop:

- `Orchestrator` runs plan → dependency-ordered tasks → writer/runner/reviewer, with checkpoints, mid-run steering at safe points, provider failover, memory, and event-bus observability.
- `createIsolatedWorktree()` creates a real git worktree on a `nuvira/<name>` branch under `~/.nuvira/worktrees`, measures the diff against `HEAD`, and removes it by default. The subagent spawner and the dashboard chat route already use it.
- The structured git tool supports gated commit and push; raw `git push` remains denied in the terminal policy.
- Specialist agents exist for issue triage, PR review, branch automation, GitLab, and releases.

**Limits:**

- The pipeline is local and mostly synchronous. There is no durable work queue, no “assign an issue and come back later” session, no hosted or containerized repository sandbox, and no PR review round-trip.
- Worktrees are ephemeral by default and are not a session record. There is no canonical `CodingSession` object that survives a process restart and owns the branch, plan, checks, review comments, and PR link.
- There is no merge queue, protected-branch policy, required-check gate, or “respond to review feedback and re-run CI” loop.
- Custom agent profiles are JavaScript plugins loaded in-process, not the scoped Markdown/TypeScript agent profiles a Copilot-class orchestration surface expects.
- There is no dedicated Docker prerequisite check for this layer yet; the existing sandbox is used by skills, not by a repository coding session.

**Verdict:** the execution primitives exist; the orchestration product does not. §12 defines that layer without replacing the current pipeline.

### 3.8 Management and durable data

The management surface is currently split across commands and pages:

- CLI: `workflow`, `marketplace`, `skills`, `plugins`, `mcp`, `gateway`, `admin`, and `doctor` each own a slice. There is no unified `capability` command.
- Dashboard: `/capabilities` is a **machine-readiness** page (what verbs work, missing executables, learned commands, session grants), not a package manager. `/hub` is the agent-enablement hub. There is no Capability Hub, package review screen, publisher portal, or unified run/session view.
- There is no control-plane API. Dashboard routes read and write files, env values, and config directly, with their own role checks.

Data placement is already close to the right shape:

- `src/config/paths.ts` is the single resolver. `resolveNuviraConfigDir()` honors an explicit directory, `NUVIRA_CONFIG_DIR`, legacy `BUFF_CONFIG_DIR`, then `~/.nuvira`. `resolveNuviraDataPath()` keeps state under that root.
- Existing durable paths include `~/.nuvira/workflows/registry/`, `~/.nuvira/agents/`, `~/.nuvira/skills/`, `~/.nuvira/plugins/`, `~/.nuvira/provenance/`, `~/.nuvira/mcp/`, `~/.nuvira/gateway/`, `~/.nuvira/memory/`, and `~/.nuvira/worktrees/`. Project skills live in `<project>/.agents/skills/`.
- Installation is `npm install -g agent-nuvira`; the app lives in the npm global prefix and user data lives outside it. There is no in-app self-updater today.

**Limits:**

- “Outside the npm package” is necessary but not sufficient. Upgrade/install commands can still overwrite user-authored artifacts: `workflow install` refuses an existing template, but `skills update` overwrites installed skill content, and there is no immutable package store, lockfile, or backup.
- Many older call sites still use hard-coded `~/.nuvira/...` paths; they bypass `NUVIRA_CONFIG_DIR` and will split an isolated profile.
- There is no schema version for capability state, no migration runner, no export/import, and no explicit “uninstall preserves authored source” contract.
- `~/.nuvira/workflows/*.json` is discovered but not executed; installing a registry template writes one JSON file with no version history.

**Verdict:** the data root is a good foundation, but update safety must become an enforced contract, not an accident of where npm puts binaries.

### 3.9 The lifecycle is fixed today

There are two execution paths, and both are fixed:

- `TaskExecutionPipeline` is explicitly a **six-step** sequence: `plan → inspect → edit → test → verify → summarize`.
- The main `Orchestrator` is richer but still hard-coded: pre-flight inspection, MCP/memory/skill context, reasoner, planner, DAG task batches, verification, report, and optional review bundle. It emits `pipeline-started`, `plan-ready`, `task-started`, `task-completed`, and `pipeline-completed`.

Existing extension mechanisms do not close the gap:

- **Workflow templates** pre-fill a fixed list of `agentType` steps and can bypass the planner. They are reusable *sequences*, not insertions into the core lifecycle.
- **`ModuleRegistry`** can register or override an agent type globally. It has no stage binding, artifact contract, scope, ordering, or per-run approval.
- **Hooks** are intentionally narrow: four seams (`before_tool_call`, `after_tool_call`, `failed_tool_call`, `on_session_end`) and three native actions (`deny`, `notify`, `scan-args`). They are safety rules, not agents, and there is no plan/test/review seam.
- **Steering** applies at a safe point *between task batches*, not at a typed stage boundary.
- **Event consumers** can observe lifecycle events, but cannot return a decision or transform an artifact.

**Verdict:** users can add an agent type or compose a fixed workflow, but they cannot say “run this security agent after the plan, block implementation if it finds a critical issue, and attach the report to the PR.” That is the missing product surface. This is a **current implementation gap, not a strategic preference**: the fixed pipeline is predictable and safe, but it cannot express a user-authored delivery method. Phase 5 replaces the fixed orchestration boundary with a typed lifecycle runner while retaining the protected stages.

The plan adds a **capability layer above these**, not a parallel universe beside them.

---

## 4. Previous recommendations, preserved

These were the recommendations from the earlier assessment. They remain the foundation of this plan.

### 4.1 The four extension levels

| Level | What it gives the user | What it gives Nuvira | Current state |
|---|---|---|---|
| **Skill** | A reusable methodology, optionally with scripts | A loadable behavior pack | Works; approval-gated |
| **Workflow** | A composed sequence of agents | A reusable plan | Works for installed JSON templates; not agent-selectable |
| **Custom agent** | A new reasoning worker | A new `agentType` | Works after restart; in-process trust |
| **New tool** | A new typed action | A new callable verb | MCP only; no userland tool API |

### 4.2 The gaps identified earlier

1. No unified capability index across skills, workflows, agents, and MCP.
2. No hot reload for agent plugins.
3. No dynamic tool registration for userland code.
4. Workflow plugin discovery is not wired into the execution path.
5. Arbitrary JS/plugin execution has full host trust.
6. The SDK cannot give a custom agent tools or filesystem access.
7. Workflows are explicit CLI objects, not capabilities the chat agent can choose.

### 4.3 The target shape recommended earlier

A **signed, versioned capability package** containing:

- a manifest;
- a `SKILL.md` or a code workflow;
- an optional custom agent;
- an optional MCP server or tool adapter;
- tests and examples;
- declared permissions and triggers.

Lifecycle: **draft → validate → preview → approve → install → index → invoke**.

This document turns that recommendation into a concrete architecture and delivery plan.

---

## 5. Target architecture

### 5.1 New layer, proposed module layout

These are proposed paths, not existing code:

```text
src/capabilities/
  manifest.ts          schema, validation, normalization
  store.ts             versioned package store + lockfile
  registry.ts          unified capability index
  installer.ts         install / upgrade / rollback / uninstall
  policy.ts            trust, permissions, approval, budgets
  runner/
    workflow-ir.ts     common intermediate representation
    executor.ts        durable run orchestration
    worker.ts          sandboxed code-step host
    checkpoints.ts     resume, replay, idempotency
  triggers/
    registry.ts        trigger definitions + matching
    http.ts            signed webhook ingress
    schedule.ts        cron adapter
    message.ts         gateway adapter
    event.ts           event-bus adapter
    agent.ts           model-requested invocation
  quality/
    lint.ts            manifest, permissions, docs, tests
    eval.ts            fixture and regression evaluation
    certify.ts         quality tiers and signatures
  orchestration/
    session.ts         durable CodingSession + state machine
    work-item.ts       issue / PR / chat / CLI intake
    queue.ts           assign, claim, cancel, resume
    workspace.ts       branch + worktree + container provisioning
    review-loop.ts     checks, review comments, changes requested
    pull-request.ts    PR creation and update, never auto-merge
  control/
    service.ts         one command/read model for every surface
    api.ts             authenticated dashboard/HTTP transport
    cli.ts             thin CLI adapter over the service
    audit.ts           who changed what, when, from which surface
  data/
    root.ts            install root vs data root vs workspace root
    migrations.ts      versioned, backed-up schema migrations
    backup.ts          export / restore / retention
    lock.ts            cross-process lock, atomic pointer swap
  lifecycle/
    contract.ts        stages, slots, modes, artifact schemas
    compiler.ts        LifecycleDefinition → deterministic LifecycleIR
    resolver.ts        agent/version/permission resolution
    runner.ts          stage wrappers, gates, ordering, budgets
    presets.ts         solo / team / regulated / fast profiles
    simulate.ts        shadow runs, cost/time estimate, diff preview
```

Supporting changes:

- `src/tools/capability-registry.ts` gains `workflow`, `agent`, `trigger`, and `bundle` kinds.
- `src/workflow/templates.ts` becomes a declarative adapter into the common IR, not the only workflow model.
- `src/plugins/agent-plugin.ts` keeps backward compatibility but delegates package discovery to `src/capabilities/`.
- `src/agents/module-registry.ts` supports runtime register/unregister per capability activation.
- `src/gateway/cron.ts` can schedule a capability, not only a registry tool.
- `src/gateway/registry.ts` can route an inbound message to a trigger, not only to the general pipeline.
- `src/web-dashboard/` gets a **Capability Hub** and **Agent HQ** (sessions), separate from the existing `/capabilities` readiness page; the readiness page links to the Hub rather than being repurposed.
- `src/agent-sdk/` gets `@agent-nuvira/sdk/workflow` and `@agent-nuvira/sdk/capability` entry points (or a sibling package if the API surface grows too large).
- `src/cli/` gets `capability`, `session`, and `backup` command groups; their handlers call the control service, not ad-hoc file writes.
- `src/config/paths.ts` gains an explicit data-root contract (install root / data root / workspace root / project root) and a compatibility alias for `NUVIRA_HOME`.

### 5.2 The unified capability descriptor

Every indexed capability should expose the same envelope, regardless of kind:

```jsonc
{
  "id": "workflow:acme/release-audit",
  "kind": "workflow",
  "name": "Release Audit",
  "version": "1.2.0",
  "oneLiner": "Audits a release, blocks on critical findings, and posts a report.",
  "effectClass": "external",
  "inputs": { "repo": "string", "channel": "string?" },
  "invoke": {
    "tool": "capability_run",
    "args": { "id": "acme/release-audit" }
  },
  "requires": {
    "credentials": [{ "anyOf": ["GITHUB_TOKEN"] }],
    "binaries": [],
    "inputs": ["repo"]
  },
  "trust": "verified",
  "platforms": ["cli", "chat", "dashboard", "gateway", "cron", "http"]
}
```

The important part is not the exact field names. It is that the agent can **search**, **inspect**, and **invoke** any kind through one contract.

---

## 6. Capability package specification

### 6.1 Package layout

```text
acme-release-audit/
  capability.json
  README.md
  CHANGELOG.md
  SKILL.md                  # optional: methodology for the agent
  workflow.ts               # optional: code-backed workflow
  agents/
    release-reviewer.ts     # optional: custom agent used by the workflow
  triggers/
    slack-release.json      # optional: trigger declarations
  tests/
    fixtures/
    workflow.test.ts
  eval/
    cases.jsonl
  docs/
    permissions.md
```

### 6.2 Manifest

`capability.json` is the source of truth. Code is an entry point; it is not the contract.

```jsonc
{
  "schemaVersion": 1,
  "id": "acme/release-audit",
  "name": "Release Audit",
  "version": "1.2.0",
  "description": "Audits a release and posts a report.",
  "license": "MIT",
  "compatibility": { "nuvira": ">=3.5.0 <4.0.0" },
  "kinds": ["workflow", "agent", "skill"],
  "entrypoints": {
    "workflow": "./workflow.ts",
    "agent": "./agents/release-reviewer.ts",
    "skill": "./SKILL.md"
  },
  "inputs": {
    "type": "object",
    "required": ["repo"],
    "properties": {
      "repo": { "type": "string" },
      "channel": { "type": "string" }
    },
    "additionalProperties": false
  },
  "outputs": {
    "type": "object",
    "required": ["verdict", "reportPath"],
    "properties": {
      "verdict": { "enum": ["pass", "warn", "block"] },
      "reportPath": { "type": "string" }
    }
  },
  "permissions": {
    "filesystem": { "read": ["."], "write": [".nuvira/artifacts/**"] },
    "network": { "hosts": ["api.github.com"] },
    "commands": { "allow": ["git", "npm"] },
    "secrets": ["GITHUB_TOKEN"],
    "mcp": ["github"],
    "models": { "maxCalls": 20, "maxSpendUsd": 2.0 }
  },
  "triggers": [
    {
      "id": "release-published",
      "type": "http",
      "path": "/hooks/acme/release",
      "auth": "hmac",
      "filter": { "event": "release.published" }
    },
    {
      "id": "release-command",
      "type": "message",
      "platform": "slack",
      "filter": { "channel": "releases", "mention": true }
    }
  ],
  "lifecycle": {
    "install": "none",
    "upgrade": "migrate",
    "uninstall": "none"
  },
  "quality": {
    "tests": "./tests",
    "eval": "./eval/cases.jsonl",
    "certification": "verified"
  },
  "provenance": {
    "author": "acme",
    "source": "github:acme/nuvira-release-audit",
    "commit": "…",
    "checksum": "sha256:…",
    "signature": "sigstore:…"
  }
}
```

### 6.3 Permission rules

Permissions are **deny-by-default** and are shown at install time.

- `filesystem.read` and `filesystem.write` are path globs, scoped to the workspace or an artifact directory.
- `network.hosts` is an allowlist. No wildcard by default.
- `commands.allow` names binaries; a command is still classified by the existing terminal policy.
- `secrets` names logical keys. The runtime injects only those keys, never the full process environment.
- `mcp` names servers the package may call.
- `models.maxCalls` and `maxSpendUsd` bound cost.
- A permission expansion on upgrade requires a new approval. It is never silently inherited.

### 6.4 Lifecycle is declarative first

`install`, `upgrade`, and `uninstall` are **not** arbitrary scripts that run on the host.

Allowed forms:

- `none` — nothing runs.
- `migrate` — a declared data migration, run in the sandbox.
- `sandbox:<entry>` — an explicit script, run in the sandbox with approval.
- `event` — emit a lifecycle event for an operator or another capability to handle.

An install hook is a package's most dangerous code because it runs before the user has seen the package work. It must never be auto-executed in-process.

---

## 7. Heavy code workflows

### 7.1 Two authoring forms, one execution model

Keep the existing JSON templates for simple pipelines. Add a TypeScript workflow SDK for real code.

Both compile to a **common workflow IR**:

- nodes: `code`, `agent`, `tool`, `skill`, `workflow`, `approval`, `parallel`, `map`, `branch`, `wait`, `emit`;
- edges: dependencies and data bindings;
- typed inputs and outputs;
- retry, timeout, and idempotency policy;
- permission scope;
- artifact references.

This avoids two runtimes and two sets of semantics. The JSON form is a restricted authoring surface over the same IR.

### 7.2 Illustrative SDK shape

This is a design sketch, not committed API:

```ts
import { defineWorkflow, z } from '@agent-nuvira/sdk/workflow';

export default defineWorkflow({
  id: 'release-audit',
  inputs: z.object({
    repo: z.string(),
    channel: z.string().optional(),
  }),

  async run(ctx) {
    const scan = await ctx.step('scan', () =>
      ctx.tool('security_scan', { path: ctx.workspace }),
    );

    const triage = await ctx.step('triage', () =>
      ctx.agent('release-reviewer', {
        findings: scan.findings,
        repo: ctx.inputs.repo,
      }),
    );

    if (triage.verdict === 'block') {
      await ctx.approval('A critical finding blocks this release. Continue?');
    }

    const [notes, report] = await ctx.parallel([
      () => ctx.agent('writer', { goal: 'Draft release notes' }),
      () => ctx.agent('reviewer', { goal: 'Write the audit report' }),
    ]);

    await ctx.emit('release.audit.completed', {
      verdict: triage.verdict,
      report: report.path,
    });

    return { verdict: triage.verdict, reportPath: report.path, notes };
  },
});
```

### 7.3 Step semantics

| Step | Purpose | Runs where |
|---|---|---|
| `code` | Deterministic transform, parsing, validation | Sandbox worker |
| `agent` | Reasoning or generation | Agent runtime, with declared tools |
| `tool` | A typed action | Existing tool registry, policy-gated |
| `skill` | Load methodology and execute its steps | Skill runtime |
| `workflow` | Compose another workflow | Same run engine |
| `approval` | Pause for a human decision | Surface-specific approval |
| `parallel` | Independent fan-out | Run engine |
| `map` | Iterate over a collection with bounded concurrency | Run engine |
| `branch` | Conditional path | Run engine |
| `wait` | Timer or external signal | Run engine |
| `emit` | Publish an event for triggers/observability | Event bus |

### 7.4 Execution guarantees

A "heavy" workflow is only credible if it survives real work:

- **Durable run record** — every run and step has an ID, status, timestamps, inputs, outputs, and errors.
- **Checkpoints** — resume after a crash or a paused approval.
- **Idempotency keys** — retries do not duplicate external effects.
- **Retries with backoff** — per step, with a declared maximum.
- **Timeouts and cancellation** — per step and per run.
- **Artifact passing** — large values move by reference, not by being pasted into prompts.
- **Replay** — re-run a failed step with the recorded inputs, without re-running successful ones.
- **Cost accounting** — model calls and external calls are attributed to the run and the capability.

### 7.5 Isolation

Three execution classes, chosen by trust and package type:

| Class | Used for | Isolation |
|---|---|---|
| **In-process** | First-party tools and built-in agents | Existing process; reviewed code only |
| **Child worker** | Verified local packages, fast startup | Separate process, restricted env, no raw secrets, resource limits |
| **Container** | Community/untrusted code, arbitrary dependencies | Docker, no network by default, read-only root, explicit mounts |

The existing Docker sandbox is the starting point for the container class. It already drops capabilities, limits CPU/memory/disk/time, and cleans up. It needs extension for artifact mounts, declared network allowlists, and structured input/output.

**Never run user-authored workflow code by importing it into the host process.** A `workflow.ts` is untrusted code even when it looks declarative.

---

## 8. Agent lifecycle and participation

"Agent lifecycle" has two meanings. Both matter, and they must not be conflated.

### 8.1 Capability lifecycle

```text
draft → validated → approved → installed → enabled → active
                                              │
                         disabled ←───────────┘
                             │
                         deprecated → removed
```

Events: `capability.installed`, `capability.enabled`, `capability.disabled`, `capability.upgraded`, `capability.removed`, `capability.failed`.

Rules:

- Installing does not enable.
- Enabling does not grant new permissions.
- Upgrading with new permissions returns to `approved` for the new scope.
- Removing a capability removes it from the index and unregisters its agent types, tools, and triggers.

### 8.2 Agent execution lifecycle

The orchestrator already emits the events needed for participation:

- `orchestrator:pipeline-started`
- `orchestrator:plan-ready`
- `orchestrator:task-started`
- `orchestrator:task-completed`
- `orchestrator:pipeline-completed`
- `tool:called`
- delegation and cron events

A capability can subscribe to those events as a **trigger**, not as an in-process callback:

```jsonc
{
  "type": "event",
  "event": "orchestrator:plan-ready",
  "filter": { "goalContainsAny": ["release"] },
  "capability": "acme/release-audit",
  "mode": "suggest"
}
```

This lets a capability participate in Nuvira's lifecycle without gaining the ability to inject arbitrary code into the orchestrator. The event is data; the capability runs in its own execution context.

### 8.3 Custom agents as first-class participants

A package can ship an agent that:

- appears in the planner's agent catalog;
- is usable as a workflow step (`agentType`);
- is usable through `delegate`;
- has a declared input/output contract;
- declares the tools it may call;
- is versioned with the package.

The new agent contract should be a superset of today's SDK agent, not a breaking replacement:

```ts
interface CapabilityAgent {
  metadata: AgentMetadata;

  validate(context: CapabilityContext): true | string;

  execute(context: CapabilityContext): Promise<AgentResult>;

  dispose?(): Promise<void>;
}
```

`CapabilityContext` adds scoped capabilities that today's SDK agent does not have:

- `ctx.tools.call(name, args)` — policy-gated tool access;
- `ctx.fs` — scoped to declared paths;
- `ctx.network` — declared hosts only;
- `ctx.secrets.get(name)` — declared keys only;
- `ctx.agents.call(type, input)` — bounded delegation;
- `ctx.workflows.run(id, input)` — bounded sub-workflow;
- `ctx.artifacts` — read/write by reference;
- `ctx.run` — run ID, cancellation, budget, trace.

That is a real capability surface, and it is why this is "heavy agent development" rather than "a better plugin file".

### 8.4 Discretion policy

The agent may choose a capability, but the user's policy decides whether choice becomes action.

Per capability and per trust tier:

| Mode | Behavior |
|---|---|
| `disabled` | Not visible, not selectable |
| `suggest` | Agent can recommend it; user must invoke |
| `ask` | Agent can invoke after a confirmation |
| `auto` | Agent can invoke within scope, budget, and permissions |

Recommended defaults:

- `auto` only for official/verified, read-only, low-cost capabilities;
- `ask` for anything that writes files, spends money, calls external systems, or triggers another agent;
- `suggest` for community packages until the user explicitly trusts the publisher;
- `disabled` by default for anything that requests shell or broad network access.

The policy must be enforced **outside the model**. A skill description or a prompt cannot grant itself permission.

### 8.5 The lifecycle is a graph, with protected stages

The baseline lifecycle is not replaced by user composition. It is a **protected graph** that always runs, with explicit slots around each stage.

```text
intake → inspect → plan → implement → test → review → verify → deliver → learn
           │          │          │          │          │          │
        slots      slots      slots      slots      slots      slots
```

Proposed stages for `coding/v1`:

| Stage | Purpose | Protected? |
|---|---|---|
| `intake` | Normalize the request, repo, constraints, and work item | Yes |
| `inspect` | Gather repository and environment context | Yes |
| `plan` | Produce the task/plan artifact | Yes |
| `implement` | Edit code, docs, or artifacts | Yes; the *agent* may be bound |
| `test` | Run deterministic checks and tests | Yes; cannot be removed |
| `review` | Review the diff against the plan and standards | Yes; additional reviewers may be inserted |
| `verify` | Evidence-based completion check | Yes; cannot be removed or overridden |
| `deliver` | PR, report, artifact, notification, or merge gate | Yes |
| `learn` | Capture eval/trajectory feedback | Optional |

A slot is a named insertion point:

```text
before:intake      after:intake
before:plan        after:plan
before:implement   after:implement
before:test        after:test
before:review      after:review
before:verify      after:verify
before:deliver     after:deliver
on_failure         on_retry
before_merge       after_merge
```

`before_merge` and `after_merge` belong to the coding-session lifecycle in §12; the rest apply to both a local pipeline run and a durable session.

### 8.6 Lifecycle extension contract

A lifecycle extension is versioned data plus a capability reference. It is not an arbitrary in-process callback.

```jsonc
{
  "schemaVersion": 1,
  "id": "acme/regulated-delivery",
  "version": "1.0.0",
  "extends": "coding/v1",
  "inserts": [
    {
      "id": "threat-model",
      "at": "after:plan",
      "agent": "acme/security-architect@1.3.0",
      "mode": "gate",
      "inputs": ["plan", "repoContext"],
      "outputs": ["threatModel", "findings"],
      "when": { "goalContainsAny": ["auth", "payment", "pii"] },
      "required": true,
      "onFailure": "block",
      "budget": { "maxUsd": 1.5, "timeoutSec": 300 }
    },
    {
      "id": "a11y-review",
      "at": "after:test",
      "agent": "acme/a11y-reviewer@2.0.0",
      "mode": "advise",
      "inputs": ["diff", "testResults"],
      "outputs": ["a11yReport"],
      "onFailure": "warn"
    }
  ],
  "bindings": {
    "implement": "acme/senior-implementer@2.1.0",
    "review": ["builtin/reviewer", "acme/security-reviewer@1.0.0"]
  }
}
```

Four modes, deliberately bounded:

| Mode | Power | Cannot do |
|---|---|---|
| `observe` | Attach evidence, metrics, or a note | Change an artifact or block |
| `advise` | Add recommendations/context for later stages | Change an artifact or block |
| `gate` | Return `pass`, `warn`, or `block` against a typed artifact | Rewrite the artifact, waive its own gate |
| `transform` | Rewrite a declared *transformable* artifact (for example, enrich a plan) with provenance | Touch test results, review verdicts, or protected safety artifacts |

A gate returns a typed result, not prose:

```jsonc
{
  "decision": "block",
  "summary": "The plan adds a new token exchange without a threat model.",
  "findings": [
    { "severity": "critical", "code": "AUTH-014", "path": "src/auth/token.ts" }
  ],
  "evidence": ["artifact:plan@sha256:...", "rule:AUTH-014"],
  "remediation": "Add a threat model and an explicit token-lifetime decision."
}
```

`decision` is one of `pass`, `warn`, or `block`. Unknown fields are rejected; a malformed gate result fails closed for a required gate and warns for an advisory. Predicates are bounded literals or globs over declared fields — no user-authored regex, `eval`, or arbitrary expression language.

There is no `replace-stage`, `bypass`, `run-shell`, or `inherit-host-env` mode. A stage binding chooses which agent fills a replaceable role; it never removes the stage.

### 8.7 Execution semantics

A lifecycle definition compiles to a deterministic **LifecycleIR**. The resolver, not the model, decides what runs:

1. Load the baseline `coding/v1` graph.
2. Merge extensions by precedence and version lock.
3. Resolve every agent ID/version and verify its permissions and compatibility.
4. Validate every artifact binding against its schema.
5. Topologically order slots; within one slot, preserve declared order then stable ID order.
6. Execute each stage through the existing orchestrator, with `before`/`after` wrappers.
7. Persist every decision, artifact hash, duration, cost, and block reason.

Guarantees:

- **The baseline always runs.** No extension can delete `intake`, `plan`, `test`, `review`, `verify`, or `deliver`.
- **Gates are deterministic.** A gate result is produced by code or by an agent whose output is schema-validated. A failed required gate blocks the run with a reason and a remediation path.
- **Artifacts are typed.** A plan, diff, test result, review, and report are distinct artifacts. An extension cannot silently treat one as another.
- **No stale gates.** A gate runs against the artifact version it was given. If an earlier transform changes the artifact, downstream gates re-run.
- **Predicates are bounded.** Slot `when` clauses use literal, tag, path-prefix, or glob matching over declared fields. There is no user regex, `eval`, or arbitrary expression evaluation in the scheduler.
- **Bounded composition.** Per stage: maximum extensions, maximum transform depth, wall-clock, token, and dollar budgets. Exceeding a limit stops or pauses; it never silently continues.
- **Failure isolation.** `onFailure` is explicit: `block`, `warn`, `retry`, or `escalate`. A crashing advisory cannot take down the pipeline; a required gate cannot be ignored.
- **Parallel only when declared.** Independent observe/advise slots may run in parallel. Gates run against a stable artifact and merge deterministically.
- **Version lock.** A run records the lifecycle definition hash and every resolved agent version. Re-running uses the lock unless the user explicitly upgrades.
- **Shadow mode.** A lifecycle can run in `shadow` for N runs: it records what it *would* have done without blocking or spending beyond a cap. This is how users evaluate a new gate before enforcing it.

#### 8.7.1 Worked example: security gate after planning

Definition:

```jsonc
{
  "at": "after:plan",
  "agent": "acme/security-architect@1.3.0",
  "mode": "gate",
  "inputs": ["plan", "repoContext", "policy"],
  "outputs": ["threatModel", "findings", "decision"],
  "required": true,
  "onFailure": "block",
  "evidence": { "attachTo": "pull_request", "redact": ["secrets", "tokens"] }
}
```

Execution:

1. The planning stage writes `plan@<sha256>` and records the repository base commit.
2. The gate runs in a read-only sandbox with the plan, repository context, and policy. It cannot edit the worktree; network is deny-by-default with an explicit allow-list.
3. The gate returns the typed result in §8.6. The runner validates every field and resolves every finding against the artifact hash it inspected.
4. `block`: no implementation stage runs. The session enters `blocked` with the finding, severity, evidence hash, remediation, and trace ID. The user or channel is notified; a waiver is a separate, audited decision with a role, scope, reason, and expiry. A waiver is recorded as `waived`, never as `pass`.
5. `warn`: implementation may proceed, but the warning is attached to the PR and the merge policy may still block it.
6. `pass`: implementation proceeds. The final PR carries the gate result and a redacted evidence manifest: plan hash, gate decision, findings, agent version, model/provider, timestamp, and trace ID. Raw logs remain in the session data root; secrets and tokens are never attached.
7. Evidence attachment is part of delivery, not a best-effort log line. If the PR comment, check output, or evidence upload fails, the session stays `review_ready` and the merge gate remains closed until the evidence is attached or explicitly waived by an authorized operator.

Failure behavior for this gate:

| Failure | Required-gate behavior | Result |
|---|---|---|
| Planning fails | Gate is not run | Run fails; no implementation or PR |
| Gate agent crashes or times out | Bounded retries with backoff; then fail closed | `blocked`; no implementation |
| Malformed or unknown result fields | Schema validation rejects the result | `blocked`; remediation names the invalid field |
| Model/provider unavailable | Retry; optional fallback to an approved model; never assume pass | `blocked` after the retry budget |
| Critical finding | Block immediately | `blocked`; finding, evidence, and remediation recorded |
| Stale plan or artifact hash | Reject the result and re-run the gate against the current artifact | Previous evidence is invalidated |
| Undeclared network, secret, or write attempt | Permission layer denies it | `blocked`; audit event with the requested capability |
| Duplicate execution or retry | Idempotency key on session + stage + artifact hash | One gate result, one PR check, one evidence record |
| Cancellation during the gate | Stop the sandbox and preserve partial evidence | `cancelled`; no implementation or merge |
| Evidence attachment fails | Retry idempotently; keep the merge gate closed | `review_ready` with `evidence_pending`, never a false `pass` |
| Budget exceeded | Pause for approval or fail closed per policy | `blocked`; cost and elapsed time recorded |

Every failure emits a structured object with `code`, `stage`, `artifactHash`, `retryable`, `remediation`, and `traceId`. Error text is for humans; the structured fields are what the runner, dashboard, and PR check use.

### 8.8 Precedence and governance

Precedence, strongest first:

```text
platform safety > organization policy > project policy > user preference > package default
```

Rules:

- A lower layer may be **stricter** than a higher one; it may never weaken a higher-layer gate.
- Only `admin`/`operator` can apply an enforcing lifecycle to a project or organization. A package can propose; it cannot activate itself.
- The agent may draft a lifecycle extension, but it cannot approve it, install it, or edit a protected stage.
- Community lifecycle packs default to `suggest`/`shadow`; `verified` packs may run read-only gates automatically, but any state-changing gate still follows the capability discretion policy.
- A lifecycle change is a reviewed diff: stages, agents, permissions, budgets, and expected cost. Applying it is an audited mutation.
- Removing or weakening a gate requires the same role that installed it, plus an explicit reason. The audit keeps the previous definition.
- A lifecycle definition cannot execute shell, read ambient secrets, or call an undeclared network host. Its agents run under the capability permission model.

### 8.9 User experience: deep, but not graph engineering

Most users should never draw a graph. The product should offer three levels:

1. **Presets** — `solo`, `team`, `regulated`, `fast`, `security-first`. One click; inspectable, not hidden.
2. **Bindings** — “use my reviewer for review”, “add a security gate after planning” from a list of installed agents.
3. **Full graph** — Lifecycle Studio for power users, with drag/drop, typed slots, validation, diff, and simulation.

CLI:

```bash
nuvira lifecycle list
nuvira lifecycle show coding/v1
nuvira lifecycle init --preset regulated
nuvira lifecycle add-agent --at after:plan --agent acme/security-architect --mode gate
nuvira lifecycle validate ./lifecycle.json
nuvira lifecycle simulate --goal "add OAuth login" --shadow 5
nuvira lifecycle apply ./lifecycle.json --scope project
nuvira lifecycle rollback --to <definition-id>
```

Dashboard **Lifecycle Studio**:

- graph of protected stages and slots;
- installed agents filtered by slot compatibility and trust;
- permission/cost/time preview before apply;
- shadow-run results and “would have blocked” evidence;
- diff between current and proposed lifecycle;
- rollback and audit history.

A lifecycle pack can ship in a capability package as `lifecycle.json`; the marketplace can list it as a “methodology pack,” not just another tool.

### 8.10 What this unlocks — and what it does not

It unlocks real depth:

- **Domain lifecycles**: security review, accessibility, data migration, compliance evidence, documentation, release readiness, incident response.
- **Team standards as executable policy**: “no implementation without a threat model,” “no merge without a rollback plan,” “every API change gets a contract test.”
- **Measurable composition**: A/B a lifecycle variant, compare gate catch rate, review time, cost per accepted change, and escaped defects.
- **Marketplace depth**: lifecycle packs are more valuable and stickier than single skills because they encode a team's whole method.
- **Agent specialization**: a reviewer can stay read-only; an implementer can be swapped; a security agent can be a gate without becoming a general-purpose agent.

It does not mean:

- every user edits a graph;
- an agent can insert itself;
- a package can remove the baseline test/review/verify stages;
- lifecycle extensions replace workflows. A workflow is a reusable sequence for a goal; a lifecycle extension is a cross-cutting rule about *how every run is governed*.
- hooks become agents. Hooks remain the cheap, native, no-code safety layer. Lifecycle extensions are versioned, sandboxed capabilities with typed artifacts.

**Assessment:** yes, this materially enhances future capability. It turns Agent-Nuvira from “a pipeline with plugins” into a **programmable delivery methodology** — the strongest differentiator in the market scan in §20. The condition is discipline: typed artifacts, protected stages, explicit failure modes, simulation, and evidence. Without those, it becomes a slower, costlier prompt chain.

---

## 9. Triggers and messaging points

### 9.1 One trigger registry

A trigger is a typed binding:

```jsonc
{
  "id": "slack-release",
  "capability": "acme/release-audit",
  "source": "message",
  "filter": {
    "platform": "slack",
    "channel": "C_RELEASES",
    "mention": true
  },
  "input": {
    "repo": "{{message.text}}"
  },
  "auth": "platform-verified-sender",
  "dedupe": "messageId",
  "rateLimit": { "perMinute": 6 },
  "reply": "origin"
}
```

### 9.2 Trigger sources

| Source | Use | Reuses |
|---|---|---|
| `chat` | User asks in the dashboard/CLI chat | Existing chat loop |
| `cli` | Explicit command | `nuvira capability run` |
| `http` | Signed webhook from GitHub, Stripe, CI, etc. | New ingress in gateway/server |
| `schedule` | Cron-style recurring run | `gateway/cron.ts` |
| `message` | Telegram/Slack/Discord/WhatsApp/etc. | Gateway adapters and policies |
| `event` | Agent lifecycle or system event | `observability/event-bus.ts` |
| `agent` | Model requests a capability during a turn | New capability tool |
| `manual` | Dashboard button or API call | Dashboard/API |

### 9.3 Message routing without prompt roulette

Today an inbound message goes through NLU and the full pipeline. For capability triggers, add a deterministic pre-router:

1. Match platform, channel, sender, mention, and an optional command prefix.
2. Validate the input against the capability's schema.
3. Check sender policy and capability policy.
4. Start the run with a correlation ID.
5. Reply in the origin channel with progress and result.

Only if no trigger matches should the message fall through to the general agent pipeline. This gives users "specific inputs" without making every channel message a capability invocation.

### 9.4 Trigger safety

- **Authentication:** HMAC for HTTP, platform signature verification for Slack/WhatsApp, verified-sender policy for messaging.
- **Idempotency:** dedupe on provider message ID, webhook delivery ID, or idempotency key.
- **Replay protection:** timestamp window + nonce.
- **Rate limits and concurrency:** per trigger, per capability, per user.
- **Input validation:** schema validation before the run starts; reject unknown fields by default.
- **No prompt injection escalation:** message text is data. It cannot change permissions, install packages, or select a different capability.
- **Dead-letter queue:** failed triggers are visible and replayable, not silently dropped.

### 9.5 Cron and lifecycle

`gateway/cron.ts` currently schedules a tool. The capability layer should add a job type that schedules a capability or workflow with typed args. Existing tool jobs remain valid.

Event triggers should default to `suggest` or `ask`, never `auto`, because an event is not a user request. A workflow that reacts to `pipeline-completed` must not silently start spending money.

---

## 10. Consumption surfaces

The same capability must be reachable from every surface without reimplementation.

### 10.1 Chat agent

New tools:

- `capability_search` — query the unified index, return ranked candidates with trust and permissions.
- `capability_inspect` — show the manifest, inputs, permissions, triggers, and recent runs.
- `capability_run` — invoke a capability with typed args; policy-gated.
- `workflow_run` — run a workflow by ID; convenience over `capability_run`.
- `capability_manage` — create a draft, validate, preview, or request install. Never installs without approval.

The system prompt should not carry the full catalog. Use retrieval and a small, trust-filtered hint, matching the existing skill-hint approach.

### 10.2 CLI

```bash
nuvira capability search "release audit"
nuvira capability inspect acme/release-audit
nuvira capability install acme/release-audit
nuvira capability enable acme/release-audit
nuvira capability run acme/release-audit --input '{"repo":"."}'
nuvira capability runs --capability acme/release-audit
nuvira capability validate ./acme-release-audit
nuvira capability pack ./acme-release-audit
nuvira capability publish ./acme-release-audit
nuvira workflow run acme/release-audit "audit this release"
```

Backward compatibility: existing `workflow list/run/search/install/publish` keep working.

### 10.3 Dashboard

A **Capability Hub** with:

- browse/search/filter by kind, trust, publisher, and permission;
- detail page: manifest, permissions, triggers, versions, runs, quality score;
- draft review: diff, test results, permission changes;
- install/enable/disable/uninstall;
- run console with live events and artifacts;
- trigger management: webhook URLs, schedules, channel bindings;
- audit log: who installed, enabled, ran, or changed what.

### 10.4 Gateway

- Message triggers route to capabilities before the general pipeline.
- Progress and final results reply to the origin channel.
- Existing allow-lists, silent-drop policy, mention requirements, and signature verification remain in force.
- A capability cannot widen the gateway's sender policy.

### 10.5 SDK / embedding

Add a capability-facing SDK:

```ts
import { defineCapability, defineWorkflow, defineAgent } from '@agent-nuvira/sdk';
```

For host applications, expose a stable `CapabilityClient`:

```ts
const client = createCapabilityClient({ baseUrl, token });
await client.run('acme/release-audit', { repo: '.' });
```

This is the "consume the same functionality in my own app" path. It should be an HTTP/JSON API with typed schemas, not a request to import Nuvira internals.

---

## 11. Management, onboarding, and durable data

A capability ecosystem fails in ordinary ways long before it fails in an interesting way: the user cannot find what is installed, an update overwrites their edits, a dashboard button writes a different file than the CLI, or a reinstall deletes the only copy of a workflow they spent a week writing. This section treats those as first-class architecture.

### 11.1 One control plane, two primary surfaces, many clients

The CLI and the dashboard must not be two implementations of management. They are two **clients of one control service**.

```
             ┌────────────────────────────────────────────┐
             │            CONTROL PLANE                   │
             │  validate → authorize → lock → change →    │
             │  audit → return typed result               │
             └───────────────┬────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
     CLI client         Dashboard/API        Agent tools
     (headless)         (local server)       (capability_*)
```

Rules:

- Every mutation has one implementation in the control service. The CLI is a thin adapter; the dashboard is a thin HTTP adapter; the agent tools are a policy-gated adapter.
- The dashboard never writes package state, trust state, `nuviraconfig.json`, `.env`, or registry files directly. It calls the same operations as the CLI.
- Every command declares its preconditions: required role, expected version, lock, approval, and confirmation. A stale version fails; it does not overwrite silently.
- Every mutation emits an audit event with actor, surface, capability, version, before/after, and correlation ID.
- Reads come from a projection of the store (the index), never from a directory walk on every request.
- The local dashboard binds to localhost by default. Remote access requires explicit TLS/auth configuration; it is not a side effect of starting the server.
- CLI output supports `--json` with stable field names and exit codes for automation. Human output is a rendering of the same result.

Minimum operation set:

| Operation | CLI | Dashboard | Agent |
|---|---|---|---|
| Search / inspect | `capability search`, `inspect` | Discover, detail | `capability_search`, `capability_inspect` |
| Install / approve | `install`, `approve` | Review sheet | `capability_manage` (request only) |
| Enable / disable | `enable`, `disable` | Toggle + reason | Never direct |
| Run / cancel | `run`, `cancel` | Run console | `capability_run` |
| Update / rollback | `update`, `rollback` | Updates page | Never direct |
| Triggers | `trigger` group | Trigger editor | Never direct |
| Trust / keys | `trust`, `key` | Trust settings | Never direct |
| Export / backup | `export`, `backup` | Data & backup | Never direct |
| Diagnose | `doctor` | Health panel | `capability_inspect` |

“Never direct” means the agent may request the operation through the approval system; it may not perform it because a model message said so.

### 11.2 CLI management surface

The CLI is the scriptable, headless, CI-friendly surface. Proposed commands:

```bash
# Discover and inspect
nuvira capability list [--installed] [--available] [--json]
nuvira capability search "release audit" --kind workflow
nuvira capability inspect acme/release-audit --version 1.2.0 --json

# Lifecycle
nuvira capability install acme/release-audit
nuvira capability approve acme/release-audit --scope digest:sha256:...
nuvira capability enable acme/release-audit
nuvira capability disable acme/release-audit --reason "cost"
nuvira capability update acme/release-audit [--to 1.3.0]
nuvira capability rollback acme/release-audit --to 1.2.0
nuvira capability uninstall acme/release-audit [--purge] [--keep-data]

# Run and observe
nuvira capability run acme/release-audit --input '{"repo":"."}'
nuvira capability runs --capability acme/release-audit --json
nuvira capability logs <run-id> --follow
nuvira capability cancel <run-id>

# Author and publish
nuvira capability init ./acme-release-audit --template workflow-agent
nuvira capability validate ./acme-release-audit
nuvira capability test ./acme-release-audit
nuvira capability eval ./acme-release-audit
nuvira capability pack ./acme-release-audit
nuvira capability publish ./acme-release-audit --registry public

# Trust, registry, data
nuvira capability registry add private https://git.example.com/capabilities.git
nuvira capability key generate --publisher acme
nuvira capability trust list
nuvira backup create --output ~/nuvira-backups/2026-11-10.tar.zst
nuvira backup restore ~/nuvira-backups/2026-11-10.tar.zst --dry-run
nuvira capability doctor --json
```

Rules:

- `--json` is available on every read and every result-bearing mutation.
- Exit codes distinguish “not found”, “needs approval”, “permission denied”, “incompatible”, “failed”, and “cancelled”. A shell script must not parse prose.
- `--yes` is allowed only for non-destructive, non-permission-expanding actions. It never approves a new permission scope.
- `uninstall` disables and removes the installed artifact from the index; `--purge` is a separate, explicit operation with a typed confirmation and an automatic export recommendation.
- `capability doctor` reports Docker, git, data-root permissions, disk, registry reachability, schema version, and missing channel configuration.

### 11.3 Dashboard: Capability Hub and Agent HQ

The dashboard gets two new destinations, not one overloaded page:

- **Capability Hub** — discover, inspect, install, approve, enable, update, rollback, uninstall, author, publish, and manage triggers.
- **Agent HQ** — work-item queue, coding sessions, diffs, checks, PR links, review rounds, steering, and merge gates.

The existing `/capabilities` page stays the **machine-readiness** view. It answers “will `deploy` work on this machine?” It should link to the Hub, not be repurposed into a package manager.

Capability Hub pages:

| Page | What it must do |
|---|---|
| **Home** | Installed count, updates available, failed runs, quarantined packages, Docker/doctor status |
| **Discover** | Search/filter by kind, trust, publisher, permission, cost, compatibility |
| **Detail** | Manifest, permissions, versions, changelog, triggers, runs, quality evidence |
| **Review** | Permission diff, test/eval results, signature, publisher, “what can it reach?” |
| **Authoring Studio** | Scaffold, edit manifest, run locally, test/eval, preview package, export |
| **Triggers** | Webhook URL, schedule, channel binding, sender policy, dedupe, test fire |
| **Runs** | Live events, step timeline, logs, artifacts, cost, replay/cancel |
| **Publisher** | Namespace, signing key, listings, versions, yanks, review status |
| **Data & Backup** | Data root, disk usage, retention, export, restore, purge |
| **Settings** | Trust policy, registry sources, update channel, roles, audit |

Interaction rules:

- Permission-changing actions show a diff and require a deliberate confirmation. “Install” never implies “enable”.
- Every long action is cancellable and resumable; closing the tab does not cancel a run.
- Empty, error, offline, and “Docker missing” states are designed, not left as a spinner.
- Secrets are write-only in the UI: the dashboard may say “configured”, never reveal the value.
- RBAC is enforced by the server. Hiding a button is a convenience, not a security boundary.

### 11.4 Onboarding

Onboarding is not a one-time modal. It is a resumable state machine with a separate path for each persona.

| Persona | First successful outcome |
|---|---|
| **Operator** | Agent-Nuvira is healthy, a data root is chosen, at least one channel is connected, and a starter capability runs |
| **Capability author** | A package is scaffolded, validated, tested, and run locally |
| **Consumer** | A capability is found, permissions are understood, and it is installed and run |
| **Publisher** | A public listing is signed, scanned, reviewed, and installable by another user |
| **Agent (self-extension)** | A draft is authored, previewed, approved, and installed without the model granting itself permission |
| **Coding-agent user** | A repository is connected, a work item is assigned, and a session opens a reviewable PR |

#### First-run operator flow

1. **Welcome and scope** — what will be installed, where data will live, and what Docker is used for.
2. **System check** — Node, npm, git, Docker daemon, disk, network, OS package manager, existing data root.
3. **Data root** — default `~/.nuvira`; show the resolved path; allow a custom root; verify write/read/rename; refuse a path inside the install root, `node_modules`, or a project repository unless explicitly overridden with a warning.
4. **Trust policy** — default `ask`; choose allowed publishers; choose whether community packages may be auto-suggested; choose secret storage (OS keychain preferred, env file fallback).
5. **Workspace and repo** — choose authoring workspace, allowed repositories, branch policy, and whether sessions may open PRs.
6. **Channels** — show all gateway adapters, connect only the ones the user chooses, send a test message, and explicitly opt in each channel to capability triggers.
7. **Starter capability** — install one official read-only capability, inspect its permissions, run it, and show the result/artifact. This proves the loop before asking for broad access.
8. **First coding session (optional)** — assign a small issue or a local task, watch the session, review the diff, and open a PR.
9. **Backup** — offer an initial export; record the data-root path and schema version.

Each step writes progress to `state/onboarding.json`; it can be resumed from CLI or dashboard, and repeating a completed step is idempotent.

#### Author onboarding

`capability init` creates a package with a manifest, typed input/output schema, one workflow, one test, one eval case, a README, and a permissions file. The first `capability test` must run without a provider key. The first `capability run` happens in the same sandbox production will use.

#### Publisher onboarding

Publisher identity → namespace claim → signing key → package metadata → automated scan → test/eval evidence → review queue → public listing. A publisher cannot mark their own package `verified`; that tier is assigned by the review process.

#### Agent onboarding

The agent does not get a separate “install anything” path. It gets `capability_manage`, which can create a draft and request installation. The human sees the same review sheet as any other install. The model’s text cannot grant a permission, change trust, or approve its own draft.

### 11.5 Lifecycle states and approvals

```text
draft → validated → approved → installed → enabled → active
                                              │
                         disabled ←───────────┘
                             │
                         update-available → approved(new scope) → enabled
                             │
                         quarantined / revoked / yanked → disabled
```

Rules:

- **Install ≠ enable.** Installation stages content and records provenance; enablement makes it selectable and activates triggers.
- **Approval is scope-bound.** The approval records the manifest digest and permission set. A new digest, publisher, or permission set requires a new approval.
- **Permission expansion is never silent.** `update` shows the diff and returns to `approved` for the new scope.
- **Disable stops triggers.** A disabled capability cannot be invoked by chat, schedule, webhook, message, or event, even if a stale trigger still exists.
- **Revocation is immediate.** A revoked or yanked version is disabled locally on the next sync and cannot be installed fresh.
- **Uninstall removes index entries, trigger bindings, and runtime registration.** It does not delete the authoring workspace or run history unless `--purge` is explicit.
- **Audit is append-only.** Every state transition records actor, surface, reason, and correlation ID.

### 11.6 Where developed data lives

There are five distinct roots. Confusing them is how updates delete work.

| Root | Default | Replaced by app update? | Contains |
|---|---|---|---|
| **Install root** | npm global prefix / app bundle | **Yes** | Agent-Nuvira code, bundled dashboard, built-in assets |
| **Data root** | `~/.nuvira` (`NUVIRA_CONFIG_DIR` override) | **No** | Config, packages, trust, state, runs, sessions, logs, backups |
| **Authoring workspace** | user-chosen, e.g. `~/Nuvira/capabilities/<id>` | **No** | Editable source, tests, evals, docs, local fixtures |
| **Project root** | the user's repository | **No** | Their code; optional project-local config/skills |
| **Artifact/cache root** | `~/.nuvira/artifacts`, `runs`, `coding-sessions`, `worktrees` | **No** (but retention may prune) | Generated outputs, checkpoints, patches, logs |

Proposed durable layout inside the data root:

```text
~/.nuvira/
  nuviraconfig.json          # or legacy buffconfig.json
  .env                       # fallback secret store, mode 0600
  capabilities/
    store/sha256/<digest>/   # immutable package content, content-addressed
    installed/<publisher>/<name>/<version>.json
    current/<publisher>/<name>   # atomic pointer to the enabled version
    lock.json                # resolved versions + digests
    authoring.json           # index of authoring workspaces, not the source itself
  trust/
    publishers.json
    keys/
    revocations.json
  registry/
    cache/index.json
  state/
    capabilities.json        # lifecycle, approvals, runs index (atomic JSON store)
    events.jsonl             # append-only audit events
    onboarding.json
    schema.json              # data schema version
  runs/<run-id>/
    run.json
    events.jsonl
    artifacts/
  coding-sessions/<session-id>/
    session.json
    events.jsonl
    plan.json
    patches/
    checks/
    pr.json
  artifacts/
  worktrees/                 # existing ephemeral isolation root
  logs/
  backups/
  exports/
```

Compatibility, not relocation:

- Existing `~/.nuvira/agents/`, `skills/`, `workflows/`, `plugins/`, `provenance/`, `mcp/`, and `gateway/` stay where they are for v1. The capability store indexes them through adapters rather than moving them and breaking existing installs.
- `<project>/.agents/skills/` remains the project skill location. A future package may opt into `<project>/.agents/capabilities/`, but it is not required and does not become an implicit trust grant.
- `NUVIRA_HOME` should be formalized as the stable data-root name, with `NUVIRA_CONFIG_DIR`/`BUFF_CONFIG_DIR` kept as aliases. Every new capability path must resolve through one helper; hard-coded `join(homedir(), '.nuvira', ...)` is a bug.
- The existing atomic JSON-store convention is the default for `capabilities.json`/`schema.json`; SQLite is only introduced if measured scale requires it, not as an unplanned dependency.
- Secrets prefer the OS keychain (the existing optional keyring dependency) and fall back to `~/.nuvira/.env` with mode `0600`. Secrets never enter package content, logs, exports, or git.
- Data root is mode `0700`; package metadata `0600` where it contains credentials or tokens. Symlinks and path traversal are rejected at install time.

Why authoring source is separate: uninstall, update, and package GC must be free to remove **installed artifacts** without ever touching the editable project the user is still working on. The package store is immutable; the authoring workspace is the source of truth.

### 11.7 Update and deletion safety contract

These are guarantees, not intentions. Each needs a test.

1. **App update replaces only the install root.** `npm install -g agent-nuvira` or a future self-update never deletes or rewrites the data root.
2. **Capability update never mutates the running version.** It downloads to a staging digest, verifies signature/checksum, scans, migrates, then atomically flips the `current` pointer. The old version remains for rollback.
3. **No install hook runs on the host.** Package lifecycle hooks are declarative or sandboxed, as in §6.4. `npm install` is not a package lifecycle mechanism.
4. **Schema migrations are versioned and reversible.** Before migration: backup, lock, dry-run. On failure: restore the previous schema and pointer. Never leave a half-migrated data root.
5. **Uninstall preserves by default.** `capability uninstall` removes index entries and runtime registration; it does not delete authoring source or run history. `--purge` is explicit, typed, and preceded by an export offer.
6. **`skills update` must stop overwriting in place.** Write the new version beside the old one, verify the checksum, swap the pointer, and retain the previous version for rollback. This is the existing command most likely to destroy local edits today.
7. **`doctor --fix` never deletes user data.** It may repair permissions, recreate missing directories, or reinstall a tool; destructive repair is a separate command with confirmation.
8. **Auto-update is opt-in and channel-based.** Default is “notify”; stable/beta channels and version pins are supported. Major versions and permission expansions never auto-apply.
9. **Interrupted updates leave the old version active.** Staging is crash-safe: write, fsync, rename, then flip. A killed process must not leave a half-written current package.
10. **Backups are first-class.** `backup create` captures packages, lockfile, trust, state, config, run/session metadata, and (optionally encrypted) secrets. `restore --dry-run` is the default; restore is explicit.

Update sequence:

```text
check compatibility → resolve version → download → verify signature/checksum
→ scan → stage → permission diff → approval if changed → migrate dry-run
→ backup → acquire lock → flip pointer → health check → audit
→ on failure: restore old pointer + schema → report exactly what failed
```

App update sequence:

```text
npm/global install new app → new process starts → doctor runs
→ data schema check → backup if migration needed → migrate → health check
→ rollback path: reinstall the previous pinned version and restore its schema
```

### 11.8 Docker is a hard prerequisite

Docker is required for community/public capability code and for the strongest isolation class. The requirement is not “Docker is nice to have”; it is part of the product contract.

Detection:

- `docker --version` and `docker info` (binary alone is not enough; the daemon must answer).
- Check architecture, disk, and whether the user can run containers without an interactive prompt.
- `capability doctor --json` reports the exact failure and the remediation command.

Installation:

- If Docker is missing, setup **offers to install it**. The agent may run the platform installer, but only after explicit approval and with the exact command shown. This is a system-level mutation, not a package install.
- macOS/Windows: Docker Desktop (license acceptance is the user's decision) or a supported alternative.
- Linux: the distro's Docker packages or Docker's official repository, with `sudo` shown and approved.
- After installation: verify `docker info`, run a trivial container, then resume onboarding. Do not claim success from an installer exit code alone.
- **Never silently install Docker. Never fall back to host execution for untrusted code.** If the container runtime is unavailable, the capability is blocked with a clear remediation, not degraded into an unsafe run.
- Rootless Docker and Podman-compatible runtimes are acceptable if they pass the same isolation checks. A remote runner is a later option, not a day-one dependency.

CI/headless environments use `capability doctor --json` and fail closed when Docker is unavailable.

### 11.9 All gateway channels

“All channels” means every configured gateway adapter is supported and testable at launch, not that every channel is enabled by default.

- The gateway currently exposes 22 platforms, including Telegram, Discord, Slack, WhatsApp (bridge and Business API), email, Signal, SMS, IRC, SimpleX, Matrix, Mattermost, DingTalk, Feishu, WeCom, Teams, Google Chat, Weixin, ntfy, BlueBubbles, generic webhook, and Home Assistant.
- Some adapters are **send-only** (webhook/REST push). They can receive results and notifications, but cannot originate an inbound capability trigger. “All channels” does not silently turn a send-only adapter into an inbound transport; the channel matrix marks that capability explicitly.
- Each capability trigger is **opt-in per channel**. Connecting a channel does not grant every capability permission to speak there.
- Onboarding shows a channel matrix: adapter, credential state, inbound/outbound capability, sender policy, mention requirement, attachment support, rate limit, and test result.
- A capability cannot widen the gateway's sender allow-list, signature verification, silent-drop policy, or mention requirement. Those remain gateway policy.
- Progress and final output use the channel's supported formatting; unsupported rich content falls back to text plus an artifact link.
- Dedupe uses the provider's message ID; replies use the origin channel; failures go to a visible dead-letter queue.
- Channel-specific limitations (WhatsApp session pairing, Slack Socket Mode, Discord gateway, email polling) are surfaced during onboarding, not discovered on first trigger.

### 11.10 Public marketplace from day one

The marketplace is public at launch: anyone can browse, inspect, and install. Publishing is public too, but no package becomes trusted merely because it was uploaded.

Launch gates, all blocking:

| Gate | Requirement |
|---|---|
| **Identity** | Publisher account, namespace ownership, signing key |
| **Package integrity** | Manifest schema, checksum, signature, immutable version |
| **Security** | Malware/dependency scan, permission review, secret scanning |
| **Behavior** | Tests + eval fixtures run in the production sandbox |
| **Moderation** | Report, quarantine, takedown, revocation, yank |
| **Transparency** | Changelog, permissions, data access, cost disclosure |
| **Legal** | Terms, privacy, acceptable-use, license metadata, DMCA/takedown path |
| **Abuse** | Rate limits, spam controls, namespace squatting policy, publisher suspension |

New public packages enter `community` **quarantine** until automated checks pass. `verified` requires human review of permissions and evidence. `official` is reserved for the core team. A publisher cannot self-assign `verified`.

Payments and paid listings are out of scope for v1 unless separately decided; the marketplace can launch with free packages and a clear “no payment” state.

---

## 12. Copilot-class coding orchestration

This section adds the orchestration model popularized by GitHub Copilot's cloud agent — assign a work item, let a durable session plan and implement it in isolation, open a pull request, respond to review, and merge only through a human gate — **in addition to** the capability ecosystem. It does not replace the existing orchestrator; it wraps it in a product-level session.

### 12.1 The model, not the vendor

“Copilot-class” here means the orchestration contract, not a clone of GitHub's UI:

```text
work item → durable session → plan → isolated workspace → implement
→ run checks → self-review → open PR → human review → changes
→ re-run checks → approve → merge
```

The defining properties are: asynchronous, resumable, observable, repo-aware, tool-using, reviewable, and policy-bound. A chat turn that edits files is not the same thing.

### 12.2 Parity matrix

| Capability | Copilot-class behavior | Nuvira today | Target |
|---|---|---|---|
| Work-item intake | Issue, PR comment, chat, CLI | Chat/CLI pipeline | Issue/PR/chat/CLI/webhook/schedule |
| Async queue | Sessions run while the user is away | No queue | Durable queue + claim/lease |
| Isolated workspace | Managed environment per session | Local git worktree | Worktree + container worker |
| Repo context | Repo-aware planning | File tree + memory | Indexed context + explicit attachments |
| Plan/todo | Visible plan and progress | Planner + checkpoints | Durable plan with step states |
| Tools/tests | Edits, terminal, tests | Yes, local | Same, sandboxed and audited |
| Custom agents | Scoped profiles, sub-agents | In-process JS plugins | Scoped profiles + package agents |
| Parallel work | Multiple sessions/sub-agents | Subagent spawner | Fleet with worktree isolation |
| Steering | Mid-session input | Safe-point steering | Steer at checkpoints, resume |
| PR creation | Opens/updates PR | Gated git push; no full PR loop | PR create/update with evidence |
| Review loop | Responds to comments and checks | PR review agent only | Review rounds + re-run checks |
| Merge | Human approval, agent merge opt-in | No merge gate | Protected branch + required checks |
| Audit/cost | Session history and usage | Event bus + cost tracking | Session-scoped audit and budget |
| Enterprise control | Org/repo policies | RBAC + audit | Repo allow-list, roles, policy |

### 12.3 Core objects

```text
WorkItem        issue, PR comment, chat request, CLI task, webhook, schedule
CodingSession   durable orchestration of one WorkItem
Assignment      which agent profile, capability set, repo, branch, budget
Plan            ordered steps with dependencies and acceptance evidence
Check           test, lint, typecheck, build, security scan, eval
ReviewRound     human/agent comments, requested changes, resolution
PullRequest     branch, title/body, checks, review state, mergeability
Artifact        patch, log, report, screenshot, test output, benchmark
```

Sketch of the durable session record (design only):

```jsonc
{
  "schemaVersion": 1,
  "id": "ses_01J...",
  "workItem": { "source": "github", "repo": "acme/app", "number": 42 },
  "agent": { "profile": "implementer", "capabilities": ["acme/release-audit@1.2.0"] },
  "repo": { "baseBranch": "main", "branch": "nuvira/issue-42", "worktree": "..." },
  "state": "verifying",
  "plan": { "steps": [] },
  "checks": [],
  "review": { "rounds": [] },
  "pullRequest": null,
  "budget": { "maxUsd": 10, "usedUsd": 3.42 },
  "createdAt": "2026-11-10T...",
  "updatedAt": "2026-11-10T..."
}
```

### 12.4 Session state machine

```text
queued → provisioning → planning → working → verifying → review_ready
   │                                                        │
   │                                  ┌─────────────────────┘
   ▼                                  ▼
blocked / failed / cancelled      in_review → changes_requested
                                      │              │
                                      │              └──→ working
                                      ▼
                                   approved → merging → merged
```

Rules:

- `queued` is durable. A restart resumes from the last checkpoint; it does not lose the assignment.
- `provisioning` creates the branch/worktree/container and records the base commit. If isolation fails, the session stops; it does not run in the user's tree.
- `working` may use tools, but every state-changing tool is policy-gated.
- `verifying` must record actual command output, exit codes, and artifacts. “Looks good” is not a check.
- `review_ready` means a PR can be opened with evidence. It does not mean merged.
- `changes_requested` returns to `working` with the review comments as explicit input.
- `approved` requires the configured human approval and all required checks.
- `merged` is terminal and records the merge commit. A failed merge returns to `in_review`, not “success”.

### 12.5 Isolation and execution

- Each session gets its own git worktree and branch. Parallel sessions never share a working tree.
- Untrusted/community code and dependency installation run in a container. The worktree is mounted at an explicit path; the host filesystem is not exposed wholesale.
- The base commit is recorded, and the diff is always measured against it. Uncommitted changes in the source tree are reported and are not silently included.
- `node_modules` is linked for speed only when safe; a container session installs from the lockfile instead.
- Network access is deny-by-default, with an explicit allow-list per session (registry, package host, API).
- Secrets are injected per session from the secret broker, scoped to the repositories and hosts the session is allowed to touch. They are never written into the worktree, PR body, or logs.
- A session has CPU, memory, disk, wall-clock, and model-spend limits. Exceeding a limit pauses or fails the session with a reason.

### 12.6 Custom agents and multi-agent orchestration

A custom agent is a reusable role, not a new trust domain.

- **Profile:** Markdown + YAML frontmatter for name, description, model preference, tool allow-list, MCP servers, and instructions; optional TypeScript for code-backed hooks.
- **Scope:** each profile declares tools, filesystem scope, network, secrets, and whether it may spawn sub-agents. A reviewer can be read-only; an implementer can edit; a deployer is a separate, more restricted profile.
- **Delegation:** the main orchestrator can delegate to a sub-agent in a separate context. Sub-agents return structured results, not raw transcripts that pollute the parent.
- **Parallelism:** a fleet of independent work items may run concurrently, each in its own worktree/container. Two agents never write to the same branch.
- **Loop prevention:** delegation depth, total sub-agents, token budget, and wall-clock are capped. A sub-agent cannot recursively spawn without an explicit grant.
- **Discovery:** package `agents/` is the canonical source; `~/.nuvira/agents/` remains a legacy compatibility path. Project-level profiles are opt-in and cannot grant tools merely by existing in a repository.
- **Selection:** the user can choose a profile; the orchestrator can suggest one. The model cannot silently switch to a more privileged profile.

This is also the bridge to the capability ecosystem: an agent profile can be packaged, versioned, reviewed, and installed like any other capability, and a workflow can invoke it as a step.

### 12.7 Review, PR, and merge

- A session opens a PR only after it has a plan, a diff, and recorded checks. The PR body contains: what changed, why, tests run with results, artifacts, risks, permission changes, and the session ID.
- A failing check may still produce a draft PR, but the body must say it failed and why. It must not claim success.
- `@nuvira` (or the configured handle) can be mentioned on a PR to request changes. That creates a new review round in the same session, not a new unconnected chat.
- The review loop re-runs affected checks after changes and links each comment to its resolution.
- Protected branches require: human approval, required checks green, no unresolved review threads, and a branch that is up to date with the base.
- **No self-merge by default.** “Agent merge” is an explicit per-repository opt-in, limited to non-protected branches or a policy that names the allowed merge method. Deploy is never part of merge.
- A merge conflict returns the session to `working`; it never force-pushes over someone else's branch.
- Every PR records the agent profile, capability versions, model/provider, cost, and session ID for audit.

### 12.8 Session data and update safety

Sessions are durable data, not app state:

```text
~/.nuvira/coding-sessions/<session-id>/
  session.json       # canonical state
  events.jsonl       # append-only timeline
  plan.json          # latest plan + step states
  patches/           # diffs by step
  checks/            # command, exit code, output, artifacts
  review/            # rounds, comments, resolutions
  pr.json            # PR number/url/state
  artifacts/         # reports, screenshots, logs
```

- App updates never touch this directory. Schema migrations are versioned and backed up.
- The source repository remains canonical; the worktree is disposable; the PR is durable in the git host.
- `session export` produces a portable bundle for support or audit. Secrets and raw credentials are excluded.
- Windows path length, case-insensitive collisions, and permission semantics are tested explicitly; the data root is not assumed to be POSIX.
- Retention is configurable. The final summary, PR link, cost, and audit record outlive verbose logs.
- Deleting a session requires an explicit command; uninstalling a capability does not delete sessions that used it.

### 12.9 Relationship to capabilities

The two layers answer different questions:

| Layer | Question | Unit |
|---|---|---|
| **Capability ecosystem** | “What can Agent-Nuvira do, and who authored it?” | Versioned package |
| **Coding orchestration** | “What work is being done now, by which agent, in which repo, with what evidence?” | Durable session |

They compose:

- a capability can be a step, tool, reviewer, or trigger handler inside a session;
- a session can invoke a workflow capability and attach its artifacts to the PR;
- an agent profile can be published as a capability package;
- a trigger can create a session (for example, a new issue with a label);
- the public marketplace distributes capabilities and agent profiles, never sessions, credentials, or repository data;
- the agent's “offering” is the union: indexed capabilities + orchestration + policy + run history.

### 12.10 Surfaces and onboarding

CLI:

```bash
nuvira session assign --repo acme/app --issue 42 --agent implementer
nuvira session list --state review_ready
nuvira session show ses_01J...
nuvira session steer ses_01J... "Use the existing retry helper; do not add a dependency"
nuvira session checks ses_01J...
nuvira session open-pr ses_01J...
nuvira session review ses_01J... --request-changes "Add a regression test"
nuvira session cancel ses_01J...
```

Dashboard **Agent HQ**: queue, active sessions, step timeline, live logs, diff viewer, checks, review threads, PR link, cost, steering box, cancel, retry, merge gate.

Other surfaces:

- Chat: “assign this to the implementer agent” creates a draft session and asks for repo/branch confirmation.
- Issue/PR webhook: a labeled issue can create a session if the repo policy allows it.
- Messaging: a channel message can create or steer a session only if the trigger is explicitly configured and the sender passes policy.
- Schedule: a recurring maintenance session is allowed, but it cannot push to a protected branch without the same gate.

Onboarding adds: connect GitHub/GitLab, allow repositories, choose base branch, choose whether PRs may be opened, configure required checks, and choose the human approver/role.

### 12.11 Safety and governance

- **Least privilege:** the session token is scoped to one repository and the minimum permissions; it is not the user's full account token.
- **No direct main:** all changes go through a branch and PR unless the repository policy explicitly allows direct commits to a non-protected branch.
- **No self-merge or self-deploy by default:** a human gate is required for protected branches; deploy is a separate capability with its own approval.
- **Untrusted input:** issue text, PR comments, repository files, and web content are data. They cannot change tool permissions, agent profiles, or repository policy.
- **Prompt-injection containment:** a session cannot read secrets it was not granted, even if a file asks it to.
- **Resource limits:** per-session token/cost/time caps; a runaway loop is stopped and reported.
- **Audit:** every assignment, tool call, check, approval, PR, merge, and cancellation is attributable.
- **Kill switch:** an operator can cancel all sessions for a repository or globally.
- **Marketplace isolation:** installing a public agent profile does not grant repository credentials. The profile must be selected and scoped for a session.

### 12.12 Delivery slice

Copilot-class orchestration is not a single feature. The smallest credible slice is:

1. `CodingSession` + durable queue + event log;
2. worktree isolation + base commit + diff;
3. plan/execute/verify with explicit evidence;
4. PR creation with a structured body;
5. review round + checks re-run;
6. human merge gate (no auto-merge);
7. Agent HQ view + CLI `session` commands.

That slice reuses the existing orchestrator, worktree tool, git tool, event bus, and PR-review agent. It does not require a hosted cloud runner on day one; local Docker + worktrees is the first target. A remote runner can be added behind the same session contract.

---

## 13. Quality and ecosystem model

"Massive" is not a goal by itself. A large ecosystem of low-quality capabilities is a liability. Quality must be a gate.

### 13.1 Package quality bar

A package is eligible for `verified` only if it has:

- a valid manifest;
- a declared input/output schema;
- a permission declaration with no undeclared access;
- tests that run in CI without a provider key;
- at least one eval fixture with expected behavior;
- a README and a changelog;
- a security scan;
- a reproducible build or a pinned artifact digest;
- a compatibility range for Agent-Nuvira versions;
- a rollback path.

### 13.2 Certification tiers

| Tier | Meaning | Who can publish |
|---|---|---|
| `draft` | Local, unlisted, not trusted | Anyone |
| `community` | Published, automated checks passed, not human-reviewed; quarantined until they pass | Anyone with a publisher identity |
| `verified` | Tests + eval + permission review + signature | Verified publisher |
| `official` | Maintained by the Agent-Nuvira project | Core team |

The tier is shown wherever the capability appears. The agent's discretion policy reads it. A public catalog is available on day one; `community` never means trusted.

The public certification tiers remain `community`, `verified`, and `official`. `organization-trusted` is a separate, org-local policy overlay, not a public badge: a verified package can still be untrusted by a given enterprise, and a community package can be explicitly trusted by that enterprise after local review. A useful display order is `official` → `verified` → `organization-trusted` → `community`, but organization trust must always name the organization and must never be presented as a global certification. Evaluate trust as public provenance plus local policy, not one global rank.

### 13.3 Public marketplace launch gates

A public marketplace changes the threat model from "a user installs code they chose" to "anyone can publish content that another user may install." The following are launch-blocking, not post-launch improvements:

- **Quarantine before indexing.** A new public version is not searchable or installable until automated malware/dependency/secret scans pass.
- **Human review for `verified`.** Automated checks can promote to `community`; they cannot promote to `verified`.
- **Immutable versions.** A published version cannot be edited in place. A fix is a new version; a bad version is yanked.
- **Revocation propagation.** A revoked version is disabled on connected installs at the next sync and cannot be installed fresh.
- **Moderation capacity.** Report, takedown, publisher suspension, namespace dispute, and appeal paths exist before launch.
- **Evidence-based ranking.** Search ranking prefers test/eval evidence and maintenance signals over download counts or descriptions.
- **No self-certification.** A publisher cannot assign `verified` or `official`, bypass a scan, or edit another publisher's namespace.
- **Legal surface.** Terms, privacy, acceptable use, license metadata, and a takedown contact are published with the catalog.

### 13.4 Supply chain

- Signed manifests and artifacts (Sigstore or equivalent).
- Checksums in a lockfile.
- No `postinstall` execution.
- Dependency pinning and an SBOM.
- Revocation list for compromised versions.
- `capability update` shows a diff and re-runs permission review.
- Yanks are explicit; a yanked version cannot be installed fresh.

### 13.5 Evaluation harness

Every capability can ship `eval/cases.jsonl`:

```jsonl
{"input":{"repo":"fixtures/clean"},"expect":{"verdict":"pass"}}
{"input":{"repo":"fixtures/critical"},"expect":{"verdict":"block"}}
```

`nuvira capability eval` runs the cases in the same sandbox as production. A regression blocks certification. This is the mechanism that keeps "works on my machine" out of the ecosystem.

### 13.6 Measurement

Track, per capability and per version:

- install success rate;
- first-run success rate;
- invocation success rate;
- p50/p95 duration;
- model and external cost per run;
- human approval/decline rate;
- failure categories;
- security findings;
- uninstall/retention rate.

Do not claim a quality or performance improvement without a before/after measurement.

---

## 14. Delivery plan

This is a multi-phase platform effort. It is not one sprint, and the sequence matters. Because the marketplace is public from day one, the public-launch gates are launch-blocking work, not post-launch polish.

### Phase 0 — Decisions and threat model (1–2 days)

Deliverables:

- confirm the decisions in §15;
- inventory existing capability-like objects and management paths;
- freeze the manifest, workflow IR, session, trigger, and lifecycle stage/slot/artifact schemas;
- define the protected-stage invariants and the lifecycle precedence order;
- define the install-root / data-root / workspace-root contract;
- define the Docker doctor/install/consent contract, including the no-host-fallback rule;
- write the threat model, permission matrix, and update-safety invariants.

Exit: signed-off design, no user-visible change.

### Phase 1 — Unified index, control-plane read model, data-root contract (1 week)

Deliverables:

- extend `Capability` to include `workflow`, `agent`, `trigger`, and `bundle`;
- index built-in and installed workflows, custom agents, lifecycle definitions, and MCP tools consistently;
- add read-only `capability_search` / `capability_inspect`;
- add `nuvira capability list/search/inspect` and the dashboard inventory view;
- introduce the control service's read model and audit stream;
- add `capability doctor` read-only checks for Docker, git, disk, and data-root permissions;
- formalize the data root (`NUVIRA_HOME` alias) and route every new path through it;
- fix the `~/.nuvira/workflows/*.json` discovery/execution mismatch or migrate it explicitly.

Exit: the agent and both management surfaces can see every capability in one place, but cannot yet mutate or run new code.

**Why first:** discovery without execution is safe, useful, and exposes naming/duplication problems before a runtime or a management UI is built.

### Phase 2 — Code workflow runtime (1–2 weeks)

Deliverables:

- workflow IR;
- TypeScript `defineWorkflow` SDK;
- JSON-to-IR adapter for existing templates;
- sandboxed code-step worker;
- durable run records and checkpoints;
- retries, timeouts, cancellation, artifacts;
- `nuvira capability run` and `workflow_run`;
- run view in the dashboard.

Exit: a user can author a code workflow, validate it, run it from CLI/chat, and inspect the run. Untrusted code does not execute in-process.

### Phase 3 — Copilot-class coding orchestration (2–3 weeks)

Deliverables:

- `WorkItem` and `CodingSession` records;
- durable queue, lease, resume, cancel, and event log;
- worktree + container provisioning with base-commit tracking;
- plan → implement → verify with recorded checks and artifacts;
- PR create/update with a structured evidence body;
- review rounds, changes requested, and check re-runs;
- Agent HQ (dashboard) and `nuvira session` CLI;
- protected-branch human merge gate; no self-merge by default.

Exit: a work item can be assigned, run asynchronously, steered, reviewed, and merged through a human gate. The existing orchestrator and worktree tool are reused; a hosted runner is not required for this slice.

### Phase 4 — Management, onboarding, and update safety (1–2 weeks)

Deliverables:

- full control-service operations for install/approve/enable/disable/update/rollback/uninstall;
- Capability Hub management UI and matching CLI;
- first-run operator, author, consumer, publisher, and agent-author onboarding flows;
- immutable package store, lockfile, version pointers, backups, export/import;
- versioned data migrations with dry-run and rollback;
- Docker guided install hardening, including daemon verification and resumable setup;
- uninstall/purge semantics that preserve authoring source.

Exit: a user can manage the entire lifecycle from either surface, survive an app update without losing work, and recover from a failed migration.

### Phase 5 — Composable lifecycle graph (6–8 weeks; 2–3 week thin slice)

> Implementation contract: [`PHASE5_LIFECYCLE_SPEC.md`](./PHASE5_LIFECYCLE_SPEC.md).
> Codebase validation: [`PHASE5_CODEBASE_VALIDATION.md`](./PHASE5_CODEBASE_VALIDATION.md) — **conditional go**. The 2-week figure is a thin-slice target; the enterprise-complete estimate is **6–8 engineer-weeks**, with a **2–3 week** thin vertical slice. The stage seam, worktree enforcement, dedicated lifecycle store, and sandboxed pack runtime are release conditions.

Deliverables:

- lifecycle contract: protected stages, slots, four modes, artifact schemas, failure policy;
- `LifecycleDefinition` → deterministic `LifecycleIR` compiler and resolver;
- stage wrappers in the orchestrator and coding-session runner;
- protected-stage enforcement: no removal, replacement, or bypass of test/review/verify/deliver;
- typed stage events and artifact hashes in the run/session record;
- lifecycle precedence (`platform safety > org > project > user > package`) and audit;
- three first-party presets and three reference packs (security, accessibility, release readiness);
- `nuvira lifecycle` CLI and dashboard Lifecycle Studio;
- shadow mode, cost/time simulation, and rollback;
- tests for gate blocking, transform revalidation, stale-artifact rejection, and lower-layer weakening attempts.

Exit: a user can bind an installed agent to a replaceable stage or insert it after planning, testing, or review; a required gate can block; the same resolved lifecycle runs from CLI and dashboard; no definition can remove a protected stage.

### Phase 6 — All-channel triggers (1–2 weeks)

Deliverables:

- trigger registry and schema;
- HTTP webhook ingress with HMAC;
- schedule adapter over `cron.ts`;
- message adapter over every configured gateway adapter;
- event-bus and agent-request adapters;
- dedupe, idempotency, rate limits, dead-letter;
- correlation IDs, reply routing, and a channel test matrix covering all 22 platforms;
- per-channel opt-in and sender-policy enforcement.

Exit: one capability can be triggered from CLI, schedule, signed webhook, event, and any configured channel, with the same input contract and run history.

### Phase 7 — Public marketplace launch readiness (2–4 weeks, launch-blocking)

Deliverables:

- publisher identity, namespace, signing keys, and public profiles;
- quarantine, malware/dependency/secret scanning, and human permission review;
- public catalog, search ranking, version resolution, and yanks;
- moderation, abuse reporting, takedown, suspension, and revocation propagation;
- legal terms, privacy, acceptable-use, license metadata, and support path;
- load, abuse, and incident-response tests against the public install path.

Exit: all §11.10 and §13.3 gates pass. **No public launch before this exit.**

### Phase 8 — Lifecycle automation and discretion (ongoing)

Deliverables:

- event-triggered capabilities;
- per-capability discretion policy (`suggest`/`ask`/`auto`);
- budget-aware selection;
- cross-surface parity tests;
- capability and session analytics, quality feedback, and retention controls.

Exit: a capability can participate in Nuvira's lifecycle under policy, without gaining arbitrary in-process control.

### Phase 9 — Capability quality and method catalog (proposed, after Phase 8)

Not part of Phase 5. This is a catalog and read-model phase, not a new runtime.

Deliverables:

- capability quality read model from lifecycle run and evidence records: technical completion, human acceptance, gate precision, false-positive/false-negative rate, cost per accepted change, p50/p95 duration, waiver rate;
- minimum sample sizes, confidence intervals, and version-level metrics;
- method-catalog entries as lifecycle-pack metadata (`category: method`); no `MethodPack` runtime primitive and no second install path;
- structured plus lexical capability discovery over manifest metadata, filters, trust, permissions, and compatibility;
- curated SOC 2-oriented, regulated, startup, and agency methods with evidence links and no certification implication.

Exit: operators can compare capability quality and browse methods without changing lifecycle semantics.

### Phase 10 — Semantic discovery and marketplace analytics (proposed, evidence-gated)

Not committed. Requires Phase 9 data and a real-query evaluation.

Deliverables:

- optional semantic retrieval arm after the lexical/structured baseline, with measured precision@k, recall, latency, and cost;
- performance analytics: top packs by precision at comparable recall, best reviewers by accepted findings and false positives, reliable workflows by completion/resume/duplicate-effect rate;
- anti-gaming controls: platform-observed runs only, tenant isolation, no pay-to-rank, published methodology;
- no automatic gate or routing decisions from rankings.

Exit: measured lift and quality thresholds justify the cost.

### Phase 11 — Distributed Agent Grid (proposed, after Phase 5)

Not part of Phase 5. This is a delivery control plane **above** the lifecycle, not a second lifecycle. A distributed work packet is one Phase 5 run on another machine.

Deliverables:

- program planner and contract-bound packet DAG with dependency, path-ownership, and patch-size validation;
- node registry with a structured capability/model/tool/trust descriptor, enrollment, and heartbeat;
- durable broker with leases, fencing tokens, attempts, retry, priority, fairness, and resume;
- distributed worktree execution with a pinned base commit, mandatory isolation, and patch-artifact return (no worker branch writes);
- independent review federation (different node and capability) and a singled-writer merge coordinator with an integration test set;
- artifact exchange by reference with classification ceilings and egress rules;
- scoped capability tokens, signed policy bundles, trust tiers, and a hash-chained program ledger;
- program, fleet, merge-queue, and evidence surfaces with cost attribution.

Scope: 5–30 nodes, one control plane, no HA. 100+ nodes is a later stage with its own specification. Phases 12–15 (departments at scale, autonomous programs, organizational intelligence, inter-organization mesh) remain uncommitted horizons and get no specification here.

Hard prerequisites: the Phase 5 stage seam, worktree-enforced writes, durable run store, and signed artifact envelopes.

Estimate: 10–14 engineer-weeks for Stages 1–4; 4–6 weeks for a thin vertical slice, on top of the 6–8 week Phase 5 prerequisite.

Exit: a 40–80 packet program is planned, executed across 20 nodes, independently reviewed, merged by the coordinator, and delivered with a verifiable evidence bundle — with zero governance-invariant violations and zero false successes.

Documents:

- [`PHASE11_DISTRIBUTED_AGENT_GRID.md`](./PHASE11_DISTRIBUTED_AGENT_GRID.md) — implementation specification;
- [`PHASE11_ADG_STRATEGY.md`](./PHASE11_ADG_STRATEGY.md) — plain-English strategy and scope boundaries;
- [`PHASE11_ADG_REVIEW.md`](./PHASE11_ADG_REVIEW.md) — comparison with the Copilot draft and the conditional-go verdict;
- [`PHASE11_ENTERPRISE_COMPANY_MODEL.md`](./PHASE11_ENTERPRISE_COMPANY_MODEL.md) — eleven department scopes, node pool management and selection, CIO/CTO delivery governance;
- [`PHASE11_SELF_IMPROVEMENT.md`](./PHASE11_SELF_IMPROVEMENT.md) — feasibility of self-correction and evidence-gated self-improvement;
- [`PHASE11_DECISIONS.md`](./PHASE11_DECISIONS.md) — D1–D15 and O1–O8 with owners and reversibility;
- [`PHASE11_STAGE1_PLAN.md`](./PHASE11_STAGE1_PLAN.md) — the stage seam and the 12-packet single-machine proof.

---

## 15. Recommended defaults to confirm

These are the decisions that change the architecture. Recommended answers are included.

### Decision 1 — Authoring language

**Recommendation:** TypeScript-first for the SDK and workflow IR. Python and other runtimes are supported through the sandbox and MCP, not by embedding a second native SDK in the host.

Why: the host is Node/TypeScript. A second in-process language runtime doubles the security and packaging surface. Sandboxed containers already support multiple languages.

### Decision 2 — Execution isolation

**Recommendation:** Container by default for community/untrusted code; child worker for verified local packages; in-process only for first-party reviewed code.

Why: the existing agent plugin loader imports arbitrary JS into the host. That cannot be the model for a public ecosystem.

### Decision 3 — Workflow format

**Recommendation:** support both JSON and code, compiled to one IR. Keep JSON as the low-risk declarative form; code is for branching, loops, and real logic.

Why: existing templates must keep working. Two runtimes would create two sets of semantics and two bug surfaces.

### Decision 4 — Agent discretion

**Recommendation:** default `ask` for all new third-party capabilities. `auto` only for official/verified, read-only, bounded-cost capabilities. `suggest` for community packages until trusted.

Why: "at the agent's discretion" is acceptable only when the user's policy, not the model's confidence, is the final authority.

### Decision 5 — Marketplace scope

**Decision (user):** a public marketplace from day one.

**Implication:** the public catalog and install path are in the launch scope. Publishing is public too, but every new package enters `community` quarantine until automated checks pass; `verified` requires human review. The gates in §11.10 and §13.3 are launch-blocking.

Why: “public” describes who can consume the catalog, not a lower trust bar. A public marketplace without quarantine, signing, revocation, and moderation is a malware distribution channel.

### Decision 6 — Durable data root and update safety

**Recommendation:** adopt the five-root model in §11.6. App updates replace only the install root; packages, authoring source, state, runs, sessions, trust, and backups live in the data root and are never deleted by install/update. Uninstall preserves authoring source by default; `--purge` is explicit.

Why: an npm-global install already keeps binaries outside `~/.nuvira`, but that is not a guarantee. In-place skill updates and ad-hoc installers can still overwrite user work. The guarantee must be encoded, migrated, and tested.

### Decision 7 — Management parity

**Recommendation:** the CLI and dashboard are both first-class and call one control service. No lifecycle operation exists only in the dashboard, and no dashboard write bypasses the control service.

Why: CLI is required for headless/CI use; the dashboard is required for review, permissions, and onboarding. Two independent implementations will diverge and produce two different answers to “what is installed?”

### Decision 8 — Docker prerequisite

**Decision (user):** Docker is required; if it is missing, setup installs it as a prerequisite.

**Refinement:** the agent may install it only with explicit approval and a shown command. It verifies the daemon, not just the binary. If Docker cannot run, untrusted capabilities are blocked; there is no host-execution fallback.

Why: silently installing a system service or Docker Desktop is a privileged, licensed, machine-wide change. “Required” does not mean “unconsented.”

### Decision 9 — Channel scope

**Decision (user):** all channels.

**Implication:** all 22 gateway adapters are supported and testable at launch. Send-only adapters remain send-only; they can deliver results but cannot originate triggers. Each capability trigger remains opt-in per channel; connecting a channel does not grant every capability permission to use it.

Why: “all” is a support commitment, not a default-on switch. The gateway's sender policy, signature verification, and allow-lists still apply.

### Decision 10 — Copilot-class orchestration

**Recommendation:** add durable coding sessions, an async work-item queue, isolated worktrees/containers, PR creation, review rounds, and a human merge gate as a first-class layer above capability packages. Do not call a chat turn with edits a “session.”

Why: the capability ecosystem answers “what can Nuvira do?” The orchestration layer answers “what work is being done, in which repo, with what evidence, and who approved it?” Both are needed for a credible agent offering.

### Decision 11 — Lifecycle composition

**Recommendation:** ship a typed lifecycle graph with protected baseline stages, user/package bindings, and governed insertion slots. Start with presets and bindings; expose the full graph only to power users. Lifecycle packs become a first-class marketplace item.

Why: this is the capability users cannot get from a prompt library, a workflow template, or a hook. It lets a team encode its actual delivery method — “threat model before implementation,” “accessibility review after tests,” “release evidence before merge” — and have Nuvira execute it deterministically. It also creates the deepest ecosystem unit: a package that ships both agents and the method that governs them.

Guardrails are part of the recommendation: protected stages, no self-approval, no agent self-insertion, shadow mode for new gates, bounded budgets, and a reviewed diff for every enforcing change.

### Additional confirmation points

- Should a capability be allowed to ship **both** a workflow and an agent in one package? Recommended: yes.
- Should message triggers be **opt-in per channel**? Recommended: yes.
- Should event triggers be allowed to run `auto`? Recommended: no, default `suggest`.
- Should the SDK expose a stable HTTP `CapabilityClient`? Recommended: yes, before the public marketplace launch.
- Should existing `~/.nuvira/workflows/*.json` files be migrated into the package store, or kept as a legacy path? Recommended: migrate with a compatibility shim.
- Should `verified` publishing be open to any verified publisher at launch, or invite-only while moderation capacity is built? Recommended: verified publishers only, with a published review SLA.
- Should auto-update default to notify-only? Recommended: yes; auto-apply is opt-in, and major/permission-expanding updates never auto-apply.
- Should paid listings ship in v1? Recommended: no; launch free and add payments only after the trust/abuse model is stable.

---

## 16. Acceptance criteria

The platform is not "done" until these are demonstrable.

### Authoring

- A user can scaffold a package with a manifest, workflow, tests, and permissions.
- `capability validate` rejects a missing schema, an undeclared permission, and a bad entry point.
- The agent can draft a package and show it as a preview; it cannot install it without approval.

### Execution

- A code workflow runs in a sandbox, not in the host process.
- A failing step is reported as a failure, not a success with a summary.
- A run can be paused for approval and resumed.
- A retried step does not duplicate an external effect.
- Large artifacts are passed by reference.

### Consumption

- The capability appears in `capability_search` and can be inspected.
- The chat agent can select it, explain why, request approval if required, and run it.
- The CLI, dashboard, gateway, cron, and webhook can run the same capability with the same input schema.
- Uninstalling removes it from the index and prevents invocation.

### Trust

- A package with an undeclared network call fails validation or is blocked at runtime.
- A permission expansion on upgrade requires re-approval.
- A community package cannot become `auto` without an explicit trust decision.
- A message trigger cannot exceed the gateway's sender policy.
- A lifecycle event cannot silently start a spending workflow.

### Quality

- `capability test` and `capability eval` run without a provider key.
- A verified package has a signature, a checksum, and a passing eval.
- A failed eval blocks certification.

### Management and onboarding

- The CLI and dashboard return the same state for list/inspect/runs after every mutation.
- Every mutation is authorized by the control service and produces an audit event.
- A new user can complete the first-run flow, run a starter capability, and find the data root without reading source.
- Onboarding resumes after a restart and is idempotent when a step is repeated.
- The dashboard cannot reveal a secret value after it is saved.

### Durability and updates

- Updating Agent-Nuvira leaves packages, authoring source, sessions, runs, trust, and config intact.
- Interrupting a capability update leaves the previous version active.
- A schema migration failure restores the previous schema and pointer.
- Uninstall preserves authoring source; only an explicit purge removes data, and it exports first.
- `backup create` → `restore --dry-run` → restore reproduces the installed set and state on a clean profile.

### Channels and marketplace

- Every configured gateway adapter can be tested from the channel matrix; unsupported content falls back to text plus a link.
- A capability cannot exceed the gateway's sender policy or enable a channel trigger without opt-in.
- A new public package is quarantined until scans pass and is not searchable before indexing.
- A revoked version is disabled on the next sync and cannot be installed fresh.
- A publisher cannot self-assign `verified` or edit another namespace.

### Copilot-class orchestration

- A work item can be assigned, queued, resumed after a restart, and cancelled.
- A session runs in an isolated worktree/container and reports its base commit and diff.
- A session opens a PR containing checks, artifacts, risks, and its session ID.
- A failing check is recorded as a failure; the PR body does not claim success.
- Review comments create a new round and re-run the affected checks.
- A protected branch cannot be merged without the configured human approval and required checks.
- Two parallel sessions cannot write to the same branch.

### Lifecycle composition

- Every run contains the protected baseline stages; no user or package definition can remove, replace, or bypass test, review, verify, or deliver.
- A user can insert an installed agent after planning as a `gate`; a critical finding blocks implementation with a reason and a remediation path.
- A `transform` of the plan invalidates downstream gates and causes them to re-run against the new artifact version.
- A lower-precedence lifecycle cannot weaken a higher-precedence gate; the attempt fails validation and is audited.
- A lifecycle that fails validation does not run and leaves the previous active definition in force.
- A shadow lifecycle records would-be blocks and costs without mutating the run or blocking delivery.
- The CLI and dashboard resolve the same definition hash and agent versions for the same run.
- An agent can draft a lifecycle but cannot apply it, approve it, or edit a protected stage.
- A community lifecycle pack installs disabled or in `suggest`/shadow mode; it cannot auto-enforce on install.

---

## 17. Risks and mitigations

| Risk | Why it matters | Mitigation |
|---|---|---|
| Remote code execution | User packages are code | Sandbox, deny-by-default permissions, no in-process import |
| Supply-chain compromise | Packages are distributed artifacts | Signatures, checksums, lockfile, revocation |
| Prompt injection through metadata | Descriptions are model input | Treat as untrusted; never grant permissions from text |
| Secret exfiltration | Workflows call external systems | Scoped secret broker; no raw process env |
| Trigger storms | Webhooks and channels can loop | Rate limits, dedupe, idempotency, concurrency caps |
| Cost blowout | Agents and workflows call models | Budget per run and per capability; hard stop |
| Version drift | A workflow depends on an old agent contract | Semver, compatibility range, migrations |
| False success | A step claims completion without evidence | Artifact and exit-code verification; no summary-only success |
| Ecosystem spam | Publishing is cheap | Certification tiers, search ranking by evidence, revocation |
| Public marketplace malware | Anyone can publish, and installs are one click | Quarantine, scanning, human review for `verified`, signed immutable versions, revocation |
| Data loss on update | User-authored skills/workflows are the valuable part | Separate install/data/workspace roots; immutable store; backups; preserve-by-default uninstall |
| Privileged Docker install | A system service or licensed desktop app is being installed | Explicit consent, exact command, daemon verification, no silent install, fail closed |
| Runaway coding session | Agents can loop, spend, or spam PRs | Queue lease, budget/time caps, cancellation, no self-merge, PR rate limits |
| Session cross-contamination | Parallel work can overwrite another branch | One worktree/container per session; one writer per branch; read-only reviewers |
| Dashboard privilege escalation | The GUI is a remote control for the machine | Server-side RBAC, CSRF protection, localhost default, no secret reveal, same control service as CLI |
| Channel sprawl | 22 adapters multiply policy and credential mistakes | Per-channel opt-in, one policy layer, channel matrix, test message before enable |
| Namespace squatting | Public names are scarce and valuable | Namespace ownership, dispute process, verified publisher identity |
| Operator overload | Too many approvals | Risk-based policy, session grants, clear permission diffs |
| Lifecycle sprawl | Every team adds gates until runs are slow and expensive | Presets, per-stage caps, cost/time budgets, shadow mode, and a measured value review before enforcement |
| Gate erosion | A user disables the one check that mattered to ship faster | Protected stages, precedence, no self-approval, audited waivers with expiry, and a visible baseline diff |
| Artifact incompatibility | An extension expects a plan shape the host no longer produces | Versioned artifact schemas, compatibility ranges, validation at compile time, and contract tests |
| Lifecycle lock-in | A team encodes its method so deeply that migration is painful | Portable JSON spec, export/import, open schema, and no proprietary gate runtime |
| Shadow-mode false confidence | A pack looks safe because it never blocked in shadow | Report sample size, coverage, and would-have-blocked evidence; require an explicit promote decision |
| Composition obscures accountability | Many agents touch one artifact and nobody knows who approved what | Per-slot actor, artifact hash, decision record, and a signed run manifest |

---

## 18. What not to build

To keep the scope honest:

- **Do not** import user workflow code into the host process.
- **Do not** auto-run install hooks.
- **Do not** auto-enable an installed capability.
- **Do not** let the model's text grant permissions or change trust.
- **Do not** launch a public marketplace without quarantine, signing, revocation, moderation, and the §11.10 launch gates.
- **Do not** silently install Docker or any system-level prerequisite.
- **Do not** store authored source, packages, sessions, or secrets inside the npm install root or `node_modules`.
- **Do not** let an app update, uninstall, or `doctor --fix` delete the data root.
- **Do not** let the dashboard write state directly or expose a secret after capture.
- **Do not** let an agent merge its own PR to a protected branch, deploy, or widen its own permissions.
- **Do not** call a local chat turn a durable coding session.
- **Do not** replace the existing skill, workflow, agent, MCP, gateway, or hook systems; adapt them into the capability layer.
- **Do not** call a capability "verified" because it has a README. Verification is tests + eval + permissions + provenance.
- **Do not** claim speed, quality, or scale improvements without a measured baseline.
- **Do not** let a user or package remove, replace, or bypass a protected lifecycle stage.
- **Do not** let an agent insert itself, approve its own lifecycle change, or waive its own gate.
- **Do not** ship an untyped lifecycle graph or a “gate” that is only a prompt asking the model to be careful.
- **Do not** conflate lifecycle extensions with hooks. Hooks are native safety rules; lifecycle extensions are versioned, sandboxed capabilities with artifacts and decisions.
- **Do not** make full graph authoring the default onboarding path. Presets and bindings come first.

---

## 19. Decisions resolved and questions remaining

### Resolved by the user

1. **Audience:** public marketplace from day one. Public catalog and install are launch scope; publishing is gated by quarantine, review, and revocation.
2. **Runtime:** Docker is required. If it is missing, setup installs it as a prerequisite, with explicit approval and daemon verification.
3. **Messaging:** all 22 gateway channels are in scope. Triggers remain opt-in per channel.

### Still open

1. **Languages:** TypeScript-first, or is Python workflow code a day-one requirement? Recommendation: TypeScript-first; other languages through the sandbox/MCP.
2. **Trigger authority:** may a channel message start a spending workflow, or only a low-cost/read-only one until approved? Recommendation: low-cost/read-only may `auto`; spending requires `ask`.
3. **Publishing openness:** is `verified` publishing open to any verified publisher at launch, or invite-only while moderation capacity is built? Recommendation: invite-only verified publishers at launch, with a published review SLA.
4. **Paid listings:** free only in v1, or payments at launch? Recommendation: free only; add payments after the trust/abuse model is stable.
5. **Hosted runner:** local Docker + worktrees first, or a hosted runner at launch? Recommendation: local first; keep the session contract runner-agnostic.
6. **Data retention:** how long should verbose session events, run logs, and artifacts be kept by default? Recommendation: configurable, with summaries and PR links retained longer than raw logs.
7. **Governance:** who can publish `official`, and who can revoke a package in an emergency? Recommendation: core team for both, with a documented on-call path.
8. **Lifecycle default:** should a new project start with `solo` or `team`? Recommendation: `solo` for an individual repo; suggest `team` when a protected branch, organization repository, multiple contributors, or CI/CD is detected; show the choice during onboarding.
9. **Stage replaceability:** may a verified package bind its own agent to `implement` and `review`? Recommendation: yes for `implement` and additional `review` agents; the baseline reviewer and all protected checks remain.
10. **Reference packs:** should the first three lifecycle packs be first-party, design-partner-built, or both? Recommendation: first-party plus two design partners, so the schema is tested against real methods before public launch.

---

## 20. Market position: how Agent-Nuvira leads

**Scope of this assessment.** This is a product-direction review based on public documentation and product pages for the major agent platforms, plus the current Nuvira codebase. It is not a benchmark. Re-validate competitor claims before using them in external marketing.

### 20.1 What the market has already proven

| Player | What it does well | How far its lifecycle extensibility goes | What it leaves open |
|---|---|---|---|
| **GitHub Copilot** | Cloud agent, Agent HQ, custom agents/subagents, hooks, automations, PR-native review | Hooks at session/tool lifecycle; custom agents participate in delegated work | GitHub-centric. Extension is event- and agent-oriented, not a portable, typed plan/test/review artifact graph |
| **Claude Code** | Plugins bundle skills, subagents, hooks, and MCP; a very broad hook surface that can invoke commands, HTTP, MCP, prompts, or subagents | The most powerful event-driven extensibility in the market | Powerful but code/plugin-centric. It does not present a portable, typed lifecycle with protected stages, artifact gates, and simulation |
| **OpenAI Codex** | Cloud sandbox, parallel tasks, PR review, AGENTS.md, subagents | Strong asynchronous execution and review | The orchestration method is largely vendor-defined; end users do not install a governed delivery methodology between stages |
| **Cursor** | Cloud agents, IDE-native flow, hooks, Slack/Linear/GitHub integrations | Strong environment setup and event hooks | Optimized for the IDE/agent experience, not a capability marketplace or a portable lifecycle standard |
| **Devin / Jules** | Delegated asynchronous work that returns a PR | Managed orchestration and playbooks | Little user-controlled insertion between plan, implement, test, and review; the vendor owns the method |
| **Multi-agent control planes** | Run and monitor several coding agents, worktrees, and sessions | Session-level coordination | They usually do not own the capability runtime, artifact contracts, trust model, or a public ecosystem |
| **Agent-Nuvira today** | Local orchestration, 22-channel gateway, hooks, module registry, workflow templates, CLI + dashboard, memory | Broad surface area, but a fixed pipeline and no typed stage insertion | The contract is missing; the foundations are closer to this opportunity than they look |

Two market shifts make the gap urgent:

1. **Buyers are moving from “which model?” to “which delivery system?”** They want repeatable outcomes, evidence, cost control, and an audit trail — not another chat window.
2. **Every platform now has agents and hooks.** Those are becoming table stakes. The differentiated layer is the *method*: which specialist runs, at which point, against which artifact, with what authority, and what happens when it says no.

### 20.2 The unoccupied gap

Hooks can approximate lifecycle behavior, but they are the wrong abstraction for this job:

- a hook sees a tool call, not the plan, diff, test result, or review verdict;
- a hook can deny a call, but it cannot decide that a plan is unsafe and block implementation;
- a subagent can be invoked, but the user cannot install a rule that says *when* it must be invoked;
- a workflow template is a sequence for one goal, not a cross-cutting policy for every run;
- none of them gives a portable pack that another team can install, simulate, audit, and roll back.

**The gap is not “more agents.” It is a governed, typed, portable lifecycle that treats an agent as a participant with a contract, not a prompt with a name.**

That gap is defensible because it sits at the intersection of four things competitors mostly own separately:

- orchestration runtime;
- capability packaging and permissions;
- a marketplace;
- a control plane across CLI, dashboard, chat, and channels.

### 20.3 The leadership thesis

**Lead by making the lifecycle the product surface.**

Nuvira should not try to win by having the largest agent catalog. It should win by making the *delivery method* installable, inspectable, and measurable.

Six advantages compound from that choice:

1. **Depth without prompt spaghetti.** A stage-aware agent receives the plan, diff, or test result it needs instead of a giant accumulated prompt. Composition becomes more reliable as the workflow becomes more complex.
2. **Method as installable IP.** Agencies, platform teams, and security teams can package how they deliver software. That is more valuable and stickier than a single skill.
3. **Trust through evidence.** Gates, shadow runs, artifact hashes, and run manifests produce proof. “Verified” can mean measured, not marketed.
4. **Data-sovereign, best-model execution.** Source, artifacts, evidence, and run history stay under the user's or organization's control, while each task routes to the best approved model. Local models are an offline/air-gapped fallback, not the default quality strategy.
5. **One control plane.** The same lifecycle runs from CLI, dashboard, chat, webhook, schedule, or any channel. Competitors often have one strong surface and weaker coverage elsewhere.
6. **Compatibility instead of isolation.** Import existing skills, agent definitions, hook conventions, and workflow templates where practical. Make Nuvira the place methods are composed, not the place they are trapped.

**What data-sovereign means — and does not mean.** It is a control and data statement, not a model-quality statement. Quality of delivery is the product: use the best approved model for the task, give it the right repository and issue context, run deterministic checks, require human gates where policy demands them, and attach evidence. Model routing should be eval-driven, cost-aware, and visible. A local model is appropriate for offline, air-gapped, or privacy-constrained tiers; it is not a default substitute for frontier capability, and Nuvira must never silently downgrade a complex task to a weaker local model. “Model-agnostic” means no single-vendor lock-in, not that all models are equal.

“Maximum depth and power” therefore means:

- bind a specialist to a stage, or insert it between stages;
- give it a typed artifact and a bounded budget;
- let it observe, advise, gate, or transform — explicitly;
- enforce precedence and protected stages;
- simulate before enforcing;
- compare variants with evidence;
- export the method and move it to another repo or team.

### 20.4 Where to win — and where not to fight

| Win zone | Why Nuvira can own it | Proof point |
|---|---|---|
| **Regulated and security-sensitive software teams** | They need evidence, protected review, audit, and local/private execution | A security gate after planning blocks a design with no threat model; the run record shows who approved the exception |
| **Agencies and consultants** | They sell a method, not just code; lifecycle packs are reusable IP | A consultancy installs its “regulated delivery” pack across ten client repos |
| **Data-sovereign / air-gapped teams** | Source and evidence remain under customer control; execution can stay on-prem | The lifecycle runs against an on-prem repo with an approved model; local inference is used only where policy requires it |
| **Platform teams standardizing many repos** | Org/project precedence and one control plane | An org policy adds a mandatory release gate; a project can tighten but not weaken it |
| **Multi-channel operations teams** | 22-channel gateway plus durable sessions | A work item arrives from Slack, runs in an isolated worktree, and returns a PR link and evidence to the thread |
| **Agent authors** | A distribution channel where the agent is part of a method, not a standalone demo | A reviewer agent ships with the lifecycle pack that knows when to call it |

| Do not fight | Why |
|---|---|
| **Frontier model quality** | Capital-intensive and not the product's differentiator; integrate the best models |
| **IDE/editor UX** | Cursor and Copilot own the editor; Nuvira should integrate, not rebuild it |
| **Raw coding benchmarks** | Easy to game and not the buyer's real problem; measure accepted change and escaped defects instead |
| **Broadest GitHub-native integration** | GitHub can always go deeper on its own surface; be excellent at the multi-surface, multi-vendor method layer |
| **A closed model or closed runtime** | Lock-in would undermine the trust and portability argument that makes the lifecycle valuable |

Partner where distribution matters: source hosts for PRs, model providers for routing, Docker for isolation, and chat platforms for intake. Own the lifecycle contract and the evidence layer.

### 20.5 The moat

The moat is not the graph editor. It is the compounding system around it:

1. **The contract and SDK.** An open, versioned lifecycle spec with a reference implementation. If packs are portable, authors choose the format with the best tooling.
2. **The pack ecosystem.** More lifecycle packs → more reasons to install → more authors → more packs. The marketplace's unit is a method, not a prompt.
3. **The trust graph.** Verified publishers, signed versions, gate outcomes, and measured evals create data competitors cannot copy quickly.
4. **Local data gravity.** Authored methods, run history, and evidence live in the user's data root. That is durable without being hostage-taking.
5. **Organizational embedding.** Once an org encodes its delivery policy, switching means re-encoding governance, not reinstalling a tool.

Open the spec to seed adoption; certify the runtime and the trust layer to build a business. Do not confuse openness with a lack of differentiation: the reference runtime, the marketplace, and the evidence network are the product.

### 20.6 Scorecard

Instrument these before making public claims. Targets are design goals, not promises.

| Metric | Definition | Design target |
|---|---|---|
| Time to first value | Install → first successful lifecycle run | Under 15 minutes with a preset |
| Lifecycle adoption | Share of coding runs using a preset or pack | Majority of active users within 90 days |
| Gate precision | Share of blocks a reviewer agrees were real | High precision; track false-block rate explicitly |
| Escaped defects | Defects found after merge per accepted change | Lower than the team's pre-Nuvira baseline |
| Quality routing | Share of runs on the eval-best approved model; visible fallback rate | Best approved model by default; every fallback is recorded |
| Review-cycle time | Plan-ready → human review complete | Shorter without increasing escaped defects |
| Cost per accepted change | Model + compute + human review | Within an explicit budget; report variance |
| Shadow-to-enforce conversion | Shadow packs later enforced | Evidence-backed promotion, not default-on |
| Rollback rate | Lifecycle changes reverted | Low and explainable |
| Verified pack share | Installs of verified vs community packs | Rising over time |
| 30-day retention | Users still running a lifecycle after 30 days | Stronger than a skill-only baseline |

### 20.7 Three horizons

**H1 — Own the lifecycle wedge (design partners).**

- Phase 1 + Phase 2 foundations;
- lifecycle contract, resolver, runner, presets, and Studio;
- three first-party reference packs;
- shadow mode and a design-partner program;
- success test: a real gate catches a real defect before merge, with a readable audit trail.

**H2 — Public category launch.**

- durable coding sessions (Phase 3);
- management/onboarding/update safety (Phase 4);
- lifecycle graph and packs (Phase 5);
- all-channel triggers (Phase 6);
- public marketplace with quarantine, verification, signing, and revocation (Phase 7);
- success test: a new user installs a lifecycle pack and gets a governed PR without writing YAML.

**H3 — Category leadership.**

- organization policy and multi-repo rollouts;
- remote/hosted runners behind the same session contract;
- cross-vendor import/export for agents, hooks, and lifecycle packs;
- an opt-in benchmark for accepted change, cost, and escaped defects;
- a partner ecosystem of agencies, security vendors, and platform teams.

### 20.8 What could stop this

| Threat | Why it is real | Response |
|---|---|---|
| Fast followers add typed lifecycle | GitHub, Anthropic, and Cursor already have hooks and subagents; the graph is a natural next step | Move early, open the spec, and win the pack ecosystem before the feature is commoditized |
| Graph complexity kills onboarding | Most users do not want to design a pipeline | Presets and bindings first; the graph is an advanced surface, not the front door |
| A lifecycle pack becomes a malware vector | It ships agents and gates with real permissions | Capability sandbox, permissions, signing, quarantine, shadow mode, and revocation |
| Claims outrun evidence | “Verified” becomes marketing | Publish methodology and measurements; block certification without eval and provenance |
| Integration breadth drains focus | 22 channels, many source hosts, many models | One contract, adapters at the edge, and a small set of reference packs |
| Vendor-specific behavior creeps in | The method becomes non-portable | Open schema, export/import, compatibility tests, and no proprietary gate runtime |

The honest risk is not that the lifecycle graph is wrong. It is that it is shipped as a power-user toy instead of a guided product, or that it is opened to untyped, ungoverned composition and becomes an expensive prompt chain. Both are product failures, not technology failures.

### 20.9 The test of leadership

If a user can install a lifecycle pack, see it block a real defect before merge, understand why, and export the method to another repo — in under fifteen minutes, without writing YAML — Nuvira has a category-defining product.

If the user has to author a graph to get value, Nuvira has a developer tool with a smaller market.

### 20.10 Sources reviewed

Public documentation reviewed for this assessment. Product capabilities change; re-check before using any claim externally.

- GitHub Copilot hooks — https://docs.github.com/en/copilot/concepts/agents/hooks
- GitHub Copilot custom agents (Copilot SDK) — https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/custom-agents
- Claude Code plugins overview — https://code.claude.com/docs/en/plugins/overview
- Claude Code subagents — https://code.claude.com/docs/en/sub-agents
- OpenAI Codex cloud — https://developers.openai.com/codex/cloud
- Cursor cloud agents — https://cursor.com/docs/cloud-agent

---

## 21. Bottom line

The earlier recommendation still holds: **the right unit is a versioned capability package, not an arbitrary code injection.** This plan extends that recommendation from "skills and JSON workflows" to:

- code-backed workflows with real control flow and durable execution;
- installable custom agents with scoped tools and lifecycle participation;
- a typed lifecycle graph with protected stages, governed insertion slots, and portable lifecycle packs;
- one unified index that the chat agent can search and select;
- a real control plane for CLI and dashboard management, onboarding, and audit;
- data-sovereign execution with best-model routing and first-class GitHub/GitLab issue, PR, and CI integration;
- a durable data root that survives app updates, reinstalls, and failed migrations;
- triggers from chat, CLI, dashboard, all gateway channels, HTTP, schedules, and the event bus;
- Copilot-class coding sessions with work-item intake, isolated execution, PR review loops, and human merge gates;
- a sandboxed runtime and a trust model that make a public ecosystem defensible;
- a quality pipeline that treats certification as evidence, not marketing.

The first internal build is **Phase 1 + Phase 2**: one manifest, one index, one sandboxed code-workflow runtime. The lifecycle contract is spiked alongside it once the workflow IR is stable, then becomes a gated deliverable in **Phase 5**. The first public milestone is **Phase 3 + Phase 4 + Phase 5 + Phase 6 + Phase 7**: durable coding sessions, full management/onboarding, composable lifecycle, all-channel triggers, and the public-marketplace launch gates. Do not launch the public catalog before those gates pass.

**No code has been changed. This document is the planning artifact. Confirm §15, including the Decision 11 lifecycle recommendation, before implementation starts.**
