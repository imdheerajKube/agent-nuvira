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

## Closed — the forked child has a verification gate (2026-09-29, found by the parity harness; closed 2026-09-29)

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

What was NOT claimed at the time: that the child's loop should copy the whole nudge
machinery (bounded counter, workspace-aware nudge text, `unverifiedEdit`/
`unverifiedEditClaim` flags on its result) as part of WS5. It was a real gap in the
*child's* engine and belonged to a change that could test it on its own terms.

### What closed it, in those terms

The child's loop now applies the SAME gate — imported, not reimplemented, so the
nudge text, the tool classification and the honesty flags cannot drift between the
loop that runs in the parent's process and the loop that runs in the child's:

- **One bounded nudge.** `runToolLoop` spends it before the child can answer when
  `assessEditActivity(successfulToolCalls, verificationEvidence, mutatedPaths)`
  says a mutation went unobserved, sends it as a `{phase:'gate', gate:'verification'}`
  progress frame (the parent's only channel), and raises the iteration ceiling by one
  so the check the loop itself asked for is not paid for out of the goal's budget.
- **Honest accounting** before the gate reads it: only calls that ran AND were not
  declined count, and `mutatedPaths` comes from the call's own `path`/`file_path`/
  `file` argument. `classifyToolRefusal` was reused rather than the bare `Error:`
  prefix for exactly the reason the in-process loop does it.
- **The verdict crosses the fork.** `unverifiedEdit` / `unverifiedEditClaim` are set
  on EVERY exit (including a ceiling), sent on the `result` frame, and recorded on
  `SubagentState`/`SubagentResult` — so a delegated run whose summary claims "I fixed
  it" is recorded as unverified instead of read as an observed result.
- **Measured, on the child's own terms.** `tests/tools/subagent-end-to-end.test.ts`
  drives the loop with a scripted provider (a write earns the nudge and the flags; a
  write plus a real check does not; a REFUSED write is not a mutation at all) and then
  forks a REAL child on the JSON transport, whose write reaches disk and whose result
  arrives at the parent with `unverifiedEdit: true` — the `modelCalls 3 vs 2`
  divergence above measured again, now `3 vs 3`.

Two things came out of doing it, both fixed in the same change:

1. **`write_file`'s REAL decline read as a success.** The classifier matched
   "needs explicit confirmation" / "retry with confirm", but `confirmFirst`
   (`src/tools/coding-tools.ts`) actually returns "…state-changing — NOT applied. Ask
   the user first via ask_user (…), then retry write_file with confirm:true…" — the
   same words, different phrasing. A write that was **NOT applied** therefore counted
   as a call that ran: it landed in `successfulToolCalls`, its path landed in
   `mutatedPaths`, the run trace recorded a change that never happened, and the
   verification gate asked the model to check a file nothing had written. The
   classifier now matches that wording (`confirmation`), with its own case in
   `tests/tools/tool-loop.test.ts`. It was the child's gate that surfaced it: the fork
   reported `unverifiedEdit` for an empty diff.
2. That fix also re-arms the **deliverable** gate correctly, which skips itself when
   `mutatedPaths` is non-empty — a declined write is no longer mistaken for a produced
   file.

The `isolation-worktree` parity scenario still makes its mutation through
`run_terminal` and keeps measuring WHERE a turn works and WHAT it changed; the
comment in `src/cli/parity.ts` no longer claims the child has no gate.

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

## WS6 (#28) — fault injection (2026-09-29)

**What it is.** Test infrastructure, not a capability a surface can have, which is
why it has no row in the capability matrix (`src/parity/matrix.ts` says so in its
scope note). It exists to make the honest answer to a dependency failure MEASURED
instead of assumed — the whole reason this tracker is about false success, and the
one shape nothing else in the suite could produce: every earlier parity row either
succeeds or fails at the TOOL level, and a failed tool still leaves a completed turn.

**Two halves.** A declared fault is served either by the harness's own loopback stub
(a `provider` fault → HTTP 500 / a truncated body / 503, so the REAL adapter's error
mapping runs and the model call still happens) or by the running agent itself
(`tool`/`ipc`, through `NUVIRA_INJECT_FAULT`, which is what proves the seam is
honoured on every surface including the forked child — it reads the declaration out
of the environment it inherited). `nuvira parity faults` lists both; the rows live in
`src/cli/parity.ts` and are driven on all five surfaces by `nuvira parity run` and by
`tests/parity/fault-injection.test.ts`.

**Four real defects, found by the rows on their first run.** Each was invisible to
the rest of the suite:

| # | Defect | Was | Now |
|---|---|---|---|
| 1 | `nuvira execute`'s direct-answer arm reported the failed turn as a success | `return { success: true }` unconditionally (the loop arm computes `!result.generationFailed`), so the SAME backend failure was "failed" on `chat` and "success" on `execute`, and the provider's apology was published as the answer — including on the `--json-events` stream (`success: true`, `tasksCompleted: 1`, `error: ''`) | `success: !answer.generationFailed`; the stream carries `tasksCompleted: 0` and the failure text in `error` |
| 2 | The parity projection read the console's request-level `ok` as a TURN completion | the dashboard reported `ok: true` with `generationFailed: true`, and `toObservation` preferred `ok` — so 2 of 5 surfaces called a backend that failed every call a completion | one helper (`turnStatus`) reads `generationFailed` first, for every surface |
| 3 | A streaming 200 that carried no SSE at all became an EMPTY ANSWER | `chatCompletionsWithToolsStream` returned `{content: '', toolCalls: []}` for a body with no `data:` line; the dashboard read that as "the model said nothing", retried to its step bound and reported **completed** ("I reached my step limit") while every non-streaming surface reported the same response as a failure | it throws when no SSE line was seen — an unparseable response is a failure, never empty-but-valid |
| 4 | A child whose provider failed mid-call left NO evidence and reported 0 model calls | `llmCalls` was incremented only AFTER a successful call (so a run that reached a model and was refused reported 0 — the harness's "the turn must have reached a model" rule refused the whole row), and the log/span were written only on the paths that produced a result, so a crashed child had `written: false` and `exported: false` | the ATTEMPT is counted before it is made; a mid-call failure writes the child's debug log and ships a RED span before rethrowing |

**A fifth finding, in the harness itself.** `subagent-spawner.waitForCompletion`
REJECTS on a failed run, so the first fault row — the first scenario where the child
legitimately ends in failure — threw out of the driver and aborted `runParityScenario`
with an exception instead of a verdict. The harness could not say "every surface
failed honestly" about the one surface most likely to fail. The driver now reads the
manager's own recorded state on rejection, so a failed child is an observation.

**How a fault row is judged.** Not by the full projection, and deliberately: under a
fatal dependency failure the CLI, the GUI, a messaging bridge and a forked child
legitimately differ in their user-facing copy, their error taxonomy, their
last-attempt attribution and their retry counts. Comparing those would report four
correct surfaces as divergent. `compareFaultHonesty` (`src/parity/scenarios.ts`)
compares `status` and the fault's own `asked`/`site`/`kind`/`took`, where `took` means
"this surface's own turn shows the consequence" — a surface that SWALLOWED the fault
reads `took: false` against every other surface's `true`, and a swallowed fault leaves
no other trace. Nothing is widened for the scenarios that declare no fault.

## WS7 (#29) — the seeded-bug benchmark (2026-09-29)

**What it is.** Test infrastructure, not a capability a surface can have (same scope
note as WS6). It measures whether the agent can FIND and FIX a defect it was not told
about — the thing a coding agent is for, and the thing M2b could only approximate:
M2b tasks are graded by hidden tests, but nothing proved a task was BROKEN before the
agent ran, so a task that already passed measured nothing and nobody could tell.

**The property that makes it a benchmark rather than a task list.** Each of the seven
seeds is declared twice — the broken workspace the agent receives, and the same
workspace after a reference fix — and verification runs the checks against both. A
seed is genuinely broken only when its check exits non-zero AND prints its own `FAIL`
marker, which is what separates "the assertion failed" from "the script crashed": a
syntax error also exits non-zero, and a seed verified by that standard would prove
nothing. The fix half proves the check is well-formed.

**It refuses to score an unverified seed.** `runSeededSuite` verifies every task
before it makes a single model call and aborts the whole run if one does not verify,
so a number can never be reported over a task that was not actually broken.
`nuvira eval verify-seeds` runs the same check with no provider and no tokens, and
exits non-zero on a bad seed — usable as a gate.

**Three things scored apart, because they fail apart** (`src/learning/seeded-benchmark.ts`):

| | Read from | Why it is not the same as the others |
|---|---|---|
| **Found** (40%) | what the run REPORTED, matched against the defect's diagnostic vocabulary | an agent can fix a defect it never explained, and explain one it never fixed |
| **Fixed** (40%) | the checks, re-run in the workspace the agent actually edited | ground truth, and the only measure that is not a reading of the model's own prose |
| **Nothing else touched** (20%) | every seeded file diffed against its original, plus any file the seed never had | "the tests pass" cannot tell a one-line fix from one that rewrote three unrelated files |

Deleting a file counts as a change, so removing the failing check is visible rather
than merely suspicious. The seeds are plain CommonJS `.js` with a `.js` check script
and no dependencies, which keeps verification deterministic, offline and fast (~0.5s
for the whole suite) — a Python seed would have to be gated on an interpreter
actually being present rather than assumed.

**What is NOT claimed:** no live provider run of the seeded suite is recorded here
(the reports table in `docs/benchmarks/INDEX.md` says so explicitly rather than
carrying a placeholder). The suite, its verification and its scoring are proven by
`tests/learning/seeded-bugs.test.ts`, which drives the scorer with fake agents — one
that applies the reference fix, one that changes nothing, and one that fixes the
right file while rewriting an unrelated one.

## Bundle 37 — the harness's own voice, and the explicit session grant (2026-10-08)

A user read one trace (`trace-1791390325578-4968th`) and saw the MODEL narrate the
HARNESS's interruptions back at them — "the command guard misfired on a read-only
check" — and read it as an agent arguing with a model. Two harness causes, both
fixed without touching the model:

1. **The gate voice.** Every loop nudge was pushed as a `user` message. A chat
   model ANSWERS a user turn, so it replied to the loop. `tools/harness-directive.ts`
   now delivers every gate nudge (promise / permission / repeat / action /
   deliverable / verification / self-review / diagnosis / malformed-call / plan /
   prerequisite / think-only, plus the child loop's verification nudge) as a
   `system`-role message prefixed with `[harness]`, DEDUPED by gate within the
   turn. The gate TEXT is unchanged — only who is seen to be speaking.
2. **The friction could not be reduced.** `learning/session-grant.ts` adds an
   explicit, per-conversation grant: "Allow this for the whole session", offered
   as one extra choice at the confirmation a tool demanded. It covers `write`
   (file mutations) and `terminal` (recoverable local-state commands) and is
   recorded as a revisable decision. It NEVER covers `external`/`destructive`:
   `sudo`, `git push`, `rm -rf /` refuse regardless, and the absolute DENY
   patterns run first.

Measured, not asserted: `scripts/measure-gate-friction.mjs` counts every `gate`
and `refusal` event per reasoning trace and prints a before → after delta when
given two files. On the local store (60 traces): 382 events, mean 6.37/turn, p90 19.
Pinned by `tests/tools/session-grant.test.ts` (11) and
`tests/tools/harness-directive.test.ts` (3); the two nudge-role assertions in
`tool-loop.test.ts` / `subagent-end-to-end.test.ts` were updated to the new
contract (`system` + `[harness]`) rather than loosened.

## Bundle 38–40 — off-machine consent, named publish, and one picture (2026-10-08)

Continued the harness-voice work with the operational half of the same report —
"why is this asking, and why won't this run?":

**38a. The off-machine grant.** The session grant gained an `external` category:
network fetches, global/system installs (`winget`, `npm i -g`), publish, push. It
is offered at the friction point exactly like `write`/`terminal`, and is the ONLY
category a blanket request can never reach — it exists so a user who WANTS the
agent to install a toolchain can say so once. The hard DENY floor is untouched:
the patterns run before the grant is consulted, so `sudo`, `rm -rf /`, `git push`
as a raw shell string stay denied with any grant. Wired in `run_terminal.ts`
(category = recoverable ? terminal : external), `git-tool.ts` (push), and
`run-cli.ts` (external intents only — never an irreversible local one).

**38b. A named publish proceeds.** `decideCliIntentConfirmation` now treats a
`publish` the user's OWN request resolves to like a named `git push`: it
proceeds and reports. An UNNAMED publish (the model's idea) still always asks.

**39. Narration is detected.** `learning/harness-narration.ts` flags an answer
that reuses a DISTINCTIVE token (a hyphenated compound or a ≥10-char word) from
the harness's own text — no phrase list; the vocabulary is derived at runtime
from what the harness actually said. `scripts/detect-harness-narration.mjs`
reports it over live traces. HONEST LIMIT: it catches the model QUOTING the
harness, not a paraphrase in the model's own words.

**40. One picture.** `learning/consent-picture.ts` states, in one place, what is
DENIED (never runs), GRANTABLE (one explicit session grant), or DECIDED by
evidence (the request names it). `learning/gate-friction.ts` summarizes the
gate/refusal/narration counts from the traces. The dashboard serves all three —
`GET /api/gates`, `/api/consent`, `/api/session-grants` (+ a POST to end one) —
and the Models panel renders them: the friction number, the live session grants
with an **End** button, and the consent table.

## Bundle 41 Phase 1 — one capability descriptor (2026-10-08)

**The finding.** Four registries overlapped and none of them knew what an action
DID. `src/tools/registry.ts` (tools + zod schemas) hardcoded a gate per tool;
`src/tools/toolsets.ts` tiered them; the skills carried only methodology; the CLI
manifest carried one `confirmation` boolean. So "what does this need, and what
does it touch" was re-stated in prose at every site — tool descriptions, the
consent picture, refusal strings, the CLI intent tables — and any new verb meant
editing all of them. That duplication is the disease; the drift between the
copies is what the user sees as the agent fighting itself.

**The fix.** `src/learning/capability-types.ts` defines the ONE descriptor:
`{ id, kind: 'tool'|'skill'|'action', ref, name, oneLiner, effectClass,
reversible, reversibleHow?, grantCategory?, requires: {credentials,binaries,
inputs}, tags }`. `src/tools/capability-registry.ts` ADAPTS the existing sources
into it — every registered tool, the hub skill catalog, and nine curated
high-level actions that only existed as prose. It does NOT import the tool
registry (callers pass the tools in), so `tool_search` uses it without a cycle.

**The conservative default.** An unlisted tool becomes `local-state` + reversible
+ NO grant category. Both choices are deliberate: `read` would hide a mutation as
inspection, and a grant category would let a user's grant silently unlock an
undeclared action. A network READ (`web_search`, `read_page`, `osv_check`) is still `read` —
the class describes what the action DOES, not where it runs.

**Discovery.** `tool_search`'s `search` action returns the same tool hits as
before PLUS a `capabilities` array carrying effect / reversibility / undo /
requirements / grant. The model can now ask "how do I publish a package" and get
the effect class and the token it needs, not just a tool name. Phase 1 changes no
behaviour: nothing routes on a descriptor yet.

**Measured, not asserted.** `scripts/measure-capability-search.mjs`, two probes,
no phrase list:

- self-retrieval (query each capability with its own words at top-K=10): tool
  87% rank-1 / 100% top-5 · action 100% / 100% · skill 99% / 99%;
- consequential recall over 60 live traces (38 tool-using turns). Ground truth is
  what the model ACTUALLY did, and the query is the model's OWN pre-call prose
  (`steps[].responsePreview`), which is the query it would really issue: 12/22
  consequential pairs surfaced (55%), 10/17 turns fully covered (59%).
  Precision proxy: turns that touched nothing yet still rank an off-machine action
  — 5/21 (24%). Plumbing (`suggest_followups`, `read_file`, `plan_todo`) is NOT
  graded on purpose: a user's goal should not name it, so counting it would
  fabricate a miss.

HONEST LIMIT: 55% is a lexical baseline. A goal names an outcome ("build a
knowledge base app"), not a tool ("write_file"), so goal-text matching alone can
never be the discovery path — which is the argument for Phase 2, where the MODEL
selects by descriptor and the gate reads `effectClass` instead of parsing prose.

## Bundle 50 — this machine, stated not assumed (2026-10-08)

**The finding.** The per-OS command map (Bundle 47) covered two verbs and said
nothing about the host. A model reasoning about "how do I do X here" had to
assume the OS family and guess which package manager existed — and a wrong guess
(`apt` on a `dnf` machine, `brew` on Windows) is a command that cannot run. The
facts it needed were cheap to detect and were being re-derived, badly, every
turn.

**The fix.** `src/learning/machine-facts.ts` detects OS / release / distro /
arch / shell / installed package managers ONCE per process. Detection uses
`binaryOnPath` — the SAME `which`/`where` resolver the shell uses — so "present"
is a fact, not a declaration, and cannot drift. The loop injects a bounded
`## This machine` block into the system prompt (chat and execute), measured in
the budget ladder as an optional block that drops after the skill hint. The facts
are also a capability (`action:machine-facts`), so `tool_search` returns them.

**Where this differs from a per-OS table.** Bundle 47 declares the command for
the verbs where the OS DETERMINES it and a wrong guess is destructive. This is
the other half: it detects what is PRESENT, which is the input that lets the model
DERIVE a command for the long tail instead of the harness enumerating it. The
model is the general intelligence; the harness supplies facts.

**The honest limit.** Facts say a binary is present; they do not say the flags
are right (`apt` vs `apt-get`, `-y` vs `--yes`). Presence is the fact the harness
can establish; choosing and adapting the command stays the model's.

Pinned by `tests/learning/machine-facts.test.ts` (10).

## Bundle 49 — the Capabilities page, or what the agent can do here (2026-10-08)

**The gap.** Bundles 41–47 built the capability layer — effect, reversibility,
requirements, per-OS commands — and exposed it to the MODEL through `tool_search`.
The human saw none of it. A user could not answer "will `deploy` work on my
machine?" before asking for it, nor see that a verb was waiting on an executable
that is not installed; the answer only surfaced as a run that abandoned halfway.

**The fix.** `src/learning/capability-readiness.ts` is a read-model over the SAME
`actionCapabilities()` the search serves and the SAME `probeRequirements` the
pre-flight runs, so the page cannot disagree with what a run sees. It reports each
curated verb's readiness, aggregates the missing executables (the same `gh` is one
row, not nine), and resolves the per-OS `onThisMachine` command. `GET /api/capabilities`
serves it (open, like the other read paths — declarations and PATH facts, no user
data), and the new `/capabilities` page renders it beside the live session grants,
which it reads and ends through the existing `/api/session-grants` (one source).

**The honesty carried through.** A binary gap marks a verb blocked; a credential
that is merely absent from the environment does not — it may live in the vault, so
it is reported and never blocks. The page states the asymmetry rather than
flattening it to a red/green.

## Bundle 48 — skill selection is the model's job, the keyword scorer is gone (2026-10-08)

**The finding.** `src/tools/loop-skill-hint.ts` decided WHICH skill a goal wanted
in code: `findLoopSkillMatch` scored the compiled store and the hub catalog, then
`hasRealGoalEvidence` pulled the false positives back with a stopword list, a
generic-name-word list (`test`), a generic-tag list (`packaging`), and a
platform-host list (`windows`, `linux`). The same `isSkillActivated` gate was
imported by `src/agents/orchestrator.ts`, so the keyword decision served the
chat/execute loop AND the pipeline. Every list was a live bug report: "blood test
report" matched the software `test-strategy` skill, "Windows and Linux" matched
`wsl-setup`, "packaging" matched `electron-app`. The user called it "the least
intelligent piece" — a word list cannot decide what a goal MEANS, and each word
added to force one case right made some real match wrong.

**The fix.** Delete the scorer, on every surface. Selection is the model's:

- the loop default (`pointer`) injects a bounded **discovery pointer** naming the
  two model-driven paths — the `skill` tool and the capability search
  (`tool_search`, hits of `kind:"skill"`);
- `buildSkillCatalogHint` (full `catalog` / `names`) stays OPT-IN via
  `NUVIRA_SKILL_CATALOG` / `skills.catalogHint`; the retired `match`/`keyword`
  values still parse and now alias the pointer;
- the orchestrator no longer keyword-matches: it hands the planner the **catalog**
  (`vault.setMeta('skillCatalog', …)`, `loadHint: 'skill-view'`), and the planner
  names the skill a step needs — the writer loads it with `skill_view(name)`.

Removed: `findLoopSkillMatch`, `hasRealGoalEvidence`, `isSkillActivated`,
`isPlatformName`, `buildLoopSkillHint`, `markLoopSkillUsed`, `LoopSkillHintMatch`
and the five word/host sets. Kept and shared: the catalog builder, so loop and
pipeline cannot disagree about what a skill IS. `skillStore.findMatch` and
`findHubSkillMatch` stay for MANUAL discovery (the CLI, and the learning dedup
check) — the retired thing is auto-injection, not lookup.

**The guard.** `DEFAULT_SKILL_HINT_MODE === 'pointer'` and the default hint stays
< 2000 chars (`tests/release/agent-contracts.test.ts`), so the 3.3.11 catalog
blow-up cannot return. The pointer names BOTH discovery paths; the catalog honors
`skills.disabled[]`; the planner renders `skillCatalog`.

## Bundle 47 — per-platform commands, declared only where the OS decides (2026-10-08)

**The ask.** "Will this cover all commands on Windows, Unix and macOS? The agent
will run on all, and the model will need to execute capabilities on all three."

**The finding, which reframed the work.** The question assumes the OS determines
the command for every verb. It does not, and blanket-adding a per-OS map would have
fabricated mappings that do not exist:

| Verb | OS-determined? | Why |
|---|---|---|
| `install-system-tool` | YES | winget / brew / apt-get — no portable form |
| `store-credential` | YES | the OS decides WHERE a secret can live |
| `install-package`, `add-dependency` | NO | `npm install` is identical everywhere; npm-vs-pnpm is a preference |
| `deploy-app` | NO | vercel-vs-flyctl is a platform choice, not an OS one |
| `publish-package`, `push-git` | NO | the toolchain is the same on all three |

**The fix.** `PlatformCommand` declares a command per OS, present EXACTLY where the
OS decides. `tool_search` resolves the current machine's entry into
`onThisMachine` and ships the full map beside it, so the model reads the right
command rather than inferring the package manager from a platform name.

**Two honesty details.** The Linux install hint states its root requirement rather
than hiding it, and it deliberately does NOT ship a `sudo` command — `sudo` is on
the unconditional DENY floor, so declaring it would hand the model a command it can
never run. And `PlatformCommand.binary` is OPTIONAL: `store-credential` runs
through nuvira itself, so naming a PATH binary for it would be a false fact.
The type carries the distinction instead of the data lying about it.

**The guard.** A test asserts every declared platform binary appears in the
capability's own `binaries` requirement — so a platform hint can never name a tool
the requirement pre-flight did not check for. The two halves are the same fact and
must agree. A second test pins the ABSENCE for the OS-neutral verbs, so nobody
"helpfully" adds a fabricated map later.

Pinned by `tests/tools/capability-registry.test.ts` (31).

## Bundle 46 — the CLI intent sets become one declaration table (2026-10-08)

**The finding.** `autonomy-policy.ts` carried three hand-maintained sets
(`IRREVERSIBLE_CLI_INTENTS`, `RECOVERABLE_CLI_INTENTS`, `EXTERNAL_CLI_INTENTS`),
and membership was the ONLY fact each carried. So "is it reversible", "does its
effect leave this machine" and "may a grant cover it" were all re-derived by
whoever read the call site — and `EXTERNAL_CLI_INTENTS` was literally
`new Set(['publish'])`, a set of one that existed only to answer a question the
declaration should answer.

**The fix.** `learning/cli-intent-effects.ts` declares all 14 confirmation-gated
intents with `effectClass` / `reversible` / `grantCategory` / `why`, and
`cliIntentGateFacts(intent)` derives the gate view in ONE place for `run_cli`, the
policy and the consent picture. The three sets are retired.

**The publish rule is now general rather than special.** It read
`intent === 'publish'`; it now reads the declaration
(`grantCategory === 'external' && namedByRequest`), so a second off-machine intent
inherits it without an edit here — which is the difference between a rule and a
coincidence.

**Not a policy change.** Every declared category is what `run_cli` already
computed (external for publish, terminal otherwise, nothing for the irreversible
local ones). A test writes the old membership down once, so a future edit has to
change behaviour CONSCIOUSLY instead of drifting into it.

**The guard, and how it paid for itself immediately.** The declared intents and
the manifest's gated intents must be the SAME set — a newly gated command cannot
ship without an effect, and a removed one cannot leave a ghost. While building the
table I read `command-manifest.json` for intents whose own `confirmation` is true,
counted 13, and concluded `contacts.remove` was dead membership that had never
existed as a gate.

**That was wrong, and the guard is what caught it.** The manifest expresses gating
in TWO places — an intent's own `confirmation`, AND `resolutions[].confirmation`
for a specific resolution of an intent. `contacts.remove` is gated ONLY through
the second form, so a check that reads the top-level flag alone calls it a ghost
and deletes it. There are 14 gated intents, not 13. The declaration is now present,
and a test pins BOTH the resolution-only shape and its declaration, so the trap is
recorded rather than re-discovered.

Pinned by `tests/learning/autonomy-state-change.test.ts` (31), including the
manifest parity guard, the resolution-only case, and the behavior-equivalence
table against the retired sets.

## Bundle 45 — parallel read fan-out derived from the registry, 6 tools to 21 (2026-10-08)

**The finding.** Which tools may run concurrently inside one step was a
hand-maintained SIX-NAME allowlist in `tool-loop.ts`. The header even argued for
the design ("an ALLOWLIST … a tool added to the registry later is SERIAL by
default until it is reviewed as read-only") — and that reasoning was sound, but the
COST was invisible: every read tool added since, and every read-only MCP tool
discovered at runtime, silently stayed serial because nobody remembered the list.
That is the same hand-maintained-table disease as the gate sets, in the hot path.

**The fix.** `isParallelSafeTool` asks the capability registry's `effectClass`.
Fan-out went from 6 to **21** tools, verified against the build:

```
read_extract read_file read_page search_memory secret_scan security_score
suggest_followups threat_patterns url_safety verify_requirement web_search
fuzzy_match glob list_dir list_memories memory_stats osv_check path_security
process_registry analyze code_search
```

**The safety direction is UNCHANGED.** A tool the registry does not describe maps
to `local-state`, so a newly registered tool is STILL serial until someone
declares it a read. That conservative default — built in Bundle 41 — is exactly
what makes replacing an allowlist with a derivation a widening rather than a
loosening.

**A finding that would have been a REGRESSION if I had trusted the effect class.**
`effectClass: 'read'` is NECESSARY but NOT SUFFICIENT for safe fan-out:

- `tool_search` genuinely reads the world and MUTATES the tiering state that
decides which tools exist in the NEXT step;
- `ask_user` genuinely reads and BLOCKS on the human.

Two siblings fanned out around either one would disagree about the world they are
reading. Both stay serial through one small explicit `READ_BUT_SERIAL` set — a
HARNESS fact, not an effect guess. The old test had already recorded both (its
comments read `// mutates the tiering state` and `// blocks on user input`), which
is how the exception was found rather than shipped.

`parallelSafeToolNames()` derives the set by filtering with the same predicate, so
the published set and the hot-path decision cannot disagree.

Pinned by `tests/tools/parallel-tool-exec.test.ts`, which now asserts: the plainly
read-only tools are safe; the stateful/blocking/off-machine ones are not; each
`READ_BUT_SERIAL` exception has a declared effect of `read` AND remains serial; an
undescribed tool is serial; and the derived set agrees with the predicate and
excludes every stateful name.

## Bundle 44 — a requirement pre-flight, so a run knows what it is missing before it starts (2026-10-08)

**The finding.** A capability declared what it needed and NOTHING checked it. A
missing executable surfaced halfway through a task — after files had been written —
and the user had to work out what went wrong. Worse, the declaration could not be
checked at all: `credentials: ['NPM_TOKEN or a GitHub token']` and
`binaries: ['winget|brew|apt']` were PROSE. A phrase list can be displayed but
never probed, which is how the same string ended up encoding two different
things (a note for the reader, an alternation for a parser) with no rule for
which.

**The fix.** `CapabilityRequires` now holds `CapabilityNeed` — `{ anyOf, note? }`
— for credentials and binaries. ONE form is both displayed and probed:
`describeRequires` renders `needs NPM_TOKEN or GITHUB_TOKEN` from the same `anyOf`
the pre-flight checks, so the two cannot drift apart. `inputs` stays a plain list
of things only the model can decide, and is deliberately never probed — a bump
type is a decision, not an environment fact.

**The asymmetry is the honesty.** `learning/requirement-probe.ts` reports two
gap kinds, worded differently on purpose:

- a missing BINARY is a FACT — `which`/`where` is the same resolver the shell
  uses — so it makes `ready: false` and BLOCKS;
- a credential absent from `process.env` is NOT the same as absent. It may live in
  the credential vault, a `gh auth login` profile, an SSH agent, or an AWS profile
  file. So it is reported as "credential not visible in the environment" and NEVER
  blocks on its own.

Reporting the second as definitively missing would be exactly the false claim
this tracker exists to remove.

**Surfacing.** `tool_search` annotates every hit that declares a need with a
`check` (`ready` / `gaps` / `ask`), probed at DISCOVERY time — so the answer
arrives before the work starts, not after. A new `readiness` action is the
deliberate pre-flight: with a query it pre-flights a described task, with no query
it reports what the curated install / publish / deploy / push verbs are missing
here. A capability that declares nothing gets no empty `check` — absence is the
signal, so the model never has to interpret a meaningless one.

**The probe is injected**, so it is testable without a real PATH or env.

**Measured.** `scripts/measure-requirement-gaps.mjs`:

- readiness here: 8/9 curated verbs ready; `deploy-app` BLOCKED (none of
  `vercel`/`flyctl`/`gcloud`/`aws`/`az` on PATH), and `publish-package`,
  `publish-website`, `push-git` carry ADVISORY credential notes only;
- trace baseline: 0 of 60 turns hit a requirement wall (keyed on
  `tool-refusal.ts`'s own codes, not user phrasing).

HONEST NOTE: that baseline is zero, so this store contains NO evidence of the
problem the pre-flight fixes. Its value here is preventive, and it is NOT claimed
as a measured reduction.

**Consolidation.** Adding this needed a PATH probe, and TWO byte-identical copies
already existed — `tools/modality/shared.ts` (which documented itself as "mirrors
vault.ts binaryOnPath") and `enterprise/vault.ts`. Resolved into
`utils/binary-probe.ts` rather than tripled; both callers now delegate.

Pinned by `tests/learning/requirement-probe.test.ts` (12) and new cases in
`tests/tools/capability-registry.test.ts`.

## Bundle 43 — the MCP schema cache actually caches, so discovery survives a cold start (2026-10-08)

**The finding** (raised as Bundle 42's Open item #3). `mcp-schema-cache.ts` existed
to persist a server's tool schemas so a later process need not re-connect. Nothing
in the connection path ever called `set()`; its only readers were the
`mcp_schema_cache` tool's `get`/`invalidate`/`stats` actions. So the file was
always empty on a fresh install and the feature was inert — a cache in name only.

**The fix, both halves.**

Writes: `MCPManager.connect` persists the schemas it just discovered, keyed by the
server name and its config hash, wrapped so a cache failure can never fail a
connection. `MCPSchemaCache` gained `getAll()` (enumerate) and `prune()`.

Reads: the new `mcp/mcp-discovery.ts` merges the live connection state with the
cache, live-first. The cache is trusted only while the server is still configured
AND its config hash is unchanged — so a RECONFIGURED server's stale schemas are
pruned rather than served, and an UNINSTALLED server's are dropped. This is the
"never trust a stale copy" rule the whole truthfulness workstream is about,
applied to a disk cache.

**Why it matters.** Capability discovery can now answer "what can I do?" about an
MCP server on a COLD START — before anything has connected — which is exactly when
a user asks. Reading never connects, so a capability search still cannot spawn a
server as a side effect.

**Two isolation defects fixed in passing.** The cache directory used
`resolveNuviraHome()`, which ignores `$NUVIRA_CONFIG_DIR` — so a process pointed at
an isolated profile still read and wrote the REAL `~/.nuvira/mcp/cache`, the exact
reach the note on `resolveNuviraHome` warns about. And it was a module-level
constant, so the path was frozen at IMPORT time: anything that set the env
afterwards still got the developer's real home. It now resolves through
`resolveMcpConfigDir()` at construction.

Pinned by `tests/mcp/mcp-schema-cache.test.ts` (10), `tests/mcp/mcp-discovery.test.ts`
(7), and a real-subprocess persistence case in `tests/mcp/mcp-e2e.test.ts`.

## Bundle 42 — external MCP tools become discoverable capabilities (2026-10-08)

**The finding.** nuvira could reach MCP servers but exposed them as ONE
dispatcher: `toolsets.ts` lists a `mcp` toolset whose only member is `mcp_tool`,
so using anything on a connected server required already knowing a server name
AND a tool name. `MCPManager.getAllTools()` existed and nothing surfaced it. So
nuvira had reach it could not see — the exact opposite of a capability layer.

**The fix.** `capabilityFromMcpTool` normalizes each connected server's tool into
a `kind: 'mcp'` capability, and `capabilityIndex` ingests them, so `tool_search`
finds them by purpose. Nothing is hand-written here: the effect class is read from
the MCP spec's own `ToolAnnotations` (`readOnlyHint` → read + reversible;
`destructiveHint` → destructive + not reversible + never grantable), and the
required inputs are read from the tool's JSON Schema `required`. Reflection rather
than a phrase list, and a standard we borrowed instead of inventing.

**Silence is not safety.** A server that declares nothing becomes `external`, not
reversible, grantable only via the explicit off-machine session grant. A foreign
tool is off-machine by construction, so the honest reading of an absent annotation
is "off-machine, effect unknown". Erring the other way would let an undeclared
foreign tool run silently.

**How to reach it.** `ref` is `<server>/<tool>`, which is NOT a callable tool name,
so every hit carries `invoke: { tool: 'mcp_tool', args: { action: 'call', server, tool } }` — mirroring `mcp_tool`'s real schema. A hit never hands over a name the
model cannot call.

**Discovery never connects.** The index reads `getMCPToolManager().listTools()` —
servers ALREADY connected this process — so a capability search cannot spawn a
server as a side effect. Hermetic: a cold process simply has no MCP capabilities.

**Two boundary defects fixed.** `mcp/client.ts` mapped tools to
`{name, description, inputSchema}` and DROPPED `annotations` the SDK had returned,
so a read-only MCP tool and a destructive one were indistinguishable to every
consumer; `mcp-client-tool.ts` did not pass them on either. Both now carry them,
and absent stays absent (never defaulted at the boundary).

Pinned by `tests/tools/mcp-capability.test.ts` (11) and an annotation-preservation
case in `tests/mcp/sdk-client.test.ts`.

HONEST LIMIT: `readOnlyHint` is the spec's own description of itself as "a hint,
not a guarantee". These tests prove we READ the declaration, not that a server's
declaration is true.

## Audit — hand-maintained tables a descriptor could own (2026-10-08)

A survey of the tables that still restate a fact the capability descriptor
already carries (Bundle 41's `Capability`) or could carry. Ranked by whether the
descriptor genuinely knows the fact, not by file size.

**OWNABLE — the descriptor already holds the fact (drift risk is real):**

| Site | Table | Why the descriptor owns it |
|---|---|---|
| `tools/capability-registry.ts` | `EFFECT_BY_TOOL` | This IS the descriptor source, and it is still keyed by tool NAME in one hand map. The end state is each tool self-declaring `effectClass`/`grantCategory` at `registerTool`, so a new tool cannot be born unclassified. The DEFAULT is conservative, so nothing is unsafe — but it is the last hand table in the layer. |
| `tools/run-terminal.ts:604` | `grantCategory = recoverable ? 'terminal' : 'external'` | The category is a capability fact; the gate re-derives it from a `recoverable` boolean instead of reading the descriptor. |
| `tools/git-tool.ts:236` | `sessionGrantCovers(planStore, 'external')` | The literal `'external'` restates `git`'s `grantCategory`. |
| `tools/run-cli.ts:191` | `gatedIntent.grantCategory ?? 'terminal'` | The `?? 'terminal'` fallback is a hand default; the intent declaration (`cli-intent-effects.ts`) already carries the category. |
| `tools/coding-tools.ts:698`, `:840` | `sessionGrantCovers(planStore, 'write')` | `write_file`/`edit_file` declare `grant: 'write'`; the gate hardcodes it. |

**PARTIALLY OWNABLE — derivable from `effectClass`, with one honest caveat each:**

| Site | Table | Fit |
|---|---|---|
| `agents/tool-bridge.ts:105` | `SAFETY_GATED_TOOLS` | ≈ `effectClass` ∈ {external, destructive}. Today it is a `console.warn` only, so it is cosmetic — but it is the same fact stated by hand. |
| `tools/tool-loop.ts:3334` | `FILE_WRITE_CAPABLE_TOOLS` | ≈ `effectClass` ∈ {local-write, local-state}. `run_terminal` is in by hand; the descriptor already says `run_terminal` is `local-state`, so the derivation is exact. |
| `learning/turn-report.ts:35` | `MUTATION_TOOLS` | ≈ `effectClass` ∈ {local-write} ∪ {local-state that writes}. `run_terminal` is correctly absent (a shell command is not necessarily a mutation), so this is a *semantic* subset, not `effectClass` verbatim. |
| `learning/turn-report.ts:33` | `VERIFICATION_TOOLS` | A judgment call, not an effect: `run_terminal` both verifies and mutates. The descriptor cannot decide it; it stays. |
| `tools/tool-loop.ts:288` | `INDEPENDENT_TOOLS` | A SECOND, older fan-out list (6 names) beside Bundle 45's derived `parallelSafeToolNames()` (21). It gates the delegate *suggestion*, not the fan-out, so it never went wrong — but it is a stale duplicate of a derived set. |
| `agents/tool-bridge.ts:47/94` | `AGENT_PIPELINE_TOOLS` / `CHAT_ONLY_TOOLS` | Tool EXPOSURE, not effect. Its own comment says "ALL 111 registry tools" over a hand list — it has drifted. A descriptor `surface`/`audience` field could own it. |
| `tools/toolsets.ts:320` | `CORE_TOOL_NAMES` | Grouping/exposure. A `core` flag on the descriptor is a natural fit, but the toolset/enablement gates already own part of this. |
| `tools/computer-use-tool.ts:46/47` | `SAFE_ACTIONS` / `DESTRUCTIVE_ACTIONS` | Per-ACTION effect for ONE tool. The descriptor is per-tool, so this is sub-tool granularity the current model does not express. |
| `tools/registry.ts:483` | the `run_terminal` confirm description naming `history.clear, memory.prune, stats.cost.clear, publish` | Prose that restates `cli-intent-effects.ts` (Bundle 46). Bundle 47's `tool_search` description mentions the manifest confirmation still carried by `intent-router.ts:212/220` and read by `run-cli.ts:169`. |

**NOT OWNABLE — correctly domain/lexical, no capability meaning:** tokenizers and
stopword lists (`learning/lexical-search.ts`, `nlu/learnings.ts`, planner
`GOAL_STOPWORDS`, `learning/deferred-task.ts` accept/decline phrases); shell
parsing sets (`run-terminal.ts`); file-scan ignore dirs and source extensions;
`read-extract` formats; config ON/OFF words; provider/router tables
(`engine-router.ts`, `quota-ledger.ts`, `inference/*`) — those are MODEL
capability, a different axis, and `model-capability.ts` is their home.

**The one-line conclusion.** The capability layer centralized the facts but did
not yet let the TOOL own them, so `EFFECT_BY_TOOL` and the five grant literals are
the remaining drift surface; everything else is either a semantic subset (keep,
but derive the easy half) or a different axis (exposure, not effect).

## Open

1. Findings **#2** and **#8** — no surviving witness; recoverable only from the lost
   original.
2. ~~The forked child's loop has no verification gate: a delegated
   `write_file`/`edit_file` was never followed by a check, and the child's result
   carried no `unverifiedEdit` flag.~~ **Closed** — the child's loop now spends the
   same bounded nudge and reports the same flags (see the section above). Writing it
   also exposed a real false-success in `classifyToolRefusal` (`write_file`'s actual
   decline wording), now fixed.
2. ~~`subagent` on a non-tool-calling provider (`local`/Ollama) refuses when asked
   for tools.~~ **Closed** by the JSON fallback above: the subagent now offers the
   tools in the prompt and parses the `{"tool":…}` reply, so a local-only setup can
   spawn a subagent *with* tools. The run's `transport` says which path it took, so
   the fallback is visible rather than silent.
3. ~~The MCP schema cache is never written.~~ **Closed** — `MCPManager.connect`
   now persists the schemas it discovered, `MCPSchemaCache` gained `getAll()` and
   `prune()`, and `mcp/mcp-discovery.ts` reads live-first-then-cache with a config
   hash check, so MCP discovery survives a cold start. Two isolation defects in
   the cache directory were fixed at the same time. See Bundle 43.
