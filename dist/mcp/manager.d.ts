/**
 * MCP Manager — Manages multiple MCP server connections.
 *
 * Discovers MCP server configurations from ~/.buff/mcp/ directory and
 * provides a unified interface for tool discovery and invocation across
 * all connected servers.
 */
import { MCPClient } from './client.js';
import { type MCPServerConfig, type MCPConnectionState, type Tool, type CallToolResult } from './types.js';
export declare class MCPManager {
    private clients;
    private configDir;
    constructor(configDir?: string);
    /**
     * Discover MCP server configurations from the config directory.
     * Looks for *.json files in ~/.buff/mcp/ and subdirectories.
     */
    discoverConfigs(): MCPServerConfig[];
    /**
     * Connect to an MCP server by its name.
     * If already connected, returns the existing client.
     */
    connect(name: string): Promise<MCPClient>;
    /**
     * Connect to all discovered MCP servers.
     */
    connectAll(): Promise<MCPClient[]>;
    /**
     * Disconnect from a specific MCP server.
     */
    disconnect(name: string): void;
    /**
     * Disconnect from all MCP servers.
     */
    disconnectAll(): void;
    /**
     * Get all tools from all connected MCP servers.
     */
    getAllTools(): Array<{
        server: string;
        tool: Tool;
    }>;
    /**
     * Call a tool by its name, searching across all connected servers.
     * If multiple servers have the same tool name, the first found is used.
     */
    callTool(name: string, args?: Record<string, unknown>): Promise<{
        server: string;
        result: CallToolResult;
    } | null>;
    /**
     * Get the state of all MCP servers (connected or not).
     */
    getAllStates(): MCPConnectionState[];
    /**
     * Get a connected MCP client by server name.
     * Returns undefined if the server is not connected or doesn't exist.
     */
    getClient(name: string): MCPClient | undefined;
    /**
     * Check if a specific MCP server is connected.
     */
    isConnected(name: string): boolean;
}
export declare function getMCPManager(): MCPManager;
export declare function resetMCPManager(): void;
//# sourceMappingURL=manager.d.ts.map