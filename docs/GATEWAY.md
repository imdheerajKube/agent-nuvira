# Agent-Nuvira Gateway — Complete Guide

> **What is it?** The Gateway turns Agent-Nuvira into a **24×7 assistant you can
> reach from any chat app you already use** — Telegram, Discord, Slack,
> WhatsApp, Email, SMS, IRC, and 15 more. You message it in plain language
> ("fix the failing test", "deploy the backend", "what's the status?"), and it
> runs the *same* agent pipeline as `agent-nuvira chat` / `agent-nuvira execute`
> and replies in the channel — streaming live progress as it works.

> **Updated (v1.73 round):**
> - **Clean messaging output** — chat requests answered on a channel now send
>   ONLY the final natural-language answer + the model's suggested followups
>   (a readable `Try next:` list). Internal progress ("routed to…", raw tool
>   calls like `⚙ suggest_followups({…})`) never reaches the sender — it stays
>   in the audit logs. Live progress streaming still works in `chat` /
>   `execute` / the dashboard console exactly as before.
> - **WhatsApp LID fix** — WhatsApp's privacy rollout delivers DMs as random
>   `@lid` ids, not phone numbers; the bridge now translates every sender +
>   group participant to its phone-number JID (learned from Baileys
>   `lid-mapping.update`, contact sync, and the paired account itself,
>   persisted to `lid-mappings.json`), so verified senders and contacts match
>   your allow-list by number.
> - **Dashboard polish** — status recipients display resolved labels
>   (`whatsapp:Alex → +919876543210`); removing one allowed contact keeps the
>   rest; toggling a single policy flag never wipes a platform's saved users;
>   "Start gateway" runs with **no timeout** (it used to be killed after 5
>   minutes) and keeps running while you switch tabs.

This guide is written for someone who has never used Agent-Nuvira. If you
follow it top to bottom, you'll have a working channel in about 10 minutes and
full control over all 22 platforms by the end.

---

## Table of Contents

1. [What the Gateway offers](#1-what-the-gateway-offers)
2. [How it works (the mental model)](#2-how-it-works)
3. [Quick start — first channel in 10 minutes](#3-quick-start)
4. [Platform-by-platform setup (CLI)](#4-platform-by-platform-setup)
5. [Managing transports with `config gateway`](#5-managing-transports)
6. [Sending messages & channel aliases](#6-sending-messages--aliases)
7. [Guaranteed delivery (the ledger)](#7-guaranteed-delivery)
8. [Natural-language task dispatch](#8-natural-language-task-dispatch)
9. [The dashboard (GUI)](#9-the-dashboard-gui)
10. [Security](#10-security)
11. [Troubleshooting & FAQ](#11-troubleshooting--faq)
12. [All configuration keys at a glance](#12-configuration-reference)
13. [Verifying real-time inbound (Discord gateway / Slack Socket Mode)](#13-verifying-real-time-inbound)

---

## 1. What the Gateway offers

| Capability | What it means for you |
|---|---|
| **22 chat platforms** | Telegram, Discord, Slack, WhatsApp (personal bridge **and** Business API), Email (SMTP), Signal, SMS (Twilio), IRC, SimpleX, Matrix, Mattermost, DingTalk, Feishu, WeCom, Teams, Google Chat, Weixin, ntfy push, BlueBubbles (iMessage), generic Webhook, Home Assistant |
| **Two-way conversations** | Send a task from the channel → the agent runs the real pipeline → replies with the result **in the same channel** |
| **Live progress streaming** | While a task runs, the channel receives status lines: `📋 plan: 4 steps`, `🔄 [writer] …`, `$ npm test`, `✅ pipeline complete` |
| **Natural-language dispatch** | "fix the failing test" is understood as a pipeline intent and executed — no special syntax needed |
| **Guaranteed delivery** | A message that fails to send (network blip, rate limit) is **persisted and retried automatically** — nothing is lost |
| **Channel aliases** | `buff gateway send ops "nightly build done"` — friendly names for channels, persisted across restarts |
| **Scheduled jobs** | Cron-style recurring tasks that can deliver results to any channel (`buff admin cron`) |
| **Dashboard (GUI)** | Point-and-click: configure platforms, send test messages, view the delivery ledger, pair WhatsApp, run gateway commands — all from the web UI |
| **Opt-in only** | Nothing is enabled until you configure a token. No tokens → the gateway does nothing. |

---

## 2. How it works

```
            ┌─────────────────────────────────────────────────────┐
            │                   AGENT-NUVIRA                     │
            │                                                     │
  message ──▶  Platform adapter (Telegram/Discord/…)             │
            │        │                                           │
            │        ▼                                           │
            │   Gateway Registry  ──▶  NLU intent parser         │
            │        │               (understands the request)   │
            │        ▼                                           │
            │   The SAME pipeline as `chat` / `execute`          │
            │   (planner → writer → runner → reviewer)           │
            │        │                                           │
            │        ▼                                           │
            │   Reply + live status lines back to the channel    │
            │        │                                           │
            │        ▼                                           │
            │   Delivery ledger (retries failed sends)           │
            └─────────────────────────────────────────────────────┘
```

**Key point:** the Gateway is not a separate, weaker agent. A channel message
runs the exact same multi-agent pipeline that `agent-nuvira execute` runs —
planner, writer, runner, reviewer — with the same model routing, repair logic,
and memory. You get identical quality from your phone.

**Platforms come in two flavors:**

- **Full two-way (inbound + outbound):** Telegram (long-polling — no public
  URL needed), WhatsApp (Baileys bridge), Discord/Slack/WhatsApp (via the
  built-in webhook receiver), IRC, SimpleX, Email, Matrix, Signal.
- **Send-only (webhook/REST push):** ntfy, Teams, Google Chat, DingTalk,
  Feishu, WeCom, Mattermost, Weixin, BlueBubbles, generic Webhook, Home
  Assistant, SMS. These are perfect for *notifications* ("build done",
  "pipeline failed") and one-way alerts.

---

## 3. Quick start

### 3.1 Install Agent-Nuvira

```bash
npm install -g agent-nuvira
```

(Or use the one-command setup scripts — see the README "One-command setup"
section for macOS / Linux / Windows.)

### 3.2 Configure your first channel (Telegram — easiest, no public URL)

**1. Create a bot** — message [@BotFather](https://t.me/BotFather) on Telegram:
`/newbot`, pick a name, and copy the **token** it gives you (looks like
`123456789:AAH…`).

**2. Tell Agent-Nuvira about it** (interactive wizard — it writes to
`~/.buff/.env` for you):

```bash
agent-nuvira config gateway set telegram
```

Paste the token when prompted. That's it — the transport is configured.

> Want to skip the wizard? `agent-nuvira config gateway set telegram --set BUFF_TELEGRAM_TOKEN=123456789:AAH…`

**3. Start the gateway:**

```bash
agent-nuvira gateway start
```

**4. Message your bot** — open the bot in Telegram and send:
`hello` → you'll get an "I understood" line.
Then send a real task: `create a python script that prints hello world`
→ the agent plans, writes, and replies with the result — **all in Telegram**.

🎉 That's the whole quick start. Everything below is power-user depth.

### 3.3 Stopping the gateway & dashboard

Both the gateway and the dashboard run in the **foreground** of whatever
terminal launched them, so `Ctrl+C` there stops them. If they're running in
another terminal (or a background/service process), stop them from anywhere:

```bash
agent-nuvira gateway stop     # gracefully stops the running `gateway start`
agent-nuvira dashboard stop   # gracefully stops the running dashboard server
```

Each finds the live process (by its command line, falling back to the webhook
receiver port / dashboard port), sends `SIGTERM`, waits for a graceful
shutdown, then force-kills only if needed. Restart any time with
`agent-nuvira gateway start` / `agent-nuvira dashboard`.

> **GUI too:** logged-in admins can stop either from the dashboard — Admin
> panel → **Shutdown** section → *Stop gateway* / *Shut down dashboard*.

---

## 4. Platform-by-platform setup (CLI)

Every platform is enabled by setting a small set of environment variables.
The two supported ways are:

- **Interactive wizard (recommended):** `agent-nuvira config gateway set <platform>`
  asks for each value, masks secrets, and writes them to `~/.buff/.env`.
- **Direct:** `agent-nuvira config gateway set <platform> --set VAR=value` (repeatable)
  — for scripts and CI.

Check what's configured at any time:

```bash
agent-nuvira config gateway list      # every platform + ✅/❌ per env var
agent-nuvira gateway status           # adapters + reachable channels
```

### 4.1 Telegram ✅ two-way (long-polling, no public URL)

| Env var | What |
|---|---|
| `BUFF_TELEGRAM_TOKEN` | Bot token from @BotFather |

```bash
agent-nuvira config gateway set telegram
agent-nuvira gateway start
```

Telegram uses **long-polling** — it works behind NAT/firewalls with no public
address and no webhook configuration. This makes it the friendliest first
channel.

### 4.2 WhatsApp

Two completely different options:

**Option A — Personal bridge (free, no Meta account):** pairs your own phone
number as a "linked device" using a QR code (Baileys library). Works with
WhatsApp on your phone; the gateway sends **and receives**.

```bash
agent-nuvira whatsapp pair          # scan the QR with your phone
# or pair with a code instead of a QR:
agent-nuvira whatsapp pair --phone 918844433322
agent-nuvira whatsapp status        # confirm pairing
agent-nuvira gateway start
```

> Env var `BUFF_WHATSAPP_SESSION_DIR` overrides where the session is stored
> (default `~/.buff/whatsapp/session`). No token needed — the session *is* the
> credential.

**Send by name (optional):** `agent-nuvira whatsapp contact add <Name> <number>`
maps a name to a number so you can send with `agent-nuvira gateway send
whatsapp:Alex "…"`. ⚠️ **A mapped name does NOT let that number trigger the
agent** — to grant inbound access add it to the verified list:
`agent-nuvira config gateway allow whatsapp user <number>` (or the dashboard
Permissions tab). The WhatsApp panel in the dashboard shows both lists side by
side so the difference is always visible.

**Option B — WhatsApp Business Cloud API (paid, official):** for businesses
with a Meta Business account, WhatsApp Cloud API app, and a phone number.

```bash
agent-nuvira config gateway set whatsapp_cloud
# needs: BUFF_WHATSAPP_TOKEN (system-user token) + BUFF_WHATSAPP_PHONE_ID
```

The platform id is `whatsapp_cloud` (distinct from the personal bridge
`whatsapp`) — send to it with `whatsapp_cloud:+1555…`.

### 4.3 Discord ✅ two-way (webhook receiver or bot)

Two options:

**Webhook (simplest, send + receive):**

```bash
agent-nuvira config gateway set discord
# needs: BUFF_DISCORD_WEBHOOK_URL (channel → Integrations → Webhooks → New webhook)
agent-nuvira gateway start --port 8787
```

**Bot token (full two-way with commands, no public URL):**

```bash
agent-nuvira config gateway set discord
# needs: BUFF_DISCORD_BOT_TOKEN (Discord Developer Portal → Bot → Reset token)
agent-nuvira gateway start --port 8787
```

With a bot token, inbound messages arrive over the **Discord Gateway
(WebSocket)** — the bot dials out, so no public URL or tunnel is needed. Enable
the **Message Content** intent in the Developer Portal, otherwise message text
and attachments are not delivered. Attachments are downloaded and extracted
like any other inbound document.

**Webhook inbound** uses the built-in receiver on `127.0.0.1:8787` at
`POST /discord`, which requires a **publicly reachable** URL (e.g. an
`ngrok http 8787` tunnel or your own domain). Outbound (sending to a Discord
channel) needs no public URL either way.

### 4.4 Slack ✅ two-way (webhook receiver or bot)

```bash
agent-nuvira config gateway set slack
# needs: BUFF_SLACK_BOT_TOKEN and/or BUFF_SLACK_WEBHOOK_URL
# inbound signature verification: BUFF_SLACK_SIGNING_SECRET
# Socket Mode (no public URL): BUFF_SLACK_APP_TOKEN (xapp-…)
agent-nuvira gateway start --port 8787
```

Inbound has two options:

- **Socket Mode (no public URL):** enable Socket Mode in your Slack app, create
  an app-level token with the `connections:write` scope, and set
  `BUFF_SLACK_APP_TOKEN`. The gateway opens a WebSocket and receives the same
  `event_callback` events the Events API posts — attachments included. Slack
  files are downloaded with the bot token.
- **Events API:** point the app's "Request URL" at `POST /slack` on a public
  URL. **Strongly recommended:** set `BUFF_SLACK_SIGNING_SECRET` so inbound
  requests are signature-verified.

### 4.5 Email ✅ two-way (SMTP relay)

```bash
agent-nuvira config gateway set email
# needs: BUFF_SMTP_HOST (e.g. smtp.gmail.com:587) + BUFF_SMTP_USER
# optional: BUFF_SMTP_PASS (absent = local/trusted relay)
agent-nuvira gateway start
```

The gateway can send email via your SMTP relay. (Inbound email reading depends
on the relay; for most setups this is a notification channel.)

### 4.6 SMS (Twilio) — send-only

Uses the **same Twilio credentials as Hermes** — if you already have those,
they just work:

```bash
agent-nuvira config gateway set sms
# needs: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
agent-nuvira gateway send sms:+15551234567 "Deploy finished successfully"
```

### 4.7 IRC ✅ two-way (RFC 1459 over TLS)

```bash
agent-nuvira config gateway set irc
# needs: IRC_SERVER (e.g. irc.libera.chat)
# optional: IRC_PORT, IRC_NICKNAME, IRC_CHANNEL, IRC_USE_TLS, IRC_NICKSERV_PASSWORD
agent-nuvira gateway start
```

### 4.8 SimpleX ✅ two-way (via local daemon)

```bash
# run the SimpleX chat daemon locally (default ws://127.0.0.1:5225)
agent-nuvira config gateway set simplex
# needs: SIMPLEX_WS_URL
# restrict who can talk to the agent: SIMPLEX_ALLOWED_USERS
agent-nuvira gateway start
```

### 4.9 Send-only webhook platforms

These all follow the same pattern — paste one webhook URL:

| Platform | Env var(s) |
|---|---|
| DingTalk robot | `BUFF_DINGTALK_WEBHOOK_URL` |
| Feishu bot | `BUFF_FEISHU_WEBHOOK_URL` |
| WeCom group bot | `BUFF_WECOM_WEBHOOK_URL` |
| Mattermost | `BUFF_MATTERMOST_WEBHOOK_URL` |
| Microsoft Teams | `BUFF_TEAMS_WEBHOOK_URL` |
| Google Chat space | `BUFF_GOOGLE_CHAT_WEBHOOK_URL` |
| ntfy push | `BUFF_NTFY_TOPIC` (+ optional `BUFF_NTFY_URL`, `BUFF_NTFY_TOKEN`) |
| Weixin (iLink bot) | `BUFF_WEIXIN_TOKEN` |
| BlueBubbles (iMessage) | `BUFF_BLUEBUBBLES_URL` + `BUFF_BLUEBUBBLES_PASSWORD` |
| Generic webhook | `BUFF_WEBHOOK_URL` |
| Home Assistant | `HASS_TOKEN` (+ optional `HASS_URL`, default `http://homeassistant.local:8123`) |

```bash
# example: send build notifications to a Teams channel
agent-nuvira config gateway set teams
agent-nuvira gateway send teams:general "nightly build passed ✅"
```

### 4.10 Matrix ✅ two-way

```bash
agent-nuvira config gateway set matrix
# needs: BUFF_MATRIX_HOMESERVER (e.g. https://matrix.org) + BUFF_MATRIX_ACCESS_TOKEN
agent-nuvira gateway start
```

### 4.11 Signal — two-way via local signal-cli-rest-api

```bash
agent-nuvira config gateway set signal
# needs: BUFF_SIGNAL_ACCOUNT (your registered number)
# the REST endpoint defaults to a local signal-cli-rest-api
agent-nuvira gateway start
```

---

## 5. Managing transports

```bash
agent-nuvira config gateway list          # every platform + ✅/❌ status
agent-nuvira config gateway set telegram  # interactive wizard
agent-nuvira config gateway set sms --set TWILIO_ACCOUNT_SID=AC… --set TWILIO_AUTH_TOKEN=… --set TWILIO_PHONE_NUMBER=+1…
agent-nuvira config gateway remove telegram   # remove a transport (asks to confirm)
agent-nuvira config gateway remove sms --yes  # skip the confirmation
```

- Values are stored in **`~/.buff/.env`** (override with `BUFF_ENV_FILE`).
- Secrets are prompted **masked** and displayed **redacted** (`••••`).
- Re-running `set` keeps existing values (press Enter to keep current).
- After any change: restart the gateway or dashboard (`agent-nuvira gateway
  start` / `agent-nuvira dashboard`).

### 5.1 Validated senders — who may trigger the agent

By default **anyone** who reaches a configured channel can trigger the agent
(and its model spend). For a public-facing number, restrict it to a
**validated contact list** per platform — only those senders may run tasks,
and (with `silent` mode) unknown senders get **no reply at all**:

```bash
# Allow a mobile number / user id / group id to trigger on a platform
agent-nuvira config gateway allow whatsapp user 919876543210
agent-nuvira config gateway allow telegram group g-family

# Remove one (or several)
agent-nuvira config gateway disallow whatsapp user 919876543210

# How unapproved senders are handled: silent (no reply — DEFAULT, hard
# policy) or polite (⛔ reply — explicit opt-in)
agent-nuvira config gateway reply whatsapp silent
agent-nuvira config gateway reply whatsapp polite
```

### 5.2 Status recipients — always get pipeline completion summaries

Pipeline completions are normally only sent to whoever triggered them. A
**status recipient** is a contact/group that ALWAYS receives the completion
summary (`✅ Done — …` / `❌ Failed — …`), regardless of who ran the task:

```bash
agent-nuvira config gateway notify add whatsapp:Alex
agent-nuvira config gateway notify add telegram:123456 slack:ops
agent-nuvira config gateway notify list
agent-nuvira config gateway notify remove slack:ops
```

- Targets are **aliases or `platform:channelId`** — the same resolution as
  `agent-nuvira gateway send` (aliases live in `~/.buff/gateway/aliases.json`).
- Stored in `~/.buff/buffconfig.json` under `gateway.statusRecipients`;
  applied to a running gateway **immediately** (re-read per pipeline).
- Also editable in the dashboard: **Agent Hub → Channels → 📊 Status recipients**.
- Best for an ops/team channel: "every build result lands in #ops even when
  someone runs it from their DM".

- Stored in `~/.buff/buffconfig.json` under `gateway.policies` — the same
  data the dashboard **Agent Hub → Channels → Permissions** page edits.
- **Applied immediately** to a running gateway (policies are re-read per
  inbound message — no restart).
- Equivalent env vars (useful for containers): `BUFF_GATEWAY_ALLOWED_USERS`,
  `BUFF_GATEWAY_ALLOWED_USERS_WHATSAPP`, `BUFF_GATEWAY_ALLOWED_GROUPS[_<PLATFORM>]`,
  `BUFF_GATEWAY_REQUIRE_MENTION[_<PLATFORM>]`.

---

## 6. Sending messages & aliases

### 6.1 Send to a channel directly

```bash
# platform:channelId
agent-nuvira gateway send telegram:123456789 "hello from the CLI"
agent-nuvira gateway send sms:+15551234567 "build done"
agent-nuvira gateway send slack:C0123 "nightly report attached"
```

### 6.2 Aliases — friendly names, persisted

```bash
agent-nuvira gateway alias add ops slack C0123
agent-nuvira gateway alias add support telegram 123456789
agent-nuvira gateway send ops "deploying v1.71.0…"
agent-nuvira gateway send support "we shipped 🎉"
```

Aliases live in `~/.buff/gateway/aliases.json` and survive restarts. List them
with `agent-nuvira gateway status` (they show under "Reachable channels").

### 6.3 Verify what's reachable

```bash
agent-nuvira gateway status
```

Shows every platform with ✅/⬜, the `X/22 platforms configured` count, and all
registered aliases.

---

## 7. Guaranteed delivery

A channel send is **never fire-and-forget**. When `send` fails (network blip,
rate limit, channel temporarily unreachable), the message is persisted to a
delivery ledger (`~/.buff/gateway/delivery.json`) and retried with exponential
backoff while the gateway runs.

- **Backoff:** starts at 15s, doubles, caps at 10 minutes.
- **Max attempts:** 5, then the entry is marked `failed` (visible to you).
- **Opportunistic flush:** a successful send also drains any due pending
  entries for the same platform.
- **Survives restarts:** a one-shot `buff gateway send` that failed is NOT
  lost — the next `agent-nuvira gateway start` drains it.

```bash
agent-nuvira gateway delivery            # view pending / sent / failed entries
agent-nuvira gateway delivery --flush    # force-drain due pending entries NOW
```

---

## 8. Natural-language task dispatch

The gateway understands plain-language **task intents** and runs the full
pipeline for them:

| You send | What happens |
|---|---|
| `fix the failing test` | NLU parses intent → pipeline runs planner/writer/runner/reviewer |
| `create a python CLI` | Same — a full project build |
| `explain this repo` | Pipeline intent → summarized answer |
| `hello` | Non-task message → polite "I understood" line with a hint |
| anything else | Same help line (or silence with `pipelineOnly`) |

**The allow-list matters:** by default **every** channel that reaches the
gateway can trigger the pipeline. To restrict who can run tasks:

```
BUFF_GATEWAY_ALLOW_IDS=telegram:123456789,slack:C0123
```

Channels not on the list get **no reply at all** (silent, hard policy)
instead of running anything. (Set it in `~/.buff/.env`.)

---

## 9. The dashboard (GUI)

Start the web dashboard:

```bash
agent-nuvira dashboard                  # http://localhost:3030
agent-nuvira dashboard --port 8080      # custom port
agent-nuvira dashboard --host 0.0.0.0   # reachable from other machines
```

Then use the **Agent Hub → Channels** tab and the **Gateway** page:

### 9.1 Agent Hub → Channels tab

- **Delivery ledger** — pending / sent / failed sends, with retry state and
  error text.
- **Channel aliases** — see what's registered.
- **Test a channel** — a send form (`target` + `text`) that goes through the
  *same* gateway the CLI uses: `ops` or `telegram:123456789`, then "Send".
- **WhatsApp panel** — pair / unpair the personal bridge, watch pairing state
  and QR events live, and see the **send-by-name contacts** (the
  `buff whatsapp contact add` mappings) — with a clear note that those names
  are for *sending* by name only and do **not** grant trigger access.
- **Platform transports** — the same `config gateway` wizard as a GUI: expand
  a platform, fill in the fields, save (writes `~/.buff/.env`).
- **Permissions** — per-platform **validated-sender** controls (who may
  trigger the agent, and how unapproved senders are handled). This is the
  GUI for `buff config gateway allow/disallow/reply`:

> ⚠️ **Two different "contacts" — don't mix them up.**
> - **Send-by-name contacts** (`buff whatsapp contact add <Name> <number>`, the
>   WhatsApp bridge panel) — let *you* send *to* someone by name
>   (`buff gateway send whatsapp:Alex "…"`). They do **NOT** let that number
>   trigger the agent.
> - **Verified list** (this Permissions tab, `buff config gateway allow
>   <platform> user <id>`) — the only thing that decides **who may trigger
>   the agent** inbound, on any platform (WhatsApp bridge, WhatsApp Cloud
>   API, Telegram, email, …). A WhatsApp number in the bridge contacts file
>   but NOT in the verified list will be refused when it messages you.
  - **Verified list rule** — a platform's **Allowed users** list has three
    states: present with entries = **only those senders** may trigger;
    present but **blank** = **no one** may trigger; the token `Allow-All`
    (case-insensitive) = **skip the verifier**, anyone may trigger. A list
    that was never configured stays the legacy open default.
  - **Add a person as Name + Contact No** — same as the CLI
    (`buff whatsapp contact add <Name> <number>`): type a Name and a Contact
    No / sender id, hit **+ User**. Named contacts render as `Alex
    (+919876543210)` on the verified list and are saved across platforms
    (WhatsApp numbers, Telegram ids, email addresses, …).
  - **📇 Saved contacts (validated list)** — a table of every saved contact
    (name, platform, contact) with a ✅ verified badge when its id is in the
    platform's allow-list; ✕ removes it from both the list and the contacts
    store. Removing ONE entry never blanks the rest of the saved list.
  - **Allowed groups** — add/remove **group IDs** per platform (the
    `allowedGroups` list).
  - **Silent drop (default, hard policy)** — unapproved senders get **no
    reply at all and no processing** (they never learn a bot exists). Polite
    `⛔` refusals are an explicit opt-in (`silentDrop: false`).
  - **Require mention** — in groups the agent only reacts when addressed
    (`buff fix the tests`).
  - **Disabled** — the platform cannot trigger the agent at all.
  - Changes are written to `~/.buff/buffconfig.json` (`gateway.policies`)
    plus `~/.buff/gateway/contacts.json` (the name → id store) and apply to
    the **running gateway immediately** — policies are re-read per inbound
    message, so no restart is needed.
  - **📊 Status recipients** — contacts/groups that ALWAYS receive the
    pipeline completion summary, whoever triggered it (e.g. `whatsapp:Alex`,
    `slack:ops`). Same save button; stored under `gateway.statusRecipients`.

> The dashboard process must have the same env tokens loaded (it reads
> `~/.buff/.env` at startup). If you configured a platform from the CLI,
> restart the dashboard so it picks it up.

### 9.2 Gateway page (🌐)

A GUI terminal for gateway operations — presets for `gateway status`,
`gateway delivery`, `gateway start --no-events`, plus a free-form input for
any `gateway` or `admin` command (`gateway alias add ops slack C0123`…).
Live output streams in; press **Cancel** to stop a foreground run.

### 9.3 Admin & RBAC

The Admin panel also has a **Shutdown** section (admin only): *Stop gateway*
and *Shut down dashboard* — the GUI twin of `agent-nuvira gateway stop` /
`agent-nuvira dashboard stop`. Stopping the dashboard disconnects the page and
exits the server (restart with `agent-nuvira dashboard`); stopping the gateway
makes channels stop responding until you run `agent-nuvira gateway start`
again.

Dashboard actions (sending test messages, configuring platforms, pairing
WhatsApp) require an **admin** role. On first run the dashboard shows a
one-time **Admin Setup** screen — create the admin user there. Manage roles
from the CLI: `agent-nuvira admin role add <user> <admin|operator|viewer>`,
`agent-nuvira admin role list`, `agent-nuvira admin whoami`. Roles: `admin`
(everything) / `operator` (operate the gateway) / `viewer` (read-only). See
`agent-nuvira admin --help`.

---

## 10. Security

| Concern | Default & how to harden |
|---|---|
| Webhook receiver exposure | Binds to **127.0.0.1** by default. Use `--host 0.0.0.0` ONLY when you have a tunnel/domain, and then set signature secrets |
| Slack inbound spoofing | Set `BUFF_SLACK_SIGNING_SECRET` → HMAC `X-Slack-Signature` verified |
| WhatsApp inbound spoofing | Set `BUFF_WHATSAPP_APP_SECRET` → `X-Hub-Signature-256` verified |
| Who can trigger pipelines | `BUFF_GATEWAY_ALLOW_IDS=platform:channelId,…` — empty means anyone |
| Who can trigger per platform | `allowedUsers` / `allowedGroups` via `buff config gateway allow <platform> <user|group> <id…>` (or env `BUFF_GATEWAY_ALLOWED_USERS[_<PLATFORM>]`); empty = anyone |
| How refusals behave | **Silent by default (hard policy)** — unapproved senders get NO reply and NO processing. `buff config gateway reply <platform> polite` opts back into the `⛔` message |
| Group chatter | `requireMention` — the agent only reacts when addressed in groups |
| Token storage | Written to `~/.buff/.env` (mode-restricted); never logged; redacted in `config gateway list` |
| SimpleX access | `SIMPLEX_ALLOWED_USERS` restricts who can talk to the agent |
| IRC access | `IRC_NICKSERV_PASSWORD` + allow-listing via nick |

**Rule of thumb:** a public tunnel (`ngrok`, cloudflare tunnel) makes inbound
channels work, but always pair it with `BUFF_GATEWAY_ALLOW_IDS` and the
platform signature secrets.

---

## 11. Troubleshooting & FAQ

**Q: `agent-nuvira gateway start` says "No adapters configured".**
A: You haven't set any tokens. Run `agent-nuvira config gateway set telegram`
(or any platform) first, then restart.

**Q: I configured a platform but `gateway status` still shows ⬜.**
A: The dashboard/gateway reads `~/.buff/.env` **at startup**. Restart
`agent-nuvira gateway start` / `agent-nuvira dashboard`.

**Q: Can I receive messages without a public URL?**
A: Yes — Telegram (long-polling) and WhatsApp (Baileys) need no public URL.
Discord/Slack inbound need a publicly reachable webhook endpoint.

**Q: A send failed — is the message lost?**
A: No. Check `agent-nuvira gateway delivery`; it will retry automatically
while the gateway runs, or use `--flush`.

**Q: The agent replied "This channel is not authorized…"**
A: Add that channel to `BUFF_GATEWAY_ALLOW_IDS` (format `platform:channelId`).

**Q: How do I stop the gateway / dashboard without closing their terminal?**
A: `agent-nuvira gateway stop` and `agent-nuvira dashboard stop` from any
terminal (or the Admin panel → Shutdown buttons). Both are also what `Ctrl+C`
does in the foreground terminal.

**Q: How do I know which models the gateway uses?**
A: The gateway uses the same auto-routing and provider config as everything
else. `agent-nuvira config` shows your providers; `agent-nuvira models` lists
them. Add provider keys via `agent-nuvira config set provider.<name>.apiKey …`.

**Q: Can scheduled jobs send to channels?**
A: Yes — `agent-nuvira admin cron add nightly "*/5 * * * *" build --args '{"goal":"…"}' --channel ops`
delivers cron results to a channel alias. See `agent-nuvira admin cron --help`.

**Q: WhatsApp pairing failed / session lost.**
A: Re-run `agent-nuvira whatsapp pair`. The session persists on disk at
`~/.buff/whatsapp/session`; the gateway auto-reconnects on socket death.

**Q: Can multiple channels be live at once?**
A: Yes — configure several platforms; `agent-nuvira gateway start` starts
every configured adapter. A message on any of them triggers the pipeline.

---

## 12. Configuration reference

| Env var | Platform | Direction |
|---|---|---|
| `BUFF_TELEGRAM_TOKEN` | Telegram | two-way |
| `BUFF_DISCORD_BOT_TOKEN` / `BUFF_DISCORD_WEBHOOK_URL` | Discord | two-way |
| `BUFF_SLACK_BOT_TOKEN` / `BUFF_SLACK_WEBHOOK_URL` / `BUFF_SLACK_SIGNING_SECRET` | Slack | two-way |
| `BUFF_WHATSAPP_SESSION_DIR` | WhatsApp (personal bridge — pair via `whatsapp pair`) | two-way |
| `BUFF_WHATSAPP_TOKEN` (+ `BUFF_WHATSAPP_PHONE_ID`, `BUFF_WHATSAPP_APP_SECRET`) | WhatsApp Business Cloud | two-way |
| `BUFF_SMTP_HOST` / `BUFF_SMTP_USER` / `BUFF_SMTP_PASS` | Email | two-way |
| `BUFF_SIGNAL_ACCOUNT` | Signal | two-way |
| `BUFF_MATRIX_HOMESERVER` / `BUFF_MATRIX_ACCESS_TOKEN` | Matrix | two-way |
| `IRC_SERVER` (+ port/nickname/channel/TLS/nickserv) | IRC | two-way |
| `SIMPLEX_WS_URL` (+ `SIMPLEX_ALLOWED_USERS`) | SimpleX | two-way |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | SMS | send |
| `BUFF_DINGTALK_WEBHOOK_URL` | DingTalk | send |
| `BUFF_FEISHU_WEBHOOK_URL` | Feishu | send |
| `BUFF_WECOM_WEBHOOK_URL` | WeCom | send |
| `BUFF_MATTERMOST_WEBHOOK_URL` | Mattermost | send |
| `BUFF_WEBHOOK_URL` | Generic webhook | send |
| `BUFF_BLUEBUBBLES_URL` / `BUFF_BLUEBUBBLES_PASSWORD` | BlueBubbles (iMessage) | send |
| `BUFF_NTFY_TOPIC` (+ URL/TOKEN) | ntfy push | send |
| `BUFF_TEAMS_WEBHOOK_URL` | Microsoft Teams | send |
| `BUFF_GOOGLE_CHAT_WEBHOOK_URL` | Google Chat | send |
| `BUFF_WEIXIN_TOKEN` | Weixin | send |
| `HASS_TOKEN` (+ `HASS_URL`) | Home Assistant | send |
| `BUFF_GATEWAY_ALLOW_IDS` | (gateway-wide) allow-list | — |

**CLI command summary:**

```bash
agent-nuvira config gateway list|set|remove     # manage platform transports
agent-nuvira gateway status                     # adapters + reachable channels
agent-nuvira gateway send <target> <text>       # send to alias or platform:channelId
agent-nuvira gateway alias add|remove           # friendly channel names
agent-nuvira gateway delivery [--flush]         # guaranteed-delivery ledger
agent-nuvira gateway start [--port N] [--host IP] [--no-events]  # run the gateway
agent-nuvira whatsapp pair|status               # personal WhatsApp bridge
agent-nuvira dashboard                          # GUI for all of the above
```

---

## 13. Verifying real-time inbound

### What this pass is for

Discord (Gateway WebSocket) and Slack (Socket Mode) inbound is covered by
`tests/gateway/realtime.test.ts`, which drives the real handshake and event frames
against a **scripted socket**. That proves the protocol handling, not your app
setup: a token whose intents or scopes are wrong fails the same way an empty inbox
does. These steps are the manual complement — about 10 minutes per platform.

Set the token the way every other gateway key is set (`agent-nuvira config gateway
set discord` writes it to the config env file; `NUVIRA_*` is accepted as well as
`BUFF_*`), then run `agent-nuvira gateway start` in a terminal you can watch.

### Where to watch, for both platforms

| Signal | Where |
|---|---|
| Transport connected / socket dropped | the `gateway start` terminal (`Discord gateway: connected — waiting for HELLO`, `Slack Socket Mode: connected`; a drop logs `socket closed — reconnecting with backoff`) |
| Attachment bytes landed | `.nuvira/artifacts/inbound/` (override with `NUVIRA_ARTIFACTS_DIR`) — files are swept after 7 days, or sooner past 200 MB |
| The model actually saw the file | the reply answers the document's content, not its caption |
| A file that could not be read | the sender gets a reply naming the reason, and the dashboard → **Channels** inbox shows an `attachment_failed` row with that reason |

Attachments above **20 MB** are skipped without a download attempt, so the turn runs
with the caption only.

### Discord checklist

1. **Enable the Message Content intent** — Developer Portal → your app → *Bot* →
   *Privileged Gateway Intents* → **Message Content**. Without it Discord sends
   `content: ""` and no `attachments`, so inbound messages are dropped as empty.
   This is the single most common cause of "the bot is online but never answers".
2. **Copy the bot token** (Bot → *Reset Token*) and set it:
   ```bash
   agent-nuvira config gateway set discord
   # needs: BUFF_DISCORD_BOT_TOKEN
   ```
3. **Invite the bot** with the `bot` scope plus *View Channels*, *Send Messages*,
   *Read Message History* (Discord no longer grants these by default).
4. **Start it:** `agent-nuvira gateway start`. No public URL, no tunnel, no
   `--port` forwarding is needed — the bot dials out.
5. **Expect** `Discord gateway: connected — waiting for HELLO` in the terminal.
   The socket URL is resolved via `GET /gateway/bot` with the token; if that call
   fails the source falls back to the public gateway and then keeps
   reconnecting — repeated `socket closed — reconnecting with backoff` lines mean
   the token is wrong, not that the network is down.
6. **Text:** send a plain message in a channel the bot can read → expect a reply in
   that channel.
7. **Document:** send a PDF, DOCX, XLSX or PPTX with a question about it → a file
   appears in `.nuvira/artifacts/inbound/` and the reply reflects the document's
   contents.
8. **Retry-bait:** send a legacy `.doc` (or an empty/corrupt PDF) → the sender gets
   a reply naming the reason and the formats that work, and a Channels inbox row
   labelled `attachment_failed`. The model must **not** answer as if it read it.
9. **Voice note:** send an audio attachment → the reply is grounded in the
   transcript. If the whisper backend is not installed the sender is told so,
   rather than being answered with silence.
10. **Image:** send a screenshot with a question → an artifact is saved and the
    turn carries a `[Image: …]` reference for `describe_image`.

### Slack checklist

1. **Enable Socket Mode** — api.slack.com/apps → your app → *Socket Mode* → on.
2. **Create an app-level token** with the `connections:write` scope → `xapp-…`:
   ```bash
   agent-nuvira config gateway set slack
   # needs: BUFF_SLACK_APP_TOKEN   (xapp-…, Socket Mode)
   #        BUFF_SLACK_BOT_TOKEN   (xoxb-…, replies + file downloads)
   ```
   Without `connections:write`, `apps.connections.open` fails and the terminal
   shows the source retrying — it will not look like a message problem.
3. **Bot scopes** — OAuth & Permissions: `chat:write`, `im:history`,
   `app_mentions:read`, and **`files:read`**. `files:read` is what makes
   `url_private*` downloads work; without it the attachment is dropped and the
   turn runs on the caption alone (no error reaches the sender).
4. **Subscribe to events** — Event Subscriptions → *Subscribe to bot events*:
   `message.im` and/or `app_mention`. Event Subscriptions does **not** need a
   Request URL in Socket Mode.
5. **Reinstall the app** (tokens are issued per install; scopes added later are
   inert until you reinstall).
6. **Start it:** `agent-nuvira gateway start` → expect
   `Slack Socket Mode: connected`.
7. **Expect** a DM to the bot to be answered. `Slack Socket Mode: server asked us
   to reconnect` is Slack rotating the connection — normal, not a failure.
8. **Document:** DM a PDF → a file appears in `.nuvira/artifacts/inbound/`, the
   reply reflects its contents, and an unreadable file triggers the same naming
   auto-reply as Discord.
9. **Threads/DMs:** confirm a `D…` channel is treated as a DM and a `C…` channel
   as a group (per-sender allow-lists in §10 depend on that distinction).

### What a pass looks like

| Layer | Passing evidence |
|---|---|
| Transport | `connected` in the terminal, with no repeating reconnect lines |
| Hydration | a new file under `.nuvira/artifacts/inbound/` matching the sent file |
| Turn | the reply's content could only come from inside the document |
| Failure path | unreadable → a reason-naming auto-reply + an `attachment_failed` inbox row |
| Cleanup | `.nuvira/artifacts/inbound/` does not grow without bound (hourly sweep) |

If everything above passes for text but a document never produces a row in
`.nuvira/artifacts/inbound/`, the transport is fine and the download is not —
check the Discord *Message Content* intent or Slack's `files:read` before looking
at extraction.

---

*This document is part of the Agent-Nuvira documentation set. For the
reasoning behind the gateway's design, see `DESIGN_DECISIONS.md`. For
architecture details, see `ARCHITECTURE.md`.*
