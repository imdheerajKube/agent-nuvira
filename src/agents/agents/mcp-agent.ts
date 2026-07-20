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
import { getMCPManager } from '../../mcp/manager.js';
import { logger } from '../../utils/logger.js';

// ─── MCP Agent ──────────────────────────────────────────────────────────────

export class MCPAgent extends Agent {
  readonly name = 'MCP';
  readonly description = 'Invokes MCP (Model Context Protocol) tools from connected servers';

  async execute(context: AgentContext, _callLLM: LLMCallFn): Promise<AgentResult> {
    try {
      // 1. Determine which MCP tool to call
      const request = this.determineToolRequest(context);

      if (!request) {
        // No explicit request — list available tools for the user
        const tools = context.metadata.mcpTools as McpToolEntry[] | undefined;

        if (!tools || tools.length === 0) {
          return {
            success: false,
            summary: 'No MCP tools available',
            error: 'No MCP servers are connected and no mcpRequest was provided in context metadata.',
          };
        }

        return {
          success: true,
          summary: `Available MCP tools: ${tools.length} tool(s) across MCP servers`,
          details: tools
            .map((t) => `  [${t.server}] ${t.tool.name}: ${t.tool.description || 'No description'}`)
            .join('\n'),
        };
      }

      // 2. Call the tool via MCP Manager
      const manager = getMCPManager();
      const result = await manager.callTool(request.tool, request.args);

      if (!result) {
        // Tool not found on any connected server
        const allTools = manager.getAllTools();
        const availableNames = allTools.map((t) => t.tool.name).join(', ');

        return {
          success: false,
          summary: `MCP tool '${request.tool}' not found`,
          error: `Tool '${request.tool}' is not available on any connected MCP server. Available tools: ${availableNames || '(none connected)'}`,
        };
      }

      // 3. Store result in context metadata
      const mcpResult: McpToolResult = {
        server: result.server,
        tool: request.tool,
        args: request.args,
        result: result.result,
      };
      context.metadata['mcpResult'] = mcpResult;

      // 4. Build summary from the result content
      const contentTexts: string[] = [];
      for (const content of result.result.content) {
        if (content.type === 'text') {
          contentTexts.push(content.text);
        }
      }

      const summaryText = contentTexts.join('\n').slice(0, 500);
      const isError = result.result.isError === true;

      logger.debug(`MCP[${result.server}] ${request.tool} → ${isError ? 'error' : 'success'} (${contentTexts.length} content blocks)`);

      return {
        success: !isError,
        summary: isError
          ? `MCP tool '${request.tool}' returned an error`
          : `MCP tool '${request.tool}' executed successfully on ${result.server}`,
        details: summaryText || '(no text content returned)',
        error: isError ? `Tool '${request.tool}' reported an error on ${result.server}` : undefined,
      };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`MCPAgent error: ${msg}`);
      return {
        success: false,
        summary: 'MCP tool call failed',
        error: msg,
      };
    }
  }

  /**
   * Determine which MCP tool to call and with what arguments.
   *
   * Priority:
   * 1. context.metadata.mcpRequest — explicit programmatic request
   * 2. Parsed from the task description (callTool(...) pattern)
   * 3. null — just list available tools
   */
  private determineToolRequest(context: AgentContext): { tool: string; args?: Record<string, unknown> } | null {
    // Priority 1: Explicit programmatic request
    const explicitRequest = context.metadata.mcpRequest as
      | { tool: string; args?: Record<string, unknown> }
      | undefined;

    if (explicitRequest?.tool) {
      return { tool: explicitRequest.tool, args: explicitRequest.args };
    }

    // Priority 2: Parse from task description
    const mcpTask = context.taskPlan.find(
      (s) => s.agentType === 'mcp' && s.status === 'running',
    );

    if (mcpTask?.description) {
      const parsed = this.parseToolCallFromDescription(mcpTask.description);
      if (parsed) return parsed;
    }

    // No explicit request found — agent will list available tools
    return null;
  }

  /**
   * Parse a tool call from the task description.
   * Supports formats:
   * - "callTool('read_file', { path: '/tmp/test.txt' })"
   * - "Use MCP filesystem tool: callTool read_file with path=/tmp/test.txt"
   * - Simply the tool name as the first word of the description
   */
  private parseToolCallFromDescription(description: string): { tool: string; args?: Record<string, unknown> } | null {
    // Pattern 1: callTool('name', { ... })
    const callToolMatch = description.match(
      /callTool\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*(\{[\s\S]*?\}))?\s*\)/,
    );
    if (callToolMatch) {
      const tool = callToolMatch[1].trim();
      let args: Record<string, unknown> | undefined;

      if (callToolMatch[2]) {
        try {
          // Handle single-quote JSON (replace single quotes with double quotes)
          const jsonStr = callToolMatch[2]
            .replace(/'/g, '"')
            .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3'); // Quote unquoted keys
          args = JSON.parse(jsonStr) as Record<string, unknown>;
        } catch {
          // If parsing fails, try eval-free object interpretation
          // Just pass the raw string — the MCP tool will handle it
          args = { raw: callToolMatch[2] };
        }
      }

      return { tool, args };
    }

    // Pattern 2: "tool: toolName" or "call: toolName"
    const toolMatch = description.match(/(?:tool|call(?:ed)?)\s*:\s*([\w-]+)/i);
    if (toolMatch) {
      return { tool: toolMatch[1].trim() };
    }

    // No recognizable pattern — return null so the agent lists available tools
    return null;
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

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
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
  };
}

/** Maximum characters for the formatted MCP tools prompt section */
const MAX_MCP_FORMATTED_CHARS = 4000;

/**
 * Format a list of MCP tool entries into a human-readable string
 * suitable for injection into LLM prompts.
 *
 * Truncated to MAX_MCP_FORMATTED_CHARS to avoid token bloat.
 */
export function formatMcpToolsForPrompt(tools: McpToolEntry[]): string {
  if (!tools || tools.length === 0) return '';

  const MAX_TOOLS_PER_SERVER = 15;

  const parts: string[] = [
    '## Available MCP Tools (External Services)',
    '',
    'The following external tools are available through connected MCP servers.',
    'You can write code that references these tools, or the PlannerAgent will',
    'schedule an `mcp` step to invoke them directly.',
    '',
  ];

  // Group by server
  const byServer = new Map<string, McpToolEntry[]>();
  for (const entry of tools) {
    const list = byServer.get(entry.server) || [];
    if (list.length >= MAX_TOOLS_PER_SERVER) continue; // Cap per server
    list.push(entry);
    byServer.set(entry.server, list);
  }

  for (const [server, serverTools] of byServer) {
    parts.push(`### Server: ${server}`);
    parts.push('');

    for (const entry of serverTools) {
      const tool = entry.tool;
      parts.push(`- **${tool.name}**: ${tool.description || 'No description'}`);

      if (tool.inputSchema) {
        const schema = tool.inputSchema as Record<string, unknown>;
        if (schema.properties) {
          const props = schema.properties as Record<string, { type?: string; description?: string }>;
          const required = (schema.required as string[]) || [];
          const propLines = Object.entries(props).map(([name, prop]) => {
            const req = required.includes(name) ? ' (required)' : '';
            return `    - \`${name}\`: ${prop.type || 'any'}${req} — ${prop.description || ''}`;
          });
          // Limit schema properties shown to top 5
          const shown = propLines.slice(0, 5);
          if (shown.length > 0) {
            parts.push('  Parameters:');
            parts.push(...shown);
            if (propLines.length > 5) {
              parts.push(`    ... and ${propLines.length - 5} more parameters`);
            }
          }
        }
      }
      parts.push('');
    }
  }

  // Count total tools for the summary note
  const totalTools = tools.length;
  if (totalTools > MAX_TOOLS_PER_SERVER * byServer.size) {
    parts.push(`*(${totalTools} total tools across ${byServer.size} server(s) — showing up to ${MAX_TOOLS_PER_SERVER} per server)*`);
    parts.push('');
  }

  parts.push(
    'Tool call results are available to subsequent steps via the context.',
    'The PlannerAgent can schedule `mcp` steps to invoke tools directly.',
  );

  let result = parts.join('\n');

  // Truncate if too long
  if (result.length > MAX_MCP_FORMATTED_CHARS) {
    result = result.slice(0, MAX_MCP_FORMATTED_CHARS) +
      `\n\n*(MCP tool descriptions truncated — ${totalTools} tools total)*`;
  }

  return result;
}
