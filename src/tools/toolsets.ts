/**
 * H1b — Toolsets (`src/tools/toolsets.ts`).
 *
 * Capability-gating parity (`toolsets` + `toolset_validation.py`
 * + `web_routers/tools.py:get_toolsets`): the registry's tools are grouped
 * into named toolsets — the "capabilities" a user toggles. Each toolset can
 * be enabled/disabled via config (`tools.toolsets.<name>.enabled` in
 * `~/.nuvira/buffconfig.json`; absent = enabled).
 *
 * Two enforcement points (I1, the capability gate):
 * 1. **Schema gating** — the tool JSON schema handed to native tool-calling
 *    providers is built from ENABLED toolsets only, so the model never sees a
 *    disabled tool (the capability-gating behavior).
 * 2. **Execution gate** — calling a disabled tool returns an explicit error
 *    instead of running it. This is the single runtime-honored enforcement
 *    point: a future dashboard toggle is never cosmetic (same rule as the
 *    skills bridge).
 *
 * The catalog here is the ONLY place tools are assigned to groups; a tool not
 * listed in any toolset is treated as always-enabled (never accidentally
 * filtered) and is surfaced by `validateToolsetCoverage` for the CLI.
 */

import { listTools, toolJsonSchemas, type Tool, type ToolJsonSchema } from './registry.js';
import { ConfigManager } from '../config/manager.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A named group of registry tools — the user-visible "capability". */
export interface ToolsetDef {
  /** Toolset id (config key `tools.toolsets.<name>.enabled`). */
  name: string;
  /** Human label for CLI/dashboard. */
  label: string;
  /** One-line description shown in `nuvira tools toolsets`. */
  description: string;
  /** Registry tool names in this group. */
  tools: string[];
  /** Toolsets with no in-code tools (config-only toolsets). */
  configOnly?: boolean;
  /** True when this toolset gates MCP-server tools (dynamic, no static names). */
  bindsMcpServers?: boolean;
}

/** Per-toolset state read from config (absent entry = enabled). */
export interface ToolsetStateMap {
  [name: string]: { enabled?: boolean };
}

/** A ConfigManager-shaped object (real instance or a test stub). */
export interface ConfigManagerLike {
  getAll?(): { tools?: { toolsets?: ToolsetStateMap } };
  save?(config: { tools: { toolsets: ToolsetStateMap } }): void;
}

// ─── The catalog (single source of tool→group assignment) ───────────────────

export const TOOLSETS: ToolsetDef[] = [
  {
    name: 'core',
    label: 'Core',
    description: 'Pipeline actions that drive the multi-agent orchestrator (build/resume/repair/document/website/analyze/test).',
    tools: ['build', 'resume', 'repair', 'document', 'website', 'analyze', 'test'],
  },
  {
    name: 'publish',
    label: 'Publish',
    description: 'Release publishing to npm/GitHub, plus the credentials it needs (store a GitHub/npm token so a release works without an environment export). Publishing is IRREVERSIBLE — confirmation flows stay active.',
    tools: ['publish', 'credentials'],
  },
  {
    name: 'experience',
    label: 'Experience',
    description: 'In-loop UX tools: clarification (ask_user), requirement verification, end-of-response follow-ups, loading reusable capability packs (skill), and recording a finding whose verdict the gate computes from the evidence supplied.',
    tools: ['ask_user', 'suggest_followups', 'verify_requirement', 'skill', 'finding'],
  },
  {
    name: 'code',
    label: 'Code',
    description: 'Project code search (ripgrep), sub-agent delegation, assessing OTHER repositories (clone_repo — shallow clone into an ephemeral cache), structured git (diff card + gated commit), document extraction, credential management.',
    tools: ['code_search', 'delegate', 'clone_repo', 'git', 'read_extract', 'credential_files'],
  },
  {
    name: 'coding',
    label: 'Coding',
    description: 'Interactive file access + verification for the agent loop: read files, list directories, glob, edit/write files, run terminal commands (tests/typecheck/build) — deny-first, workspace-scoped; state-changing actions are confirmation-gated — and the plan/todo checklist that tracks multi-step work.',
    tools: ['read_file', 'list_dir', 'glob', 'edit_file', 'write_file', 'run_terminal', 'plan_todo', 'terminal'],
  },
  {
    name: 'web',
    label: 'Web research',
    description: 'Web search + page reading (free backends: DuckDuckGo / SearXNG / Jina Reader).',
    tools: ['web_search', 'read_page'],
  },
  {
    name: 'channels',
    label: 'Channels',
    description: 'Message delivery through the gateway (WhatsApp by contact name or number, Telegram, Slack, Discord, email, aliases).',
    tools: ['gateway_send', 'send_message'],
  },
  {
    name: 'system',
    label: 'System & tooling',
    description: 'Plain-English system/tooling control: start/stop the dashboard or gateway, verified senders, platform setup, evals, stats, multi-LLM routing (via the nuvira CLI — run_cli).',
    tools: ['run_cli', 'openrouter_client'],
  },
  {
    name: 'browser',
    label: 'Browser',
    description: 'Real-browser automation (optional playwright install).',
    tools: ['browser', 'browser_supervisor', 'browser_dialog', 'camofox'],
  },
  {
    name: 'media',
    label: 'Media & modality',
    description: 'Image generation, speech synthesis, transcription, vision, video generation, voice mode, desktop automation, TTS streaming.',
    tools: ['generate_image', 'speak', 'transcribe', 'describe_image', 'vision', 'video_generate', 'voice_mode', 'wake_word', 'neutts_synth', 'computer_use', 'tts_streaming', 'tts_text_normalize'],
  },
  {
    name: 'mcp-tools',
    label: 'MCP Integration',
    description: 'MCP OAuth, schema cache, and watchdog tools.',
    tools: ['mcp_oauth', 'mcp_schema_cache', 'mcp_watchdog'],
  },
  {
    name: 'docker',
    label: 'Docker',
    description: 'Docker container and image management.',
    tools: ['docker'],
  },
  {
    name: 'productivity',
    label: 'Productivity',
    description: 'Kanban boards, cronjobs, todos, session management, and persistent memory.',
    tools: ['kanban', 'cronjob', 'todo', 'session', 'memory'],
  },
  {
    name: 'security',
    label: 'Security',
    description: 'Schema sanitization, binary detection, approvals, env probing, write approval.',
    tools: ['sanitize', 'binary_extensions', 'approval', 'env_probe', 'write_approval'],
  },
  {
    name: 'project',
    label: 'Project Tools',
    description: 'Blueprints, working diffs, file operations, debug helpers.',
    tools: ['blueprint', 'working_diff', 'file_ops', 'debug'],
  },
  {
    name: 'delegation',
    label: 'Delegation',
    description: 'Subagent spawning, delegation system, managed gateway, async execution, live logs.',
    tools: ['delegate_system', 'subagent', 'managed_gateway', 'messaging', 'async_delegation', 'delegation_live_log'],
  },
  {
    name: 'platforms',
    label: 'Platform Integrations',
    description: 'Discord, Home Assistant, Microsoft Graph, Feishu.',
    tools: ['discord', 'homeassistant', 'microsoft_graph', 'feishu_doc', 'feishu_drive'],
  },
  {
    name: 'mcp',
    label: 'MCP servers',
    description: 'MCP server connection, tool discovery, and invocation. Disabling removes MCP tools from the model schema.',
    tools: ['mcp_tool'],
    bindsMcpServers: true,
  },
  {
    name: 'infrastructure',
    label: 'Infrastructure',
    description: 'Critical infrastructure: interrupts, daemons, process registry, code execution, checkpoints.',
    tools: ['interrupt', 'daemon_pool', 'process_registry', 'code_execution', 'checkpoint'],
  },
  {
    name: 'security-deep',
    label: 'Deep Security',
    description: 'Advanced security: AST audit, threat patterns, URL safety, path security, scoring.',
    tools: ['ast_audit', 'threat_patterns', 'url_safety', 'path_security', 'security_score'],
  },
  {
    name: 'infra-utility',
    label: 'Infrastructure Utility',
    description: 'Tool search, budget config, fuzzy matching, lazy deps, backend helpers, output limits, result storage.',
    tools: ['tool_search', 'budget_config', 'fuzzy_match', 'lazy_deps', 'tool_backend', 'tool_output_limits', 'tool_result_storage'],
  },
  {
    name: 'utility',
    label: 'Utility',
    description: 'Small utilities: ANSI strip, OSV check, patch parser, image source.',
    tools: ['ansi_strip', 'osv_check', 'patch_parser', 'image_source'],
  },
  {
    name: 'skills-ecosystem',
    label: 'Skills Ecosystem',
    description: 'Skill marketplace, sync, usage tracking, and provenance.',
    tools: ['skills_hub', 'skills_sync', 'skills_sync_client', 'skill_usage', 'skill_provenance'],
  },
  {
    name: 'memory',
    label: 'Memory',
    description: 'Persistent memory management — add, search, delete, replace memories.',
    tools: ['add_memory', 'search_memory', 'delete_memory', 'replace_memory', 'list_memories', 'memory_stats'],
  },
];

/** Find the toolset that owns a tool name (undefined → tool is always-enabled). */
export function toolsetForTool(toolName: string): ToolsetDef | undefined {
  return TOOLSETS.find((t) => t.tools.includes(toolName));
}

/**
 * Integrity check over the registry: every registered tool must belong to
 * EXACTLY ONE toolset (no unassigned, no duplicates across groups). Returns
 * the violations so the CLI can surface them instead of silently gating.
 */
export function validateToolsetCoverage(registered: string[]): { unassigned: string[]; duplicated: string[] } {
  const seen = new Map<string, number>();
  for (const toolset of TOOLSETS) {
    for (const name of toolset.tools) {
      seen.set(name, (seen.get(name) || 0) + 1);
    }
  }
  const unassigned = registered.filter((n) => !seen.has(n));
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([n]) => n);
  return { unassigned, duplicated };
}

// ─── Config-backed state ────────────────────────────────────────────────────

/**
 * Read the toolsets state map. Accepts a real ConfigManager or a stub
 * (`{ getAll() {...} }`); a stub without `getAll` (or any read failure)
 * yields `{}` = all toolsets enabled — the graceful default, so existing
 * callers that pass a bare object never accidentally gate on real config.
 */
export function readToolsetsState(cm?: ConfigManagerLike): ToolsetStateMap {
  try {
    const cfg = cm?.getAll?.();
    const toolsets = cfg?.tools?.toolsets;
    return toolsets && typeof toolsets === 'object' ? toolsets : {};
  } catch {
    return {};
  }
}

/** Names of toolsets currently disabled (absent entry = enabled). */
export function disabledToolsetNames(state?: ToolsetStateMap): string[] {
  const map = state ?? {};
  return TOOLSETS.filter((t) => map[t.name]?.enabled === false).map((t) => t.name);
}

/**
 * Persist a toolset's enabled state. Uses the provided ConfigManager when
 * given (CLI/dashboard pass their own), else constructs a fresh one.
 * Throws for an unknown toolset name (typo-safe for `nuvira tools toolsets`).
 */
export function setToolsetEnabled(name: string, enabled: boolean, cm?: ConfigManagerLike): void {
  if (!TOOLSETS.some((t) => t.name === name)) {
    throw new Error(`Unknown toolset '${name}' — run \`nuvira tools toolsets\` to see the catalog.`);
  }
  // Deep-merge the entry so any FUTURE per-toolset keys (provider, env, …)
  // survive a toggle — only `enabled` flips, nothing else is clobbered.
  const current = readToolsetsState(cm)[name] || {};
  const save = cm?.save ? cm.save.bind(cm) : (config: { tools: { toolsets: ToolsetStateMap } }) => new ConfigManager().save(config);
  save({ tools: { toolsets: { [name]: { ...current, enabled } } } });
}

/** Is a registry tool allowed to run? Unknown tools → true (never block). */
export function isToolEnabled(toolName: string, cm?: ConfigManagerLike): boolean {
  const toolset = toolsetForTool(toolName);
  if (!toolset) return true;
  return readToolsetsState(cm)[toolset.name]?.enabled !== false;
}

// ─── Effective tool set (schema gating) ─────────────────────────────────────

/** Registry tools filtered to ENABLED toolsets. Tools with no toolset pass. */
export function effectiveTools(cm?: ConfigManagerLike): Tool[] {
  const disabled = new Set(disabledToolsetNames(readToolsetsState(cm)));
  if (disabled.size === 0) return listTools();
  return listTools().filter((t) => !disabled.has(toolsetForTool(t.name)?.name ?? ''));
}

/** The JSON schemas handed to native tool-calling providers — gated version. */
export function effectiveToolJsonSchemas(cm?: ConfigManagerLike): ToolJsonSchema[] {
  return toolJsonSchemas(effectiveTools(cm).map((t) => t.name));
}

// ─── Tiered exposure (AGENTIC_CAPABILITY_ASSESSMENT Addendum v3/v4) ────────
//
// The assessment measured ~110 tool schemas (~12K chars of descriptions
// alone) in EVERY chat turn with all toolsets enabled by default. That is a
// per-turn token tax, a prompt-cache problem, and — worse — choice paralysis
// for weak models. The proven equilibrium is ~15 tools + one discovery tool.
// The fix is NOT fewer capabilities; it is TIERED EXPOSURE:
//
//   Tier 1 (CORE)  — universal primitives, always in the model's schema.
//   Tier 2 (DOMAIN)— every other toolset, hidden until the model loads it
//                    mid-turn via the `tool_search` discovery tool
//                    (action "load"), whose names the loop unions into the
//                    live schema set before the next step.
//
// Zero capability is lost: every tool stays registered, executable (the I1
// gate keeps honoring toolset toggles), and discoverable on demand.

/**
 * The always-exposed primitive set. Each name MUST exist in the registry
 * (guarded at module load by `validateCoreToolCoverage`). This is the whole
 * loop harness: files, terminal, code execution, web, clarification,
 * plan/todo, skills, delegation, and the discovery tool itself.
 *
 * `read_extract` is core (not tier-2) on purpose. A document — a PDF, a DOCX,
 * a spreadsheet — is first-class user input, and `read_file` refuses a binary
 * file by NAMING `read_extract` as the alternative (coding-tools.ts). If that
 * alternative were hidden behind `tool_search`, the refusal would send the model
 * to a tool it cannot call, and the user's own document would be unreadable in
 * the default tiered loop — the exact "barely reachable by default" gap. One
 * extra schema is a rounding error against a dead end.
 */
export const CORE_TOOL_NAMES: readonly string[] = [
  'read_file',
  'list_dir',
  'glob',
  'code_search',
  'edit_file',
  'write_file',
  'run_terminal',
  'code_execution',
  'web_search',
  'read_page',
  'read_extract',
  'ask_user',
  'suggest_followups',
  'plan_todo',
  'finding',
  'skill',
  'delegate',
  'tool_search', // the discovery/load tool MUST be core or tiering is a trap
];

/**
 * Integrity guard: a core name that is not registered (typo / rename) must
 * fail LOUDLY at import time, not silently shrink the loop's toolset.
 * Returns the missing names (empty = healthy).
 */
export function validateCoreToolCoverage(): string[] {
  const registered = new Set(listTools().map((t) => t.name));
  return CORE_TOOL_NAMES.filter((n) => !registered.has(n));
}

/** Is a tool in the always-exposed core set? */
export function isCoreTool(toolName: string): boolean {
  return CORE_TOOL_NAMES.includes(toolName);
}

/**
 * Core-only tool list: registered + core + still respecting ENABLED toolsets
 * (a user who disabled the `media` toolset must never get generate_image
 * back just because tiering changed the schema path — the I1 gate stays
 * the single source of enablement truth).
 */
export function coreTools(cm?: ConfigManagerLike): Tool[] {
  const core = new Set(CORE_TOOL_NAMES);
  return effectiveTools(cm).filter((t) => core.has(t.name));
}

/** Core-only JSON schemas (the tiered hand-off for native tool-calling). */
export function coreToolJsonSchemas(cm?: ConfigManagerLike): ToolJsonSchema[] {
  return toolJsonSchemas(coreTools(cm).map((t) => t.name));
}

/**
 * Tiered exposure mode — read from config (`tools.loopExposure`):
 * - 'tiered'  — core schemas on the wire; the rest via `tool_search` load.
 * - 'all'     — the pre-tiering behavior (every enabled toolset's schemas).
 *
 * DEFAULT 'tiered' (flipped from 'all' after the live evidence below).
 *
 * Measured on the built 2.7.3 artifact: the full set is 110 schemas ≈
 * 68,764 bytes ≈ 17.2K tokens sent on EVERY loop step, while the tiered core
 * is 16 schemas ≈ 15,034 bytes ≈ 3.9K tokens — a 4.6× cut. That payload is a
 * hard FUNCTIONAL ceiling, not merely a cost: Gemini's free tier caps input
 * at 16,000 tokens per model per minute
 * (`generate_content_free_tier_input_token_count`), so a 17.2K-token tool
 * payload can never fit — every turn dies with "You exceeded your current
 * quota", which is exactly the live 429 users hit on the WhatsApp/dashboard
 * chat paths.
 *
 * Tiering stays safe because CORE_TOOL_NAMES keeps the whole tool CONTRACT on
 * the wire (`suggest_followups`, `ask_user`, `plan_todo`) plus `tool_search`,
 * the discovery loader — so a turn that needs a domain tool still reaches it
 * mid-turn instead of being stranded without it.
 *
 * 'all' remains an explicit opt-in for large-context models / debugging.
 */
export function getLoopExposureMode(cm?: ConfigManagerLike): 'tiered' | 'all' {
  try {
    const exposure = (cm?.getAll?.() as { tools?: { loopExposure?: string } } | undefined)?.tools?.loopExposure;
    return exposure === 'all' ? 'all' : 'tiered';
  } catch {
    return 'tiered';
  }
}

/** Status of every toolset (CLI + future dashboard): enabled, label, tools. */
export function getToolsetStatus(cm?: ConfigManagerLike): Array<{
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  tools: string[];
  toolCount: number;
}> {
  const state = readToolsetsState(cm);
  return TOOLSETS.map((t) => ({
    name: t.name,
    label: t.label,
    description: t.description,
    enabled: state[t.name]?.enabled !== false,
    tools: [...t.tools],
    toolCount: t.tools.length,
  }));
}

// ─── Pure filter (testable without config) ──────────────────────────────────

/** Filter a tool list by an explicit set of disabled toolset names. */
export function filterToolsByToolsets(tools: Tool[], disabled: string[]): Tool[] {
  if (disabled.length === 0) return tools;
  const disabledSet = new Set(disabled);
  return tools.filter((t) => !disabledSet.has(toolsetForTool(t.name)?.name ?? ''));
}
