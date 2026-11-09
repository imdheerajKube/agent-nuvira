# Environment & Process Configuration — the plain-English guide

**Audience:** anyone who runs Agent-Nuvira, including people who are not developers.
**Goal:** explain, without jargon, what environment variables are, where Nuvira
keeps them, which ones are worth changing, and what each change actually gets you.
**Related:** [`docs/HOOKS_GUIDE.md`](HOOKS_GUIDE.md) (the plain-English hooks guide),
[`docs/HOOKS.md`](HOOKS.md) (the technical hooks reference), [`.env.example`](../.env.example)
(the template you copy).

---

## 1. What an environment variable actually is

Think of the program as a worker sitting at a desk. An **environment variable** is
a sticky note taped to the wall next to it: a *label* and a *value*.

```
GROQ_API_KEY=gsk_abc123
NUVIRA_ISOLATE=1
```

- The **label** on the left (`GROQ_API_KEY`) is the name. It is written in CAPITALS
  by convention and the program looks it up by that exact name.
- The **value** on the right (`gsk_abc123`) is the setting. It can be a key, a
  number, a path, the words `on`/`off`, or a whole command.
- The `=` is just the separator. There are no spaces around it.

That is the entire concept. The rest of this document is: *which* sticky notes
Nuvira reads, *where* you should write them, and *what each one does*.

> **Why bother?** Because they are the switches and the keys. They are how you say
> "use my Groq account", "run each task in an isolated copy of my project", "keep
> a debug log I can attach to a bug report", or "never silently use a different
> model than the one I pinned". Nothing here requires writing code.

---

## 2. Where Nuvira reads them from — and which one wins

Nuvira looks in three places. When the same name appears in more than one, one of
them **wins** and the others are ignored. This is the single most common source of
"I set it but nothing changed", so it is worth two minutes.

| Priority | Where it lives | Who usually puts it there | Typical use |
|---|---|---|---|
| **1 — strongest** | Your **shell / operating system** environment | You with `export`, or `systemd`/Docker/CI configuration | One-off runs, CI pipelines, keeping a secret out of every file |
| **2** | The **profile file**: `<config-dir>/.env` (normally `~/.nuvira/.env`) | The dashboard's Env Config & Process Env pages, `nuvira config …`, platform setup | Your normal, persistent setup |
| **3 — weakest** | A **project file**: `.env` in the folder you run Nuvira from | You, by hand, for one project | Project-specific overrides |

**The rule that surprises people:** a value that is *already* in the environment
wins over anything written to a file. If you `export NUVIRA_OTEL=0` in your
terminal, then later switch OTEL **on** on the Process Env page, your shell's `0`
still wins for every command you run from that terminal — for the dashboard too.
Nuvira does not override a value that the operating system already provides.

To make this visible instead of mysterious, the dashboard's **Process Env** page
shows **two** values for every switch:

- the **file value** (what is written down and what your *next* run will read), and
- the **process value** (what the *currently running* program would actually obey).

When those differ, the row is flagged as **shadowed** — meaning "something outside
this page is outranking it". If you see that, look for the variable in your shell
or in a service definition; that is where it is coming from.

### The order inside the `.env` files

A **project** `.env` is read first, then the **profile** `.env` is layered on top,
so the profile wins over the project file. Neither can beat a value you exported in
the shell.

---

## 3. The three places to set things (and which one belongs where)

Nuvira deliberately separates the *kinds* of value, because they have different
safety rules and different audiences. Putting a value in the wrong place is the
usual reason a setting "does nothing".

| Surface | Where | What belongs there | What is **refused** there |
|---|---|---|---|
| **Env Config** | Dashboard → *Resources → Env Config* (`/env`) | **Skill secrets** — any well-formed name a skill declares (e.g. `MY_SERVICE_API_KEY`) | **Provider credentials** (AI API keys) are shown locked (🔒) and rejected on save — configure those as providers instead |
| **Process Env** | Dashboard → *Resources → Process Env* (`/process-env`) | The **curated switches** that change how a *run* behaves (isolation, resume, debug log, tracing, tool hooks) | Any name that is not on the curated list — the allowlist is enforced by the server, not just hidden in the UI |
| **Provider / platform setup** | Dashboard → *Models*, *Integrations → Platforms*, *Bedrock*; CLI `nuvira models`, `nuvira config gateway add …`, `nuvira bedrock` | **AI provider API keys** and **messaging tokens** | — |

Two consequences worth stating plainly:

1. **The Process Env page is deliberately small.** Every switch on it is one that
   Nuvira actually reads somewhere. A control that silently did nothing would be
   worse than no control, so the list is curated rather than "type any name".
2. **Provider keys are blocked from the skill editor on purpose.** Skills run in a
   sandbox that is *never* handed your AI provider keys; storing one as a "skill
   secret" would promise something Nuvira refuses to deliver. Provider keys go
   through provider setup, where the router also learns that the provider is
   authorised.

All of these surfaces write to the **same** file — `<config-dir>/.env`, normally
`~/.nuvira/.env` — so the dashboard and the CLI can never disagree about what is
configured.

---

## 4. The Process Env switches — what each one gets you

This is the heart of the page. Each row below is a real switch Nuvira reads. For
every one you get: **what it does**, and **what *unset* means** (because "nobody
said anything" and "someone said no" are different, and some of these default to
ON).

### 4.1 How a turn behaves

| Variable | Plain-English: what it does | What **unset** means | Turn it on from the CLI |
|---|---|---|---|
| `NUVIRA_ISOLATE` | Run each turn in its **own throwaway git worktree** (a private copy of your project) and hand back the diff against the commit it started from. Nothing touches your working files until you accept the change. | A turn runs directly in your project folder. | `nuvira chat --worktree` |
| `NUVIRA_RESUME` | **Replay** the model calls of this ask whose entire input is unchanged, instead of paying for them a second time. | Nothing is replayed; every step is paid for again. | `nuvira chat --resume [id]` |
| `NUVIRA_SESSION_STORE` | Snapshot each turn's conversation at every step, so a turn that is **killed or crashes** can be picked up by the next one. A turn that finishes cleanly is closed and never resumed. | Continuity is **ON** (this switch exists to turn it *off*). | `nuvira execute --no-session-store` |
| `NUVIRA_SESSION_RECALL` | Index each finished ask and, at the start of a new one, surface the **semantically closest past asks** in this project. History only — never a claim that work is already done. | Semantic recall is **ON** (this switch turns it *off*). | `nuvira execute --no-session-recall` |
| `NUVIRA_CATALOG_FEED` | Fetch OpenRouter's **public model catalogue** out-of-band and use it for two *priors* Nuvira cannot measure cold: **cost** (from real pricing) and **ecosystem** (from advertised tool support). A prior is replaced by real measurement as data builds up, is printed with its source, and never outranks evidence. | **OFF.** Nothing is fetched; cost shows `n/a`. | `nuvira config catalog-feed set on` + `… refresh` |
| `NUVIRA_EXTRACT_MAX_CHARS` | How many characters **one `read_extract` call** may return. A bigger document is read only in part and the truncation is stated. Raise it to read a large report in a single pass (max 8,000,000). | 40,000 characters (about 10,000 words). | `nuvira config limit set extract-max-chars <n>` |
| `NUVIRA_ATTACHMENT_MAX_BYTES` | Legacy cap for a file sent **inline in a JSON chat request**, in bytes. The dashboard composer no longer uses this path. | 300,000 bytes (~293 KB) per inline attachment, 10 per turn. | `nuvira config limit set attachment-max-kb <n>` |
| `NUVIRA_ATTACHMENT_UPLOAD_MAX_BYTES` | The largest single file the **streamed attachment uploader** accepts, in bytes. The file is stored and indexed out-of-band, so this is a disk/quota limit, not a model-context limit (max 8,589,934,592 = 8 GB). | 2,147,483,648 bytes (2 GB) per file. | Set in Process Env or `~/.nuvira/.env` |
| `NUVIRA_ATTACHMENT_INGEST_MAX_CHARS` | How much extracted text is stored for one attachment. This is **not** a prompt budget: the full text is chunked on disk and read through `attachment_search` / `attachment_read` in bounded windows. | 20,000,000 characters per attachment. | Set in Process Env or `~/.nuvira/.env` |
| `NUVIRA_ATTACHMENT_RETENTION_DAYS` | How long an attachment nobody has touched is kept before automatic cleanup. Chats active in the last 7 days are protected, and nothing younger than an hour is removed. | 30 days. | Set in Process Env or `~/.nuvira/.env` |
| `NUVIRA_ATTACHMENT_STORE_MAX_BYTES` | Total disk budget for the durable attachment store. Over budget, the oldest unprotected files are deleted first; an upload that still cannot fit is refused. | 50 GB. | Set in Process Env or `~/.nuvira/.env` |
| `NUVIRA_ATTACHMENT_SESSION_MAX_BYTES` | The total attachment budget for one conversation. An upload that would exceed it is refused with the current usage. | 10 GB. | Set in Process Env or `~/.nuvira/.env` |
| `NUVIRA_CAPABILITY_MODE` | How much Nuvira **spends on reasoning** versus how much it saves. `balanced` (default): best model for complex/critical work, cheaper models for simple work, escalation on a stall. `max`: cost is not a concern — every turn routes to the strongest model, paid models are always allowed, cost ceilings lift, and the loop gets its longest reasoning budget. | `balanced` — the recommended default. | `nuvira config capability set <balanced\|max>` |
| `NUVIRA_WORK_DIGEST` | When a long turn's context is compacted, keep a short **digest of what the turn has done** (files changed, commands and whether they passed, tools used). `all` (default): always keep it. `max`: only under `max` capability mode. `off`: never. | `all` — the digest is kept in every mode. | `NUVIRA_WORK_DIGEST=all\|max\|off` |
| `NUVIRA_STRICT_MODEL` | **Fail** instead of substituting a model when the one you pinned is unavailable, so "it secretly ran on something else" cannot happen. | A dead pin is repaired by substituting an available model, and the swap *is* announced. | — |

### 4.2 Observability — seeing what happened

| Variable | Plain-English: what it does | What **unset** means |
|---|---|---|
| `NUVIRA_DEBUG_LOG` | Write **one redacted, size-bounded log file per turn**, ready to attach to a bug report. | No log is written. |
| `NUVIRA_OTEL` | Export a **span tree per turn** (`nuvira.turn` with one child per tool call that really ran) over OTLP/HTTP. | Nothing is built and the OpenTelemetry SDK is not even imported. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | **Where** spans are shipped (e.g. `http://localhost:4318`). The OTLP spec appends `/v1/traces`; set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` instead if you want to give the full path yourself. | Export is on but there is nowhere to send spans, so **Nuvira builds them and then drops them**. The Process Env page warns you in exactly this situation. |

> **Common trap:** turning on `NUVIRA_OTEL` without an endpoint. The page spots it
> and tells you. Set the endpoint first if you want the data.

### 4.3 Tool command hooks (the "run my own command" switches)

These three are for people who *do* want to run their own program around every tool
call. They are the **code** path, and deliberately separate from the safe,
no-code rules described in [`docs/HOOKS_GUIDE.md`](HOOKS_GUIDE.md).

| Variable | Plain-English: what it does | What **unset** means |
|---|---|---|
| `NUVIRA_TOOL_HOOK_BEFORE` | A command run **before** each tool call. The call arrives as JSON on stdin; **silence means allow**, and printing `{"decision":"deny","reason":"…"}` stops the call. | No before-hook. |
| `NUVIRA_TOOL_HOOK_AFTER` | A command run **after** each tool call, receiving the call and a bounded preview of its result. It **cannot** veto — the call already happened. | No after-hook. |
| `NUVIRA_TOOL_HOOK_FAILED` | A command run when a tool call **fails**, with the failure on stdin. | No failed-hook. |

Each of these is a **single command line** (max 512 characters). A hook declared in
`tools.hooks` inside `buffconfig.json` still runs as well.

---

## 5. The four value-spelling rules (read this before typing a value)

Not every switch decides "on" the same way. Because Nuvira refuses to lie about
behaviour, the page writes the **canonical** spelling the reader understands
(`1` for on, `0` for off) rather than storing whatever you typed.

| Rule | Names using it | Means ON when the value is… | Everything else means OFF |
|---|---|---|---|
| **asks** | `NUVIRA_ISOLATE`, `NUVIRA_CATALOG_FEED` | `1`, `true`, `yes` | anything else, including unset |
| **truthy** | `NUVIRA_SESSION_STORE`, `NUVIRA_SESSION_RECALL`, `NUVIRA_DEBUG_LOG`, `NUVIRA_OTEL` | anything **except** `0`, `false`, `off`, `no`, or blank | `0`/`false`/`off`/`no`/blank |
| **strict-one** | `NUVIRA_STRICT_MODEL` | the literal `1` **and nothing else** | anything else — `true` will **not** enable it |
| **asks-or-names** | `NUVIRA_RESUME` | `1`, `true`, `yes` ask for the automatic record; **any other value names a specific checkpoint** | only blank, `0`, `false` |

Two facts here are worth reading twice, because they are exactly the kind of thing
a config page usually gets wrong:

- **`NUVIRA_STRICT_MODEL=true` does NOT turn it on.** Only the literal `1` does.
  If you type it by hand, type `1`.
- **`NUVIRA_RESUME=no` is a *resume*, not a refusal.** Only blank, `0`, and `false`
  decline. The words `off` and `no` are treated as *names of a checkpoint*. Use
  `NUVIRA_RESUME=0` to turn it off.

If a value is rejected, the page tells you why (empty, contains a newline, too long
over 512 characters, or not a valid on/off word) and the previously saved setting
stays in force — nothing is silently dropped. A newline is refused rather than
stripped, because silently dropping half a pasted value is how a config ends up
containing something you never wrote.

---

## 6. AI provider API keys — bring your own model accounts

Nuvira can route across **17+ providers**. A provider only enters the pool when its
key is present, so "which providers do I get?" is answered entirely by which keys
you set. Keys belong in **provider setup** (dashboard *Models* page, or
`nuvira models`), which writes them to the profile `.env`.

| Provider | Env var | What it gives you, in plain terms |
|---|---|---|
| Groq | `GROQ_API_KEY` | Extremely fast open-model inference; generous free tier |
| NVIDIA NIM | `NVIDIA_NIM_API_KEY` | Hosted Llama/Nemotron on NVIDIA's inference cloud |
| Google Gemini | `GEMINI_API_KEY` | Very large context (up to ~1M tokens), strong reasoning, cheap |
| OpenRouter | `OPENROUTER_API_KEY` | One key in front of hundreds of models, incl. free tiers and failover |
| OpenAI | `OPENAI_API_KEY` | GPT models — the reference baseline |
| Anthropic | `ANTHROPIC_API_KEY` | Claude — strong reasoning and tool use, long context |
| Mistral | `MISTRAL_API_KEY` | Efficient European model family |
| Cohere | `COHERE_API_KEY` | Command models, good for chat and retrieval |
| Together AI | `TOGETHER_API_KEY` | Broad catalogue of hosted open-weight models |
| DeepInfra | `DEEPINFRA_TOKEN` | Among the cheapest per-token for open-weight models |
| Fireworks AI | `FIREWORKS_API_KEY` | Fast open-weight serving with function calling |
| Perplexity | `PERPLEXITY_API_KEY` | Search-grounded answers with live web citations |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` (+ `AZURE_OPENAI_ENDPOINT`) | Your OpenAI deployments inside your own Azure subscription |
| Anyscale | `ANYSCALE_API_KEY` | Hosted open-weight models, OpenAI-compatible |
| DeepSeek | `DEEPSEEK_API_KEY` | Strong coding/reasoning at very low cost |
| xAI (Grok) | `XAI_API_KEY` | Large context and current-events reasoning |
| Replicate | `REPLICATE_API_TOKEN` | Hosted model API proxying Llama and many open models |
| Amazon Bedrock | `AWS_BEARER_TOKEN` (+ `BEDROCK_REGION`) | AWS-hosted Claude/Llama via an OpenAI-compatible endpoint |

**Keyless providers** need no key at all — Nuvira just checks whether the server is
reachable: **Ollama** (`local`), **LM Studio**, **vLLM / TGI**, the local **Nuvira
gateway**, and **OmniRoute** (a local gateway that multiplexes your other upstream
keys behind one endpoint).

**Auxiliary service keys** (image generation, web search, speech, vision) are also
provider-level credentials and are treated the same way — they are kept away from
skills. They include `STABILITY_API_KEY`, `BRAVE_SEARCH_API_KEY` / `BRAVE_API_KEY`,
`SERPER_API_KEY`, `TAVILY_API_KEY`, `GOOGLE_CSE_API_KEY`, `FAL_KEY`,
`ELEVENLABS_API_KEY`, `JINA_API_KEY`, and `NEUTTS_API_KEY`. Configure them from the
dashboard's service-key section or `nuvira config service …`.

---

## 7. Messaging and gateway platform keys

To let Nuvira talk on a chat platform, set that platform's token. Two-way platforms
receive *and* reply; "send-only" ones just post.

| Platform | Variable(s) | Notes |
|---|---|---|
| Telegram | `NUVIRA_TELEGRAM_TOKEN` | Bot token from @BotFather; two-way |
| Discord | `NUVIRA_DISCORD_BOT_TOKEN` / `NUVIRA_DISCORD_WEBHOOK_URL` | Bot token = two-way; webhook = send-only |
| Slack | `NUVIRA_SLACK_BOT_TOKEN` / `NUVIRA_SLACK_WEBHOOK_URL` / `NUVIRA_SLACK_SIGNING_SECRET` | Bot token two-way; webhook send-only |
| WhatsApp (personal) | `NUVIRA_WHATSAPP_SESSION_DIR` | Pair via QR: `nuvira whatsapp pair` |
| WhatsApp (Cloud API) | `NUVIRA_WHATSAPP_TOKEN` + `NUVIRA_WHATSAPP_PHONE_ID` | Meta business account |
| Email (SMTP) | `NUVIRA_SMTP_HOST`, `NUVIRA_SMTP_USER`, `NUVIRA_SMTP_PASS`, `NUVIRA_SMTP_FROM` | Works with Gmail, SendGrid, etc. |
| Signal | `NUVIRA_SIGNAL_ACCOUNT` | Via `signal-cli-rest-api` |
| Matrix | `NUVIRA_MATRIX_HOMESERVER`, `NUVIRA_MATRIX_ACCESS_TOKEN` | Two-way |
| DingTalk / Feishu / WeCom / Mattermost / Teams / Google Chat | `NUVIRA_DINGTALK_WEBHOOK_URL`, `NUVIRA_FEISHU_WEBHOOK_URL`, `NUVIRA_WECOM_WEBHOOK_URL`, `NUVIRA_MATTERMOST_WEBHOOK_URL`, `NUVIRA_TEAMS_WEBHOOK_URL`, `NUVIRA_GOOGLE_CHAT_WEBHOOK_URL` | Send-only webhooks |
| Generic webhook | `NUVIRA_WEBHOOK_URL` | POST JSON anywhere |
| BlueBubbles (iMessage) | `NUVIRA_BLUEBUBBLES_URL`, `NUVIRA_BLUEBUBBLES_PASSWORD` | Local BlueBubbles server |
| ntfy | `NUVIRA_NTFY_TOPIC` (+ `NUVIRA_NTFY_URL`) | Push notifications |
| Weixin (iLink) | `NUVIRA_WEIXIN_TOKEN` | Send-only |

**Who is allowed to trigger the agent** is controlled separately, and this matters
more than the tokens themselves:

| Variable | Plain-English: what it controls |
|---|---|
| `NUVIRA_GATEWAY_ALLOW_IDS` | An allowlist of `platform:channelId` pairs that may trigger the agent (e.g. `whatsapp:919876543210`). Empty = every channel. |
| `NUVIRA_GATEWAY_ALLOWED_USERS[_<PLATFORM>]` | Sender ids allowed to trigger, globally or per platform. |
| `NUVIRA_GATEWAY_ALLOWED_GROUPS[_<PLATFORM>]` | Group ids allowed to trigger. |
| `NUVIRA_GATEWAY_REQUIRE_MENTION[_<PLATFORM>]` | In groups, only respond when the bot is mentioned. |
| `NUVIRA_GATEWAY_DISABLED_PLATFORMS` | Turn a platform's pipeline triggers off entirely. |
| `NUVIRA_GATEWAY_SUPERVISED` | `1` runs the gateway under supervision. |

The friendly way to set a platform up is `nuvira gateway setup <platform>` — a
step-by-step guide that can *verify* the token before saving — or the dashboard's
*Platforms* page. (`nuvira config gateway set <platform>` writes the variables
directly, and `nuvira config gateway list` shows each platform's status.) The dashboard's **Agent Hub** also lets you manage who may
trigger the agent per platform.

> **Safety note:** exposing the gateway publicly requires the platform's signature
> secrets (e.g. `NUVIRA_SLACK_SIGNING_SECRET`, `NUVIRA_WHATSAPP_APP_SECRET`) so
> requests can be authenticated. Always keep `NUVIRA_GATEWAY_ALLOW_IDS` tight when
> the endpoint is reachable from the internet.

---

## 8. Dashboard access and safety

| Variable | Plain-English: what it does |
|---|---|
| `NUVIRA_DASHBOARD_PORT` | Port the dashboard serves on (default `3030`). |
| `NUVIRA_DASHBOARD_HOST` | Interface to bind (default `127.0.0.1` = this machine only). |
| `NUVIRA_DASHBOARD_ADMIN_USER` | Admin username, for zero-config setup. |
| `NUVIRA_DASHBOARD_ADMIN_PASSWORD` | Admin password. When set, it **wins** over the interactive setup, and a saved password will not override it. |
| `NUVIRA_DASHBOARD_ADMIN_ROLE` | Role for that user (default `admin`). |
| `NUVIRA_DASHBOARD_DEFAULT_ADMIN` | `0` disables the default first-user admin gate. |

Roles gate every config write: reading is generally open, but changing configuration
(process env, hooks, platforms, service keys) requires the **admin** or **operator**
role.

---

## 9. Paths and advanced switches

You will rarely need these, but they are the ones people reach for when isolating a
profile, moving storage, or debugging.

| Variable | Plain-English: what it does |
|---|---|
| `NUVIRA_CONFIG_DIR` | Move the **whole profile** (config, credentials, state) somewhere else. This is how you isolate a test, CI, or per-project profile so it cannot touch your real `~/.nuvira`. |
| `NUVIRA_ENV_FILE` | Point the credential `.env` at an explicit path. |
| `NUVIRA_MEMORY_DIR` | Where memory/routing data lives (default `~/.nuvira/memory`). |
| `NUVIRA_MCP_DIR` | Where MCP server configs live. |
| `NUVIRA_VECTOR_BACKEND` | Vector search backend: `auto` \| `faiss-native` \| `faiss-ivf` \| `json`. |
| `NUVIRA_SKILLS_REGISTRY` | Skills registry source (a local folder or a GitHub raw URL). |
| `NUVIRA_ACT_AS` | Act as a different identity, for testing role-based access. |
| `NUVIRA_LOG_JSON` | Emit structured JSON logs instead of human text. |
| `NUVIRA_DEBUG` | Verbose debug output. |
| `NUVIRA_NO_REDACT` | **Debugging only — disables log redaction and exposes API keys in logs. Do not leave this on.** |
| `NUVIRA_WEB_ALLOW_PRIVATE` | Allow private-network URLs in web research (a security risk; off by default). |
| `NUVIRA_ARTIFACTS_DIR` | Where artifacts are stored. |
| `NUVIRA_IMAGE_API_URL` | Image-generation endpoint (Pollinations by default, or local SD/ComfyUI). |
| `NUVIRA_PIPER_MODEL` | Piper voice model for text-to-speech. |
| `NUVIRA_SEARXNG_URL` | Self-hosted SearXNG instance for web search. |
| `GITHUB_TOKEN` (or `GH_TOKEN` / `GITHUB_API_KEY`) and `GIT_USERNAME` | Git credentials for repository operations (HTTPS pushes). Stored in the profile `.env`; a one-off shell value still wins. |
| `BUFF_ACTIVE_MODEL_PATH` | Read by the **VS Code extension** to point at a different active-model state file. (The CLI itself always uses `~/.nuvira/active-model.json`.) |
| `NUVIRA_TELEMETRY_ACTION` | Action tag for IDE integration. |
| `NUVIRA_EFFECT_VERIFY` | Controls effect verification (off/full/etc.). |
| `NUVIRA_ENV_GUARD` | Controls project-env write guarding. |
| `NUVIRA_ALLOW_DEP_CHANGES` | `1` lets a release accept dependency changes. |

---

## 10. Legacy `BUFF_*` names still work

Older installs used a `BUFF_` prefix (`BUFF_CONFIG_DIR`, `BUFF_TELEGRAM_TOKEN`, …).
Those still work, and every one reads through a dual lookup:

```
NUVIRA_<name>   first
BUFF_<name>     fallback (legacy)
```

**If both are set, `NUVIRA_*` wins.** You do not have to rename anything, but new
configuration should use `NUVIRA_*`.

---

## 11. The golden rules for secrets

1. **The credential file is `<config-dir>/.env` (normally `~/.nuvira/.env`), and it
   lives outside your repository.** Keep it there. Save via the dashboard or
   `nuvira` so it is written correctly; secret-writing paths tighten the file to
   owner-only permissions on systems that support it.
2. **Never commit a `.env`.** Add it to `.gitignore` in any project that has one.
3. **Provider keys are blocked from skills on purpose.** A skill sandbox never
   receives them, and Nuvira also filters out anything that *looks* like a
   credential — names ending in `_API_KEY`, `_SECRET`, `_TOKEN`, `_PASSWORD`, or
   starting with `AWS_`, `AZURE_`, `STRIPE_`, `TWILIO_`, and so on — so a stray
   platform password cannot leak into a skill by accident. A skill can still be
   given *its own* declared key explicitly.
4. **Leave redaction on.** `NUVIRA_NO_REDACT` exists to debug a redaction problem;
   with it on, your keys can appear in logs.
5. **Writes are gated.** Changing the process environment, hooks, platforms, or
   service keys requires the admin or operator role, and the server — not just the
   UI — enforces which names may be written.

---

## 12. Recipes — what you can actually achieve

Each recipe names the variable(s), says what to do, and states the outcome.

**"Protect my files while the agent works on them."**
Set `NUVIRA_ISOLATE=1`. Outcome: each turn happens in a private worktree and you
get a diff back; your real files change only when you accept it.

**"Stop paying twice for steps that did not change."**
Set `NUVIRA_RESUME=1`. Outcome: on a retry of the same ask, model calls whose input
is byte-for-byte unchanged are replayed instead of re-run.

**"Don't lose work if my machine dies mid-task."**
Leave `NUVIRA_SESSION_STORE` unset (it is ON by default). Outcome: each turn's
conversation is snapshotted at every step, so the next run can pick it up.

**"Spend freely on a hard task."**
Set `NUVIRA_CAPABILITY_MODE=max`. Outcome: every turn routes to the strongest
model, paid models are allowed, cost ceilings lift, and the loop reasons longer.

**"Never let it silently swap my pinned model."**
Set `NUVIRA_STRICT_MODEL=1` (the literal `1`). Outcome: if your pinned model is
unavailable, the run fails instead of quietly using something else.

**"Attach a large file / read a huge document in one pass."**
The composer streams the file to the durable attachment store under
`NUVIRA_ATTACHMENT_UPLOAD_MAX_BYTES` (2 GB default); extraction is indexed under
`NUVIRA_ATTACHMENT_INGEST_MAX_CHARS` (20M characters default). The model receives
a manifest plus relevant excerpts, then reads more with `attachment_search` and
`attachment_read` — so a large document no longer has to fit in one prompt.
`NUVIRA_EXTRACT_MAX_CHARS` still controls a direct `read_extract` call.

**"Stop old attachments filling my disk."**
Set `NUVIRA_ATTACHMENT_RETENTION_DAYS` to the age you want (30 days by default),
and `NUVIRA_ATTACHMENT_STORE_MAX_BYTES` / `NUVIRA_ATTACHMENT_SESSION_MAX_BYTES`
for the disk budgets. The dashboard sweeps on boot, protects conversations active
in the last 7 days, and removes the oldest unprotected files first.

**"File a bug report I can actually attach something to."**
Turn on `NUVIRA_DEBUG_LOG`. Outcome: one redacted, bounded log per turn, ready to
attach.

**"Send run traces to my observability stack."**
Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` **and** `NUVIRA_OTEL=1`.
Outcome: one span tree per turn with a child span per tool call that really ran.

**"Audit or block tool calls with my own program."**
Set `NUVIRA_TOOL_HOOK_BEFORE=node ~/my-check.mjs` (and/or `_AFTER`, `_FAILED`).
Outcome: your command runs around every tool call and can deny a call from stdin
JSON. If you would rather not write code, use the declarative hooks in
[`docs/HOOKS_GUIDE.md`](HOOKS_GUIDE.md).

**"Keep a test or CI run away from my real setup."**
Export `NUVIRA_CONFIG_DIR=/tmp/nuvira-ci`. Outcome: that process reads and writes an
isolated profile and cannot touch `~/.nuvira`.

**"See what is really in force."**
Open **Resources → Process Env**. Outcome: every curated switch with its file
value, its live process value, what unset means, and a flag when something outside
the page is outranking it.

---

## 13. Quick reference — the curated Process Env switches

| Name | Group | Kind | Default when unset |
|---|---|---|---|
| `NUVIRA_ISOLATE` | turn | flag (asks) | off — runs in the project dir |
| `NUVIRA_RESUME` | turn | flag (asks-or-names) | off — nothing replayed |
| `NUVIRA_SESSION_STORE` | turn | flag (truthy) | **on** — continuity kept |
| `NUVIRA_SESSION_RECALL` | turn | flag (truthy) | **on** — recall enabled |
| `NUVIRA_CATALOG_FEED` | turn | flag (asks) | off — no catalogue fetch |
| `NUVIRA_EXTRACT_MAX_CHARS` | turn | text | 40,000 characters |
| `NUVIRA_ATTACHMENT_MAX_BYTES` | turn | text | 300,000 bytes (legacy inline path) |
| `NUVIRA_ATTACHMENT_UPLOAD_MAX_BYTES` | turn | text | 2,147,483,648 bytes (2 GB) |
| `NUVIRA_ATTACHMENT_INGEST_MAX_CHARS` | turn | text | 20,000,000 characters |
| `NUVIRA_ATTACHMENT_RETENTION_DAYS` | turn | text | 30 days |
| `NUVIRA_ATTACHMENT_STORE_MAX_BYTES` | turn | text | 53,687,091,200 bytes (50 GB) |
| `NUVIRA_ATTACHMENT_SESSION_MAX_BYTES` | turn | text | 10,737,418,240 bytes (10 GB) |
| `NUVIRA_CAPABILITY_MODE` | turn | text | `balanced` |
| `NUVIRA_WORK_DIGEST` | turn | text | `all` |
| `NUVIRA_STRICT_MODEL` | turn | flag (strict-one) | off — dead pins are repaired |
| `NUVIRA_DEBUG_LOG` | observability | flag (truthy) | off — no log |
| `NUVIRA_OTEL` | observability | flag (truthy) | off — SDK not imported |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | observability | text | unset — spans dropped |
| `NUVIRA_TOOL_HOOK_BEFORE` | hooks | text | no before-hook |
| `NUVIRA_TOOL_HOOK_AFTER` | hooks | text | no after-hook |
| `NUVIRA_TOOL_HOOK_FAILED` | hooks | text | no failed-hook |

---

## 14. See also

- [`docs/HOOKS_GUIDE.md`](HOOKS_GUIDE.md) — hooks in plain English: the four
  moments a rule can fire on, the three things it can do, and what you can achieve.
- [`docs/HOOKS.md`](HOOKS.md) — the technical reference and full recipe cookbook.
- [`docs/GATEWAY.md`](GATEWAY.md) — messaging platforms and gateway operations.
- [`.env.example`](../.env.example) — the copyable template with every provider and
  platform key.
