/**
 * MCPAgent — Invokes MCP (Model Context Protocol) tools during orchestration.
 *
 * This agent reads a tool-call request from context.metadata.mcpRequest,
 * calls the MCP Manager's connected servers to execute the tool, and
 * stores the result in context.metadata.mcpResult.
 *
 * The PlannerAgent can schedule mcp-agent steps when it knows MCP tools
 * are available. The orchestrator injects available MCP tool descriptions
 * into context.metadata.mcpTools before any agent runs.
 *
 * Usage in task plans:
 * ```json
 * {
 *   "id": "mcp-read-files",
 *   "description": "Use MCP filesystem tool to read project files: callTool('read_file', { path: '/path/to/project/package.json' })",
 *   "agentType": "mcp",
 *   "dependsOn": []
 * }
 * ```
 *
 * The tool name and arguments can be specified in:
 * 1. context.metadata.mcpRequest — { tool: string, args?: Record<string, unknown> }
 * 2. Parsed from the task description (e.g., "callTool('read_file', ...)")
 * 3. Interactive selection if multiple MCP tools are available
 */
import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
export declare class MCPAgent extends Agent {
    readonly name = "MCP";
    readonly description = "Invokes MCP (Model Context Protocol) tools from connected servers";
    execute(context: AgentContext, _callLLM: LLMCallFn): Promise<AgentResult>;
    /**
     * Determine which MCP tool to call and with what arguments.
     *
     * Priority:
     * 1. context.metadata.mcpRequest — explicit programmatic request
     * 2. Parsed from the task description (callTool(...) pattern)
     * 3. null — just list available tools
     */
    private determineToolRequest;
    /**
     * Parse a tool call from the task description.
     * Supports formats:
     * - "callTool('read_file', { path: '/tmp/test.txt' })"
     * - "Use MCP filesystem tool: callTool read_file with path=/tmp/test.txt"
     * - Simply the tool name as the first word of the description
     */
    private parseToolCallFromDescription;
}
/** A discovered MCP tool with its server context */
export interface McpToolEntry {
    server: string;
    tool: {
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
    };
}
/** The result of an MCP tool call */
export interface McpToolResult {
    server: string;
    tool: string;
    args?: Record<string, unknown>;
    result: {
        content: Array<{
            type: string;
            text?: string;
            data?: string;
            mimeType?: string;
        }>;
        isError?: boolean;
    };
}
/**
 * Format a list of MCP tool entries into a human-readable string
 * suitable for injection into LLM prompts.
 *
 * Truncated to MAX_MCP_FORMATTED_CHARS to avoid token bloat.
 */
export declare function formatMcpToolsForPrompt(tools: McpToolEntry[]): string;
//# sourceMappingURL=mcp-agent.d.ts.map