# Project — Dashboard ↔ CLI parity (every command from the GUI)

**Source:** `ASSESSMENT_DASHBOARD_CLI_PARITY.md` (2026-08-13) · **Status:** P1 ✅ implemented (v1.63.1+)

## Goal

Every agent-nuvira command + subcommand must be executable from **both** the CLI
and the Dashboard GUI — messaging, skills, tools, `buff eval`, and all other
tasks. The dashboard executes the *actual CLI* as an isolated child process, so
parity is guaranteed by construction.

## Milestones & acceptance criteria

### ✅ P1 — Task-runner core (DONE, shipped in this change set)

The dashboard command console: run any CLI command, stream output live, cancel.

- **Backend** `src/web-dashboard/task-runner.ts`
  - `POST /api/tasks` — start `node dist/index.js <args>` as an isolated child
    process (admin-auth + `routing.operate` role gate).
  - `GET /api/tasks` (history) / `GET /api/tasks/:id` (detail+logs) /
    `POST /api/tasks/:id/cancel` (SIGTERM).
  - `GET /api/tasks/:id/events` — SSE stream (log + status events; token via
    `?token=` since EventSource can't set headers).
  - Timeout (SIGTERM → 5s grace → SIGKILL), 2000-line log ring buffer,
    50-task history cap, spawn-error handling.
- **Frontend** `TasksPage.tsx` — run form (quote-aware argv split), live
  console with auto-scroll, cancel, history table, admin login gate.
- **Tests:** 9 TaskRunner unit tests + 6 `/api/tasks` integration tests +
  5 TasksPage component tests. E2E verified: real CLI `--help` ran through the
  API → `status: done, exit: 0, 101 log lines`.
- **Acceptance:** ✅ run any non-interactive command from the GUI with live
  output, cancel, and history.

### ⏭ P2 — High-value surfaces (chat + eval DONE; gateway ops pending)

**Chat console** (✅ v1.65.0), **in-page WhatsApp pairing** (✅ v1.64.0 — QR +
8-char code, the dashboard is the natural home for the QR the CLI renders),
gateway status/start/stop + delivery ledger + cron editor (⏳ pending),
**`buff eval` runner** (✅ v1.65.0 — preset + custom runs with a live console
via the task runner, results auto-refresh).

- **Acceptance:** pair WhatsApp from the GUI (✅); start/stop the gateway and
  watch the delivery ledger (⏳); run an eval task and see live progress in
  the GUI (✅).

### ⏭ P3 — Breadth

Skill author/install/run, marketplace/tools browser, workflow templates, team
reviews, federation/A2A, MCP management, memory/history/trace actions
(clear/reindex/export/replay), security/audit/sbom scans.

- **Acceptance:** every `buff skill|workflow|team|federation|mcp|memory|security`
  subcommand has a GUI equivalent.

### ⏭ P4 — Hardening

RBAC audit on every GUI action, task-history persistence + rerun, interactive
command support (TTY pass-through for `chat`), dashboard CI coverage (component
tests in the release pipeline), adapter hot-path tests.

- **Acceptance:** all dashboard write actions enforce `roleCan`; task history
  survives restart; `chat` works from the GUI; dashboard tests run in CI.

## Status tracking

- [x] P1 — task-runner core (`/api/tasks` + SSE + Tasks console)
- [x] P2 — chat console (`/api/chat`, in-process agent), WhatsApp pairing UI, eval runner (`/api/tasks` presets)
- [ ] P2 — gateway ops (status/start/stop + delivery ledger + cron editor)
- [ ] P3 — skills/marketplace/workflow/team/federation/MCP/memory/trace actions
- [ ] P4 — RBAC audit, task persistence, TTY pass-through, CI coverage
