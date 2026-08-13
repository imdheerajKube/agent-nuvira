# Assessment — Messaging platform health + Dashboard ↔ CLI parity

**Date:** 2026-08-13 · **Assessed against:** v1.63.1 (post WhatsApp-pairing fix)

## Executive summary

1. **Messaging audit: no other WhatsApp-class bug.** The WhatsApp pairing failure
   was the *only* adapter that depended on a third-party SDK whose behavior
   silently changed (Baileys 7 dropped `qrcode-terminal` → `printQRInTerminal`
   became a no-op). All other 21 platforms are pure Node built-ins + `fetch`
   against stable HTTP APIs (Telegram Bot API, Meta Cloud API, Twilio, Slack,
   Discord, IRC over `node:net`/`node:tls`, SimpleX WS, SMTP, webhooks) — no SDK
   dependency-roll hazard exists anywhere else. No `TODO`/`FIXME`/stubs in the
   gateway. **Coverage gaps (not known breakage):** Telegram long-poll, the
   Discord/Slack/WhatsApp-Cloud Bot-token REST paths, and `whatsapp_cloud`
   inbound webhook verification are untested; IRC, SimpleX (in+out), Email
   (full SMTP), and all 13 webhook connectors have tests (incl. IRC E2E).

2. **Dashboard ↔ CLI parity: the big gap is real.** The dashboard today is a
   **monitor + admin** surface. It can *view* models/routing/traces/history/
   cost/benchmarks/eval-results/memory and *administer* providers, quota, users,
   hub toggles, and a single channel **send-test**. It **cannot run any task**:
   no chat/plan/execute, no eval run, no skill author/install/run, no gateway
   start/status/cron/alias, no WhatsApp pairing, no workflow/team/federation/
   MCP/memory/trace/security ops. **≈40 of the 46 top-level CLI commands have
   no GUI execution path.**

3. **Verdict: yes, a project is required** to reach "every command + subcommand
   works from CLI *and* Dashboard". It is a substantial feature (a dashboard
   task-runner / command console with job streaming, RBAC on actions, and
   per-command forms), not a small patch. Recommended as a phased project
   (Section D). Foundation already exists: the dashboard server imports CLI
   modules today (admin checks = `runAllChecks`, same-source pattern), SSE
   streaming is in place, and the adapter/router code is shared.

---

## Part A — Messaging platform audit (22 platforms)

| Platform | Type | SDK? | Tested? | Risk |
|---|---|---|---|---|
| WhatsApp (Baileys bridge) | in+out | **Baileys 7** | ✅ incl. pairing | **FIXED in v1.63.1** (QR render + `--phone` code) — the only SDK-roll hazard |
| Telegram | in (long-poll) + out | none (fetch) | ❌ no dedicated tests | Low (stable Bot API); add long-poll offset/timer tests |
| Discord | in (webhook) + out | none (fetch) | ⚠️ webhook base via connectors; Bot-token REST path untested | Low |
| Slack | in (webhook) + out | none (fetch) | ⚠️ same as Discord | Low |
| WhatsApp Cloud (Meta API) | in+out | none (fetch) | ⚠️ webhook base tested; inbound verify signature path untested | Low |
| IRC | in+out (RFC 1459) | none (`node:net`/`tls`) | ✅ extensive incl. E2E round-trip, 433 retry, PING/PONG, allowlist, reconnect | Low |
| SimpleX (daemon WS) | in+out | none (global WS) | ✅ inbound + outbound (auto-accept, allowlists, reconnect) | Low |
| Email (SMTP) | out | none (`node:net`) | ✅ full EHLO→AUTH→MAIL→RCPT→DATA + failure paths | Low |
| Signal (REST bridge) | out | none (fetch) | ✅ | Low |
| SMS (Twilio) | out | none (fetch) | ✅ (incl. 1600-char cap) | Low |
| DingTalk / Feishu / WeCom / Mattermost / Matrix / Webhook / BlueBubbles / ntfy / Teams / Google Chat / Weixin / Home Assistant | out | none (fetch) | ✅ per-connector payload tests + unconfigured/failure paths | Low |

**Conclusion:** no other platform can "fall flat" the way WhatsApp did. The
only follow-up worth doing is closing the untested paths in Part A (Telegram
long-poll, Discord/Slack/WhatsApp-Cloud REST + inbound signature verification).

---

## Part B — CLI ↔ Dashboard capability matrix

Legend: ✅ in dashboard · ◐ partial (read-only or limited action) · ❌ not in dashboard

| # | CLI command | Dashboard today | Gap |
|---|---|---|---|
| 1 | `dashboard` | ✅ (it *is* the dashboard) | — |
| 2 | `admin` | ✅ Admin tab (users, auth) | — |
| 3 | `model` / `models` | ◐ Models tab + Admin→providers (keys, quota, test) | no model switching, no `model quota` ops beyond quota form |
| 4 | `config` | ◐ provider keys + quota via Admin | no full `.buffconfig` editor, no vault/secrets UI |
| 5 | `doctor` | ◐ Admin→checks (`/api/admin/checks` = `runAllChecks`) | read-only; no `doctor --fix` |
| 6 | `benchmark` | ◐ Benchmarks tab (results) | cannot *run* a benchmark |
| 7 | `eval` | ◐ Evals tab (results) | **cannot run `buff eval` from GUI** |
| 8 | `memory` | ◐ Memory tab (view) | no clear/reindex/trajectory ops |
| 9 | `history` | ◐ History tab (view) | no prune/export |
| 10 | `trace` | ◐ Traces tab (view) | no capture/replay/delete |
| 11 | `gateway` | ◐ Hub→Channels **send-test only** | **no start/stop, status, aliases, delivery ledger, cron UI** |
| 12 | `whatsapp` | ❌ | **no pair (QR/code) / status in GUI** — ideal GUI surface (render QR in-page) |
| 13 | `chat` | ❌ | no chat console |
| 14 | `plan` | ❌ | no plan builder |
| 15 | `execute` / `run` | ❌ | **no task execution** (Execution tab = DAG *monitor* only) |
| 16 | `skill` / `skills` | ◐ Hub→skills enable/disable | no author/install/run from GUI |
| 17 | `tools` / `marketplace` | ◐ Hub→toolsets enable/disable | no install/remove/registry search |
| 18 | `workflow` | ❌ | no workflow templates/run |
| 19 | `team` | ❌ | no review/memory/team UI |
| 20 | `federation` | ❌ | no federation/A2A UI |
| 21 | `mcp` | ❌ | no MCP server/client mgmt |
| 22 | `provider` | ◐ Admin→providers | partial |
| 23 | `security` / `audit` / `sbom` | ❌ (admin checks partial) | no scan/verify UI |
| 24 | `sandbox` | ❌ | no sandbox mgmt |
| 25 | `init` | ❌ | no project scaffolding |
| 26 | `publish` / `ci` / `phase` | ❌ | no autonomous-pipeline UI |
| 27 | `edit` | ❌ | no file-edit UI |
| 28 | `nlu` / `code-map` / `retrieval` / `cache` / `stats` / `feedback` / `session` / `learn` / `plugins` / `sdk` / `agent` | ❌ | no GUI equivalents |

**≈6/46 covered (2 full, 4 partial-read) · ≈40/46 have no GUI execution.**

---

## Part C — What "all tasks from the Dashboard" means

To satisfy the requirement, the dashboard needs a **task-runner / command
console** layer, not just more read endpoints:

1. **Execute any command** (chat, plan, execute, run, eval, skill run, gateway
   ops, team, federation, mcp, workflow, …) from the GUI, with:
   - a **job model**: start → stream progress → result/artifacts → history
     (SSE already exists for DAG/event streaming — reuse it);
   - **reuse of the CLI command modules** as the single source of truth (the
     dashboard already imports CLI code for admin checks — extend that pattern
     so `ExecuteCommand`, `EvalCommand`, etc. are invoked programmatically);
   - **RBAC on actions** (guardRbacAction already exists; the GUI admin role
     must gate destructive/credential ops);
   - **long-running job supervision** (timeouts, cancel, log capture).
2. **Per-command forms/UX** for ~46 commands × subcommands — the bulk of the
   work is UI, not plumbing.
3. **Interactive surfaces** the CLI has that the GUI currently lacks entirely:
   chat console, WhatsApp pairing (render the QR in-page — the natural fix for
   the exact pain point reported), gateway live status + delivery ledger + cron
   editor, eval runner with live results, skill/marketplace browser with install.

---

## Part D — Recommended project (phased)

| Phase | Scope | Rough size |
|---|---|---|
| **P1 — Task-runner core** | `/api/tasks` job API + SSE job stream + cancel/timeout + reuse of CLI command modules; "Run command" console UI shell | M–L |
| **P2 — High-value surfaces** | Chat console, WhatsApp pair (QR in-page) + status, gateway status/start/stop + delivery ledger + cron UI, eval runner | L |
| **P3 — Breadth** | Skill author/install/run, marketplace/tools, workflow, team, federation, MCP, memory/history/trace actions | L |
| **P4 — Hardening** | RBAC audit on every GUI action, tests for Telegram/Discord/Slack/Cloud adapter paths (Part A), job persistence + rerun | M |

Total: a multi-week initiative (a real project, 1–2 engineers + designer for
the console UX), deliverable incrementally — P1 alone already answers "can I
run tasks from the GUI?".

## Decision

**Confirmed: a project is required** to achieve full CLI↔Dashboard parity.
The messaging side is healthy (one bug, fixed, zero similar risks found); the
dashboard side is a monitoring/admin tool today and needs a task-execution
layer + per-command UI to meet the stated requirement.
