# Tool Truthfulness Tracker

**Why this doc exists.** The original tracker was an untracked working doc and was
lost, exactly like the master plan described in `IMPLEMENTATION_BRIEFS.md` — the
repo's `.gitignore` ignores `*.md` unless a file is explicitly whitelisted, and this
one was not, so it appeared never to have been written. Eight source files still cite
it by name (bare, as `TOOL_TRUTHFULNESS_TRACKER.md`; it lives here in `docs/`), so
the list below is **reconstructed** from the two places the truth actually survived:

1. the inline comment at each fix site (which names the finding it closes), and
2. `tests/tools/tool-truthfulness.test.ts`, which pins one assertion per finding.

**How to read it.** Every row is a *claim* — the evidence column is what makes it
verifiable. To re-verify the whole doc, run the commands in
[Verification](#verification). A row whose test fails is a regression regardless of
what this table says.

**Ground rule for this workstream** (from `src/tools/tool-refusal.ts`): a tool that
cannot perform its action returns a **typed refusal** — `ok: false` (or
`success: false`) plus a `code` — never an empty-but-valid payload, a fabricated
identifier, or fabricated data. `success: true` on a path that performs no work is
the one defect the agent cannot recover from, because the signal it would need to
fall back on has been replaced with a plausible result.

## Origin incident (2026-09-27)

A PDF blood report was placed in the project and `read_extract` answered
`{ text: '<%PDF-1.4 …raw bytes…>', format: 'pdf', success: true }`. The model had no
signal that extraction had failed, so the turn produced a generic Markdown template,
claimed to have "verified that the file was created correctly", and only on the
third turn admitted the file had never been read.

The missing extractor was **not** the failure. The failure was that an unsupported
format reported success.

## The mechanism

`src/tools/tool-refusal.ts` — `ToolRefusal { ok: false, code, reason, alternatives? }`
with a deliberately small code set, one per recovery path:

| Code | Meaning |
|---|---|
| `unsupported_format` | No parser/backend exists for this input format. |
| `not_configured` | The capability exists but its backend is missing (no key, no binary, no package). |
| `no_data` | The backend is present but the input is outside what it can do (e.g. a PDF page with no text layer). |
| `unavailable` | Backend present but temporarily broken / rate-limited / disabled by policy. |

Tools whose backend is optional additionally expose an `isXAvailable()` probe,
mirrored into the tool **description**, so the model can see what is real before
choosing a tool.

## Status — tool-truthfulness findings

| Finding | What it was | Fix site | Status |
|---|---|---|---|
| **#1** | `read_extract` returned a PDF's raw bytes as `text` with `success: true`; the `read_extract` tool description advertised formats it could not read, which is how a model concluded an unreadable PDF had been read. | `src/tools/read-extract.ts`, description at `src/tools/registry.ts:3161` | ✅ Closed |
| **#3** | `messaging` send path fabricated delivery — an agent could truthfully report a message reached a third party when nothing left the machine. | `src/tools/messaging-tools.ts`, `registry.ts:1859` (tool marked NOT CONNECTED) | ✅ Closed |
| **#4** | `delegate_system` `executeTask` settled every task as `completed` with `result = 'Task completed: <goal>'` and never called a model; the parent summarised its own instructions echoed back. | `src/tools/delegation-system.ts:145` | ✅ Closed |
| **#5** | `neutts_synth`'s fallback wrote a valid, **silent** WAV and returned it as a successful synthesis, so downstream acted on silence that looked like speech. | `src/tools/neutts-synth.ts` (silence is opt-in only: `BUFF_NEUTTS_ALLOW_SILENT`) | ✅ Closed |
| **#6** | The registry's `vision` tool ("analyze images, extract text via OCR, detect UI elements") pointed at a stub that returned empty-but-valid payloads while `describe_image` pointed at the real engine. | `src/tools/vision-tools.ts` | ✅ Closed |
| **#7** | Dashboard turn attachments were read client-side with `File.text()`, so a PDF arrived as `%PDF-1.4 …` mojibake with nothing indicating failure. | `src/web-dashboard/server.ts:5963` → `attachment-extract.ts` → same `read_extract` | ✅ Closed |
| **#9** | `messaging` react answered `{ success: true }` unconditionally — "Reacted" for a reaction never applied. | `src/tools/messaging-tools.ts` (refuses via the registry, never the word "Reacted") | ✅ Closed |

**Not recoverable:** findings **#2 and #8** are cited by no source comment or test,
so whatever they were cannot be reconstructed. Treat this list as complete only for
the findings that still have a witness in the tree.

## Status — P-items

| Item | What it is | Evidence | Status |
|---|---|---|---|
| **P1.1** | XLSX reader. The `xlsx` name on the public registry is stale at 0.18.5; `@e965/xlsx` republishes the official SheetJS 0.20.3 build with zero dependencies and is pinned exactly in `package.json`. | `src/tools/extract/xlsx.ts` | ✅ Closed |
| **P1.2–P1.5** | The real PDF/DOCX/PPTX containers — pdf.js and SheetJS load lazily (import failures report `not_configured`, never silent degradation); CSV quote rules parsed directly instead of `split(',')`; a "text" file whose bytes are binary refuses; only implemented formats report as supported, probed per file; huge text files cap and say they truncated. | `src/tools/read-extract.ts`, `src/tools/extract/` | ✅ Closed |
| **P0.1, P0.2** | read_extract truthfulness: an unimplemented format refuses with `unsupported_format` + alternatives (legacy `.doc`/`.xls`/`.ppt`, `.rtf`, `.odt` → `PENDING_FORMATS`) and never leaks raw bytes as `text`. | `tests/tools/tool-truthfulness.test.ts:98–221` | ✅ Closed |
| **P1 — reachability** | The tool-truthfulness fixes were barely reachable: `read_extract` was tier-2, so the default tiered tool loop could not call it, and `read_file`'s binary refusal did not name it. | `src/tools/toolsets.ts` (`read_extract` in `CORE_TOOL_NAMES`), `src/tools/coding-tools.ts` (extension-aware refusal) | ✅ Closed |
| **P2 — gateway inbound** | The WhatsApp bridge only extracted `conversation`/`extendedTextMessage`, so a document message arrived with empty `text` and was dropped at `if (!text) continue` — the sender's own file vanished with no reply and no record. | `src/gateway/inbound-media.ts` + bridge/adapter/registry wiring | ✅ Closed |
| **P4.1** | `subagent` — child-process spawning. Cited as the alternative in `delegate_system`'s refusal with "see P4.1 for its current state"; that state is now restated in full below. | `src/tools/delegation-system.ts`, `src/tools/subagent-spawner.ts`, `src/tools/registry.ts` | ✅ Closed (as a truthfulness fix — the path itself is still dead, see below) |

### P4.1 — what `subagent` actually does (restated 2026-09-28)

**It cannot run. In any layout.** Three independent, individually verifiable facts:

1. `spawn()` calls `require('node:fs')` from an **ESM** module → `ReferenceError:
   require is not defined`. It throws immediately after `fork()`, before the child
   is even tracked, in dev and in a compiled build alike. (`node --input-type=module
   -e "require('node:fs')"` reproduces the error.)
2. Its fork target, `src/tools/child-agent-entry.js`, is written in **CommonJS**
   (`require`, `__dirname`) under this package's `"type": "module"`, so even a
   fork that resolved would have the child die on `require is not defined`.
3. The build (`tsc` + a copy of `src/resources`) never emits that entry —
   `allowJs` is `false`, and `dist/tools/` contains `child-agent-worker.js` but **no**
   `child-agent-entry.js`. So a compiled build forks a path that does not exist.

On top of that, `handleExit` **fabricated success**: a child that exited 0 having
sent no `result` message was marked `completed` with
`result: 'Task completed successfully'`, so `subagent wait` returned success for a
run whose output never existed — the finding-#4 defect, still present here.

**Fixed (truthfulness only, not the capability):**

- `classifyChildExit()` in `subagent-spawner.ts` — exported and tested — encodes
  "no result ⇒ failure, never success".
- `delegate_system`'s refusal no longer offers `subagent` as an alternative. A
  refusal that sends the caller to a path performing no work is the same defect the
  refusal exists to report.
- The `subagent` tool description is marked **NOT CONNECTED** and points at
  `delegate`.

**Making `subagent` work is net-new work and has NOT been done** — it needs the
entry ported to ESM, shipped to `dist/`, the `require` removed, and a real
end-to-end test (fork → LLM call → result). It is listed under [Open](#open)
because nothing about the capability was delivered.

## Status — gateway inbound attachments (P2 follow-on)

Workstream opened by the P2 fix. All rows below verified in the session that closed
them; the whole path is: transport downloads bytes → `InboundMessage.media` →
`hydrateInboundMedia` (writes to the artifact sandbox, runs the **same**
`read_extract` the agent uses, or the existing `transcribe()` for audio) →
`handleInbound` prepends the section to the turn.

| Item | Status | Evidence |
|---|---|---|
| `read_extract` promoted to CORE + named in `read_file`'s refusal | ✅ Closed | `toolsets.ts`, `coding-tools.ts`, `tests/tools/toolsets.test.ts`, `tests/tools/coding-tools.test.ts` |
| WhatsApp inbound document download + extraction | ✅ Closed | `src/gateway/whatsapp/baileys-bridge.ts`, `tests/gateway/whatsapp-bridge.test.ts` |
| Telegram inbound document download + extraction | ✅ Closed | `src/gateway/adapters.ts`, `tests/gateway/adapters-messaging.test.ts` |
| Discord + Slack inbound documents over **webhooks** | ✅ Closed | `parseWebhookPayload` + `WebhookReceiver`, `tests/gateway/adapters-messaging.test.ts` |
| Auto-reply naming the reason when a document cannot be extracted | ✅ Closed | `formatMediaFailureReply`, `attachment_failed` inbox disposition, `tests/gateway/registry.test.ts` |
| Scheduled sandbox cleanup (TTL 7d + 200 MB cap, hourly, on the liveness tick) | ✅ Closed | `pruneInboundMedia`, `tests/gateway/inbound-media.test.ts` |
| Voice-note transcription via the existing whisper path | ✅ Closed | `hydrateInboundMedia` audio branch, `tests/gateway/inbound-media.test.ts` |
| Voice-note **reply** (`replyInKind`) | ✅ Closed | `tests/gateway/registry.test.ts` |
| `gateway.inboundAttachments` config toggle (enable + `maxBytes` cap) | ✅ Closed | `src/config/types.ts`, `inboundAttachmentPolicy`, `tests/gateway/inbound-media.test.ts` |
| Dashboard Channels inbox: attachment-failed count + reason | ✅ Closed | `hub-data.ts`, `types.ts`, `AgentHub.tsx`, `tests/web-dashboard/hub-data.test.ts` |
| **Discord/Slack real-time inbound transport** (Discord Gateway WS + Slack Socket Mode) | ✅ Closed | `src/gateway/realtime.ts`, `tests/gateway/realtime.test.ts` |

### The real-time transport decision (was the last open item)

Discord bots cannot own a webhook URL, and Slack apps that cannot expose public
HTTPS use Socket Mode — so webhook-only attachment handling was unreachable in
practice on both platforms. Decision: **dial out.**

- `DiscordGatewaySource` — `/gateway/bot` (fallback: the public gateway) → op 10
  HELLO → op 2 IDENTIFY with `GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT`,
  heartbeat on the advertised interval, op 0 `MESSAGE_CREATE` → attachment download.
- `SlackSocketModeSource` — `apps.connections.open` (app token `xapp-…`) → ack every
  envelope → the **same** `event_callback` envelopes the Events API posts, parsed by
  the **same** `parseWebhookPayload` → `url_private*` files fetched with the bot token.
- Both reuse `downloadInboundAttachment` and `mediaKindFromMime`, so extraction,
  auto-reply and pruning are shared rather than reimplemented. Both reconnect with
  exponential backoff and never throw into `Adapter.start()`; the socket and `fetch`
  are injectable, so no test touches the network.
- Enabled by configuration, not by default: Discord needs `DISCORD_BOT_TOKEN`,
  Slack needs `SLACK_APP_TOKEN`.
- **The live pass is written down**: `docs/GATEWAY.md` §13 is the manual checklist
  for both platforms (the Message Content intent, Slack's `files:read`, what to
  watch, and what a pass looks like at each layer). The suite proves the protocol
  against a scripted socket; it cannot prove an app's intents and scopes.

## Verification

```bash
npx tsc --noEmit                                        # must be clean (src only)
npx vitest run tests/tools                              # 619 passed (39 files)
npx vitest run tests/tools/tool-truthfulness.test.ts
npx vitest run tests/gateway                            # 437 passed (23 files)
node scripts/check-doc-citations.mjs --check            # cited docs exist + are tracked
```

(`node scripts/check-doc-citations.mjs --check` is also an npm script,
`npm run docs:citations:check`, and `tests/docs/doc-citations.test.ts` asserts the
same invariant, so the guard runs wherever the suite does.)

Last verified: **2026-09-28** — typecheck clean; `tests/tools` 619 passed;
`tests/gateway` 437 passed (includes `realtime.test.ts`, 8 tests);
`tests/docs` 13 passed (3 files, incl. the 8 doc-citation guards); the four suites
together (`tools` + `docs` + `gateway` + `agents`) 2305 passed.

Note: the root `tsconfig.json` includes only `src/**/*`, so `tsc --noEmit` does
**not** typecheck `tests/` — a test-only type error surfaces in vitest, not in the
typecheck step.

## Protecting this document from being lost again

`scripts/check-doc-citations.mjs` (`npm run docs:citations:check`, plus
`tests/docs/doc-citations.test.ts` and a named CI step in both workflow files)
fails when a source file cites a `SCREAMING_SNAKE.md` that is missing, or that
exists but is **gitignored** — the exact way this file was lost. `*.md` is ignored
by default in this repo and tracked only by explicit whitelist, so a plan/tracker
doc is one forgotten `!` line away from being invisible.

It immediately found **three more docs in the same trap** — cited from code while
gitignored, so on a fresh clone every comment pointed at nothing:

| Doc | Cited from | Now |
|---|---|---|
| `AGENT_NUVIRA_MAJOR_REVAMP_PLAN.md` | `src/enterprise/vault.ts:50` (Phase A1 design reference) | ✅ published (whitelisted) |
| `ENTERPRISE_GRADE_TRACKER.md` | `src/tools/tool-loop.ts:106`, `src/agents/agents/writer.ts:225`, `tests/tools/state-change-autonomy.test.ts:4` (the G16/G18 audit) | ✅ published (home paths scrubbed to `~`) |
| `NUVIRA_ROUTER_ROADMAP.md` | `src/enterprise/secrets.ts`, `sbom.ts`, `audit-chain.ts` (§P6 milestones) | ✅ published (whitelisted) |

All three are whitelisted in `.gitignore` alongside this file, so the guard needs
no exemption for them and the acknowledgement list is empty.

## Open

1. **Make `subagent` real** (P4.1 capability) — port the entry to ESM, ship it to
   `dist/`, drop the ESM `require`, and cover fork → LLM call → result end-to-end.
   Nothing about the capability exists today; only its refusal is honest.
2. Findings **#2** and **#8** — no surviving witness; recoverable only from the lost
   original.
