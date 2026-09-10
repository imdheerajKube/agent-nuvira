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
import type { AgentTool } from './tool-calling-agent.js';
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
export declare function getAgentTools(options?: BridgeOptions): AgentTool[];
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
export declare function getToolsForAgent(agentType: string, options?: BridgeOptions): AgentTool[];
/**
 * Check if a tool is available in the agent pipeline.
 *
 * @param toolName - The tool name to check
 * @returns true if the tool can be used by agents
 */
export declare function isAgentTool(toolName: string): boolean;
/**
 * Get a summary of tool availability for debugging.
 */
export declare function getToolBridgeSummary(): {
    totalRegistryTools: number;
    agentPipelineTools: number;
    chatOnlyTools: number;
    excludedTools: number;
};
//# sourceMappingURL=tool-bridge.d.ts.map