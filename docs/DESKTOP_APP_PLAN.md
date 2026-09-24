# Agent-Nuvira Desktop — GUI-Only Plan (Mac + Windows)

> **The decision (2026-09-23, user directive):** agent-nuvira ships as a
> **desktop application** with **ONE interface** — no chat/execute/plan faces —
> and **no CLI command, ever**, for the user. Every capability and every
> configuration lives in that one window.
>
> **Ratified (2026-09-23):** the shell is **Electron** — a real installed
> application window (dock/taskbar, native menus, dialogs, tray, keychain,
> auto-update), NOT a browser tab. Tauri and truly-native (SwiftUI/WinUI)
> were both considered and rejected in §2. Reusing the existing React UI is
> what makes this a months-scale plan instead of a rebuild.
>
> **Reference apps (researched 2026-09-23):** see §1. **Hermes Desktop is the
> primary reference** (it is the mature, documented, shipped equivalent of
> exactly what we are building); **Freebuff Desktop is the secondary
> reference** for parallel-agent workspace isolation. We do not invent a UI.
>
> **The one scoping rule that keeps this honest:** the CLI stays in the
> codebase and keeps working. `nuvira`/`buff` must still run for CI, the eval
> harness, the demo cast and `verify-commands`. GUI-only describes the
> **user-facing product surface**, not the repo. Deleting the CLI would break
> 362 test files, `docs/COMMANDS.md` generation and the publish workflows, for
> zero user benefit.
>
> **What this is NOT:** a rewrite. `DASHBOARD_FIRST_PLAN` already delivered the
> browser dashboard as a CLI-free front door (chat as the lobby, artifact/diff
> cards, token streaming, projects, sessions, attachments, skills) with its
> north-star check passing on 2026-08-18. **Roughly half the interface spec in
> §3 is already built and tested.** This plan adds the native shell, closes the
> configuration gap, and matches the reference interaction model.
>
> **Honest feasibility verdict: YES.** ~20–26 person-weeks of engineering,
> concentrated in native shell + interface parity + release engineering. The
> engine, the 72 API routes, the auth/RBAC layer and the OS-keychain vault are
> reused verbatim.

---

## 0. The honest baseline — where we stand TODAY (audited 2026-09-23)

All numbers measured in this repo, not estimated.

| Asset | Measured today | What it buys us |
|---|---|---|
| Engine + CLI | 493 TS/TSX files, **204,892 LOC**, 362 test files | No rewrite — the desktop app is a *client* |
| Dashboard server | `server.ts` **7,053 LOC**, **72 API routes**, SSE streaming (7 sites) | Reused verbatim as the desktop transport |
| Dashboard SPA | **25,274 LOC**, React 18 + Vite, **31 unique screens**, 21 component test files | The UI already exists — ~half of §3 |
| Built SPA | `src/web-dashboard/public/` **6.5 MB**, shipped in npm `files` | Electron loads the same bundle; no second build |
| Auth | bcryptjs + jsonwebtoken, Bearer 8h, RBAC (`roleCan`, roles) | A desktop auth workstream **already done** |
| Secrets | `@napi-rs/keyring` OS keychain, tier ladder keyring → os-cli → aes-file → none | Keychain integration **already done** |
| Native deps | `@napi-rs/keyring`, `sharp` are **N-API** (ABI-stable) | **No `electron-rebuild`** for them — where most Electron migrations bleed weeks |
| Cross-platform CI | `test-linux.yml` + `test-windows.yml`, `publish-vscode.yml` | Two-OS release muscle exists |
| Lifecycle primitives | `dashboard --force` stale-server detection, `probeDashboardPortState`, `waitForPortFree` | To build the desktop boot ladder on |
| Interaction seams | `ToolContext.askUser` injection (dashboard already injects its own renderer — no `inquirer` in the GUI path), `write-approval.ts`, `approval-tools.ts` | The hooks the GUI needs **already exist** |

**The gap:**

| Measured | Count |
|---|---|
| Registered command paths (`.command(` in `src/cli/*.ts`) | **175**, in 31 files |
| Documented command sections (`docs/COMMANDS.md`) | **88**, in **13 domains** |
| CLI files using `inquirer` (flows that must become GUI) | **18** |
| Desktop shell present | **none** (no Electron/Tauri, no icons, no installers, no signing, no updater) |
| Real PTY terminal | **none** (no `node-pty`, no `xterm`) |
| Windows shell story | `run-terminal.ts:312` hardcodes `C:\Program Files\Git\bin\bash.exe` — a desktop user without Git gets broken commands |

**The uncomfortable truth:** the dashboard is CLI-free for *chat*, not for
*configuration*. 18 CLI files' worth of interactive setup still assumes a TTY,
and error copy across the product still tells users to run commands. **That
gap — not window chrome — is the real work.**

## 1. Reference decision — Hermes, with Freebuff for parallelism

Researched directly (docs + the Hermes Desktop `apps/desktop/README.md`).

| | **Hermes Desktop** | **Freebuff Desktop** |
|---|---|---|
| Architecture | "The packaged app ships the **Electron shell** and a **native React chat surface**." Three boundaries: Electron (native + narrow preload bridge) / React (routes, panes, transcript) / **headless `hermes serve` backend** | TS/Bun monorepo; desktop "run parallel agents locally" |
| Relationship to its core | *"same agent, same skills, same memory as the CLI and gateway… not a separate product or a lightweight clone"* | Shares Codebuff core |
| Transport | Backend exposes a JSON-RPC/WebSocket API; the renderer connects via `apps/shared` — **the same module the browser dashboard uses** | n/a (closed) |
| Documented UX depth | **Exhaustive** — streamed tool activity, right-hand preview rail, file browser, artifacts gallery, tabs/multi-window/panes, status bar (context meter, cache hit rate), model picker in composer, Simple/Advanced interface modes, command palette, embedded terminal, comment mode on the live page | Parallel agents isolated in separate workspaces |
| Platforms | macOS arm64, Windows, Linux | macOS, Windows, Linux |
| Verdict | **Primary reference.** Same problem, same architecture, fully documented, and demonstrably shippable | **Secondary.** Its one distinct axis is **parallel-agent workspace isolation** — adopt that behaviour |

**Note for the "not web-based" concern (§2):** Hermes — the best-in-class
reference — is **Electron + React**, the same rendering technology as our
existing dashboard. "Native desktop app" in this category means *a real
installed application window*, not a browser tab. That is achievable without
abandoning 25,274 LOC of React.

## 2. The single-interface contract (validating the directive)

The directive — *one interface, no chat/execute/plan faces, no CLI* — is
**correct, and partly already true in the engine.**

- **`chat` / `execute` / `plan` are CLI *modes*, not product capabilities.**
  The engine already unifies them: the intent router + tool loop decide
  whether a turn is answered or acted on (`DASHBOARD_FIRST_PLAN`: "the agent
  decides answer-vs-act"). The faces were a terminal artifact. **Retire them
  from the product surface; keep them in the CLI.**
- **One interface ≠ one screen** (the one nuance to get right). Hermes is *"a
  chat-first window with a left sidebar for navigation"*: the capability
  surfaces (settings, messaging, skills, artifacts) still exist as
  **panes/pages — but they are never modes of the agent.** They change what is
  *shown*, not what it *can do*. That distinction is the contract:

  > **One interaction surface (the composer + transcript). Capability surfaces
  > are panes, not faces.** The user never chooses a mode; the agent does.

- **Wide capability does not mean more faces.** Hermes answers 13+ domains with
  one chat plus a **Simple / Advanced** interface mode. We adopt it: **Simple**
  = chat, sessions, files, edits, decisions, thinking. **Advanced** = the same
  window with the audit/ops panes docked. Same agent, same power, no mode
  switching.
- **No CLI, anywhere in the UI.** Where the agent runs a command, the user sees
  a **structured action card with parameters and approve/reject** — never a
  copy-pasteable command line. Enforced by the gate in §6.

**What "not web-based" must mean here** (be explicit, it decides everything):

| Interpretation | What it delivers | Cost | Recommendation |
|---|---|---|---|
| **Not a browser tab; a real installed app** (native window, dock/taskbar, menus, file dialogs, tray, keychain, deep links, auto-update) | Everything the user asks for; exactly what Hermes ships | ~20–26 person-weeks (§5) | ✅ **CHOSEN (2026-09-23).** Electron shell + existing React UI |
| Not Chromium under the hood either (SwiftUI + WinUI/WPF) | Marginally "purer" native widgets | **Two separate codebases**, discard 25,274 LOC + 21 test files, and leave the category's chosen stack | ❌ Not recommended |
| Smaller footprint than Chromium (Tauri: Rust shell + system webview) | ~10–20 MB vs ~150 MB, lower idle memory | Keeps the Node backend as a sidecar anyway, **adds a Rust toolchain**, sidecar lifecycle/IPC complexity, +3–5 weeks | 🟡 Escape hatch only, if footprint becomes a product differentiator |

## 3. The interface spec — "same behaviour as the reference GUI"

This is the concrete, checkable target: what the user sees for **files, edits,
decisions, thinking**. Status reflects what already exists in this repo.

| # | Interface behaviour | Reference | Our status |
|---|---|---|---|
| 1 | **One composer**, model picker + reasoning/effort control inline | Hermes | 🟡 Models panel exists; picker not in composer |
| 2 | **Streaming responses** (typewriter) | both | ✅ Delivered (SSE `token` event; `DASHBOARD_FIRST_PLAN` Phase 1) |
| 3 | **Live tool activity** rows as the agent works | Hermes | ✅ Tool cards delivered (P0.6) |
| 4 | **Structured tool-call summaries**, expandable | Hermes | 🟡 Tool cards exist; expandable summaries need parity |
| 5 | **Thinking** shown as a collapsible reasoning block, collapsed by default | Hermes | ❌ **New** — reasoning is not surfaced as a first-class block |
| 6 | **Decisions** — approval cards (approve/reject), dangerous-command prompts | both | 🟡 Engine gating exists (`write-approval.ts`); needs the card UI |
| 7 | **Per-session YOLO / auto-approve toggle** in the status bar | Hermes | ❌ New |
| 8 | **Edits as inline diffs** with **per-file accept/reject** | both | ✅ Delivered (diff cards, accept/reject, "Commit accepted (N)") |
| 9 | **Review pane** — diff/review side by side with chat | Hermes | ❌ New (panes) |
| 10 | **File browser** — explore/preview the working dir, follow the agent live | Hermes | 🟡 Project attach + code-map exist; no tree/preview pane |
| 11 | **Artifacts gallery** — everything sessions produced, searchable, with jump-back | Hermes | ❌ New (`artifacts.ts` extracts cards; no gallery) |
| 12 | **Right-hand preview rail** — pages/files/tool output beside the chat | Hermes | ❌ New |
| 13 | **Embedded terminal pane** (real PTY, hideable) | Hermes | ❌ New (Phase 4 — the only non-N-API dep) |
| 14 | **Projects as the workspace abstraction** (folders, repos, worktrees, sessions) | Hermes | 🟡 Project attach + recall exist; needs multi-folder projects |
| 15 | **Sessions sidebar** — search, date groups, resume, rename, delete | Hermes | ✅ Delivered (Phase 8 smart rail) |
| 16 | **Composer attachments** — drag-drop, paste-as-attachment, chips | Hermes | ✅ Delivered (Phase 8) |
| 17 | **Tabs / multiple windows / panes**; pop a session into its own window | Hermes | ❌ New (desktop-only affordance) |
| 18 | **Status bar** — session state, context/token meter, cost, model, approvals, timers | Hermes | 🟡 Data all exists (QuotaPanel, CostDashboard, ModelTimeline); no persistent bar |
| 19 | **Command palette** + keyboard-first shortcuts | Hermes | ❌ New |
| 20 | **Simple / Advanced interface modes** | Hermes | ❌ New — **the answer to §2's "one interface"** |
| 21 | **Settings & onboarding** — providers, models, credentials, first-run in seconds | Hermes | 🟡 `EnvVarEditor`, `HealthPanel`, `BedrockOnboarding` exist; needs the wizard (Phase 2) |
| 22 | **Background update check + one-click update** | Hermes | ❌ New (Phase 5) |
| 23 | **Parallel agents in isolated workspaces** | **Freebuff** | 🟡 Orchestrator exists; workspace isolation per agent is the Freebuff behaviour to adopt |

**Read the status column:** 10 of 23 are already delivered or substantially
built. The plan's job is the other 13 plus the native shell — which is why the
estimate is months, not years.

## 4. Architecture

**Decision (chosen 2026-09-23): Electron shell + the existing React UI + the existing engine as a headless backend — the Hermes three-boundary model, adapted.**

```
┌──── Boundary 1 — Electron main (the app) ──────────────────────────┐
│  single-instance lock · windows/menus/tray · native bridge          │
│  ├─ backend boot ladder: bundle → validate → probe → health → serve │
│  ├─ native: file/folder dialogs · notifications · deep links        │
│  │           keychain (safeStorage) · PTY · auto-update             │
│  └─ narrow preload bridge: random loopback port + per-launch token  │
└─────────────┬───────────────────────────────────────────────────────┘
              │ loopback HTTP + SSE — UNCHANGED (72 routes, 7,053 LOC)
              ▼
┌──── Boundary 3 — engine (headless) ─────────────────────────────────┐
│  the existing dashboard server + the same engine the CLI drives:    │
│  chat loop · tool loop · intent router · gateway · orchestrator ·   │
│  memory · eval — ALL UNCHANGED                                      │
└─────────────┬───────────────────────────────────────────────────────┘
              │ the SAME transport module the browser dashboard uses
              ▼
┌──── Boundary 2 — React renderer ────────────────────────────────────┐
│  the existing SPA (25,274 LOC, 31 screens) + the §3 additions       │
└─────────────────────────────────────────────────────────────────────┘
```

**Why Electron:** the backend is Node/TypeScript and the UI is React. Tauri
would keep the Node backend as a sidecar *and* add a Rust toolchain for a size
win that is not a stated requirement. The stated constraint
(macOS/Windows/Linux) is best served by the runtime the code already targets.
Confirmed by the reference: Hermes ships Electron + React.

**Backend boot ladder** (adapted from Hermes' resolution ladder; ours is
simpler because we have no Python): bundled `dist/` → validate → **probe before
use** (health endpoint, not merely "the file exists") → managed install under
`~/.nuvira` → crash recovery with an in-app error surface. **Bundle the Node
runtime inside Electron** — the user must never be asked to install Node.

**Security hardening (required, not optional):** bind `127.0.0.1` (already the
default), **ephemeral port** instead of fixed 3030, **per-launch token via the
preload bridge** (never a file, never a URL), **Origin/CSRF validation**, and
drop the `?token=` query fallback from the desktop path (keep it for the
browser dashboard, which needs it for `EventSource`).

**Secrets:** reuse `@napi-rs/keyring` (N-API, no rebuild) — it is strictly
better than a bare `safeStorage` call and its tier ladder already degrades
gracefully.

**Terminal:** Phase 2 ships the existing `TaskConsole` + SSE log streaming
(already built). The real **PTY pane** (`xterm.js` + `node-pty`) lands in
**Phase 4**, because `node-pty` is the only dependency here that is **not**
N-API and therefore needs per-Arch rebuilds. It must not block launch.

## 5. Phased execution (each phase independently shippable)

### Phase 0 — Decisions + spine spike (3–5 days)
- [x] Record the reference decision (§1: Hermes primary, Freebuff for parallel workspaces) and the renderer decision (§2: **Electron** — chosen 2026-09-23) in this doc
- [ ] Spike: a window that boots the engine and loads the existing SPA — proves zero-rewrite in days
- [ ] Inventory every user-facing "run a CLI command" string in `src/web-dashboard/**` + engine errors → the Phase 7 burn-down list
- [ ] Decide the `computer-use` question: it silently needs an external Rust `cua-driver` (`cargo install`). **Bundle it or cut it from the product claim** — do not ship a button that cannot work
- [ ] **Start Apple + Windows certificate procurement on day 1** (calendar-bound, gates the first signed build)

### Phase 1 — App shell (2–3 weeks)
- [ ] Electron main: single-instance lock, window state, native menus, tray (engine healthy / working / stopped)
- [ ] Backend boot ladder + probe-before-use + crash recovery with an in-app error surface (reuses `probeDashboardPortState`/`waitForPortFree`)
- [ ] Ephemeral port + per-launch token via preload; drop `?token=` from the desktop path; Origin/CSRF checks
- [ ] Deep links (`nuvira://`), dock/taskbar identity, About panel
- [ ] Packaging: **DMG (arm64 + x64)** and **NSIS/MSI (x64)**; unsigned internal builds testers can actually run
- [ ] CI: build-and-package job added to the existing two-OS workflows (artifacts, no publish)

### Phase 2 — GUI-only configuration (3–4 weeks) ← **the heart of the directive**
- [ ] **Settings hub**: schema-driven UI over `nuviraconfig.json` + `.env`, replacing `config get/set/list/init` and `EnvVarEditor`. Every key gets a typed control, validation, description, default
- [ ] **Secrets UI**: write to the OS keychain; masked after save with reveal-on-demand; never logged, never left in the DOM
- [ ] **First-run wizard**: welcome → provider → key → verify → workspace — `doctor` re-rendered as a live checklist (`HealthPanel`), not a text report
- [ ] **Provider setup GUI**: keys, model selection, routing preference (today `inquirer` in `config.ts`, `model.ts`, `model-picker.ts`, `failover-prompt.ts`, `weak-model-prompt.ts`)
- [ ] **Workspace picker** (native folder dialog) + **Projects** as first-class (multiple folders/repos per project — Hermes parity)
- [ ] **Storage panel**: cache size, clear, sandbox location, reset (domain 13)
- [ ] **Advanced (maintainer) area** hosting the §7 exemptions
- [ ] **"No dead ends" acceptance, per key:** reachable in ≤2 clicks · has a GUI control · its error copy names a GUI action · no CLI flag required to use the feature

### Phase 3 — Interface parity to the §3 spec (5–6 weeks)
- [ ] **Thinking block** — surface reasoning as a collapsible first-class block (§3.5)
- [ ] **Decision cards** — approval/reject UI over the existing gating; per-session YOLO toggle in the status bar (§3.6–3.7)
- [ ] **Docked panes** — review/diff pane, file browser, right-hand preview rail, artifacts gallery (§3.9–3.12)
- [ ] **Status bar** — session state, context/token meter, cost, model, approvals, timers, customizable (§3.18)
- [ ] **Command palette** + keyboard-first shortcuts (§3.19)
- [ ] **Simple / Advanced interface modes** — the §2 contract made real (§3.20)
- [ ] Composer **model picker + reasoning pill** (§3.1); expandable tool summaries (§3.4)
- [ ] **Freebuff behaviour**: parallel agents isolated in separate workspaces (§3.23)

### Phase 4 — Desktop depth & native (3–4 weeks)
- [ ] **PTY terminal pane** (`xterm.js` + `node-pty`), hide vs close (keep shell state), `electron-rebuild` wired for both OS × Arch
- [ ] **Tabs, multiple windows, pop-out session**; per-workspace windows (§3.17)
- [ ] Notifications on long-task completion; tray progress/badge
- [ ] Drag-drop files/folders; "open in editor"; comment/annotate on previewed pages
- [ ] Offline / unreachable-provider states as actionable UI

### Phase 5 — Release engineering (2–3 weeks + the cert calendar path)
- [ ] macOS: Developer ID cert, **hardened runtime + entitlements** (the app spawns subprocesses *and* reads the keychain), `notarytool` + stapling on every build
- [ ] Windows: **Authenticode** (identity verification mandatory now — allow weeks), SmartScreen reputation, NSIS/MSI
- [ ] **Auto-update** (electron-builder/electron-updater style) over GitHub Releases; staged rollout; "Check for updates" in About
- [ ] Crash reporting with **telemetry off by default**, opt-in only (consistent with the privacy-first pitch)
- [ ] Release automation: tag → build both OS × Arch → sign → notarize → publish → notes
- [ ] Decide Intel Mac support explicitly (the reference shipped **arm64-only** and has an open issue complaining about it — do not repeat it by accident)

### Phase 6 — Panel parity for the 13 CLI domains (4–6 weeks, can overlap 3–5)
Build every unmapped row from §7's matrix, **as panes, never as faces**:
- [ ] Gateway: QR pairing wizard, verified-list editor, status recipients, delivery ledger, policy editor
- [ ] Skills: MCP inspector, plugin manager, workflow templates, quality/GC view
- [ ] Security: cron editor, scan runner, audit viewer, SBOM export
- [ ] Learning: 👍/👎 turn feedback, learnings viewer
- [ ] Observability: retrieval, intent/NLU, code-map viewer, tool-registry browser
- [ ] Collaboration: review/approve flow, team workspace
- [ ] CI/CD: publish wizard (notes → confirm → streamed run)
- [ ] All 18 `inquirer` flows have a GUI twin or are confirmed maintainer-exempt

### Phase 7 — GUI-only enforcement & hardening (2 weeks, overlapping)
- [ ] The gate (§6) wired into `npm test`
- [ ] Burn down the Phase 0 string inventory to zero user-facing "run this command"
- [ ] Accessibility (focus order, labels, contrast), perf (cold start, long transcripts), memory
- [ ] In-app guide replacing GUI-facing `USER_MANUAL.md` prose; the app never links a user to `COMMANDS.md`

**Total ≈ 20–26 person-weeks** — ~5–6.5 months solo, **~3 months with two
engineers**, plus the certificate calendar path.

## 6. The gate — proving GUI-only instead of asserting it

Consistent with this repo's culture (`commands-surface --check`,
`cli-demo --check`, `verify-commands`), GUI-only gets a **test**:

- `docs/GUI_PARITY.md` — the committed table: every command path enumerated from
  `src/resources/command-manifest.json`, mapped to a **GUI surface id**, or
  marked `maintainer-exempt` with a reason.
- `scripts/check-gui-only.mjs --check` — fails when:
  1. a registered command path is **neither** mapped nor exempt (new CLI capability with no GUI home),
  2. a **user-facing string** in `src/web-dashboard/**` or engine error copy tells the user to run a command (pattern: `` `buff <verb>` ``/`` `nuvira <verb>` `` in UI-visible text; code comments and internal logs excluded),
  3. a mapped surface id no longer exists in the component tree,
  4. **a route introduces a new agent *mode*** (the §2 contract: no new faces).
- Wired into `npm test` alongside `docs:commands:check`; skips (never silently passes) without a dashboard build — same pattern as `tests/docs/cli-demo.test.ts`.

**Definition of done (north-star check, written before the work):**
> A new user on macOS or Windows downloads a signed installer, opens one window,
> connects a provider with a key kept in the OS keychain, points at a project,
> asks for work, watches the agent think and act, reviews files and diffs inline,
> approves or rejects decisions, runs the tests, pairs a messaging channel,
> adjusts routing, sets a policy, and updates the app — **all in one interface,
> by clicking, with no terminal, no env file, no `nuvira` command, and no link
> to a command reference.**

## 7. Zero-gap matrix — every CLI domain gets a GUI home (panes, not faces)

Status: ✅ GUI exists · 🟡 partial/CLI-shaped · ❌ none. Phase = where it lands.

| # | CLI domain | GUI surface | Today | Phase |
|---|---|---|---|---|
| 0 | Quick start / first run | First-run wizard | ❌ | 2 |
| 1 | Service lifecycle (start/stop gateway, dashboard) | **Owned by the app** — boot, health, restart, tray. The user never starts a service | 🟡 | 1 |
| 2 | Messaging channels — pairing, verified list, recipients, delivery ledger, policies | `GatewayPage`+`WhatsAppPanel`+`ContactsPage` ✅; add QR pairing wizard, verified-list editor, delivery ledger, policy editor | 🟡 | 6 |
| 3 | Core AI ops — chat/execute/edit/plan/run | **`ChatPage` — the ONE interface** ✅ (all five are modes of one loop) | ✅ | — |
| 4 | Config & setup — doctor, config, vault, scaffold, Bedrock | Settings hub + `EnvVarEditor`✅ + `HealthPanel`✅ + `BedrockOnboarding`✅; add secrets UI, scaffold wizard | 🟡 | 2 |
| 5 | Models & providers — list, health, switch, routing, staleness | `ModelsPanel`+`RoutingInsightsPanel`+`ModelTimeline`+`QuotaPanel`✅; add composer picker, staleness view | 🟡 | 2–3 |
| 6 | Skills & automation — compiled, hub, plugins, workflows, MCP, bundles, GC | `SkillEnvPage`+`AgentHub`✅ + marketplace panel; add MCP inspector, plugin manager, workflows, GC view | 🟡 | 6 |
| 7 | Learning, memory & feedback | `MemoryPanel`✅, `EvalsPage`✅; add turn feedback, learnings viewer | 🟡 | 6 |
| 8 | Evaluation & benchmarking | `EvalsPage`+`BenchmarkCharts`✅ | ✅ | — |
| 9 | Security & governance — policy, RBAC, cron, scan, audit, SBOM | `AdminPanel`✅; add cron editor, scan runner, audit viewer, SBOM export | 🟡 | 6 |
| 10 | Collaboration — team, review bundles, federation, A2A, agents, SDK | `AgentHub`✅; add review/approve, team workspace; federation/A2A → advanced | 🟡 | 6 |
| 11 | CI/CD & publishing | `PhaseTimeline`✅; add publish wizard; **headless CI is out of GUI by definition** | 🟡 | 6 |
| 12 | Observability — stats/cost, history, traces, retrieval, sessions, NLU, code map, tools | `Overview`+`CostDashboard`+`HistoryBrowser`+`TracePanel`+`DAGView`✅; add retrieval, intent/NLU, code-map viewer, tool browser | 🟡 | 6 |
| 13 | Cache & sandbox | Settings → Storage | ❌ | 2 |

**Maintainer/ops-only (explicitly exempt, still GUI-hosted, never a terminal):**
`headless CI`, `publish` to npm, `publish:vscode`, `migrate-keys`, `serve`,
`federation`, `a2a`. Behind **Settings → Advanced**, labelled "maintainer",
documented as exempt in `docs/GUI_PARITY.md`. Exempt because they *are*
automation surfaces — a GUI for `headless CI` would defeat its purpose.

## 8. What we deliberately do NOT do

- **No engine rewrite.** Chat loop, tool loop, router, gateway, memory, eval stay as they are. One sanctioned exception (same as `DASHBOARD_FIRST_PLAN`): additive opt-in engine hooks if a GUI affordance genuinely needs one.
- **No CLI deletion.** `nuvira`/`buff` remain for CI, evals, the demo cast, `verify-commands`.
- **No new agent faces.** No chat/execute/plan selector, ever — the engine decides. Enforced by the §6 gate.
- **No CLI→page 1:1 mapping.** 175 command paths ≠ 175 screens; subcommands are controls inside one pane. The matrix is by *operation*.
- **No real-pty-native in the launch path.** `node-pty` is the only ABI-fragile dep; it arrives in Phase 4.
- **No rewriting the 72 routes into IPC.** Keep HTTP/SSE over loopback.
- **No Tauri/Rust second toolchain** unless footprint becomes a stated differentiator.
- **No bundling `cua-driver`** — bundle it or cut computer-use from the claim (Phase 0 decision).
- **No Hermes-style runtime bootstrap complexity.** Hermes bundles Python 3.11 + portable Git + ripgrep and reconciles a venv. We have **no Python**: bundle Node inside Electron and most of that class of failure disappears. Do not copy it.
- **No voice, no remote-gateway mode, no Hermes Cloud in v1.** Real capabilities, but not this plan. (Hermes has all three; they are backlog, not launch.)

## 9. Effort, sequencing & honest risks

**Effort (person-weeks):** shell/lifecycle/packaging 2–3 · GUI-only config 3–4 ·
interface parity 5–6 · desktop depth/native 3–4 · panel parity 4–6 · release
engineering 2–3 · enforcement/hardening 2 · **total 20–26**.

**Critical path:** certificates, not code. Apple Developer Program ($99/yr) +
Developer ID + notarization; Windows Authenticode (identity verification
mandatory, often weeks). Start both on day 1.

**Recommended sequence:** **macOS first, then Windows.** Two platforms in
parallel is how 3 months becomes 6.

| Risk | Severity | Mitigation |
|---|---|---|
| **Cert procurement stalls launch** | High | Start day 1; ship unsigned internal builds so engineering never blocks |
| **Windows is the sharp edge** — `run-terminal.ts:312` hardcodes Git Bash; 319 Windows-conditional sites | High | Decide the Windows shell story *before* Phase 6; validate on real Windows hardware, not CI alone |
| **`node-pty` is the one non-N-API dep** | Medium | Phase 4, after launch; wire `electron-rebuild` per Arch/OS. `keyring`/`sharp` are N-API → no rebuild |
| **Engine lifecycle bugs** — orphaned servers, port collisions, zombies | Medium | Ephemeral port + single-instance lock + probe-before-use + crash recovery, explicitly tested in Phase 1 |
| **Local HTTP server inside a desktop app** | Medium | Loopback bind + per-launch token + Origin/CSRF + no `?token=` on the desktop path |
| **`computer-use` needs an unbundled Rust binary** | Medium | Phase 0: bundle or cut |
| **Interface scope creep** — the §3 spec is 23 behaviours | Medium | Status column is the contract; the §6 gate caps it |
| **Perf is the reference app's known weakness** — public complaints about Hermes Desktop being slow | Medium–High | Budget explicit perf gates (cold start, long-transcript render, streaming under load) in Phase 7; measure, do not hope |
| **Intel Mac support** — the reference shipped arm64-only and drew complaints | Medium | Decide explicitly in Phase 5; state it on the download page either way |
| **Electron bundle (~80–150 MB/OS) + idle memory** | Low–Med | Accepted for capability + runtime continuity; Tauri is the documented escape hatch |
| **GUI-only costs power users** | Medium | Ship the embedded terminal pane (a GUI affordance) + a developer mode; never tell the user to open Terminal |
| **Two-OS support is a permanent tax** | Medium | Budget as ongoing, not one-time; CI matrix from Phase 1 |
| **Existing UI debt** — `revamp_dashboard.md`, `UI_UPGRADE_MASTERPLAN.md`, `DASHBOARD_UI_REDUX_PLAN.md` | Medium | A 4–6 week design effort **with a design owner** is what makes it "premium"; extra engineering will not produce it. Hermes ships a `DESIGN.md` (visual system, IA, motion, direct manipulation, keyboard) — write the equivalent |

**On "better than the reference":** not by out-polishing it — that is a design
workstream, not this plan. Win a **category**, using what already exists: the
audit-grade panels (trace, routing, cost, DAG, phase timeline, model timeline)
as **docked, multi-window** desktop affordances, plus local-first (OS keychain,
Ollama, no telemetry). Hermes' own docs list *"no explainability interface"* as
a gap — that is precisely our strongest existing asset. **Name the axis and win
it; do not enter a looks contest.**
