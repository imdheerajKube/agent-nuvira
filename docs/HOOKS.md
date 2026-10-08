# Hooks — the declarative lifecycle contract

**Status:** implemented · dashboard surface at `/hooks` · CLI surface at `nuvira hooks` · runtime in `src/gateway/hook-contract.ts`
**Decision recorded in:** `docs/DESIGN-skill-plugin-ecosystem.md` §5.2 / §6 (model C — a bounded, native hook contract)

This document answers three questions: **what is a hook here**, **how does it
work**, and **why is it safe to expose to an operator**. It is the reference for
the dashboard page and for anyone porting a Claude Code–style plugin hook.
**§8 is the cookbook** — if you are here to *use* hooks rather than understand
them, start there: it lists what each action can achieve and gives copy-pasteable
examples for both the CLI and the dashboard.

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

---

## 8. Recipes — what you can actually achieve

This section is the practical half of the document: the four seams, the three
actions, and the concrete jobs they let an operator do without writing a line of
code. Every example is copy-pasteable, and each one is given for **both
surfaces** (the CLI and the dashboard) because they write the very same file.

### 8.1 The matcher, precisely (read this before writing a rule)

The `when` block is the only part that decides *which* calls a hook applies to,
and its limits are deliberate. Getting these five points wrong is the usual
reason a hook "does nothing":

1. **`tool` and `argsMatch` are GLOBS, and the only wildcard is `*`.** Matching is
   case-insensitive and anchored at both ends. `run_*` matches `run_terminal`;
   `*push*` matches anywhere. There is **no `?` and no regex** — `?` is treated as
   a literal character, so `file?.txt` will not do what you expect.
2. **`argsMatch` looks at TOP-LEVEL tool arguments only**, comparing the
   stringified value against the glob. It does not walk nested objects, so
   `argsMatch: { "when.tool": "…" }` never matches. For a non-string argument
   the value is JSON-stringified first.
3. **A missing or empty argument matches only a bare `*`.** `argsMatch: {command:
   "*rm -rf*"}` therefore does *not* fire on a `run_terminal` call that carries no
   `command` at all — which is the behaviour you want, but is worth knowing when a
   rule seems quiet.
4. **`cwdPrefix` is the WORKING DIRECTORY, not a file path.** This is the single
   most common misreading. To protect a *file*, match the tool's own path
   argument (`--tool write_file --arg "path=*.env"`), not `cwdPrefix`.
5. **All the `when` fields are AND-ed.** An absent field matches anything, so a
   hook with no `when` at all applies to every call of its seam.

The action has two cross-field rules, both enforced at **save time** (a rejected
save is a 400 and the previously-saved set stays in force — nothing is silently
ignored):

- `deny` is valid **only** on `before_tool_call`. The other three seams run too
  late to stop a call, so `deny` there is refused with a message saying so.
- `scan-args` needs a tool call, so it is refused on `on_session_end`.

**Order matters, and the first denial wins.** Declarations are evaluated in file
order — built-ins first, then your own — and the first `deny` (or a `scan-args`
hit with `denyOnHit`) stops the walk. A `notify` placed *before* a `deny` on the
same seam still logs, which is how you record an attempt you are also blocking.

### 8.2 Recipes by goal

#### Deny — hard guardrails (`before_tool_call` only)

**Block a destructive shell command.** The shipped starter, for reference:

```bash
nuvira hooks enable builtin-block-rm-rf        # tool run_terminal, command=*rm -rf* → deny
```

**Refuse a force-push.** Match the command, not the directory:

```bash
nuvira hooks add --id no-force-push --label "No force push" \
  --event before_tool_call --action deny \
  --tool run_terminal --arg "command=*git push --force*" \
  --reason "force-push rewrites shared history — push a branch and open a PR instead"
```

**Block an irreversible database statement:**

```bash
nuvira hooks add --id no-drop-table --label "No DROP TABLE" \
  --event before_tool_call --action deny \
  --tool run_terminal --arg "command=*DROP TABLE*" \
  --reason "schema changes go through a migration"
```

**Protect a class of FILES.** Here the matcher is the tool's own `path`
argument — *not* `cwdPrefix` (see §8.1 point 4):

```bash
nuvira hooks add --id no-env-writes --label "Never write .env files" \
  --event before_tool_call --action deny \
  --tool write_file --arg "path=*.env" \
  --reason "secrets belong in the environment, not in the repo"
```

On the dashboard the same rule is **Add a hook → Seam `before_tool_call`, Action
`deny`, Tool glob `write_file`, Arg match `path=*.env`** → **Add to draft** →
**Save hooks**.

The equivalent `hooks.json` entry, for the file-based path:

```json
{
  "id": "no-env-writes",
  "label": "Never write .env files",
  "event": "before_tool_call",
  "enabled": true,
  "when": { "tool": "write_file", "argsMatch": { "path": "*.env" } },
  "action": { "kind": "deny", "reason": "secrets belong in the environment" }
}
```

#### scan-args — secret hygiene (tool seams only)

`scan-args` runs nuvira's own local secret scanner over the call's arguments
(before) or its result text (after/failed). Values are **masked** in everything it
reports.

**Stop a key from ever reaching disk.** This is the highest-value hook in the set,
because it fires at the exact moment the mistake would become permanent:

```bash
nuvira hooks enable builtin-scan-writes-for-secrets    # tool write_file → scan-args, deny on hit
```

**Flag (but allow) a key pasted into a shell command** — audit rather than block,
by omitting `denyOnHit`:

```bash
nuvira hooks enable builtin-scan-terminal-args-for-secrets   # tool run_terminal → scan-args
```

**Extend the same protection to edits:**

```bash
nuvira hooks add --id scan-edits --label "Scan edits for secrets" \
  --event before_tool_call --action scan-args --deny-on-hit \
  --tool edit_file --reason "a key-shaped value is in this edit"
```

#### notify — visibility and audit (every seam)

`notify` writes a log line (and a note on the turn's trace). `{tool}`, `{surface}`
and `{event}` are interpolated.

**Audit every failed tool call** — the starter:

```bash
nuvira hooks enable builtin-notify-tool-failures    # failed_tool_call → notify
```

**Watch a specific capability being exercised:**

```bash
nuvira hooks add --id watch-browser --label "Log browser use" \
  --event before_tool_call --action notify \
  --tool browser --message "{tool} opened on {surface}"
```

**Scope a rule to one project, using the working directory:**

```bash
nuvira hooks add --id prod-shell-log --label "Flag shell use in prod repo" \
  --event before_tool_call --action notify \
  --tool run_terminal --cwd /srv/prod --message "{tool} running in the production checkout"
```

**Mark the end of an unattended pipeline run:**

```bash
nuvira hooks add --id run-done --label "Pipeline finished" \
  --event on_session_end --action notify \
  --message "{event} — run finished"
```

### 8.3 What each action can and cannot do

| | `deny` | `notify` | `scan-args` |
|---|---|---|---|
| **Seams** | `before_tool_call` only | all four | tool seams only |
| **Stops a call?** | yes | no | yes, with `denyOnHit` on `before_tool_call` |
| **Produces a log line?** | — | yes | yes, when something is found |
| **Sees arguments?** | shallow matcher only | shallow matcher only | full argument blob (or result) |

### 8.4 What a hook deliberately CANNOT do

Worth stating next to the recipes, because it is the reason hooks are safe to
ship and to hand to an operator. A hook **cannot**:

- run a command or a script (there is no `run-command` action);
- load a module, call an MCP server, or reach the network;
- read a provider credential — it sees a tool *name*, the matcher fields, and a
  result preview, never a secret value;
- rewrite a tool's arguments, inject a prompt, or alter a result;
- fire on a seam or carry an action that is not in the tables above.

Adding a capability means adding a member to `HookAction` **and implementing it
natively** — that is §7, and it is the only path. A hook you can write is a rule
you can read, which is the whole point.
