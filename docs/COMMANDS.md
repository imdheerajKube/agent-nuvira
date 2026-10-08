# Commands of Agent-Nuvira

A complete command reference for the **`nuvira`** CLI (binary name `nuvira`, also installed as
`agent-nuvira`). Every entry is written the same way:

> **Machine-checked surface:** every command/subcommand/flag in this doc's
> scope is cross-checked against the live CLI in
> [COMMANDS_SURFACE.md](./COMMANDS_SURFACE.md) — regenerated from the command
> tree by `npm run docs:commands` and drift-guarded in CI. If this curated doc
> and the generated surface ever disagree, the surface is authoritative for
> what EXISTS and this doc stays authoritative for HOW to use it.

1. **Objective** — what task you are trying to accomplish (plain English).
2. **Command** — the exact CLI invocation.
3. **Example** — a concrete, copy-pasteable usage.

The document is grouped by objective (service lifecycle, messaging, configuration, …) so
you can look up "what do I run to do X" instead of remembering command names. The final
section explains how Agent-Nuvira itself can drive these commands from a plain-English
chat/execute request.

> **Naming:** `nuvira` and `agent-nuvira` are the same CLI (the npm binary name). All examples
> below use `nuvira`; on the global install use `agent-nuvira`.

---

## 0. Quick start — the 15 commands you will use most

| Objective | Command |
|---|---|
| Chat with the agent | `nuvira chat "fix the failing test"` |
| Run a multi-agent pipeline on a goal | `nuvira execute "add login to the API"` |
| Start the gateway (WhatsApp/Telegram/…) | `nuvira gateway start` |
| Stop the gateway | `nuvira gateway stop` |
| Gateway status | `nuvira gateway status` |
| Send a message to a channel | `nuvira gateway send ops "nightly build done"` |
| Start the web dashboard | `nuvira dashboard` |
| Stop the web dashboard | `nuvira dashboard stop` |
| Start/stop the external OmniRoute gateway | `nuvira omniroute start` · `nuvira omniroute stop` · `nuvira omniroute status` |
| Check everything is configured | `nuvira doctor` |
| Pair WhatsApp (QR) | `nuvira whatsapp pair` |
| WhatsApp bridge status | `nuvira whatsapp status` |
| Allow a number to trigger the agent | `nuvira config gateway allow whatsapp user 919876543210` |
| Add a send-by-name WhatsApp contact | `nuvira whatsapp contact add Alex 919876543210` |
| List/switch AI models | `nuvira models list` · `nuvira model switch` |
| Open the website (capabilities/docs) | `nuvira website` |
| See what changed / debug | `nuvira stats` · `nuvira trace list` · `nuvira admin policy` |

### First run — expect it to be slow, and expect the model list to be incomplete

**This is normal, not a fault.** On a fresh install Nuvira does not know what your
keys can actually reach. It discovers it by *probing* providers and recording what
the live APIs will really serve, then hardening that into an availability + routing
matrix. Until that first sweep finishes:

- the **Models page and `nuvira models` list are incomplete** (models are shown as
  unverified, or missing entirely);
- **routing falls back** to a conservative choice, so the first requests can be
  slower or land on a less-preferred model;
- a provider that answers `403`/`429` is recorded as **blocked**, and Nuvira stops
  routing to it until you clear it.

Afterwards the registry **updates itself from real usage** — you should not have to
maintain it. Two commands are the escape hatch when you do not want to wait:

```bash
nuvira models refresh          # force a probe now instead of waiting for the sweep
nuvira models status           # show what is verified, stale, or blocked
nuvira models excluded         # show what routing is skipping, and WHY
```

> The first run is also when `nuvira doctor` is most useful — it reports exactly
> which providers are configured and which are missing a key.

---

## 1. Service lifecycle — start & stop the gateway and dashboard

### 1.1 Start the gateway

- **Objective:** Run the multi-channel gateway so the agent answers messages on
  WhatsApp, Telegram, Discord, Slack, Email, Signal, and more.
- **Command:** `nuvira gateway start [--port <n>] [--host <host>] [--no-events]`
- **Examples:**
  ```bash
  nuvira gateway start                        # run all configured adapters (Ctrl-C stops)
  nuvira gateway start --port 9090            # webhook receiver on port 9090 instead of 8787
  nuvira gateway start --no-events            # do not stream board events to channels
  ```

### 1.2 Stop the gateway

- **Objective:** Gracefully stop a running gateway — from any terminal, not just the one
  that started it.
- **Command:** `nuvira gateway stop [--port <n>]`
- **Examples:**
  ```bash
  nuvira gateway stop              # SIGTERM the running gateway (default port 8787)
  nuvira gateway stop --port 9090  # stop the gateway bound to port 9090
  ```

### 1.3 Start the web dashboard

- **Objective:** Launch the web UI (Agent Hub, Channels, Tasks, Chat, Gateway ops, Admin).
- **Command:** `nuvira dashboard [-p, --port <n>] [--host <host>] [--no-open] [--build] [--force]`
- **Examples:**
  ```bash
  nuvira dashboard                      # start on port 3030 and open the browser
  nuvira dashboard --no-open            # start without opening a browser tab
  nuvira dashboard --port 8080          # serve on port 8080
  nuvira dashboard --force              # detect and restart a stale dashboard on the port
  ```

### 1.4 Stop the web dashboard

- **Objective:** Gracefully stop a running dashboard — from any terminal.
- **Command:** `nuvira dashboard stop [-p, --port <n>]`
- **Examples:**
  ```bash
  nuvira dashboard stop          # SIGTERM the running dashboard (default port 3030)
  nuvira dashboard stop --port 8080
  ```
- **Aliases the agent understands:** "stop dashboard", "kill dashboard", "bounce
  dashboard", "shut down the dashboard" → all map to `nuvira dashboard stop`.

### 1.5 Start / stop the OmniRoute gateway

- **Objective:** Run (or stop) the **external** OmniRoute AI gateway — a separate local process
  on port 20128 that multiplexes many upstream providers behind one OpenAI-compatible endpoint.
  Agent-nuvira does not embed it: the provider row decides whether nuvira *routes* to it, these
  commands control whether the gateway itself is up.
- **Command:** `nuvira omniroute start | stop | status`
- **Examples:**
  ```bash
  nuvira omniroute status   # probe http://127.0.0.1:20128/v1 (a 401 still counts as running)
  nuvira omniroute start    # launch it in the background and wait until it answers
  nuvira omniroute stop     # SIGTERM the running gateway
  ```
- **Dashboard:** Admin → **External gateway: OmniRoute** shows reachability (✅ reachable /
  ⚠️ process up, not answering / ❌ not running) with **Start**, **Stop** and **Recheck** buttons.
  Start/stop require `gateway.manage` (admin or operator); the status read is available to any
  signed-in session.

---

## 2. Messaging channels — WhatsApp, Telegram, and friends

### 2.1 Gateway status & reachable channels

- **Objective:** See which platforms are configured and which channels are reachable.
- **Command:** `nuvira gateway status`
- **Example:**
  ```bash
  nuvira gateway status
  # ✅ WhatsApp (Baileys bridge — paired)
  # 📇 Reachable channels: ✅ WhatsApp 91***@s.whatsapp.net (family)
  ```

### 2.2 Send a message to a channel

- **Objective:** Send a one-shot message to an alias or a `platform:channelId` target.
- **Command:** `nuvira gateway send <target> <text>`
- **Examples:**
  ```bash
  nuvira gateway send ops "nightly build done"                     # by alias
  nuvira gateway send telegram:123456789 "hello from the CLI"      # by platform:id
  nuvira gateway send whatsapp:Alex "your report is ready"         # by send-by-name contact
  nuvira gateway send whatsapp:+919876543210 "hi"                  # by number
  ```

### 2.3 Send a media file

- **Objective:** Send an image/video/audio/document to a channel (WhatsApp/Telegram/Discord).
- **Command:** `nuvira gateway send-media <target> <file> [--caption <text>]`
- **Examples:**
  ```bash
  nuvira gateway send-media ops ./screenshot.png --caption "new build"
  nuvira gateway send-media whatsapp:Alex ./report.pdf
  ```

### 2.4 Channel aliases

- **Objective:** Give a channel a friendly name so `nuvira gateway send <alias>` works.
- **Command:** `nuvira gateway alias add <alias> <platform> <channelId>` · `nuvira gateway alias remove <alias>`
- **Examples:**
  ```bash
  nuvira gateway alias add ops slack C0123
  nuvira gateway alias add support telegram 123456789
  nuvira gateway alias remove ops
  ```

### 2.5 Configure a platform transport (Telegram, Discord, Matrix, …)

- **Objective:** Set the API token / env vars a platform needs, written to `~/.nuvira/.env`.
- **Command:** `nuvira config gateway set <platform> [--set VAR=value ...]` · `nuvira config gateway list` · `nuvira config gateway remove <platform>`
- **Examples:**
  ```bash
  nuvira config gateway list                                        # every transport + env status
  nuvira config gateway set telegram                                # interactive wizard
  nuvira config gateway set telegram --set NUVIRA_TELEGRAM_TOKEN=123456789:AAH…
  nuvira config gateway remove telegram --yes
  ```

### 2.6 WhatsApp bridge — pair a personal number (Baileys, no paid API)

- **Objective:** Pair your own WhatsApp number so the gateway can read/write messages.
- **Command:** `nuvira whatsapp pair [--phone <number>] [--timeout <seconds>]`
- **Examples:**
  ```bash
  nuvira whatsapp pair                     # scan the QR with WhatsApp → Linked devices
  nuvira whatsapp pair --phone 919876543210   # enter the 8-char code on the phone instead
  nuvira whatsapp pair --timeout 120       # longer pairing window
  ```

### 2.7 WhatsApp bridge — status

- **Objective:** Check the bridge session path and pairing state.
- **Command:** `nuvira whatsapp status`
- **Example:**
  ```bash
  nuvira whatsapp status
  # WhatsApp bridge (Baileys, personal number — I8)
  #   session: /Users/you/.nuvira/whatsapp/session
  #   paired:  yes
  ```

### 2.8 WhatsApp — send-by-name contacts (mapping)

> **Important — two different "contacts" lists, don't mix them up:**
> - **Send-by-name mapping** (`nuvira whatsapp contact add`) lets *you* send **to** someone
>   by name. It does **NOT** let that number trigger the agent.
> - **Verified list** (`nuvira config gateway allow whatsapp user <number>`) decides **who may
>   trigger** the agent when they message you.

- **Objective:** Map a display name to a number so you can `nuvira gateway send whatsapp:<Name>`.
- **Command:** `nuvira whatsapp contact add <Name> <number>` · `nuvira whatsapp contact remove <Name>` · `nuvira whatsapp contacts`
- **Examples:**
  ```bash
  nuvira whatsapp contact add Alex 919876543210
  nuvira whatsapp contact remove Alex
  nuvira whatsapp contacts                 # list mapping (numbers masked on screen)
  ```

### 2.9 Verified list — who can TRIGGER the agent (per platform)

- **Objective:** Allow (or deny) a user/group to trigger the agent on a platform.
  Blank list = no one may trigger; `Allow-All` skips the rule.
- **Command:** `nuvira config gateway allow <platform> <user|group> <id...>` · `nuvira config gateway disallow <platform> <user|group> <id...>`
- **Examples:**
  ```bash
  nuvira config gateway allow whatsapp user 919876543210
  nuvira config gateway allow telegram user 123456789
  nuvira config gateway allow telegram group g-family
  nuvira config gateway allow whatsapp user Allow-All        # everyone may trigger
  nuvira config gateway disallow whatsapp user 919876543210
  ```

### 2.10 Verified list — reply mode for unapproved senders

- **Objective:** Choose how unapproved senders are handled: polite refusal message or silent drop.
- **Command:** `nuvira config gateway reply <platform> <polite|silent>`
- **Examples:**
  ```bash
  nuvira config gateway reply whatsapp polite    # ⛔ message to unapproved senders
  nuvira config gateway reply whatsapp silent    # drop silently (default)
  ```

### 2.11 Status recipients — always get pipeline completion summaries

- **Objective:** Contacts/groups that ALWAYS receive the completion summary, whoever triggered it.
- **Command:** `nuvira config gateway notify <add|remove|list> [target...]`
- **Examples:**
  ```bash
  nuvira config gateway notify add whatsapp:Alex slack:ops telegram:123456
  nuvira config gateway notify remove whatsapp:Alex
  nuvira config gateway notify list
  ```

### 2.12 Delivery ledger (guaranteed delivery)

- **Objective:** See failed sends awaiting retry, or force a drain now.
- **Command:** `nuvira gateway delivery [--flush]`
- **Examples:**
  ```bash
  nuvira gateway delivery            # show pending/sent/failed sends
  nuvira gateway delivery --flush    # attempt every due pending entry now
  ```

---

### 2.13 Gateway setup wizard — configure a platform without memorizing env vars

- **Objective:** Set up a messaging platform end to end (credentials, verification),
  interactively, instead of hand-editing `~/.nuvira/.env`.
- **Command:** `nuvira gateway setup [platform]`
- **Examples:**
  ```bash
  nuvira gateway setup                 # pick a platform from a menu
  nuvira gateway setup telegram        # guided Telegram setup (BotFather walkthrough)
  nuvira gateway setup discord         # guided Discord setup
  ```
- **First-timer detail:** the wizard prints the exact steps for that platform (e.g. how
  to get a bot token from BotFather), verifies the credential where the platform allows
  it, then writes it to `~/.nuvira/.env`. Run `nuvira gateway status` afterwards to
  confirm the adapter came up.

### 2.14 Outbound contacts — send by name, with an approval gate

- **Objective:** Register people so you can message them by name, and decide who is
  allowed to receive agent-sent messages.
- **Command:** `nuvira gateway contact <list|add|approve|reject|delete>`
- **Examples:**
  ```bash
  nuvira gateway contact add Anuj telegram 616825477     # name → platform:id
  nuvira gateway contact add Alex whatsapp --phone 919876543210
  nuvira gateway contact list                            # all contacts + status
  nuvira gateway contact list --pending                  # only those awaiting a decision
  nuvira gateway contact approve Anuj --platform telegram
  nuvira gateway contact reject Anuj --platform telegram
  nuvira gateway contact delete Anuj --platform telegram
  ```
- **First-timer detail:** a contact starts out **unapproved**. Approving one is a
  deliberate act because it allows the agent to send messages **to that person** — see
  §2.17 for the separate `gateway_send` authority. `reject` keeps the record but blocks
  outbound; `delete` removes it permanently.

### 2.15 Conversation history — what the agent remembers per contact

- **Objective:** Inspect, clear, or trim the per-contact conversation memory the
  gateway keeps so replies stay in context.
- **Command:** `nuvira gateway history <list|show|clear|prune>`
- **Examples:**
  ```bash
  nuvira gateway history list                                  # every stored conversation
  nuvira gateway history list --platform whatsapp
  nuvira gateway history show whatsapp:918800663237            # one thread, with preview
  nuvira gateway history show whatsapp:918800663237 --limit 20
  nuvira gateway history clear whatsapp:918800663237           # forget one contact
  nuvira gateway history prune                                 # drop threads older than 7 days
  ```
- **First-timer detail:** conversations are keyed `platform:channelId`. `prune` is the
  safe routine cleanup (age-based); `clear` is the targeted "forget this person" — use
  it when a thread has drifted or you are testing.

### 2.16 Gateway log — why a message did or did not go out

- **Objective:** Read the structured record of send failures, refused senders, and
  pipeline outcomes without hunting through terminal scrollback.
- **Command:** `nuvira gateway logs [--event <event>] [--limit <n>] [--path]`
- **Examples:**
  ```bash
  nuvira gateway logs                       # most recent gateway events
  nuvira gateway logs --limit 50
  nuvira gateway logs --event refused       # only refused senders
  nuvira gateway logs --path                # print the log file path (for tail/grep)
  ```
- **First-timer detail:** this is the first place to look when "the agent didn't
  reply on WhatsApp". A refused sender, a send failure, and a pipeline error are
  recorded as *different* events — the log tells you which one you have.

### 2.17 Gateway policies — who may send, and hold-on-a-question

- **Objective:** Control the two gateway behaviours that people get wrong: who may
  command the agent to send to *other people*, and whether the agent waits for a reply
  instead of guessing.
- **Command:** `nuvira config gateway send-authority` · `nuvira config gateway ask-user-wait`
- **Examples:**
  ```bash
  nuvira config gateway send-authority list
  nuvira config gateway send-authority allow 919876543210   # this person may trigger gateway_send
  nuvira config gateway send-authority deny 919876543210
  nuvira config gateway send-authority remove 919876543210

  nuvira config gateway ask-user-wait on     # a question is held for the real reply
  nuvira config gateway ask-user-wait off
  ```
- **First-timer detail:** `send-authority` is deliberately **separate** from
  `config gateway allow`. `allow` decides who may *trigger the agent at all*;
  `send-authority` decides who may make it *message a third party*. Widening one does
  not widen the other — that separation is the point.

---

## 3. Core AI operations — chat, execute, edit, plan, run

### 3.1 Interactive chat

- **Objective:** Start an interactive chat session with the agent.
- **Command:** `nuvira chat [prompt] [-p <provider>] [-m <model>] [--no-cache] [-f <file>]`
- **Examples:**
  ```bash
  nuvira chat                              # interactive REPL
  nuvira chat "what's the state of this project?"        # one-shot, then followups selectable
  nuvira chat -p groq -m llama-3.3-70b "explain this"   # pin provider + model
  ```

### 3.2 Multi-agent pipeline execution

- **Objective:** Run the full planner→gatherer→writer→reviewer pipeline on a goal.
- **Command:** `nuvira execute "<goal>" [-p <provider>] [-m <model>] [--planner-model …] [--dry-run] [--review] [--memory] [--checkpoint] [--resume] [--session-store] [--session-recall]`
- **Examples:**
  ```bash
  nuvira execute "add a login page to the API"
  nuvira execute "fix the flaky test" --review --memory
  nuvira execute "refactor auth" --dry-run          # plan only, don't write files
  nuvira execute "migrate to v2" --checkpoint       # save progress for --resume later
  nuvira execute "finish the refactor" --session-store   # persist the conversation across process death
  nuvira execute "keep going" --no-session-recall        # skip semantic recall of past asks
  ```
- **Continuity flags (default ON):** `--session-store` persists the live conversation at every step
  so a killed process can resume, and `--session-recall` surfaces semantically similar past asks.
  Both are ON unless you turn them off (`--no-session-store` / `--no-session-recall`, the
  `NUVIRA_SESSION_STORE` / `NUVIRA_SESSION_RECALL` env vars, or `memory.sessionStore` /
  `memory.sessionRecall` in config). See §12.13 to inspect or forget what they store.

### 3.3 AI-assisted file edit

- **Objective:** Edit a file using AI assistance.
- **Command:** `nuvira edit <file> [-i <instruction>] [-p <provider>] [-m <model>] [--dry-run] [--review]`
- **Examples:**
  ```bash
  nuvira edit src/server.ts -i "add input validation"
  nuvira edit README.md --dry-run -i "document the new flag"   # preview the diff
  ```

### 3.4 Implementation plan

- **Objective:** Generate an implementation plan for a codebase task (no code changes).
- **Command:** `nuvira plan -t "<task>" [-p <provider>] [-m <model>] [-v]`
- **Example:**
  ```bash
  nuvira plan -t "add OAuth login" -p groq --verbose
  ```

### 3.5 Run a shell command

- **Objective:** Execute a shell command and show output (lightweight, no pipeline).
- **Command:** `nuvira run "<command>" [-t <timeout>]`
- **Example:**
  ```bash
  nuvira run "npm test" -t 120
  ```

---

## 4. Configuration & setup

### 4.1 Doctor — diagnose your setup

- **Objective:** Run diagnostic checks on all provider configs and system health.
- **Command:** `nuvira doctor [-p <provider>] [--enterprise] [--watch] [--verbose] [--fix]`
- **Examples:**
  ```bash
  nuvira doctor                       # everything checked at once
  nuvira doctor --fix                 # attempt auto-fixes for problems found
  nuvira doctor -p groq               # check one provider only
  ```

### 4.2 Config get/set/list/init

- **Objective:** Read or write configuration values in `~/.nuvira/nuviraconfig.json`.
- **Command:** `nuvira config set <key> <value>` · `nuvira config get <key>` · `nuvira config list` · `nuvira config init`
- **Examples:**
  ```bash
  nuvira config list                          # all providers + status
  nuvira config set defaultProvider groq
  nuvira config get defaultProvider
  nuvira config init                          # interactive defaults (already set? shows them)
  ```

### 4.2c Size limits and the capability mode

- **Objective:** Bound how much the agent reads/writes in one call, and choose how much
  REASONING it buys versus how much it saves.
- **Command:** `nuvira config limit list` · `nuvira config limit set <name> <value>` · `nuvira config limit unset <name>` · `nuvira config capability show` · `nuvira config capability set <balanced|max>` · `nuvira config capability unset` · `nuvira config catalog-feed show` · `nuvira config catalog-feed set <on|off>` · `nuvira config catalog-feed unset` · `nuvira config catalog-feed refresh`
- **Examples:**
  ```bash
  nuvira config limit list                          # every size limit + its default
  nuvira config limit set attachment-max-kb 500     # accept a larger single file
  nuvira config limit unset attachment-max-kb       # back to the default
  nuvira config capability show                     # balanced (default) or max
  nuvira config capability set max                   # cost is not a concern: strongest model,
                                                     # no cost ceilings, longest loop budget
  nuvira config capability unset                     # restore the balanced default
  nuvira config catalog-feed                        # is the catalogue feed on, and how old is its snapshot?
  nuvira config catalog-feed set on                 # allow cost/ecosystem PRIORS from the provider catalogue
  nuvira config catalog-feed refresh                # fetch a fresh snapshot now (never done during a turn)
  nuvira config catalog-feed unset                  # back to the default (off)
  ```
- **Catalogue feed:** `OFF` by default. When on, Agent-Nuvira fetches OpenRouter's public model
  catalogue **out-of-band** and uses it for two priors it cannot measure cold: `cost` (from real
  pricing) and `ecosystem` (from advertised tool support). A prior is replaced by measurement as
  samples accumulate, is printed with its source in `nuvira model explain`, and never outranks
  evidence. Nothing is fetched during a turn, so routing never waits on — or fails because of — a
  third-party call. It writes `NUVIRA_CATALOG_FEED`, the same switch the dashboard's Process Env
  page offers.
- **Capability mode:** `balanced` (the default) uses the best model for complex/critical work
  and cheaper models for simple work, escalating when a stall is detected. `max` routes every
  turn to a strong model (a reasoning floor — not merely a paid one), allows paid models, and
  lifts cost ceilings and the loop's continuation budget. It writes `NUVIRA_CAPABILITY_MODE`,
  the same switch the dashboard Chat page and Process Env page use, and never widens the
  deterministic safety surface.

### 4.1b The website — capabilities, commands, docs, setup

- **Objective:** Open the Agent-Nuvira website, where the capabilities, the full command
  reference, the architecture and the setup guides live.
- **Command:** `nuvira website [site|docs] [--url]`
- **Examples:**
  ```bash
  nuvira website                 # open https://www.agent-nuvira.com in your browser
  nuvira website docs            # open the documentation site directly
  nuvira website --url           # print the URL only (headless / scripts)
  ```
- **First-timer detail:** `--url` prints the link and opens nothing, so it is safe in CI or over
  SSH where no browser is running.

### 4.2b Third-party service keys (image / video / search / vision / speech)

- **Objective:** Configure the service backends the agent calls directly — Nano Banana / DALL·E /
  Stability image generation, FAL video, Brave / Serper / Tavily / Google CSE / SearXNG search, Jina
  page reading, vision and TTS — writing their keys to `~/.nuvira/.env`. The same keys are editable in
  the dashboard's Admin → Service Provider API Keys section.
- **Command:** `nuvira config service list` · `nuvira config service set <serviceId> [ENV_VAR] [value] [--set VAR=value]` · `nuvira config service unset <serviceId> [ENV_VAR]`
- **Examples:**
  ```bash
  nuvira config service list                                          # every backend + env status
  nuvira config service set search-brave BRAVE_SEARCH_API_KEY bsa_…   # one key
  nuvira config service set image-gemini --set GEMINI_API_KEY=AIza…   # Nano Banana
  nuvira config service unset search-brave BRAVE_SEARCH_API_KEY --yes
  ```

### 4.3 Secret vault

- **Objective:** Store API keys in an encrypted vault instead of plaintext config.
- **Command:** `nuvira config vault status` · `nuvira config vault migrate-keys` · `nuvira config vault log [-n <limit>]`
- **Examples:**
  ```bash
  nuvira config vault status
  nuvira config vault migrate-keys            # move plaintext keys into the vault
  nuvira config vault log -n 20
  ```

### 4.4 Scaffold a new project

- **Objective:** Generate a project from a template.
- **Command:** `nuvira init [-t <template>] [--list] [--template-dir <dir>] [-p <provider>] [-m <model>]`
- **Examples:**
  ```bash
  nuvira init --list
  nuvira init -t cli-app my-new-project
  ```

---

### 4.5 AWS Bedrock — dedicated onboarding

- **Objective:** Configure and verify AWS Bedrock (credentials, region, model access)
  without working out the IAM/region details yourself.
- **Command:** `nuvira bedrock <setup|status|test>`
- **Examples:**
  ```bash
  nuvira bedrock                 # show status + available actions
  nuvira bedrock setup           # interactive wizard: credentials, region, model access
  nuvira bedrock status          # current config + connectivity
  nuvira bedrock test            # probe Bedrock models and run a test inference
  nuvira bedrock test --region us-east-1
  ```
- **First-timer detail:** Bedrock uses **IAM auth, not an API key**, so the usual
  "paste your key" flow does not apply. `bedrock test` is the honest check — a region
  can be configured correctly and still have **no models enabled** for your account,
  which is exactly what the probe catches.

---

## 5. Models & providers

### 5.1 List models

- **Objective:** List available models from inference providers.
- **Command:** `nuvira models list [-p <provider>] [-s <search>] [--all] [--verify] [-j]`
- **Examples:**
  ```bash
  nuvira models list
  nuvira models list -p groq --verify -j
  nuvira models list -s llama
  ```

### 5.2 Registry health (availability registry)

- **Objective:** Show which providers/models are verified, unavailable, or quota-parked.
- **Command:** `nuvira models refresh` · `nuvira models status [-v]` · `nuvira models unblock <provider>` · `nuvira models watch [--interval <ms>]`
- **Examples:**
  ```bash
  nuvira models refresh                 # re-probe providers + spot-check models
  nuvira models status --verbose
  nuvira models unblock groq            # release a registry-blocked provider (escape hatch)
  nuvira models watch --interval 3600000
  ```

### 5.3 Switch / inspect active model

- **Objective:** Change the active provider/model; `auto` enables smart routing.
- **Command:** `nuvira model switch [--provider <p>] [--model <m>]` · `nuvira model list` · `nuvira model info` · `nuvira model recommend` · `nuvira model health [-p <provider>]`
- **Examples:**
  ```bash
  nuvira model switch --provider groq --model llama-3.3-70b
  nuvira model switch --provider auto        # smart per-task routing
  nuvira model info --verbose
  nuvira model health -p groq
  ```

### 5.4 Understand routing decisions

- **Objective:** See *why* a provider/model would be picked for a task (Auto router).
- **Command:** `nuvira model explain [-a <agent>] [-j] [--since <time>] [--context-tokens <n>] [--exclude-provider <provider>]` · `nuvira model bandit` · `nuvira model ml` · `nuvira model quota`
- **Examples:**
  ```bash
  nuvira model explain -a writer --json
  nuvira model explain "refactor the router" --context-tokens 120000 --exclude-provider groq
  nuvira model bandit -j                 # Thompson-sampling state per provider × complexity
  nuvira model ml -j                     # ML task-similarity router state
  nuvira model quota -j                  # token/request/cost ledger per provider × model
  ```
- **First-timer detail:** `explain` is offline, so it cannot see a live session's own
  state. Two runtime-only inputs change the pick, and you can supply them to reproduce a
  real decision: the prompt token count the turn would have seen (`--context-tokens`, the
  context-preflight basis) and a provider that already failed this session
  (`--exclude-provider`, repeatable — it sinks by scoring exactly as a live failure does).
  The header always states which inputs were in force, so an offline answer is never read
  as the live one.
- **Acceptance (read-only):** `explain` also prints the pair's own rated record
  (`👍 9 / 👎 3 (n=12, 75%)`, from `nuvira rate` and the dashboard Trace tab) and a
  harness-level fit `P(accepted | features)`. The fit is **NOT used for routing** and it
  refuses to train below 20 labelled turns (≥5 of each class), printing the honest reason
  instead of a number that would read as evidence. See
  `docs/DESIGN_CAPABILITY_BY_MEASUREMENT.md` §8.

### 5.5 Provider health

- **Objective:** List all providers with color-coded status, or deep health checks.
- **Command:** `nuvira provider list [--all]` · `nuvira provider health [--watch] [--verbose]`
- **Examples:**
  ```bash
  nuvira provider list
  nuvira provider health --verbose
  ```

---

### 5.6 Why routing is skipping a provider

- **Objective:** Find out what routing is currently *not* using, and the reason — so a
  provider that is quietly being avoided does not look like a mystery.
- **Command:** `nuvira models excluded [--json]`
- **Examples:**
  ```bash
  nuvira models excluded                 # providers being skipped, grouped by cause
  nuvira models excluded --json          # machine-readable (for scripts/dashboards)
  ```
- **First-timer detail:** the two common causes are worth telling apart:
  **failure cooldowns** (transient — a provider that just errored is parked briefly and
  comes back on its own) and **registry blocks / governance policy** (not transient —
  Nuvira learned this key cannot use these models, or `nuvira admin` forbids them).
  If the reason is a learned block, the escape hatch is `nuvira models refresh` followed
  by `nuvira models unblock`.

### 5.7 Model staleness — what has not been verified recently

- **Objective:** See how long since each model was last proven usable, and which ones
  are at risk of being dropped.
- **Command:** `nuvira models staleness [--json]`
- **Examples:**
  ```bash
  nuvira models staleness                # last probe time + days since verification
  nuvira models staleness --json
  ```
- **First-timer detail:** "stale" is not "broken". Availability changes constantly as
  providers add, retire, or paywall models, so Nuvira re-verifies on a schedule and
  drops what it can no longer confirm. Reading this alongside `nuvira models refresh`
  tells you whether an empty result is real or just unverified.

---

## 6. Skills & automation

### 6.1 Compiled skills (reusable execution plans from past runs)

- **Objective:** Run a compiled skill — the agent resolves parameters and invokes the pipeline.
- **Command:** `nuvira skill list` · `nuvira skill show <name>` · `nuvira skill run <name> [--params k=v] [--dry-run]` · `nuvira skill compile` · `nuvira skill search <q>` · `nuvira skill clear`
- **Examples:**
  ```bash
  nuvira skill list --quality
  nuvira skill run fix-lint --params "file=src/server.ts"
  nuvira skill compile                    # compile skills from stored trajectories
  nuvira skill clear --force
  ```

### 6.2 Skills hub (community skills)

- **Objective:** Search, install, update, audit community skills (SKILL.md packages).
- **Command:** `nuvira skills search <q>` · `nuvira skills install <owner/repo> --skill <name>` · `nuvira skills update` · `nuvira skills list [--origin <origin>]`
- **Examples:**
  ```bash
  nuvira skills search git-release
  nuvira skills install acme/skills --skill release --yes
  nuvira skills update
  nuvira skills list --origin registry
  ```

### 6.3 Plugins

- **Objective:** Discover installed provider/agent plugins and workflow templates.
- **Command:** `nuvira plugins list` · `nuvira plugins scan`
- **Examples:**
  ```bash
  nuvira plugins list
  nuvira plugins scan
  ```

### 6.4 Workflow templates

- **Objective:** Run, manage, and share workflow templates.
- **Command:** `nuvira workflow list` · `nuvira workflow run <name>` · `nuvira workflow search <q>` · `nuvira workflow install <owner/repo>` · `nuvira workflow publish` · `nuvira workflow info <name>` · `nuvira workflow upgrade`
- **Examples:**
  ```bash
  nuvira workflow list
  nuvira workflow run release-checklist
  nuvira workflow search deploy
  ```

### 6.5 MCP (Model Context Protocol) servers

- **Objective:** Connect the agent to MCP servers, or expose its own tools as an MCP server.
- **Command:** `nuvira mcp list` · `nuvira mcp connect <server> [--all]` · `nuvira mcp call <tool> [-s <server>] [-a '<json>']` · `nuvira mcp install <name> [--env K=V]` · `nuvira mcp uninstall <name>` · `nuvira mcp serve [--with <tool>]` · `nuvira mcp catalog [--search <q>]`
- **Examples:**
  ```bash
  nuvira mcp list
  nuvira mcp call fetch_webpage -s browser -a '{"url":"https://example.com"}'
  nuvira mcp install github --env GITHUB_TOKEN=ghp_…
  nuvira mcp serve --with gateway_send      # expose agent tools over stdio (Claude/IDEs)
  ```
- **Worked example — give the agent a GitHub MCP server, then let Claude Desktop call it:**
  ```bash
  nuvira mcp catalog --search github          # 1. find the vetted server
  nuvira mcp install github --env GITHUB_TOKEN=ghp_xxx   # 2. install it (writes ~/.nuvira/mcp/github.json)
  nuvira mcp list                            # 3. confirm it connected + its tools are live
  nuvira mcp call get_issue -s github -a '{"repo":"acme/app","number":42}'
  nuvira mcp serve --with gateway_send       # 4. expose agent tools to Claude Desktop / IDEs
  ```

---

### 6.6 Uninstall a skill, and bundle related skills

- **Objective:** Remove a skill cleanly, or group skills so they load together.
- **Command:** `nuvira skills uninstall <name>` · `nuvira skills bundle --create ...`
- **Examples:**
  ```bash
  nuvira skills uninstall code-assist                 # removes .agents/skills/<name>
  nuvira skills uninstall code-assist --project /path/to/project

  nuvira skills bundle --create --name docs --skills pdf,markdown --description "Doc tooling"
  nuvira skills bundle --delete docs
  ```
- **First-timer detail:** `uninstall` removes the skill *and its provenance record*, so
  it will not silently reappear on the next `nuvira skills update`. A bundle is a named
  group — loading the bundle id is the shorthand for loading all of its members.

### 6.7 Skill quality and garbage collection

- **Objective:** See which compiled skills are actually earning their place, and retire
  the ones that are not.
- **Command:** `nuvira skill quality [--details]` · `nuvira skill gc [--dry-run]`
- **Examples:**
  ```bash
  nuvira skill quality                  # quality + decay metrics per skill
  nuvira skill quality --details
  nuvira skill gc --dry-run             # show what WOULD be removed
  nuvira skill gc                       # actually collect the low-quality ones
  ```
- **First-timer detail:** **run `--dry-run` first.** Garbage collection deletes skills,
  and the dry run is the review step. Quality decays with disuse, so a skill that was
  good six months ago can be collected — if you still want it, use it or it goes.

### 6.8 Marketplace — browse, search, install community items

- **Objective:** Find and install community plugins and workflow templates.
- **Command:** `nuvira marketplace <browse|search|info|install>`
- **Examples:**
  ```bash
  nuvira marketplace browse
  nuvira marketplace browse --plugins          # plugins only
  nuvira marketplace browse --workflows        # workflow templates only
  nuvira marketplace browse --refresh          # re-fetch the registry index
  nuvira marketplace search review
  nuvira marketplace info <item>
  nuvira marketplace install <template>
  ```
- **First-timer detail:** browse is cached, so `--refresh` is what makes a *newly
  published* item appear. Community items are third-party code — `info` first, then
  install.

### 6.9 MCP — inspect and reconnect servers

- **Objective:** See the details of a configured MCP server, or re-discover them all
  after adding/changing a config.
- **Command:** `nuvira mcp info <server>` · `nuvira mcp refresh`
- **Examples:**
  ```bash
  nuvira mcp info filesystem
  nuvira mcp refresh                 # re-discover and reconnect every server
  ```
- **First-timer detail:** MCP servers are connected at startup, so **editing an MCP
  config file does nothing until you `refresh`** — this is the usual reason a newly
  added tool "doesn't exist".

---

## 7. Learning, memory & feedback

### 7.0 Continuity store — inspect and forget what the agent remembers

- **Objective:** See the continuity switches, the session snapshots kept across process death, and
  the semantic recall index — and forget any of it. Continuity is **default ON**, so this is the
  transparency + erasure surface for a feature that writes to your home directory.
- **Command:** `nuvira continuity list` · `nuvira continuity clear [--sessions] [--recall]`
- **Examples:**
  ```bash
  nuvira continuity list                 # effective switches + stored sessions + recall index
  nuvira continuity clear                # forget BOTH sessions and recall (no flags = both)
  nuvira continuity clear --sessions     # only the session snapshots
  nuvira continuity clear --recall       # only the semantic recall index
  ```
- **First-timer detail:** `list` reports the **effective** switch state through the same resolvers the
  engine uses, so it cannot disagree with what a run actually does. An **OPEN** snapshot is a turn
  that did not finish (resumable); a **closed** one ran to a clean end and is history — kept for you
  to read, never replayed. The switches themselves live in config (`memory.sessionStore` /
  `memory.sessionRecall`), the environment (`NUVIRA_SESSION_STORE` / `NUVIRA_SESSION_RECALL`), and
  the per-run `execute` flags; the dashboard's Memory page shows the same view with Forget buttons.

### 7.1 Self-improvement (learn)

- **Objective:** See agent stats, patterns, failure lessons, and optimization recommendations.
- **Command:** `nuvira learn stats` · `nuvira learn patterns [--extract]` · `nuvira learn lessons [--extract]` · `nuvira learn optimize` · `nuvira learn status` · `nuvira learn clear [-f]` · `nuvira learn gc [-n]`
- **Examples:**
  ```bash
  nuvira learn stats
  nuvira learn lessons --extract
  nuvira learn optimize                 # model→agent routing recommendations
  nuvira learn gc --dry-run
  ```

### 7.2 Memory store (compression, pruning, facts)

- **Objective:** Manage trajectory memory — compress, prune, summarize, store facts.
- **Command:** `nuvira memory stats` · `nuvira memory optimize [--dry-run] [--aggressive]` · `nuvira memory prune [--max-age <d>] [--min-score <n>]` · `nuvira memory summarize [--retention <d>]` · `nuvira memory facts list/add [--project <p>]` · `nuvira memory backend [--check]` · `nuvira memory clear [-f]`
- **Examples:**
  ```bash
  nuvira memory stats
  nuvira memory optimize --aggressive
  nuvira memory prune --max-age 30 --min-score 0.5
  nuvira memory facts add "deploys happen every Friday" --tags deploy
  nuvira memory backend --check          # active vector backend (e.g. FAISS) and why
  ```

### 7.3 Feedback

- **Objective:** Rate agent outputs (trajectories) and view aggregate stats.
- **Command:** `nuvira feedback record [--positive|--negative|--neutral] [-c <comment>]` · `nuvira feedback list [-n <limit>] [--trajectory <id>]` · `nuvira feedback stats` · `nuvira feedback clear`
- **Examples:**
  ```bash
  nuvira feedback record --positive -c "great fix"
  nuvira feedback stats
  ```
- **Not the same as `nuvira rate` (§12.15):** this store is keyed by **trajectory id** (pipeline runs) and
  is read for stats; `nuvira rate` is keyed by **chat turn** (`traceId`) and is the label a future
  quality signal is fit to. They are deliberately separate — see
  `docs/DESIGN_CAPABILITY_BY_MEASUREMENT.md` §8.5.

---

### 7.4 Memory — inspect, search, add, and move entries

- **Objective:** Work with the memory store directly: see what is in it, search it, add
  to it, export it, or bring it to another machine.
- **Command:** `nuvira memory <list|info|search|add|delete|export|import|facts>`
- **Examples:**
  ```bash
  nuvira memory list                                  # everything stored, with types
  nuvira memory list --type fact --limit 25
  nuvira memory info                                  # compression analysis
  nuvira memory search "deployment preference"
  nuvira memory search "postgres" --type lesson
  nuvira memory add "Prefers timezone Asia/Kolkata" --type preference --tags prefs
  nuvira memory delete <id>
  nuvira memory export --output ./memory-backup.json
  nuvira memory import ./memory-backup.json --merge
  nuvira memory facts stats                           # fact-store statistics
  ```
- **First-timer detail:** entries are typed — **facts**, **preferences**, **lessons**,
  **observations** — and `--type` filters on that. `import --merge` adds to what is
  already there; without it, an import replaces. `memory info` is the honest view of how
  much is being compressed away, which is worth a look before you blame retrieval for
  "forgetting".

### 7.5 Learning — compare models, rate outcomes, watch quality decay

- **Objective:** Compare measured results between models, give explicit feedback on an
  outcome, and see whether the learned patterns are still holding.
- **Command:** `nuvira learn <compare|feedback|quality>`
- **Examples:**
  ```bash
  nuvira learn compare --last            # compare the most recent benchmark results
  nuvira learn compare --all
  nuvira learn feedback --stats                                   # feedback statistics
  nuvira learn feedback --trajectory <id> --rating 5 --comment "clean fix"
  nuvira learn quality                   # pattern quality + decay
  nuvira learn quality --details
  ```
- **First-timer detail:** `learn compare` reports what was **measured**, so it is only
  meaningful once benchmarks have run — an empty comparison usually means you have not
  run `nuvira benchmark` yet. `feedback --trajectory <id>` is the strongest signal you
  can give the agent: it attaches your judgement to the exact run it came from.

---

## 8. Evaluation & benchmarking

### 8.1 Evaluation framework

- **Objective:** Measure whether the agent is actually improving.
- **Command:** `nuvira eval run [-p <provider>] [-m <model>] [--tasks <t>] [--suite <s>] [--budget <$>] [--pace <n>] [--format <fmt>] [--routing]` · `nuvira eval parity [-p <provider>] [-m <model>] [--tasks <ids>] [--engine loop|pipeline]` · `nuvira eval verify-seeds` · `nuvira eval list` · `nuvira eval results [--last] [--compare <id>]` · `nuvira eval score` · `nuvira eval clear`
- **Examples:**
  ```bash
  nuvira eval run --tasks quick --format text
  nuvira eval run --suite full --provider groq
  nuvira eval verify-seeds                  # every seeded bug is broken, and fixable
  nuvira eval run --suite seeded-bugs -p groq -m llama-3.3-70b-versatile
  nuvira eval parity -p groq -m llama-3.3-70b-versatile   # balanced vs max on the hard tasks
  nuvira eval results --last
  ```
- **Capability parity (`nuvira eval parity`):** run the SAME hard, multi-step tasks twice —
  once under `balanced`, once under `max` — and print the deltas that describe the
  capability gap (composite score, hidden-test pass, completion, bounded-ness,
  interruptions per task, tokens, cost). The mode is applied through the real
  `NUVIRA_CAPABILITY_MODE` switch, so the measurement exercises production resolution,
  not a test-only knob. Read the delta column: positive composite/test/completed favors
  `max`; negative bounded/asks favors `max`. This costs real tokens — it runs the suite
  twice.
- **Seeded bugs (`--suite seeded-bugs`):** a separate benchmark with its own scoring — a
  deliberate defect is planted in a small project, the run is asked to make the failing
  check pass without editing it, and three things are scored apart: **found** (read from
  what the run reported), **fixed** (the check passes now — ground truth), and **nothing
  else touched** (every seeded file diffed against its original, plus any new file).
  `nuvira eval verify-seeds` proves each seed FAILS its checks and PASSES them once the
  reference fix is applied, with no provider and no tokens — a task that already passed
  would measure nothing, so the suite refuses to score one and aborts instead. That same
  verification runs before every scored run, which is why an aborted run costs nothing.
  The "nothing else touched" component only counts on a task that was actually fixed: a run
  that changes nothing scores 0 rather than 20% for leaving the workspace as it found it.

### 8.2 Benchmarks

- **Objective:** Run standardized model benchmarks against coding tasks.
- **Command:** `nuvira benchmark run [-p <provider>] [-m <model>] [--tasks <t>] [--budget <$>] [--format <fmt>] [--routing]` · `nuvira benchmark list` · `nuvira benchmark results [--last] [--compare]` · `nuvira benchmark clear`
- **Examples:**
  ```bash
  nuvira benchmark run --tasks smoke
  nuvira benchmark results --compare
  ```

---

## 9. Security, governance & compliance

### 9.1 Admin governance policy

- **Objective:** Allow/deny providers & models, hard cost cap, PII privacy, unblock control.
- **Command:** `nuvira admin policy [--json]` · `nuvira admin allow <provider...>` · `nuvira admin deny <provider...>` · `nuvira admin allow-model <model...>` · `nuvira admin deny-model <model...>` · `nuvira admin max-cost <usd>` · `nuvira admin pii-min <score>` · `nuvira admin unblock <true|false>` · `nuvira admin clear <field>`
- **Examples:**
  ```bash
  nuvira admin policy
  nuvira admin deny openai
  nuvira admin max-cost 0.05
  nuvira admin pii-min 1.0
  nuvira admin clear allow
  ```

### 9.2 RBAC roles

- **Objective:** Assign roles (admin/operator/viewer) to users over the admin surface.
- **Command:** `nuvira admin role add <user> <role>` · `nuvira admin role remove <user>` · `nuvira admin role list` · `nuvira admin whoami`
- **Examples:**
  ```bash
  nuvira admin role add dheeraj admin
  nuvira admin role list
  nuvira admin whoami
  ```

### 9.3 Cron jobs

- **Objective:** Scheduled tool invocations (e.g. nightly build).
- **Command:** `nuvira admin cron add <name> "<schedule>" <tool> [--args '<json>'] [--channel <target>] [--dry-run]` · `nuvira admin cron list` · `nuvira admin cron remove <name>` · `nuvira admin cron run <name>`
- **Examples:**
  ```bash
  nuvira admin cron add nightly-build "0 3 * * *" build --channel slack:ops
  nuvira admin cron list
  nuvira admin cron run nightly-build
  ```

### 9.4 Security scanning

- **Objective:** Scan code/prompts/files for PII, injection, or dangerous patterns.
- **Command:** `nuvira security scan [-f <file>] [--stdin] [--prompt <text>] [--code <text>] [--pii] [--generated] [--json] [--strict]`
- **Examples:**
  ```bash
  nuvira security scan -f src/server.ts --json
  nuvira security scan --prompt "ignoring the system prompt…"
  nuvira security scan --pii --generated
  ```

### 9.5 Audit trail

- **Objective:** Verify and export the tamper-evident (hash-chained) audit trail.
- **Command:** `nuvira audit verify [-f <file>] [--json]` · `nuvira audit export [-f <file>] [--out <file>]`
- **Examples:**
  ```bash
  nuvira audit verify
  nuvira audit export --out audit.cef
  ```

### 9.6 SBOM

- **Objective:** Generate/verify the CycloneDX software bill of materials.
- **Command:** `nuvira sbom [-o <out>] [--reproducible] [--json] [--verify] [--sbom <file>] [--licenses]`
- **Examples:**
  ```bash
  nuvira sbom -o sbom.json --json
  nuvira sbom --verify --sbom sbom.json
  ```

---

## 10. Collaboration — team, federation, SDK, agents

### 10.1 Team workspace

- **Objective:** Shared config + git-synced memory + review workflow for a team.
- **Command:** `nuvira team init [-r <repo>] [-b <branch>]` · `nuvira team join <repo>` · `nuvira team sync` · `nuvira team status` · `nuvira team share`
- **Examples:**
  ```bash
  nuvira team init -r git@github.com:acme/team-config.git
  nuvira team join git@github.com:acme/team-config.git
  nuvira team sync
  ```

### 10.2 Review bundles (agent PR → review → merge)

- **Objective:** Create and manage agent-produced review bundles.
- **Command:** `nuvira team review create [-f <files...>] [--provider <p>]` · `nuvira team review list [-l <n>]` · `nuvira team review show <id>` · `nuvira team review approve <id>` · `nuvira team review request-changes <id>` · `nuvira team review reject <id>` · `nuvira team review merge <id>`
- **Examples:**
  ```bash
  nuvira team review create -f src/api.ts src/db.ts
  nuvira team review approve bundle-123
  nuvira team review merge bundle-123
  ```

### 10.3 Federation (remote agent instances)

- **Objective:** Connect to and run tasks on remote agent instances.
- **Command:** `nuvira federation status` · `nuvira federation start [-p <port>] [-s <secret>] [--daemon]` · `nuvira federation connect [-p <port>] [-s <secret>]` · `nuvira federation run "<task>" [-a <agent>] [-m <model>]` · `nuvira federation health` · `nuvira federation disconnect` · `nuvira federation config [--show] [--set-secret <s>] [--set-port <n>]`
- **Examples:**
  ```bash
  nuvira federation start --port 9000 --secret s3cret
  nuvira federation connect --port 9000 --secret s3cret
  nuvira federation run "run the test suite" -a builder
  ```
- **Worked example — offload a heavy build to a remote agent:**
  ```bash
  nuvira federation config --set-port 9000 --set-secret s3cret   # 1. configure the local endpoint
  nuvira federation start --daemon                               # 2. serve (detached)
  # On the remote machine:
  nuvira federation connect --port 9000 --secret s3cret          # 3. link the remote agent
  nuvira federation status                                       # 4. confirm both sides are up
  nuvira federation run "build the release artifacts" -a builder --timeout 600
  nuvira federation health                                       # 5. check latency + auth
  ```

### 10.4 A2A (agent-to-agent protocol)

- **Objective:** Discover/connect to external A2A-compliant agents and delegate tasks.
- **Command:** `nuvira federation a2a discover <url>` · `nuvira federation a2a start [-p <port>]` · `nuvira federation a2a status <url>` · `nuvira federation a2a run <url> "<task>" [-s <skill>]`
- **Examples:**
  ```bash
  nuvira federation a2a discover https://agent.example.com/.well-known/agent.json
  nuvira federation a2a run https://agent.example.com "summarize the repo"
  ```
- **Worked example — delegate to an A2A agent you found online:**
  ```bash
  nuvira federation a2a discover https://agent.example.com/agentcard.json   # 1. fetch its AgentCard (name, skills, auth)
  nuvira federation a2a status https://agent.example.com                    # 2. confirm it is healthy
  nuvira federation a2a run https://agent.example.com "write release notes" -s notes-writer
  nuvira federation a2a start --port 9500                                   # 3. also expose YOUR agent as A2A
  ```

### 10.5 Custom agents (SDK + scaffold)

- **Objective:** Scaffold and register custom agent-nuvira agents.
- **Command:** `nuvira agent create [-n <name>] [-d <desc>] [--dir <dir>]` · `nuvira agent list` · `nuvira agent info <name>` · `nuvira sdk scaffold <outDir> <agentName> [description] [-t <basic-agent|full-agent|agent-pack>] [--agent-type <type>]` · `nuvira sdk templates` · `nuvira sdk register <className> <agentType> <sourceModule> [-i <icon>]` · `nuvira sdk unregister <agentType>`
- **Examples:**
  ```bash
  nuvira agent create -n code-reviewer -d "Reviews PRs"
  nuvira sdk scaffold code-formatter CodeFormatter "Formats source code" -t full-agent
  nuvira sdk register CodeFormatter code-formatter ./agents/code-formatter.js --orchestrator-path ./src/agents/orchestrator.ts
  ```
- **First-timer details:** `sdk scaffold` takes the output directory and the class
  name positionally, and an unknown `--template` is refused with the valid list
  rather than silently falling back to a default. `sdk register` needs all three
  positional arguments in that order, and its default orchestrator path is
  `./src/agents/orchestrator.ts` — so it edits a **source checkout**, not an
  npm-installed CLI. Full guide: [docs/AGENT_SDK.md](AGENT_SDK.md).

---

### 10.6 SDK package info

- **Objective:** Check which SDK version is installed/available before building a
  custom agent against it.
- **Command:** `nuvira sdk info`
- **Examples:**
  ```bash
  nuvira sdk info
  ```
- **First-timer detail:** the SDK is what you import in a custom agent
  (`import { Agent } from '@agent-nuvira/sdk'`). Check the version here first — a
  mismatch between the SDK you built against and the installed CLI is the usual reason
  a custom agent fails to load.

---

## 11. CI/CD & publishing

### 11.1 Headless CI mode

- **Objective:** Structured JSON output + exit codes for pipelines in CI.
- **Command:** `nuvira ci execute "<goal>" [--github-annotations] [--timeout <s>]` · `nuvira ci check "<gate>" [-v]` · `nuvira ci review <file...> [--format <fmt>]`
- **Examples:**
  ```bash
  nuvira ci execute "fix the failing build" --github-annotations
  nuvira ci check "run tests"                     # exit 0 pass / 1 fail
  nuvira ci review src/server.ts --format json
  ```
- **Worked example — a CI gate in GitHub Actions:**
  ```yaml
  # .github/workflows/agent-check.yml
  steps:
    - run: nuvira ci check "run tests" --verbose        # exit 0 = gate passed
    - run: nuvira ci review src/ src/tests/ --format json > findings.json
    - run: nuvira ci execute "fix the findings" --github-annotations --timeout 600
  ```

### 11.2 Autonomous publish

- **Objective:** Version, build, and publish to npm & GitHub.
- **Command:** `nuvira publish [--patch|--minor|--major] [--dry-run] [--skip-tests] [--no-preflight] [--force] [--fresh] [--from <phase>] [-p <provider>]`
- **Behaviour:** The phases are deterministic — bump (with the lockfile's own version fields), regenerate any version-pinned artifacts the project declares through a `release:artifacts` npm script, commit, annotated tag, push, `npm publish`, `gh release create`. No model is consulted for any of them, so a release cannot be derailed by plan quality or provider health. A **preflight** runs first and stops the run before anything irreversible when it finds a definitive blocker (the version is already on the registry, the tag is taken, the package is `private`, no remote, the model pair does not exist when a phase would need one); a check that cannot run (offline) warns and proceeds rather than claiming to have passed. A killed run is **resumable**: the scope records its target version, `running` counts as unfinished, and a second run continues the same release instead of bumping again — `--from <phase>` starts at a given phase, `--fresh` ignores the saved run, `--force` overrides a definitive preflight blocker.
- **Examples:**
  ```bash
  nuvira publish --patch
  nuvira publish --minor --dry-run
  nuvira publish --patch --from "npm Build & Publish"   # continue an interrupted release
  nuvira publish --patch --fresh --force                 # ignore state and blockers (deliberate)
  ```

### 11.3 Release credentials

- **Objective:** Store the GitHub and npm tokens a release needs, so `nuvira publish` — and the agent's own `publish` tool — work without re-exporting them every session. Values live in the nuvira credential store (owner-only, outside the repository), never in git and never in your shell history. This is also how an agent can be handed a token and then release unattended.
- **Command:** `nuvira credentials status` · `nuvira credentials set <KEY>` · `nuvira credentials forget <KEY>` · `nuvira credentials verify`
- **Keys:** `GITHUB_TOKEN` · `GIT_USERNAME` · `NPM_TOKEN` · `NPM_REGISTRY`
- **Examples:**
  ```bash
  nuvira credentials                                            # what is set, and where each came from
  nuvira credentials set GITHUB_TOKEN                            # prompts — nothing lands in shell history
  gh auth token | nuvira credentials set GITHUB_TOKEN --stdin    # scripts/CI: value stays out of argv
  nuvira credentials verify                                      # check the tokens against GitHub & npm
  nuvira credentials forget NPM_TOKEN
  ```

### 11.4 Phase scopes (multi-goal pipelines)

- **Objective:** Create and execute an ordered multi-goal project scope.
- **Command:** `nuvira phase create [-o <file>]` · `nuvira phase execute <scope> [--non-interactive]` · `nuvira phase resume <scope>` · `nuvira phase status` · `nuvira phase list` · `nuvira phase delete <scope>`
- **Examples:**
  ```bash
  nuvira phase create -o roadmap.md
  nuvira phase execute roadmap.md --non-interactive
  nuvira phase status
  ```

---

## 12. Observability & debugging

### 12.1 Stats & cost

- **Objective:** Usage statistics and API cost tracking.
- **Command:** `nuvira stats cost [--clear]` · `nuvira stats history`
- **Examples:**
  ```bash
  nuvira stats cost
  nuvira stats history
  ```

### 12.2 Conversation history

- **Objective:** Browse and search past conversations.
- **Command:** `nuvira history list [-l <n>]` · `nuvira history search "<q>" [-s]` · `nuvira history show <id>` · `nuvira history clear` · `nuvira history prune [-d <days>]` · `nuvira history reindex`
- **Examples:**
  ```bash
  nuvira history list -l 20
  nuvira history search "deploy config" --semantic
  nuvira history reindex
  ```

### 12.3 Traces (per-step reasoning)

- **Objective:** Inspect and replay every LLM call in a pipeline.
- **Command:** `nuvira trace list [-l <n>]` · `nuvira trace show <id>` · `nuvira trace replay <id> [-f]` · `nuvira trace clear`
- **Examples:**
  ```bash
  nuvira trace list -l 10
  nuvira trace replay t_abc123 --full
  ```

### 12.4 Retrieval (vector, token-efficient context)

- **Objective:** Index a repo and semantically query it (local embeddings).
- **Command:** `nuvira retrieval index <path>` · `nuvira retrieval query "<q>" [-k <n>]` · `nuvira retrieval stats` · `nuvira retrieval clear`
- **Examples:**
  ```bash
  nuvira retrieval index ./src
  nuvira retrieval query "how is auth handled" -k 5
  nuvira retrieval stats
  ```

### 12.5 Knowledge (tag-scoped documents)

- **Objective:** Bring your own documents, give them a tag, and answer questions scoped to that tag. Documents are extracted, chunked (heading-aware for Markdown) and embedded once, so later questions retrieve the relevant passages instead of re-reading the files every turn. Retrieval is **hybrid** — vectors plus BM25 — fused by rank and capped per source document, and it keeps only passages that clear a relevance floor, so an unrelated question comes back empty rather than receiving the closest passages of a document it has nothing to do with. `query` answers "where is it mentioned"; `read` answers "what does it say" by returning a document or one section **verbatim**.
- **Command:** `nuvira knowledge add <tag> <paths...>` · `nuvira knowledge sync <tag> <paths...>` · `nuvira knowledge query <tag> "<question>" [-k <n>]` · `nuvira knowledge toc <tag> [doc]` · `nuvira knowledge read <tag> <doc> [-s <heading>]` · `nuvira knowledge remove <tag> <doc>` · `nuvira knowledge list` · `nuvira knowledge stats <tag>` · `nuvira knowledge forget <tag>`
- **In chat:** open a message with `#<tag>` (chat REPL, dashboard Chat tab, gateway channel) to pull that tag's passages into the turn — e.g. `#dheeraj-health-report what is my LDL?`. Without a leading tag nothing is retrieved and the turn is unchanged. An unknown tag suggests a near match instead of substituting another document set.
- **Examples:**
  ```bash
  nuvira knowledge add dheeraj-health-report ~/Documents/labs.pdf
  nuvira knowledge query dheeraj-health-report "what is my LDL and how do I lower it"
  nuvira knowledge sync specs ./docs/specs            # re-sync; unchanged files are not re-embedded
  nuvira knowledge toc specs                          # documents and their headings
  nuvira knowledge read specs roadmap.md -s "Q3"      # one section, verbatim
  nuvira knowledge list                               # tags, documents, chunk counts
  nuvira knowledge forget dheeraj-health-report       # remove a tag's vectors and stored text
  ```

### 12.6 Session continuity

- **Objective:** List/resume project-scoped sessions (debug surface; `continue` is the primary path).
- **Command:** `nuvira session list [--project <p>] [--since <t>] [-l <n>]` · `nuvira session summarize <id>` · `nuvira session resume [--project <p>]`
- **Examples:**
  ```bash
  nuvira session list --project my-app
  nuvira session resume
  ```

### 12.7 NLU debugging

- **Objective:** Debug how a plain-English request is understood (intent/entities/actions).
- **Command:** `nuvira nlu debug "<request>" [--llm]`
- **Example:**
  ```bash
  nuvira nlu debug "stop the dashboard" --llm
  # → intent: dashboard.stop · entities: { service: dashboard }
  ```

### 12.8 Intent routing (plain-English → CLI)

- **Objective:** Resolve a plain-English ask into the exact `nuvira` command(s) to run —
  including the clarifying question when an ask is ambiguous (e.g. verified list vs
  send-by-name mapping). This is the machine-readable surface the agent itself uses
  to execute requests (see §15).
- **Command:** `nuvira intent resolve "<ask>" [-j]`
- **Examples:**
  ```bash
  nuvira intent resolve "stop the dashboard"
  # → intent: dashboard.stop → nuvira dashboard stop
  nuvira intent resolve "add Rahul mobile +919958604222 to whatsapp"
  # → ⚠ AMBIGUOUS — ask which:
  #     • verified list (triggers the agent)  → nuvira config gateway allow whatsapp user 919958604222
  #     • send-by-name mapping                → nuvira whatsapp contact add Rahul 919958604222
  nuvira intent resolve "run the eval suite" -j   # machine-readable JSON for automation
  ```

### 12.9 Code map

- **Objective:** Symbol map of a project — functions/classes/methods with line numbers.
- **Command:** `nuvira code-map [--json]`
- **Example:**
  ```bash
  nuvira code-map --json
  ```

### 12.10 Tool registry

- **Objective:** Inspect the agent's tool-calling surface.
- **Command:** `nuvira tools list` · `nuvira tools show <tool>` · `nuvira tools toolsets [-e <name>] [-d <name>]`
- **Examples:**
  ```bash
  nuvira tools list
  nuvira tools show gateway_send
  nuvira tools toolsets -e web
  ```

---

### 12.11 NLU learnings — the corrections the agent has learned

- **Objective:** See (and if needed forget) the routing corrections learned from
  **confirmed** misreadings — i.e. the agent improving itself from your actual usage.
- **Command:** `nuvira nlu learnings [--json] [--forget <id>]`
- **Examples:**
  ```bash
  nuvira nlu learnings                   # learned corrections
  nuvira nlu learnings --json
  nuvira nlu learnings --forget <id>     # drop one that is wrong
  ```
- **First-timer detail:** only **confirmed** misreadings are learned — the agent does
  not retrain itself off a guess. If it has learned something wrong, `--forget` is how
  you undo it; `nuvira nlu` is the sibling surface for debugging a single phrase.

### 12.12 Intent eval — how good is plain-English → CLI routing?

- **Objective:** Measure the intent router (deterministic rules vs semantic matching)
  over a labelled corpus, including novel phrasings, instead of trusting an impression.
- **Command:** `nuvira intent eval [--json]`
- **Examples:**
  ```bash
  nuvira intent eval
  nuvira intent eval --json
  ```
- **First-timer detail:** this is the scorecard for the §15 design below. Run it after
  changing routing rules — a phrase that used to resolve can regress silently
  otherwise, and this is the only thing that catches it.

### 12.13 Surface parity — prove every surface behaves the same

- **Objective:** Check that the same request produces the same experience on **chat,
  execute, dashboard chat, the gateway and subagents** — and that the code still agrees
  with the architecture the project claims. The requirement is only real if a capability
  cannot land on one surface and quietly miss the other four.
- **Command:** `nuvira parity` · `nuvira parity surfaces` · `nuvira parity debt` · `nuvira parity matrix` · `nuvira parity faults` · `nuvira parity run`
- **Examples:**
  ```bash
  nuvira parity                 # summary of the subcommands
  nuvira parity surfaces        # the registry vs the real import graph
  nuvira parity debt            # the anti-silo ratchet (exit 1 on drift)
  nuvira parity matrix          # every capability × surface, and any unproven claim
  nuvira parity faults          # the declared faults, and what each one proves
  nuvira parity run             # drive ALL five surfaces and report the verdict
  ```
- **Faults:** `nuvira parity faults` lists every fault the harness can inject — the
  protocol is `NUVIRA_INJECT_FAULT=<site>:<kind>[:<times|all>[:<tool>]]`, e.g.
  `provider:error:all` for a backend that fails every call, `tool:error:read_file` for
  one tool, `ipc:error` for a forked child that dies. It is off by default (with the
  variable unset nothing is wrapped), every message says the fault was injected, and a
  declaration that cannot be parsed throws rather than running unfaulted. The same
  declaration works outside the harness — `nuvira chat "…"` with it set runs a real
  turn against a broken dependency on purpose. Under a fatal fault the surfaces are
  judged on whether the failure was REPORTED, not on identical wording.
- **First-timer detail:** `surfaces`, `debt` and `matrix` read the repository's own
  `src/` import graph and exit non-zero when it drifts, so they work as a gate in a
  script or CI. `run` is the real thing: it drives each surface's own turn code (the
  real chat engine, dashboard console, gateway handler, execute command and a forked
  child) against a loopback stub provider in an isolated profile — no network, no real
  API key, no effect on a running dashboard or gateway. It drives three scenarios: a
  plain turn, a tool call that works, and a tool call that FAILS — the last one because
  a surface can agree that a tool ran while disagreeing about whether it worked, and an
  outcome that is merely absent would otherwise read as agreement too. The same drivers
  and the same scenario list back the parity test suite, so the CLI verdict and CI
  cannot disagree.

### 12.14 Hooks (declarative lifecycle rules, no-code)

- **Objective:** Attach a rule to nuvira's own lifecycle seams — `before_tool_call`,
  `after_tool_call`, `failed_tool_call`, `on_session_end` — without running any
  third-party code. A hook is DATA, not code: its only possible actions are `deny`
  (stop a call), `notify` (log a line) and `scan-args` (run the local secret scanner
  over a call's arguments/result, optionally denying on a hit). Same contract, same
  `<config-dir>/hooks.json`, as the dashboard's **Agent Management → Hooks** page.
- **Command:** `nuvira hooks list` · `nuvira hooks add --id … --label … --event … --action …` · `nuvira hooks remove <id>` · `nuvira hooks enable <id>` · `nuvira hooks disable <id>`
- **Examples:**
  ```bash
  nuvira hooks list                        # built-in + user hooks, with state
  nuvira hooks enable builtin-block-rm-rf  # turn a built-in ON (persists it)
  nuvira hooks add --id no-force-push --label "No force push" \
    --event before_tool_call --action deny \
    --tool run_terminal --arg "command=*git push --force*" --reason "no force push"
  nuvira hooks disable no-force-push
  nuvira hooks remove no-force-push        # remove a user hook
  ```
- **Starter set:** four built-in hooks ship **DISABLED** (block `rm -rf`, block writes
  that contain a secret, flag secrets in terminal commands, log failed tool calls).
  `enable` writes one into `hooks.json` so the runtime enforces it. See `docs/HOOKS.md`.

### 12.15 Rate a turn (the label the harness cannot derive)

- **Objective:** Tell the harness whether the last turn was actually what you wanted.
  Every other signal nuvira has is *derived* from what the run did (a tool ran, a plan
  step closed, an honesty flag fired); only you know whether the work was right. That
  makes your verdict the one input the harness cannot compute — and, because the derived
  correction signal can only ever produce negatives, the only source of a POSITIVE label.
- **Command:** `nuvira rate <good|bad> [--trace <id>]` · `nuvira rate --list` · `nuvira rate --stats` · `nuvira rate --export [path] [--format json|csv]`
- **Examples:**
  ```bash
  nuvira rate good                 # the last turn was what you wanted
  nuvira rate bad                  # it was not
  nuvira rate bad -t t_abc123      # rate a specific turn (`nuvira trace list`)
  nuvira rate --list               # recent verdicts
  nuvira rate --stats              # labels, class balance, per-pair record, fit status
  nuvira rate --export corpus.json # ship the labelled corpus for offline fitting
  nuvira rate --export corpus.csv  # CSV (or --format csv); no path prints to stdout
  ```
- **Export:** `--export` writes the SAME rows a fit here reads (the labelled turns, with
  their features and provenance), so nothing is lost in the hand-off. JSON keeps the full
  structure; CSV is the flat form (`traceId,provider,model,at,accepted,source,` + one column
  per feature). With no path it prints to stdout to be piped.
- **What it writes:** the verdict on the turn's reasoning trace (`userVerdict`, with its
  source) and, when that turn delivered an authored file, a label on the matching row of
  the quality corpus. The dashboard's **Trace tab** has the same control (👍/👎).
- **What it does NOT do:** nothing routes on it and no score is derived from it. It
  records a dataset so a measured quality signal can be fit to labelled turns; a turn
  nobody rated stays unlabelled, because reading silence as acceptance would fabricate
  the positive class instead of measuring it. See `docs/DESIGN_CAPABILITY_BY_MEASUREMENT.md` §8.
  (For trajectory ratings in the older store, use `nuvira feedback` — §7.3.)
- **Other label sources:** behaviour is also inferred when you do not rate — a near-verbatim
  **re-ask** or a **hand-edit** of the delivered file is a derived rejection, and an untouched
  file you then **reference** (without reporting a regression) is a derived acceptance. These
  carry `source: 'derived'` and are recorded on the same trace/corpus rows.
- **Where it is read:** `nuvira model explain` prints the pair's rated record and the fitted
  `P(accepted | features)` read-only (§5.4). The fit is not used for routing and refuses
  below 20 labelled turns.

---

## 13. Cache & sandbox

### 13.1 Inference cache

- **Objective:** Show or clear cached inference responses. Answers are cached per WORKSPACE
  (the project folder they are about), so `stats` names each folder and `clear` can drop one:
  when a project changes and an ask replays an old answer, only that project's answers are stale,
  and clearing everything would discard answers that are still correct.
- **Command:** `nuvira cache stats` · `nuvira cache clear [workspace] [--unscoped]`
- **Examples:**
  ```bash
  nuvira cache stats                # entries by provider AND by project folder
  nuvira cache clear ~/code/my-app  # drop only that project's cached answers
  nuvira cache clear --unscoped     # answers cached with no folder attached
  nuvira cache clear                # everything
  ```
- **First-timer detail:** a low `clear <workspace>` count is not a failure — the folder you named
  is matched EXACTLY, so a parent directory never clears a subdirectory's answers. The dashboard's
  **Admin → Response Cache** section lists the same buckets with a Clear button.

### 13.2 Docker sandbox

- **Objective:** Isolate code execution in Docker containers.
- **Command:** `nuvira sandbox status` · `nuvira sandbox config [--enable|--disable] [--memory <m>] [--cpu <n>] [--timeout <s>] [--network <on|off>]` · `nuvira sandbox images` · `nuvira sandbox run "<cmd>" [--image <img>] [--project <p>]` · `nuvira sandbox cleanup`
- **Examples:**
  ```bash
  nuvira sandbox status
  nuvira sandbox config --enable --memory 2g --cpu 2
  nuvira sandbox run "npm test" --project my-app
  nuvira sandbox cleanup
  ```

---

## 14. Appendix — every top-level command at a glance

```
nuvira admin         governance policy, RBAC roles, cron jobs
nuvira chat          interactive chat with the agent
nuvira edit          AI-assisted file editing
nuvira plan          implementation plan for a task
nuvira config        config get/set/list, secret vault, gateway transports & policies
nuvira cache         inference cache stats / clear
nuvira models        list models, refresh/status/unblock/watch registry
nuvira execute       multi-agent pipeline execution
nuvira run           run a shell command
nuvira workflow      workflow templates (list/run/search/install/publish)
nuvira whatsapp      WhatsApp bridge (pair/status/contacts/contact)
nuvira plugins       plugin discovery
nuvira learn         self-improvement (stats/patterns/lessons/optimize/gc)
nuvira init          scaffold a project
nuvira stats         usage stats + cost
nuvira history       conversation history (list/search/show/prune/reindex)
nuvira skill         compiled skills (list/show/run/compile/gc/clear)
nuvira skills        community skills hub (search/install/update/list)
nuvira gateway       multi-channel gateway (status/send/send-media/alias/delivery/start/stop)
nuvira model         provider/model switching, auto-routing explain, bandit/ml/quota
nuvira benchmark     standardized model benchmarks
nuvira eval          evaluation framework (improvement measurement)
nuvira sandbox       Docker isolation for code execution
nuvira doctor        diagnostic checks + auto-fix
nuvira memory        memory store (stats/optimize/prune/summarize/facts/backend)
nuvira dashboard     web dashboard (start/stop)
nuvira agent         custom agent scaffolding
nuvira federation    remote agents + A2A protocol
nuvira team          team workspace + review bundles
nuvira sdk           custom agent SDK
nuvira provider      provider list/health
nuvira security      PII / injection / dangerous-code scanning
nuvira audit         tamper-evident audit verify/export
nuvira sbom          CycloneDX software bill of materials
nuvira feedback      feedback record/list/stats/clear
nuvira intent        plain-English → CLI routing (resolve an ask into the command(s) to run)
nuvira nlu           NLU intent debugging
nuvira code-map      project symbol map
nuvira tools         tool registry + toolsets
nuvira parity        surface-parity harness (surfaces/debt/matrix/run)
nuvira session       project-scoped session continuity
nuvira marketplace   community plugins & workflow templates
nuvira mcp           MCP server management (list/connect/call/install/serve)
nuvira ci            headless CI/CD mode (execute/check/review)
nuvira publish       autonomous version/build/publish
nuvira phase         multi-goal phase scopes
nuvira retrieval     vector retrieval (index/query/stats/clear)
nuvira trace         reasoning-trace capture/replay
nuvira continuity    session snapshots + semantic recall (list/clear)
nuvira bedrock       AWS Bedrock onboarding (setup/status/test)
nuvira credentials   release tokens (status/set/forget/verify)
nuvira website       open the project site (capabilities/commands/docs/setup)
```

---

## 15. Agent-Nuvira as your operator — plain English → CLI

Your idea is exactly right, and the groundwork already exists. The goal: **a user should
never need to remember any of the commands above — they describe the outcome in plain
English and Agent-Nuvira performs it.**

### What already exists today

1. **A unified CLI** — every capability is one `nuvira` subcommand with stable argument
   shapes (this document proves the surface is enumerable and well-described).
2. **A tool registry** — `nuvira tools list` shows the agent's own tool-calling surface, and
   `nuvira mcp serve` can expose those tools to other agents. The same pattern applies in
   reverse: the CLI *is* a tool surface the agent can call.
3. **The dashboard Task Console + Gateway ops** already run `nuvira` commands as a real
   subprocess from the GUI (`nuvira eval run`, `nuvira gateway start`, …).
4. **RBAC + audit + redaction** already gate every sensitive write (`gateway.manage`,
   `skill.remove`, audit chain, secret redaction) — so an agent executing CLI commands
   inherits the same guardrails.

### The piece to build: a command-routing layer

Give the agent a single tool, e.g. `run_cli`, that takes a **structured intent** rather
than a raw string:

```
User: "Add Rahul's mobile +919958604222 to WhatsApp"
  └─ run_cli({ platform: "whatsapp", action: "add_contact", id: "919958604222",
              name: "Rahul", list: "verified" })
       → nuvira config gateway allow whatsapp user 919958604222
```

The routing layer's job is to map the ask to **one of the two contact lists** — and to
**ask for clarity when the answer is ambiguous** (exactly as you said):

| User says | Correct command | Why |
|---|---|---|
| "Add Rahul to WhatsApp" (vague) | **ask**: "trigger access (he can message the bot) or just send-by-name?" | ambiguous — two lists |
| "Let Rahul message the bot / respond to Rahul" | `nuvira config gateway allow whatsapp user 919958604222` | verified list (trigger) |
| "Let me send messages to Rahul by name" | `nuvira whatsapp contact add Rahul 919958604222` | send-by-name mapping |
| "Block Rahul" | `nuvira config gateway disallow whatsapp user 919958604222` | verified list |
| "Stop dashboard / kill it / bounce it" | `nuvira dashboard stop` | one intent, many phrasings |
| "Start/stop the gateway" | `nuvira gateway start` / `nuvira gateway stop` | trivial mapping |
| "Enable FAISS memory" | `nuvira memory backend --check` → then enable vector backend | diagnostics first |
| "Set up Telegram support" | `nuvira config gateway set telegram` (wizard) → `nuvira gateway start` | multi-step flow |
| "Schedule the nightly build" | `nuvira admin cron add nightly-build "0 3 * * *" build --channel slack:ops` | cron intent |
| "Is this prompt safe?" | `nuvira security scan --prompt "<text>" --json` | security intent |
| "Clear the chat history" | `nuvira history clear` | destructive → confirm |
| "Index the repo for search" | `nuvira retrieval index ./src` | retrieval intent |
| "Install the git-release skill" | `nuvira skills install acme/skills --skill release --yes` | skills intent |

### What exists today (this is now built)

- **`nuvira intent resolve "<ask>"`** — the router. Resolves a plain-English ask into the
exact `nuvira` command(s), extracts entities (phone/name/target/platform), fills manifest
placeholders, and flags ambiguity. Try it:
  ```bash
  nuvira intent resolve "stop the dashboard"                       # → nuvira dashboard stop
  nuvira intent resolve "add Rahul mobile +919958604222 to whatsapp"  # → ⚠ AMBIGUOUS (two options)
  nuvira intent resolve "run the eval suite" -j                    # machine-readable
  ```
- **`run_cli` agent tool** — the agent itself can execute: in `nuvira chat` / `nuvira execute`
(and the dashboard chat, same engine), the model resolves the ask and runs the command.
Ambiguous asks route through `ask_user`; destructive intents need explicit confirmation.
- **Dashboard chat short-circuit** — the Chat page resolves each message against the
manifest BEFORE the agent: a confident command shows a ⚡ Run-this-command card (no model
turn for deterministic tasks like "stop the dashboard"), ambiguous asks show their two
options as choices, and everything else flows to the agent normally.
- **The manifest** — `src/resources/command-manifest.json`, the machine-readable twin of
this document: ~70 intents with aliases, objective, command template, args, RBAC level,
and confirmation flag. Ambiguity pairs (verified list vs send-by-name) are first-class
via `resolutions[]` so the agent asks instead of guessing.

### Design

The router pipeline: (1) alias match with word-boundary + stop-word filtering (distinctive
words only, so "what is allowed" can't match "what is the meaning of life"), (2) entity
extraction, (3) tie-break toward the more specific and the unambiguous match ("remove from
the verified list" resolves straight to `disallow`; only vague asks get the question),
(4) placeholder fill with E.164 normalization, (5) mask sender ids in the result. Extend
it by adding an entry to the manifest (aliases + command + args) and a row to the matching
section of this document — the router picks it up automatically.

### Guardrails to bake in

- **Confirm before destructive/system-level actions** (stop, publish, clear, disallow,
  remove, shutdown) — even when the wording sounds casual ("bounce the dashboard" still
  confirms).
- **RBAC is non-negotiable** — route through `guardRbacAction` so a viewer can't stop the
  gateway or grant trigger access.
- **Never echo full numbers/secrets** — reuse `maskSenderId` in the agent's reply so the
  outcome report shows `91***`, not the raw number.
- **Dry-run by default** for anything multi-step (e.g. Telegram setup) — show the plan,
  let the user approve, then execute.

---

*Document generated from the live CLI surface (`nuvira` v3.3.x). When in doubt,
`nuvira <command> --help` shows the authoritative signature for your installed version.*
