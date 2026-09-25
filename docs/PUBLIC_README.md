<p align="center">
  <img src="docs/assets/logo.svg" width="88" height="88" alt="Agent-Nuvira">
</p>

<h1 align="center">Agent-Nuvira</h1>

<p align="center"><b>Multi-agent AI coding CLI.</b><br>
Plans, writes, reviews, tests and publishes code — from your terminal, a dashboard,<br>
or any of 22 messaging platforms. Local models or cloud APIs, bring your own keys.</p>

<p align="center">
  <a href="docs/index.md"><b>📖 Documentation</b></a>
  &nbsp;·&nbsp;
  <a href="docs/user-manual.md">User Manual</a>
  &nbsp;·&nbsp;
  <a href="docs/capabilities.md">Capabilities</a>
  &nbsp;·&nbsp;
  <a href="docs/commands.md">Commands</a>
  &nbsp;·&nbsp;
  <a href="docs/architecture.md">Architecture</a>
  &nbsp;·&nbsp;
  <a href="docs/demos/index.md">CLI tour</a>
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-6366f1">
  <img alt="Node >= 18.18" src="https://img.shields.io/badge/node-%E2%89%A5%2018.18-6366f1">
  <img alt="No telemetry" src="https://img.shields.io/badge/telemetry-none-6366f1">
</p>

---

```bash
npm install -g agent-nuvira
nuvira doctor                                  # full environment diagnosis
nuvira chat "explain what this project does"   # have a conversation about your code
```

The first run is deliberately thorough — it probes every provider you hold a key for — and
`nuvira doctor` will tell you exactly what it found. **[Full setup guide →](https://docs.agent-nuvira.com/user-manual/)**

## Why it is different

**It verifies its own work.** An edit that nothing checked cannot be reported as done. If the
agent changes files, makes a claim, and runs nothing, that is recorded and it gets one
corrective nudge naming what would settle it — rather than eight confident turns of "now
fully operational" while your build stays broken.

**One engine behind every surface.** The terminal, the dashboard and all 22 messaging
channels are the same pipeline, the same tool surface and the same router. Fix a bug in one
and you have fixed it everywhere, because there is only one place it lives.

**It finishes long unattended jobs, and accounts for them.** A multi-hour run reports its
per-batch cost and latency on every completion path — so a job started from WhatsApp is as
measurable as one started in your terminal.

**Every number means what it says.** A progress percentage means the deliverable exists, not
that a counter ran out. A listing is never presented as a capability. When the agent cannot
tell, it says so.

**Local-first, and honest about cost.** Ollama and local models are a first-class path, not a
fallback. 22 providers speak one interface, with bring-your-own-keys, a cost cap and a
governance policy you control.

**No telemetry.** Nothing leaves your machine except the requests to the model providers you
configured.

## What it can do

| | |
|---|---|
| **110** agent tools | filesystem, execution, browser, vision, voice, sandbox, integrations |
| **289** CLI command entries | across 48 groups, with a generated, drift-guarded reference |
| **22** providers · **22** messaging platforms | Telegram, Slack, WhatsApp, SMS, IRC, Signal, Teams, … |
| **155** skills · **10** workflow pipelines | reusable plans and fixed multi-agent pipelines |
| **22** dashboard pages | chat, routing, traces, cost, models, memory, admin governance |
| **6** vetted MCP servers | connect external tools, or expose these tools as an MCP server |

Beyond code, it drives a browser, reads PDFs and spreadsheets, generates and describes
images, transcribes and speaks, runs code in a sandbox, supervises containers, and assesses
a repository it has never seen. **[Everything it can do →](https://docs.agent-nuvira.com/capabilities/)**

Vector retrieval keeps long contexts affordable rather than merely possible — measured on a
real repository: **142,493 tokens saved at a 65.6% average reduction**.

## See it before you install it

The **[command reference](https://docs.agent-nuvira.com/commands/)**
covers every command with its objective, exact syntax and a copy-pasteable example. The
**[CLI tour](https://docs.agent-nuvira.com/demos/)** is a
recorded sweep across the whole surface, captured from the real binary rather than performed
for a camera. The **[architecture](https://docs.agent-nuvira.com/architecture/)**
document explains how the execution engine is put together, including what is still target
state rather than built.

## What it is not

It is not a hosted product — there is no cloud dashboard, because there is no telemetry.
Provider support is broad, so polish is uneven across all 22. Multi-account key rotation is
currently scoped to `plan` and `edit`, and unwinding that is the next milestone. Those are
the honest boundaries, written down rather than discovered by you.
**[Limitations and roadmap →](https://docs.agent-nuvira.com/user-manual/#13-limitations-and-roadmap)**

## Repository layout

This repository is **documentation only** — the source lives in a private repository. The
content here is generated from it, so a page cannot describe a command, a count or an
interface that does not exist.

| Path | What it is |
|---|---|
| [`docs/user-manual.md`](docs/user-manual.md) | Install, configure, and use every surface in depth |
| [`docs/capabilities.md`](docs/capabilities.md) | What it can do beyond writing code |
| [`docs/commands.md`](docs/commands.md) | Curated command reference with examples |
| [`docs/reference/commands-surface.md`](docs/reference/commands-surface.md) | All 289 entries, generated from the live CLI |
| [`docs/architecture.md`](docs/architecture.md) | Modular execution engine design |
| [`docs/whats-new.md`](docs/whats-new.md) | Release index |
| [`docs/demos/`](docs/demos/index.md) | The CLI tour, and how to replay it |

---

<p align="center">
  <b>MIT licensed</b> · Built by Dheeraj Sharma<br>
  <a href="docs/index.md">Documentation</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/imdheerajKube/agent-nuvira-documentation/issues">Issues</a>
</p>
