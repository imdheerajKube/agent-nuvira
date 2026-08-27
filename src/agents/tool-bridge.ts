/**
 * ToolBridge — Converts registry Tools to AgentTool format.
 *
 * The registry has 111+ tools (Tool interface: zod schema + run function).
 * The tool-calling agents use AgentTool interface (JSON Schema + execute function).
 * This bridge converts between them, enabling the agent pipeline to use
 * the full tool registry instead of just the 4 built-in tools.
 *
 * Design:
 * - Tools are filtered by relevance to the agent pipeline
 * - Chat-only tools (ask_user, suggest_followups) are excluded
 * - Tools are grouped by category for selective injection
 * - Context differences are handled transparently
 */

import { listTools, type Tool, type ToolContext } from '../tools/registry.js';
import type { AgentTool, ToolResult } from './tool-calling-agent.js';
import type { AgentContext } from './agent.js';
import { toJSONSchema } from 'zod';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Categories of tools relevant to the agent pipeline */
export type AgentToolCategory = 'file-ops' | 'search' | 'terminal' | 'git' | 'web' | 'docker' | 'all';

/** Options for converting tools */
export interface BridgeOptions {
  /** Categories to include (default: all agent-relevant categories) */
  categories?: AgentToolCategory[];
  /** Specific tool names to include (overrides categories) */
  includeTools?: string[];
  /** Specific tool names to exclude */
  excludeTools?: string[];
  /** Maximum number of tools to convert (default: 50) */
  maxTools?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Tools that are useful for the agent pipeline (writer/reviewer).
 * These tools help agents read code, make edits, run commands, search, etc.
 *
 * We now include ALL 111 registry tools (except pure UX tools).
 * Dangerous tools have safety gates in convertTool().
 */
const AGENT_PIPELINE_TOOLS = new Set([
  // ─── File Operations ───
  'read_file', 'list_dir', 'glob', 'edit_file', 'write_file',
  'run_terminal', 'plan_todo', 'terminal', 'read_extract',
  // ─── Code & Search ───
  'code_search', 'delegate', 'clone_repo', 'git',
  // ─── Web Research ───
  'web_search', 'read_page',
  // ─── Docker ───
  'docker',
  // ─── Security ───
  'sanitize', 'binary_extensions',
  // ─── System ───
  'run_cli',
  // ─── Previously "dead" tools (now wired) ───
  'browser', 'browser_supervisor', 'browser_dialog',
  'code_execution',
  'computer_use',
  'generate_image', 'video_generate',
  'discord', 'homeassistant', 'microsoft_graph',
  'feishu_doc', 'feishu_drive',
  'kanban', 'cronjob', 'todo', 'session', 'memory',
  'voice_mode', 'wake_word', 'transcribe',
  'tts_streaming', 'tts_text_normalize',
  'speak', 'describe_image', 'vision',
  'mcp_tool', 'mcp_watchdog', 'mcp_oauth', 'mcp_schema_cache',
  'interrupt', 'daemon_pool', 'process_registry', 'checkpoint',
  'delegate_system', 'subagent', 'managed_gateway',
  'messaging', 'async_delegation', 'delegation_live_log',
  'ast_audit', 'threat_patterns', 'url_safety',
  'path_security', 'security_score',
  'tool_search', 'budget_config', 'fuzzy_match',
  'lazy_deps', 'tool_backend', 'tool_output_limits', 'tool_result_storage',
  'ansi_strip', 'osv_check', 'patch_parser', 'image_source',
  'skills_hub', 'skills_sync', 'skills_sync_client',
  'skill_usage', 'skill_provenance',
  'blueprint', 'working_diff', 'file_ops', 'debug',
  'env_probe', 'write_approval', 'approval',
  'openrouter_client',
  'camofox',
]);

/**
 * Tools that are chat-only and should NOT be injected into agent pipeline.
 * These tools are designed for interactive user interaction, not autonomous execution.
 * Only truly UX-only tools go here — everything else is agent-available.
 */
const CHAT_ONLY_TOOLS = new Set([
  'ask_user', 'suggest_followups', 'verify_requirement',
  // 'skill' is kept — agents can load skills via the bridge
]);

// ─── Conversion ─────────────────────────────────────────────────────────────

/**
 * Tools that require safety gates before execution.
 * These tools can have side effects outside the project directory.
 */
const SAFETY_GATED_TOOLS = new Set([
  'browser', 'browser_supervisor', 'browser_dialog',
  'code_execution',
  'computer_use',
  'generate_image', 'video_generate',
  'discord', 'homeassistant', 'microsoft_graph',
  'feishu_doc', 'feishu_drive',
  'voice_mode', 'wake_word', 'transcribe',
  'tts_streaming', 'tts_text_normalize',
  'speak', 'describe_image', 'vision',
  'mcp_tool', 'mcp_watchdog', 'mcp_oauth',
  'interrupt', 'daemon_pool', 'process_registry',
  'delegate_system', 'subagent', 'managed_gateway',
  'messaging', 'async_delegation', 'delegation_live_log',
  'openrouter_client', 'camofox',
]);

/**
 * Convert a registry Tool to an AgentTool.
 *
 * Key conversions:
 * - ZodType inputSchema → JSON Schema (for LLM prompt)
 * - run(args, ToolContext) → execute(args, AgentContext) → ToolResult
 * - ToolContext is constructed from AgentContext
 * - Safety gates for dangerous tools (browser, code_execution, etc.)
 */
function convertTool(tool: Tool): AgentTool {
  // Convert Zod schema to JSON Schema for the LLM
  let parameters: Record<string, any>;
  try {
    parameters = toJSONSchema(tool.inputSchema) as Record<string, any>;
  } catch {
    // Fallback: use a simple object schema
    parameters = { type: 'object', properties: {} };
  }

  const isSafetyGated = SAFETY_GATED_TOOLS.has(tool.name);

  return {
    name: tool.name,
    description: tool.description,
    parameters,
    async execute(args: Record<string, any>, context: AgentContext): Promise<ToolResult> {
      // Safety gate: warn but still allow execution
      if (isSafetyGated) {
        // Log the safety gate trigger for auditing
        console.warn(`[ToolBridge] Safety gate triggered for tool '${tool.name}' — executing with caution`);
      }

      try {
        // Build ToolContext from AgentContext
        const toolContext: ToolContext = {
          configManager: context.metadata?.configManager,
          cwd: context.workingDirectory,
        };

        // Call the original tool's run function
        const output = await tool.run(args, toolContext);

        return {
          success: true,
          output: typeof output === 'string' ? output : JSON.stringify(output),
        };
      } catch (err) {
        return {
          success: false,
          output: '',
          error: `Tool '${tool.name}' failed: ${err}`,
        };
      }
    },
  };
}

/**
 * Create a skill_view tool for on-demand skill loading.
 *
 * Hermes pattern: agents call skill_view(name) to load full methodology.
 * This enables progressive disclosure — planner sees summaries, writer
 * loads full methodology when needed.
 */
function createSkillViewTool(): AgentTool {
  return {
    name: 'skill_view',
    description: 'Load full methodology for a skill. Use this when you need detailed step-by-step guidance for a specific domain (e.g., game-development, api-design, docker-management). Returns the complete skill with steps, parameters, and reference information.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name to view (e.g., "game-development", "api-design", "docker-management")',
        },
        file_path: {
          type: 'string',
          description: 'Optional: specific file within the skill (e.g., "references/platform-specific.md")',
        },
      },
      required: ['name'],
    },
    async execute(args: Record<string, any>, context: AgentContext): Promise<ToolResult> {
      try {
        // Import skill store dynamically to avoid circular deps
        const { getSkillStore } = await import('../learning/skill-store.js');
        const store = getSkillStore();
        const output = store.skillView(args.name, args.file_path);
        return { success: true, output };
      } catch (err) {
        return {
          success: false,
          output: '',
          error: `skill_view failed: ${err}`,
        };
      }
    },
  };
}

/**
 * Create a skills_list tool for lightweight skill discovery.
 *
 * Hermes pattern: skills_list() returns name+description only.
 * Use skill_view() for full methodology.
 */
function createSkillsListTool(): AgentTool {
  return {
    name: 'skills_list',
    description: 'List available skills with their descriptions. Returns only names and descriptions (lightweight). Use skill_view() to load full methodology for a specific skill.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional search query to filter skills by name, description, or tags',
        },
      },
      required: [],
    },
    async execute(args: Record<string, any>, context: AgentContext): Promise<ToolResult> {
      try {
        const { getSkillStore } = await import('../learning/skill-store.js');
        const store = getSkillStore();

        let skills;
        if (args.query) {
          skills = store.search(args.query);
        } else {
          skills = store.getAll();
        }

        // Return lightweight summaries (Hermes pattern)
        const summaries = skills.map((s) => ({
          name: s.name,
          description: s.description,
          tags: s.tags,
          quality: `${(s.qualityScore * 100).toFixed(0)}%`,
        }));

        return {
          success: true,
          output: JSON.stringify(summaries, null, 2),
        };
      } catch (err) {
        return {
          success: false,
          output: '',
          error: `skills_list failed: ${err}`,
        };
      }
    },
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Get all agent-relevant tools converted to AgentTool format.
 *
 * This is the main entry point for the bridge. It:
 * 1. Loads all tools from the registry
 * 2. Filters out chat-only tools
 * 3. Converts remaining tools to AgentTool format
 * 4. Returns them ready for injection into tool-calling agents
 *
 * @param options - Filtering and conversion options
 * @returns Array of AgentTool instances
 */
export function getAgentTools(options: BridgeOptions = {}): AgentTool[] {
  const {
    categories,
    includeTools,
    excludeTools = [],
    maxTools = 100,
  } = options;

  // Get all tools from registry
  const allTools = listTools();

  // Filter by relevance
  const filtered = allTools.filter((tool) => {
    // Always exclude chat-only tools
    if (CHAT_ONLY_TOOLS.has(tool.name)) return false;

    // Exclude explicitly excluded tools
    if (excludeTools.includes(tool.name)) return false;

    // If specific tools are requested, only include those
    if (includeTools) {
      return includeTools.includes(tool.name);
    }

    // If categories are specified, filter by category
    if (categories) {
      // For now, all agent-pipeline tools are in one group
      // Future: categorize by actual category
      return AGENT_PIPELINE_TOOLS.has(tool.name);
    }

    // Default: include all agent-pipeline tools
    return AGENT_PIPELINE_TOOLS.has(tool.name);
  });

  // Convert to AgentTool format
  const converted = filtered.map(convertTool);

  // Add skill tools (always available for progressive disclosure)
  const skillTools: AgentTool[] = [createSkillViewTool(), createSkillsListTool()];

  // Combine: registry tools + skill tools
  const combinedTools = [...converted, ...skillTools];

  // Apply limit
  return combinedTools.slice(0, maxTools);
}

/**
 * Get tools for a specific agent type.
 *
 * Different agents need different tools:
 * - Writer: ALL tools (file ops, code search, terminal, web, docker, etc.)
 * - Reviewer: file ops, code search, git, security scanning
 * - Context-gatherer: file ops, search, glob, web search
 * - Runner: terminal, docker, code execution
 * - Debugger: file ops, search, terminal, browser
 *
 * NOTE: We now inject ALL agent-relevant tools, not just a subset.
 * The LLM decides which tools to use based on the task.
 *
 * @param agentType - The agent type ('writer', 'reviewer', 'context-gatherer')
 * @param options - Additional filtering options
 * @returns Array of AgentTool instances
 */
export function getToolsForAgent(
  agentType: string,
  options: BridgeOptions = {},
): AgentTool[] {
  // Agent-specific tool selections
  const agentToolSelections: Record<string, string[]> = {
    // Writer gets the most tools — it needs everything to implement changes
    'writer': [
      // File ops
      'read_file', 'list_dir', 'glob', 'edit_file', 'write_file',
      'run_terminal', 'plan_todo', 'read_extract',
      // Code & search
      'code_search', 'delegate', 'clone_repo', 'git',
      // Web
      'web_search', 'read_page',
      // Docker
      'docker',
      // Security
      'sanitize', 'binary_extensions',
      // System
      'run_cli',
      // Skills
      'skill', 'skills_hub',
      // MCP
      'mcp_tool',
      // Debugging
      'browser', 'browser_supervisor',
      'code_execution',
      'computer_use',
      'ast_audit',
      'debug',
      // Image generation
      'generate_image',
    ],
    'writer-tc': [
      // Same as writer
      'read_file', 'list_dir', 'glob', 'edit_file', 'write_file',
      'run_terminal', 'plan_todo', 'read_extract',
      'code_search', 'delegate', 'clone_repo', 'git',
      'web_search', 'read_page',
      'docker', 'sanitize', 'binary_extensions', 'run_cli',
      'skill', 'skills_hub', 'mcp_tool',
      'browser', 'browser_supervisor', 'code_execution', 'debug',
    ],
    // Reviewer gets file ops + code search + security tools
    'reviewer': [
      'read_file', 'list_dir', 'glob', 'read_extract',
      'code_search', 'git', 'sanitize', 'binary_extensions',
      'ast_audit', 'threat_patterns', 'url_safety', 'path_security',
      'security_score', 'osv_check', 'debug',
    ],
    'reviewer-tc': [
      'read_file', 'list_dir', 'glob', 'read_extract',
      'code_search', 'git', 'sanitize', 'binary_extensions',
      'ast_audit', 'threat_patterns', 'debug',
    ],
    // Context-gatherer gets read-only tools
    'context-gatherer': [
      'read_file', 'list_dir', 'glob', 'read_extract',
      'code_search', 'web_search', 'read_page',
    ],
    // Runner gets terminal + build tools
    'runner': [
      'run_terminal', 'run_cli', 'docker',
      'code_execution', 'git',
    ],
    // Debugger gets read + search + browser
    'debugger': [
      'read_file', 'list_dir', 'glob', 'read_extract',
      'code_search', 'run_terminal', 'git',
      'browser', 'browser_supervisor', 'debug',
    ],
    // Tester gets terminal + file ops
    'tester': [
      'read_file', 'list_dir', 'glob', 'run_terminal', 'run_cli',
    ],
  };

  const selectedTools = agentToolSelections[agentType];

  if (selectedTools) {
    // Use specific tool selection for this agent type
    return getAgentTools({
      ...options,
      includeTools: selectedTools,
    });
  }

  // Default: all agent-pipeline tools
  return getAgentTools(options);
}

/**
 * Check if a tool is available in the agent pipeline.
 *
 * @param toolName - The tool name to check
 * @returns true if the tool can be used by agents
 */
export function isAgentTool(toolName: string): boolean {
  if (CHAT_ONLY_TOOLS.has(toolName)) return false;
  return AGENT_PIPELINE_TOOLS.has(toolName);
}

/**
 * Get a summary of tool availability for debugging.
 */
export function getToolBridgeSummary(): {
  totalRegistryTools: number;
  agentPipelineTools: number;
  chatOnlyTools: number;
  excludedTools: number;
} {
  const allTools = listTools();
  const agentTools = allTools.filter((t) => AGENT_PIPELINE_TOOLS.has(t.name));
  const chatTools = allTools.filter((t) => CHAT_ONLY_TOOLS.has(t.name));
  const excluded = allTools.filter(
    (t) => !AGENT_PIPELINE_TOOLS.has(t.name) && !CHAT_ONLY_TOOLS.has(t.name),
  );

  return {
    totalRegistryTools: allTools.length,
    agentPipelineTools: agentTools.length,
    chatOnlyTools: chatTools.length,
    excludedTools: excluded.length,
  };
}
