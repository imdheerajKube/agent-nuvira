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
import { MCPManager } from '../mcp/manager.js';
// ─── MCP Tool Manager ───────────────────────────────────────────────────────
class MCPToolManager {
    manager;
    serverStates = new Map();
    toolCallHistory = [];
    constructor(configDir) {
        this.manager = new MCPManager(configDir);
    }
    /**
     * Connect to an MCP server by name.
     */
    async connect(serverName) {
        try {
            this.serverStates.set(serverName, {
                name: serverName,
                status: 'connecting',
                tools: [],
            });
            const client = await this.manager.connect(serverName);
            const tools = client.tools.map((t) => t.name);
            this.serverStates.set(serverName, {
                name: serverName,
                status: 'connected',
                tools,
                lastConnected: Date.now(),
            });
            return { success: true, tools };
        }
        catch (err) {
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
    async disconnect(serverName) {
        try {
            await this.manager.disconnect(serverName);
            this.serverStates.delete(serverName);
            return { success: true };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    }
    /**
     * List all connected servers and their tools.
     */
    listServers() {
        return Array.from(this.serverStates.values());
    }
    /**
     * List all available tools across all connected servers.
     */
    listTools() {
        const tools = [];
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
    async callTool(serverName, toolName, args, timeoutMs = 30_000) {
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
                new Promise((_, reject) => setTimeout(() => reject(new Error(`Tool call timed out after ${timeoutMs}ms`)), timeoutMs)),
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
        }
        catch (err) {
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
    getHistory(limit = 50) {
        return this.toolCallHistory.slice(-limit);
    }
    /**
     * Get health status of all servers.
     */
    async checkHealth() {
        const results = [];
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
    sanitizeError(error) {
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
let _instance = null;
export function getMCPToolManager() {
    if (!_instance)
        _instance = new MCPToolManager();
    return _instance;
}
export { MCPToolManager };
//# sourceMappingURL=mcp-client-tool.js.map