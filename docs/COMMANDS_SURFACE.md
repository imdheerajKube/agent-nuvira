<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate: node scripts/generate-commands-surface.mjs -->
<!-- Drift guard: node scripts/generate-commands-surface.mjs --check -->
<!-- Source of truth: src/cli/cli-program.ts (createCLI) — generated from the live commander tree. -->

# CLI Command Surface

Every command, subcommand, alias, and flag the CLI exposes, derived from the
live command tree (not maintained by hand). For task-oriented, copy-pasteable
usage see the curated [COMMANDS.md](./COMMANDS.md).


### `nuvira`

Nuvira — multi-agent AI coding CLI (local models & cloud APIs)

   - flags: `--debug, --task <task>, --version`
### `nuvira admin`

Admin governance policy for Auto routing (P6 M6.5) — allow/deny providers & models, hard cost cap, PII privacy, unblock control

### `nuvira admin policy`

Show the current governance policy + enforcement status

   - flags: `--json`
### `nuvira admin allow`

Add providers to the allow-list (empty = all providers allowed)

### `nuvira admin deny`

Add providers to the deny-list (wins over the allow-list)

### `nuvira admin allow-model`

Add models to the allow-list — a provider survives only if one of its candidate models is listed

### `nuvira admin deny-model`

Add models to the deny-list (wins over the allow-list)

### `nuvira admin max-cost`

Set the admin hard max cost per call (USD); joins routing.maxCostUsd (stricter wins)

### `nuvira admin pii-min`

Set the minimum privacy score (0-1) required when a task matches a PII pattern (default 1.0 = local-only)

### `nuvira admin unblock`

Control whether `nuvira models unblock` may override REGISTRY-learned blocks (false = admin-hard)

### `nuvira admin clear`

Remove one governance rule (the policy becomes permissive on that field)

### `nuvira admin role`

Manage RBAC roles over the admin surface (P6 M6.1 — requires admin role)

### `nuvira admin role add`

Assign a role to a user (first assignment exits legacy single-user mode)

### `nuvira admin role remove`

Remove a user's role assignment (if none remain, legacy permissive mode resumes)

### `nuvira admin role list`

List all role assignments

### `nuvira admin whoami`

Show the current identity and its effective RBAC permissions

### `nuvira admin cron`

Scheduled tool invocations (J2 — cron/jobs.py)

### `nuvira admin cron add`

Add a cron job: nuvira admin cron add nightly-build "0 3 * * *" build

   - flags: `--args <args>, --channel <channel>, --dry-run`
### `nuvira admin cron list`

List cron jobs with schedule + next run

### `nuvira admin cron remove`

Remove a cron job

### `nuvira admin cron run`

Run a cron job NOW (invoke its tool immediately)

### `nuvira chat`

Start an interactive chat session with AI

   - flags: `--dev, --file <file>, --keep-worktree, --model <model>, --no-cache, --provider <provider>, --resume [resume], --worktree`
### `nuvira edit`

Edit a file using AI assistance

   - flags: `--auto-route, --dry-run, --instruction <instruction>, --model <model>, --provider <provider>, --review`
### `nuvira plan`

Generate an implementation plan for a codebase task

   - flags: `--model <model>, --provider <provider>, --task <task>, --verbose`
### `nuvira config`

Manage Nuvira configuration

### `nuvira config set`

Set a configuration value

### `nuvira config get`

Get a configuration value

### `nuvira config list`

List all providers and their status

### `nuvira config init`

Initialize configuration interactively

### `nuvira config vault`

Secret vault management (Phase A1)

### `nuvira config vault status`

Show the active vault tier and migration state

### `nuvira config vault log`

Show recent vault access-log entries (K3 tamper-evident audit)

   - flags: `--limit <limit>`
### `nuvira config vault migrate-keys`

Move plaintext provider API keys from buffconfig.json into the vault

### `nuvira config gateway`

Manage gateway platform transports (tokens written to ~/.nuvira/.env)

### `nuvira config gateway list`

Show every platform transport and its env-var status

### `nuvira config gateway set`

Configure a platform transport (interactive wizard, or --set VAR=value)

   - flags: `--set <set>`
### `nuvira config gateway remove`

Remove a platform transport from the env file

   - flags: `--yes`
### `nuvira config gateway allow`

Allow a user/group to trigger the agent on a platform (written to gateway.policies in config)

### `nuvira config gateway disallow`

Remove a user/group from the allowed list of a platform

### `nuvira config gateway reply`

Set how unapproved senders are handled on a platform: polite (⛔ message) or silent (no reply)

### `nuvira config gateway send-authority`

Manage who may command the agent to send to OTHER people (gateway_send). Outbound-only gate — separate from `allow` (who may trigger).

### `nuvira config gateway notify`

Manage status recipients — contacts/groups that ALWAYS get pipeline completion summaries

### `nuvira config gateway ask-user-wait`

Ask-and-wait for clarifying questions on messaging channels: when a turn asks the sender a question, hold it for their reply instead of assuming option 1

### `nuvira config service`

Manage third-party service keys (image/video/search/vision/speech) in ~/.nuvira/.env

### `nuvira config service list`

Show every service backend and its env-var status

### `nuvira config service set`

Set a service key: config service set <serviceId> <ENV_VAR> <value> (or --set VAR=value)

   - flags: `--set <set>`
### `nuvira config service unset`

Remove a service key (all vars, or one with [varName]) from the env file

   - flags: `--yes`
### `nuvira config limit`

Show or change the size limits for document extraction and attachments

### `nuvira config limit list`

Show the effective extraction and attachment limits

### `nuvira config limit set`

Set a limit: config limit set <extract-max-chars|attachment-max-kb> <value>

### `nuvira config limit unset`

Restore a limit to its default

### `nuvira config capability`

Show or change the capability mode (balanced | max)

### `nuvira config capability show`

Show the effective capability mode

### `nuvira config capability set`

Set the capability mode: config capability set <balanced|max>

### `nuvira config capability unset`

Restore the default capability mode (balanced)

### `nuvira cache`

Manage inference cache

### `nuvira cache stats`

Show cache statistics

### `nuvira cache clear`

Clear cached responses — all of them, or one workspace (project folder)

   - flags: `--unscoped`
### `nuvira models`

List available models from inference providers

   - flags: `--all, --json, --provider <provider>, --search <search>, --verify`
### `nuvira models refresh`

Probe providers and spot-check models, updating the Model Availability Registry

   - flags: `--json, --no-spot-check`
### `nuvira models status`

Show the Model Availability Registry (verified / unavailable / quota-parked models)

   - flags: `--json, --verbose`
### `nuvira models unblock`

Manually release a registry-blocked provider (escape hatch) and re-probe it against the live API

   - flags: `--json, --no-spot-check`
### `nuvira models excluded`

Show which providers routing is currently skipping, and why (failure cooldowns, registry blocks, governance policy)

   - flags: `--json`
### `nuvira models staleness`

Show model staleness: last probe time, days since verification, and removal risk

   - flags: `--json`
### `nuvira models watch`

Run the model-registry maintenance daemon: probe + spot-check on a schedule

   - flags: `--interval <interval>, --no-spot-check`
### `nuvira execute`

Run a multi-agent pipeline to accomplish a goal

   - flags: `--auto-branch, --auto-route, --checkpoint, --checkpoint-list, --context-limit <context_limit>, --context-prune <context_prune>, --dry-run, --engine <engine>, --gatherer-model <gatherer_model>, --json-events, --keep-worktree, --max-repairs <max_repairs>, --memory, --memory-clear, --memory-stats, --model <model>, --no-session-recall, --no-session-store, --no-tool-calling, --plan-mode <plan_mode>, --planner-model <planner_model>, --provider <provider>, --repair-fallback-models <repair_fallback_models>, --repair-mode <repair_mode>, --resume [resume], --review, --reviewer-model <reviewer_model>, --sandbox, --session-recall, --session-store, --skip-tests, --tool-calling, --verbose, --worktree, --writer-model <writer_model>`
### `nuvira run`

Execute a shell command and show output (lightweight alternative to the full pipeline)

   - flags: `--timeout <timeout>, --verbose`
### `nuvira workflow`

Run, manage, and share workflow templates

### `nuvira workflow list`

Show available workflow templates (built-in + installed)

### `nuvira workflow run`

Run a workflow template

   - flags: `--dry-run, --model <model>, --provider <provider>, --verbose`
### `nuvira workflow search`

Search the GitHub workflow template registry

   - flags: `--refresh`
### `nuvira workflow install`

Install a workflow template from the GitHub registry

### `nuvira workflow publish`

Prepare a local workflow template for publishing to the registry

### `nuvira workflow info`

Show detailed information about a registry template

### `nuvira workflow upgrade`

Check for and apply template upgrades from the registry

### `nuvira whatsapp`

WhatsApp bridge (Baileys) — pair a personal number via QR and check status (I8)

### `nuvira whatsapp pair`

Pair WhatsApp (personal number — no Meta Business account, no paid API)

   - flags: `--phone <phone>, --timeout <timeout>`
### `nuvira whatsapp status`

Show bridge session path + pairing state

### `nuvira whatsapp contacts`

List resolvable contacts (mapping file + learned) — connects briefly to learn names from live traffic

   - flags: `--timeout <timeout>`
### `nuvira whatsapp contact`

Manage the WhatsApp contact-name mapping (send by name: nuvira gateway send whatsapp:<Name> "message")

### `nuvira whatsapp contact add`

Map a display name to a number (E.164, no +): nuvira whatsapp contact add Name 919876543210

### `nuvira whatsapp contact remove`

Remove a mapped contact name

### `nuvira plugins`

Manage provider plugins, agent plugins, and workflow templates

### `nuvira plugins list`

List all discovered plugins and workflows

### `nuvira plugins scan`

Force re-scan all plugin directories

### `nuvira learn`

Self-improvement system — agent stats, patterns, and optimization

### `nuvira learn stats`

Show per-agent performance statistics

### `nuvira learn patterns`

Show extracted coding patterns

   - flags: `--extract, --model <model>, --provider <provider>`
### `nuvira learn lessons`

Show failure lessons — what past runs learned from mistakes

   - flags: `--extract, --model <model>, --provider <provider>`
### `nuvira learn optimize`

Generate optimized model-to-agent routing recommendations

### `nuvira learn status`

Show overall self-improvement status

### `nuvira learn clear`

Reset all learning data (stats, patterns, memory)

   - flags: `--force`
### `nuvira learn compare`

Compare benchmark results between two models

   - flags: `--all, --last`
### `nuvira learn feedback`

Rate a trajectory or view feedback statistics

   - flags: `--comment <comment>, --rating <rating>, --stats, --trajectory <trajectory>`
### `nuvira learn quality`

Show pattern quality and decay metrics

   - flags: `--details`
### `nuvira learn gc`

Garbage-collect low-quality patterns

   - flags: `--dry-run`
### `nuvira init`

Scaffold a new project from a template

   - flags: `--list, --model <model>, --provider <provider>, --template <template>, --template-dir <template_dir>`
### `nuvira stats`

View usage statistics and cost tracking

### `nuvira stats cost`

Show API cost tracking details

   - flags: `--clear`
### `nuvira stats history`

Show conversation history statistics

### `nuvira history`

Browse and search conversation history

### `nuvira history list`

Show all saved conversations

   - flags: `--limit <limit>`
### `nuvira history search`

Search conversations by keyword or semantic similarity

   - flags: `--limit <limit>, --semantic`
### `nuvira history show`

Show a specific conversation

### `nuvira history clear`

Clear all conversation history

### `nuvira history prune`

Remove conversations older than the retention period

   - flags: `--days <days>`
### `nuvira history reindex`

Rebuild the semantic search index for all past conversations (embeds each session for vector search)

### `nuvira skill`

Manage and run compiled skills — reusable execution plans derived from past trajectories

### `nuvira skill list`

List all compiled skills

   - flags: `--quality <quality>`
### `nuvira skill show`

Show detailed skill definition

### `nuvira skill run`

Run a skill — resolves parameters and invokes the multi-agent pipeline

   - flags: `--auto-route, --dry-run, --memory, --model <model>, --params <params>, --provider <provider>, --verbose`
### `nuvira skill compile`

Force skill compilation from stored trajectories

   - flags: `--model <model>, --provider <provider>`
### `nuvira skill search`

Search skills by name, tag, or description

### `nuvira skill gc`

Garbage-collect low-quality skills

   - flags: `--dry-run`
### `nuvira skill quality`

Show skill quality and decay metrics

   - flags: `--details`
### `nuvira skill clear`

Remove all compiled skills

   - flags: `--force`
### `nuvira skills`

Skills hub — search, install, update, and audit community skills (J3)

### `nuvira skills search`

Search all configured skill registries (I7 P1 multi-source)

   - flags: `--refresh, --source <source>`
### `nuvira skills install`

Install a skill from the configured registries into <project>/.agents/skills/ (sandboxed, checksummed)

   - flags: `--project <project>, --source <source>`
### `nuvira skills uninstall`

Uninstall a skill: removes .agents/skills/<name> and its provenance record

   - flags: `--project <project>`
### `nuvira skills update`

Update installed skills to newer registry versions (checksum-verified)

   - flags: `--project <project>`
### `nuvira skills bundle`

P6b — skill bundles: group skills under one id and load them together (Hermes parity)

   - flags: `--create, --delete, --description <description>, --name <name>, --skills <skills>`
### `nuvira skills list`

List installed skills with provenance (origin: registry vs local)

   - flags: `--origin <origin>, --project <project>`
### `nuvira gateway`

Multi-channel gateway — talk to the agent from Telegram/Discord/Slack/WhatsApp/Email/Signal (J1)

### `nuvira gateway status`

Show configured adapters and reachable channels

### `nuvira gateway send`

Send a message to a channel alias or platform:channelId

### `nuvira gateway send-media`

Send a media file (image/video/audio/document) — type from the file extension; WhatsApp/Telegram/Discord

   - flags: `--caption <caption>`
### `nuvira gateway alias`

Manage channel aliases

### `nuvira gateway alias add`

Register an alias: nuvira gateway alias add ops slack C0123

### `nuvira gateway alias remove`

Remove an alias

### `nuvira gateway contact`

Manage contacts for outbound messaging (name → platform:id resolution)

### `nuvira gateway contact list`

List all contacts with status, platform, and ID

   - flags: `--pending, --platform <platform>`
### `nuvira gateway contact approve`

Approve a contact for outbound messaging

   - flags: `--platform <platform>`
### `nuvira gateway contact reject`

Reject a contact (block outbound messages)

   - flags: `--platform <platform>`
### `nuvira gateway contact delete`

Delete a contact permanently

   - flags: `--platform <platform>`
### `nuvira gateway contact add`

Manually add a contact (e.g. nuvira gateway contact add Anuj telegram 616825477)

   - flags: `--phone <phone>`
### `nuvira gateway delivery`

Show the delivery ledger (failed sends awaiting retry) and optionally drain it

   - flags: `--flush`
### `nuvira gateway logs`

Show the structured gateway log (send failures, refused senders, pipeline outcomes)

   - flags: `--event <event>, --limit <limit>, --path`
### `nuvira gateway history`

Manage per-contact conversation history (gateway chat memory)

### `nuvira gateway history list`

List all stored conversations with last message preview

   - flags: `--platform <platform>`
### `nuvira gateway history show`

Show conversation history for a contact (e.g. nuvira gateway history show whatsapp:918800663237)

   - flags: `--limit <limit>`
### `nuvira gateway history clear`

Clear conversation history for a contact

### `nuvira gateway history prune`

Remove conversations older than 7 days

### `nuvira gateway start`

Run all configured adapters in the foreground (Ctrl-C to stop; --supervise auto-restarts on crash)

   - flags: `--host <host>, --no-events, --port <port>, --supervise`
### `nuvira gateway stop`

Stop a running gateway gracefully (SIGTERM — from any terminal)

   - flags: `--port <port>`
### `nuvira gateway setup`

Interactive setup wizard for a messaging platform (e.g. nuvira gateway setup telegram)

### `nuvira omniroute`

Start / stop / inspect the external OmniRoute AI gateway (default port 20128)

### `nuvira omniroute status`

Probe the OmniRoute gateway and report whether it is reachable

### `nuvira omniroute start`

Start the OmniRoute gateway in the background and wait for it to answer

### `nuvira omniroute stop`

Stop the running OmniRoute gateway

### `nuvira model`

Manage inference providers and models — switch, list, inspect, and recommend

### `nuvira model list` (aliases: `ls`)

List all providers and their configuration status

   - flags: `--all, --json`
### `nuvira model switch`

Switch active provider/model (interactive or via argument). Use `auto` for smart routing

   - flags: `--model <model>, --provider <provider>`
### `nuvira model info`

Show current active provider and model configuration

   - flags: `--verbose`
### `nuvira model recommend`

Show model routing recommendations

### `nuvira model explain`

Explain Auto model routing — why a provider/model would be picked for a task

   - flags: `--agent <agent>, --json, --since <since>`
### `nuvira model health`

Quick health check for the currently active provider

   - flags: `--provider <provider>, --verbose`
### `nuvira model bandit`

Show learning-router bandit state (Thompson-sampling priors per provider × complexity bucket). Action: reset

   - flags: `--json`
### `nuvira model ml`

Show the ML task-similarity router state (learned outcomes per provider, kNN over task features). Action: reset

   - flags: `--json`
### `nuvira model quota`

Show the central quota ledger (tokens/requests per provider × model, reset windows, parked state). Actions: reset | set <provider> | clear <provider>

   - flags: `--cost-usd <cost_usd>, --json, --requests <requests>, --tokens <tokens>, --window-ms <window_ms>`
### `nuvira benchmark`

Run standardized model benchmarks against coding tasks

### `nuvira benchmark run`

Run the benchmark suite

   - flags: `--budget <budget>, --format <format>, --model <model>, --provider <provider>, --routing, --tasks <tasks>`
### `nuvira benchmark list`

List available benchmark tasks

### `nuvira benchmark results`

Show previous benchmark results

   - flags: `--compare, --format <format>, --last`
### `nuvira benchmark clear`

Clear all benchmark data

### `nuvira eval`

Run the Agent-Nuvira evaluation framework — measures if the agent is actually improving

### `nuvira eval run`

Run the evaluation suite

   - flags: `--budget <budget>, --engine <engine>, --format <format>, --keep-workspaces, --model <model>, --pace, --provider <provider>, --routing, --suite <suite>, --tasks <tasks>`
### `nuvira eval parity`

Measure the capability gap: run the hard tasks under balanced AND max, then compare

   - flags: `--engine <engine>, --model <model>, --provider <provider>, --tasks <tasks>`
### `nuvira eval verify-seeds`

Prove every seeded bug is genuinely broken (and genuinely fixable) — no provider needed

   - flags: `--tasks <tasks>`
### `nuvira eval list`

List available eval tasks

### `nuvira eval results`

Show previous eval runs

   - flags: `--compare, --format <format>, --last`
### `nuvira eval score`

Show the evaluation scoring rules

### `nuvira eval clear`

Clear all eval data

### `nuvira sandbox`

Manage Docker sandbox isolation for code execution

### `nuvira sandbox status`

Check Docker availability and sandbox status

### `nuvira sandbox config`

Show or update sandbox configuration

   - flags: `--cpu <cpu>, --disable, --disk <disk>, --enable, --image <image>, --memory <memory>, --network, --timeout <timeout>`
### `nuvira sandbox images`

List available pre-defined sandbox images

### `nuvira sandbox run`

Run a command inside a new sandbox container

   - flags: `--cpu <cpu>, --image <image>, --memory <memory>, --network, --project <project>, --timeout <timeout>`
### `nuvira sandbox cleanup`

Destroy all active sandbox containers

### `nuvira doctor`

Run diagnostic checks on all provider configurations and system health

   - flags: `--enterprise, --fix, --nuvira, --provider <provider>, --verbose, --watch`
### `nuvira memory`

Manage agent memory store — compression, pruning, and optimization

### `nuvira memory stats`

Show memory store statistics

### `nuvira memory optimize`

Run automatic memory compression and pruning

   - flags: `--aggressive, --dry-run`
### `nuvira memory prune`

Prune old or low-quality trajectories

   - flags: `--max-age <max_age>, --max-count <max_count>, --min-score <min_score>, --verbose`
### `nuvira memory summarize`

Summarize old trajectories by merging similar ones

   - flags: `--retention <retention>, --verbose`
### `nuvira memory info`

Show detailed compression analysis

### `nuvira memory backend`

Show the active vector-search backend and why it was chosen

   - flags: `--check`
### `nuvira memory list`

List all memory entries (facts, preferences, lessons, observations)

   - flags: `--limit <limit>, --type <type>`
### `nuvira memory search`

Search memory entries by content

   - flags: `--limit <limit>, --type <type>`
### `nuvira memory add`

Add a memory entry

   - flags: `--tags <tags>, --type <type>`
### `nuvira memory delete`

Delete a memory entry by ID

### `nuvira memory export`

Export all memories to a JSON file

   - flags: `--output <output>`
### `nuvira memory import`

Import memories from a JSON file

   - flags: `--merge`
### `nuvira memory facts`

Fact & preference memory (project-scoped, cross-session)

### `nuvira memory facts list`

List facts, optionally for a project (git slug or cwd:<hash>)

   - flags: `--project <project>`
### `nuvira memory facts add`

Manually store a fact for the current project

   - flags: `--project <project>, --tags <tags>`
### `nuvira memory facts stats`

Show fact-store statistics

### `nuvira memory clear`

Clear all stored trajectories and reset memory

   - flags: `--force`
### `nuvira dashboard`

Launch the web-based dashboard for visualizing agent execution and system status

   - flags: `--build, --cwd <cwd>, --force, --gateway-port <gateway_port>, --host <host>, --keep-gateway, --no-gateway, --no-open, --port <port>`
### `nuvira dashboard stop`

Stop a running dashboard gracefully (SIGTERM — from any terminal)

   - flags: `--port <port>`
### `nuvira agent`

Scaffold and manage custom agent-nuvira agents

### `nuvira agent create`

Create a new custom agent project from a template

   - flags: `--agent-name <agent_name>, --description <description>, --dir <dir>`
### `nuvira agent list`

List all discovered custom agent plugins

### `nuvira agent info`

Show details about a discovered agent plugin

### `nuvira federation`

Connect to and manage remote agent instances

### `nuvira federation status`

Show federation connection status and configuration

### `nuvira federation start`

Start the federation server (listens for incoming connections)

   - flags: `--auth <auth>, --daemon, --host <host>, --oidc-public-key <oidc_public_key>, --port <port>, --secret <secret>`
### `nuvira federation connect`

Connect to a remote federation server

   - flags: `--port <port>, --secret <secret>`
### `nuvira federation disconnect`

Disconnect from the remote federation server

### `nuvira federation run`

Run a task on the remote federation server

   - flags: `--agent <agent>, --model <model>, --no-stream, --provider <provider>, --timeout <timeout>`
### `nuvira federation health`

Check the health of the remote federation server

### `nuvira federation config`

Show or update federation configuration

   - flags: `--set-port <set_port>, --set-secret <set_secret>, --show`
### `nuvira federation a2a`

A2A (Agent-to-Agent) protocol — discover and connect to external A2A-compliant agents

### `nuvira federation a2a discover`

Discover an A2A-compliant agent and fetch its AgentCard

### `nuvira federation a2a start`

Start the A2A server (listens for incoming A2A connections)

   - flags: `--host <host>, --port <port>`
### `nuvira federation a2a status`

Check the health and status of a remote A2A agent

### `nuvira federation a2a run`

Delegate a task to a remote A2A-compliant agent

   - flags: `--agent <agent>, --skill <skill>, --timeout <timeout>`
### `nuvira team`

Team collaboration — shared config, git-synced memory, and review workflow

### `nuvira team init`

Initialize team configuration in the working directory

   - flags: `--branch <branch>, --repo <repo>`
### `nuvira team join`

Clone and join an existing team repository

### `nuvira team sync`

Sync team memory with remote (pull latest + push local changes)

### `nuvira team status`

Show team configuration and memory status

### `nuvira team share`

Share local trajectories and patterns with the team

### `nuvira team review`

Manage review bundles — agent PR → review → merge workflow

### `nuvira team review list`

List all review bundles

   - flags: `--limit <limit>`
### `nuvira team review show`

Show a specific review bundle with full details

### `nuvira team review approve`

Approve a review bundle (sets status to approved)

   - flags: `--message <message>`
### `nuvira team review request-changes`

Request changes on a review bundle

### `nuvira team review reject`

Reject a review bundle

### `nuvira team review merge`

Merge an approved review into the working directory

### `nuvira team review create`

Create a review bundle from specified files

   - flags: `--files <files>, --model <model>, --provider <provider>`
### `nuvira sdk`

Create and manage custom agents with the Agent-Nuvira SDK

### `nuvira sdk scaffold`

Generate a new custom agent project

   - flags: `--agent-type <agent_type>, --template <template>`
### `nuvira sdk templates`

List available scaffold templates

### `nuvira sdk info`

Show SDK package info and version

### `nuvira sdk register`

Register a custom agent with the orchestrator

   - flags: `--icon <icon>, --orchestrator-path <orchestrator_path>`
### `nuvira sdk unregister`

Remove a custom agent from the orchestrator

   - flags: `--orchestrator-path <orchestrator_path>`
### `nuvira provider`

List and check health of all inference providers

### `nuvira provider list`

Show all providers with color-coded status table

   - flags: `--all`
### `nuvira provider health`

Show detailed health checks for one or all providers

   - flags: `--verbose, --watch`
### `nuvira security`

Scan code, prompts, or files for security issues

### `nuvira security scan`

Scan for PII, injection attempts, or dangerous code patterns

   - flags: `--code, --file <file>, --generated, --json, --pii, --prompt, --stdin, --strict`
### `nuvira audit`

Verify and export the tamper-evident (hash-chained) audit trail (P6 M6.3)

### `nuvira audit verify`

Verify hash-chain integrity of audit stores (tamper detection)

   - flags: `--file <file>, --json`
### `nuvira audit export`

Export an audit store as SIEM-friendly CEF lines

   - flags: `--file <file>, --out <out>`
### `nuvira sbom`

Generate and verify the CycloneDX software bill of materials (P6 M6.6)

   - flags: `--json, --licenses, --out <out>, --reproducible, --sbom <sbom>, --verify`
### `nuvira feedback`

Record, view, and manage user feedback on agent outputs

### `nuvira feedback record`

Record feedback for a trajectory (interactive)

   - flags: `--comment <comment>, --negative, --neutral, --positive`
### `nuvira feedback list`

Show recent feedback entries

   - flags: `--limit <limit>, --trajectory <trajectory>`
### `nuvira feedback stats`

Show aggregated feedback statistics

### `nuvira feedback clear`

Clear all feedback data

### `nuvira nlu`

NLU request understanding — debug intent/entity/action resolution

### `nuvira nlu debug`

Debug how a request is understood (rule path + optional LLM verify)

   - flags: `--llm`
### `nuvira nlu learnings`

Show the routing corrections learned from CONFIRMED misreadings (the agent improving itself)

   - flags: `--forget <forget>, --json`
### `nuvira intent`

Plain-English → CLI routing — resolve an ask into the exact `nuvira` command(s) to run

### `nuvira intent resolve`

Resolve a plain-English ask (e.g. "stop the dashboard", "add Rahul to whatsapp") into CLI commands

   - flags: `--json, --semantic`
### `nuvira intent eval`

Score deterministic vs semantic matching over a labeled ask corpus (novel phrasings included)

   - flags: `--json`
### `nuvira code-map`

Project symbol map — functions, classes, methods with line numbers (AST engine)

   - flags: `--json`
### `nuvira tools`

Inspect the agent tool registry (pipeline + experience tools)

### `nuvira tools list`

List every registered tool (the H1 tool-calling surface)

### `nuvira tools show`

Show a tool's description and input schema

### `nuvira tools toolsets`

List toolset groups (capability gating) with enabled state; enable/disable a group

   - flags: `--disable <disable>, --enable <enable>`
### `nuvira parity`

Surface-parity harness — prove the same experience on chat, execute, dashboard, gateway and subagents

### `nuvira parity surfaces`

Compare the surface registry against the real import graph

### `nuvira parity debt`

Check the anti-silo debt ratchet (observed surface debt must equal the frozen list)

### `nuvira parity matrix`

Show every capability × surface and any unproven `supported` claim

### `nuvira parity faults`

List the declared faults the harness can inject, and what each one proves

### `nuvira parity run`

Drive all five surfaces through the real harness and report the verdict

### `nuvira session`

Project-scoped session continuity (debug surface — `continue` is the primary path)

### `nuvira session list`

List recent sessions, optionally filtered by project + time range

   - flags: `--limit <limit>, --project <project>, --since <since>`
### `nuvira session summarize`

Show summary + metadata for one session (transcript: nuvira history show)

### `nuvira session resume`

Run D1 auto-recall for a project and print the recall card

   - flags: `--project <project>, --since <since>`
### `nuvira marketplace`

Browse and install community plugins and workflow templates

### `nuvira marketplace browse`

Browse all available marketplace items

   - flags: `--plugins, --refresh, --workflows`
### `nuvira marketplace search`

Search across plugins and workflow templates

### `nuvira marketplace install`

Install a workflow template from the registry

### `nuvira marketplace info`

Show detailed information about a marketplace item

### `nuvira mcp`

Manage MCP (Model Context Protocol) server connections

### `nuvira mcp list`

List all discovered MCP servers and their tools

### `nuvira mcp connect`

Connect to an MCP server

   - flags: `--all`
### `nuvira mcp call`

Call a tool on an MCP server

   - flags: `--args <args>, --server <server>`
### `nuvira mcp info`

Show detailed information for an MCP server

### `nuvira mcp refresh`

Re-discover and reconnect to all MCP servers

### `nuvira mcp catalog`

List the curated MCP server catalog (vetted, exact-version pins)

   - flags: `--search <search>`
### `nuvira mcp install`

Install a vetted MCP server from the catalog (writes ~/.nuvira/mcp/<name>.json)

   - flags: `--env <env>`
### `nuvira mcp uninstall`

Remove an installed MCP server config

### `nuvira mcp serve`

Expose the agent's H1 tools as an MCP server over stdio (MCP clients / IDEs / other agents can connect)

   - flags: `--with <with>`
### `nuvira ci`

Headless CI/CD mode — structured JSON output and exit codes for pipelines

### `nuvira ci execute`

Execute a goal and emit JSON result (exit 0 = success, 1 = failure)

   - flags: `--context-limit <context_limit>, --context-prune <context_prune>, --github-annotations, --memory, --model <model>, --planner-model <planner_model>, --provider <provider>, --reviewer-model <reviewer_model>, --sandbox, --timeout <timeout>, --writer-model <writer_model>`
### `nuvira ci check`

Run a gate check (exit 0 = pass, 1 = fail) — minimal output, ideal for workflow gates

   - flags: `--model <model>, --provider <provider>, --verbose`
### `nuvira ci review`

Review one or more files and emit JSON findings

   - flags: `--context <context>, --format <format>, --model <model>, --provider <provider>`
### `nuvira publish`

Autonomous publish workflow — version, build, publish to npm & GitHub

   - flags: `--dry-run, --force, --fresh, --from <from>, --major, --minor, --model <model>, --no-preflight, --patch, --provider <provider>, --skip-tests, --verbose`
### `nuvira credentials`

Store GitHub/npm release credentials so the agent can release without re-entering them

### `nuvira credentials status`

Show which release credentials are available, and where each came from

### `nuvira credentials set`

Store a credential in the nuvira credential store

   - flags: `--stdin, --value <value>`
### `nuvira credentials forget`

Delete a stored credential

### `nuvira credentials verify`

Check the stored GitHub and npm tokens against the live services

### `nuvira bedrock`

AWS Bedrock setup and management (dedicated onboarding for Bedrock)

### `nuvira bedrock setup`

Interactive wizard to configure AWS Bedrock (credentials, region, model access)

### `nuvira bedrock status`

Show current Bedrock configuration and connectivity status

### `nuvira bedrock test`

Probe Bedrock models and test inference

   - flags: `--region <region>`
### `nuvira phase`

Phase-wise project scope execution — multi-goal pipelines

### `nuvira phase create`

Create a new phase scope with ordered goals

   - flags: `--output <output>`
### `nuvira phase execute`

Execute a phase scope from start to finish

   - flags: `--dry-run, --model <model>, --non-interactive, --provider <provider>, --skip-tests, --verbose`
### `nuvira phase resume`

Resume a saved phase scope from where it left off

   - flags: `--model <model>, --provider <provider>, --skip-tests, --verbose`
### `nuvira phase status`

Show progress of a phase scope

### `nuvira phase delete`

Delete a saved phase scope

### `nuvira phase list`

List all saved phase scopes

### `nuvira retrieval`

Vector retrieval — token-efficient context via local embeddings

   - flags: `--verbose`
### `nuvira retrieval stats`

Show token-savings transparency (how many tokens retrieval saved)

### `nuvira retrieval index`

Index a repo/file into the retrieval store (chunks embedded locally)

### `nuvira retrieval query`

Semantic search over the indexed repo (top-k chunks)

### `nuvira retrieval clear`

Clear the retrieval index and token-savings stats

### `nuvira knowledge`

Knowledge base — answer questions from your own tagged documents (vector retrieval)

   - flags: `--verbose`
### `nuvira knowledge add`

Ingest files or folders under a tag (extracted, chunked and embedded once)

### `nuvira knowledge query`

Retrieve the most relevant passages for a question, scoped to a tag

   - flags: `--top-k <top_k>`
### `nuvira knowledge list`

List knowledge tags with document and chunk counts

### `nuvira knowledge stats`

Show details for one knowledge tag

### `nuvira knowledge forget`

Remove a tag's vectors and manifest entry

### `nuvira trace`

Inspect and replay per-step reasoning traces (every LLM call in a pipeline)

### `nuvira trace list`

Show recent traces

   - flags: `--limit <limit>`
### `nuvira trace show`

Show a single trace (goal, timing, step summary)

### `nuvira trace replay`

Step-by-step replay of a trace — every LLM call with prompt digest, model, tokens, latency, and routing

   - flags: `--full`
### `nuvira trace clear`

Delete all stored traces

### `nuvira continuity`

Session continuity — what is stored, and how to forget it

### `nuvira continuity list`

Show the continuity switches, stored sessions, and the semantic recall index

### `nuvira continuity clear`

Forget stored continuity data (no flags = both sessions and recall)

   - flags: `--recall, --sessions`
### `nuvira website`

Open the Agent-Nuvira website — capabilities, commands, docs, setup

   - flags: `--url`
---

*472 commands (incl. subcommands) · generated from the live CLI — this file is the drift-guarded surface.*
