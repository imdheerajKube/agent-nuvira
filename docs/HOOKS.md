# Hooks — the declarative lifecycle contract

**Status:** implemented · dashboard surface at `/hooks` · CLI surface at `nuvira hooks` · runtime in `src/gateway/hook-contract.ts`
**Decision recorded in:** `docs/DESIGN-skill-plugin-ecosystem.md` §5.2 / §6 (model C — a bounded, native hook contract)

This document answers three questions: **what is a hook here**, **how does it
work**, and **why is it safe to expose to an operator**. It is the reference for
the dashboard page and for anyone porting a Claude Code–style plugin hook.

---

## 1. Positioning — a hook is a RULE, not code

Third-party plugins in the Claude Code ecosystem ship hooks (`SessionStart`,
`PreToolUse`, …) that **run their own code**. nuvira deliberately does not have
that. Running a plugin's script at a lifecycle moment is a remote-code-execution
surface, and it is the reason Ponytail/RTK cannot be installed directly (see the
design doc §5.2).

What nuvira has instead is a **declarative hook**: a rule an operator writes on
the dashboard, bound to one of nuvira's own lifecycle seams, with a **fixed
allow-list of native actions**. A declaration is data — JSON on disk. It can
never invoke a shell, load a module, reach the network, or read a credential.

The contract is deliberately the *safe half* of the design doc's model C: the
content and the seam are pluggable; the behaviour is not arbitrary.

---

## 2. The contract

```jsonc
{
  "id": "block-rm-rf",            // slug, unique. ^[a-z0-9][a-z0-9-]{0,63}$
  "label": "Block rm -rf",        // human label
  "event": "before_tool_call",    // one of the four seams below
  "enabled": true,
  "when": {                       // optional matcher; absent = every call
    "tool": "run_terminal",       // glob over the tool name (`edit_*`, `*`)
    "surface": "cli-chat",        // glob over the surface label
    "cwdPrefix": "/work/proj",    // prefix match on the working directory
    "argsMatch": { "command": "rm -rf*" } // shallow arg name → glob
  },
  "action": { "kind": "deny", "reason": "destructive command" }
}
```

Declarations live at **`<config-dir>/hooks.json`** (honours `NUVIRA_CONFIG_DIR`,
next to `contacts.json`). The dashboard's `/hooks` page reads and writes the same
file the runtime reads.

### The four seams

| Seam | Fires | Actions available |
|---|---|---|
| `before_tool_call` | before a tool call runs | `deny`, `notify`, `scan-args` |
| `after_tool_call` | after a tool call succeeds | `notify`, `scan-args` |
| `failed_tool_call` | after a tool call fails | `notify`, `scan-args` |
| `on_session_end` | when a pipeline run finishes | `notify` |

`deny` on a seam that cannot stop a call is **rejected at save time**, not
silently ignored. `scan-args` on `on_session_end` (no call to scan) is rejected
too. A rejected save is a 400 and the previously-saved set stays in force.

### The action allow-list (the entire power of a hook)

| Action | What it does |
|---|---|
| `deny` | Stops the call. `before_tool_call` only. The reason flows to the model and the trace. |
| `notify` | Writes a log line. `{tool}` / `{surface}` / `{event}` are interpolated. |
| `scan-args` | Runs the local secret scanner over the call's arguments (or the tool result). With `denyOnHit`, a hit on `before_tool_call` blocks the call. Values are masked. |

There is no `run-command`, no `script`, no `mcp`, no `write`. Adding one would
mean adding a member to `HookAction` **and implementing it natively** — that is
the only way to give hooks a new capability, by design.

---

## 3. How it works (request path)

```
tool loop ──► hooks.runBefore(ctx)            [src/gateway/hooks.ts]
                   │
                   ├─ internal handlers (e.g. tools.hooks commands)
                   └─ the declarative handler        [src/gateway/hook-contract.ts]
                          │
                          ├─ read getHookDeclarations()   (live, from memory)
                          ├─ keep declarations whose event matches
                          ├─ test each `when` matcher
                          └─ apply the action:
                               deny       → return { deny: true, by: "hook:<id>" }
                               notify     → log + ctx.report(...)
                               scan-args  → scanText(args|result) → maybe deny
```

Key properties:

- **First denial wins.** Declarations are evaluated in order; the first `deny`
  (or a `scan-args` hit with `denyOnHit`) stops the walk and is returned to the
  tool loop, which does not run the call.
- **Live edits.** One handler per seam is registered once. It reads the current
  declarations on every call, so a dashboard save is in force on the *next* tool
  call — no restart, no re-registration.
- **Fail open.** Exactly like the underlying registry, a throwing handler is
  reported and skipped, never fatal. A broken rule must not take down the loop.
- **Idempotent install.** `installDeclaredHooks(registry)` registers once per
  registry instance, so importing the gateway twice cannot double-fire hooks.
- **One pattern source of truth.** `scan-args` reuses `scanText` from
  `src/security/secret-scan.ts`, the same detector the `secret_scan` tool and the
  git-history scan use.

---

## 4. Why it is safe to expose

1. **No code execution.** The action set is a fixed union of three native
   behaviours. There is no path from a declaration to a subprocess.
2. **No credentials.** A hook sees a tool *name*, a shallow matcher over the
   caller's args, and a result preview — never a provider credential. `scan-args`
   *masks* every value it reports.
3. **Deterministic and bounded.** Matching is global-glob and shallow; there is
   no regex-from-user, no eval, no unbounded walk.
4. **Reversible.** Deleting the declaration (or `enabled: false`) is immediate.
5. **Gated writes.** Reads are open; writes require `routing.operate` (admin or
   operator), the same capability every other config write uses.

---

## 5. Using it

### Dashboard

Open **Agent Management → Hooks**. The page lists every declaration with a
readable summary, shows the four seams and the three actions, and lets an
admin/operator add, enable/disable, remove and Save. Nothing is in force until
**Save hooks** is pressed — the form builds a draft.

Built-in starter hooks are shown with a `builtin` chip and cannot be deleted
(they are code-owned defaults); disable one to switch it off.

### CLI

`nuvira hooks` is the same contract and the same `hooks.json`, from the terminal:

```bash
nuvira hooks list                       # built-in + user hooks, with state
nuvira hooks add --id no-force-push --label "No force push" \
  --event before_tool_call --action deny \
  --tool run_terminal --arg "command=*git push --force*" --reason "no force push"
nuvira hooks enable builtin-block-rm-rf # turn a built-in ON (persists it)
nuvira hooks disable builtin-block-rm-rf
nuvira hooks remove no-force-push        # remove a user hook
```

`add` flags mirror the dashboard form (`--event`, `--action`, `--tool`,
`--surface`, `--cwd`, repeatable `--arg key=glob`, `--reason`, `--message`,
`--deny-on-hit`, `--disabled`). A hook is enabled on add unless `--disabled` is
given, matching the dashboard. `enable`/`disable` work on a built-in by
materializing it into the file, which is how the runtime (which follows the user
set) starts enforcing it.

### File

Edit `<config-dir>/hooks.json` directly:

```json
{
  "version": 1,
  "hooks": [
    {
      "id": "warn-on-shell-edit",
      "label": "Warn when a secret shape is written",
      "event": "before_tool_call",
      "enabled": true,
      "when": { "tool": "write_file" },
      "action": { "kind": "scan-args", "denyOnHit": true, "reason": "secret-shaped value in write_file" }
    }
  ]
}
```

The runtime picks it up on the next process start (or the next dashboard save,
which reloads in memory).

### Built-in starter hooks

These ship with nuvira, **DISABLED** — nothing changes until an operator enables
one (dashboard toggle → Save, or `nuvira hooks enable <id>`). They are code-owned
defaults merged into what the dashboard/CLI DISPLAY; enabling one writes it into
`hooks.json`.

| id | event | when | action | why |
|---|---|---|---|---|
| `builtin-block-rm-rf` | `before_tool_call` | `tool: run_terminal`, `argsMatch: {command: "*rm -rf*"}` | `deny` | deletes a tree irreversibly |
| `builtin-scan-writes-for-secrets` | `before_tool_call` | `tool: write_file` | `scan-args` `denyOnHit` | stops a key being written into source |
| `builtin-scan-terminal-args-for-secrets` | `before_tool_call` | `tool: run_terminal` | `scan-args` | flags a key pasted into a command |
| `builtin-notify-tool-failures` | `failed_tool_call` | — | `notify` | one audit line per failure |

A user declaration with the same id overrides a built-in (so you can widen
`builtin-block-rm-rf` to also match `edit_file`, or relax its matcher).

---

## 6. Relationship to other surfaces

- **`tools.hooks` / `ProcessEnvPage` tool hooks** — those run an operator-supplied
  *command* around every tool call (`NUVIRA_TOOL_HOOK_BEFORE=node hook.mjs`). They
  are the *code* path, intentionally separate and more powerful. The declarative
  hooks here are the *safe, no-code* path; both feed the same registry.
- **Secret scanner** — `secret_scan` (with `history: true`) and the hook
  `scan-args` action share `src/security/secret-scan.ts`.
- **`secret_scan`** is a tool the model calls on demand; a hook is a rule that
  fires automatically. Pick by whether you want the model to decide or to always
  enforce.

---

## 7. Extending the contract

To add a capability, in order:

1. Add a member to `HookAction` in `src/gateway/hook-contract.ts`.
2. Implement it natively in `applyHookDeclaration` — no subprocess, no network.
3. Describe it in `HOOK_ACTION_DESCRIPTIONS` (the dashboard renders this verbatim).
4. Add cross-field rules to `validateHookDeclaration` if the action is only valid
   on some seams.
5. Add tests to `tests/gateway/hook-contract.test.ts` (and the page/API tests if
   the UI changes).

Nothing else grants a hook power — the union *is* the contract.
