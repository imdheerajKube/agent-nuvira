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
declare class MCPToolManager {
    private manager;
    private serverStates;
    private toolCallHistory;
    constructor(configDir?: string);
    /**
     * Connect to an MCP server by name.
     */
    connect(serverName: string): Promise<{
        success: boolean;
        tools: string[];
        error?: string;
    }>;
    /**
     * Disconnect from an MCP server.
     */
    disconnect(serverName: string): Promise<{
        success: boolean;
        error?: string;
    }>;
    /**
     * List all connected servers and their tools.
     */
    listServers(): MCPServerState[];
    /**
     * List all available tools across all connected servers.
     */
    listTools(): {
        server: string;
        name: string;
        description: string;
        inputSchema: any;
    }[];
    /**
     * Call a tool on a connected MCP server.
     */
    callTool(serverName: string, toolName: string, args: Record<string, any>, timeoutMs?: number): Promise<MCPToolCallResult>;
    /**
     * Get tool call history.
     */
    getHistory(limit?: number): typeof this.toolCallHistory;
    /**
     * Get health status of all servers.
     */
    checkHealth(): Promise<{
        server: string;
        status: string;
        tools: number;
    }[]>;
    /**
     * Sanitize error messages to remove credentials.
     */
    private sanitizeError;
}
export declare function getMCPToolManager(): MCPToolManager;
export { MCPToolManager };
//# sourceMappingURL=mcp-client-tool.d.ts.map