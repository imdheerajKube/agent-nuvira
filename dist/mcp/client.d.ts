/**
 * MCP Client — Connects to MCP servers via stdio or SSE transport.
 *
 * The Model Context Protocol (MCP) allows AI agents to discover and invoke
 * tools exposed by external servers. This client implements:
 * - stdio transport: spawns a subprocess and communicates via stdin/stdout
 * - SSE transport: connects to a remote HTTP server with Server-Sent Events
 *
 * Protocol: JSON-RPC 2.0
 * Spec: https://modelcontextprotocol.io/specification/
 */
import { EventEmitter } from 'node:events';
import { type Tool, type Resource, type Prompt, type CallToolResult, type TextContent, type EmbeddedResource, type Implementation, type MCPServerConfig, type MCPConnectionState } from './types.js';
export interface MCPClientEvents {
    connected: [];
    disconnected: [];
    error: [error: Error];
    'tool-list-changed': [];
    'resource-list-changed': [];
}
export declare class MCPClient extends EventEmitter {
    private config;
    private process;
    private lineReader;
    private requestId;
    private pendingRequests;
    private _connected;
    private _serverInfo;
    private _tools;
    private _resources;
    private _prompts;
    /** Timeout for JSON-RPC requests (ms) */
    private readonly requestTimeoutMs;
    constructor(config: MCPServerConfig, requestTimeoutMs?: number);
    get name(): string;
    get connected(): boolean;
    get serverInfo(): Implementation | null;
    get tools(): Tool[];
    get resources(): Resource[];
    get prompts(): Prompt[];
    get state(): MCPConnectionState;
    /**
     * Connect to the MCP server. For stdio transport this spawns the subprocess;
     * for SSE transport this connects to the HTTP endpoint.
     */
    connect(): Promise<void>;
    /**
     * Disconnect from the MCP server, cleaning up any subprocess or SSE connection.
     */
    disconnect(): void;
    /**
     * List all tools available from this MCP server.
     */
    listTools(): Promise<Tool[]>;
    /**
     * Call a tool on the MCP server.
     *
     * @param name — The tool name to call
     * @param args — Arguments to pass to the tool
     * @returns The tool call result with content blocks
     */
    callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
    /**
     * List all resources available from this MCP server.
     */
    listResources(): Promise<Resource[]>;
    /**
     * Read a resource by URI.
     *
     * @param uri — The resource URI to read
     */
    readResource(uri: string): Promise<TextContent | EmbeddedResource>;
    /**
     * List all prompts available from this MCP server.
     */
    listPrompts(): Promise<Prompt[]>;
    /**
     * Get a specific prompt by name with optional arguments.
     */
    getPrompt(name: string, args?: Record<string, string>): Promise<unknown>;
    /**
     * Connect via stdio — spawns a subprocess and communicates via stdin/stdout.
     */
    private connectStdio;
    /**
     * Connect via SSE — connects to a remote HTTP SSE endpoint.
     */
    private connectSSE;
    /**
     * Send a JSON-RPC request and wait for the response.
     */
    private sendRequest;
    /**
     * Send a raw JSON-RPC message over the transport.
     */
    private sendRaw;
    /**
     * Send a message via SSE HTTP POST.
     */
    private sendSSEMessage;
    /**
     * Handle an incoming JSON-RPC message from the transport.
     */
    private handleMessage;
    /**
     * Perform the MCP initialization handshake.
     */
    private initialize;
    /**
     * Discover server capabilities after initialization.
     */
    private discoverCapabilities;
}
/**
 * Create an MCP client from a server configuration.
 */
export declare function createMCPClient(config: MCPServerConfig): MCPClient;
//# sourceMappingURL=client.d.ts.map