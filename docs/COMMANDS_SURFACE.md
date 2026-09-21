<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate: node scripts/generate-commands-surface.mjs -->
<!-- Drift guard: node scripts/generate-commands-surface.mjs --check -->
<!-- Source of truth: src/cli/cli-program.ts (createCLI) — generated from the live commander tree. -->

# CLI Command Surface

Every command, subcommand, alias, and flag the CLI exposes, derived from the
live command tree (not maintained by hand). For task-oriented, copy-pasteable
usage see the curated [COMMANDS.md](./COMMANDS.md).


### `buff`

Nuvira — multi-agent AI coding CLI (local models & cloud APIs)

   - flags: `--debug, --task <task>, --version`
### `buff admin`

Admin governance policy for Auto routing (P6 M6.5) — allow/deny providers & models, hard cost cap, PII privacy, unblock control

### `buff admin policy`

Show the current governance policy + enforcement status

   - flags: `--json`
### `buff admin allow`

Add providers to the allow-list (empty = all providers allowed)

### `buff admin deny`

Add providers to the deny-list (wins over the allow-list)

### `buff admin allow-model`

Add models to the allow-list — a provider survives only if one of its candidate models is listed

### `buff admin deny-model`

Add models to the deny-list (wins over the allow-list)

### `buff admin max-cost`

Set the admin hard max cost per call (USD); joins routing.maxCostUsd (stricter wins)

### `buff admin pii-min`

Set the minimum privacy score (0-1) required when a task matches a PII pattern (default 1.0 = local-only)

### `buff admin unblock`

Control whether `nuvira models unblock` may override REGISTRY-learned blocks (false = admin-hard)

### `buff admin clear`

Remove one governance rule (the policy becomes permissive on that field)

### `buff admin role`

Manage RBAC roles over the admin surface (P6 M6.1 — requires admin role)

### `buff admin role add`

Assign a role to a user (first assignment exits legacy single-user mode)

### `buff admin role remove`

Remove a user's role assignment (if none remain, legacy permissive mode resumes)

### `buff admin role list`

List all role assignments

### `buff admin whoami`

Show the current identity and its effective RBAC permissions

### `buff admin cron`

Scheduled tool invocations (J2 — cron/jobs.py)

### `buff admin cron add`

Add a cron job: nuvira admin cron add nightly-build "0 3 * * *" build

   - flags: `--args <args>, --channel <channel>, --dry-run`
### `buff admin cron list`

List cron jobs with schedule + next run

### `buff admin cron remove`

Remove a cron job

### `buff admin cron run`

Run a cron job NOW (invoke its tool immediately)

### `buff chat`

Start an interactive chat session with AI

   - flags: `--dev, --file <file>, --model <model>, --no-cache, --provider <provider>`
### `buff edit`

Edit a file using AI assistance

   - flags: `--auto-route, --dry-run, --instruction <instruction>, --model <model>, --provider <provider>, --review`
### `buff plan`

Generate an implementation plan for a codebase task

   - flags: `--model <model>, --provider <provider>, --task <task>, --verbose`
### `buff config`

Manage Buff configuration

### `buff config set`

Set a configuration value

### `buff config get`

Get a configuration value

### `buff config list`

List all providers and their status

### `buff config init`

Initialize configuration interactively

### `buff config vault`

Secret vault management (Phase A1)

### `buff config vault status`

Show the active vault tier and migration state

### `buff config vault log`

Show recent vault access-log entries (K3 tamper-evident audit)

   - flags: `--limit <limit>`
### `buff config vault migrate-keys`

Move plaintext provider API keys from buffconfig.json into the vault

### `buff config gateway`

Manage gateway platform transports (tokens written to ~/.nuvira/.env)

### `buff config gateway list`

Show every platform transport and its env-var status

### `buff config gateway set`

Configure a platform transport (interactive wizard, or --set VAR=value)

   - flags: `--set <set>`
### `buff config gateway remove`

Remove a platform transport from the env file

   - flags: `--yes`
### `buff config gateway allow`

Allow a user/group to trigger the agent on a platform (written to gateway.policies in config)

### `buff config gateway disallow`

Remove a user/group from the allowed list of a platform

### `buff config gateway reply`

Set how unapproved senders are handled on a platform: polite (⛔ message) or silent (no reply)

### `buff config gateway send-authority`

Manage who may command the agent to send to OTHER people (gateway_send). Outbound-only gate — separate from `allow` (who may trigger).

### `buff config gateway notify`

Manage status recipients — contacts/groups that ALWAYS get pipeline completion summaries

### `buff config gateway ask-user-wait`

Ask-and-wait for clarifying questions on messaging channels: when a turn asks the sender a question, hold it for their reply instead of assuming option 1

### `buff cache`

Manage inference cache

### `buff cache stats`

Show cache statistics

### `buff cache clear`

Clear all cached responses

### `buff models`

List available models from inference providers

   - flags: `--all, --json, --provider <provider>, --search <search>, --verify`
### `buff models refresh`

Probe providers and spot-check models, updating the Model Availability Registry

   - flags: `--json, --no-spot-check`
### `buff models status`

Show the Model Availability Registry (verified / unavailable / quota-parked models)

   - flags: `--json, --verbose`
### `buff models unblock`

Manually release a registry-blocked provider (escape hatch) and re-probe it against the live API

   - flags: `--json, --no-spot-check`
### `buff models excluded`

Show which providers routing is currently skipping, and why (failure cooldowns, registry blocks, governance policy)

   - flags: `--json`
### `buff models staleness`

Show model staleness: last probe time, days since verification, and removal risk

   - flags: `--json`
### `buff models watch`

Run the model-registry maintenance daemon: probe + spot-check on a schedule

   - flags: `--interval <interval>, --no-spot-check`
### `buff execute`

Run a multi-agent pipeline to accomplish a goal

   - flags: `--auto-branch, --auto-route, --checkpoint, --checkpoint-list, --context-limit <context_limit>, --context-prune <context_prune>, --dry-run, --engine <engine>, --gatherer-model <gatherer_model>, --json-events, --max-repairs <max_repairs>, --memory, --memory-clear, --memory-stats, --model <model>, --no-tool-calling, --plan-mode <plan_mode>, --planner-model <planner_model>, --provider <provider>, --repair-fallback-models <repair_fallback_models>, --repair-mode <repair_mode>, --resume [resume], --review, --reviewer-model <reviewer_model>, --sandbox, --skip-tests, --tool-calling, --verbose, --writer-model <writer_model>`
### `buff run`

Execute a shell command and show output (lightweight alternative to the full pipeline)

   - flags: `--timeout <timeout>, --verbose`
### `buff workflow`

Run, manage, and share workflow templates

### `buff workflow list`

Show available workflow templates (built-in + installed)

### `buff workflow run`

Run a workflow template

   - flags: `--dry-run, --model <model>, --provider <provider>, --verbose`
### `buff workflow search`

Search the GitHub workflow template registry

   - flags: `--refresh`
### `buff workflow install`

Install a workflow template from the GitHub registry

### `buff workflow publish`

Prepare a local workflow template for publishing to the registry

### `buff workflow info`

Show detailed information about a registry template

### `buff workflow upgrade`

Check for and apply template upgrades from the registry

### `buff whatsapp`

WhatsApp bridge (Baileys) — pair a personal number via QR and check status (I8)

### `buff whatsapp pair`

Pair WhatsApp (personal number — no Meta Business account, no paid API)

   - flags: `--phone <phone>, --timeout <timeout>`
### `buff whatsapp status`

Show bridge session path + pairing state

### `buff whatsapp contacts`

List resolvable contacts (mapping file + learned) — connects briefly to learn names from live traffic

   - flags: `--timeout <timeout>`
### `buff whatsapp contact`

Manage the WhatsApp contact-name mapping (send by name: nuvira gateway send whatsapp:<Name> "message")

### `buff whatsapp contact add`

Map a display name to a number (E.164, no +): nuvira whatsapp contact add Name 919876543210

### `buff whatsapp contact remove`

Remove a mapped contact name

### `buff plugins`

Manage provider plugins, agent plugins, and workflow templates

### `buff plugins list`

List all discovered plugins and workflows

### `buff plugins scan`

Force re-scan all plugin directories

### `buff learn`

Self-improvement system — agent stats, patterns, and optimization

### `buff learn stats`

Show per-agent performance statistics

### `buff learn patterns`

Show extracted coding patterns

   - flags: `--extract, --model <model>, --provider <provider>`
### `buff learn lessons`

Show failure lessons — what past runs learned from mistakes

   - flags: `--extract, --model <model>, --provider <provider>`
### `buff learn optimize`

Generate optimized model-to-agent routing recommendations

### `buff learn status`

Show overall self-improvement status

### `buff learn clear`

Reset all learning data (stats, patterns, memory)

   - flags: `--force`
### `buff learn compare`

Compare benchmark results between two models

   - flags: `--all, --last`
### `buff learn feedback`

Rate a trajectory or view feedback statistics

   - flags: `--comment <comment>, --rating <rating>, --stats, --trajectory <trajectory>`
### `buff learn quality`

Show pattern quality and decay metrics

   - flags: `--details`
### `buff learn gc`

Garbage-collect low-quality patterns

   - flags: `--dry-run`
### `buff init`

Scaffold a new project from a template

   - flags: `--list, --model <model>, --provider <provider>, --template <template>, --template-dir <template_dir>`
### `buff stats`

View usage statistics and cost tracking

### `buff stats cost`

Show API cost tracking details

   - flags: `--clear`
### `buff stats history`

Show conversation history statistics

### `buff history`

Browse and search conversation history

### `buff history list`

Show all saved conversations

   - flags: `--limit <limit>`
### `buff history search`

Search conversations by keyword or semantic similarity

   - flags: `--limit <limit>, --semantic`
### `buff history show`

Show a specific conversation

### `buff history clear`

Clear all conversation history

### `buff history prune`

Remove conversations older than the retention period

   - flags: `--days <days>`
### `buff history reindex`

Rebuild the semantic search index for all past conversations (embeds each session for vector search)

### `buff skill`

Manage and run compiled skills — reusable execution plans derived from past trajectories

### `buff skill list`

List all compiled skills

   - flags: `--quality <quality>`
### `buff skill show`

Show detailed skill definition

### `buff skill run`

Run a skill — resolves parameters and invokes the multi-agent pipeline

   - flags: `--auto-route, --dry-run, --memory, --model <model>, --params <params>, --provider <provider>, --verbose`
### `buff skill compile`

Force skill compilation from stored trajectories

   - flags: `--model <model>, --provider <provider>`
### `buff skill search`

Search skills by name, tag, or description

### `buff skill gc`

Garbage-collect low-quality skills

   - flags: `--dry-run`
### `buff skill quality`

Show skill quality and decay metrics

   - flags: `--details`
### `buff skill clear`

Remove all compiled skills

   - flags: `--force`
### `buff skills`

Skills hub — search, install, update, and audit community skills (J3)

### `buff skills search`

Search all configured skill registries (I7 P1 multi-source)

   - flags: `--refresh, --source <source>`
### `buff skills install`

Install a skill from the configured registries into <project>/.agents/skills/ (sandboxed, checksummed)

   - flags: `--project <project>, --source <source>`
### `buff skills uninstall`

Uninstall a skill: removes .agents/skills/<name> and its provenance record

   - flags: `--project <project>`
### `buff skills update`

Update installed skills to newer registry versions (checksum-verified)

   - flags: `--project <project>`
### `buff skills bundle`

P6b — skill bundles: group skills under one id and load them together (Hermes parity)

   - flags: `--create, --delete, --description <description>, --name <name>, --skills <skills>`
### `buff skills list`

List installed skills with provenance (origin: registry vs local)

   - flags: `--origin <origin>, --project <project>`
### `buff gateway`

Multi-channel gateway — talk to the agent from Telegram/Discord/Slack/WhatsApp/Email/Signal (J1)

### `buff gateway status`

Show configured adapters and reachable channels

### `buff gateway send`

Send a message to a channel alias or platform:channelId

### `buff gateway send-media`

Send a media file (image/video/audio/document) — type from the file extension; WhatsApp/Telegram/Discord

   - flags: `--caption <caption>`
### `buff gateway alias`

Manage channel aliases

### `buff gateway alias add`

Register an alias: nuvira gateway alias add ops slack C0123

### `buff gateway alias remove`

Remove an alias

### `buff gateway contact`

Manage contacts for outbound messaging (name → platform:id resolution)

### `buff gateway contact list`

List all contacts with status, platform, and ID

   - flags: `--pending, --platform <platform>`
### `buff gateway contact approve`

Approve a contact for outbound messaging

   - flags: `--platform <platform>`
### `buff gateway contact reject`

Reject a contact (block outbound messages)

   - flags: `--platform <platform>`
### `buff gateway contact delete`

Delete a contact permanently

   - flags: `--platform <platform>`
### `buff gateway contact add`

Manually add a contact (e.g. nuvira gateway contact add Anuj telegram 616825477)

   - flags: `--phone <phone>`
### `buff gateway delivery`

Show the delivery ledger (failed sends awaiting retry) and optionally drain it

   - flags: `--flush`
### `buff gateway logs`

Show the structured gateway log (send failures, refused senders, pipeline outcomes)

   - flags: `--event <event>, --limit <limit>, --path`
### `buff gateway history`

Manage per-contact conversation history (gateway chat memory)

### `buff gateway history list`

List all stored conversations with last message preview

   - flags: `--platform <platform>`
### `buff gateway history show`

Show conversation history for a contact (e.g. nuvira gateway history show whatsapp:918800663237)

   - flags: `--limit <limit>`
### `buff gateway history clear`

Clear conversation history for a contact

### `buff gateway history prune`

Remove conversations older than 7 days

### `buff gateway start`

Run all configured adapters in the foreground (Ctrl-C to stop; --supervise auto-restarts on crash)

   - flags: `--host <host>, --no-events, --port <port>, --supervise`
### `buff gateway stop`

Stop a running gateway gracefully (SIGTERM — from any terminal)

   - flags: `--port <port>`
### `buff gateway setup`

Interactive setup wizard for a messaging platform (e.g. nuvira gateway setup telegram)

### `buff model`

Manage inference providers and models — switch, list, inspect, and recommend

### `buff model list` (aliases: `ls`)

List all providers and their configuration status

   - flags: `--all, --json`
### `buff model switch`

Switch active provider/model (interactive or via argument). Use `auto` for smart routing

   - flags: `--model <model>, --provider <provider>`
### `buff model info`

Show current active provider and model configuration

   - flags: `--verbose`
### `buff model recommend`

Show model routing recommendations

### `buff model explain`

Explain Auto model routing — why a provider/model would be picked for a task

   - flags: `--agent <agent>, --json, --since <since>`
### `buff model health`

Quick health check for the currently active provider

   - flags: `--provider <provider>, --verbose`
### `buff model bandit`

Show learning-router bandit state (Thompson-sampling priors per provider × complexity bucket). Action: reset

   - flags: `--json`
### `buff model ml`

Show the ML task-similarity router state (learned outcomes per provider, kNN over task features). Action: reset

   - flags: `--json`
### `buff model quota`

Show the central quota ledger (tokens/requests per provider × model, reset windows, parked state). Actions: reset | set <provider> | clear <provider>

   - flags: `--cost-usd <cost_usd>, --json, --requests <requests>, --tokens <tokens>, --window-ms <window_ms>`
### `buff benchmark`

Run standardized model benchmarks against coding tasks

### `buff benchmark run`

Run the benchmark suite

   - flags: `--budget <budget>, --format <format>, --model <model>, --provider <provider>, --routing, --tasks <tasks>`
### `buff benchmark list`

List available benchmark tasks

### `buff benchmark results`

Show previous benchmark results

   - flags: `--compare, --format <format>, --last`
### `buff benchmark clear`

Clear all benchmark data

### `buff eval`

Run the Agent-Nuvira evaluation framework — measures if the agent is actually improving

### `buff eval run`

Run the evaluation suite

   - flags: `--budget <budget>, --engine <engine>, --format <format>, --keep-workspaces, --model <model>, --pace, --provider <provider>, --routing, --suite <suite>, --tasks <tasks>`
### `buff eval list`

List available eval tasks

### `buff eval results`

Show previous eval runs

   - flags: `--compare, --format <format>, --last`
### `buff eval score`

Show the evaluation scoring rules

### `buff eval clear`

Clear all eval data

### `buff sandbox`

Manage Docker sandbox isolation for code execution

### `buff sandbox status`

Check Docker availability and sandbox status

### `buff sandbox config`

Show or update sandbox configuration

   - flags: `--cpu <cpu>, --disable, --disk <disk>, --enable, --image <image>, --memory <memory>, --network, --timeout <timeout>`
### `buff sandbox images`

List available pre-defined sandbox images

### `buff sandbox run`

Run a command inside a new sandbox container

   - flags: `--cpu <cpu>, --image <image>, --memory <memory>, --network, --project <project>, --timeout <timeout>`
### `buff sandbox cleanup`

Destroy all active sandbox containers

### `buff doctor`

Run diagnostic checks on all provider configurations and system health

   - flags: `--enterprise, --fix, --nuvira, --provider <provider>, --verbose, --watch`
### `buff memory`

Manage agent memory store — compression, pruning, and optimization

### `buff memory stats`

Show memory store statistics

### `buff memory optimize`

Run automatic memory compression and pruning

   - flags: `--aggressive, --dry-run`
### `buff memory prune`

Prune old or low-quality trajectories

   - flags: `--max-age <max_age>, --max-count <max_count>, --min-score <min_score>, --verbose`
### `buff memory summarize`

Summarize old trajectories by merging similar ones

   - flags: `--retention <retention>, --verbose`
### `buff memory info`

Show detailed compression analysis

### `buff memory backend`

Show the active vector-search backend and why it was chosen

   - flags: `--check`
### `buff memory list`

List all memory entries (facts, preferences, lessons, observations)

   - flags: `--limit <limit>, --type <type>`
### `buff memory search`

Search memory entries by content

   - flags: `--limit <limit>, --type <type>`
### `buff memory add`

Add a memory entry

   - flags: `--tags <tags>, --type <type>`
### `buff memory delete`

Delete a memory entry by ID

### `buff memory export`

Export all memories to a JSON file

   - flags: `--output <output>`
### `buff memory import`

Import memories from a JSON file

   - flags: `--merge`
### `buff memory facts`

Fact & preference memory (project-scoped, cross-session)

### `buff memory facts list`

List facts, optionally for a project (git slug or cwd:<hash>)

   - flags: `--project <project>`
### `buff memory facts add`

Manually store a fact for the current project

   - flags: `--project <project>, --tags <tags>`
### `buff memory facts stats`

Show fact-store statistics

### `buff memory clear`

Clear all stored trajectories and reset memory

   - flags: `--force`
### `buff dashboard`

Launch the web-based dashboard for visualizing agent execution and system status

   - flags: `--build, --cwd <cwd>, --force, --host <host>, --no-open, --port <port>`
### `buff dashboard stop`

Stop a running dashboard gracefully (SIGTERM — from any terminal)

   - flags: `--port <port>`
### `buff agent`

Scaffold and manage custom agent-baba-d agents

### `buff agent create`

Create a new custom agent project from a template

   - flags: `--agent-name <agent_name>, --description <description>, --dir <dir>`
### `buff agent list`

List all discovered custom agent plugins

### `buff agent info`

Show details about a discovered agent plugin

### `buff federation`

Connect to and manage remote agent instances

### `buff federation status`

Show federation connection status and configuration

### `buff federation start`

Start the federation server (listens for incoming connections)

   - flags: `--auth <auth>, --daemon, --host <host>, --oidc-public-key <oidc_public_key>, --port <port>, --secret <secret>`
### `buff federation connect`

Connect to a remote federation server

   - flags: `--port <port>, --secret <secret>`
### `buff federation disconnect`

Disconnect from the remote federation server

### `buff federation run`

Run a task on the remote federation server

   - flags: `--agent <agent>, --model <model>, --no-stream, --provider <provider>, --timeout <timeout>`
### `buff federation health`

Check the health of the remote federation server

### `buff federation config`

Show or update federation configuration

   - flags: `--set-port <set_port>, --set-secret <set_secret>, --show`
### `buff federation a2a`

A2A (Agent-to-Agent) protocol — discover and connect to external A2A-compliant agents

### `buff federation a2a discover`

Discover an A2A-compliant agent and fetch its AgentCard

### `buff federation a2a start`

Start the A2A server (listens for incoming A2A connections)

   - flags: `--host <host>, --port <port>`
### `buff federation a2a status`

Check the health and status of a remote A2A agent

### `buff federation a2a run`

Delegate a task to a remote A2A-compliant agent

   - flags: `--agent <agent>, --skill <skill>, --timeout <timeout>`
### `buff team`

Team collaboration — shared config, git-synced memory, and review workflow

### `buff team init`

Initialize team configuration in the working directory

   - flags: `--branch <branch>, --repo <repo>`
### `buff team join`

Clone and join an existing team repository

### `buff team sync`

Sync team memory with remote (pull latest + push local changes)

### `buff team status`

Show team configuration and memory status

### `buff team share`

Share local trajectories and patterns with the team

### `buff team review`

Manage review bundles — agent PR → review → merge workflow

### `buff team review list`

List all review bundles

   - flags: `--limit <limit>`
### `buff team review show`

Show a specific review bundle with full details

### `buff team review approve`

Approve a review bundle (sets status to approved)

   - flags: `--message <message>`
### `buff team review request-changes`

Request changes on a review bundle

### `buff team review reject`

Reject a review bundle

### `buff team review merge`

Merge an approved review into the working directory

### `buff team review create`

Create a review bundle from specified files

   - flags: `--files <files>, --model <model>, --provider <provider>`
### `buff sdk`

Create and manage custom agents with the Agent-Nuvira SDK

### `buff sdk scaffold`

Generate a new custom agent project

   - flags: `--agent-type <agent_type>, --template <template>`
### `buff sdk templates`

List available scaffold templates

### `buff sdk info`

Show SDK package info and version

### `buff sdk register`

Register a custom agent with the orchestrator

   - flags: `--icon <icon>, --orchestrator-path <orchestrator_path>`
### `buff sdk unregister`

Remove a custom agent from the orchestrator

   - flags: `--orchestrator-path <orchestrator_path>`
### `buff provider`

List and check health of all inference providers

### `buff provider list`

Show all providers with color-coded status table

   - flags: `--all`
### `buff provider health`

Show detailed health checks for one or all providers

   - flags: `--verbose, --watch`
### `buff security`

Scan code, prompts, or files for security issues

### `buff security scan`

Scan for PII, injection attempts, or dangerous code patterns

   - flags: `--code, --file <file>, --generated, --json, --pii, --prompt, --stdin, --strict`
### `buff audit`

Verify and export the tamper-evident (hash-chained) audit trail (P6 M6.3)

### `buff audit verify`

Verify hash-chain integrity of audit stores (tamper detection)

   - flags: `--file <file>, --json`
### `buff audit export`

Export an audit store as SIEM-friendly CEF lines

   - flags: `--file <file>, --out <out>`
### `buff sbom`

Generate and verify the CycloneDX software bill of materials (P6 M6.6)

   - flags: `--json, --licenses, --out <out>, --reproducible, --sbom <sbom>, --verify`
### `buff feedback`

Record, view, and manage user feedback on agent outputs

### `buff feedback record`

Record feedback for a trajectory (interactive)

   - flags: `--comment <comment>, --negative, --neutral, --positive`
### `buff feedback list`

Show recent feedback entries

   - flags: `--limit <limit>, --trajectory <trajectory>`
### `buff feedback stats`

Show aggregated feedback statistics

### `buff feedback clear`

Clear all feedback data

### `buff nlu`

NLU request understanding — debug intent/entity/action resolution

### `buff nlu debug`

Debug how a request is understood (rule path + optional LLM verify)

   - flags: `--llm`
### `buff intent`

Plain-English → CLI routing — resolve an ask into the exact `buff` command(s) to run

### `buff intent resolve`

Resolve a plain-English ask (e.g. "stop the dashboard", "add Rahul to whatsapp") into CLI commands

   - flags: `--json, --semantic`
### `buff intent eval`

Score deterministic vs semantic matching over a labeled ask corpus (novel phrasings included)

   - flags: `--json`
### `buff code-map`

Project symbol map — functions, classes, methods with line numbers (AST engine)

   - flags: `--json`
### `buff tools`

Inspect the agent tool registry (pipeline + experience tools)

### `buff tools list`

List every registered tool (the H1 tool-calling surface)

### `buff tools show`

Show a tool's description and input schema

### `buff tools toolsets`

List toolset groups (capability gating) with enabled state; enable/disable a group

   - flags: `--disable <disable>, --enable <enable>`
### `buff session`

Project-scoped session continuity (debug surface — `continue` is the primary path)

### `buff session list`

List recent sessions, optionally filtered by project + time range

   - flags: `--limit <limit>, --project <project>, --since <since>`
### `buff session summarize`

Show summary + metadata for one session (transcript: nuvira history show)

### `buff session resume`

Run D1 auto-recall for a project and print the recall card

   - flags: `--project <project>, --since <since>`
### `buff marketplace`

Browse and install community plugins and workflow templates

### `buff marketplace browse`

Browse all available marketplace items

   - flags: `--plugins, --refresh, --workflows`
### `buff marketplace search`

Search across plugins and workflow templates

### `buff marketplace install`

Install a workflow template from the registry

### `buff marketplace info`

Show detailed information about a marketplace item

### `buff mcp`

Manage MCP (Model Context Protocol) server connections

### `buff mcp list`

List all discovered MCP servers and their tools

### `buff mcp connect`

Connect to an MCP server

   - flags: `--all`
### `buff mcp call`

Call a tool on an MCP server

   - flags: `--args <args>, --server <server>`
### `buff mcp info`

Show detailed information for an MCP server

### `buff mcp refresh`

Re-discover and reconnect to all MCP servers

### `buff mcp catalog`

List the curated MCP server catalog (vetted, exact-version pins)

   - flags: `--search <search>`
### `buff mcp install`

Install a vetted MCP server from the catalog (writes ~/.nuvira/mcp/<name>.json)

   - flags: `--env <env>`
### `buff mcp uninstall`

Remove an installed MCP server config

### `buff mcp serve`

Expose the agent's H1 tools as an MCP server over stdio (MCP clients / IDEs / other agents can connect)

   - flags: `--with <with>`
### `buff ci`

Headless CI/CD mode — structured JSON output and exit codes for pipelines

### `buff ci execute`

Execute a goal and emit JSON result (exit 0 = success, 1 = failure)

   - flags: `--context-limit <context_limit>, --context-prune <context_prune>, --github-annotations, --memory, --model <model>, --planner-model <planner_model>, --provider <provider>, --reviewer-model <reviewer_model>, --sandbox, --timeout <timeout>, --writer-model <writer_model>`
### `buff ci check`

Run a gate check (exit 0 = pass, 1 = fail) — minimal output, ideal for workflow gates

   - flags: `--model <model>, --provider <provider>, --verbose`
### `buff ci review`

Review one or more files and emit JSON findings

   - flags: `--context <context>, --format <format>, --model <model>, --provider <provider>`
### `buff publish`

Autonomous publish workflow — version, build, publish to npm & GitHub

   - flags: `--dry-run, --major, --minor, --model <model>, --patch, --provider <provider>, --skip-tests, --verbose`
### `buff bedrock`

AWS Bedrock setup and management (dedicated onboarding for Bedrock)

### `buff bedrock setup`

Interactive wizard to configure AWS Bedrock (credentials, region, model access)

### `buff bedrock status`

Show current Bedrock configuration and connectivity status

### `buff bedrock test`

Probe Bedrock models and test inference

   - flags: `--region <region>`
### `buff phase`

Phase-wise project scope execution — multi-goal pipelines

### `buff phase create`

Create a new phase scope with ordered goals

   - flags: `--output <output>`
### `buff phase execute`

Execute a phase scope from start to finish

   - flags: `--dry-run, --model <model>, --non-interactive, --provider <provider>, --skip-tests, --verbose`
### `buff phase resume`

Resume a saved phase scope from where it left off

   - flags: `--model <model>, --provider <provider>, --skip-tests, --verbose`
### `buff phase status`

Show progress of a phase scope

### `buff phase delete`

Delete a saved phase scope

### `buff phase list`

List all saved phase scopes

### `buff retrieval`

Vector retrieval — token-efficient context via local embeddings

   - flags: `--verbose`
### `buff retrieval stats`

Show token-savings transparency (how many tokens retrieval saved)

### `buff retrieval index`

Index a repo/file into the retrieval store (chunks embedded locally)

### `buff retrieval query`

Semantic search over the indexed repo (top-k chunks)

### `buff retrieval clear`

Clear the retrieval index and token-savings stats

### `buff trace`

Inspect and replay per-step reasoning traces (every LLM call in a pipeline)

### `buff trace list`

Show recent traces

   - flags: `--limit <limit>`
### `buff trace show`

Show a single trace (goal, timing, step summary)

### `buff trace replay`

Step-by-step replay of a trace — every LLM call with prompt digest, model, tokens, latency, and routing

   - flags: `--full`
### `buff trace clear`

Delete all stored traces

---

*421 commands (incl. subcommands) · generated from the live CLI — this file is the drift-guarded surface.*
