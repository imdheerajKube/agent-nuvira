# Agent-Nuvira: AI Software Company — Strategic Execution Plan

> **Timeframe:** 6–9 months  
> **Objective:** Transform Agent-Nuvira from a powerful single-machine CLI into a serious enterprise platform for teams, competitive with Hermes-Agent, Cursor, and GitHub Copilot.  
> **Guiding thesis:** Win on *execution accuracy + engineering reliability + team-scale collaboration*.

---

## Table of Contents

1. [Current State Assessment](#1-current-state-assessment)
2. [Strategic Roadmap Overview](#2-strategic-roadmap-overview)
3. [Pillar A: GitHub/GitLab Integration — 6–8 weeks](#3-pillar-a-githubgitlab-integration)
4. [Pillar B: IDE-Native Experience — 8–12 weeks](#4-pillar-b-ide-native-experience)
5. [Pillar C: Remote Execution — 8–10 weeks](#5-pillar-c-remote-execution)
6. [Pillar D: Team Memory & Shared Context — 8–12 weeks](#6-pillar-d-team-memory--shared-context)
7. [Dependency Graph](#7-dependency-graph)
8. [Engineering Team Sizing](#8-engineering-team-sizing)
9. [Success Metrics & OKRs](#9-success-metrics--okrs)
10. [Risk Matrix](#10-risk-matrix)

---

## 1. Current State Assessment

### What We Already Have (✅)

| Area | Capability | Status |
|---|---|---|
| **GitHub** | GitHubReleaseAgent — create releases, changelogs via LLM | ✅ Production |
| **GitHub** | GitAgent — branch, commit, push, PR descriptions (LLM) | ✅ Production |
| **VS Code** | 9 commands (execute, fix, review, explain, test, workflow, accept/reject, panel) | ✅ Production |
| **VS Code** | InlineCompletionItemProvider (Copilot-style suggestions) | ✅ Production |
| **VS Code** | WebView panel with progress + diff viewer | ✅ Production |
| **Docker** | SandboxManager — full container lifecycle, 8 images, isolation | ✅ Production |
| **Team** | Git-synced team memory (trajectories, patterns, templates) | ✅ Production |
| **Team** | Review workflow (create/approve/merge/reject) | ✅ Production |
| **Team** | 10 workflow templates + marketplace registry | ✅ Production |
| **Team** | Project-level config priority chain | ✅ Production |

### What We Need to Build (❌)

| Area | Gap | Effort |
|---|---|---|
| **GitLab** | Zero GitLab support — no API, no MRs, no webhooks | 🔴 High |
| **GitHub** | No issue triage — no discover/issues/assign/workflow | 🔴 High |
| **GitHub** | No automatic PR code review comments (inline review) | 🟡 Medium |
| **GitHub** | No branch automation hooks (create → commit → PR on trigger) | 🟡 Medium |
| **IDE** | No real-time streaming in VS Code panel (progress phases only) | 🟡 Medium |
| **IDE** | No VS Code Chat panel (like Copilot Chat / Cursor) | 🔴 High |
| **IDE** | No diagnostic → AI fix integration (squiggles → Ctrl+. → fix) | 🟡 Medium |
| **IDE** | No JetBrains/IntelliJ extension | 🔴 High |
| **IDE** | No "code lens" / gutter actions | 🟢 Low |
| **Exec** | No SSH remote execution (Docker-only currently) | 🔴 High |
| **Exec** | No cloud VM orchestration (AWS EC2, GCP, Azure) | 🔴 High |
| **Exec** | No remote repo sandboxing (clone → work → destroy) | 🟡 Medium |
| **Exec** | No VS Code Remote SSH integration | 🟡 Medium |
| **Team** | No knowledge graph — only flat files | 🔴 High |
| **Team** | No team conventions system (reusable conventions schema) | 🟡 Medium |
| **Team** | No cross-team semantic search of shared trajectories | 🟡 Medium |
| **Team** | No team workspace/org management (multi-repo projects) | 🔴 High |

---

## 2. Strategic Roadmap Overview

```
Month 1          Month 2          Month 3          Month 4          Month 5          Month 6
├────────────────┼────────────────┼────────────────┼────────────────┼────────────────┤
│  Pillar A      │  Pillar A      │  Pillar B      │  Pillar B      │  Pillar C      │  Pillar D      │
│  A1-A3         │  A4-A5         │  B1-B3         │  B4-B6         │  C1-C3         │  D1-D4         │
│                │                │                │                │                │                │
│  GitLab API    │  Issue Triage  │  Chat Panel    │  Diagnostic    │  SSH Exec      │  Knowledge     │
│  + MR Gen      │  Engine        │  (WebView)     │  → AI Fix      │  Engine        │  Graph Engine  │
│                │                │                │                │                │                │
│  GitHub PR     │  Branch        │  Streaming     │  JetBrains     │  Cloud VM      │  Team          │
│  Review Agent  │  Automation    │  in Panel      │  Extension     │  Orchestrator  │  Conventions   │
└────────────────┴────────────────┴────────────────┴────────────────┴────────────────┴────────────────┘
                                                                                                
                                        Month 7-9 (Polish & Scale)
                                        ├──────────────────────────┤
                                          B6: Code Lens
                                          C4: Remote Sandboxing + VSCode SSH
                                          D4: Org Management
                                          E2: Performance & Reliability
```

---

## 3. Pillar A: GitHub/GitLab Integration (6–8 weeks)

### A1 — GitLab API Client + Merge Request Generation (Week 1–2)

**Problem:** Zero GitLab support. Hermes-Agent already has GitLab MR generation.

**Solution:** Build a `GitLabAgent` matching `GitAgent` + `GitHubReleaseAgent` parity.

**Files to create/modify:**

| File | Change |
|---|---|
| `src/agents/agents/gitlab-agent.ts` | **NEW** — GitLab API client (merge requests, approvals, pipelines, issues) |
| `src/agents/agents/gitlab-api-client.ts` | **NEW** — REST API wrapper (list projects, create MR, comment on MR, merge MR, list issues) |
| `src/config/types.ts` | Add `GITLAB_TOKEN`, `GITLAB_URL` config keys |
| `src/agents/orchestrator.ts` | Register `gitlab` agent type |
| `tests/agents/gitlab-agent.test.ts` | **NEW** — Mock API tests |

**Capabilities:**
- `GET /api/v4/projects` — discover projects
- `POST /api/v4/projects/:id/merge_requests` — create MR with title, description, source/target branch
- `POST /api/v4/projects/:id/merge_requests/:mr_iid/notes` — comment on MR (code review inline)
- `PUT /api/v4/projects/:id/merge_requests/:mr_iid/merge` — auto-merge
- `GET /api/v4/projects/:id/issues` — list issues for triage

**Test plan:** 25+ tests (API calls, MR creation, comment creation, error handling, auth)

---

### A2 — GitHub PR Review Agent (Week 2–3)

**Problem:** No automatic inline code review on open PRs. Hermes-Agent posts inline review comments.

**Solution:** A `PRReviewAgent` that watches for open PRs, reads the diff, runs the VerifyModule pipeline, and posts inline review comments via the GitHub API.

**Files:**

| File | Change |
|---|---|
| `src/agents/agents/pr-review-agent.ts` | **NEW** — PR review agent (discover open PRs, read diff, run verification, post comments) |
| `src/agents/orchestrator.ts` | Register `pr-review` agent type, add `reviewOpenPRs` option |
| `src/cli/execute.ts` | Add `--review-prs` flag to `buff execute` |
| `tests/agents/pr-review-agent.test.ts` | **NEW** — Mock API tests |

**How it works:**
1. `buff execute "review open PRs"` or `buff execute --review-prs`
2. `PRReviewAgent` fetches open PRs via GitHub API (`GET /repos/:owner/:repo/pulls`)
3. For each PR, fetches the diff (`GET /repos/:owner/:repo/pulls/:number/files`)
4. Runs each changed file through `VerifyModule.scan()` (security + quality checks)
5. Posts inline review comments on problematic lines via `POST /repos/:owner/:repo/pulls/:number/comments`
6. Posts a summary comment with pass/fail/bockers/suggestions

**Test plan:** 20+ tests (PR discovery, diff parsing, comment posting, rate limiting)

---

### A3 — Issue Triage Engine (Week 3–4)

**Problem:** No issue triage. Hermes-Agent can automatically label, assign, and prioritize issues.

**Solution:** An `IssueTriageAgent` that scans open issues, classifies them (bug/feature/question/docs), assigns priority, suggests labels, and optionally auto-assigns to team members.

**Files:**

| File | Change |
|---|---|
| `src/agents/agents/issue-triage-agent.ts` | **NEW** — Issue triage engine (classify, prioritize, label, assign) |
| `src/agents/orchestrator.ts` | Register `issue-triage` agent type |
| `src/cli/execute.ts` | Add `--triage-issues` flag |
| `tests/agents/issue-triage-agent.test.ts` | **NEW** — Mock API tests |

**Classification Schema (LLM-driven):**

```typescript
interface TriageResult {
  issueNumber: number;
  title: string;
  classification: 'bug' | 'feature' | 'question' | 'docs' | 'chore';
  priority: 'critical' | 'high' | 'medium' | 'low';
  suggestedLabels: string[];
  suggestedAssignee?: string; // based on git blame + expertise
  suggestedMilestone?: string;
  estimatedDifficulty: 'easy' | 'medium' | 'hard';
  suggestedAction: string; // LLM-generated triage note
}
```

**How it works:**
1. Fetches open issues without labels via GitHub/GitLab API
2. For each issue, sends title + body to LLM for classification
3. Applies labels via API, adds triage comment with analysis
4. Optionally assigns to team member based on expertise (git blame heuristics)

**Test plan:** 25+ tests (classification, prioritization, labeling, git blame parsing)

---

### A4 — Branch Automation Hooks (Week 4–5)

**Problem:** No automated branch workflow. Currently manual: `buff execute` → GitAgent → commit.

**Solution:** A `BranchAutomationAgent` that watches for triggers (issue assigned, PR label added, config file changed) and auto-creates branches, commits work-in-progress, and opens draft PRs.

**Files:**

| File | Change |
|---|---|
| `src/agents/agents/branch-automation-agent.ts` | **NEW** — Branch automation with trigger hooks |
| `src/agents/agents/branch-automation-hooks.ts` | **NEW** — Git hooks installer (post-checkout, pre-commit) |
| `src/cli/execute.ts` | Add `--auto-branch` flag for branch-create-on-start |
| `src/config/types.ts` | Add `branchAutomation` config section |
| `tests/agents/branch-automation-agent.test.ts` | **NEW** — Mock tests |

**Trigger Sources:**
1. **Issue → Branch:** When an issue is assigned to the user, auto-create a branch
2. **PR Label → Update:** When a PR label like `wip` or `needs-work` is added, auto-update
3. **File Watch → Commit:** Watch for file changes and auto-commit with conventional commit messages
4. **CI Status → Fix:** When CI fails on a PR, detect the failure, fix it, push

**Test plan:** 25+ tests (branch creation, hook installation, auto-commit, CI fix detection)

---

### A5 — GitLab Webhook Server (Week 5–6)

**Problem:** No webhook processing. Can't react to GitLab events in real-time.

**Solution:** A lightweight webhook server (separate process or CLI subcommand) that listens for GitHub/GitLab webhooks and triggers agent pipelines.

**Files:**

| File | Change |
|---|---|
| `src/cli/webhook.ts` | **NEW** — `buff webhook start` CLI command (Express server) |
| `src/agents/agents/webhook-processor.ts` | **NEW** — Webhook event router (map event type → agent pipeline) |
| `tests/cli/webhook.test.ts` | **NEW** — 15+ tests |

**Supported Events:**
- `pull_request` / `merge_request` → run PR review
- `issues` / `issue` → run issue triage
- `push` → run verify + auto-fix
- `workflow_run` / `pipeline` → run CI fix

---

### Pillar A — Test Count: ~110 new tests

---

## 4. Pillar B: IDE-Native Experience (8–12 weeks)

### B1 — VS Code Chat Panel (Week 1–4)

**Problem:** No multi-turn chat within VS Code. Currently only commands via command palette and a progress panel.

**Solution:** A full VS Code Chat Panel (webview-based) that supports multi-turn conversations with the agent, file context, slash commands, and streaming responses — similar to GitHub Copilot Chat or Cursor.

**Files:**

| File | Change |
|---|---|
| `vscode-extension/src/chatPanel.ts` | **NEW** — Chat webview panel with streaming, markdown rendering, code blocks |
| `vscode-extension/src/chatPanel.html` | **NEW** — HTML template for chat webview |
| `vscode-extension/src/chatPanel.css` | **NEW** — Dark-theme chat styles |
| `vscode-extension/src/chatProvider.ts` | **NEW** — Chat history provider (session persistence) |
| `vscode-extension/src/extension.ts` | Update — register chat panel, add `agent-nuvira.openChat` command |
| `vscode-extension/package.json` | Update — add `openChat` command + keybinding |

**Chat Panel Features:**
- Multi-turn conversation with streaming LLM responses
- `/fix`, `/review`, `/test`, `/explain`, `/workflow` slash commands
- **File context:** Auto-include open file/selection, `@file` mentions for multi-file context
- **Code block rendering:** Syntax-highlighted code with "Apply to File" button
- **Conversation history:** Persist sessions, resume previous chat
- **Agent pipeline view:** When a command triggers a multi-agent pipeline, show DAG progress inline

**Implementation Details:**
- WebView with `cspSource` for security
- Streaming via CLI subprocess with real-time `stdout` parsing
- Markdown rendering with `marked` (lightweight, bundled)
- Code block actions: apply, copy, diff preview

**Extension Commands Added:**
| Command | Keybinding | Action |
|---|---|---|
| `agent-nuvira.openChat` | `Ctrl+Shift+A C` | Open AI Chat Panel |
| `agent-nuvira.chatAddFile` | (context menu) | Add current file to chat context |

**Test plan:** 35+ tests (message sending, streaming parsing, code block actions, slash commands, history)

---

### B2 — Real-Time Streaming in VS Code Panel (Week 2–3, overlaps B1)

**Problem:** The current `AgentPanel` shows progress phases but not real-time token streaming.

**Solution:** Upgrade the existing `AgentPanel` webview to show real-time streaming tokens (like ChatGPT streaming) alongside the progress phases.

**Files:**

| File | Change |
|---|---|
| `vscode-extension/src/agentPanel.ts` | Rewrite — add streaming message display alongside progress |
| `vscode-extension/src/agentPanel.html` | Update — add streaming text area + phase indicators |
| `vscode-extension/src/agentPanel.css` | Update — streaming token styles (typewriter effect) |
| `vscode-extension/src/cliManager.ts` | Update — parse streaming chunks and emit `onStreamChunk` callback |

**Test plan:** 15+ tests (streaming parsing, phase tracking, error recovery)

---

### B3 — VS Code Diagnostic → AI Fix Integration (Week 4–6)

**Problem:** Users see red squiggles but can't fix them with AI. Copilot/Cursor can fix diagnostics.

**Solution:** Register a VS Code `CodeActionProvider` that adds "Fix with Agent-Nuvira" to diagnostic squiggles. Clicking it runs a quick-fix pipeline on the affected code range.

**Files:**

| File | Change |
|---|---|
| `vscode-extension/src/diagnosticFixer.ts` | **NEW** — CodeActionProvider for diagnostics |
| `vscode-extension/src/extension.ts` | Update — register CodeActionProvider |
| `vscode-extension/package.json` | Update — add code actions contribution |

**How it works:**
1. VS Code shows a diagnostic (red squiggle) on line 42
2. User clicks "Fix with Agent-Nuvira" in the lightbulb menu (`Ctrl+.`)
3. The extension captures: the error message, the affected code range, surrounding context (5 lines before/after)
4. Sends this to the CLI: `buff execute "Fix error on line 42 of src/app.ts: <error message>"`
5. The agent pipes the result back as a `FileChange` shown in the diff viewer
6. User accepts/rejects the fix

**Test plan:** 20+ tests (diagnostic detection, code action registration, fix pipeline, accept/reject)

---

### B4 — JetBrains/IntelliJ Extension (Week 6–10)

**Problem:** No JetBrains support. VS Code users are covered, but IntelliJ IDEA, WebStorm, PyCharm, GoLand users cannot use Agent-Nuvira.

**Solution:** Build a JetBrains plugin using the IntelliJ Platform SDK with feature parity to the VS Code extension (execute goal, quick fix, review, inline suggestions, chat panel).

**Files:**

| Directory | Content |
|---|---|
| `intellij-extension/` | **NEW** — JetBrains plugin project directory |
| `intellij-extension/src/main/kotlin/` | Kotlin source files |
| `intellij-extension/src/main/resources/META-INF/plugin.xml` | Plugin descriptor |
| `intellij-extension/build.gradle.kts` | Gradle build config |

**Key Components:**

| Component | Kotlin Class | Purpose |
|---|---|---|
| **Plugin Entry** | `AgentNuviraPlugin` | Extension activation, lifecycle, config |
| **Command Actions** | `ExecuteGoalAction`, `QuickFixAction`, `ReviewAction`, etc. | Toolbar/context menu actions |
| **Chat Tool Window** | `ChatToolWindowFactory` + `ChatPanel` webview | Multi-turn chat panel (tool window) |
| **Inline Completion** | `AgentInlineCompletionProvider` | Copilot-style suggestions |
| **File Annotator** | `AgentFileAnnotator` | Gutter icons, line markers |
| **CLI Manager** | `CliProcessManager` | Spawn/manage CLI subprocess |
| **Diff Viewer** | Integration with IntelliJ's diff API | Show/applied/reject changes |
| **Diagnostic Fixer** | `AgentFixCodeAction` | Lightbulb → Quick Fix for diagnostics |

**Required IntelliJ SDK Plugins:**
- `com.intellij.modules.platform` (core)
- `com.intellij.modules.lang` (language support)
- `com.intellij.java` (Java/Kotlin specific)
- `git4idea` (Git integration)

**Test plan:** 80+ tests (Kotlin unit tests for each component)

---

### B5 — Code Lens / Gutter Actions (Week 10–11)

**Problem:** No visual affordances in the editor. Users must use keybindings or command palette.

**Solution:** Add VS Code `CodeLens` providers and gutter decorations for common agent actions.

**Files:**

| File | Change |
|---|---|
| `vscode-extension/src/codeLensProvider.ts` | **NEW** — CodeLensProvider for functions/classes |
| `vscode-extension/src/gutterActions.ts` | **NEW** — Gutter clickable icons |
| `vscode-extension/src/extension.ts` | Update — register CodeLens/CodeAction |

**CodeLens Actions (shown above functions/classes):**
- **▶ Test** — Generate unit test for this function
- **📝 Review** — Review this function for bugs
- **💡 Explain** — Explain this function
- **🔍 Quick Fix** — Quick fix this function

---

### B6 — VS Code Chat Panel v2: Agent Pipeline Visualization (Week 11–12)

**Problem:** The chat panel from B1 shows text only. Users want to see multi-agent pipeline progress inline.

**Solution:** Upgrade the chat panel to render the orchestrator DAG inline — showing which agents ran, which are running, results, and file changes in real-time.

**Files:**

| File | Change |
|---|---|
| `vscode-extension/src/chatPanel.ts` | Update — add DAG visualization component |
| `vscode-extension/src/dagRenderer.ts` | **NEW** — SVG DAG renderer for agent pipeline |

---

### Pillar B — Test Count: ~180 new tests

---

## 5. Pillar C: Remote Execution (8–10 weeks)

### C1 — SSH Execution Engine (Week 1–3)

**Problem:** Currently Docker-only. No SSH remote execution. Hermes-Agent has SSH support.

**Solution:** Build an `SSHExecutionEngine` that can execute agent commands on remote machines via SSH, with key management, host verification, and session tracking.

**Files:**

| File | Change |
|---|---|
| `src/sandbox/ssh-engine.ts` | **NEW** — SSH execution engine (connect, exec, file transfer, disconnect) |
| `src/sandbox/ssh-types.ts` | **NEW** — SSH config types (host, port, user, keyPath, fingerprint) |
| `src/config/types.ts` | Update — add `remoteExecution.ssh` config section |
| `src/cli/execute.ts` | Update — add `--ssh <host>` flag |
| `src/cli/sandbox.ts` | Update — add `ssh` subcommands |
| `tests/sandbox/ssh-engine.test.ts` | **NEW** — Mock SSH tests |

**SSH Engine Capabilities:**
```typescript
interface SSHExecutionEngine {
  connect(config: SSHConfig): Promise<void>;
  disconnect(): Promise<void>;
  execCommand(command: string, timeoutMs?: number): Promise<ExecResult>;
  copyToRemote(localPath: string, remotePath: string): Promise<void>;
  copyFromRemote(remotePath: string, localPath: string): Promise<void>;
  getStatus(): SSHConnectionStatus;
  verifyHostKey(fingerprint: string): boolean;
}
```

**Implementation Options (choose one):**

| Option | Pros | Cons |
|---|---|---|
| **node-ssh** (npm) | Pure JS, async/await, built-in SFTP | Dependency overhead |
| **ssh2** (npm) | Most popular, battle-tested, streaming | Callback-based API |
| **Native `ssh` subprocess** | Zero deps, works everywhere | Complex output parsing, no SFTP |

**Recommendation:** Use `ssh2` for maximum reliability, with fallback to native `ssh` subprocess when the package isn't available.

**Test plan:** 25+ tests (connect, auth, command exec, file transfer, error handling, timeout)

---

### C2 — Cloud VM Orchestrator (Week 3–6)

**Problem:** No cloud VM provisioning. Users must manually set up VMs.

**Solution:** A `CloudVMOrchestrator` that provisions temporary cloud VMs (AWS EC2, Google Cloud, Azure), installs dependencies, runs agent pipelines, and destroys the VM on completion.

**Files:**

| File | Change |
|---|---|
| `src/sandbox/cloud-orchestrator.ts` | **NEW** — Cloud VM orchestrator (AWS/GCP/Azure) |
| `src/sandbox/cloud-types.ts` | **NEW** — Cloud config types (provider, region, instance type, AMI) |
| `src/cli/sandbox.ts` | Update — add `cloud` subcommands |
| `tests/sandbox/cloud-orchestrator.test.ts` | **NEW** — Mock cloud API tests |

**Provisioning Flow:**
1. `buff execute "deploy app" --cloud aws --instance t3.medium`
2. `CloudVMOrchestrator.createInstance({ provider: 'aws', type: 't3.medium', image: 'ami-xxx' })`
3. Wait for instance to be running (poll every 5s, timeout 5min)
4. SSH into instance, install Docker + project dependencies
5. Run agent pipeline inside the VM
6. On completion/failure: `destroyInstance(instanceId)`

**Supported Providers (v1):**
- AWS EC2 (via `@aws-sdk/client-ec2` — lightweight SDK import)
- GCP Compute Engine (via `google-auth-library` + REST API)
- Azure Virtual Machines (via `@azure/arm-compute`)

**Test plan:** 30+ tests (provisioning, polling, destruction, error handling, SSH integration)

---

### C3 — Remote Repo Sandboxing (Week 5–7, overlaps C2)

**Problem:** No isolated repo sandboxing. Running agent pipelines on production repos is risky.

**Solution:** A `RepoSandbox` workflow: clone a repo to a sandbox (local temp dir or remote), execute the pipeline, and either apply or discard changes.

**Files:**

| File | Change |
|---|---|
| `src/sandbox/repo-sandbox.ts` | **NEW** — Repo sandbox (clone → work → apply/discard) |
| `src/cli/execute.ts` | Update — add `--sandbox-repo` flag |
| `tests/sandbox/repo-sandbox.test.ts` | **NEW** — Mock git tests |

**How it works:**
1. `buff execute --sandbox-repo https://github.com/org/repo.git --branch feat/new-feature`
2. Clone repo to `/tmp/buff-sandbox-xxx/` (or remote via SSH)
3. Create a new feature branch from the base branch
4. Run agent pipeline inside the sandbox
5. On success: push changes and create PR/MR, or discard
6. On failure: keep sandbox for debugging, or discard

**Integration with Cloud VM:**
```
buff execute "refactor auth" --sandbox-repo https://github.com/team/repo.git --cloud aws
```
1. Provision a temporary EC2 instance
2. Clone repo into the instance
3. Run agent pipeline
4. Push changes back to repo
5. Destroy EC2 instance

**Test plan:** 20+ tests (clone, branch, push, apply/discard, cleanup)

---

### C4 — VS Code Remote SSH Integration (Week 7–8)

**Problem:** VS Code users can't use Agent-Nuvira on remote machines via Remote SSH extension.

**Solution:** Detect VS Code Remote SSH environments and adapt the CLI communication strategy (forward CLI subprocess to remote host, tunnel panel communication).

**Files:**

| File | Change |
|---|---|
| `vscode-extension/src/remoteResolver.ts` | **NEW** — Detect remote environment, resolve CLI path |
| `vscode-extension/src/cliManager.ts` | Update — add remote execution fallback |
| `vscode-extension/src/extension.ts` | Update — auto-detect remote SSH |

**Test plan:** 10+ tests (environment detection, path resolution, CLI forwarding)

---

### Pillar C — Test Count: ~85 new tests

---

## 6. Pillar D: Team Memory & Shared Context (8–12 weeks)

### D1 — Knowledge Graph Engine (Week 1–5)

**Problem:** Team memory is file-based (flat JSON files). No graph structure for relationships between code, patterns, decisions, and people.

**Solution:** Build a `KnowledgeGraph` engine using a simple graph structure (nodes + edges with typed relationships) stored in a local DB (better-sqlite3 or NeDB). This replaces the flat file-based team memory with a queryable graph.

**Files:**

| File | Change |
|---|---|
| `src/team/knowledge-graph.ts` | **NEW** — Knowledge graph engine (nodes, edges, traversal) |
| `src/team/knowledge-graph-store.ts` | **NEW** — SQLite-backed graph persistence |
| `src/team/knowledge-graph-search.ts` | **NEW** — Semantic + graph traversal search |
| `src/cli/team.ts` | Update — add `knowledge-graph` subcommands |
| `src/agents/orchestrator.ts` | Update — auto-index trajectories into knowledge graph |
| `tests/team/knowledge-graph.test.ts` | **NEW** — 40+ tests |

**Graph Schema:**

```typescript
interface KnowledgeNode {
  id: string;
  type: NodeType;
  label: string;
  properties: Record<string, unknown>;
  embedding?: Float32Array; // 384-dim for semantic search
  createdAt: number;
  updatedAt: number;
}

interface KnowledgeEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relation: RelationType;
  weight: number; // 0-1, decays over time
  properties: Record<string, unknown>;
  createdAt: number;
}

type NodeType = 
  | 'file' | 'function' | 'class' | 'module'     // Code
  | 'pattern' | 'anti-pattern'                     // Patterns
  | 'decision' | 'architecture-decision'           // Decisions
  | 'persona' | 'team-member'                      // People
  | 'convention' | 'workflow-template'              // Conventions
  | 'trajectory' | 'execution'                     // History
  | 'issue' | 'pr' | 'release';                    // GitHub/GitLab

type RelationType =
  | 'contains' | 'depends-on' | 'implements'
  | 'follows' | 'precedes' | 'references'
  | 'resolves' | 'relates-to' | 'pattern-of'
  | 'authored-by' | 'assigned-to'
  | 'similar-to' | 'alternative-to';
```

**Queries the Graph Can Answer:**
- "Which modules does the auth system depend on?"
- "What architectural decisions were made about the database layer?"
- "Who has the most expertise in the payment module?"
- "What patterns were used in the last 3 refactoring tasks?"
- "Which team members worked on this area of the codebase?"
- "What was the rationale for switching from REST to GraphQL?"

**Integration Points:**
1. **Orchestrator on completion:** Auto-index the trajectory + changed files + patterns into the knowledge graph
2. **Before execution:** Query the graph for relevant patterns, decisions, conventions
3. **Team sync:** Share graph nodes/edges via git-synced team memory (export/import)
4. **Search:** `buff team knowledge-graph query "auth module decisions"` — semantic + graph traversal

**Test plan:** 40+ tests (node/edge CRUD, graph traversal, semantic search, graph export/import)

---

### D2 — Team Conventions System (Week 4–6)

**Problem:** No formal conventions system. Teams want reusable rules like "use arrow functions", "prefix event handlers with `handle`", "all API routes must have input validation".

**Solution:** A `ConventionsRegistry` with a typed schema for conventions, stored in the team memory and automatically applied by agents during code generation.

**Files:**

| File | Change |
|---|---|
| `src/team/conventions.ts` | **NEW** — Convention types and registry |
| `src/team/conventions-validator.ts` | **NEW** — Validate code against conventions |
| `src/agents/agents/writer.ts` | Update — inject active conventions into writer prompt |
| `src/agents/agents/planner.ts` | Update — inject conventions into plan context |
| `src/cli/team.ts` | Update — add `convention` subcommands |
| `tests/team/conventions.test.ts` | **NEW** — 30+ tests |

**Convention Schema:**

```typescript
interface Convention {
  id: string;
  name: string;
  description: string;
  category: 'naming' | 'structure' | 'style' | 'testing' | 'architecture' | 'security';
  scope: {
    languages: string[];
    filePatterns?: string[]; // glob: 'src/**/*.ts'
    excludePatterns?: string[];
  };
  rule: string; // Natural language rule description
  severity: 'error' | 'warning' | 'suggestion';
  examples: {
    good?: string;
    bad?: string;
  };
  autoFix?: boolean;
}
```

**How it works:**
1. Team lead runs `buff team convention add --name "arrow-functions" --category style --rule "Use arrow functions instead of function declarations for callbacks" --lang typescript`
2. Convention is saved to team memory (`~/.buff/team/conventions/`)
3. When WriterAgent generates code, it receives the active conventions in its context: "Follow these conventions: ..."
4. When VerifyModule reviews code, it checks conventions and flags violations
5. Conventions sync across the team via `buff team sync`

**Built-in Convention Packs:**
- TypeScript Best Practices (15 conventions)
- Python PEP 8 (10 conventions)
- Go Best Practices (12 conventions)
- Security Hardening (8 conventions)

**Test plan:** 30+ tests (CRUD, validation, prompt injection, sync)

---

### D3 — Cross-Team Semantic Search (Week 6–8)

**Problem:** Team memory exists but can't be searched semantically across the team. Each member's local trajectories are isolated.

**Solution:** Extend the existing `ChatHistory.searchSemantic()` to search the team memory directory, with a shared embedding index that syncs via git.

**Files:**

| File | Change |
|---|---|
| `src/team/memory.ts` | Update — add `searchTeamMemory()` function |
| `src/team/team-embedder.ts` | **NEW** — Team embedding index (shared, synced) |
| `src/cli/team.ts` | Update — add `search` subcommand |
| `tests/team/memory.test.ts` | Update — 15+ new tests |

**How it works:**
1. `buff team search "how did we implement JWT refresh tokens?"`
2. Searches local team memory directory → also searches shared trajectories
3. Falls back to semantic search if the local embedder is available
4. Results ranked by relevance, showing which team member contributed the trajectory
5. `buff team search --semantic` forces embedding-based search

**Test plan:** 15+ new tests (cross-team search, ranking, embedding sync)

---

### D4 — Team Workspace / Org Management (Week 8–10)

**Problem:** No concept of "org" or "workspace". Multi-repo projects require separate configs.

**Solution:** A `TeamWorkspace` system that manages multi-repo projects, org-level configs, and member roles.

**Files:**

| File | Change |
|---|---|
| `src/team/workspace.ts` | **NEW** — Team workspace (org, repos, members, roles) |
| `src/cli/team.ts` | Update — add `workspace` subcommands |
| `src/config/types.ts` | Update — add `workspace` config section |
| `tests/team/workspace.test.ts` | **NEW** — 25+ tests |

**Workspace Schema:**

```typescript
interface Workspace {
  id: string;
  name: string;
  description?: string;
  repos: RepoDef[];
  members: MemberDef[];
  settings: WorkspaceSettings;
  createdAt: number;
}

interface RepoDef {
  url: string;
  name: string;
  branch: string; // default branch
  conventions: string[]; // convention IDs to apply
  workflows: string[]; // workflow template IDs
}

interface MemberDef {
  name: string;
  email: string;
  role: 'admin' | 'contributor' | 'reviewer';
  gitHubUsername?: string;
  gitLabUsername?: string;
}
```

**CLI Usage:**
```bash
buff team workspace create "MyOrg" --repo https://github.com/org/repo1
buff team workspace add-repo MyOrg https://github.com/org/repo2
buff team workspace add-member MyOrg "alice@example.com" --role admin
buff team workspace show MyOrg
buff execute "refactor shared library" --workspace MyOrg --repo repo1
```

**Integration with Knowledge Graph:**
Each workspace gets a sub-graph in the knowledge graph, enabling cross-repo queries:
- "Find all places where the shared library is imported across all repos"
- "What conventions are used in the API repo vs the frontend repo?"
- "Show me all open PRs across the workspace"

**Test plan:** 25+ tests (workspace CRUD, member management, multi-repo search)

---

### Pillar D — Test Count: ~110 new tests

---

## 7. Dependency Graph

```
┌─────────────────────────────────────────────────────────────────────┐
│  Month 1-2: Pillar A (GitHub/GitLab Integration)                   │
│                                                                     │
│  A1: GitLab API + MR Gen ──────────────────────────────────────┐   │
│  A2: GitHub PR Review    ─── (depends on VerifyModule) ─────┐  │   │
│  A3: Issue Triage         ─── (depends on LLM) ───────────┐ │  │   │
│  A4: Branch Automation   ─── (depends on A2, A3) ───────┐ │ │  │   │
│  A5: Webhook Server      ─── (depends on A2, A3, A4) ─┐ │ │ │  │   │
│                                                            │ │ │ │  │   │
└────────────────────────────────────────────────────────────┘ │ │ │ │   │
                                                               │ │ │ │   │
┌──────────────────────────────────────────────────────────────┐│ │ │ │   │
│  Month 3-5: Pillar B (IDE-Native Experience)                 ││ │ │ │   │
│                                                               ││ │ │ │   │
│  B1: VS Code Chat Panel       ──────────────────────────┐    ││ │ │ │   │
│  B2: Streaming in Panel       ─── (depends on B1) ───┐ │    ││ │ │ │   │
│  B3: Diagnostic → AI Fix      ───────────────────────│ │    ││ │ │ │   │
│  B4: JetBrains Extension      ─── (depends on CLI) ──│ │ ───││ │ │ │   │
│  B5: Code Lens / Gutter       ─── (depends on B1) ───│ │    ││ │ │ │   │
│  B6: Chat Panel v2 (DAG)     ─── (depends on B1) ────│─│───││ │ │ │   │
└──────────────────────────────────────────────────────────────┘│ │ │ │ │ │
                                                               │ │ │ │ │ │
┌──────────────────────────────────────────────────────────────┐│ │ │ │ │ │
│  Month 4-6: Pillar C (Remote Execution)                      ││ │ │ │ │ │
│                                                               ││ │ │ │ │ │
│  C1: SSH Execution Engine     ───────────────────────────┐   ││ │ │ │ │ │
│  C2: Cloud VM Orchestrator    ─── (depends on C1) ────┐  │   ││ │ │ │ │ │
│  C3: Remote Repo Sandboxing   ─── (depends on C1, A1) │  │   ││ │ │ │ │ │
│  C4: VS Code Remote SSH       ─── (depends on B1, C1) │  │   ││ │ │ │ │ │
└──────────────────────────────────────────────────────────┘  │   ││ │ │ │ │
                                                             │   ││ │ │ │ │
┌───────────────────────────────────────────────────────────┐│   ││ │ │ │ │
│  Month 5-7: Pillar D (Team Memory & Shared Context)       ││   ││ │ │ │ │
│                                                            ││   ││ │ │ │ │
│  D1: Knowledge Graph Engine     ───────────────────────┐  ││   ││ │ │ │ │
│  D2: Team Conventions System    ─── (depends on D1) ─┐ │  ││   ││ │ │ │ │
│  D3: Cross-Team Semantic Search ─── (depends on D1) ─│ │  ││   ││ │ │ │ │
│  D4: Team Workspace / Org Mgmt  ─── (depends on D2, A1)│  ││   ││ │ │ │ │
└───────────────────────────────────────────────────────────┘  ││   ││ │ │ │
                                                              ││   ││ │ │ │
┌────────────────────────────────────────────────────────────┐││   ││ │ │ │
│  Month 7-9: Polish & Scale                                  │││   ││ │ │ │
│                                                              │││   ││ │ │ │
│  Performance tuning, bug fixes, docs, website updates       │││   ││ │ │ │
│  Knowledge graph ↔ IDE integration (context-aware chat)    │││   ││ │ │ │
│  JetBrains marketplace publish + VS Code marketplace update│││   ││ │ │ │
│  Public roadmap + changelog maintenance                     │││   ││ │ │ │
└──────────────────────────────────────────────────────────────┘│││   ││ │ │
```

---

## 8. Engineering Team Sizing

| Pillar | Estimated Effort | Recommended Team |
|---|---|---|
| **A: GitHub/GitLab** | 6–8 weeks | 1 senior TS dev + 1 mid-level |
| **B: IDE-Native** | 8–12 weeks | 2 full-stack TS devs + 1 Kotlin dev (B4) |
| **C: Remote Exec** | 8–10 weeks | 2 backend TS devs |
| **D: Team & Context** | 8–12 weeks | 1 senior TS dev + 1 data/ML dev (D1) |
| **Total** | **6–9 months** | **5–6 engineers** |

**Parallelization:** Pillars A, B, C can run in parallel with different teams. Pillar D starts in Month 5 (after A1-3 complete) because it depends on GitLab/PR agents.

---

## 9. Success Metrics & OKRs

### OKR Set 1: Release 1 (Month 3) — "GitHub/GitLab Native"

| Key Result | Target | Measurement |
|---|---|---|
| GitLab MR creation from agent | ✅ 100% of agent-generated changes can be pushed as MRs | Manual test |
| PR review comments posted | ✅ 15+ real PRs reviewed with inline comments | Manual QA |
| Issue triage accuracy | ≥ 80% classification matches human triage | A/B test on 100 issues |
| Branch automation success rate | ≥ 90% of triggered events create correct branches | Automated metrics |

### OKR Set 2: Release 2 (Month 5) — "IDE-Native Power"

| Key Result | Target | Measurement |
|---|---|---|
| Chat panel DAU (VS Code) | ≥ 50 active users | Telemetry |
| Diagnostic → AI fix acceptance | ≥ 40% of suggested fixes are accepted | Telemetry |
| JetBrains extension downloads | ≥ 100 installs | Marketplace |
| Inline suggestion acceptance rate | ≥ 25% of shown suggestions are accepted | Telemetry |

### OKR Set 3: Release 3 (Month 7) — "Remote Everything"

| Key Result | Target | Measurement |
|---|---|---|
| SSH execution success rate | ≥ 95% of commands succeed | Automated test |
| Cloud VM provisioning time | ≤ 5 minutes (EC2 t3.medium) | Manual test |
| Repo sandbox cleanup success | 100% — no orphaned temp dirs | Automated test |
| Remote SSH extension compatibility | ✅ Works with VS Code Remote SSH | Manual test |

### OKR Set 4: Release 4 (Month 9) — "Team Intelligence"

| Key Result | Target | Measurement |
|---|---|---|
| Knowledge graph nodes created | ≥ 500 after 1 week of team use | Automated metrics |
| Convention violation detection | ≥ 80% of violations caught | Manual audit on 50 files |
| Cross-team search relevance (top 3) | ≥ 80% of queries have relevant result in top 3 | Manual evaluation |
| Workspace admin satisfaction | ≥ 4/5 NPS | Survey |

---

## 10. Risk Matrix

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| **GitLab API changes** | Low | Medium | Pin to API v4, write integration tests |
| **VS Code API deprecations** | Low | Medium | Target stable APIs, update every VS Code release |
| **JetBrains SDK complexity** | Medium | High | Start with 80% feature parity, iterate |
| **SSH2 npm package limitations** | Medium | Medium | Build native `ssh` subprocess fallback |
| **Cloud VM costs** | Medium | Medium | Enforce timeouts, destroy-on-exit, cost alerts |
| **Knowledge graph becomes too complex** | Medium | High | Start simple (SQLite + adjacency), optimize later |
| **Team adoption friction** | High | Medium | Provide migration scripts from flat files → graph |
| **API rate limiting** | High | Low | Implement exponential backoff, queuing |

---

## Summary

**Phase A (Month 1-2):** GitLab parity + GitHub PR review + Issue triage + Branch automation  
**Phase B (Month 3-4):** Chat panel + Streaming + Diagnostic fixes + JetBrains extension  
**Phase C (Month 4-5):** SSH execution + Cloud VMs + Repo sandboxing + VS Code Remote  
**Phase D (Month 5-7):** Knowledge graph + Conventions + Cross-team search + Workspaces  
**Phase E (Month 7-9):** Polish + Scale + Marketplace publishing

**Total new files:** ~35 source files + ~6 test files  
**Total new tests:** ~485  
**Total engineering effort:** 5–6 developers × 6–9 months  
**Version bump:** v1.60.0+ across releases

---

*Last updated: July 2026*
