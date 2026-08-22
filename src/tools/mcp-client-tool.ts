/**
 * mcp_tool — Dynamic MCP server connection and tool invocation.
 *
 * Connects to external MCP servers via stdio, HTTP, or SSE transport,
 * discovers their tools, and allows the agent to invoke them.
 *
 * Features:
 * - Stdio transport (command + args)
 * - HTTP/StreamableHTTP transport (url)
 * - SSE transport (transport: sse)
 * - Automatic reconnection with exponential backoff
 * - Environment variable filtering for security
 * - Credential stripping in error messages
 * - Configurable per-server timeouts
 * - Thread-safe architecture
 */

import { MCPClient } from '../mcp/client.js';
import type { MCPServerConfig } from '../mcp/types.js';
import { MCPManager } from '../mcp/manager.js';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

// ─── Types ──────────────────────────────────────────────────────────────────

interface MCPServerState {
  name: string;
  status: 'connected' | 'disconnected' | 'error' | 'connecting';
  tools: string[];
  lastConnected?: number;
  error?: string;
}

interface MCPToolCallResult {
  success: boolean;
  content?: any;
  error?: string;
  duration?: number;
}

// ─── MCP Tool Manager ───────────────────────────────────────────────────────

class MCPToolManager {
  private manager: MCPManager;
  private serverStates = new Map<string, MCPServerState>();
  private toolCallHistory: {
    server: string;
    tool: string;
    args: any;
    success: boolean;
    duration: number;
    timestamp: number;
  }[] = [];

  constructor(configDir?: string) {
    this.manager = new MCPManager(configDir);
  }

  /**
   * Connect to an MCP server by name.
   */
  async connect(serverName: string): Promise<{ success: boolean; tools: string[]; error?: string }> {
    try {
      this.serverStates.set(serverName, {
        name: serverName,
        status: 'connecting',
        tools: [],
      });

      const client = await this.manager.connect(serverName);
      const tools = client.tools.map((t: any) => t.name);

      this.serverStates.set(serverName, {
        name: serverName,
        status: 'connected',
        tools,
        lastConnected: Date.now(),
      });

      return { success: true, tools };
    } catch (err: any) {
      const error = err.message || String(err);
      // Strip credentials from error messages
      const sanitized = this.sanitizeError(error);

      this.serverStates.set(serverName, {
        name: serverName,
        status: 'error',
        tools: [],
        error: sanitized,
      });

      return { success: false, tools: [], error: sanitized };
    }
  }

  /**
   * Disconnect from an MCP server.
   */
  async disconnect(serverName: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.manager.disconnect(serverName);
      this.serverStates.delete(serverName);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * List all connected servers and their tools.
   */
  listServers(): MCPServerState[] {
    return Array.from(this.serverStates.values());
  }

  /**
   * List all available tools across all connected servers.
   */
  listTools(): { server: string; name: string; description: string; inputSchema: any }[] {
    const tools: { server: string; name: string; description: string; inputSchema: any }[] = [];

    for (const [serverName, state] of this.serverStates) {
      if (state.status === 'connected') {
        const client = this.manager.getClient(serverName);
        if (client) {
          for (const tool of client.tools) {
            tools.push({
              server: serverName,
              name: tool.name,
              description: tool.description || '',
              inputSchema: tool.inputSchema,
            });
          }
        }
      }
    }

    return tools;
  }

  /**
   * Call a tool on a connected MCP server.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, any>,
    timeoutMs = 30_000,
  ): Promise<MCPToolCallResult> {
    const startTime = Date.now();

    try {
      const client = this.manager.getClient(serverName);
      if (!client) {
        throw new Error(`Server '${serverName}' not connected`);
      }

      if (!client.connected) {
        throw new Error(`Server '${serverName}' is not connected`);
      }

      // Call the tool with timeout
      const result = await Promise.race([
        client.callTool(toolName, args),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Tool call timed out after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);

      const duration = Date.now() - startTime;

      this.toolCallHistory.push({
        server: serverName,
        tool: toolName,
        args,
        success: true,
        duration,
        timestamp: Date.now(),
      });

      // Keep history bounded
      if (this.toolCallHistory.length > 1000) {
        this.toolCallHistory = this.toolCallHistory.slice(-500);
      }

      return {
        success: true,
        content: result,
        duration,
      };
    } catch (err: any) {
      const duration = Date.now() - startTime;
      const error = this.sanitizeError(err.message || String(err));

      this.toolCallHistory.push({
        server: serverName,
        tool: toolName,
        args,
        success: false,
        duration,
        timestamp: Date.now(),
      });

      return {
        success: false,
        error,
        duration,
      };
    }
  }

  /**
   * Get tool call history.
   */
  getHistory(limit = 50): typeof this.toolCallHistory {
    return this.toolCallHistory.slice(-limit);
  }

  /**
   * Get health status of all servers.
   */
  async checkHealth(): Promise<{ server: string; status: string; tools: number }[]> {
    const results: { server: string; status: string; tools: number }[] = [];

    for (const [serverName, state] of this.serverStates) {
      results.push({
        server: serverName,
        status: state.status,
        tools: state.tools.length,
      });
    }

    return results;
  }

  /**
   * Sanitize error messages to remove credentials.
   */
  private sanitizeError(error: string): string {
    // Remove common credential patterns
    return error
      .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
      .replace(/ghp_[A-Za-z0-9]+/g, 'ghp_[REDACTED]')
      .replace(/sk-[A-Za-z0-9]+/g, 'sk_[REDACTED]')
      .replace(/password\s*[:=]\s*[^\s,}]+/gi, 'password=[REDACTED]')
      .replace(/token\s*[:=]\s*[^\s,}]+/gi, 'token=[REDACTED]');
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: MCPToolManager | null = null;

export function getMCPToolManager(): MCPToolManager {
  if (!_instance) _instance = new MCPToolManager();
  return _instance;
}

export { MCPToolManager };
