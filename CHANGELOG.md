# Changelog

All notable changes to **Agent-Nuvira** are documented in this file.

## v1.66.0 — Live chat progress streaming + gateway ops in the GUI

- **⚡ Live working steps in the Chat tab.** The agent's tool calls and
  reasoning markers now stream into the GUI in real time while a turn runs
  (previously a static "thinking…" bubble). The tool loop's `onEvent` stream
  is wired into `ChatCommand.answerOnce` via an `onProgress` hook, the chat
  console emits per-session progress/status events, and a new SSE endpoint
  `GET /api/chat/:sessionId/events` delivers them to the page (subscribed
  BEFORE each turn so no step is missed). Completed answers keep a
  collapsible step summary.
- **🌐 Gateway ops tab.** Gateway status, delivery ledger, foreground start
  (with live event stream + Cancel), and cron management now run the real
  `buff gateway` / `buff admin cron` CLI from the GUI via a shared
  `TaskConsole` component (preset buttons + custom command line, live SSE
  console, cancel, timeout) — extracted from the Evals tab so both surfaces
  reuse one console.

## v1.65.0 — Dashboard chat console + eval runner in the GUI

- **💬 Chat tab — chat with the agent from the GUI.** Each message runs ONE
  tool-loop turn through the real agent engine in the dashboard process
  (`ChatCommand.answerOnce` — the exact engine behind `buff chat "<prompt>"`),
  with the conversation threaded server-side per session so the GUI holds a
  real back-and-forth. The model's suggested follow-ups render as clickable
  chips that send their prompt as the next message. API: `POST /api/chat`
  (`{ sessionId?, message, provider?, model? }`) + `POST /api/chat/reset`,
  admin/operator-gated. Non-TTY by construction: an injected `ask_user`
  renderer declines clarifications instead of hanging on piped stdin.
  Verified end-to-end against a real provider (content + followups returned).
- **🏆 Evals tab — run `buff eval` from the GUI.** Preset buttons
  (quick / medium / slow / M2B parity / full) plus a custom task filter, each
  running the REAL `buff eval run` as an isolated process via the task runner
  with a live SSE console and cancel; the results table auto-refreshes from
  evals.json (tasks passed, completion, composite score, cost) as runs land.
- 19 new tests (chat console unit + API, Chat page, Evals page); suite at
  4,345 root + 178 dashboard, typecheck clean.

## v1.64.0 — Dashboard command console (P1) + in-page WhatsApp pairing (P2)

- **Dashboard Tasks tab — every CLI command runnable from the GUI (P1).** The
  dashboard executes the REAL CLI (`node dist/index.js <args>`) as an isolated
  child process, so command parity is guaranteed by construction. Run any
  command (`eval run --task smoke`, `gateway status`, `skill list`, …) from a
  `🚀 Tasks` tab with a live log console (SSE), cancel (SIGTERM), timeout
  (SIGTERM→SIGKILL), and history (last 50, click to reopen). API:
  `POST/GET /api/tasks`, `GET /api/tasks/:id`, `POST …/cancel`, `GET …/events`
  — all admin/operator-gated. Verified end-to-end: the real CLI `--help` ran
  through the API (`status: done, exit: 0`, logs streamed back).
- **In-page WhatsApp pairing — QR + 8-char code live in the browser (P2).**
  The Agent Hub → Channels tab now pairs the Baileys bridge without touching a
  terminal: the QR renders as a scannable PNG `<img>` (auto-refreshing as
  WhatsApp rotates it), the `--phone` 8-char code mode streams the code the
  same way, and pair/cancel/unpair are admin/operator-gated
  (`GET/POST /api/whatsapp`, `…/pair`, `…/cancel`, `…/unpair`, `…/events` SSE).
  The bridge gained an AbortSignal path (dashboard cancel ends the socket) and
  a PNG data-URL renderer alongside the terminal QR.
- **Messaging hot-path tests + one real bug fixed.** Telegram long-poll
  (send/inbound/offset), Discord & Slack Bot-token REST sends, and WhatsApp
  Cloud send + inbound `X-Hub-Signature-256` verification (good/tampered/
  challenge) are now covered. The audit surfaced a genuine bug:
  `TelegramAdapter.send()` threw on network errors instead of returning
  `false` like every other adapter — fixed.
- **Project plan** `PROJECT_DASHBOARD_CLI_PARITY.md` tracks P3/P4 (chat
  console, eval runner, skills/marketplace/team/federation surfaces, RBAC
  audit). Suite: 4,331 root tests + 167 dashboard tests, typecheck clean.

## v1.63.1 — Fix: WhatsApp pairing renders a scannable QR again

- **`buff whatsapp pair` prints a real scannable QR.** Baileys 7.0.0-rc14
  removed `qrcode-terminal` and deprecated `printQRInTerminal` (now a silent
  no-op) — pairing previously showed only the raw payload string, so there was
  nothing to scan. The QR is now rendered in the terminal (via `qrcode`) with
  step-by-step instructions; the raw payload moved to `--debug`.
- **New `buff whatsapp pair --phone <number>` — pair with an 8-char code.**
  Uses Baileys `requestPairingCode`: enter the code under WhatsApp → Linked
  devices → Link with phone number instead. Ideal for headless/remote hosts
  where scanning is impossible. Warns when a 10-digit number looks like it's
  missing its country code (e.g. use `918800663237`, not `8800663237`).
- 3 new tests; suite at 4,283 passing.

## v1.63.0 — Hermes messaging campaign: 22-platform multi-channel gateway

- **Multi-channel gateway — 22 platforms (Hermes `gateway/` parity).** The
  `buff gateway` surface now covers the full Hermes messaging ecosystem: the
  original J1 platforms (Telegram long-poll, Discord/Slack webhooks, WhatsApp
  Cloud API) plus **18 connectors with Hermes env-var parity** — DingTalk,
  Feishu, WeCom, Mattermost, Matrix, generic Webhook, BlueBubbles (iMessage
  bridge, macOS), ntfy, Microsoft Teams, Google Chat, Weixin (WeChat iLink bot
  API), SMS (Twilio REST), IRC (RFC 1459 over node:net/tls, byte-aware ≤510-byte
  message splitting + markdown strip), SimpleX (local daemon WebSocket), and
  Home Assistant (REST notifications). Every adapter is opt-in via the SAME env
  vars Hermes uses (`TWILIO_*`, `IRC_*`, `SIMPLEX_*`, `HASS_*`, `BUFF_*`) —
  existing Hermes credentials work in agent-nuvira unchanged. Pure Node built-ins
  throughout (fetch, node:net/tls, global WebSocket) — zero new SDK deps.
- **WhatsApp personal bridge (Baileys).** `buff whatsapp pair` (QR) pairs your
  own WhatsApp number — no paid API. Two-way: the gateway relays inbound
  messages to the agent and replies back. `whatsapp_cloud` (Meta Cloud API)
  remains the paid opt-in.
- **Guaranteed delivery ledger.** Failed sends are persisted and retried
  automatically while `buff gateway start` runs; `buff gateway delivery` shows
  the queue and `--flush` forces a drain.
- **SimpleX is two-way.** Persistent inbound WS listener — contact-request
  auto-accept (`SIMPLEX_AUTO_ACCEPT`), echo filtering, contact/group
  allowlists (`SIMPLEX_ALLOWED_USERS` / `SIMPLEX_GROUP_ALLOWED`), reconnect
  with backoff — the agent listens AND replies on SimpleX.
- **IRC is two-way too (the heavy protocol).** `IrcAdapter.start()` now runs a
  persistent RFC 1459 listener socket — registration (PASS → NICK → USER →
  001), NickServ IDENTIFY + JOIN, PING/PONG keepalives, 433 nick-collision
  retry, and PRIVMSG relay with Hermes' exact semantics: self-echo filter,
  CTCP ACTION → `* nick text` (other CTCP dropped), channel messages only
  when addressed (`nick:`/`nick,`/`nick `), `IRC_ALLOWED_USERS`
  case-insensitive allowlist, reconnect with backoff. Send prefers the live
  listener socket (one IRC identity, 0.3s flood guard) with connect-per-send
  fallback. Wire-level walkthrough in `IRC_PROTOCOL_DEEP_DIVE.md`.
- **Dashboard channel send-test.** The Agent Hub Channels tab can send a test
  message through the same gateway the CLI uses (`POST
  /api/admin/hub/channels/send`, admin + `routing.operate` gate), with a 15s
  send bound and env-var hints per platform. `buff gateway status` now shows a
  `X/22 platforms configured` count line.
- **Security hardening across connectors.** CRLF injection rejected pre-connect
  (IRC, SimpleX), socket errors after send are failures (never silent loss),
  Twilio/HA/Hermes credentials never logged (`describe()` shows only the
  non-secret parts).
- **Tests.** Full connector suites use in-process mock servers (SMTP, IRC,
  fake WebSocket, fetch spies) — no network. Full suite: **4,280 tests across
  180 files** (was 4,031).
- **Docs.** `HERMES_ECOSYSTEM_INTEGRATION_PLAN.md` (I1–I16 pillars + deferred
  heavy-bridge assessment), `HERMES_IMPORT_DESIGN.md`, `ASSESSMENT_WEBSITE_DEPLOY.md`;
  User Manual gateway section updated; website updated to v1.63.0 / 4,280 tests.

## v1.62.5 — Reviewer rate-limit recovery: eval 429s are waited out, not fatal

- **Root cause fixed (eval interference).** The reviewer's retry loop used a
  fixed 1s/2s backoff and never invoked `context.onRateLimit` — so a transient
  429 with an 18s reset hint (e.g. Groq TPM) fired all 3 attempts inside the
  reset window and the review died, killing the task. Observed: 6/9 eval tasks
  failed with "Provider interference" and the reviewer errored on an 18.165s
  reset. The reviewer now mirrors the writer/context-gatherer: long reset
  hints (>= 3s) delegate to the orchestrator's `onRateLimit` handler (decision
  #26 — silent wait for transient, silent auto-switch for exhaustion/storms,
  dashboard failover events), short hints use the hint-aware delay, and
  switch-model/skip/abort are honored. The pipeline now waits out transient
  quota blips instead of failing on them.
- **Shared retry helpers.** New `src/agents/rate-limit-retry.ts`
  (`isRateLimitError`, `calculateRetryDelay`, `parseModelName`,
  `parseRetryAfterHint`, base/threshold constants) — writer and
  context-gatherer were refactored onto it, removing their duplicated local
  copies (single source of truth, no drift).
- **Tests.** 3 new reviewer tests (wait-then-retry with fake timers verifying
  the full 18.2s hint is honored, switch-model uses the handler's LLM, abort
  path) — 168/168 files pass. Live smoke eval on groq: 100% completion, 100%
  test pass, 0 provider interference.
- **Decision #29** — "Transient quota blips must never fail a task" — full
  analysis of the eval 429 failure and the fix.

## v1.62.4 — Deliverable match check + domain reference docs + NVDA eval task

- **Deliverable match check (fixes the wrong-file success bug).** `TaskStep` gains
  `expectedFiles`; the planner now declares the exact files each writer step must
  produce, and the orchestrator **fails a writer step that claims success without
  producing its declared files** (checked before the result is recorded, so a step
  that wrote `globalPlugins/hello_anuj.py` while reporting "Create manifest.ini"
  can no longer mark itself ✅ — the exact false-success from the live NVDA run).
- **Domain reference-docs injection (fixes hallucinated APIs).** New
  `src/agents/reference-docs.ts` injects curated, verified API snippets into the
  writer prompt when the task targets a known domain — NVDA addons first
  (`globalPluginHandler` / `scriptHandler` / `addonHandler` / `ui.message`,
  `kb:NVDA+alt+1`), keyword-matched so ordinary tasks are untouched. The live run's
  `nvda.register_key_handler` hallucination is now blocked at prompt level.
- **NVDA addon eval task (`py-nvda-addon`).** New eval-framework task whose hidden
  test checks the real addon contract (manifest + `globalPlugins/*.py` with the
  NVDA+alt+1 script) and whose `referencePatterns` reject the hallucinated API
  surface — so this failure class is now caught in the eval suite, not just on a
  user's machine.
- **Decision #28** — "Where the pipeline loses to interactive execution" — a full
  comparison of agent-nuvira's stage-by-stage pipeline vs. tool-driven interactive
  execution, with seven concrete efficiency wins (parallel step fan-out, tool-based
  context gathering, structured writer output, latency-based provider failover,
  toolchain pre-flight for the runner, deterministic-first review, reference docs).

## v1.62.2 — Fix: rate-limit recovery is fully automatic (no more prompts, no more grinding)

- **Automatic recovery by default:** the orchestrator's rate-limit handler no longer
  interrupts the user. Transient hits (short reset hints, e.g. "try again in 16.5s") are
  silently waited out and retried; exhaustion (long hints, e.g. "resets in 17h 51m" —
  daily-quota caps) and storms (2+ consecutive hits in one task) silently auto-switch to
  the router's next healthy provider mid-task. The pipeline keeps building on whichever
  provider is healthy — the exact failure the user hit (gemini 503 → writer retried gemini
  3× and died, never failing over to the available groq) can no longer surface as an error.
- **Interactive prompt is now opt-in** (`routing.askOnRateLimit: true` in .buffconfig.json)
  and only ever appears on a real TTY. Non-interactive runs (CI, pipes) get the same
  silent auto-switch + auto-wait instead of grinding the same exhausted provider.
- **Threshold:** a reset hint over 60s counts as exhausted (provider is down for a while →
  switch); under 60s is transient (waiting is cheaper than switching).
- **Honest "consecutive" storm semantics:** the streak counter resets after each successful
  auto-switch (the new provider starts fresh — one transient hit after 10 successes is NOT
  a storm) and strikes more than 5 minutes apart are treated as a fresh incident, not a
  continuation (a long healthy run between them means the provider recovered).
- **Auto-mode bound-provider seed:** the storm guard never "switches" to the provider the
  agent is already on — in auto mode the task's routed provider is seeded into the
  tried-providers set, so a fresh decision that re-picks the just-rate-limited provider
  (registry park lag) is skipped in favor of the next healthy ranked provider.
- **No ping-pong / no model leak:** per-task `triedProviders` set prevents bouncing between
  two exhausted providers; the auto-switch target resolves its own best verified model
  (`model: 'default'` no-pin sentinel) so a gemini model ID can never be sent to groq.
- **Tests:** orchestrator suite updated for the silent default + new paths (first-hit
  exhausted auto-switch, non-TTY silent retry, opt-in prompt, counter reset, time-window,
  auto-mode bound-provider seed) — 168/168 files pass.

## v1.62.3 — Dashboard Failover Timeline shows auto-switches + decision #27

- **Auto-switches are now visible on the dashboard.** Every rate-limit auto-switch the
  orchestrator makes (storm or exhaustion) writes a `failover` event to the quota
  timeline (`quota-events.jsonl`) with the reason ("rate-limited 2x" / "exhausted"), so
  the dashboard's 🛟 **Failover Timeline** card shows mid-task provider swaps live — same
  store the CLI `model quota` last-20 and the audit chain read. Verified in the live
  NVDA-addon run: the "auto-switched to local" / "auto-switched to groq" events now land
  in the timeline instead of only the event bus.
- **Decision #27** — `routing.askOnRateLimit: true` documented as the explicit opt-in
  for the legacy interactive rate-limit prompt (TTY only), with the revised-auto
  rationale (default = fully automatic; opt-in for operators who want to intervene).
- **Tests:** new orchestrator regression — an auto-switch records `failover` on the
  quota ledger (82/82 orchestrator, 168/168 files).

## v1.62.1 — Fix: rate-limit no longer permanently kills cloud models

- **Registry (model-registry.ts):** a `rate-limit` failure now PARKS an entry without
  demoting it to `unavailable` (auth still demotes). Previously a 429 flipped `verified →
  unavailable`, and since `isUsable()` requires `verified`, rate-limited cloud models never
  auto-recovered — the router silently forced every agent onto the weak local model after
  one quota burst (the "chat fast, execute slow+wrong" symptom). Verified models now return
  automatically when the park window lapses.
- **Recovery path:** `markVerified` clears registry parks on real success; `syncQuota` only
  re-applies live ledger parks. Manual escape hatch unchanged: `buff models unblock <provider>`
  (release + re-probe) and `buff models refresh <provider>`.
- **Tests:** updated 8 files encoding the old demotion semantics; added a regression test
  proving a verified model is parked but auto-recovers after the window.
- **Docs:** decision #23 in DESIGN_DECISIONS.md (park, never demote).
- **Fix 2 — park for the provider's ACTUAL reset time:** a 429 that says "try again in
  16.5s" / `Retry-After: N` / `x-ratelimit-reset-*` now parks for ~that long (floored 10s,
  capped by the configured `routing.quota.<provider>.windowMs`) instead of the 24h default —
  so a per-minute/token-window quota burst re-admits the provider the moment it lifts, with
  zero manual intervention. New shared `parseRetryAfterHint`/`extractRetryAfterMs` in
  `provider-fallback.ts` (replaces 3 duplicated copies in writer/context-gatherer/edit-module).
- **Fix 3 — rate-limit STORM auto-switch (the "gemini 503 → writer died" failure):** when
  an agent hits 2+ consecutive rate limits within one task, the orchestrator now stops
  prompting and AUTO-SWITCHES to the router's next healthy provider mid-task (fresh
  auto-routing decision; pinned mode excludes the bound provider; auto mode trusts the
  fresh winner, which the hint-aware park already moved off the rate-limited provider).
  The switch uses `model: 'default'` so the new provider resolves its own best VERIFIED
  model — never leaking the rate-limited provider's model ID (a gemini ID on groq = 404).
  Falls back to the interactive prompt only when no healthy alternative exists. A per-task
  `triedProviders` set prevents ping-ponging between two exhausted providers (their short
  hint-aware parks can lapse mid-task).
  Both the quota-ledger park and the registry floor honor the hint.
- **Fix 3 — cross-provider failover for agent LLM calls ("why didn't it take another
  model?"):** the orchestrator's auto-routed LLM now walks the router's next-ranked
  candidates on a retryable failure (503 high-demand / 429 / network) instead of
  exhausting the repair budget on one provider. Auth never fails over; a user-pinned
  provider is honored as-is. A live agent-update event shows "⚠️ gemini server — failing
  over to groq" on the board. Each failed provider×model still records exactly once via
  the shared telemetry path.
- **Fix 4 — adapter errors now carry their HTTP context:** new `attachHttpContext`
  attaches status + headers (Retry-After, x-ratelimit-reset-*) to errors from ALL
  adapters (groq, gemini, anthropic, nim, ollama, openai-compat, tools), so even a
  body-less 429 parks for the provider's actual reset time.
- **Fix 5 — Gemini model IDs:** the pinned `gemini-2.0-flash-exp` (retired for new
  accounts) is replaced with `gemini-flash-latest` (verified live); catalog updated to
  2026 model IDs. Config also set `routing.quota.{groq,gemini}.windowMs = 4h` so a
  hint-less 429 parks 4h max instead of 24h.

## v1.62.0 — Revamp complete — reliability stack, code-map, scheduled jobs, gateway

- **Major revamp complete** — all 30 rows of the Freebuff/Hermes parity program are landed (AGENT_NUVIRA_MAJOR_REVAMP_PLAN)
- **Reliability stack** — writer surfaces unparseable output instead of masking it (repair escalates the model), reviewer-blocked verdicts route through a writer fix pass, weak-local-model pre-flight warning before long runs
- **New `buff code-map`** — project symbol map (functions/classes/methods) via the AST engine; closes the last revamp row; AST dedupe fix recovered silently-dropped top-level functions
- **Scheduled jobs** — `buff admin cron add/list/remove/run` with schema-validated args, RBAC-gated writes, channel delivery
- **Multi-channel gateway** — Telegram / Discord / Slack / WhatsApp via `buff gateway`
- **Web tools + modality packs** — `web_search`/`read_page` (SSRF-guarded) plus browser / image / voice / vision tools
- **Structured logging (K1) + runtime metrics (K2)** — JSON logs with correlation IDs; `buff doctor --enterprise` runtime metrics
- **Session recall** — chat auto-recalls per-project sessions and facts
- **4,031 tests passing across 167 files**

### Session 47 — post-revamp followups + last revamp row
- feat: NEW buff code-map [dir] [--json] — project symbol map (functions/classes/methods with 1-based lines) via the AST engine; closes revamp row 11 (engine-agnostic; web-tree-sitter remains the upgrade follow-up)
- fix: editing/ast.ts — duplicate pattern matches for the same declaration (explicit "function name(" + generic "name(") produced equal-end nodes that the nesting filter dropped BOTH of; top-level functions silently vanished from the structure map (pre-existing bug that also affected the edit pipeline). Same-end nodes are now excluded from nesting + deduped, and JS/TS function patterns accept an export prefix.
- fix: writer buildPrompt now surfaces a ## Goal section when context.goal differs from the step description — repair/fix-pass/alternative-approach context in the goal previously never reached the LLM (caught by the new E2E)
- fix: edit-module empty-parse parity — a genuine "no changes needed" decline is a clean no-op; a format failure keeps the parseable warning
- test: NEW tests/integration/reliability-fixes.test.ts — real Orchestrator + scripted fake LLM E2E (writer parse-failure repair recovery, loud failure, reviewer-blocked fix pass); NEW tests/cli/code-map.test.ts (3)
### Session 46 — NVDA-run reliability fixes (post-revamp)
- fix: writer no longer masks unparseable LLM output as "No files needed changes" — a genuine "no changes needed" decline stays a no-op, but a format failure (no filepath: code blocks) now FAILS the task so the repair engine escalates the model instead of silently skipping the real work (was: masked success → incomplete deliverable → reviewer loop)
- fix: reviewer "blocked" verdicts now route through a WRITER fix pass (writer applies the reviewer feedback, then the reviewer re-verifies) instead of re-running the reviewer on unchanged code until the repair budget dies
- feat: weak-local-model pre-flight warning — when auto-routing lands on a LOCAL model scoring < 0.5 (no verified cloud provider available), warn before the pipeline burns minutes on a model likely to fail complex tasks
- test: writer parse-failure surfacing (4) · orchestrator reviewer fix-pass (2) · weak-model gate (2) · updated writer-prompt suite to the new contract

### Session 45b — K1 structured logging + K2 runtime metrics (last revamp rows)
- **Structured logging (K1)** — `BUFF_LOG_JSON=1` now emits one machine-readable JSON object per log line (level/time/msg + correlation IDs), with secrets redacted BEFORE serialization. Every chat session carries ONE `sessionId`; every pipeline run carries a `runId`; every agent execution carries a `taskId` — so `buff chat` → pipeline → agent logs are correlateable end-to-end, without any parameter plumbing (AsyncLocalStorage carrier in `src/enterprise/log.ts`).
- **Runtime metrics (K2)** — dependency-free counters + latency timers persisted to `~/.buff/memory/metrics.json`: memory hits/misses, and the C1 rule-vs-LLM latency budget (`rule.parse.ms` / `rule.dispatch.ms` / `llm.answer.ms`). `buff doctor --enterprise` now surfaces a **Runtime Metrics (K2)** check. These are the last two rows of the major revamp — **all 30 rows are now Done/Baseline/skipped-by-design**.

### Session 45 — Honest stuck-scoring + plan sweep + key hygiene
- **Stuck states now exclude provider interference** — a task whose terminal failure is rate-limit / server / network (e.g. a free-tier 429 that opened the circuit breaker) is reported on a separate `Provider interference` line instead of inflating the user-visible stuck count. The S44 run re-analyzes from **5 stuck → 0 stuck, 6 interference** (all 429s, attempts=1 — the pipeline never got a chance to work). Persisted runs saved earlier re-analyze correctly, and auth/timeout failures remain genuinely stuck. `buff eval run` / `results --compare` both use the corrected counts.
- **Full-plan sweep** — the revamp plan is complete except two rows now actionable (K1 structured logging, K2 latency metrics); M3 (zod) confirmed landed inside the H1 registry.
- **Key hygiene** — `~/.buff/.env` carries real GROQ/GEMINI keys but placeholder `new-key` / `openrouter-env-key` values for NIM and OpenRouter. Replace those two lines with real keys (`NVIDIA_NIM_API_KEY=...`, `OPENROUTER_API_KEY=...`) to unlock both providers; `buff doctor` and `buff models refresh` then pick them up. Note: the configured `gemini-2.0-flash-exp` model and catalog `gemini-2.5-flash` both return 404 on this account — switch to a model `buff models list` shows as served, or use the auto router.

### Session 44 — M2b experience-parity re-run (final revamp item)
- **Post-revamp benchmark run** — `buff eval run --suite m2b --provider groq --budget 0.05` (9 tasks, $0.008, 110.7s). The instrumented `buff eval results --compare` gate shows a **win on every experience axis vs the immediately-prior run**: composite 47.2% vs 26.9%, test-pass 44% (4/9) vs 11% (1/9), completion 22% vs 0%, stuck 5 vs 8, rework 32 vs 36.
- **Honest caveats** — the composite sits below the Session 31 peak (72.2%) within the documented ±17pt free-tier Groq noise floor, and this run hit 2 circuit-breaker cooldowns (120s each) — a post-baseline failure mode that scores recoverable rate-limit pauses as "stuck". The revamp did not regress; absolute movement past noise requires a stable provider run.

### Session 43 — I2–I5 modality packs (browser / image / voice / vision)
- **New `src/tools/modality/` family** — four capability packs, every backend OPTIONAL and availability-gated (Hermes registry pattern): `browser` (Playwright optional via `require.resolve`, SSRF guard reusing web-research's `isAllowedReadUrl`), `generate_image` (Pollinations.ai free endpoint default, local SD/ComfyUI via `BUFF_IMAGE_API_URL`), `speak`/`transcribe` (edge-tts + Piper stdin fallback; whisper.cpp/whisper-cli with transcript file read-back), `describe_image` (Ollama llava/llama3.2-vision or Gemini via the existing model router). All four registered in the H1 tool registry with availability-gated `run()` — a missing backend returns a clear "install … then retry" message, never throws. Artifacts land in `<cwd>/.buff/artifacts/<kind>` (`BUFF_ARTIFACTS_DIR` overrides).
- **Code-search race fix** — the ripgrep engine could parse pipe-buffered matches after truncating (async `kill()`), making `maxResults` flaky; the stdout handler now bails once truncated/timed-out.
- **Validation**: tsc clean · full suite 163/163 files (+modality tests) · build OK · `buff tools list` shows the new tools.

### Session 42 — J1 Multi-channel gateway
- **`buff gateway start / send / status / alias`** — talk to the agent from Telegram, Discord, Slack, or WhatsApp (Hermes `gateway/` parity). Dependency-free adapters (pure fetch — deliberately no grammY/discord.js/@slack/web-api SDKs): Telegram long-poll `getUpdates`, Discord/Slack incoming-webhook send, WhatsApp Meta Cloud API; all opt-in via env bot tokens.
- **`GatewayRegistry`** — inbound message → `parseRequestSync` (C3) → the SAME shared `runPipelineTool` core as `buff chat`/`execute` → reply to the originating channel; every ORCHESTRATOR/EXEC/CRON board event streams as a compact channel status line. Pipeline runs serialize so events route to the right channel.
- **Channel directory + aliases** — Hermes `channel_directory.py` pattern: `buff gateway alias add ops slack C0123`, persisted to `~/.buff/gateway/aliases.json`, `platform:channelId` targets supported.
- **Security**: webhook receiver binds 127.0.0.1 by default (`--host 0.0.0.0` for a tunnel); Slack `X-Slack-Signature` (HMAC v0) + WhatsApp `X-Hub-Signature-256` verified when secrets configured; **pipeline triggers gated by `BUFF_GATEWAY_ALLOW_IDS`** (platform:channelId allow-list); alias writes RBAC-gated on `gateway.manage`.
- **Cron delivery**: `buff admin cron add … --channel <alias>` → job results forwarded to the channel after each run (best-effort — never fails the run).
- **Validation**: tsc clean · full suite 162/162 files (+19 tests) · build OK · live smoke.

### Session 41 — M1 Integration tests + M4 CI matrix
- **`tests/integration/` (M1)** — the three foundation systems pass as ONE hermetic unit: one temp `BUFF_CONFIG_DIR` + `BUFF_MEMORY_DIR` harness drives the REAL Vault (aes-file set→get round-trip surviving fresh instances), WorkspaceStore (recordRun → reload), and FactStore (addFact → reload) — plus a "secret never on disk in plaintext" check. A second file runs a REAL `Orchestrator.execute()` against a nonexistent local model (fast-fail, zero network) and proves the best-effort workspace `recordRun` fires even when the pipeline FAILS (❌ row) and that a second run upserts the same project row.
- **CI matrix (M4)** — `test-linux.yml` extended in place (no new pipeline file): Node 22/24/26 × ubuntu/macos + a new `bun` job (committed `bun.lock`, `bunx tsc --noEmit`, `bun run build`, `bunx vitest run`).
- **Validation**: tsc clean · full suite 160/160 files (+2 integration files) · build OK · integration suite passes under both Node and Bun.

### Session 40 — J2 Scheduled jobs (cron)
- **`buff admin cron add / list / remove / run`** — scheduled tool invocations (Hermes `cron/jobs.py` parity): 5-field node-cron validation, `--dry-run` (validate + next run WITHOUT executing), persisted jobs in `~/.buff/cron/jobs.json`, `run <name>` invokes the H1 registry tool now (fresh ConfigManager — pipeline tools need one) and emits `cron:run/result/error` events for the future gateway/dashboard.
- **Safety**: job names sandboxed (`^[a-z0-9][a-z0-9-]{0,49}$`), **`--args` validated against the tool's zod schema at add time** (a typo surfaces immediately, not at 3am), all writes RBAC-gated on the new `cron.manage` action (admin + operator).
- **Validation**: tsc clean · full suite 158/158 files (+11 tests) · isolated-HOME live smoke.

### Session 39 — J3 Skills hub + sync (capability gap #10)
- **`buff skills search / install / update / list`** — community skills discovered from a configurable registry (default GitHub raw; `BUFF_SKILLS_REGISTRY` can point at a local dir for offline use) and installed into `<project>/.agents/skills/` — Hermes `skills_hub.py` + Freebuff `npx skills add` parity. Distinct from `buff skill` (singular), which manages internal trajectory-compiled skills.
- **Trust + safety**: sandboxed install names (`^[a-z0-9-]+$`), frontmatter `name:` cross-checked against the registry entry, SHA-256 provenance recorded in `~/.buff/skills-hub/provenance.json`, mismatched reinstall content quarantined; `buff skills update` is version-gated (never downgrades, never clobbers local edits) and RBAC-gated on `skill.remove` like `skill gc`/`clear`.
- **Validation**: tsc clean · full suite 157/157 files (+19 tests) · local-dir registry tests, no network.

### Session 38 — I1 Web research tools (capability gap #3)
- **`web_search` / `read_page` tools** — the model can now search the web (DuckDuckGo free tier by default, SearXNG opt-in) and read a page's text (Jina Reader free tier or a plain fetch) to ground its answers — Freebuff `researcher-web.ts` / Hermes `web_search_registry.py` parity. Registered in the H1 tool registry + the safe MCP surface; `buff tools list` shows them under 🧰 Workflow.
- **SSRF guard** — `read_page` only fetches public http(s): loopback/link-local/private/metadata hosts blocked unless `BUFF_WEB_ALLOW_PRIVATE=1`; DDG redirect URLs decoded to real targets.
- **Validation**: tsc clean · full suite 156/156 files (+17 tests) · mocked-fetch tests, no network.

### Session 37 — Eval `--pace` (Decision 21's gate fix)
- **`buff eval run --pace`** stops the suite BEFORE a task would cross the user-declared daily token budget (`routing.quota.<provider>.tokensPerWindow`), so free-tier TPD exhaustion can't invalidate an M2b measurement mid-run. Resolves the budget from the config + today's quota-ledger consumption (`resolvePaceBudget`); warns when `--pace` is set but no budget is declared; works in both direct-provider and `--routing` modes alongside the existing `--budget` (USD) gate.
- **`EvalMetrics.totalTokens`** — per-task input+output token total powers the cumulative pacing check.
- **Validation**: full suite **3,908/3,908** (+6 tests) · tsc clean · live smoke (500-token cap, 84K used → stopped before task 1).

### K4 — RBAC enforcement (Session 34)
- **Enforcement everywhere**: the RBAC engine previously only gated `buff admin`. K4 adds `credential.write`/`team.manage`/`sbom.write`/`skill.remove` to the action matrix and wires a shared `guardRbacAction()` helper into every sensitive surface: `buff team` mutations (init/join/sync/share + all review actions), `buff skill gc` real removal + `buff skill clear` (dry-run stays open), `buff sbom --out`, and `buff config vault migrate`. Denied → clear message + exit code 3; legacy single-user mode remains fully permissive.
- **Single enforcement path**: `buff admin`'s private guard now delegates to the shared helper.
- **New**: `src/cli/rbac-guard.ts` + `tests/cli/rbac-guard.test.ts` (13 tests).

### M2b gate re-run + noise-floor verdict (Session 35)
- **Gate ran, verdict: measurement-integrity.** Post-K3/K4 re-run scored 26.9% composite vs the 72.2% baseline — but with **12 tokens-per-DAY 429s and 0 TPM events**: free-tier Groq's daily budget was exhausted mid-run (cost $0.0018, 8/9 tasks starved of any model response). NOT a regression — the gate's anti-coverup job.
- **Noise floor widened to ~±45pt** (72.2% / 55.0% / 26.9% across identical setups) — TPD exhaustion dominates. The Part 1.9 gate must run on a paid tier or with per-task pacing; documented in the benchmark INDEX + plan.
- **RBAC user docs**: Product_Guide v1.61.1 row + User_Manual section (enforcement everywhere, vault audit, eval compare). Dashboard parity confirmed automatic (same `roleCan` matrix).

### User-declared daily token budget (Session 36, Design Decision 21)
- **Your plan, your say** — free-tier TPD caps are invisible to us, so the USER declares their budget: `buff model quota set <provider> --tokens N --requests N --window-ms N --cost-usd N` (CLI) + a dashboard **💰 Daily Budget** panel (Admin) editing the SAME `routing.quota.*` + `governance.maxCostUsd` config. Advisory + pacing, never a product hard cap: unset = current behavior, set = the quota ledger parks the provider at the cap and auto-resumes at window rollover.
- **Backend enforcement is real** — `getRouterQuotaStatus()` derives configured-limit exhaustion and feeds the auto-router before every pick; rate-limited providers park for the declared window.
- **Fixed a latent merge bug** — ConfigManager.save shallow-merges `routing`; quota setters (CLI + `config set routing.quota.*`) now save the full merged map so sibling providers' limits are never wiped.
- **RBAC-aware** — budget fields gate `routing.operate` (admin+operator), the cost cap gates `policy.write` (admin); viewer read-only. 3,899 tests.
- **Update as and when** — `ConfigManager` live-re-reads on file change: a running chat/execute/dashboard honors a limit change from `buff model quota set` or the Daily Budget panel immediately, no restart (verified on a live instance). `save()` refreshes before merging so concurrent CLI ↔ dashboard edits never clobber each other; a partial concurrent write keeps the last good config. 3,902 tests.

### G1–G3 — Observability, dashboard & docs surfacing
- **`buff session`** (new): `list` (project + temporal filter via `--since`), `summarize <id>`, `resume` — the explicit debug surface over D1 auto-recall (a bare `continue` remains the primary path).
- **`buff doctor`** now reports a **Fact Memory** section (facts per project, B1) alongside the existing vault / workspace checks.
- **Privacy (P6 M6.2):** chat session writes (`history.json` + the semantic vector index) are now **redacted** — API keys / Bearer tokens / key=value secrets are masked before persisting; the caller's message array is never mutated.
- **Dashboard memory panel:** Facts, recall hits (total / today / this week, per project), and the backend tier are now surfaced; recall hits come from a deduped JSONL counter at the shared auto-recall choke point.

### H1 follow-up — Agent-Nuvira as an MCP server
- **`buff mcp serve`** exposes the agent's H1 tools as an MCP **server** over stdio (Claude Desktop / IDEs / other agents can connect). Safe surface by explicit allowlist: pipeline tools (`build` / `resume` / `repair` / `document` / `website` / `analyze` / `test`) + `code_search`; loop-internal / LLM-dependent / irreversible tools (`ask_user`, `suggest_followups`, `verify_requirement`, `delegate`, `publish`) are **excluded by default** — opt in explicitly with `--with <tools>`. Runs are headless (`board: false`), errors map to MCP `isError` results, and pre-connect output routes to stderr so the protocol owns stdout cleanly.

### M2b — Experience-parity baseline + stuck/rework breakdown
- **First real M2b baseline** (`buff eval run --suite m2b`, auto-routed to `groq/llama-3.3-70b-versatile`): 9/9 tasks in 142s for **$0.02** — composite **72.2%**, test-pass **78% (7/9)**, avg time-to-fix **9.9s**, 0 rollbacks. Report: `docs/benchmarks/m2b-groq-llama-3.3-70b-versatile.md`.
- **Stuck / rework breakdown** — the benchmark spec promised these axes; now actually measured and rendered: `computeReworkTurns()` (repairs + alternative approaches + rollbacks — NOT llmCalls, which the multi-agent pipeline makes ~4-5 of by design) and `computeStuckStates()` (crash/timeout, or 3+ rework turns, with **no working outcome**) drive new columns + an **Experience Parity** section in eval reports. Baseline: **15 rework turns (1.7/task), 2 stuck states** — Groq free-tier TPM 429 rate-limits hit 3 tasks; 2 recovered to correct code (interference, not stuckness), 1 failed.
- **Test-isolation fix** — eval-framework tests now run against a temp homedir (`vi.mock('node:os')` + hoisted temp dir); previously `afterEach(clearEvals)` wiped the real `~/.buff/memory/evals.json`.
- **`buff eval results --compare`** — one-command Part 1.9 gate: diffs two runs across the M2b axes (composite / test-pass / completion higher-better; stuck / rework / time-to-done / avg-fix / cost lower-better) with per-axis winner arrows. `selectCompareRuns()` compares against the most recent **same provider+model** run so a model switch never confounds the gate. A second identical-setup run quantified the free-tier Groq noise floor at ~±17 composite points (17 TPM 429s — 55.0% vs 72.2%) — phase-gating movement must exceed that band.

### K3 — Vault access auditing
- **Vault access log** — every credential read/write/delete is now recorded as a hash-chained, secret-scrubbed record in `~/.buff/memory/vault-access.jsonl` (**account names only, never values**). View with `buff config vault log [--limit N]`; verify integrity with `buff audit verify` / `buff doctor --enterprise`. Rotation keeps the store bounded (~5k–10k lines) with the chain re-chained intact.
- **`buff audit verify` fix** — builtin chain ids now carry the `.jsonl` extension, so `buff audit verify` verifies the REAL stores (quota-events 200 records, model-registry 2,408 records — previously every builtin silently reported as an empty bogus "legacy" chain).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.61.1] - 2026-08-08

### Added

- **`buff eval run` (non-routing) refuses placeholder-keyed providers** — if the resolved provider's configured API key is a sentinel/placeholder (e.g. the literal `openrouter-env-key`), eval aborts with a clear error instead of burning minutes producing auth-dead scores (the "consistent 25%" failure mode reported on the dev machine). Guidance points to `buff config set providers.X.apiKey <real-key>` or `defaultProvider auto`. `defaultProvider auto` already resolves through `rankAvailableProviders` (registry-verified first), so `buff eval run` now measures the best available provider, and `buff eval run --routing` measures the router's exact per-task picks.

### Changed

- **Eval guard also warns (not just aborts) when an explicit `--model` is passed with a placeholder-keyed provider** — a model override can't fix a dead key.

### Fixed

- **Hermetic test isolation** — `eval`, `orchestrator`, `injection-guardrail`, and `a2a` tests no longer depend on the dev machine's `buffconfig.json`; they pin temp `BUFF_CONFIG_DIR`s so local-model availability on the host can't flip pass/fail (the `llama2` → `gemma4:e4b` config change exposed this).

---

## [1.61.0] - 2026-08-08

### Added

- **Dynamic provider catalog (Issue 001) — ALL 17+ configured providers join routing.** A new `src/inference/provider-catalog.ts` is the single source of truth for 21 providers (id, label, env var, base URL, OpenAI-compat flag, keyless flag, api-key header, api-version query, capability profile, list pricing, context window). Routing/probing/CLI discovery are now derived at runtime from the user's credentials instead of hardcoded built-ins:
  - `ConfigManager` maps EVERY catalog env var (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `MISTRAL_API_KEY`, `DEEPINFRA_TOKEN`, `REPLICATE_API_TOKEN`, ...) into config, and keyless catalog providers (local, nuvira, lmstudio, vllm) count as configured (reachability probed).
  - `rankAvailableProviders` + the auto-router's `getDefaultAllowedProviders` consider every catalog provider with real credentials (registry-block-aware), falling back to the built-ins only when nothing is configured — a user who sets `OPENAI_API_KEY` now sees OpenAI scored and routed to.
  - Capability profiles, list pricing, and context windows fall back to the catalog for extended providers (real metadata, never a neutral guess).
  - `OpenAICompatAdapter` (generalized from NuviraAdapter) serves every OpenAI-compatible catalog provider via metadata — baseUrl, `api-key` header + api-version query for Azure, etc.; `AnthropicAdapter` serves Anthropic's native Messages API (streaming + measured usage).
  - `buff models refresh` probes every configured provider; `buff provider list/health`, `buff models`, `buff doctor`, and the model picker list the full catalog with real env-var hints.

- **ISSUE-002 — the router now leverages the data it already gathers.** Auto routing decisions are driven by (and cite) the registry's real telemetry:
  - **Registry pre-filter strength**: a provider with ZERO verified models AND ≥3 unavailable entries is DEGRADED — excluded from candidates even when credentials exist, so a dead provider (0 verified, N unavailable) can never win a task it would fail (`ModelRegistry.getDegradedProviders` + `getProviderStats`).
  - **Bandit learning ON by default**: `routing.bandit` now defaults to enabled (opt out with `buff config set routing.bandit false`) in chat, the orchestrator, and outcome recording — the Thompson-sampling bandit actually improves routing from real results instead of collecting dust. Cold start is DETERMINISTIC (untouched Beta(1,1) priors sample the mean), so enabling it never randomizes an unlearned ranking — it only shifts routing once real outcomes accumulate.
  - **Context-window transparency**: scored providers now carry a `contextWindowSource` ('live' | 'override' | 'provider' | 'default'); estimate/default windows are flagged in the reason and preflight snapshot, so "no advertised spec" is never silently treated like a real one.
  - **Explanation transparency**: the decision explanation cites the registry counts that excluded a provider (e.g. `excluded: openrouter (0 verified models, 9 unavailable)`) via the new `registryExcluded` audit field — users can see the gathered data is driving every auto decision.

- **ISSUE-004 — invalid API keys are deleted and stale local models are purged (config hygiene).**
  - **Key auto-clear after N consecutive 401/403s**: a new `KeyHygiene` store counts consecutive auth failures per provider (`AUTH_CLEAR_THRESHOLD = 3`, persisted across restarts). At the threshold `ConfigManager.clearProviderApiKey(provider, failedKey)` removes the SPECIFIC dead credential — the primary `apiKey` or a matching `apiKeys[]` rotation entry — and the user sees `🚫 ... the invalid API key has been CLEARED ... buff config set providers.X.apiKey <real-key>`. Env-sourced keys (value equals the catalog env var) are NOT cleared from the file — the user is told to unset/fix the env var instead. The counter resets only when the key was actually handled (a throwing clear retries on the next failure); a real success also resets it so one blip never clears a valid key. Hooked into the single `recordActionFailure` auth path (covers chat/execute/plan/edit/failover) + `recordRegistrySuccess`.
  - **Stale local-model purge**: `ModelRegistry.pruneAbsentModels` removes entries for models the user deleted from the local system (e.g. `ollama rm`) — unverified/unavailable entries deleted, verified entries demoted to `unavailable` ("model deleted from local system") so a partial `listModels()` response never destroys learned telemetry. Wired into `buff models refresh` for KEYLESS runners only (local/nuvira/lmstudio/vllm — authoritative lists). Keyed providers are never pruned (remote catalogs can legitimately drop models). `RefreshResult.prunedLocal` + the refresh summary report the removed count.
  - **Dashboard surfacing**: `/api/model-registry` now carries `keyHygiene` (per-provider consecutive 401/403 counters + the auto-clear threshold) and `deletedLocal` (verified models demoted because they were removed from the machine). The Models panel shows a 🧹 **Key hygiene in progress** strip warning before the threshold and a 🗑️ **Deleted locally** stat card — the cleanup the router performs is visible, not silent.

- **ISSUE-003 — the router's full feature set now fires at EVERY action point, not just chat.** A single shared `buildAutoResolveOptions` helper assembles the complete option set chat + the orchestrator pass (bandit learning ON by default, quota-ledger status, runtime stats, cost/speed/reasoning floors, paid-model gate) and every other entry point routes through it:
  - `buff plan` — the route callback now resolves with the FULL feature set (previously only the context-hint token estimate), so a plan's ranked failover walk is driven by the same learned, quota-aware, registry-filtered ranking as chat.
  - `buff eval --routing` / `buff benchmark` / `buff model explain` — scored picks now run through bandit + quota + floors + paid gate instead of a bare runtime-stats resolve, so the measured quality reflects the real production routing path.
  - `buff edit` — NEW `--auto-route` flag (or `--provider auto` / `--model auto`) drives the edit through the shared ranked walk (`runSingleShotAuto`): auto-router primary pick, ranked failover for ALL failure classes, key rotation, session exclusion, and per-action 'edit' registry attribution. The legacy explicit-provider path is unchanged.

### Changed

- `ProviderFactory` resolves all 21 catalog ids (dedicated adapters for the built-ins, generic/native adapters for the extended set).
- NuviraAdapter is now a thin subclass of OpenAICompatAdapter (behavior contract unchanged).
- **Cold-start guard (review fix):** keyless runners BEYOND `local` (nuvira, lmstudio, vllm) only join the ROUTING candidate pool once the registry verifies them or the user configures them explicitly — a not-running localhost endpoint can never out-rank a running Ollama on a fresh machine. `buff models refresh` still probes the full configured set.
- **Azure OpenAI works out of the box (review fix):** `AZURE_OPENAI_ENDPOINT` maps into `providers.azure.baseUrl`, and the generic adapter builds the real Azure shape (`/openai/deployments/{model}/chat/completions?api-version=…`, `api-key` header, `/openai/models`).
- **CLI probe fast-path (review fix):** `buff models` and the model picker skip network availability probes for providers with no configured key (and not keyless) — no more waiting on 16 dead endpoints.

## [1.60.4] - 2026-08-07

### Added

- **Per-task repair model escalation** — the same stronger-model escalation that fixes planner failures now applies to EVERY failing agent (writer, debugger, security, tester, reviewer...). When a task fails under auto routing, the repair engine is handed a re-routed LLM at the NEXT complexity level instead of re-prompting the same weak model that just failed. The escalation climbs from the task's ROUTED complexity (captured per task id, including any escalation the router already applied) so the repair is always strictly above the tier that failed.

### Changed

- `createEscalatedLLM` is now the single shared escalation primitive (planner + per-task repair), carrying the stronger decision's routing snapshot into the reasoning trace.

## [1.60.3] - 2026-08-07

### Added

- **P0 reasoning traces** — every LLM call in a pipeline (planner, memory, per-task, repair escalation) records `{agentType, provider×model, prompt digest, response preview, tokens, latency, routing snapshot}` to a per-run trace file. New `buff trace list/show/replay/clear` CLI plus a dashboard 🔍 Reasoning Traces panel — the full per-step provenance needed to debug "why did the agent build the wrong thing" instead of just counting tokens.
- **P1 failure-lesson episodic memory** — the self-improver now distills NEGATIVE trajectories ("what didn't work") into episodic memory and injects them into future planning prompts, so past mistakes (dead-end approaches, bad model choices, ignored goals) are avoided proactively. Previously only successful runs were stored.
- **Planner goal-fidelity validation** — plans must reference the goal's significant tokens (≥2-token goals) or pass an example-copy marker check (1-token goals). Off-topic or few-shot-regurgitated plans are rejected with an actionable error and re-planned. Fixes the NVDA-addon failure where the planner copied the JWT few-shot example verbatim (including its fake `path/to/...` path).
- **Planner-repair model escalation** — when the planner fails under auto routing, repair re-routes through the Auto router at the NEXT complexity level so a STRONGER model is used instead of re-prompting the same weak one until the repair budget dies. Non-auto paths keep the explicit model and honor `repairFallbackModels`.
- **`buff trace replay <id>`** — replays a captured trace step-by-step with the routing snapshot that selected each model (dashboard and CLI parity).

### Changed

- Planner few-shot example moved from JWT-auth to a neutral domain with an explicit `CRITICAL — DO NOT COPY THE EXAMPLES` instruction.
- Orchestrator + injection-guardrail tests pinned to a hermetic `BUFF_MEMORY_DIR` so trace writes never leak into the real `~/.buff` during the suite.

## [1.60.2] - 2026-08-07

### Added

- **Live context windows for every provider that exposes one.**
  - **Ollama multi-source parsing** — the local adapter reads the advertised context length from whichever location the Ollama version uses: `details.context_length` (0.32.x+), `model_info["general.context_length"]` / `["llama.context_length"]` (mid builds), or a family-keyed `model_info["<family>.context_length"]` (e.g. `gemma4.context_length`).
  - **Bounded `/api/show` fallback** — models that `/api/tags` can't describe get a targeted `POST /api/show` lookup (capped at 8 per list, so a large local library never triggers an unbounded N+1; localhost round-trips are ~ms). Live-verified: `gemma4:e4b` (custom model, no metadata in tags) now records its 131,072-token window via the fallback.
  - **Gemini** — `models.list` `inputTokenLimit` is recorded as the live window, gated on `supportedGenerationMethods` containing `generateContent` so embedding models' input caps are never mistaken for chat context windows.
  - **NIM** — vLLM-backed deployments expose `max_model_len` in the OpenAI-compatible list (total sequence length — a slight overestimate of the input window, fine for a soft preflight estimate); TensorRT-LLM deployments omit it and fall back to the provider-level estimate.
  - **Groq** — documented in code that `/models` exposes only id/object/created/owned_by (no window) — nothing to parse; falls back to the provider-level estimate.

### Fixed

- The 1.60.1 local-adapter parser looked only at `model_info.general.context_length`/`llama.context_length`; Ollama 0.32.x actually reports the value in `details.context_length`, so no local windows were recorded until the multi-source parse. Now all real local models carry live windows (verified on this machine: gemma4:e4b → 131,072, qwen2.5:0.5b → 32,768, deepseek-coder → 16,384).

### Added

- Tests: adapter window parsing for gemini (chat vs embedding vs no-fields), nim (max_model_len present/absent), and local (all three key locations + `/api/show` fallback + bounded N+1 + graceful failure). 6 new tests; 3,404 total green.

## [1.60.1] - 2026-08-07

### Added

- **Live per-model context windows in the router's context preflight.** The model probe now records each model's provider-advertised context window into the Model Availability Registry when the list endpoint exposes it — Ollama `/api/tags` (`general.context_length`) and OpenRouter `/models` (`context_length`). `resolveContextWindow` precedence is now: user override (`routing.contextWindows`) → **live registry descriptor** → provider-level nominal window → generous default. Providers whose list endpoints don't advertise windows (Groq, NIM, Gemini) fall back to the provider-level estimate. `ModelDescriptor` and `ModelRegistryEntry` gained `contextWindowTokens`; `markListed` accepts full descriptors (legacy string-id callers unchanged) and the window survives re-verify/re-kill rebuilds and JSON-mirror reloads.

### Fixed

- The v1.60.0 comment "live model descriptors win where available" is now actually true — the static provider-level estimate is only a fallback, not the primary source, when the API exposes the real spec.

### Added

- Tests: registry descriptor roundtrip (incl. reload), probe records advertised windows, router precedence (live beats provider default; explicit override still beats live). 3 new tests; 3,398 total green.

## [1.60.0] - 2026-08-07

### Changed

- **No hardcoded model defaults — fully dynamic selection.** The agent no longer ships a hardcoded default provider or per-provider model pins. `defaultProvider` is now the routing directive `'auto'`, resolved at runtime to the best *available* provider for the user's keys + learned registry (verified → configured-with-key → zero-config local). Every provider's model pin is the `'default'` sentinel, resolved at call time to a registry-verified working model. Explicit user pins still win (health-checked).
- **New `src/learning/model-selection.ts`** is the single selection authority: `rankAvailableProviders`, `resolveDefaultProvider`, `bestAvailable`, `preferredModelsFor`, `requireAdapterModel` — all derived from the Model Availability Registry (probe → spot-check → verified/unavailable), ranked by learned health (error rate, then latency). Provider-level nominal context windows replace the static per-model map; adapters resolve their last-resort model from the registry and never invent a name (clear onboarding error instead).
- **Fallback chain derived at runtime** — `fallback.providers` defaults to empty; the chain is built from what the user actually configured + verified, never a fixed provider list.
- **`'auto'` can never reach an adapter factory** — `getProviderConfig` resolves the directive, and every `ProviderFactory.createProvider` call site (router, orchestrator, skill compile, learn extract, CI review, provider-fallback) uses the resolved type.
- **Cold-start onboarding guidance** when nothing usable is configured (`buildOnboardingGuidance`): key hints + `buff models refresh`.
- Removed static selection data: `PREFERRED_MODELS`, `MODEL_CONTEXT_WINDOWS`, `DEFAULT_AGENT_MODELS`, `TASK_TO_PROVIDER`.

### Added

- `tests/learning/model-selection.test.ts` (16 tests): no-keys → local only, verified-first health ranking, blocked-provider exclusion, capability-profile picks, adapter model resolution, guidance on empty state. Router regression: `defaultProvider 'auto'` resolves to a concrete provider. 3,395 tests green.

## [1.59.9] - 2026-08-06

### Fixed

- **`BUFF_CONFIG_DIR` honored everywhere** — the config manager, dashboard server readers (`alwaysWatchQuota`, governance policy, API-key loader, RBAC role file), and the vector store's backend picker now resolve the config dir through one shared helper (`src/config/paths.ts`) with the same precedence as the RBAC layer: explicit dir > `$BUFF_CONFIG_DIR` > `~/.buff`. Previously only rbac.ts honored the override, so a hermetic smoke run pointed at `BUFF_CONFIG_DIR` could silently read/write the real `~/.buff/buffconfig.json` (exactly the stray-governance pollution seen in the v1.59.7 release).
- **`src/enterprise/rbac.ts`** switched to the same shared resolver (removed its duplicate inline resolution).

### Added

- Tests: `ConfigManager` honors `BUFF_CONFIG_DIR` for reads and writes, explicit dir arg wins over the env var; the dashboard's `/api/routing` governance reader honors `BUFF_CONFIG_DIR` over the homedir config. 4 new tests; 3,367 total green.

## [1.59.8] - 2026-08-06

### Added

- **P6 M6.4 Nuvira Gateway (minimal slice)** — the federation server is now a token-verified gateway: `FederationConfig.authMode 'oidc'` turns `/federation/handshake` into an `Authorization: Bearer` check verified by the new dependency-free `JwtOidcAdapter` (RS256 JWT verification via `node:crypto`, enforcing sub/exp/issuer/audience). `buff federation start --auth oidc --oidc-public-key <pem>`; the PEM path persists in `federation.json` so a daemonized server reloads it. Secret-mode servers are unchanged.
- **Dashboard RBAC identity card** — Routing Insights now shows who is looking (`buff admin whoami` mirror): acting identity, role badge, the full user→role map, and the legacy single-user notice, read from the same `~/.buff/rbac.json` the CLI writes.
- **Secrets hardening** — `buff doctor --enterprise` now flags M2.3 `apiKeys` rotation arrays stored in plaintext `buffconfig.json`, not just single `apiKey` values.
- **Admin guard-coverage parity test** — every mutating `buff admin` subcommand (allow/deny/allow-model/deny-model/max-cost/pii-min/unblock/clear) is asserted blocked for a viewer role.

### Added

- **P6 M6.1 RBAC** — role-based access control over the admin surface: `src/enterprise/rbac.ts` (roles admin/operator/viewer with a permission matrix, local role file `~/.buff/rbac.json` with `BUFF_CONFIG_DIR` override, OIDC adapter interface as the token-identity seam). `buff admin role add/remove/list` + `buff admin whoami`; every policy-write and role command is gated (`policy.write` / `role.manage`); legacy single-user mode stays fully permissive until roles are assigned; a misconfigured `rbac.json` now logs a warning instead of silently downgrading.
- **Dashboard governance card** — the Routing Insights page now renders the active `routing.governance.*` policy (allow/deny provider+model lists, max-cost, pii-min, unblock) read from the same config the router enforces.
- **CLI flakiness trend** — `models status` flaky rows now tag `healing` (EMA trending down toward 0) or `worsening` (climbing) from the `partialHistory` trajectory.

### Added

- **P6 M6.5 Admin governance API** — `buff admin` promotes the M2.4 policy (already enforced as hard constraints in Auto routing) into a first-class admin surface: `admin policy [--json]`, `admin allow/deny <provider...>`, `admin allow-model/deny-model <model...>`, `admin max-cost <usd>`, `admin pii-min <0..1>`, `admin unblock on|off`, `admin clear <field>` — all writing the same `routing.governance.*` config the router reads
- **Dashboard: flakiness healing sparkline** — the registry now records each `partialRate` EMA change as a bounded trajectory (`partialHistory`, capped at 16); registry rows render a mini sparkline (trending down = healing via clean successes, green end dot; climbing = accumulating). The signal survives every rebuild path (markVerified / markListed / markUnavailable — never hard-wiped) and persists across restarts
- **Dashboard: Requests panel flakiness** — per provider × model × action rows show a violet `⏸ N` chip for mid-stream partial interruptions (excluded from the error rate — a partial is not a request failure, it's the flakiness signal)
- Tests: registry 5 (history append/decay, preserve through re-verify + availability flip, 16-cap, restart persistence), admin 10, server partial/requests assertions, dashboard sparkline 3 + chip 1; 3,328 root green

## [1.59.5] - 2026-08-06

### Added

- **Dashboard: mid-stream flakiness feeds the registry cards** — the Models page now surfaces the P4 M4.4 flakiness signal the router uses: each registry row with a `partialRate` EMA > 0 renders a violet `⏸ flaky N%` chip (mirroring the CLI's `model explain` chip), provider headers show a `⏸ N flaky` badge, and the stats grid gains a **Flaky mid-stream** card. The dashboard server passes `partialRate` through the registry payload with provider + top-level `flaky` rollups; web types mark `flaky` optional so mixed-version bundles degrade gracefully. New server assertions + 3 `FlakinessChip` unit tests

## [1.59.4] - 2026-08-06

### Added

- **P6 M6.6: Software Bill of Materials (`buff sbom`).** Generates a CycloneDX
  1.5 SBOM from `package-lock.json` — the deterministic source of truth for
  exactly-what-is-installed (resolved versions + integrity hashes), so no
  network is needed and output is reproducible (`--reproducible` pins serial
  + timestamp for byte-identical rebuilds). Subcommands:
  - `buff sbom` — print the BOM (stdout) or `--out sbom.json` to write it
  - `buff sbom verify` — compare a stored BOM against the current lockfile:
    detects added/removed/changed dependencies (drift) and hand-edited BOMs
    (tamper), exit 0 clean / 1 drift
  - `buff sbom licenses` — license audit flagging copyleft (GPL/AGPL/…) and
    unknown licenses for compliance review
  - `doctor --enterprise` gains a Supply Chain (SBOM) check that verifies a
    stored `sbom.json` against the lockfile when present (real drift
    detection) and otherwise reports the fresh-BOM license posture

## [1.59.3] - 2026-08-06

### Fixed

- **`buff config set routing.<gate>` accepts the soft-signal gate keys.** The
  routing allowlist in the config CLI was stale — `capabilityFit`, `contextFit`
  and the new `partialFlakiness` were rejected with "Unknown routing config
  key". All three boolean gates now round-trip via `config set` (the router
  always read them, but operators couldn't set them from the CLI).

## [1.59.2] - 2026-08-06

### Added

- **P4 M4.4: mid-stream flakiness now feeds the ROUTER, not just the dashboard.**
  Each registry entry carries a `partialRate` EMA (0–1): `recordPartial` bumps
  it (status never flips — a partial today may complete tomorrow), clean
  `recordCall` successes decay it (never a hard wipe; a single success can't
  erase a flaky streak). New `getProviderFlakiness()` exposes the worst
  rate across a provider's models. Auto routing applies a reliability penalty
  (capped at 40% of the dimension) gated by `routing.partialFlakiness`
  (default ON), so providers that keep starting streams that die mid-way rank
  below otherwise-identical healthy ones — and `models explain` renders a
  transparent `⏸ flaky mid-stream (N%)` chip on affected rows. Set
  `routing.partialFlakiness false` to disable.

## [1.59.1] - 2026-08-06

### Added

- **Dashboard: P4 M4.4 partial mid-stream chips surface everywhere (M3.4 presentation).**
  The "learned from real usage" per-action telemetry now surfaces `partial`
  (mid-stream interruption) events end-to-end: the scrubbable timeline renders
  a violet `⏸` segment + day-summary count + legend, per-day chips render a
  violet `⏸` variant with the streamed-chunk detail in the tooltip ("died
  after ~N chunks"), and each action card shows a `⏸ N partial` stat + a
  dedicated Partial chips section (violet border wins the card when flaky
  mid-stream providers are present). `dedupeDayEvents` orders chips
  killed → partial → verified → error so flaky mid-stream providers surface
  right after predictive skips. Registry aggregation exposes `partialModels`
  (latest per provider × model, with `streamedChunks`).

## [1.59.0] - 2026-08-06

### Added

- **P6 M6.2 — Secrets management**: central `src/enterprise/secrets.ts` redaction scrubber — `redact()` masks API keys (known prefixes, Bearer tokens, key=value + JSON-encoded fields) everywhere; wired into EVERY logger method (message + args, non-plain values like Error preserved) and the two JSONL audit writers (quota-events, model-registry-actions). Nothing sensitive reaches a log or audit record. `BUFF_NO_REDACT=1` disables (debug only).
- **P6 M6.3 — Tamper-evident audit log**: `src/enterprise/audit-chain.ts` — SHA-256 hash-chained records (`chain.hash = sha256(prevHash ‖ canonical(record))`), sidecar head state (`<file>.chain.json`), `verifyChain()` with exact tamper-line detection + legacy pre-chain compatibility, rotation-safe re-chaining, O(1) fast append for hot paths, and CEF/SIEM export. New `buff audit verify` (exit 0 ok / 1 tampered|corrupt / 2 legacy) + `buff audit export`. `doctor --enterprise` Audit Integrity checks are now hash-chain verification (tamper = FAIL with the exact line).

## [1.58.9] - 2026-08-06

### Added

- **P7 M7.4 — opt-in gateway telemetry / usage-health flags** (`routing.gatewayTelemetry.enabled` / `healthFlags`, both **OFF by default**). Privacy-preserving by construction: enabling never captures prompt content — it only reports aggregate gateway usage/health (request counts, token totals, estimated cost, per-provider parked state + reset countdown) already tracked by the quota ledger + cost tracker, surfaced via `buff doctor --enterprise`.
  - `buff config set routing.gatewayTelemetry.enabled true` turns the report on; `healthFlags true` adds per-provider detail lines.
  - Off by default: `doctor --enterprise` shows an informative "Telemetry / Usage Health OFF (privacy-preserving default)" note with the enable command — never a failure.
  - `~/.buff/.env` is now overridable via `BUFF_ENV_FILE` (mirrors `BUFF_MEMORY_DIR`) so tests isolate from a real home env file; env/config tests updated.

## [1.58.8] - 2026-08-06

### Fixed

- **PERMANENT fix for the persistent "Dashboard server unreachable / Failed
  to fetch" issue.** Root cause: macOS resolves `localhost` → `::1` (IPv6)
  BEFORE `127.0.0.1` (IPv4), but the dashboard bound IPv4-only — so browsers
  hitting `localhost:3030` intermittently refused the connection (happy-
  eyeballs timing), and the frontend-only retries from v1.58.2 merely masked
  it. The server now binds BOTH loopback families to the same handler
  (IPv4 `127.0.0.1` + IPv6 `::1` twin), and `buff dashboard` auto-opens the
  deterministic `http://127.0.0.1:<port>` URL. Regression test proves both
  families serve HTTP 200. Reported repeatedly across sessions — now fixed
  at the bind layer.

## [1.58.7] - 2026-08-06

### Added

- **M4.4 conservative compression** (`routing.compression.*`, off by default):
  lossless-for-code prose elision — fenced code blocks are preserved
  byte-identical (identifiers/strings/symbols always survive, property-tested),
  only long prose is trimmed middle-out. `config set routing.compression.enabled`
  to opt in.
- **`partial` mid-stream telemetry**: the model registry now records providers
  that STARTED streaming but died mid-stream as a distinct `partial` outcome
  (aggregated per action + in the 14-day timeline; never flips availability).
  Chat's auto-failover write-throughs the interruption.
- **`buff doctor --enterprise`** (P7 M7.1): self-check for gateway health,
  secrets backend (env vs plaintext keys), audit-trail integrity (JSONL), and
  RBAC/governance policy presence. Missing optional config is informational.
- **Upgrade guide + migration notes** (P7 M7.2) added to UPGRADE_ROADMAP.md.

## [1.58.6] - 2026-08-06

### Fixed

- **`routing.*` config was silently dropped on every reload.** `loadConfig`
  merged providers/history/fallback/pricing but NOT the routing section — so
  `buff config set routing.bandit`, `routing.quota.*`, `routing.governance.*`,
  `routing.contextWindows.*` and the new `routing.nuviraSidecar.*` keys never
  survived a restart (they worked within a session only). The routing section
  is now merged with deep-merges for the nested maps. New regression test.

## [1.58.5] - 2026-08-06

### Added

- **P5 M5.4 config keys** — `buff config set routing.nuviraSidecar.enabled <true|false>`
  (the P5 feature flag) and `routing.nuviraSidecar.image <image:tag>` (pinned
  gateway image override) are now accepted by the config schema (additive-only,
  per the roadmap cross-cutting rule). 2 new config tests.

## [1.58.4] - 2026-08-06

### Added — Nuvira-Router P5 (sidecar interop) + P4 (mid-stream resilience core)

- **P5 M5.1 — Sidecar profile + `buff doctor --nuvira` probe.**
  `docker-compose.nuvira.yml` (pinned external-gateway image, `base` profile,
  healthcheck, loopback-only port mapping) + a sample `nuvira-gateway-config.yaml`.
  `buff doctor --nuvira` probes the gateway (GET `/v1/models` → reachability +
  model count; best-effort `/version` → gateway version) via the exported,
  unit-tested `probeNuviraSidecar()`. Doctor tests use a real mock gateway.
- **P5 M5.4 — Feature flag + router universe.** `routing.nuviraSidecar.enabled`
  (default false). The auto-router now includes `nuvira` as a candidate with a
  NEUTRAL profile (never dominates, never excluded — it joins the same
  registry/bandit/quota learning), and `hasRequiredCredentials('nuvira')`
  returns true (keyless loopback gateways by design; a dead gateway is skipped
  at the availability walk, never failed into).
- **P5 M5.3 — Hermetic E2E through the gateway** (`tests/e2e/sidecar-learning.test.ts`):
  mock gateway-shaped server, real adapter + registry + router — a 429 teaches
  the block, the next pick skips, a later success re-verifies (mirrors
  `failover-learning.test.ts`).
- **P4 M4.1 — Continuation retry core** (`src/learning/continuation.ts` +
  chat wiring). `isPartialFailure()` (definitive auth/rate-limit/model-404 never
  continue), `buildContinuationNote()` (bounded, head+tail partial relay,
  prompt always included), `ContinuationBudget` (max 1 continuation per task).
  Chat's interactive auto-failover buffers streamed tokens and hands the next
  candidate a bounded "continue from here" note on a mid-stream death; the
  nuvira adapter appends it via `InferenceOptions.continuation`.
- **P4 M4.2 — Reasoning-replay cache** (`src/learning/reasoning-cache.ts` +
  SSE capture). Last `reasoning_content` per (provider, model, conversation-key
  fingerprint) persisted to `~/.buff/memory/reasoning-cache.json`;
  `streamCompletion` forwards reasoning deltas (`parseSSEReasoning`); the nuvira
  adapter caches them and re-injects via `InferenceOptions.reasoningContext` as
  a prior assistant reasoning message.
- **P4 M4.3 — Context-relay summaries.** The continuation note doubles as the
  compact "session so far" relay (prompt + partial output, budget-capped) so a
  rotated provider/key has continuity.

### Tests

- New: `tests/cli/doctor.test.ts` (4), `tests/e2e/sidecar-learning.test.ts` (3),
  `tests/learning/continuation.test.ts` (12), `tests/learning/reasoning-cache.test.ts` (4),
  +3 nuvira-adapter P4 tests. Auto-router governance tests updated for the nuvira
  universe. ~3,300 root tests passing.

## [1.58.3] - 2026-08-06

### Added — Nuvira-Router P3 (Requests panel + decision diff)

- **M3.2 — Dashboard Requests panel** (`src/web-dashboard/server.ts`,
  `src/web-dashboard/src/components/RequestsPanel.tsx`). New
  `GET /api/requests` endpoint + Requests nav item/route: a per
  provider × model × action request table built from the action-telemetry
  JSONL log — requests, failures, avg latency, p50/p95/p99 (percentiles
  render only at ≥10 samples, per the roadmap contract; the avg renders
  whenever any sample exists), last-call time, and measured spend per
  provider × model sourced from the cost ledger (adapters record cost
  without an action tag, so ledger spend is attributed at provider×model
  and the panel sums unique pairs). Also wired into `/api/all` and both
  SSE payloads.
- **M3.3 — Decision diff (`models explain --since <ref>`)** — new pure
  `src/learning/decision-diff.ts` module (`diffRoutingDecisions` +
  `formatDecisionDiff`): `models explain` now records a full
  `RoutingSnapshot` (winner, ranked scores, task type) per decision, and
  `--since @1|@2|…` compares the current decision against that earlier
  snapshot — candidate score deltas (▲ improved / ▼ regressed /
  unchanged), winner changes, and gate/latency changes. Renders in human
  output and `--json` (as `diff`).
- **Telemetry latency threading** — `ModelRegistry.recordCall` /
  `markVerified` and the shared failover runner now record measured
  latency (and cost/callId where known) into each action-telemetry entry,
  so the Requests panel has real per-call latency instead of zeros.

### Tests

- 85 root tests (decision-diff suite + explain `--since` + `/api/requests`
  server contract) and 54 dashboard component tests (RequestsPanel suite),
  all passing; typecheck clean on both sides.

## [1.58.2] - 2026-08-06

### Fixed

- **Models dashboard "Failed to fetch" repeat fix** — the Models page fetch was
  un-hardened: a single transient network hiccup (browser socket-pool
  contention with the persistent SSE feed, a slow provider probe, an
  IPv4/IPv6 race on `localhost`) rejected the bare `fetch()` calls with
  `TypeError: Failed to fetch` and left the panel stuck on an error banner.
  The panel now uses per-request `AbortController` timeouts, fetches health
  and registry independently (a failure on one never hides the other),
  auto-retries network-level failures with backoff, re-polls quickly after a
  failure (self-healing instead of waiting the 60s cadence), and shows a clear
  "Dashboard server unreachable — retrying automatically…" message only after
  retries are exhausted. 3 new component tests (total 48).

## [1.58.1] - 2026-08-06

### Added

- **Dashboard mirrors the CLI `model explain` guarantees** — the Auto Router
  preference panel now renders the v1.58.0 M2.x chips on every provider row:
  🎯 capability fit (`capabilityFit`), 📏 measured wire-token cost
  (`costSource` + `costBasis`), and ⏳ context preflight (`contextUtilization` +
  `contextWindowTokens`). `/api/routing` and `/api/all` carry the fields per
  ranked provider; rows whose gates are OFF simply omit the chip (the cost
  source always renders, exactly like the CLI). Verified live end-to-end.
- `MODELS_EXPLAIN_DEMO.md` gains a dashboard-mirroring section.

### Tests

- 3,161 root tests pass (+45 dashboard component tests): new component tests
  for the preference-table chips (measured renders, gates-OFF leaves only the
  cost chip, no chip row when fields absent) and a server assertion loop
  proving the measured/estimated cost-source contract. Also fixed a
  cold-start timeout flake in `trajectory-store.test.ts` (vector-backend
  warmup in `beforeAll` + 60s timeout on the first save test).

## [1.58.0] - 2026-08-06

> First release to ship the Nuvira-Router P2 routing work below. Also carries
> the `buff dashboard --force` + `--port` fixes staged as v1.57.0 (see that
> entry) — v1.57.0 was bumped in `package.json` but never published, so all of
> it lands here. 3,159 root tests pass (+ dashboard component tests).

### Added — Nuvira-Router P2 (capability-aware scoring + wire-token metering)

- **M2.5 — Context-length preflight** (`src/learning/auto-router.ts`,
  `src/learning/hybrid-router.ts`, `src/cli/chat.ts`, `src/cli/model.ts`,
  `src/cli/config.ts`). The genuine gap Copilot identified — the router now
  scores each provider's NOMINAL INPUT CONTEXT WINDOW against the task's
  estimated prompt size before picking. Built-in per-model + per-provider
  window tables (`MODEL_CONTEXT_WINDOWS` / `PROVIDER_CONTEXT_WINDOWS`,
  `routing.contextWindows` overrides keyed by model or provider always win),
  and the estimate comes from the caller's `contextHintTokens` when the REAL
  payload is known (chat passes the growing conversation history and the
  built full prompt) — else the task text. **Soft, estimation-only, NEVER a
  hard block**: `computeContextFit` is neutral below 50% utilization
  (normal-size tasks never shift a ranking), ramps linearly, and even a
  prompt exceeding the window only caps the penalty at 35% (models may
  exceed nominal windows). Reversible gate `routing.contextFit` (default ON,
  like capability-fit — gate-off omits the signal entirely). Surfaced per
  provider in `models explain`: a `⏳ ctx N%` chip on ranked rows, a full
  `── Context preflight ──` section (estimated tokens, basis task|hint,
  per-provider window/utilization/fit), and a JSON `context` block; fallback
  chain candidates carry `contextWindowTokens`. `buff config set
  routing.contextWindows.<model|provider> <tokens>` stores validated
  integers. A 500K-token payload flips a privacy-first local pick to gemini
  (1M window) — the long-conversation/heavy-workspace case now routes toward
  big-window providers.
  - **Followup: plan + orchestrator pass real payload estimates** (`src/cli/plan.ts`,
    `src/agents/orchestrator.ts`). `buff plan` resolves with
    `contextHintTokens: estimateTokens(prompt)` — the actual built prompt
    (task + parsed codebase context). The orchestrator sizes each per-task
    payload via `estimateTaskPayloadTokens(vault, description, contextFiles)`
    (goal + task description + stat-sized workspace context files, best-effort)
    and forwards it as `contextHintTokens` through `resolveAutoRoutingDecision`
    into the router, so multi-agent pipelines (execute/plan) get the same
    long-context awareness chat already had. Planner decision intentionally
    omits the hint (its payload isn't known at resolve time; goal-only would
    equal the router default). 3 new tests; 288 affected + full gate pass.
- **M2.4 — Governance constraints (admin policy)** (`src/config/types.ts`,
  `src/learning/auto-router.ts`, `src/cli/models.ts`, `src/cli/model.ts`,
  `src/web-dashboard/server.ts`). Admin routing policy via `routing.governance`
  — config-additive, fully permissive when unset. Provider allow/deny lists,
  model allow/deny lists (enforced against the model that will ACTUALLY be
  served: the configured pin, or the curated defaults when unpinned — a pinned
  violator is killed even if a curated default would pass), an admin per-call
  max-cost cap (the stricter of admin vs per-call wins), and a PII-domain
  block (task matches `piiPatterns` → only providers with privacy ≥
  `minPrivacyForPii`, default 1.0 = local-only). All enforcement is a HARD
  elimination in the router's constraint slot — never a score nudge.
  **Hard-gate guarantees:** when a governance rule eliminates EVERY candidate
  the router REFUSES to serve a policy violator — `PIIPolicyError` (privacy)
  / `GovernancePolicyError` (lists/admin cap), each carrying the full
  `governanceBlocked` audit trail (provider + reason); only per-call SOFT
  options (`maxCostUsd`/`minSpeed`/`minReasoning`, which never populate the
  audit) keep the benign fallback-to-ranking. `models explain` renders policy
  blocks cleanly (human audit trail + JSON error object); `buff plan`
  rethrows instead of degrading around a block. `buff models unblock` gains
  the admin gate `governance.allowUnblock: false` (refuses the escape hatch)
  and an advisory when the provider sits on an admin deny list (unblock alone
  can't restore it). Dashboard Quota panel adds the parked key-account view
  (`parkedAccounts`). `buff config set` supports `providers.<name>.apiKeys`
  and `routing.governance.*`.
- **M2.3 — Multi-account key rotation** (`src/config/types.ts`,
  `src/learning/quota-ledger.ts`, `src/cli/failover-runner.ts`). A provider
  can now carry MULTIPLE API keys (`ProviderConfig.apiKeys: string[]`, in
  addition to the primary `apiKey`). The shared failover walk
  (`runSingleShotAuto`) rotates through every non-parked key of a candidate
  BEFORE switching providers: on a rate-limit/auth failure the dead ACCOUNT
  is parked in the quota ledger (FNV-1a fingerprint via `accountIdForKey` —
  raw keys are never persisted) and the next key is tried, so a quota-exhausted
  secondary account no longer forces a provider switch. `options.apiKey`
  overrides the configured key at the adapter level (Groq, NIM, Nuvira
  gateway). Rotation is logged (`🔑 key#N …`), the next run SKIPS parked
  accounts predictively (`isAccountParked`), and `releaseProvider` /
  `releaseAccount` / `buff models unblock` clear them. Single-key and
  keyless behavior is unchanged. Account parks act as a floor — the
  config-aware `routing.quota.windowMs` window (via `recordActionFailure`)
  wins when longer. Hermetic E2E (`tests/e2e/key-rotation.test.ts`) drives
  the real adapter + runner against a mock gateway whose behavior keys on the
  Authorization header: key-1 → 429 parks, key-2 → 200 answers, next run
  skips key-1. Surfaced in `models explain` per ranked provider (`cost-source`
  column) and in the dashboard Models panel (📏 measured-token chip).

### Added — Nuvira-Router P2 (capability-aware scoring + wire-token metering)

- **M2.1 — Capability-aware scoring** (`src/learning/auto-router.ts`). A new
  soft task-type → capability signal: each task type's required model-catalog
  tags (`plan`→reasoning, `code-review`→code+reasoning, quick edit→code,
  `context-gather`→fast, …) are matched against each provider's offered tags,
  nudging equally-scored candidates toward the one whose strengths fit the
  task. Tags = static catalog ∪ tags derived from the provider's REAL
  capability profile (custom/gateway providers are scored honestly); unknown
  providers stay fully neutral (the fallback profile derives nothing) until
  real usage data exists. Applied as a clamped soft multiplier
  `min(1, score·(0.9+0.2·fit))` — it can never overturn a dimension-weight
  advantage or break the 0–1 invariant. **Reversible gate**
  `routing.capabilityFit` (default ON) — set false to revert to pure
  dimension-weight scoring. Surfaced per ranked provider in `models explain`
  (text `🎯 fit N%` + JSON `capabilityFit`); fit applies only to healthy
  candidates (quota-parked reasons stay definitive, no chip).
- **M2.2 — Wire-token cost inputs (measured cost beats the estimate)**.
  OpenAI-compatible adapters (Nuvira gateway, Groq, NIM) now capture the
  provider-reported `usage` — from the response body and from the final SSE
  chunk (include_usage convention) — and record EXACT input/output tokens
  (`recordCallMeasured`, `CostEntry.measured`). The Model Availability
  Registry stores per-model token EMAs (`recordMeasuredUsage` /
  `getMeasuredUsage`), and Auto routing's cost scoring uses MEASURED tokens
  instead of the TYPICAL 2,000/500 estimate whenever real usage exists
  (`costSource: 'measured' | 'estimated'` per ranked provider in
  `models explain`, shown as `📏 measured N→M tok`). The dashboard cost panel
  splits spend into 📏 measured (exact wire tokens) vs 📐 estimated
  (length-based), per-call and per-provider. Providers that report no usage
  fall back to estimates, flagged. Hermetic E2E
  (`tests/e2e/gateway-measured-cost.test.ts`) drives the real adapter against
  a mock OpenAI-compatible /v1 gateway and proves the full loop: measured
  usage → registry → verified → measured-cost resolve.

### Added — Nuvira-Router M0.2 (shared failover machinery, phase P0)

- **`recordActionFailure()` — one shared failure-composition for every action**
  (`src/learning/failure-bookkeeping.ts`). Every LLM-call failure now runs the
  SAME bookkeeping: classify → session exclusion (auth = rest of session,
  rate-limit = cooldown + quota-ledger park, transient = cooldown + re-verify
  marker) → per-action model-registry write-through (model-not-found →
  definitive unavailable) → quota-timeline failover event → circuit-breaker
  feed. Best-effort, never throws.
- **`runSingleShotAuto()` — one shared auto-failover walk**
  (`src/cli/failover-runner.ts`). Walks the auto-router's ranked candidates
  for ANY failure class and returns the first success; same candidate order,
  same per-attempt telemetry, same TTY-guarded prompt-on-failover, same
  last-error throw — extracted behavior-identically from chat.
- **`buff plan` now fails over like chat.** The old pick-then-`callWithFallback`
  (retryable-only) path is replaced with the shared walk: plan tries the
  picked provider first, then the auto-router's ranked alternatives, records
  every attempt through the full bookkeeping (`action: 'plan'`), and repairs
  models to live ones. Picker + auth UX preserved.
- **`buff execute` now uses the full bookkeeping.** The orchestrator's per-agent
  LLM catch (the single record point for the whole pipeline) switched from a
  bare registry write to `recordActionFailure` — a mid-pipeline 429 now parks
  the provider in the quota ledger so the next task skips it predictively.
  `resolveAutoRoutingDecision` also consults the per-pipeline failure session
  (M0.3): a provider that failed earlier in the pipeline never wins a
  subsequent task. `generateFollowUpSuggestions` (the one execute-side call
  that bypassed the orchestrator) now records through the same composition.
- **Regression gate** (`scripts/ci/regression-gate.sh`) — canonical
  no-regression gate (routing guard → hermetic failover E2E → full root suite
  → dashboard suite, hard failure exit), wired into CI as the baseline lock.

---

## [1.57.0] - 2026-08-05

### Added

- **`buff dashboard --force`** — automatically detect a STALE dashboard on the
  port (the API/SSE mismatch: `/api/model-registry` answers with SPA HTML
  instead of JSON) and offer to restart it. A new unit-testable module
  `src/cli/dashboard-restart.ts` provides `probeDashboardPortState` (classifies
  what's on the port: unreachable / not-a-dashboard / current-dashboard /
  stale-dashboard / unknown — only a stale Agent-Nuvira dashboard is ever
  touched), `findPidOnPort`, `killPid` (SIGTERM→SIGKILL, `taskkill` on
  Windows), `waitForPortFree`, and `confirmStaleRestart` (inquirer confirm;
  non-TTY `--force` runs skip the prompt). The CLI then kills the stale PID,
  waits for the port to free, and re-binds a fresh server (up to 3 attempts).

### Fixed

- **`buff dashboard --port <port>` silently ignored the port** (pre-existing
  bug) — `createDashboardServer()` bound the module-**import-time** `PORT`/
  `HOST` constants, so any non-default port still served on 3030. The server
  now resolves the bind at **call time** from explicit `{ port, host }`
  overrides (env vars → defaults as fallback), and the CLI passes them
  explicitly. This was ALSO why the `--force` restart loop failed: after
  killing the stale dashboard it kept re-binding 3030 (EADDRINUSE) instead of
  the requested port — proven fixed live end-to-end (stale detected → killed →
  fresh server re-bound on the requested port).
- The `--force` retry now gates on the port actually freeing (the
  `waitForPortFree` result is honored instead of discarded), and the restart
  promise has a rejection handler so an unexpected error can never leave the
  CLI hanging on an unsettled promise.

### Tests

- 3,032 root tests pass (+42 dashboard component tests): new
  `tests/cli/dashboard-restart.test.ts` (17 tests for the probe/kill/wait/
  prompt helpers), `--force` CLI paths (detect → restart, current-dashboard
  decline, confirm decline), and a server regression proving an explicit
  port override binds the requested port.

## [1.56.1] - 2026-08-05

### Fixed

- **Dashboard Models panel crash — "Failed to execute 'json' on 'Response':
  Unexpected token '<'"** — a STALE dashboard server (an older globally-installed
  `agent-nuvira dashboard` still running on the port) returned the SPA
  `index.html` (HTTP 200, `text/html`) for `/api/model-registry` — a route its
  older server code doesn't have — while the newer frontend bundle fetched it.
  `res.ok` was true, so `res.json()` threw on the HTML. Fixed at all three
  layers:
  - **Server** — unknown `/api/*` paths now return a parseable **JSON 404**
    (`{ error: 'Not found', path }`) instead of falling through to the SPA
    fallback, so API consumers never receive HTML. Non-API unknown paths still
    get the SPA fallback.
  - **Frontend** — all `/api/*` responses are parsed defensively through a
    shared `parseJsonOrNull()` helper (Content-Type must be JSON + try/catch
    parse; an HTML-200 logs a console hint and degrades to null).
    `ModelsPanel`'s `/api/models` non-JSON surfaces a friendly "is the
    dashboard server up to date?" error instead of an uncaught parse crash;
    the registry/telemetry sections (optional data) simply hide when the
    response isn't JSON, and `api.ts`'s `fetchAll()` (the app bootstrap)
    waits for the next SSE snapshot instead of crashing.
  - **CLI** — `buff dashboard` now listens for the `error` event on the server:
    **EADDRINUSE** (the exact stale-instance scenario) logs a clear "port
    already in use — another dashboard (possibly an older version) is running"
    message with `pkill` / alternate-port hints, closes the server, and exits 1
    instead of crashing with an unhandled error event and leaving the browser
    pointed at the stale instance.
- **Tests** — server suite flips the old contract (unknown `/api/*` → 200 HTML)
  to JSON-404 + a non-API SPA-fallback test; `dashboard.test.ts` mock is now
  EventEmitter-shaped (fires `listening` on `setImmediate`, captures `error`)
  with a new EADDRINUSE test; `ModelsPanel.test.tsx` adds two fetch-degradation
  tests (both endpoints HTML → friendly error; registry-only HTML → grid
  survives). Root suite: 3,011 tests; dashboard component tests: 42 across 6
  files.

---

## [1.56.0] - 2026-08-05

### Added

- **Scrubbable per-action telemetry timeline** — the dashboard's daily
  "learned from real usage" chart (verified vs killed vs transient per
  action over the last 14 days) now matches the Run Timeline interaction:
  drag across the bars, click a day, or use the range slider to scrub the
  caret to any day, with ▶ play/pause sweeping day-by-day. The detail panel
  under the chart shows the scrubbed day's exact chips — which provider ×
  model the action killed (predictively skipped) or verified that day.
  Day buckets in the registry's action-telemetry timeline now carry their
  raw events (provider × model × outcome × reason, deduped per combo so the
  dashboard payload stays bounded as usage grows) end-to-end from the JSONL
  log through `/api/model-registry`.

### Notes

- Test suite: 3,011 tests across 98 files. Web dashboard component tests:
  39 across 5 files (added the scrubbable-chart suite).

---

## [1.55.0] - 2026-08-05

### Added

- **`buff models unblock <provider>` escape hatch** — manually release a
  provider the Model Availability Registry has ruled out (predictive skip).
  `ModelRegistry.unblockProvider()` demotes every `unavailable` entry to
  `unverified` and clears quota parks, `getQuotaLedger().releaseProvider()`
  clears the ledger cooldown (so `syncQuota` can't instantly re-park genuine
  exhaustion), then the command re-probes the live API via
  `refreshModelRegistry` to re-learn the truth. Output shows the demote
  result, the re-probe verdict (`verified` / `unavailable` / `skipped` /
  `error`), and an honest `stillBlocked: true/false` field — with `--json`
  for CI. `--no-spot-check` skips the live probe (demote + un-park only).
- **Fixed a pre-existing `models` subcommand JSON bug** — the parent `models`
  command's `-j, --json` option shadowed the identical flag on its
  subcommands, so `models status --json` and `models refresh --json` silently
  emitted human output. New `isJsonMode()` helper resolves the flag through
  `optsWithGlobals()`, fixing both commands (and the new `unblock --json`).

### Notes

- Test suite: 3,009 tests across 98 files (added the unblock registry + CLI
  suites). VS Code extension: 213 tests across 10 files.

---

## [1.54.0] - 2026-08-05

### Added

- **VS Code extension telemetry attribution** — the extension now tags every
  real LLM call it drives with `BUFF_TELEMETRY_ACTION` at each subprocess spawn
  (`ide-chat` for the chat panel, `ide-inline` for inline suggestions,
  `ide-<command>` for execute / edit / workflow / review via the CLI manager),
  so IDE usage shows up as its own rows in the per-action "learned from real
  usage" registry log and dashboard panel instead of blending into
  terminal-driven telemetry. The CLI resolves the override centrally in
  `recordRegistryFailure` / `recordRegistrySuccess` (`resolveTelemetryAction`),
  so every write from an IDE-spawned CLI process — including developer-mode
  orchestrator calls inside a chat session — inherits the spawning action's
  tag (documented as process-wide by design).
- **Env-override tests** — `provider-fallback.test.ts` covers the override
  (IDE-tagged kill + verify writes, blank-override fallback, natural tag when
  unset) with file-level `BUFF_TELEMETRY_ACTION` isolation; `cliManager.test.ts`
  asserts the spawn env carries `ide-<command>` for execute/chat/edit.

### Notes

- Test suite: 3,002 tests across 98 files (added the env-override + spawn-env
  suites). VS Code extension: 213 tests across 10 files.

---

## [1.53.0] - 2026-08-05

### Added

- **Per-action "learned from real usage" telemetry everywhere** — every LLM call
  (chat, execute, plan, edit, skill, learn, ci, doctor) writes through to the
  Model Availability Registry WITH its action tag, so the registry learns which
  provider × model each action killed or verified from real usage — not just
  probes. `models status --verbose` prints registry-blocked providers (why
  routing skips them) plus per-action verified/killed chips; the dashboard's
  Models panel shows the same feed with a **daily timeline chart** (verified vs
  killed vs transient per action over the last 14 days). A provider killed by
  ANY action is skipped predictively by all others.
- **Recovery loop** — a later real success re-verifies a provider AND clears a
  stale learned quota-park (a real 1-token spot-check or usage success is
  direct evidence the provider serves again; `syncQuota` re-parks genuine
  exhaustion on the next routing read).
- **Hermetic E2E failover test** (`tests/e2e/failover-learning.test.ts`) — a
  real local HTTP mock returns 429, the real NIM adapter + ProviderFallback +
  ModelRegistry + AutoModelRouter are exercised over that socket, proving
  "registry learns the block, next pick skips it" (and the recovery loop) with
  zero external network / Ollama.

### Notes

- Test suite: 2,996 tests across 98 files (added E2E + registry timeline +
  `models status --verbose` coverage).

---

## [1.52.0] - 2026-08-04

### Added

- **Predictive model-availability routing** — the model registry now drives every
  pick: models with no known API key or failed health probes are skipped before
  scoring, so the router never opens a session on a dead provider (no more
  "starts with Gemini, then NIM, then local" on every chat). Registry health,
  availability, token remaining and reset windows feed the scorer directly.
- **Web dashboard — scrubbable phase timeline** for pipeline runs (plan → gather
  → write → review → test), persisted to `pipeline-runs.json` and replayed with a
  draggable caret, play/pause sweep, and run selector; scrubbing highlights the
  matching DAG node.
- **Web dashboard — routing walkthrough** "Why did the router pick this?": a
  narrated 4-step playback (request → candidates → exclusions → pick) built from
  real routing-history decisions, with a complexity-profile fallback.

### Notes

- The dashboard is rebuilt into `src/web-dashboard/public/` and ships inside the
  npm tarball, so `buff dashboard` serves the new timeline + walkthrough.

### Fixed

- **Published README version-history table completed** — the README shipped in
  the npm tarball was missing the v1.50.0 and v1.51.0 rows in the version
  history table (it stopped at v1.49.1), so consumers of the published docs
  couldn't see the two newest releases. Added both rows; the historical
  v1.45.5 entry was verified against the npm registry and CHANGELOG and left
  intact (it's a real release record, not a stale reference)

---

## [1.51.0] - 2026-08-04

### Added

- **Routing strategy super-enhancement** — Auto model selection now scores
  providers across 5 weighted dimensions (reasoning, speed, cost, privacy,
  reliability) with per-complexity weight matrices for all 5 levels (trivial →
  critical). Key enhancements:
  - **Thompson-sampling bandit** with cost-adjusted rewards per complexity
    bucket; Beta(1,1) cold start behaves deterministically until outcomes
    accumulate. State persists to `~/.buff/memory/router-bandit.json`
  - **Uncertainty-driven escalation** — when the bandit's winner has no learned
    data (α+β < default 8 samples), routing escalates to the next-ranked
    provider that HAS learned data with a ≥55% win-rate floor, so a cold-start
    winner never commits to a coin flip
  - **Per-modelId learning** (ruflo ADR-149 mirror) — both provider-level and
    model-level Beta priors track which concrete model won; cold start keeps
    the configured pin, learned models prefer the best Thompson-sampled one
  - **Promotion gate A/B** — every auto-routed task records both the
    deterministic heuristic pick and the bandit pick for the same task;
    `buff model bandit` evaluates 3 criteria (quality improvement >2%, cost
    regression ≤1%, p95 latency regression ≤5%) before promoting the bandit
  - **Routing rules** — regex/string task-pattern rules force a specific
    provider/model before scoring (first match wins); rules also note the
    forced provider for correct bandit outcome attribution
  - **Hard constraints** — `routing.maxCostUsd`, `routing.minSpeed`,
    `routing.minReasoning` eliminate violating providers with graceful fallback
    when constraints would remove everything
  - **Credential-aware filtering** — Auto routing never picks a provider
    without configured credentials (ModelRegistry fast path verifies usable
    models); explicit `allowedProviders` always win
  - **Quota-ledger integration** — exhausted providers sink below healthy ones
    like circuit-breaker cooldown, only picked when every candidate is parked
  - **Runtime stats blending** — benchmark quality scores (30%) + per-agent
    best-model stats adjust provider capability scores in real time
  - **Verification-aware escalation** — verification-heavy tasks (deploy,
    security audit) boost reasoning+reliability weights and reorder candidates
    so the strongest provider for verification is tried first
  - **Free/local-first gate** (`routing.allowPaid: false`) — keeps paid
    providers out of trivial/simple/moderate tasks; complex/critical tasks may
    still use high-capacity models

- **Orchestrator test pollution fix** — 2 flaky checkpoint-resume tests were
  failing under parallel load due to module-level `mockClear()` (which clears
  call counts but not implementations) vs `mockReset()` (which clears both).
  Changed all 3 `describe` blocks to use `mockReset()`, added cross-describe
  mock reset in auto-model resolution `beforeEach`, and restored
  `mockReturnValue()` after each reset. Full suite: 2,934 tests, 0 failures.

- **Model-registry test FAISS backend fix** — widened the expected backend
  assertion from `['json', 'faiss-ivf']` to `['json', 'faiss-ivf',
  'faiss-native']` since `@faiss-node/native` is now installed and functional
  on this machine. All 19/19 model-registry tests pass.

### Changed

- **Auto routing tests expanded** — 95 tests covering: 5 complexity levels ×
  4 preference modes, pricing overrides, runtime stats, bandit learning,
  uncertainty escalation, credential filtering, hard constraints, routing
  rules, per-model learning, and promotion gate A/B
- **Total test count** updated to 2,934 tests (96 test files) — all passing

---

## [1.50.0] - 2026-08-02

### Added

- **`buff memory backend --check` diagnostics** — new `backend` subcommand
  shows the active vector-search backend (faiss-native / faiss-ivf / json),
  why it was chosen, and (with `--check`) whether native FAISS is installed
  and usable, with install guidance when it isn't. `checkNativeFaiss()` is
  also exported from the package API.
- **Docs & website coverage for the FAISS-backed vector store** — README
  version history, Product_Guide inventory rows 93–95 + release timeline
  (v1.48.0–v1.49.1), User_Manual "Vector Search Backend" section, and a new
  FAISS feature card on agent-nuvira.com with test counts updated to 2,880+.

---

## [1.49.1] - 2026-08-02

### Fixed

- **Native FAISS tier now actually activates** — `NativeFaissBackend` was
  written against the wrong `@faiss-node/native` API (`IndexFlatIP`), so the
  load-time smoke test always failed and agent-nuvira silently ran the pure-JS
  IVF backend even when the native module was installed and built. Rewritten
  for the real v0.1.11 API (`FaissIndex` with `{ type: 'FLAT_IP', dims }`,
  async `add(Float32Array, Int32Array?)` / `search(Float32Array, k)` returning
  typed arrays, `dispose()`), with L2-normalization so FLAT_IP inner product =
  cosine similarity, a typed-array-safe smoke test (the `Array.isArray` check
  is false for `Int32Array` labels — the second silent-fallback bug), CJS/ESM
  interop normalization, and a `Math.max(0, …)` pad guard. Verified: on a
  machine with `@faiss-node/native` built, `createFaissBackend` now resolves
  to `faiss-native` and searches correctly. New mock-based native-tier tests
  (end-to-end + filter) and an updated fallback test

## [1.49.0] - 2026-08-02

### Added

- **Hermetic memory test suite** — `vector-store`, `trajectory-store`, and
  `memory-integration` tests now run against a fresh temp `BUFF_MEMORY_DIR`
  (they previously wrote to the real `~/.buff/memory`)
- **IVF-vs-exact benchmark** — new `faiss-benchmark` test compares the pure-JS
  IVF-flat ANN against the exact JSON backend on a 2,000-vector corpus:
  asserts exact recall@5 ≥ 0.99, IVF recall@5 ≥ 0.9, recall@1 ≥ 0.8, and logs
  per-query latency so the approximate-search tradeoff is measurable
- **Cross-session FAISS transparency** — the orchestrator's memory-retrieval
  step now logs the active vector backend (`faiss-native` / `faiss-ivf` /
  `json`) in verbose mode; a new integration test verifies cross-session
  trajectory memory is served through the FAISS-style backend under `auto`

### Fixed

- **Module-import path capture in trajectory/pattern stores** —
  `trajectory-store.ts` and `pattern-extractor.ts` resolved their memory-dir
  paths at module load (ignoring `BUFF_MEMORY_DIR`); they now resolve lazily
  per operation, matching `vector-store.ts`, so hermetic tests and
  `BUFF_MEMORY_DIR`-based redirects work everywhere

## [1.48.0] - 2026-08-02

### Added

- **FAISS-style vector search backend** — the JSON vector store is now a
  pluggable backend behind the same `VectorStore` interface. New
  `src/memory/faiss-backend.ts` provides a **pure-JS IVF-flat ANN** (a faithful
  TypeScript port of FAISS `IndexIVFFlat`: nlist inverted lists via
  deterministic k-means++, nprobe probe lists, cosine = inner product of
  L2-normalized vectors, filter-aware probe expansion) that is exact below the
  512-entry threshold (identical results to the JSON backend) and approximate
  above it, plus a **best-effort native tier** that uses real
  `@faiss-node/native` bindings when the user has installed+build them
  (smoke-tested at load; any failure falls back to the pure-JS tier, so
  semantic search never breaks). Backend chosen by `memory.vectorBackend`
  (`auto` default / `faiss` / `json`), the `BUFF_VECTOR_BACKEND` env var, and
  shown in `buff memory stats`. `@faiss-node/native` added as an optional
  dependency (npm skips it gracefully when it can't build). Decision
  documented: native FAISS requires cmake/OpenBLAS/libomp compilation with no
  prebuilt binaries, so it can't be a hard dependency for zero-setup
  `npx agent-nuvira` — the pure-JS IVF-flat backend provides FAISS-style
  behavior portably

### Added

- **Vector retrieval — token-efficient context** — large gathered contexts are chunked (~512 tokens, paragraph-aware, 64-token overlap), embedded locally with `bge-small-en-v1.5` via @huggingface/transformers (zero new deps, 384-dim so the vector schema is unchanged), and reduced to the top-k semantically-relevant chunks before the LLM call — saving tokens so free quotas stretch further (complements the quota ledger: retrieval SAVES, ledger MANAGES). Small contexts pass through untouched (zero overhead); any retrieval failure fails over to the full context (never breaks the LLM call). Wired into `chat --file` (chunk reduction) and `buff execute` (post-gather semantic file ranking for the writer + token-savings stats). New `buff retrieval index/query/stats/clear` CLI, `routing.retrieval` config (enabled/topK/chunkTokens/overlapTokens/thresholdTokens/model), and a dashboard 🧠 Retrieval card (tokens saved, avg reduction, repo chunks, latest hits)
- **VectorStore namespaces** — each namespace gets its own index file (`vectors.json` default, `vectors-<ns>.json` otherwise) so repo retrieval chunks never pollute memory/history vectors; entry format unchanged so existing vectors survive upgrades
- **Embedder model override** — `embed()` accepts a model param (default `all-MiniLM-L6-v2` for memory/history; `bge-small-en-v1.5` for retrieval); cache key includes the model

- **Always-on dashboard quota watcher** — new `routing.alwaysWatchQuota` config flag: when enabled, the dashboard's quota file watcher arms at server start and is **never disarmed by client count**, so the Failover Timeline is already current the moment a dashboard connects even after the server sat idle between viewing sessions (was: armed only while an SSE client was connected). Test hook `setAlwaysWatchQuota()` / `isQuotaWatcherArmed()` exported for hermetic tests
- **Single-shot Auto failover confirmation** — `routing.promptOnFailover` now also applies to one-shot Auto prompts (`buff chat "..." -m auto`): before silently hopping to the next candidate, the CLI asks (switch recommended / pick manually); choosing "manual" surfaces the original provider error instead of switching behind your back. Previously the confirmation prompt only ran in the interactive chat loop

## [1.45.5] - 2026-08-02

### Added

- **Opt-in failover confirmation** — `routing.promptOnFailover: true` makes Auto mode ASK before a mid-session provider swap: when a provider dies (expired key, exhausted quota, deprecated model), the CLI shows the next-ranked candidate and offers "switch (recommended)" or "pick a provider myself" instead of silently auto-switching. Default stays silent auto-failover (never get stuck). New unit-tested `src/cli/failover-prompt.ts`

## [1.45.4] - 2026-08-02

### Added

- **Real-time quota events over SSE** — the dashboard server now watches
  `quota-events.jsonl` / `quota-ledger.json` in the memory dir and pushes a
  dedicated `quota` SSE event the moment a failover, park, or window reset is
  written (from the CLI, chat failover, or any process sharing `BUFF_MEMORY_DIR`)
  — the Failover Timeline updates instantly instead of waiting for the next 10s
  refresh tick. The watcher is armed only while a dashboard client is connected
  and disarmed when the last one disconnects; debounced so rapid append bursts
  coalesce into a single push
- **Frontend `quota` SSE handler** — `api.ts` merges the pushed quota payload
  into `routing.quota` and notifies subscribers, so the Quota card + Failover
  Timeline re-render in real time (mirrors the existing `dag` event pattern)

## [1.45.3] - 2026-08-02

### Added

- **Quota failover timeline** — a persistent event log (`~/.buff/memory/quota-events.jsonl`, capped at 200 events) records when providers are **parked**, **re-enabled** (window reset), **released** (manual), or **failed over** mid-session (auth/rate-limit). Chat's auto-mode failover bookkeeping writes `failover` events directly; the ledger's park/release/window-roll paths write the rest (assessment item #7: "show which models were used and when failover occurred")
- **Dashboard Failover Timeline card** — the 📒 Quota Ledger panel now renders the recent event timeline (type, provider, reason, time) from `/api/routing` (`quota.events`, newest first, max 50, corrupt-line-safe)
- **CLI failover timeline** — `buff model quota` shows the last 20 events in the human output and includes them as `events` in `--json` — and renders them even when the ledger has no usage entries yet (failovers can precede any successful call)

### Fixed

- **Empty-ledger dashboard timeline** — `readQuotaData()` previously returned without the `events` field when no `quota-ledger.json` existed, hiding the failover timeline; it now always includes events

## [1.45.2] - 2026-08-02

### Added

- **`buff model quota` cost summary** — the quota CLI now renders a free/local-first
  cost section (free tokens/requests vs paid tokens/requests + an estimated $ saved
  figure) and includes the same `costSummary` in `--json` output, mirroring the
  dashboard's Quota card (assessment item #7 transparency: tokens saved / paid usage
  triggered)
- **QuotaLedger.getCostSummary()** — the ledger now exposes a shared free/paid
  classification + savings estimate (local + Gemini free tier = free; everything
  else = paid; conservative $0.0005/1K blended paid rate), window-rotated so the CLI
  summary always agrees with the status table rendered above it
- **Checkpoint CLI smoke tests** — `--checkpoint` / `--resume [id]` /
  `--checkpoint-list` option mapping is now covered in `tests/cli/execute.test.ts`
  (empty-list hint, listing with progress %, `--checkpoint-list` routing, resume-id
  round-trip, and the four `checkpointOptions()` flag combinations)

### Changed

- `src/cli/execute.ts` — checkpoint flag mapping extracted into an exported pure
  helper `checkpointOptions(checkpoint, resume)` so the option wiring is
  unit-testable and the `checkpoint: options.checkpoint || !!options.resume`
  semantics are preserved exactly (plain runs never checkpoint by default)
- `src/agents/test-module.ts` — sandboxed test runs now **skip `npm install` when
  the project declares zero dependencies**, fixing a flaky CI test caused by a
  network-bound npm install on dep-less temp projects; sandboxing is faster and
  hermetic for offline/CI environments

### Tests

- `tests/learning/quota-ledger.test.ts` — 3 new `getCostSummary()` tests (free/paid
  classification + savings math, zeroed empty ledger, unknown providers = paid)
- `tests/cli/execute.test.ts` — 5 new checkpoint CLI smoke tests

---

## [1.45.1] - 2026-08-02

### Fixed

- **`--checkpoint` no longer silently resumes a stale checkpoint** — plain
  `buff execute "<goal>" --checkpoint` (no resume intent) previously loaded any
  prior checkpoint at the auto id (goal + cwd) — including a previously
  **completed** run — and re-entered it, skipping every task and reporting
  success without doing work. The checkpoint LOAD is now gated strictly on
  resume intent (`--resume` / `resumeRequested` / explicit id); `--checkpoint`
  always starts fresh while still saving forward. A resumed run (including
  direct API callers that only set `resumeRequested`) keeps checkpointing
  forward. Regression test covers the stale-checkpoint case

## [1.45.0] - 2026-08-02

### Added

- **Checkpoint / resume** — `buff execute "<goal>" --checkpoint` saves a
  resume-able snapshot after every task batch (task plan with per-step
  statuses, artifacts, file changes, metadata) to `~/.buff/memory/checkpoints/`
  (honors `BUFF_MEMORY_DIR`). A crash / quota kill / token expiry mid-pipeline
  no longer restarts the whole plan: `buff execute "<goal>" --resume [id]`
  rehydrates the vault and continues from the first pending step, skipping
  completed steps and the planner entirely (assessment item #6: continuity
  across models). Bare `--resume` auto-finds the id for the current goal + cwd;
  `--checkpoint-list` shows saved checkpoints
- **Quota cost-transparency card** — the dashboard's 📒 Quota Ledger panel now
  splits tracked usage into **free/local tokens** (local + Gemini free tier —
  $0) vs **paid tokens** (actual spend triggered), shows the free-tier share of
  usage, and an **estimated $ saved** figure (free tokens × conservative paid
  rate). Assessment item #7: show users which models were used and how
  free/local-first routing saved money

### Tests

- New `tests/agents/checkpoint-store.test.ts` (save/load round-trip,
  deterministic auto id, listing, corrupt-file handling, function-field
  stripping)
- Orchestrator checkpoint-resume regression tests (resume skips completed steps
  + planner; fresh pipeline on missing id)

## [1.44.0] - 2026-08-02

### Added

- **Central quota ledger** — `QuotaLedger` tracks tokens/requests per provider ×
  model with calendar-aware reset windows (daily/hourly free-tier limits).
  Exhausted providers are **parked** (excluded from Auto routing) until the
  window rolls — automatic re-enable at the exact reset boundary, no timers.
  Every LLM call write-throughs usage via `CostTracker.recordCall`. Persists to
  `~/.buff/memory/quota-ledger.json` (honors `BUFF_MEMORY_DIR`); all writes
  best-effort
- **Predictive quota-aware routing** — Auto routing sinks quota-parked providers
  below healthy candidates BEFORE a call is made (previously only reactive
  failover). Wired into the AutoModelRouter, chat, and orchestrator
- **Free/local-first gate** — `routing.allowPaid: false` excludes PAID providers
  for non-complex tasks (trivial/simple/moderate) so free/local models win unless
  complexity demands otherwise; complex/critical tasks may still use paid
  high-capacity models. Falls back safely if the gate would eliminate everyone
- **Per-subtask complexity labels** — the Planner now emits a `complexity` label
  per `TaskStep` (trivial → critical); the orchestrator labels any step lacking
  a valid label and threads the label into routing as `complexityHint`, so each
  subtask routes by its OWN complexity, not the whole goal's
- **`buff model quota` CLI** — inspect the ledger (tokens/requests per
  provider × model, resets in, parked state), `--json` for scripting, and
  `reset` to clear
- **`routing.quota` config** — per-provider `tokensPerWindow` /
  `requestsPerWindow` / `windowMs` limits via `buff config set routing.quota.<provider>.*`
- **Mid-session failover persistence** — rate-limit failures now park the
  provider in the central ledger, so the exclusion survives across chat sessions
  (auth failures stay permanent, never re-enabled by a window roll)
- **Dashboard quota card + DAG complexity badges** — the web dashboard's
  🤖 Routing panel shows live quota status; DAG nodes display their complexity
  label
- **Assessment-gap roadmap** — [ASSESSMENT_OPPORTUNITIES.md](ASSESSMENT_OPPORTUNITIES.md)
  maps the coding-assessment recommendations (cost-efficient tier routing,
  quota ledger, graceful failover, cost transparency) to implementation status

### Tests

- New `tests/learning/quota-ledger.test.ts` (usage recording, window rotation
  auto re-enable, exhaustion parking, `getBestAvailable` never-empty, persistence)
- New `tests/learning/quota-routing.test.ts` (complexityHint, allowPaid gate,
  quota-sink ranking)
- Orchestrator regression test for per-step complexity labeling

## [1.43.0] - 2026-08-02

### Added

- **Startup progress feedback (first-run UX)** — `agent-nuvira` now shows a live
  spinner with phase text while starting up (`⚙️ Loading plugins…`,
  `⚙️ Initializing history & search…`, `📦 Building semantic search index…`) so a
  cold start never looks like a silent hang. Ora auto-suppresses when stdout is
  not a TTY, keeping piped output clean
- **Model-picker loading progress** — provider availability checks now show a
  spinner, print per-provider loading progress, and each `isAvailable()` /
  `listModels()` call is wrapped in a timeout so one hanging provider can't
  stall first run or `model switch`
- **Live model-list cache (60s TTL)** — `model-validator.ts` caches
  `listModels()` results for 60 seconds (was: re-fetched on every auto-routed
  chat message, a real per-message latency cost). Failures are not cached.
  `buff config set providers.*` clears the cache immediately so a new
  key/model/baseURL takes effect right away

### Fixed

- **Auto-mode failover on token expiry** — when Auto routing picked a provider
  whose API key/token expires mid-session (Gemini token-limit errors, OpenRouter
  401s, quota exhaustion), chat used to get stuck re-failing on the same
  provider. Now the session **remembers failed providers** and Auto routing
  routes around them: auth failures (expired key) exclude the provider for the
  whole session, rate-limit failures for a 120s cooldown (aligned with the
  circuit breaker), and 5xx/network errors flow through the circuit breaker
  only. In-cooldown providers are deprioritized by router scoring, the final
  fallback always prefers a non-failed provider, and the failover is
  crash-proof — a throwing re-route can't kill the interactive loop
- **Broader rate-limit classification** — `classifyFallbackError` (and the chat
  error handler) now recognize `token limit`, `resource has been exhausted`,
  and `insufficient_quota`, so these are labeled "Rate limit" (retryable)
  instead of falling through as unknown

---

## [1.42.1] - 2026-08-02

### Fixed

- **Pre-existing CI test failures (hermetic + cross-platform)** — fixed the five
  environment-dependent test failures that had kept `test-linux.yml` red since
  v1.41.1: `model.test.ts` seeds API keys so the explain JSON has a non-empty
  fallback chain in a fresh-HOME CI; `safe-execution-layer.test.ts` uses a
  hermetic `SandboxManager` stub (Docker-enabled runners);
  `inspect-module.test.ts` skips the unreadable-dir assertion on Windows (no
  POSIX chmod read bits); `history.test.ts` uses `TMPDIR || TEMP || '/tmp'`
  instead of a hardcoded `/tmp`; and the dashboard server tests pin
  `BUFF_MEMORY_DIR` before module import so the suite stays hermetic even when a
  developer exports it in their shell
- **Dashboard memory-dir consistency** — the dashboard server now honors
  `BUFF_MEMORY_DIR` (`MEMORY_DIR = BUFF_MEMORY_DIR || ~/.buff/memory`), so the
  bandit card and the promotion-gate card always read from the same directory as
  the CLI and the learning router

### Added

- **Promotion-gate verdict in the dashboard** — the 🤖 Routing panel now renders a
  live 🎖️ Promotion Gate card (ruflo ADR-150 mirror): promoted / not-promoted /
  collecting-data verdict, sufficiency progress (diverged vs. min decisions), and
  the three criteria — quality >+2%, cost <+1%, latency <+5% — with pass/fail
  chips. Unmeasured latency honestly renders a `○ neutral` chip instead of a
  misleading green pass. Backed by `readPromotionData()` on `/api/routing`
  (also wired into `/api/all` and SSE)
- **CI routing regression guard** — `test-linux.yml` runs the four learning-router
  test files (bandit / promotion gate / auto-router / tier-0) in a dedicated step
  before the full suite, so routing regressions fail fast with a clearly-labeled
  step
- **Dashboard component tests** — first frontend unit tests: the dashboard's own
  vitest + jsdom + Testing Library setup (`src/web-dashboard/vitest.config.ts`,
  `npm test`) covering `PromotionGateSection` rendering states (promoted,
  collecting-data, not-promoted, neutral latency, hidden-empty, absent data), wired
  into CI as a dedicated `Dashboard component tests` step

---

## [1.42.0] - 2026-08-02

### Added

- **Uncertainty-driven escalation (ruflo model-router mirror)** — when the
  bandit's winner has almost no accumulated samples (α+β <
  `routing.escalationMinSamples`, default 8), Auto routing **escalates to the
  next-ranked provider that HAS learned data** instead of committing to a
  cold-start guess — a strictly better cold-start policy. A sanity bound
  (`ESCALATION_WIN_RATE_FLOOR = 0.55`) ensures a learned-but-failing provider
  can never steal routing from a strong cold-start winner. Decisions record a
  `banditEscalation` flag + `| escalated: winner unlearned` explanation marker
- **Per-modelId bandit priors (ruflo ADR-149 mirror)** — the learning router now
  learns per **concrete model**, not just per provider: `modelPriors[complexity]
  [modelId] = Beta(α, β)` shadow state updated alongside provider priors
  (`recordModelOutcome`), so `llama-3.3-70b-versatile` ≠ `openai/gpt-oss-20b`
  within the SAME provider. `resolveModelWithLearning()` keeps the configured
  pin on cold start (deterministic) and picks the best Thompson-sampled
  LEARNED model once data accumulates — the model choice learns too. State file
  bumped to v2 (`router-bandit.json`), CLI shows per-model α/β heatmap
- **Promotion gate / A/B validation (ruflo router-parallel mirror)** — new
  `src/learning/router-promotion.ts` answers "is the bandit actually better than
  the heuristic?" on real trajectories. Every auto-routed task records BOTH the
  deterministic pick and the bandit pick (keyed by agentType+task, bounded at
  64 pending), and `recordOutcome()` finalizes it with the real result to
  `~/.buff/memory/router-promotion.jsonl`. `evaluate()` applies ruflo's THREE
  promotion criteria — quality ↑ > 2%, cost regression < 1%, p95 latency
  regression < 5% — over diverged decisions only, with `sufficient`/`promoted`
  verdicts. Config: `routing.promotionMinDecisions` (default 20). `buff model
  bandit` now renders the gate (human + `--json`); `bandit reset` clears the
  trajectory too

---

## [1.41.2] - 2026-08-01

### Fixed
- **Auto routing only uses working models — no more 401/404 surprises**
  - Picking **Auto** in the model picker now enables per-message routing instead of handing a literal `'auto'` to `resolveProvider()` (which silently fell back to an unconfigured default like OpenRouter with no key → 401)
  - Auto routing **only scores providers that have credentials** configured (`getDefaultAllowedProviders()` filters by `hasRequiredCredentials`), so it never picks a provider that would 401
  - `resolveProvider('auto')` now falls back to the **first provider with credentials** (groq → nim → gemini → openrouter → local) instead of the unconfigured default
- **Model health validation** — Auto routing validates the resolved model against the provider's **live model list** and repairs stale/deprecated/placeholder pins (e.g. Gemini's retired `gemini-2.0-flash-exp` → 404, NIM's `new-nim-model`) to a curated known-working default before sending a request
- **Runtime failover** — if a routed provider still fails at generate time (quota exhausted 429, deprecated model 404 — Gemini's model list can list models a key can't actually use), chat **automatically walks the ranked candidates and answers from the first working provider** instead of crashing; the orchestrator and `benchmark --routing` apply the same model-health validation

### Added
- `src/inference/model-validator.ts` — live-list model validation + curated per-provider working defaults (`resolveWorkingModel`)
- Regression tests: `tests/inference/model-validator.test.ts` (12 tests), `tests/cli/router.test.ts` (4 tests), deterministic auto-routing tests in `tests/cli/chat.test.ts`, credential-filtering tests in `tests/learning/auto-router.test.ts`

> **Note:** this release bundles the previously-unreleased routing work
> (learning bandit, tier-0 deterministic routing, routing rules/hard
> constraints, dashboard routing panels, per-provider model drill-down, VS Code
> extension updates) — everything that shipped in this published tarball.

---

## [1.41.0] - 2026-07-31

### Added
- **`buff model list --json`** — structured JSON output (`{ active, providers: [...] }`)
  for provider/status/availability listing, powering reliable parsing in the VS Code
  extension's model & provider switcher
- **`buff models --json`** — machine-readable per-provider model listing
  (`{ models: [{ provider, providerType, name, id, owner, description }] }`) with pure
  JSON on stdout (no spinner/log decoration). `providerType` is included so consumers can
  switch directly with `buff model switch <provider>/<model>`. Honors `-p` and `-s` filters

### Changed
- `src/cli/models.ts` — new `-j/--json` flag; human output (ora spinner, logger lines,
  results table) is gated behind non-JSON mode so scripting stays parseable
- `src/cli/model.ts` — `model list` gained `-j/--json` output

### Tests
- `tests/cli/models.test.ts` (7 tests) — JSON shape, `providerType` presence, `-p`/`-s`
  filters, pure-JSON stdout, empty-list and fetch-error fallbacks

---

## [1.40.0] - 2026-07-31

### Added
- **`buff eval --routing`** — evaluates the exact provider/model pairs the Auto router
  picks for each eval task (via `getAutoRouter().resolve` with runtime stats), dedupes
  distinct picks with task counts, records each decision to the routing-history store,
  runs the full Agent Evaluation framework against every pick (skipping unavailable
  providers), then ranks the picks by composite score with a 🏆 best-pick summary —
  closing the routing → **reliability** loop (not just response quality). Warns when
  `--provider`/`--model`/`--format` are ignored in routing mode
- **Routing History Store** — `src/learning/routing-history.ts`: records every Auto
  router decision (`recordRoutingDecision`) to `~/.buff/memory/routing-history.json`
  (capped at 500, best-effort writes, `BUFF_MEMORY_DIR` override for tests). Query with
  `getRoutingHistory()` / `getRoutingUsageStats()` / `clearRoutingHistory()`. Sources:
  chat (per message), orchestrator (per auto-routed task), explain (human + `--json`
  snapshots), benchmark `--routing`, eval `--routing`
- **Dashboard Routing Usage + Audit Trail** — the 🤖 Routing panel now shows:
  - **Routing Usage — actual picks over time** — totals, last-24h, per-provider pick
    counts, per-source breakdown (chat/orchestrator/explain/benchmark/eval), and most-
    picked models
  - **Audit Trail — routing decision timeline** — the 30 most recent decisions with
    source badge, winner provider/model, complexity, task, and relative time
  Backed by `readRoutingUsage()` + `readRoutingHistory()` in the `/api/routing` payload
  (also wired into `/api/all` and SSE)

### Changed
- `eval.ts` — `--routing` flag + `runEvalRouting()` (mirrors `runRoutingBenchmark`)
- `chat.ts` / `orchestrator.ts` / `benchmark.ts` / `model.ts` — record routing decisions
  to the history store (sources: chat, orchestrator, benchmark, explain)
- Dashboard frontend — `RoutingInsightsPanel` usage + audit sections; `types.ts` extended
  with `RoutingUsage` / `RoutingHistoryEntry`
- Docs — README (`eval --routing` example), User_Manual (Auto Model Routing §), Product_Guide
  (feature inventory rows 73–75 + Key Upgrades rows)

### Tests
- `tests/learning/routing-history.test.ts` (10 tests) — record/get/usage aggregation,
  clear, 500-entry cap, corruption resilience
- `tests/cli/eval.test.ts` (5 tests) — routing mode dispatch, pick dedupe, per-pick suite
  run, comparison table + best pick, unavailable-provider skip, history recording
- `tests/web-dashboard/server.test.ts` — `/api/routing` usage aggregation + audit-timeline
  ordering + missing-file grace (3 new tests)

---

## [1.39.3] - 2026-07-31

### Added
- **`buff benchmark --routing`** — benchmarks the exact provider/model pairs the Auto router
  picks for each benchmark task (via `getAutoRouter().resolve` with runtime stats), dedupes
  distinct picks with task counts, runs the filtered suite against every pick (skipping
  unavailable providers), then ranks them by measured quality with a 🏆 best-pick summary.
  Closes the routing → quality loop: results feed the router's runtime stats. Warns when
  `--provider`/`--model`/`--format` are ignored in routing mode
- **`buff model explain --json`** — machine-readable explain output for scripting and CI.
  Single task → one decision object; no task → all 5 sample complexities. Payload includes
  task, agentType, complexity, taskType, weights, winner, ranked providers (score, reason,
  dimensions, cooldown), fallback chain, and effective per-provider pricing with override flags
- **Explain command now matches production routing** — `renderRoutingDecision` resolves with
  `useRuntimeStats: true` (same as chat/orchestrator) so the displayed decision reflects
  benchmark- and agent-stats-adjusted scores
- **Tests (6)** — `tests/cli/model.test.ts`: detailed render, 5-complexity walk, single-task
  JSON, sample-array JSON, `--agent` routing, ranked best-first ordering

### Changed
- `benchmark.ts` — `--routing` flag + `runRoutingBenchmark()`; `BenchmarkRun` type import
- `model.ts` — `-j, --json` option + `buildExplainJSON()`
- Docs — README (explain `--json` + `benchmark --routing` examples), User_Manual (Auto Model
  Routing § + benchmark options), Product_Guide Key Upgrades rows

---

## [1.39.2] - 2026-07-31

### Added
- **Configurable routing pricing** — `buff config set pricing.<provider>.inputPer1K|outputPer1K`
  overrides any provider's per-1K-token cost used by the Auto router's cost dimension
  (deep-merged per provider so both fields survive sequential sets; free tiers default to $0)
- **`buff model explain [task]`** — transparency command showing why Auto routing picks a
  provider/model: detected complexity, task type, dimension weight bars, ranked provider table
  with reasons, winner, and fallback chain. With no task it walks all 5 complexity levels;
  `--agent <type>` routes for a specific agent. Powered by the new `weights` field on
  `AutoRouteResult`
- **Dashboard Routing Insights** — new `GET /api/routing` endpoint + 🤖 Routing dashboard panel
  (nav item, `/routing` route): per-provider benchmark quality (avg quality, pass rate, cost),
  best model per agent type from agent stats, and Auto-router preference across complexity
  levels. Wired into `/api/all` and SSE init/refresh payloads

### Changed
- `auto-router.ts` — `getProviderPricing()` resolves config override ?? built-in table;
  `estimateCallCostUsd` / `computeCostScore` accept optional pricing overrides
- `config/manager.ts` — `pricing` config section loaded, deep-merged, and saved
- `config.ts` — `buff config set pricing.*` + `buff config list` pricing section
- `model.ts` — `explain` subcommand registered
- `web-dashboard/server.ts` + React frontend — routing insights API, `RoutingInsightsPanel`,
  rebuilt dashboard assets
- Docs — README, User_Manual (Auto Model Routing §), Product_Guide Key Upgrades rows

### Tests
- config manager: pricing default/load/merge/save + sequential-save regression (5 tests)
- auto-router: pricing overrides (5) + result weights (2)
- dashboard server: `/api/routing` empty/fixture/malformed + `/api/all` routing field (4 tests)

---

## [1.39.1] - 2026-07-31

### Added
- **Real provider pricing in Auto routing** — `PROVIDER_PRICING_PER_1K` table with actual
  per-1K-token list prices (input/output) per provider; the cost dimension score is now derived
  from real pricing via `estimateCallCostUsd()` / `computeCostScore()` instead of static profiles.
  Free tiers (local, Gemini) score 1.0; OpenRouter priced at GPT-4o-class pass-through. Opt out
  per call with `useRealPricing: false`.
- **Runtime-stats-driven routing** — `useRuntimeStats` option blends real benchmark quality
  scores into the reasoning dimension (70% static / 30% measured) and boosts reliability + reasoning
  for the proven best model of the agent type (from agent-stats). Now enabled by default in
  `buff chat` (`routeMessageAuto`) and the orchestrator's per-task `createAutoRoutedLLM()`.

### Changed
- `auto-router.ts` — pricing table + runtime adjustment pipeline (`loadRuntimeAdjustments`,
  `adjustCapabilitiesForRuntime`)
- `chat.ts` / `orchestrator.ts` — `useRuntimeStats: true` wired into production routing calls
- `Product_Guide.md` — feature inventory row 72 + Key Upgrades entry for Auto Model Routing
- `website/index.html` — 3 new feature cards (Auto Model Routing, Real Provider Pricing,
  Benchmark-Driven Learning); providers card mentions Auto

### Tests
- `tests/learning/auto-router.test.ts` — new pricing suite (7 tests) + runtime-stats suite
  (4 tests), trivial-task expectation updated for real pricing (Gemini free tier wins)

---

## [1.39.0] - 2026-07-31

### Added
- **Auto Model Routing (`AutoModelRouter`)** — "Use the right model for the right task."
  A first-class `auto` model selection option that routes every task to the optimal
  provider/model based on **complexity, cost, latency, privacy, and reliability**:
  - **5-dimension scoring engine** — per-provider capability profiles (reasoning, speed,
    cost, privacy, reliability) weighted by detected task complexity (trivial → cost+speed
    dominate; critical → reasoning+reliability dominate)
  - **Preference modes** — balanced, `performance-first`, `cost-first`, `privacy-first`
    (routes private tasks to the local provider)
  - **Circuit-breaker awareness** — providers in cooldown are deprioritized (excluded unless
    all are in cooldown); fallback chains keep the pipeline running
  - **`buff model switch auto`** — selectable as option 1 in the model picker or via CLI;
    `buff chat` routes every message, `buff execute "<goal>" -m auto` / `--auto-route` routes
    each agent task independently, explicit `--model` always wins
  - **Exports** — `AutoModelRouter`, `getAutoRouter`, `resetAutoRouter`, `isAutoModel`,
    `isAutoProvider`, `computeWeights`, `scoreProvider` from the package index
- **Tests (55)** — `tests/learning/auto-router.test.ts` (44 tests: weights, scoring,
  complexity routing, circuit-breaker, fallback chains, model resolution, singleton) +
  `tests/cli/model-picker.test.ts` updated for the Auto option index shift (12 tests)

### Changed
- `model-picker.ts` — "Auto — Agent decides" is now option 1; model choices shift to 2+
- `chat.ts` — per-message auto routing; `/model` and error-recovery picker selections of Auto
  re-enable auto mode (with inline re-resolution so the retried message uses the routed provider)
- `orchestrator.ts` — per-task `createAutoRoutedLLM()`; `--auto-route` now uses the new engine
  instead of the legacy static agent-model map
- `execute.ts` — new `--auto-route` flag
- `README.md` + `User_Manual.md` — Auto model routing feature bullets, examples, and usage guide

---

## [1.38.1] - 2026-07-31

### Added
- **Documentation: dependency installer** — README feature bullet and User_Manual §7.9
  "Automatic Dependency Installation" (manifest detection, tool-bootstrap table, retry,
  command-based fallback, `autoInstallTools:false` opt-out, telemetry)
- **Runner tool-install tests (20)** — `installTool()` bootstrap paths for npm (no-reinstall,
  Node bootstrap, failure propagation, not-on-PATH), yarn/pnpm, pip (ensurepip, Python-first,
  failure), brew, bundler (gem/Ruby-first/failure), cargo (rustup), go (darwin/winget), dart
  (brew/apt/winget), and unknown-tool error — with `process.platform` override/restore
- **Product_Guide §3.1 rows 70–71 + §7.9 Phase 11** — Cross-Platform Execution & Dependency
  Automation feature inventory and roadmap table
- **Website feature card** — "Auto Dependency Install" added to the features grid (9 cards)

---

## [1.38.0] - 2026-07-31

### Added
- **Cross-platform dependency installer (Runner)** — `RunnerAgent` now auto-installs missing
  project dependencies and bootstrap-installs missing package managers:
  - **11 manifest types detected** — `package.json`/`pnpm-lock.yaml`/`yarn.lock` (lockfiles win),
    `requirements.txt`, `pyproject.toml`, `setup.py`, `Gemfile`, `Cargo.toml`, `go.mod`,
    `composer.json`, `pubspec.yaml`
  - **Tool bootstrapping on all platforms** — npm via brew/apt/dnf/yum/NodeSource/winget/choco/MSI;
    pip via `ensurepip` + Python install; Homebrew via official `NONINTERACTIVE=1` script;
    bundler via gem + Ruby; cargo via rustup; go via brew/apt/winget; composer via getcomposer.org
    into user-writable `$HOME/.local/bin` (no sudo, quoted, `USERPROFILE` fallback); dart via
    Homebrew / Google apt repo / winget
  - **Command-based tool detection** — when no manifest exists, missing interpreters referenced by
    the failing command (`python3`, `node`, `go`, `cargo`, etc.) are installed automatically
  - **Telemetry** — `dependencyInstallTool` / `dependencyInstallToolInstalled` on `RunResult`,
    feeding the eval framework's dependency-install success metric
- **Dashboard: Deps Installed stat** — Agent Evaluation section now shows dependency-install
  success rate alongside tests / composite / recovery / rollbacks; stat grid switched to
  `auto-fit` so both the 4-card benchmark and 5-card eval sections lay out evenly
- **Runner tests** — composer install paths ($HOME/.local/bin, PHP bootstrap, PHP-failure
  short-circuit), interpreter→tool mapping, and failed-command auto-install flow

---

## [1.37.1] - 2026-10-05

### Fixed
- **Provider crash in `buff plan`** — Running `agent-nuvira plan` with an unconfigured default
  provider (e.g., OpenRouter with no API key) crashed with a raw 401 JSON error. Now:
  - Auto-fallback via `getProviderFallback.callWithFallback()` for retryable errors
  - Interactive model picker when provider is unavailable or auth fails
  - Helpful error messages with actionable steps (set API key, run `buff model switch`, use local)
  - Correct env var names per provider (e.g., `nim` → `NVIDIA_NIM_API_KEY`)
- **Provider crash in `buff skill compile`** — Added auto-fallback to `callLLM` in `compileSkills()`
  so skill compilation doesn't crash with raw provider errors
- **Provider crash in `buff learn patterns --extract`** — Added auto-fallback to `callLLM` in
  `showPatterns()` so pattern extraction handles provider failures gracefully

### Security
- `plan.ts` now detects auth errors (401/403) and shows environment variable configuration hints
  instead of exposing raw API error JSON to the user

---

## [1.37.0] - 2026-10-05

### Added
- **Branch Automation Hooks (Pillar A4)** — Automated branch workflow with 4 trigger sources:
  - **Issue → Branch** — Auto-creates `feat/PROJ-123-description` branches from issue keys with
    configurable branch type (feat/fix/chore) and sanitized naming
  - **PR Label → Update** — Auto-commits changes and pushes to PR branch when labels like `wip`
    or `needs-work` are detected
  - **File Watch → Commit** — Background file-watch script with configurable polling interval
    (default: 60s) that auto-commits with conventional commit messages on change detection
  - **CI Status → Fix** — Analyzes CI failures from git context (recent commits, changed files)
    with LLM-powered diagnosis and actionable fix suggestions
- **Git hooks installer** — Installable post-checkout and pre-commit hooks that detect issue-based
  branches and enforce conventional commit format; hooks are self-identifying (contain 'Agent-Nuvira'
  marker) for clean removal
- **Conventional commit generator** — Rule-based commit type detection from changed files
  (test→test, docs→docs, fix→fix, feat→feat) with LLM fallback for contextual messages
- **`--auto-branch` flag** — New CLI flag for `buff execute` enabling branch automation workflows
- **Module registry** — `branch-automation` agent type registered in ModuleRegistry

### Files
| File | Change |
|---|---|
| `src/agents/agents/branch-automation-agent.ts` | **NEW** — BranchAutomationAgent (400+ lines)
| `src/agents/agents/branch-automation-hooks.ts` | **NEW** — Git hooks manager (250 lines)
| `src/agents/module-registry.ts` | **MODIFIED** — Added agent registration
| `src/cli/execute.ts` | **MODIFIED** — Added `--auto-branch` flag + `ExecuteOptions.autoBranch`

---

## [1.36.0] - 2026-10-04

### Added
- **Real-Time Token Streaming in AgentPanel (Pillar B2)** — Live streaming output with
  typewriter effect in the agent progress panel:
  - **Streaming display** — Streaming container with blinking cursor, animated live dot,
    and monospace output area appears below phase indicators when tasks run
  - **Real-time chunk emission** — `CLIManager` now emits `onStreamChunk` callbacks for
    every stdout data event, enabling token-by-token display
  - **Code block detection** — Chunks containing ``` markers are styled with specialized
    token coloring (`.token-code`, `.token-keyword`, `.token-string`, `.token-comment`,
    `.token-error`, `.token-emphasis`)
  - **Auto-scroll** — Output area auto-scrolls to show latest tokens as they arrive
  - **Completed indicator** — After streaming ends, the header label changes from
    "streaming" to "completed" in green, and content stays visible until next task
  - **Clean lifecycle** — `startStreaming()` before each task, `completeStreaming()`
    after both success and error paths, `clearAll()` resets streaming state

### Changed
- `vscode-extension/src/cliManager.ts` — Added `onStreamChunk` callback, emits chunks
  with code block detection on every stdout data event
- `vscode-extension/src/agentPanel.ts` — Added streaming container HTML/CSS/JS,
  `startStreaming()`, `updateStreaming()`, `completeStreaming()` methods
- `vscode-extension/src/commands.ts` — Wired streaming lifecycle: CLI → panel → webview

---

## [1.35.1] - 2026-10-04

### Fixed
- **Missing runtime dependency** — Moved `typescript` from `devDependencies` to `dependencies`
  in `package.json`. The `ts-adapter.ts` and `transform.ts` modules import the TypeScript
  Compiler API at runtime (`import * as ts from 'typescript'`), but it was only listed as a
  devDependency. When installed globally via `npm install -g`, devDependencies are skipped,
  causing `ERR_MODULE_NOT_FOUND`. Now correctly installed as a regular dependency.

### Dependency Audit
- Cross-referenced all `src/` imports against `package.json` — only `typescript` was
  misclassified; all other packages (commander, ora, inquirer, chalk, @huggingface/transformers)
  were correctly categorized.

---

## [1.35.0] - 2026-10-04

### Added
- **Chat Panel v2 — DAG Pipeline Visualization (Pillar B6)** — Live multi-agent pipeline
  visualization inline in chat messages for slash commands:
  - **SVG DAG renderer** — Standalone `dagRenderer.ts` ported from React DAGView to vanilla JS;
    renders colored agent nodes with icons, status badges, edge curves, step details table, and legend
  - **16 agent types** — Planned, gatherers, writers, reviewers, testers, debuggers, security, git,
    packages, releases, triage, PR review, GitLab, skills, MCP with distinct icons/colors
  - **Real-time pipeline detection** — Parses CLI output for agent markers (📋 planner, ✏️ writer,
    👁️ reviewer, 🧪 tester, ✅/❌ complete/fail) and builds DAG state incrementally
  - **Live indicator** — Animated glow for running nodes, pulsing LIVE badge, status summary bar
  - **Fade-in animations** — Smooth entry for pipeline container and node updates
  - **Empty state** — Helpful placeholder when no pipeline is active, with command suggestions
- **Issue Triage Engine (Pillar A3)** — Automated issue classification, prioritization, and labeling
  across GitHub and GitLab:
  - **LLM-based classification** — Classifies issues as bug, feature, question, docs, or chore using
    a structured JSON prompt with configurable temperature (0.2) and explicit classification guidelines
  - **Priority assignment** — Assigns critical, high, medium, or low priority with emoji indicators
  - **Difficulty estimation** — Estimates issue complexity: easy, medium, or hard
  - **Label management** — Suggests and auto-applies labels (creates missing labels on GitHub repos)
  - **Triage comments** — Posts structured markdown table comments with classification, priority,
    difficulty, reasoning, and suggested action
  - **Git blame expertise heuristic** — Infers suggested assignee from git blame on files mentioned
    in the issue body (extracts file paths from backtick references)
  - **Multiple operations**: `triage-all` (all unlabeled), `triage-specific` (#N), `classify` (#N),
    `list-unlabeled`
  - **Auto-source detection** — Detects GitHub vs GitLab from keywords, tokens, or git remote;
    auto mode tries both platforms with clear error messages
  - **Robust LLM response parsing** — Supports valid JSON, markdown-wrapped code blocks, and
    malformed responses with validation fallbacks for all classification fields
- **Module registration** — `issue-triage` agent type registered in ModuleRegistry with metadata

### Files
| File | Change |
|---|---|
| `src/agents/agents/issue-triage-agent.ts` | **NEW** — IssueTriageAgent (550 lines)
| `src/agents/module-registry.ts` | **MODIFIED** — Added agent registration
| `tests/agents/issue-triage-agent.test.ts` | **NEW** — 46 unit tests

---

## [1.34.0] - 2026-10-03

### Added
- **Code Lens Actions (Pillar B5)** — Clickable `$(sparkle) AI: <name>` lenses above functions and classes
  in VS Code. Click opens a quick pick menu with 4 agent actions:
  - **Test** — Generate unit tests for the function/class
  - **Review** — Review for bugs, security, and style issues
  - **Explain** — Explain the code in detail
  - **Quick Fix** — Fix issues in the code
- **Language support** — TypeScript, JavaScript, Python, Go, Rust, Java — with regex-based declaration
  detection and brace-counting body range extraction
- **Quick pick UX** — Single lens per declaration, menu-based action selection with descriptions
- **Error handling** — Try/catch wrapper with user-facing notification on CLI failures

### Changed
- `vscode-extension/src/extension.ts` — Registered CodeLensProvider, single `lensCommandId` handler
- `vscode-extension/package.json` — No menu additions (all interactions via CodeLens click)

### Files
| File | Change |
|---|---|
| `vscode-extension/src/codeLensProvider.ts` | **NEW** — CodeLensProvider with quick pick menu (1,243 lines)

---

## [1.33.0] - 2026-10-02

### Added
- **VS Code Chat Panel (Pillar B1)** — Multi-turn AI chat panel directly in VS Code:
  - Streaming responses via `agent-nuvira chat --stream --no-color` CLI subprocess
  - 6 slash commands: `/fix`, `/review`, `/test`, `/explain`, `/workflow`, `/help`
  - File context: "Add File" button attaches active editor content as context
  - Code block rendering with "Apply to File" button
  - Conversation history sidebar with session management (new, switch, delete)
  - Sessions persisted across restarts via `workspaceState`
  - Slash command autocomplete with arrow key navigation
  - Welcome screen with quick command buttons
  - Keybinding: `Ctrl+Shift+A C` (mac: `Cmd+Shift+A C`)
- **Diagnostic → AI Fix (Pillar B3)** — "Fix with Agent-Nuvira" in VS Code lightbulb menu:
  - Detects diagnostics (red squiggles) and groups by line
  - Captures error message, affected code range, and 3-line surrounding context
  - Sends targeted fix prompt to CLI
  - Shows diff preview with Apply/Reject workflow
  - Falls back to showing raw output as new editor document
  - Retry on failure with error notification

### Changed
- `vscode-extension/src/extension.ts` — Registered ChatPanel, DiagnosticFixProvider, CodeLensProvider
- `vscode-extension/package.json` — Added `openChat` command, `Ctrl+Shift+A C` keybinding, chat activity bar view
- Status bar now opens Chat Panel instead of old Agent Panel

### Files
| File | Change |
|---|---|
| `vscode-extension/src/chatPanel.ts` | **NEW** — Chat webview panel controller (280 lines)
| `vscode-extension/src/chatPanel.html` | **NEW** — Chat webview HTML+CSS+JS template (520 lines)
| `vscode-extension/src/chatProvider.ts` | **NEW** — Chat history provider with workspaceState persistence (260 lines)
| `vscode-extension/src/diagnosticFixer.ts` | **NEW** — Diagnostic fix CodeActionProvider (280 lines)
| `vscode-extension/src/extension.ts` | **MODIFIED** — Registered all B1+B3 components
| `vscode-extension/package.json` | **MODIFIED** — Commands, keybindings, views

---

## [1.31.0] - 2026-09-30

### Added
- **TS Compiler API Wrapper (Phase 11)** — `src/editing/ts-adapter.ts` — Proper TypeScript Compiler API
  integration with `parseSourceFile()`, `findStructuralNodes()`, `findNodeByName()`, `findNodeAtPosition()`,
  `nodeToRange()`, `getBodyRange()`, `validateTSSyntax()` (uses `parseDiagnostics`), `replaceNodeText()`, and
  `insertAt()` — provides parser-level accuracy for all TS/JS editing operations
- **Structural Transformations (Phase 11)** — `src/editing/transform.ts` — Real code transformations:
  `renameSymbol()` (regex word-boundary replacement), `extractFunction()`, `inlineFunction()`,
  `addParameter()`, `changeSignature()`, and `detectTransformType()` NLP heuristic mapper
- **Two-Tier Editing Engine (Phase 11)** — `src/editing/edit.ts` rewritten with `tryFindNodeTS()` helper:
  all 7 operations (replaceFunctionBody, addMethodToClass, insertBefore, insertAfter, deleteNode,
  performEdit, buildStructuralContext) try the TS Compiler API first, fall back to regex — giving
  TS/JS files parser-level accuracy while supporting Python/Go/Rust via regex
- **Phase 11 Unit Tests** — 66 new tests across two suites:
  - `tests/editing/ts-adapter.test.ts` (40 tests) — parsing, node finding, body ranges, validation, text manipulation
  - `tests/editing/transform.test.ts` (26 tests) — all 5 transformation operations + NLP detection

### Changed
- `src/editing/edit.ts` — Replaced all `await import()` dynamic imports with clean static imports;
  replaced fragile regex-based structural analysis with TS Compiler API tier (for TS/JS) + regex fallback
  (for Python/Go/Rust)
- Marked unused imports cleanup (nodeToRange, replaceNodeText, insertAt) in transform.ts

### Tests
- 66 new Phase 11 tests — all passing ✅
- Total module tests: ts-adapter (40) + transform (26) = **66 Phase 11 tests**

---

## [1.30.0] - 2026-09-30

### Added
- **Unit tests: CredentialStore** — 357-line test suite covering constructor auto-detection, canPush/canPublish getters, collectAll() flow, setupGitCredentials() (GIT_ASKPASS, SSH agent), setupNpmAuth() (.npmrc injection), cleanup(), and module-level helper functions
- **Unit tests: PhaseExecutionEngine** — 560-line test suite covering createScope(), getNextPhase(), getProgress(), saveScope()/loadScope(), listSavedScopes()/deleteScope(), executePhase() (success/failure/exception/edge cases), executeScope() (sequential/resume/failure/credential collection)
- **Phase 10 documentation** — README roadmap table (10.1-10.4), version history (v1.29.0), Phase-Wise Feature Summary (4 new entries)
- **Product_Guide Phase 10** — Feature inventory items 66-69, section 7.8 with detailed phase table
- **Website stats update** — Architecture highlights: 10/10 Phases Complete, 10/10 Modules Extracted

### Changed
- Updated README, Product_Guide, and website to reflect Phase 10 (Autonomous Publish & Phase-Wise Execution) progress

### Tests
- 80 new tests: 357 lines credential-store, 560 lines phase-engine — all passing ✅

---

## [1.29.0] - 2026-09-30

### Added
- **CredentialStore** — Interactive Git/npm credential collection with GIT_ASKPASS setup, SSH key passphrase handling, .npmrc token injection, and auto-detection from env vars | `src/agents/credential-store.ts`
- **PhaseExecutionEngine** — Multi-goal project scope execution with save/resume across restarts | `src/agents/phase-engine.ts`
- **Publish command** — `buff publish` — 5-phase autonomous pipeline: test verification → version bump → git commit/tag/push → npm build/publish → GitHub release | `src/cli/publish.ts`
- **Phase command** — `buff phase create/execute/resume/status/list/delete` — phase-wise project execution | `src/cli/phase.ts`
- **GitAgent: git push + tag push** — `pushToRemote()`, `createAndPushTag()`, `pushTagToRemote()`, `autoPush()` with credential-aware error messages (auth failures, missing remote, network errors)
- **PackageAgent: fullPublish pipeline** — `fullPublish()` chains version bump → build → publish with auto npm auth detection from env vars or .npmrc

### Changed
- GitAgent now supports `git push`, `git tag -a`, and `git push --tags` operations — previously only local commit was supported, no remote push capability
- PackageAgent now auto-detects npm auth via `NPM_TOKEN` env var or `.npmrc` before publishing, with clear error messages for auth failures
- CLI router registered `PublishCommand` and `PhaseCommand` as new top-level commands
- All new modules exported from `src/index.ts` for SDK access

---

## [1.28.0] - 2026-09-29

### Added
- **Phase 9 documentation** — README, Product_Guide, and User_Manual updated with SafeExecutionLayer entries
- **README roadmap table** — Added Phase 9: Safe Execution Layer (9.1 SafeExecutionLayer, 9.2 VerifyModule EventBus tests)
- **README version history** — v1.26.0 (Phase 9 SafeExecutionLayer + 32 tests) and v1.27.0 (website/SVG updates)
- **README Phase-Wise Feature Summary** — SafeExecutionLayer (Phase 9) entry with 3-domain safety system description
- **Product_Guide feature inventory** — Item 65 for SafeExecutionLayer, new section 7.7 with detailed module table
- **User_Manual Phase 6 table** — SafeExecutionLayer (Phase 9) entry added with full description

### Changed
- Product_Guide.md migration summary updated from "8 modules" to "9 modules"
- All 3 docs now consistently reference Phase 9 / SafeExecutionLayer across all section types

---

## [1.27.0] - 2026-09-29

### Added
- **Website v1.26.0 updates** — Phase progress updated to "9/9" phases and modules extracted; test count to 2,207; architecture header from Phase 1→8 to Phase 1→9
- **Migration roadmap SVG** — Added Phase 9 (SafeExecutionLayer) timeline circle, card with 3 capabilities, Row 11 comparison entry, extended metrics/footer
- OG/twitter meta descriptions updated to 2,207+ tests

---

## [1.26.0] - 2026-09-29

### Added
- **SafeExecutionLayer (Phase 9)** — `DefaultSafeExecutionLayer` unifying three safety domains:
  - **File validation** — file size guard (default: 100KB), .gitignore compliance detection, AST syntax
    validation (TS/JS/Python/Go/Rust), security scan of file content via `runAllScans()`
  - **Sandboxed execution** — Docker container isolation via `SandboxManager`, resource limits
    (CPU/memory), timeout enforcement, automatic container lifecycle (create/copy/exec/destroy)
  - **Safe LLM calls** — prompt injection guardrail (blocks injection patterns before sending),
    configurable prompt length cap (default: 128K chars), exponential backoff retry (up to 3),
    circuit breaker for auth errors (401/403), response length cap
- **EventBus events (10 new)** — `SAFE_EXEC_FILE_VALIDATED`, `SAFE_EXEC_SANDBOX_STARTING`/`CREATED`/
  `COMPLETED`/`FAILED`, `SAFE_EXEC_LLM_STARTING`/`BLOCKED`/`RETRY`/`COMPLETED`/`FAILED`
- **VerifyModule EventBus tests** — 9 new tests verifying `VERIFY_STARTING`, `VERIFY_CHECK` (all 4
  check types), and `VERIFY_COMPLETED` emissions

### Changed
- Response truncation in `DefaultSafeExecutionLayer.safeLLMCall()` now uses the `maxPromptLength`
  parameter consistently for both prompt and response capping

### Tests
- SafeExecutionLayer: 23 tests — 11 validateFile (size, gitignore, syntax, security, edge cases,
  events), 10 safeLLMCall (injection, retry, auth skip, truncation, events), 2 executeInSandbox
  (Docker unavailable, events)
- VerifyModule EventBus: 9 tests — event emissions for all verification check types

---

## [1.25.0] - 2026-09-29

### Added
- **Website v1.24.0 updates** — Hero metrics updated to 2,184 tests; Architecture section upgraded from "Phase 1→6" to "Phase 1→8", highlights updated to "8/8" phases, "8/8" modules extracted, "2,184" tests
- **README.md** — Added Phase 6 (Architecture Migration) to roadmap table with 8 sub-phases (6.1–6.8); added Phase 6 section to phase-wise feature summary with 10 module entries
- **Product_Guide.md** — Added feature inventory items 57–64 for all architecture modules; added section 7.6 with detailed 8-module migration table
- **User_Manual.md** — Added Phase 6: Architecture Migration section with 10 module entries (RecoverModule through TestModule)

### Changed
- All documentation now consistently references v1.24.0 release and 2,184+ test count

---

## [1.24.0] - 2026-09-29

### Added
- **ExecuteModule tests** — 24 new unit tests for `DefaultExecuteModule`: execute() with callLLM (happy path,
  npm test validation, command inference), execute() without callLLM (fallback), inferCommand (backtick,
  `Run:` prefix, `run <file>`, npm patterns, file extension), EventBus emissions
  (`EXECUTE_STARTING`/`EXECUTE_COMPLETED`/`EXECUTE_FAILED`)
- **TestModule tests** — 27 new unit tests for `DefaultTestModule`: runTests() with callLLM (vitest,
  jest, generic output formats), runTests() without callLLM (fallback), parseTestOutput (vitest,
  jest, generic, malformed/no match), detectFramework, detectTestCommand, EventBus emissions
  (`TEST_STARTED`/`TEST_COMPLETED`/`TEST_FAILURE`)
- **Migration roadmap SVG** — Updated to Phase 1-8 with Phase 7 (Plan+EditModule) and Phase 8
  (Execute+TestModule) timeline nodes and detail cards in second row; 10-row comparison table;
  updated metrics (8/8 phases, 150+ tests, 8 modules extracted)

### Changed
- Phase 5 badge in migration-roadmap.svg corrected from "IN PROG" to "DONE"

### Tests
- Total module tests: PlanModule (41) + EditModule (34) + ExecuteModule (24) + TestModule (27) = **126 module tests**

---

## [1.23.0] - 2026-09-29

### Added
- **ExecuteModule (Phase 8)** — `DefaultExecuteModule` extracted from `RunnerAgent`: pluggable command
  execution with 5-strategy command inference (backtick, `Run:` prefix, `run <file>`, npm patterns, file
  extension), npm test validation against `package.json`, structured `ExecuteResult` output (stdout, stderr,
  exit code, duration), EventBus integration with `EXECUTE_STARTING`/`EXECUTE_COMPLETED`/`EXECUTE_FAILED` events
- **TestModule (Phase 8)** — `DefaultTestModule` extracted from `TesterAgent`: pluggable sandboxed test
  execution with temp directory creation, project file copying (excluding `node_modules`/`.git`/etc.),
  file change application, dependency installation (npm install), multi-framework test output parsing
  (vitest, jest, generic), `TEST_STARTED`/`TEST_COMPLETED`/`TEST_FAILURE` events

### Changed
- `website/index.html` — Architecture section: `6/6` → `7/8` Phases Complete, `8 Modules Designed` →
  `5/8 Modules Extracted`, test count `2,058` → `2,133`

---

## [1.22.0] - 2026-09-28

### Added
- **PlanModule (Phase 7)** — `DefaultPlanModule` extracted from `PlannerAgent`: pluggable goal decomposition
  with prompt building (goal + file tree + memory context), 3-LLM-response parsing strategies (direct JSON,
  code block, array extraction), step normalization (numeric IDs, null dependsOn, missing fields),
  fallback plan when no `callLLM` provided, and `PLAN_STARTED`/`PLAN_STEP_CREATED`/`PLAN_COMPLETED` events
- **EditModule (Phase 7)** — `DefaultEditModule` extracted from `WriterAgent`: pluggable file change
  generation with prompt building (artifacts + goal + MCP tools), `filepath:` code block parsing,
  AST syntax validation, token-budget-aware file selection (prioritizes smaller files, max 10 files,
  16K char budget), 2-attempt retry loop with rate-limit handling (skip/abort/switch-model/retry),
  mutable `currentCallLLM` for model-switch support, and `EDIT_GENERATING`/`EDIT_WRITTEN`/`EDIT_SKIPPED` events

### Tests
- **PlanModule: 41 new tests** — plan() with/without callLLM, parsePlan (direct JSON/code block/array extraction/
  malformed responses), normalizeSteps (numeric IDs, null dependsOn, missing fields, step filtering),
  EventBus emissions (3 event types, source verification)
- **EditModule: 34 new tests** — edit() happy path (multi-file, new file, unchanged file),
  empty results, LLM errors, rate-limit handling (skip/abort/switch-model), parseFileChanges
  (filepath prefix, spaces, empty blocks), addFileChange (modified/created/identical content),
  validateChanges (valid syntax, syntax warnings, non-source files), token budget, EventBus emissions

---

## [1.21.0] - 2026-09-27

### Added
- **VerifyModule (Phase 6)** — Explicit verification pipeline with `security`, `goal-alignment`, `tests`,
  and `code-quality` check types; low/medium/high strictness levels; pass/fail scoring with configurable
  pass thresholds (0.5/0.7/0.9)
- **LLM-based file classification** — `DefaultInspectModule.classifyWithLLM()` dispatches files to
  specialized agents (debugger, reviewer, tester, mcp-agent, security-agent) based on file content analysis
- **EventBus LoggerConsumer** — Handlers for `VERIFY_STARTING`, `VERIFY_CHECK`, `VERIFY_COMPLETED` events
- **Pipeline PR summary SVG** — 14-agent pipeline flow diagram for the website
- `ROADMAP_TODO.md`, `spec.md`, `spec_roadmap.md`, `spec_upgrade.md` — roadmap and spec documentation

### Changed
- `DefaultInspectModule.scanByKeywords()` — improved walkAndScore with additive keyword scoring,
  depth-5 limit, directory-name matching, symlink skipping
- `DefaultInspectModule.parseClassifyResponse()` — robust JSON extraction with markdown-wrapped,
  malformed, and empty response fallbacks
- **Architecture migration (Phase 6)** — 8-module architecture designed (InspectModule, ReportModule,
  VerifyModule, PlanModule, EditModule, ExecuteModule, TestModule, RecoverModule) with 3 extracted;
  remaining 5 modules scheduled for future phases
- `.gitignore` — added `.DS_Store` to prevent macOS metadata clutter

### Fixed
- **Followup first-letter truncation** — broken regex `\U` (treated as literal `U`, creating range `0-U`
  that stripped letters `A`–`U`) → fixed with `\u{XXXX}` + `u` flag for proper emoji stripping
- **Followup auto-continue** — removed duplicate "What next?" prompt after followup execution;
  followup result now falls through cleanly to the main goal loop
- Redundant `printOrchestrationResult` call in followup dispatch handler (already handled by `runSingleGoal`)

### Tests
- InspectModule tests expanded from **41 → 74 tests** (event spy emissions, walkAndScore scoring,
  parseClassifyResponse edge cases, inspect error handling, symlink/symlink-permission scenarios)
- VerifyModule: **28 new tests** (all 4 check types, strictness levels, dedup, scoring)

---

## [1.20.0] - 2026-09-20

### Added
- **InspectModule (Phase 5)** — codebase scanning wrapper around ContextGathererAgent with keyword
  scoring (+3 name match, +1 path match), depth limiting (5), `.buffignore` pattern support,
  binary/symlink skipping, and LLM-based file classification
- **ReportModule (Phase 4)** — Pluggable report formatters (markdown, JSON, summary, verbose) with
  EventBus integration and 4 structured event types
- **Architecture roadmap SVG** — Visual migration timeline (Phase 1→6) for the website
- **Website provider showcase SVG** — Visual logo grid of 17+ supported AI providers

### Changed
- `DefaultInspectModule` — scanByKeywords now respects `.buffignore` patterns, depth limit (5),
  and skips binary/symlink files
- `website/index.html` — added Architecture Migration section with roadmap SVG and metric highlights
- `website/styles.css` — architecture-visual section with glow hover effects, responsive grid

### Tests
- InspectModule: 41 tests covering inspect(), scanByKeywords(), walkAndScore(),
  parseClassifyResponse(), and keyword-based file discovery

---

## [1.19.0] - 2026-09-15

### Added
- **EventBus** — Structured observability system with 37 typed events and 4 built-in consumers
  (LoggerConsumer, MetricsConsumer, AuditConsumer, MetricsBufferConsumer)
- **Architecture documentation** — `ARCHITECTURE.md` with full 8-module design, extensibility hooks,
  plug-and-play agent lifecycle, and event-driven observability
- **Mermaid architecture diagrams** — `ARCHITECTURE_DIAGRAMS.md` with 5 visual diagrams:
  Module Architecture, Extensibility, Execution Flow, Event Bus Data Flow, Migration Timeline

### Changed
- `DefaultOrchestrator` — wired to EventBus; emits 14 pipeline lifecycle events
- A2A tests — increased timeout to accommodate real Orchestrator initialization
- Documentation expanded with cross-references between ARCHITECTURE.md and all strategic docs

---

## [1.18.0] - 2026-08-29

### Added
- `PRODUCT_STRATEGY.md` — comprehensive product strategy with product thesis, competitive landscape (pricing matrix, 22-dimension feature comparison, positioning map, target user match, competitive advantages), OKR framework (5 objectives, 19 key results), and risk register
- `PITCH_DECK.md` — 10-slide investor presentation outline with talking points, architecture diagrams, traction timeline, business model (3-tier + marketplace), quarterly OKR roadmap, and partnership/investment ask
- `CONTRIBUTING.md` — quick-reference contributor guide with documentation map (12 linked docs), development setup, testing commands, contribution workflow, and area-idea table
- Cross-references to strategic docs in `README.md` (Roadmap callout box) and `Product_Guide.md` (§9 Strategy & Pitch Deck + TOC entry)
- PITCH_DECK.md references to both `README.md` and `Product_Guide.md` alongside existing PRODUCT_STRATEGY.md links

### Changed
- `README.md` — added strategic docs callout box in Roadmap section, extended with PITCH_DECK.md reference
- `Product_Guide.md` — added §9 Strategy & Pitch Deck with docs table and competitive highlights, updated TOC
- `Product_Guide.md` — fixed TOC anchor link for §9 (`strategy-pitch-deck`)

---

## [1.17.0] - 2026-08-28

### Added
- `CHANGELOG.md` — comprehensive version history from v1.0.0 to v1.17.0 following Keep a Changelog format
- Comprehensive Phase-Wise Feature Summary in README, Product Guide, and User Manual
- Version History table in README (v1.0.0 through v1.17.0)
- Agent Catalog table — 13 agent roles with type, description, and version introduced
- Release Phases overview mapping version ranges to development phases

### Changed
- **Product_Guide.md** — updated to v1.16.1 → v1.17.0 alignment, Phase 4 & 5 roadmap completed, version history extended, test counts updated (1620→1830+)
- **User_Manual.md** — updated to v1.16.1 → v1.17.0 alignment, added Phase-Wise Feature Summary, updated key concepts and glossary
- **README.md** — Phase 4 marked complete (6 items), new Phase 5 added (5 items), Version History extended through v1.17.0
- Architecture diagram updated to show all 14 agent roles
- Multi-agent pipeline section enhanced with table format and interactive dev mode documentation

### Fixed
- Product_Guide.md footer version (v1.14.6 → v1.17.0)
- Agent count consistency across all docs (10+ → 15 agent roles & management)

---

## [1.16.1] - 2026-08-27

### Added
- Interactive dev mode enhancements — failure analysis with per-agent-type recovery actions
- Follow-up suggestions — LLM-powered contextual next-step recommendations after goal execution
- `/fix` command — retry last failed goal with failure context, shows post-execution analysis
- 35 new unit tests for failure analysis, follow-up suggestions, and handlePostExecution methods
- Enhanced post-execution UX with dynamic choices (continue, switch model, history, exit, retry-fix, followup)

### Changed
- `/fix` command now shows post-execution actions (consistent with `retry-fix` behavior)
- Session history tracking via shared `handlePostExecution` method
- Comprehensive README update with Phase-Wise Feature Summary, Version History, and Agent Catalog

### Fixed
- ESM module mocking in tests — replaced `vi.spyOn` with `getProviderConfig` throw strategy
- Input validation test — fixed test data that was exceeding the 3-suggestion limit in fallback logic

---

## [1.16.0] - 2026-08-26

### Added
- Comprehensive MCP README documentation with stdio and SSE transport examples
- SSE header support for MCP — Bearer auth and custom headers for remote MCP connections

### Changed
- Firecrawl integration for web search via MCP

---

## [1.15.6] - 2026-08-25

### Added
- Firecrawl integration for web search and scraping

---

## [1.15.5] - 2026-08-24

### Added
- SSE (Server-Sent Events) header support for MCP transport
- Bearer token authentication for remote MCP servers

---

## [1.15.4] - 2026-08-23

### Added
- Search/filter bar for model discovery
- Column count toggle (3/4/5 columns) for model display
- Speech provider section in model picker

---

## [1.15.3] - 2026-08-22

### Fixed
- Accessibility fix — replaced `window.open` with native `<a>` tags in SpeechProviderSection

---

## [1.15.2] - 2026-08-21

### Fixed
- Windows compatibility fixes for runner and sandbox agents

---

## [1.15.1] - 2026-08-20

### Added
- Interactive development mode — `buff execute` without a goal launches a guided loop
- Model picker — interactive provider/model selection at dev mode start
- Session tracking — full goal history within a development session
- `/save <name>` — save development session state to disk
- `/resume <name>` — restore a previously saved session with full history
- `/suggest` — search past trajectories for similar goals

---

## [1.15.0] - 2026-08-19

### Added
- npm publishing — `npx agent-nuvira` / `npx buff` live on npm (1.3 MB package)
- Zero-setup onboarding for new users

---

## [1.14.6] - 2026-07-28

### Added
- Skill Compiler — auto-extracts reusable patterns from successful trajectories into parameterized skill scripts
- Context-Window Memory Pruner — 5 strategies (metadata strip, file collapse, conversation truncation, artifact summarize, aggressive fallback)
- Context-Preserving Model Switching — `buff model switch` changes providers mid-session without losing agent state
- Docker Compose Setup — 5-minute onboarding with multi-stage Dockerfile, health checks, persistent volume
- Project Scaffolding — `buff init` with 5 built-in templates and interactive provider selection wizard

### Technical
- Skill Store with decay scoring, garbage collection, and keyword search
- Token estimation heuristic with 1-token-per-4.5-char ratio
- 156 new tests (84 skill system + 72 context pruner), 1479 total

---

## [1.14.5] - 2026-07-22

### Fixed
- `/exit` command now actually terminates the process (no lingering "You:" prompt)
- Ctrl+C double-press logic moved from process-level to readline handler (first press shows warning, second press exits)
- Process-level SIGINT simplified to immediate exit (appropriate for API-call interruptions)

---

## [1.14.4] - 2026-07-20

### Added
- Rate-limit header parsing across all cloud providers (7+ header naming conventions)
- Green/Amber status based on real quota data (>20% = Green, ≤20% = Amber)
- New "Quota" column in dashboard models table

### Fixed
- OpenRouter models now correctly reflect rate-limit status

---

## [1.14.3] - 2026-07-18

### Added
- Interactive error recovery on API failures (retry, switch provider, cancel, exit)
- Seamless provider switching preserves all conversation history

### Fixed
- Ctrl+C single press now shows warning, second press exits

---

## [1.14.2] - 2026-07-16

### Added
- Web dashboard `/api/models` endpoint with provider health data
- Color-coded model table (Green = working, Amber = limited, Red = unavailable)
- Provider card headers with overall status
- Quota remaining indicator

---

## [1.14.1] - 2026-07-14

### Fixed
- Rename "Agent-Baba-D" to "Agent-Nuvira" in dashboard
- Windows `spawn start ENOENT` error on dashboard launch
- Cross-platform browser opening logic

---

## [1.14.0] - 2026-07-12

### Added
- Full Windows CI test suite (GitHub Actions)
- Multi-line input in interactive chat

### Fixed
- Cross-platform echo commands in runner tests

### Changed
- Published to npm as `agent-nuvira`

---

## [1.13.0] - 2026-07-10

### Added
- Hybrid model routing — complexity-based model selection with cost optimization
- Team collaboration — Git-synced shared config, memory, and review pipelines
- Agent SDK — `@agent-nuvira/sdk` npm package with scaffolding CLI
- Provider fallback routing — auto-failover with circuit breaker and configurable chain
- Security scan CLI — `buff security scan` for PII, injection, and dangerous code detection
- Feedback & rating system — `buff feedback record/list/stats/clear`
- Marketplace unified CLI — `buff marketplace browse/search/install/info`

---

## [1.12.0] - 2026-07-08

### Added
- VS Code extension — 9 commands, inline suggestions, diff viewer, agent progress panel
- Remote agent federation — multi-machine collaboration via TCP protocol
- Web UI dashboard — React dashboard with DAG, health, cost, history, benchmarks
- Shared model picker, spinner UX, model-picker tests

---

## [1.11.0] - 2026-07-06

### Added
- Skill compiler — auto-extracts reusable patterns from trajectories into runnable skills
- Context-window memory pruner — token-aware compression for long agent chains
- Context-preserving model switching — `buff model switch`
- Speech model labeling in model picker

---

## [1.10.0] - 2026-07-04

### Added
- Docker sandbox isolation — resource-limited, network-isolated containers, 8 base images
- Provider health dashboard — `buff doctor` with color-coded status and watch mode
- Human-readable model names in picker
- Categorized model selection (chat, code, vision)

---

## [1.9.0] - 2026-07-02

### Added
- Workflow template marketplace — 10 built-in templates + GitHub registry with install/publish
- Model benchmarking — 21 standardized coding tasks with scoring and A/B comparison
- Model categorization + smart picker

---

## [1.8.0] - 2026-06-30

### Added
- Native embedding support — 3-tier embedder (Xenova/Python/LLM) with LRU cache
- Vector store — cosine similarity search over embedded trajectories
- Trajectory store — few-shot example storage with quality scoring
- Memory integration — context retrieval + storage orchestration

---

## [1.7.1] - 2026-06-29

### Changed
- Rate-limit UX improvements with smart retry logic
- Better error messages for rate-limit errors

---

## [1.7.0] - 2026-06-28

### Added
- Groq LPU integration for fastest open-source model inference
- Streaming support — token-by-token output (Groq, NIM, OpenRouter)
- Plugin system — programmatic API + auto-discovery from `~/.buff/plugins/`
- Cost tracking — per-provider, per-session, monthly cost dashboards

---

## [1.6.0] - 2026-06-25

### Added
- Agent retry logic with exponential backoff (3 attempts)
- Format validation — auto-retry on malformed agent output
- Git integration — branch creation, commit with LLM-generated messages
- PR description generation from git diff

---

## [1.5.1] - 2026-06-20

### Fixed
- Windows CI pipeline fixes

---

## [1.5.0] - 2026-06-18

### Added
- TesterAgent — sandboxed test execution in isolated temp directory
- RunnerAgent — shell command execution with output capture
- DebuggerAgent — iterative test-fix loop using LLM (up to 3 iterations)
- SecurityAgent — prompt injection + secret/PII scanning

---

## [1.4.1] - 2026-06-15

### Fixed
- Bug fixes, Windows compatibility improvements

---

## [1.4.0] - 2026-06-12

### Added
- Multi-agent pipeline (`buff execute` command)
- PlannerAgent — goal decomposition and task planning
- WriterAgent — code implementation with retry logic
- ContextGathererAgent — codebase scanning and file discovery
- ReviewerAgent — code review, bug detection, style checks

---

## [1.3.0] - 2026-06-10

### Added
- Implementation plans (`buff plan` command)
- Codebase-aware plan generation with architecture impact analysis
- Structured plan output (summary, files, architecture, steps, risks, testing)

---

## [1.2.0] - 2026-06-08

### Added
- AI-assisted file editing (`buff edit` command)
- Dry-run mode for safe previews
- File context support

---

## [1.1.0] - 2026-06-05

### Added
- Model discovery — `buff models` with search/filter across all providers
- Provider-specific model listing (Groq, NIM, Gemini, OpenRouter)

---

## [1.0.0] - 2026-06-01

### Added
- Initial release
- Core CLI with 25+ commands via Commander.js
- 5 built-in inference providers (expandable to 17+ via env vars + plugin system): Groq, NVIDIA NIM, Google Gemini, OpenRouter, Local (Ollama/HuggingFace/GGML)
- Interactive chat with conversation history and `/` commands
- Configuration system — JSON config file + env vars + CLI flags priority chain
- SQLite-backed response caching with configurable TTL
- Plugin system foundation
- MIT License

---

## Agent Catalog

### Agent Roles (16)

| Agent | Type | Description | Version |
|-------|------|-------------|---------|
| **PlannerAgent** | Core | Goal decomposition, dependency-aware task planning | v1.4.0 |
| **ContextGathererAgent** | Core | Codebase scanning, file discovery, artifact identification | v1.4.0 |
| **WriterAgent** | Core | Code implementation with retry + format validation | v1.4.0 |
| **ReviewerAgent** | Core | Code review, bug detection, security + style checks | v1.4.0 |
| **RunnerAgent** | Execution | Shell command execution with output capture | v1.5.0 |
| **TesterAgent** | Testing | Sandboxed test execution (temp dir / Docker) | v1.5.0 |
| **DebuggerAgent** | Testing | Iterative test-fix loop via LLM (3 iterations) | v1.5.0 |
| **SecurityAgent** | Safety | Prompt injection, secret/PII, dangerous code scanning | v1.5.0 |
| **GitAgent** | Publishing | Branch creation, LLM commit messages, PR descriptions | v1.6.0 |
| **PackageAgent** | Publishing | Version bump, npm build, publish, changelog generation | v1.6.0 |
| **GitHubReleaseAgent** | Publishing | Tag creation, release notes, GitHub releases | v1.6.0 |
| **SkillRunnerAgent** | Learning | Execute compiled skill scripts as pre-built task plans | v1.11.0 |
| **MCPAgent** | Integration | Invoke MCP tools from connected servers (stdio/SSE) | v1.16.0 |
| **GitLabAgent** | Integration | GitLab MR management, issues, pipelines | v1.32.0 |
| **PRReviewAgent** | Review | GitHub PR review with inline comments + security scans | v1.32.0 |
| **IssueTriageAgent** | Management | Issue classification, prioritization, auto-labeling | v1.32.0 |

### Release Phases

| Phase | Versions | Description |
|-------|----------|-------------|
| **Phase 0: Foundation** | v1.0.0 – v1.3.0 | Core CLI, chat, edit, plan, 5 built-in providers (expandable to 17+) |
| **Phase 1: Quick Wins** | v1.4.0 – v1.7.0 | Multi-agent pipeline, plugins, streaming, cost tracking |
| **Phase 2: Structural Changes** | v1.8.0 – v1.10.0 | Memory system, workflows, benchmarks, Docker sandbox |
| **Phase 3: Major Upgrades** | v1.11.0 – v1.14.6 | Skills, pruner, VS Code, federation, dashboard, SDK |
| **Phase 4: Industry Standards** | v1.15.0 – v1.16.0 | MCP, A2A, CI/CD, npm publishing, error-repair |
| **Phase 5: Interactive UX** | v1.16.1 | Interactive dev mode, failure analysis, follow-up suggestions, /fix |

