# IRC Protocol Deep-Dive — the "heavy protocol" connector

A wire-level walkthrough of agent-nuvira's IRC adapter (`src/gateway/adapters.ts`,
`IrcAdapter` + `ircSend`), built to RFC 1459 with Hermes
`plugins/platforms/irc` parity. IRC is the *heavy* connector of the gateway
campaign: unlike the webhook/HTTP/SMTP send-only adapters, it is a **stateful,
line-based chat protocol** that needs a full-time connection, a registration
state machine, keepalives, and live receive — not a single request/response
round trip.

```
┌─────────────────────────┐      TCP/TLS (6667/6697)      ┌─────────────────┐
│  agent-nuvira IrcAdapter│ ─────  persistent socket ────▶ │   IRC server    │
│                         │                                │  (Libera, etc.) │
│  start() → register     │ ◀─── 001 / 433 / PING / NICK ──┤                 │
│  JOIN #ops              │                                │                 │
│  PRIVMSG (send, 0.3s    │ ──── PRIVMSG #ops :reply ────▶ │                 │
│  flood guard)           │ ◀─── PRIVMSG (inbound) ────────┤                 │
└─────────────────────────┘                                └─────────────────┘
```

## 1. Wire format (RFC 1459)

Every server message is a single line terminated by `\r\n`:

```
[:<prefix>] <command> <params...> [:<trailing>]
```

- **prefix** — `nick!user@host` for users, `server.name` for servers. Absent on
  client-originated commands.
- **command** — a 3-digit numeric (001, 366, 433…) or a verb (PING, PRIVMSG,
  NICK, JOIN…).
- **params** — space-separated, middle parameters.
- **trailing** — everything after ` :`; may contain spaces, `:` and control
  characters. The last parameter.

`parseIrcLine()` in the adapter mirrors Hermes' `_parse_irc_message()` exactly:
strip the prefix, split the trailing at ` :`, then split the remainder on
spaces (trailing re-appended to params when non-empty).

```
:alice!user@host PRIVMSG #ops :agent-nuvira: run the tests
└─prefix───────┘ └─cmd──┘ └─mid─┘ └trailing──────────────┘
```

**Line-size discipline.** The wire limit is ~512 bytes; the adapter budgets
`PRIVMSG <target> :` + `\r\n` and keeps every content line ≤510 bytes on the
wire. `splitIrcMessage()` does this byte-aware (not char-aware): a binary
search finds the longest UTF-8-safe cut, preferring the last space boundary
(Hermes `_split_message` parity), so multibyte sequences are never torn.

## 2. Registration state machine (the listener)

When `start(handler)` is called the adapter opens the persistent socket and
runs this sequence:

```
connect → PASS <server password>?  →  NICK agent-nuvira  →  USER agent-nuvira 0 * :Agent-Nuvira gateway
                │
                ▼  server replies 001 RPL_WELCOME (params[0] = confirmed nick)
   currentNick ← params[0]        (server may have mangled/collided the nick)
                │
                ├─ IRC_NICKSERV_PASSWORD set → PRIVMSG NickServ :IDENTIFY <pw>
                └─ IRC_CHANNEL set           → JOIN #ops        (confirmed by 366)
```

Two numerics get special handling during/after registration:

| Numeric | Meaning | Handling |
|---|---|---|
| **001** | RPL_WELCOME | Registration complete; adopt the server-confirmed nick; IDENTIFY + JOIN |
| **433** | ERR_NICKNAMEINUSE | Nick collision → retry `nick_`, `nick_1`, `nick_2`… (Hermes parity) |

Nick changes are tracked throughout: a `NICK` message whose prefix is our own
nick updates `currentNick`, so self-echo filtering and addressing always use
the live nick.

## 3. Keepalive

The server pings idle clients and drops silent ones:

```
server:  PING :keepalive-token
client:  PONG :keepalive-token     ← sent verbatim, payload echoed
```

Without this the listener would be reaped within minutes. The PING/PONG test
asserts the round trip against the mock server.

## 4. Receive path (PRIVMSG → InboundMessage)

Incoming `PRIVMSG <target> :<text>` is processed in this order (mirroring
Hermes `plugins/platforms/irc/adapter.py::_handle_line`):

1. **Self-echo filter** — `sender.nick == currentNick` (case-insensitive) is
   dropped. The server relays our own PRIVMSGs back to us; without this the
   agent would talk to itself in a loop.
2. **CTCP** — `\x01ACTION <text>\x01` (a `/me`) becomes `* <nick> <text>`;
   every other CTCP (`\x01VERSION\x01`, …) is ignored.
3. **Channel vs DM** — target starting with `#`/`&` is a channel (channelId =
   the channel), anything else is a DM to the bot (channelId = sender nick).
4. **Channel addressing** — in channels the bot only reacts when addressed:
   `nick:`, `nick,` or `nick ` prefix (case-insensitive); the prefix is
   stripped before dispatch. Unaddressed channel chatter is ignored — this is
   what keeps the agent from answering every line in a busy channel. DMs are
   always accepted.
5. **Allowlist** — `IRC_ALLOWED_USERS` (comma list) restricts who may talk to
   the bot, compared case-insensitively. Unset = allow all (Hermes parity:
   `allowed_users: []` means allow all).
6. **Dispatch** — `handler({ platform: 'irc', channelId, text, from: nick })`.

The socket is a full-time relay: `start()` also survives server drops via a
reconnect with backoff (`reconnectDelayMs`, default 5s), and `stop()` sends
`QUIT` and tears the socket down.

## 5. Send path

Two delivery modes, chosen per call:

- **Live listener (primary)** — when the listener socket is connected,
  `send()` writes `PRIVMSG <target> :<line>` straight onto it, one line every
  **0.3s** (Hermes' flood guard — IRC servers kill clients that burst). Using
  the listener socket is deliberate: a second connect-per-send connection
  claiming the same nick would collide with the listener (433 / kill) — one
  IRC identity, one connection, exactly like Hermes. Divergence (documented):
  the listener path returns success once the bytes are written — error
  numerics (401/404/442) arrive asynchronously on the shared connection and
  are not attributed to a specific send, so a silent failed delivery may be
  recorded as success in the delivery ledger (Hermes behaves the same way;
  the strict numeric-watch only exists on the connect-per-send fallback).
- **Connect-per-send fallback (`ircSend`)** — when no listener is running
  (pure outbound use, or before `start()`), it opens a short-lived
  connection: PASS → NICK → USER → wait 001 → IDENTIFY → JOIN channel targets
  (confirmed by 366, settle-timer fallback) → PRIVMSG line(s) → grace window
  for error numerics (401/404/442…) → QUIT. Returns `false` on any error
  numeric; CRLF injection in the target is rejected before connecting.

## 6. Environment surface

| Env var | Meaning | Default |
|---|---|---|
| `IRC_SERVER` | Server host | — (required to configure) |
| `IRC_PORT` | Port | `6697` (TLS) |
| `IRC_USE_TLS` | `1/true/yes` = TLS (auto-on for 6697) | `true` on 6697 |
| `IRC_NICKNAME` | Bot nick | `agent-nuvira` |
| `IRC_CHANNEL` | Home channel (JOIN + fallback send target) | — |
| `IRC_SERVER_PASSWORD` | Server password (PASS) | — |
| `IRC_NICKSERV_PASSWORD` | NickServ IDENTIFY | — |
| `IRC_ALLOWED_USERS` | Comma-list of allowed nicks (extension) | — (allow all) |
| `IRC_RECONNECT_DELAY_MS` | Reconnect backoff | `5000` |

`IRC_ALLOWED_USERS` is our env-var extension of Hermes' config.yaml
`allowed_users` key — same semantics, env-delivered (consistent with the rest
of the gateway's env-var credential surface).

## 7. Hermes parity & deliberate divergences

| Aspect | Hermes | agent-nuvira |
|---|---|---|
| Env vars | `IRC_*` (same names) | Same, plus `IRC_ALLOWED_USERS` extension |
| Registration | PASS → NICK → USER → 001 | Same |
| Nick collision | `_`, `_1`, `_2`… | Same |
| PING/PONG | Answered | Same |
| Channel addressing | `nick:`, `nick,`, `nick ` | Same |
| Self-echo filter | `sender == current nick` | Same |
| CTCP | ACTION → text, others dropped | Same |
| Allowed users | config.yaml `allowed_users` | Same semantics via env |
| IDENTIFY → JOIN | 2s sleep between | No artificial sleep (benign divergence) |
| Send path | Persistent connection | Listener socket when running, connect-per-send fallback |
| Split | `_split_message` ≤510 bytes | Same algorithm |

## 8. Tests

The mock IRC server in `tests/gateway/adapters.test.ts` speaks the same wire
protocol (001 on USER, 366 on JOIN, PONG on PING) and can push server→client
lines (`push`) and drop connections (`drop`) for inbound tests. Coverage:

- send: register/join/deliver, DM no-JOIN, PASS+IDENTIFY, fallback target,
  401 failure, unconfigured, dead-server timeout, CRLF injection
- inbound: listener registration + JOIN, DM relay, channel addressing
  (addressed relayed + prefix stripped / unaddressed ignored), self-echo +
  non-text CTCP filtering, CTCP ACTION conversion, allowlist
  (case-insensitive), PING→PONG, 433 nick retry
- **E2E round-trip**: server pushes → listener relays to the handler → the
  handler replies through `send()` → the server sees the reply **on the same
  single connection**
- resilience: reconnect-after-drop then deliver, stop() QUIT + no delivery +
  no reconnect

## 9. Example wire exchange

```
C: NICK agent-nuvira
C: USER agent-nuvira 0 * :Agent-Nuvira gateway
S: :irc.example.net 001 agent-nuvira :Welcome to the example IRC Network agent-nuvira
C: JOIN #ops
S: :irc.example.net 366 agent-nuvira #ops :End of /NAMES list
S: PING :1234567890
C: PONG :1234567890
S: :alice!user@host PRIVMSG #ops :agent-nuvira: deploy the site
C: PRIVMSG #ops :deploying — build #42 is up
S: :alice!user@host PRIVMSG agent-nuvira :nice, thanks!
S: :agent-nuvira!bot@host NICK agent-nuvira_   (if a collision forced a retry)
```
