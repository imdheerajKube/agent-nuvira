# Using Agent-Nuvira in VS Code

> **What this page is for:** install, first run, every command and setting, how to
> use the extension from Copilot Chat and from another extension's code, and an
> explicit statement of what the editor surface can and cannot do. The
> [depth section](#what-depth-you-actually-get) is the one to read before you
> promise a teammate something.

The extension is **not a second implementation**. It is an editor surface for
the same agent engine as the CLI: every action spawns `agent-nuvira` as a child
process, so routing, the quota ledger, memory, skills and the model registry are
shared with whatever you run in a terminal. If a goal works from
`npx agent-nuvira execute "…"`, it works from the extension, and vice versa.

- **Extension:** `dheerajsharma.agent-nuvira-vscode` (Marketplace and
  Open VSX), version `3.3.5`
- **Requires:** VS Code `>= 1.85.0`, Node `>= 18`, and the `agent-nuvira` CLI
- **Same version number as the CLI**, so "the extension says 3.3.5, the CLI says
  3.3.5" is the whole compatibility question.

---

## 1. Install

```bash
code --install-extension dheerajsharma.agent-nuvira-vscode
```

Or: Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`) → search **Agent-Nuvira** →
Install. Offline installs can use the `.vsix` from the Marketplace or Open VSX
version history:

```bash
code --install-extension agent-nuvira-vscode.vsix
```

**The CLI is a prerequisite**, because it *is* the engine:

```bash
npm install -g agent-nuvira
```

If `agent-nuvira` is not on your `PATH`, point the extension at it — this is the
first thing to check when nothing works:

```jsonc
// .vscode/settings.json or user settings
{
  "agent-nuvira.cliPath": "/usr/local/bin/agent-nuvira"
}
```

On Windows the CLI may resolve as `npx.cmd`; the extension handles the `npx`
prefix itself, so `"agent-nuvira.cliPath": "npx"` works for a local install.

---

## 2. First run (the 4-step walkthrough)

The Welcome tab's **Get started with Agent-Nuvira** walkthrough walks the same
four steps, and ticks each one off when you run the command it names:

| Step | Do this | Completes when |
|---|---|---|
| 1. Install the CLI | `npm install -g agent-nuvira` | you run **Check Model Health** |
| 2. Configure a provider | set a key (below) or pick one via **Switch Model / Provider** | you run that command |
| 3. Run a goal | **Agent-Nuvira: Execute Goal** | you run it |
| 4. Open the chat | **Agent-Nuvira: Open Chat** | you run it |

Configure a provider — either in the CLI, which the extension then reads:

```bash
agent-nuvira config set defaultProvider groq
export GROQ_API_KEY=gsk_your_key_here
```

…or per-workspace in VS Code settings (`Ctrl+,` → search `agent-nuvira`):

```jsonc
{
  "agent-nuvira.defaultProvider": "groq",
  "agent-nuvira.defaultModel": "llama-3.3-70b-versatile",
  "agent-nuvira.useAutoRouting": false
}
```

Then run something:

1. `Ctrl+Shift+P` → **Agent-Nuvira: Execute Goal**
2. Type a goal in plain language — *"Add pagination to the /users endpoint and test it"*
3. Watch the agent progress panel; proposed edits open in VS Code's native diff
   editor, and you accept or reject them.

---

## 3. Commands

All 13, with the exact ids (useful for keybindings and for scripting):

| Command (palette) | Id | What it runs underneath |
|---|---|---|
| Agent-Nuvira: Execute Goal… | `agent-nuvira.executeGoal` | `execute "<goal>"` |
| Agent-Nuvira: Quick Fix | `agent-nuvira.quickFix` | `edit <relative path> --quick` |
| Agent-Nuvira: Review File | `agent-nuvira.reviewFile` | `execute "Review the file <path> for bugs, security issues, and improvements…"` |
| Agent-Nuvira: Explain Code | `agent-nuvira.explainCode` | `chat "Explain the following <lang> in detail: …" --stream` |
| Agent-Nuvira: Generate Test | `agent-nuvira.generateTest` | `execute "Generate comprehensive unit tests for the code in <path>…"` |
| Agent-Nuvira: Open Chat | `agent-nuvira.openChat` | chat webview |
| Agent-Nuvira: Show Agent Panel | `agent-nuvira.showPanel` | progress webview |
| Agent-Nuvira: Run Workflow… | `agent-nuvira.runWorkflow` | `workflow run <template> "<goal>"` |
| Agent-Nuvira: Accept All Changes | `agent-nuvira.acceptChanges` | applies the pending diff |
| Agent-Nuvira: Reject All Changes | `agent-nuvira.rejectChanges` | discards the pending diff |
| Agent-Nuvira: Switch Model / Provider… | `agent-nuvira.switchModel` | `model list --all --json`, then the switch |
| Agent-Nuvira: Check Model Health | `agent-nuvira.modelHealth` | `model health` for the active provider |
| Agent-Nuvira: Show Quota Ledger | `agent-nuvira.showQuota` | the ledger webview |

When **auto routing** is on, the request gains `--auto-route` for `execute`
commands and `--model auto` for chat and inline suggestions. With it off, the
extension appends your configured `--provider` / `--model` instead. That switch
is the whole difference — nothing else about the command changes.

### Default keybindings

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+A E` | Execute Goal |
| `Ctrl+Shift+A Q` | Quick Fix |
| `Ctrl+Shift+A R` | Review File |
| `Ctrl+Shift+A C` | Open Chat |
| `Ctrl+Shift+A P` | Show Agent Panel |
| `Ctrl+Shift+A A` | Accept All Changes (`when: agent-nuvira.hasChanges`) |
| `Ctrl+Shift+A X` | Reject All Changes (`when: agent-nuvira.hasChanges`) |

On macOS these are `Cmd+Shift+A …`. Explain Code, Generate Test, Run Workflow,
Switch Model and Show Quota Ledger have **no default binding** — that is
deliberate, since they are less frequent and `Ctrl+Shift+A` is a crowded prefix.
Bind your own:

```jsonc
// keybindings.json
{
  "key": "ctrl+shift+a t",
  "command": "agent-nuvira.generateTest",
  "when": "editorTextFocus"
}
```

### Right-click menus

| Where | Shows |
|---|---|
| Explorer | Review File, Quick Fix, Generate Test (source-file extensions only) |
| Editor | Explain Code (only with a selection), Quick Fix, Generate Test |
| Editor title | Review File |

---

## 4. Settings

| Setting | Default | What it does |
|---|---|---|
| `agent-nuvira.cliPath` | `"agent-nuvira"` | Path to the CLI executable. Set this when the CLI is not on `PATH` |
| `agent-nuvira.defaultProvider` | `""` | Provider override; empty means "use the CLI's config" |
| `agent-nuvira.defaultModel` | `""` | Model override; empty means the provider default |
| `agent-nuvira.autoApplyChanges` | `false` | Apply edits without the diff preview. Off is the safe default |
| `agent-nuvira.maxTokens` | `4096` | Max tokens per agent response |
| `agent-nuvira.showProgressPanel` | `true` | Auto-open the progress panel when a task starts |
| `agent-nuvira.useAutoRouting` | `false` | Route each request to the best provider/model per task (chat, execute, inline suggestions, code-lens actions, diagnostic fixes) |

Changing any of these takes effect immediately — the extension rebuilds its CLI
manager on the configuration-change event, so no window reload is needed.

---

## 5. Editor-native features

- **Inline suggestions** — debounced (800 ms), context-aware completions from
  whichever provider is active. **Latency note:** with auto routing on, each
  suggestion may consult a different model; if completions feel slow, pin a fast
  provider instead.
- **Code lenses** — a `✨ AI: <name>` lens above functions and classes with a
  quick-pick menu (Test / Review / Explain / Quick Fix).
- **Diagnostic quick fix** — a *Fix with Agent-Nuvira* lightbulb on a
  diagnostic, with the proposed change previewed in the diff editor before it is
  applied.
- **Agent progress panel** — agent-by-agent status, live streamed output, and
  a pipeline DAG render for multi-agent runs.
- **Chat panel** — multi-turn chat with streaming, slash commands
  (`/fix`, `/review`, `/test`, `/explain`, `/workflow`, `/help`), file context,
  code blocks with "Apply to File", persisted history, and a provider/model
  dropdown in the header that switches without leaving the chat.
- **Quota ledger view** — free vs paid token usage, estimated savings,
  per-provider windows, parked providers, and the failover timeline. It watches
  the same memory directory the CLI writes, so a failover caused by a terminal
  run appears without pressing Refresh (with a 60 s poll as the safety net where
  file watching is unreliable).
- **Output channel** — activation and errors go to a dedicated **Agent-Nuvira**
  channel (View → Output → Agent-Nuvira) rather than `console`.
- **Status bar** — a readiness indicator, a model/provider indicator you can
  click to switch, and a quota indicator that shows parked-provider alerts.

---

## 6. Use it from Copilot Chat (language model tools)

Three tools let the model *inside your editor* call Agent-Nuvira. They appear in
VS Code's tool list under the `#` reference names — and only on VS Code versions
that expose the `vscode.lm` tool API; older versions simply don't show them.

| Tool id | `#` reference | Inputs |
|---|---|---|
| `agent-nuvira_reviewFile` | `#reviewFileWithAgentNuvira` | `filePath` (optional — defaults to the active editor's file) |
| `agent-nuvira_explainSelection` | `#explainWithAgentNuvira` | `code` (optional — defaults to the current selection) |
| `agent-nuvira_executeGoal` | `#executeGoalWithAgentNuvira` | `goal` (**required**) |

Example prompts in Copilot Chat:

```text
#reviewFileWithAgentNuvira review this file before I open the PR

#explainWithAgentNuvira what does this regex do, and what input breaks it?

#executeGoalWithAgentNuvira extract the retry logic in src/api.ts into a tested helper
```

Two behaviours worth knowing, because they decide when a tool runs:

- The model descriptions tell the model *when* to reach for each one: review is
  for "a specific file or the active file", explain for "what a piece of code
  does", and execute for "substantial tasks that require editing multiple files
  or running commands". A small question will not normally trigger the pipeline.
- **Every failure is returned as text the model can read**, not thrown — a
  missing CLI or an expired key arrives as `Agent-Nuvira failed (exit …): …`
  rather than an opaque chat error, so the model can tell you what broke.

---

## 7. Drive it from another extension (public API)

`activate()` returns a small, explicit, compatibility-promising object, also
reachable as `extension.exports`:

```ts
interface AgentNuviraApi {
  readonly version: string;                     // from the manifest
  readonly commands: readonly string[];         // the 13 ids above
  openChat(): void;
  executeGoal(goal: string): Promise<CLIResult>;
  getActiveModel(): Promise<ActiveModelInfo | null>;   // null when none chosen
  getQuotaStatus(): Promise<QuotaStatusInfo>;
}
```

A complete example — publish this as its own extension:

```ts
import * as vscode from 'vscode';

interface AgentNuviraApi {
  readonly version: string;
  readonly commands: readonly string[];
  openChat(): void;
  executeGoal(goal: string): Promise<{ success: boolean; stdout: string; stderr: string; exitCode?: number }>;
  getActiveModel(): Promise<{ provider: string; model: string } | null>;
  getQuotaStatus(): Promise<{ freeTokens: number; paidTokens: number; estimatedSavedUsd: number }>;
}

export async function activate() {
  const ext = vscode.extensions.getExtension<AgentNuviraApi>('dheerajsharma.agent-nuvira-vscode');
  if (!ext) {
    vscode.window.showWarningMessage('Agent-Nuvira is not installed.');
    return;
  }
  // activates if needed — never assume another extension is already active
  const nuvira = ext.isActive ? ext.exports : await ext.activate();

  vscode.commands.registerCommand('myExt.auditAndOpenChat', async () => {
    const active = await nuvira.getActiveModel();
    if (!active) {
      vscode.window.showInformationMessage('Pick a provider first.'); // e.g. via nuvira.commands
      return;
    }

    const quota = await nuvira.getQuotaStatus();
    const run = await nuvira.executeGoal('audit this workspace for hardcoded secrets');

    if (!run.success) {
      vscode.window.showErrorMessage(`Agent-Nuvira failed: ${run.stderr || run.stdout}`);
      return;
    }
    nuvira.openChat();  // continue the conversation in the real panel
  });
}
```

The `version` field is what you version-check against; `commands` is the
canonical id list (the extension's own end-to-end suite asserts that every id
here is genuinely registered in a real editor, so it is safe to `executeCommand`
against any of them).

---

## 8. Attribution: where your IDE usage shows up

Every model call the extension drives is written through to the CLI's model
registry **with its own action tag**, passed as `BUFF_TELEMETRY_ACTION` at spawn:

| Action | Tag |
|---|---|
| Chat panel | `ide-chat` |
| Inline suggestions | `ide-inline` |
| Everything else | `ide-<command>` (e.g. `ide-execute`, `ide-edit`, `ide-workflow`) |

So IDE usage gets its own rows in `nuvira models status --verbose` and the
dashboard's Models panel, and a provider that an IDE action proved dead is
skipped predictively by every other action — CLI included — until a real success
re-verifies it.

---

## 9. What depth you actually get

**You get:**

- **The whole engine, not a subset.** The extension has no separate agent
  implementation to drift: each action is a thin, reviewable mapping onto a CLI
  verb (the table in §3), so a capability added to the CLI is available here on
  the same version number.
- **Editor-native review before apply.** Proposed edits open in VS Code's diff
  editor; `autoApplyChanges` is off by default.
- **Two-way integration with the editor's own model** — the LM tools let Copilot
  Chat delegate to Agent-Nuvira's reviewer/explainer/pipeline and read the result
  back as ordinary text.
- **A programmatic API** small enough to be a real promise, with `version`,
  `commands`, `openChat`, `executeGoal`, `getActiveModel`, `getQuotaStatus`.
- **Localization** — manifest and runtime strings go through
  `package.nls.json` (70 keys) plus an `l10n/` bundle, drift-checked by
  `npm run l10n:check`, so a translated build does not leave untranslated
  settings descriptions behind.
- **Honest workspace declarations** — untrusted and virtual workspaces are
  declared `limited`, so VS Code states the restriction instead of concealing it.

**You do not get:**

- **Any capability the CLI does not have.** The extension adds no agent, no
  provider and no routing rule. It is a surface.
- **A chat that survives without the CLI.** Every action is a child process; a
  missing or mis-pathed CLI breaks everything, and the first diagnostic is
  always `agent-nuvira.cliPath`.
- **Dashboard webviews inside the editor.** The Agent-Nuvira dashboard
  (trace viewer, inbox, models panel, subagents) is a separate web surface —
  `nuvira dashboard`.
- **The dashboard's support-bundle download.** That lives in the dashboard's
  chat; the extension's chat has file attachments but not the bundle action.
- **Inline completions on every language.** The provider is registered for the
  source extensions listed in §3's menus (`ts, js, tsx, jsx, py, go, rs, java,
  rb, php, c, cpp, h, hpp, cs, swift, kt, scala, vue, svelte, mjs, cjs`) — a
  language outside that set gets no suggestions.
- **Sub-agent isolation or resume controls.** Those are CLI/dashboard features
  (`--worktree`, `--resume`); the extension does not surface them.
- **A stable API beyond `AgentNuviraApi`.** Anything not exported from
  `activate()` is internal and may change between versions.

---

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Agent-Nuvira CLI not found" | `agent-nuvira` is not on `PATH`. Set `agent-nuvira.cliPath` to the absolute path |
| Commands do nothing, no error | Check the **Agent-Nuvira** output channel (View → Output) — activation errors are logged there, not to a toast |
| "needs a provider" / every call 404s | No provider configured. `agent-nuvira config set defaultProvider <p>` and export the key, or set `agent-nuvira.defaultProvider` |
| Model health shows ⚠️ unreachable | Key missing/invalid for that provider. Use **Switch Model / Provider** — the status icons mark ✅ available, ⚠️ unreachable, ⏳ needs key |
| A provider is parked and never used | It was killed by a real failure. `nuvira models unblock <provider>`, or open the Quota Ledger to see the failover timeline |
| Inline suggestions feel slow | Auto routing is on. Pin a fast provider, or turn `agent-nuvira.useAutoRouting` off |
| No `#reviewFileWithAgentNuvira` in chat | Your VS Code predates the `vscode.lm` tool API. The tools are feature-detected and silently absent, never broken |
| Panel says "running" forever | Refresh; a long pipeline can outlast a poll interval. The CLI's own `nuvira session list` shows the run |
| Edits applied without asking | `agent-nuvira.autoApplyChanges` is on. Set it to `false` |

---

## 11. Developing the extension

Source lives in `vscode-extension/`.

```bash
cd vscode-extension
npm install
npm run compile        # tsc + copy webview assets into out/
npm test               # vitest unit suite
npm run lint           # tsc --noEmit
npm run l10n:check     # fails on an unresolved placeholder or a dead key
npm run test:e2e       # downloads a real VS Code, activates the extension
```

The e2e suite is the one that catches what unit tests cannot: it asserts every
manifest-contributed command is really registered, every `package.nls.json`
placeholder resolves, and the activity-bar icon exists on disk.

To package and publish:

```bash
npm run package            # → agent-nuvira-vscode.vsix
npm run publish            # Marketplace (needs a VSCE_PAT)
npm run publish:openvsx    # Open VSX (needs an OVSX_PAT)
```

The version number is kept equal to the CLI's; the extension's own `CHANGELOG.md`
(in `vscode-extension/`) records what shipped alongside each CLI release.

## License

MIT
