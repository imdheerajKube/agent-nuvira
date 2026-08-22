/**
 * H1b — Toolsets (`src/tools/toolsets.ts`).
 *
 * Capability-gating parity (`toolsets` + `toolset_validation.py`
 * + `web_routers/tools.py:get_toolsets`): the registry's tools are grouped
 * into named toolsets — the "capabilities" a user toggles. Each toolset can
 * be enabled/disabled via config (`tools.toolsets.<name>.enabled` in
 * `~/.buff/buffconfig.json`; absent = enabled).
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
  /** One-line description shown in `buff tools toolsets`. */
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
    description: 'Release publishing to npm/GitHub. IRREVERSIBLE — confirmation flows stay active.',
    tools: ['publish'],
  },
  {
    name: 'experience',
    label: 'Experience',
    description: 'In-loop UX tools: clarification (ask_user), requirement verification, end-of-response follow-ups, and loading reusable capability packs (skill).',
    tools: ['ask_user', 'suggest_followups', 'verify_requirement', 'skill'],
  },
  {
    name: 'code',
    label: 'Code',
    description: 'Project code search (ripgrep), sub-agent delegation, assessing OTHER repositories (clone_repo — shallow clone into an ephemeral cache), and structured git (diff card + gated commit).',
    tools: ['code_search', 'delegate', 'clone_repo', 'git'],
  },
  {
    name: 'coding',
    label: 'Coding',
    description: 'Interactive file access + verification for the agent loop: read files, list directories, glob, edit/write files, run terminal commands (tests/typecheck/build) — deny-first, workspace-scoped; state-changing actions are confirmation-gated — and the plan/todo checklist that tracks multi-step work.',
    tools: ['read_file', 'list_dir', 'glob', 'edit_file', 'write_file', 'run_terminal', 'plan_todo'],
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
    tools: ['gateway_send'],
  },
  {
    name: 'system',
    label: 'System & tooling',
    description: 'Plain-English system/tooling control: start/stop the dashboard or gateway, verified senders, platform setup, evals, stats (via the buff CLI — run_cli).',
    tools: ['run_cli'],
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
    description: 'Image generation, speech synthesis, transcription, vision, video generation, voice mode.',
    tools: ['generate_image', 'speak', 'transcribe', 'describe_image', 'vision', 'video_generate', 'voice_mode', 'wake_word', 'neutts_synth'],
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
    description: 'Kanban boards, cronjobs, todos, and session management.',
    tools: ['kanban', 'cronjob', 'todo', 'session'],
  },
  {
    name: 'security',
    label: 'Security',
    description: 'Schema sanitization, binary detection, approvals, env probing.',
    tools: ['sanitize', 'binary_extensions', 'approval', 'env_probe'],
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
    description: 'Subagent spawning, delegation system, managed gateway.',
    tools: ['delegate_system', 'subagent', 'managed_gateway', 'messaging'],
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
    description: 'Tools exposed by configured MCP servers. Disabling removes MCP tools from the model schema.',
    tools: [],
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
    description: 'Tool search, budget config, fuzzy matching.',
    tools: ['tool_search', 'budget_config', 'fuzzy_match'],
  },
  {
    name: 'utility',
    label: 'Utility',
    description: 'Small utilities: ANSI strip, OSV check, patch parser, image source.',
    tools: ['ansi_strip', 'osv_check', 'patch_parser', 'image_source'],
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
 * Throws for an unknown toolset name (typo-safe for `buff tools toolsets`).
 */
export function setToolsetEnabled(name: string, enabled: boolean, cm?: ConfigManagerLike): void {
  if (!TOOLSETS.some((t) => t.name === name)) {
    throw new Error(`Unknown toolset '${name}' — run \`buff tools toolsets\` to see the catalog.`);
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
