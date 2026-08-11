/**
 * MCP Client — Connects to MCP servers via stdio or Streamable HTTP.
 *
 * F2: the transport + JSON-RPC internals now run on the OFFICIAL
 * `@modelcontextprotocol/sdk` (Client + StdioClientTransport +
 * StreamableHTTPClientTransport) — replacing the hand-rolled JSON-RPC loop
 * with identical call behavior (no API break for callers): same constructor,
 * methods, getters, events, and `MCPConnectionState` shape.
 *
 * Transports:
 * - stdio: spawns a subprocess; the SDK's close() reaps the child with a
 *   stdin-end → SIGTERM → SIGKILL escalation (the old client's detached
 *   process-group kill is an SDK trade-off — the direct child is always
 *   reaped, npx-wrapped grandchildren are not).
 * - sse: maps to StreamableHTTPClientTransport (Streamable HTTP is the spec
 *   successor of the old SSE transport; the same `transport: 'sse'` config
 *   entries keep working unchanged).
 *
 * Spec: https://modelcontextprotocol.io/specification/
 */
import { EventEmitter } from 'node:events';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type Tool, type Resource, type Prompt, type CallToolResult, type TextContent, type EmbeddedResource, type Implementation, type MCPServerConfig, type MCPConnectionState } from './types.js';
export interface MCPClientEvents {
    connected: [];
    disconnected: [];
    error: [error: Error];
    'tool-list-changed': [];
    'resource-list-changed': [];
}
/**
 * Optional transport factory — a test seam. Production callers never pass it;
 * unit tests inject an in-memory Transport to drive the SDK client without
 * spawning a subprocess or opening sockets.
 */
export type TransportFactory = (config: MCPServerConfig) => Transport;
export declare class MCPClient extends EventEmitter {
    private config;
    private client;
    private transport;
    private transportFactory;
    private _connected;
    private _serverInfo;
    private _tools;
    private _resources;
    private _prompts;
    /** Timeout for JSON-RPC requests (ms) — passed through to the SDK. */
    private readonly requestTimeoutMs;
    constructor(config: MCPServerConfig, requestTimeoutMs?: number, transportFactory?: TransportFactory);
    get name(): string;
    get connected(): boolean;
    get serverInfo(): Implementation | null;
    get tools(): Tool[];
    get resources(): Resource[];
    get prompts(): Prompt[];
    get state(): MCPConnectionState;
    /**
     * Connect to the MCP server. For stdio transport this spawns the subprocess;
     * for sse transport this connects to the Streamable HTTP endpoint. The SDK
     * performs the initialize handshake inside `client.connect(transport)`.
     */
    connect(): Promise<void>;
    /**
     * Disconnect from the MCP server. The SDK's close() reaps the stdio child
     * (stdin end → SIGTERM → SIGKILL) or tears down the HTTP stream. Sync by
     * design — callers (MCPManager.disconnectAll) tear down in a loop.
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
     * Read a resource by URI. Returns the first content block (the SDK
     * normalizes `resources/read` to `{ contents: [...] }`).
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
    /** Build the SDK transport for this server's config (stdio vs sse). */
    private buildTransport;
    /**
     * Discover server capabilities after initialization. The SDK already
     * re-lists tools/resources when the server advertises `listChanged`; this
     * is the explicit initial snapshot (mirrors the old client).
     */
    private discoverCapabilities;
    /** Reject if `p` doesn't settle within the request timeout. */
    private withTimeout;
    /** Whether the SDK client is usable (connected + created). */
    private ensureConnected;
    /** The not-connected error message (stable across callers/tests). */
    private notConnectedError;
    /** Fire-and-forget teardown used on connect failure paths. */
    private closeClient;
}
/**
 * Create an MCP client from a server configuration.
 */
export declare function createMCPClient(config: MCPServerConfig): MCPClient;
//# sourceMappingURL=client.d.ts.map