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
 */
const AGENT_PIPELINE_TOOLS = new Set([
  // File operations (coding toolset)
  'read_file', 'list_dir', 'glob', 'edit_file', 'write_file', 'run_terminal', 'plan_todo', 'terminal',
  // Code tools (code toolset)
  'code_search', 'delegate', 'clone_repo', 'git', 'read_extract',
  // Web research
  'web_search', 'read_page',
  // Docker
  'docker',
  // Security scanning
  'sanitize', 'binary_extensions',
  // System
  'run_cli',
]);

/**
 * Tools that are chat-only and should NOT be injected into agent pipeline.
 * These tools are designed for interactive user interaction, not autonomous execution.
 */
const CHAT_ONLY_TOOLS = new Set([
  'ask_user', 'suggest_followups', 'verify_requirement', 'skill',
  'gateway_send', 'send_message',
  'discord', 'homeassistant', 'microsoft_graph', 'feishu_doc', 'feishu_drive',
  'kanban', 'cronjob', 'todo', 'session', 'memory',
  'voice_mode', 'wake_word', 'transcribe', 'tts_streaming', 'tts_text_normalize',
  'generate_image', 'speak', 'describe_image', 'vision', 'video_generate',
  'computer_use', 'code_execution',
  'mcp_tool', 'mcp_watchdog', 'mcp_oauth', 'mcp_schema_cache',
  'interrupt', 'daemon_pool', 'process_registry', 'checkpoint',
  'delegate_system', 'subagent', 'managed_gateway', 'messaging', 'async_delegation', 'delegation_live_log',
  'ast_audit', 'threat_patterns', 'url_safety', 'path_security', 'security_score',
  'tool_search', 'budget_config', 'fuzzy_match', 'lazy_deps', 'tool_backend', 'tool_output_limits', 'tool_result_storage',
  'ansi_strip', 'osv_check', 'patch_parser', 'image_source',
  'skills_hub', 'skills_sync', 'skills_sync_client', 'skill_usage', 'skill_provenance',
  'blueprint', 'working_diff', 'file_ops', 'debug',
  'env_probe', 'write_approval', 'approval',
  'openrouter_client',
  'camofox', 'browser', 'browser_supervisor', 'browser_dialog',
]);

// ─── Conversion ─────────────────────────────────────────────────────────────

/**
 * Convert a registry Tool to an AgentTool.
 *
 * Key conversions:
 * - ZodType inputSchema → JSON Schema (for LLM prompt)
 * - run(args, ToolContext) → execute(args, AgentContext) → ToolResult
 * - ToolContext is constructed from AgentContext
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

  return {
    name: tool.name,
    description: tool.description,
    parameters,
    async execute(args: Record<string, any>, context: AgentContext): Promise<ToolResult> {
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
    maxTools = 50,
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

  // Apply limit
  return converted.slice(0, maxTools);
}

/**
 * Get tools for a specific agent type.
 *
 * Different agents need different tools:
 * - Writer: file ops, code search, terminal
 * - Reviewer: file ops, code search, git
 * - Context-gatherer: file ops, search, glob
 *
 * @param agentType - The agent type ('writer', 'reviewer', 'context-gatherer')
 * @param options - Additional filtering options
 * @returns Array of AgentTool instances
 */
export function getToolsForAgent(
  agentType: string,
  options: BridgeOptions = {},
): AgentTool[] {
  // Default categories for each agent type
  const agentCategories: Record<string, AgentToolCategory[]> = {
    'writer': ['file-ops', 'search', 'terminal', 'git', 'docker'],
    'writer-tc': ['file-ops', 'search', 'terminal', 'git', 'docker'],
    'reviewer': ['file-ops', 'search', 'git'],
    'reviewer-tc': ['file-ops', 'search', 'git'],
    'context-gatherer': ['file-ops', 'search'],
    'runner': ['terminal', 'docker'],
    'debugger': ['file-ops', 'search', 'terminal'],
    'tester': ['file-ops', 'terminal'],
  };

  const categories = agentCategories[agentType] || ['all'];

  return getAgentTools({
    ...options,
    categories,
  });
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
