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
| **P4.1** | `subagent` — child-process spawning. Was dead in every layout and its worker simulated both the model and the tools. Restated, then **implemented for real**: the child forks, resolves a provider from your config, calls the model, runs real tools (native protocol, or the shared JSON fallback where the provider has none), records what served the run, and refuses instead of faking output. | `src/tools/child-agent-entry.ts`, `child-agent-runtime.ts`, `subagent-spawner.ts`, `registry.ts`, `src/web-dashboard/hub-data.ts` | ✅ Closed (capability delivered) |

### P4.1 — what was wrong, and what `subagent` does now (2026-09-28)

**What was wrong.** Four defects, each independently verifiable:

1. `spawn()` called `require('node:fs')` from an **ESM** module → `ReferenceError:
   require is not defined`, thrown immediately after `fork()`, before the child was
   tracked. (`node --input-type=module -e "require('node:fs')"` reproduces it.)
2. Its fork target, `src/tools/child-agent-entry.js`, was written in **CommonJS**
   (`require`, `__dirname`, a `parentPort` import from worker_threads no forked
   process has) under this package's `"type": "module"` — so a fork that resolved
   died on `require is not defined`.
3. The build never emitted that entry (`allowJs` is `false`; `tsc` produces `.js`
   only from TypeScript), so a compiled install forked a path that did not exist
   (`dist/tools/` had `child-agent-worker.js` and no entry).
4. `handleExit` **fabricated success**: a child that exited 0 with no `result`
   message became `completed` + `result: 'Task completed successfully'`.

And beneath all four, the worker was a **simulation**: `LLMClient.call()` switched
on keywords in the goal and returned canned strings, while `ToolExecutor.execute()`
answered `Executed <tool>` without running anything. A "completed" subagent had
done nothing at all.

**What it does now** (`child-agent-entry.ts` + `child-agent-runtime.ts`):

- The entry is **TypeScript**, so `tsc` emits `dist/tools/child-agent-entry.js` and
  the compiled layout forks a file that exists. A source run (tsx/vitest) forks the
  `.ts` through the tsx loader — `resolveChildEntry()` picks the layout that is
  actually present instead of assuming one.
- It resolves a **real provider** from your configuration
  (`ConfigManager.getProviderConfig` → `ProviderFactory`), checks `isAvailable()`, and
  makes real model calls. Tools the caller allows are offered as real schemas
  (`toolJsonSchemas`) and executed through the **real registry**; the assistant turn
  is replayed with its tool-call ids and `providerMeta` intact.
- **Tools work even where the provider has no tool protocol.** `transportFor()`
  chooses `native` when the provider implements `generateTools`, and otherwise the
  **shared JSON fallback** — the same `buildJsonFallbackPrompt` +
  `extractFallbackToolCalls` pair the chat and execute loops already use, so a
  subagent speaks the dialect the rest of the system parses rather than a private
  one. This replaces an earlier refusal: a local Ollama setup had no way to spawn a
  subagent *with* tools, because `local` cannot do native tool-calling. The chosen
  transport is reported as `native | json | none`.
- It **refuses instead of fabricating**: no constructible provider, an unreachable
  backend, or an unknown tool name raise a typed `SubagentRefusalError` whose `code`
  crosses the IPC boundary. There is no code path that returns a plausible answer
  for work that did not happen.
- **A finished run is inspectable after the fact.** The child reports the provider,
  model and transport it actually used; the spawner persists them (with the refusal
  `code`, when there is one) beside the run's state, and the dashboard's
  **Subagents** tab lists the most recent runs with each one. "It answered nothing
  useful" reads very differently when the row says `local · json` than when it says
  the provider you configured.
- **And a run in flight is watched, not guessed at.** A child reports `running` and
  only later `completed` or `failed`, so the tab re-reads the hub on a short timer
  **while something is running** and tears the timer down the moment nothing is —
  the row and the tab badge move without a manual Refresh, and an idle panel never
  polls.
- `classifyChildExit()` — exported and tested — encodes "no result ⇒ failure".
- `subagent wait` now converts the rejection into the standard refusal shape
  (`{success:false, code, error}`) instead of letting a raw throw reach the model,
  and `subagent spawn` exposes the `tools` allow-list it always advertised.
- `delegate_system`'s refusal offers `subagent` again — the rule is that every
  alternative named must be a path that executes, and now this one does.

**Verified three ways** (`tests/tools/subagent-end-to-end.test.ts`, 8 tests):

- *Source layout*: a real fork, a real provider (`local`), and a real HTTP request
  to a server started in the test — asserting the model's own answer comes back over
  IPC, plus the unreachable-backend refusal carrying `code: 'not_configured'`.
- *Fallback transport*: a provider with **no** `generateTools` still runs the tool
  loop — the tool call travels as `{"tool":…}` text, the shared extractor parses it,
  the tool really runs, and its output is replayed on the next turn
  (`transport === 'json'`, and no raw tool block survives into the answer).
- *Compiled layout*, run by hand: `node dist/tools/child-agent-entry.js` forked with
  an IPC channel returned
  `{"type":"result","result":"FROM-THE-COMPILED-ENTRY","llmCalls":1,…}` and exit 0.
  (A full `npm run build` is required — `tsc` alone leaves extensionless imports
  that Node's ESM resolver rejects; `scripts/fix-esm-extensions.mjs` is what makes
  `dist/` runnable.)

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
cd src/web-dashboard && npx tsc --noEmit -p tsconfig.json # the dashboard tree
npx vitest run tests/tools                              # 628 passed (40 files)
npx vitest run tests/tools/tool-truthfulness.test.ts     # the P0/P1 assertions
npx vitest run tests/tools/subagent-end-to-end.test.ts   # real fork + real HTTP
npx vitest run tests/gateway                            # 445 passed (23 files)
npx vitest run tests/web-dashboard                      # 296 passed (16 files)
npm run test:dashboard                                  # dashboard typecheck + 307 passed (28 files)
node scripts/check-doc-citations.mjs --check            # cited docs exist + are tracked
```

(`node scripts/check-doc-citations.mjs --check` is also an npm script,
`npm run docs:citations:check`, and `tests/docs/doc-citations.test.ts` asserts the
same invariant, so the guard runs wherever the suite does.)

Last verified: **2026-09-28** — both typechecks clean (root `src` and
`src/web-dashboard`); `tests/tools` 628 passed (40 files, incl. the now 9-test
`subagent-end-to-end.test.ts`); `tests/gateway` 445 passed (23 files, incl.
`realtime.test.ts`); `tests/docs` 13 passed (3 files, incl. the 8 doc-citation
guards); `tests/web-dashboard` 296 passed (16 files) and the front-end suite
**307 passed (28 files)** — both including the new Subagents-tab coverage (and the
root suite as a whole: **7029 passed, 360 files**).

### Counts are formatted by one pinned formatter, not by the machine's locale

`ModelsPanel.test.tsx` and `RoutingInsightsPanel.test.tsx` asserted one locale's
digit grouping — `1,048,576` and `131,072`. That only holds where `toLocaleString()`
groups like en-US: on an **en-IN** machine the same values render as `10,48,576` and
`1,31,072`, on **de-DE** as `1.048.576`, and on **fr-FR** with narrow no-break
spaces. The suites therefore passed in CI and failed on the developer's own
machine, which is the worst version of this bug.

The first fix made the *assertions* locale-aware (build the expected string with the
same `toLocaleString()` the renderer calls). That stopped the suite from being wrong
but left the product wrong: the same count read `35,000` here and `35.000` there, so
a word count could be read as a decimal, and a factual number could not be quoted in
a bug report and reproduced. **Counts now go through one formatter** —
`formatCount()` in `src/utils/format.ts`, on a module-level
`Intl.NumberFormat('en-US')` — and the dashboard consumes it through
`src/web-dashboard/src/format.ts` (a re-export shim, the same pattern as `mask.ts`).
55 call sites across 25 files were converted; the assertions are now the plain
literals they always wanted to be (`'131,072'`, `'2,500 characters'`).

Scope is deliberately **numbers only**: the ~30 remaining bare `toLocaleString()`
calls in `src/` are all `new Date(...)` and dates are still locale-formatted on
purpose. One conversion was reverted on the evidence — `cli/admin.ts` passed a `Date`
to what it assumed was a number formatter, and the root typecheck caught it.

**Verified:** the front-end suite (307) passes under **en-US, en-IN, de-DE, fr-FR and
ja-JP**; the root suite (7029) passes under the machine default, **de-DE** and
**fr-FR** — the assertions no longer depend on the ambient locale at all, so passing
everywhere is the expected result rather than a coincidence.

Note: the root `tsconfig.json` includes only `src/**/*`, so `tsc --noEmit` does
**not** typecheck `tests/` — a test-only type error surfaces in vitest, not in the
typecheck step.

## Status — the live subagent run and the gateway credentials check (2026-09-28, second pass)

Three things came out of running the real path instead of the suite. All three were
invisible to tests, because all three are about what the *shipped artifact* and the
*operator's own surface* say.

### 1. The Subagents tab existed in the source and not in the product

`readSubagentsData()` and the tab's rendering were correct and covered — and the
committed dashboard bundle did not contain them. `grep -c Subagents` on the shipped
`public/assets/index-*.js` returned **0**: the bundle had been built before the tab
landed, and the dashboard server serves `src/web-dashboard/public` directly, so the
served page was the old one. Nothing in the suite can catch this — vitest runs the
source, not the artifact. Rebuilding (`cd src/web-dashboard && npm run build`) makes
the shipped bundle contain the tab, and the asset hash changes with it, so the
staleness is visible in a diff next time.

**Guarded now** by `scripts/check-dashboard-bundle.mjs` (`npm run
dashboard:bundle:check`), so the next silent drift is a failing check instead of a
missing feature. It has two modes because the two halves of the problem need
different evidence. The default reads GIT HISTORY — the newest commit touching the
bundle's inputs must not be newer than the newest commit touching its outputs —
which is cheap, needs no build, and catches exactly the case above (on this repo it
blames `2bf0db2 Give the Subagents tab live state while a child process runs`).
`--rebuild` builds with the dashboard's own toolchain and compares byte for byte,
which also catches a stale bundle committed in the SAME commit as its source, where
history cannot order the two. Both are in CI, and `--rebuild` is step 5/5 of
`scripts/ci/regression-gate.sh`.

Three things were measured while writing it, and each one changed the design:

- **Directory pathspecs re-imported the test files.** `git rev-list --
  src/web-dashboard/src` sweeps everything beneath it, `*.test.tsx` included, so it
  blamed the locale-assertion commit — which touched nothing in the dashboard but
  tests. The input set is an enumerated list of files, never a directory.
- **The sourcemap is relative to the OUTPUT directory.** A build into `/tmp`
  produced a byte-different map, so the comparison builds into a scratch dir at the
  SAME DEPTH as `public/` (`src/web-dashboard/.bundle-check`), removed afterwards.
  Nothing is written to `public/`, so the check cannot clobber uncommitted work.
- **A build is not environment-independent.** Vite bakes `NODE_ENV` into the bundle:
  with `NODE_ENV=test` this tree emits `index-BEXqDnGR.js` where the committed
  artifact is `index-DxxxI4lk.js`. The check pins `NODE_ENV=production`, or it would
  report a good bundle as wrong every time it ran under a test runner.

### 2. A subagent run reported WHO served it only if it succeeded

The child process announced its provider on a `progress` frame and then reported
`provider`/`model`/`transport` on the `result` frame. The parent recorded those from
`result` only — so a run that **failed** (the case you actually need to debug)
reached the dashboard as a bare error string with no provider, model or transport at
all. MEASURED on the first real run: `refusalCode: "unavailable"` and a 404 message,
and the dashboard row could not say which backend produced it.

Fixed on both sides of the boundary:

- the child computes the model it is about to send with `resolveAdapterDefault` — the
  same resolver every adapter calls for itself — and passes it **explicitly** to each
  model call, so "it reported model X" cannot disagree with "it sent X"; and it sends
  provider/model/transport on its FIRST frame, before anything can fail, and repeats
  them on the error frame;
- the parent records the identity from **every** frame (`recordIdentity`), so a child
  that is killed mid-call still attributes the run from the first frame it sent.

`subagent` also now accepts `provider`/`model`, because auto-routing can resolve a
model the account cannot serve and the caller had no way to say which to use instead.
Covered by three assertions in `subagent-end-to-end.test.ts`: success, refusal, and a
run killed while the model call is still open (the last one verified non-vacuous by
deleting the progress-frame recording and watching it fail).

### 3. The key Slack's Socket Mode needs was not in the config surface

`docs/GATEWAY.md` documents `config gateway set slack` as needing
`BUFF_SLACK_APP_TOKEN` (Socket Mode) alongside the bot token. The CLI never offered
it: `PLATFORM_ENV_VARS.slack` held only the bot token, so the wizard did not ask for
it, `config gateway list` did not show it, and the dashboard form did not render it.
Live evidence — `gateway start` printed
`Slack: real-time Socket Mode inbound skipped — no app-level token`, while
`config gateway list` reported `✅ Slack`. The operator was told the transport was
connected and given no surface that named the missing key.

Fixed by splitting "required" from "additional": `PLATFORM_TRANSPORT_ENV_VARS` +
`platformConfigVars()` feed the wizard, `config gateway list` and the dashboard form,
while `isPlatformConfigured` keeps judging only the required vars — an outbound-only
Slack app with a bot token IS configured (it replies and downloads files), and
folding the inbound token into the required list would have flipped it to
"not configured" and blocked alias registration for a channel it can already post to.
Discord gets the same treatment for its webhook URL.

**Still blocked, and not claimable:** the GATEWAY.md §13 pass itself. There is no
Discord bot token on this machine and no Slack app-level token, so neither real-time
inbound can be exercised end to end. The checklist is documented and the surface now
names what is missing; the handshake against a real app has NOT been performed here.

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

## Status — the forked child has no verification gate (2026-09-29, found by the parity harness)

`write_file` / `edit_file` are `MUTATION_TOOLS` (`src/tools/edit-verification.ts`),
so an **in-process** turn that writes one spends a bounded verification nudge and
makes one more model call. The **forked child's** loop
(`src/tools/child-agent-runtime.ts`) has no verification gate at all — the file has
no reference to `assessEditActivity`, `MUTATION_TOOLS`, `unverifiedEdit` or the
nudge — so the same write inside a delegated run is never followed by "nothing
observed the result, run a check".

Measured, not inferred. The WS5 isolation parity scenario was first written with
`write_file` as the mutating call, and the harness reported exactly one field
diverging across the five surfaces: `modelCalls 3 vs 2` — three for each in-process
surface (ask for the write, get nudged to verify, answer), two for the child. The
scenario was then re-pointed at `run_terminal` (not a mutation tool) so the WS5 row
measures WHERE a turn works and what it changed rather than this gate, and this
entry is the record of the difference the first version found.

What is NOT claimed: that the child's loop should copy the whole nudge machinery
(bounded counter, workspace-aware nudge text, `unverifiedEdit`/`unverifiedEditClaim`
flags on its result) as part of WS5. It is a real gap in the *child's* engine and
belongs to a change that can test it on its own terms.

## Status — the dashboard isolation control (2026-09-29, found by the live dashboard run)

Adding the 🌿 control to the chat composer meant driving the real dashboard server
and the real bundle. Three things came out of it; the first two were invisible to the
suite because they only appear when a real model, a real repository and the shipped
artifact are in the same room.

### 1. A REFUSED isolated turn was re-dispatched to the pipeline — unisolated

`runChatAnswer` refuses a turn it cannot isolate and reports it as a failed turn
(`generationFailed: true`), so no surface renders the refusal as an answer. But
`generationFailed` is ALSO the trigger for the engine's no-model fallback — "the loop
produced nothing, the rules say this is a coding ask, run the pipeline instead" — and
that fallback runs a completely different engine with no isolation at all.

Measured on the real CLI, in a directory that is not a git repository:

```bash
nuvira chat "write a file called hello.txt saying hi" --worktree
```

printed the pipeline's three-task board and "Repair budget exhausted", and the word
"isolation" never appeared. A dashboard turn did the same and surfaced as
*"I couldn't get an answer from the model just now"* — blaming the model for a
decision about the directory. The operator asked for isolation, got an unisolated
run in their real tree, and was told nothing. Exactly the outcome the capability
exists to prevent.

**Both halves are closed.** The refusal now carries its own `refused: true` beside
`generationFailed`, every no-model gate requires `!answer.refused`, and the dashboard
neither offers a Retry nor queues a background re-run for one (retrying cannot make a
directory a git repository). Witnesses: the refusal reason reaches the reader
verbatim, and `tests/cli/chat-answer-once-auto-parity.test.ts` asserts the pipeline
was **never called** for a refused WRITE ask — verified to fail with the guard
removed.

### 2. A clean repository was reported as having an uncommitted change

`gitRun` returns git's stdout with a fallback message when it is empty (`out ||
'git reported no output'`), and `dirtyCount` counted LINES of that. `git status
--porcelain` on a pristine tree prints NOTHING, so every isolated turn in a clean
checkout announced:

```text
note: 1 uncommitted change(s) in the source tree are NOT in this worktree
```

and sent the operator looking for a change that did not exist. `gitRun` now returns
the exact stdout (`raw`) beside the never-empty message, counting and parsing read
`raw`, and the unit test asserts **0** on a clean repo where the old one only
asserted `> 0` (which the bug satisfied).

### 3. The card rendered nothing, because the guard demanded the wrong shape

`WorktreeDiff` carries the changed PATHS (`files: string[]`) and the unified diff
BODY (`payload: {files: [{path, body}]}`). The client-side guard checked `files` for
`{path, body}` objects, so it rejected every real payload and the API client dropped
the report — a card for a turn that changed a file would never have appeared. Found
by printing the live response (`diff.files` is `["dash-iso.txt"]`, so `.map(f =>
f.path)` gave `[null]`) rather than by any test, because the test fixture had been
written in the same wrong shape as the guard.

The guard now checks both halves, `src/api.test.ts` pins the REAL wire shape, and the
live run pins the rest: a dashboard turn with isolation on changed `dash-iso.txt`,
the response carried `payload.files[0].body` = the unified diff, and the project tree
stayed clean.

## Open

1. Findings **#2** and **#8** — no surviving witness; recoverable only from the lost
   original.
2. The forked child's loop has no verification gate (see the section above): a
   delegated `write_file`/`edit_file` is never followed by a check, and the child's
   result carries no `unverifiedEdit` flag.
2. ~~`subagent` on a non-tool-calling provider (`local`/Ollama) refuses when asked
   for tools.~~ **Closed** by the JSON fallback above: the subagent now offers the
   tools in the prompt and parses the `{"tool":…}` reply, so a local-only setup can
   spawn a subagent *with* tools. The run's `transport` says which path it took, so
   the fallback is visible rather than silent.
