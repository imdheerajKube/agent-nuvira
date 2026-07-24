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
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { logger } from '../utils/logger.js';
import { MCP_PROTOCOL_VERSION, } from './types.js';
// ─── MCP Client ─────────────────────────────────────────────────────────────
export class MCPClient extends EventEmitter {
    config;
    process = null;
    lineReader = null;
    requestId = 0;
    pendingRequests = new Map();
    _connected = false;
    _serverInfo = null;
    _tools = [];
    _resources = [];
    _prompts = [];
    /** Timeout for JSON-RPC requests (ms) */
    requestTimeoutMs;
    constructor(config, requestTimeoutMs = 15_000) {
        super();
        this.config = config;
        this.requestTimeoutMs = requestTimeoutMs;
    }
    // ─── Public Accessors ─────────────────────────────────────────────────────
    get name() { return this.config.name; }
    get connected() { return this._connected; }
    get serverInfo() { return this._serverInfo; }
    get tools() { return this._tools; }
    get resources() { return this._resources; }
    get prompts() { return this._prompts; }
    get state() {
        return {
            name: this.config.name,
            transport: this.config.transport,
            status: this._connected ? 'connected' : 'disconnected',
            tools: this._tools,
            resources: this._resources,
            prompts: this._prompts,
            serverInfo: this._serverInfo ?? undefined,
        };
    }
    // ─── Connection Lifecycle ─────────────────────────────────────────────────
    /**
     * Connect to the MCP server. For stdio transport this spawns the subprocess;
     * for SSE transport this connects to the HTTP endpoint.
     */
    async connect() {
        if (this._connected) {
            logger.debug(`MCP[${this.config.name}]: Already connected`);
            return;
        }
        try {
            if (this.config.transport === 'stdio') {
                await this.connectStdio();
            }
            else {
                await this.connectSSE();
            }
            // Perform initialization handshake
            await this.initialize();
            this._connected = true;
            this.emit('connected');
            // Discover available capabilities
            await this.discoverCapabilities();
            logger.debug(`MCP[${this.config.name}]: Connected (tools: ${this._tools.length}, resources: ${this._resources.length})`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.debug(`MCP[${this.config.name}]: Connection failed: ${msg}`);
            this.emit('error', err instanceof Error ? err : new Error(msg));
            throw err;
        }
    }
    /**
     * Disconnect from the MCP server, cleaning up any subprocess or SSE connection.
     */
    disconnect() {
        this._connected = false;
        this._serverInfo = null;
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Disconnected'));
            this.pendingRequests.delete(id);
        }
        if (this.lineReader) {
            this.lineReader.close();
            this.lineReader = null;
        }
        if (this.process && !this.process.killed) {
            this.process.kill();
            this.process = null;
        }
        this.emit('disconnected');
        logger.debug(`MCP[${this.config.name}]: Disconnected`);
    }
    // ─── Tool Invocation ─────────────────────────────────────────────────────
    /**
     * List all tools available from this MCP server.
     */
    async listTools() {
        const result = await this.sendRequest('tools/list');
        this._tools = result.tools || [];
        return this._tools;
    }
    /**
     * Call a tool on the MCP server.
     *
     * @param name — The tool name to call
     * @param args — Arguments to pass to the tool
     * @returns The tool call result with content blocks
     */
    async callTool(name, args) {
        const result = await this.sendRequest('tools/call', { name, arguments: args });
        return result;
    }
    // ─── Resource Access ─────────────────────────────────────────────────────
    /**
     * List all resources available from this MCP server.
     */
    async listResources() {
        const result = await this.sendRequest('resources/list');
        this._resources = result.resources || [];
        return this._resources;
    }
    /**
     * Read a resource by URI.
     *
     * @param uri — The resource URI to read
     */
    async readResource(uri) {
        return this.sendRequest('resources/read', { uri });
    }
    // ─── Prompt Access ───────────────────────────────────────────────────────
    /**
     * List all prompts available from this MCP server.
     */
    async listPrompts() {
        const result = await this.sendRequest('prompts/list');
        this._prompts = result.prompts || [];
        return this._prompts;
    }
    /**
     * Get a specific prompt by name with optional arguments.
     */
    async getPrompt(name, args) {
        return this.sendRequest('prompts/get', { name, arguments: args });
    }
    // ─── Private: Transport Implementations ───────────────────────────────────
    /**
     * Connect via stdio — spawns a subprocess and communicates via stdin/stdout.
     */
    async connectStdio() {
        if (!this.config.command) {
            throw new Error(`MCP[${this.config.name}]: No command specified for stdio transport`);
        }
        const env = { ...process.env, ...this.config.env };
        this.process = spawn(this.config.command, this.config.args || [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
        });
        this.process.on('error', (err) => {
            this.emit('error', err);
        });
        this.process.on('exit', (code) => {
            if (this._connected) {
                logger.debug(`MCP[${this.config.name}]: Process exited with code ${code}`);
                this.disconnect();
            }
        });
        // Set up line-based reader on stdout
        this.lineReader = createInterface({
            input: this.process.stdout,
            crlfDelay: Infinity,
        });
        this.lineReader.on('line', (line) => {
            this.handleMessage(line);
        });
        // Log stderr for debugging
        this.process.stderr?.on('data', (data) => {
            const text = data.toString().trim();
            if (text) {
                logger.debug(`MCP[${this.config.name}] stderr: ${text}`);
            }
        });
    }
    /**
     * Connect via SSE — connects to a remote HTTP SSE endpoint.
     */
    async connectSSE() {
        if (!this.config.url) {
            throw new Error(`MCP[${this.config.name}]: No URL specified for SSE transport`);
        }
        // For SSE transport, we send JSON-RPC messages via HTTP POST
        // and receive responses via the SSE stream.
        // This is a simplified implementation that uses fetch + EventSource-like polling.
        // A full implementation would use an EventSource-compatible reader.
        // Test the connection — try GET first (standard SSE), fall back if server only accepts POST
        try {
            const headers = { ...this.config.headers };
            const response = await fetch(this.config.url, { headers, method: 'GET' });
            if (response.ok || response.status === 405) {
                // 405 means the server accepts POST only, which is fine for our implementation
                logger.debug(`MCP[${this.config.name}]: SSE endpoint reachable at ${this.config.url}`);
            }
            else {
                throw new Error(`SSE endpoint returned status ${response.status}`);
            }
        }
        catch (err) {
            throw new Error(`Failed to connect to SSE endpoint: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // ─── Private: JSON-RPC Messaging ─────────────────────────────────────────
    /**
     * Send a JSON-RPC request and wait for the response.
     */
    async sendRequest(method, params) {
        if (!this._connected && method !== 'initialize') {
            throw new Error('Not connected to MCP server');
        }
        const id = ++this.requestId;
        const request = {
            jsonrpc: '2.0',
            id,
            method,
            params,
        };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`MCP[${this.config.name}]: Request '${method}' timed out after ${this.requestTimeoutMs}ms`));
            }, this.requestTimeoutMs);
            this.pendingRequests.set(id, { resolve: resolve, reject, timer });
            this.sendRaw(request);
        });
    }
    /**
     * Send a raw JSON-RPC message over the transport.
     */
    sendRaw(message) {
        const raw = JSON.stringify(message) + '\n';
        if (this.config.transport === 'stdio') {
            if (this.process?.stdin?.writable) {
                this.process.stdin.write(raw);
            }
            else {
                logger.debug(`MCP[${this.config.name}]: Cannot write to stdin (not writable)`);
            }
        }
        else {
            // SSE transport: send via HTTP POST
            this.sendSSEMessage(raw).catch((err) => {
                logger.debug(`MCP[${this.config.name}]: SSE send failed: ${err.message}`);
            });
        }
    }
    /**
     * Send a message via SSE HTTP POST.
     */
    async sendSSEMessage(raw) {
        if (!this.config.url)
            return;
        const response = await fetch(this.config.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                ...this.config.headers,
            },
            body: raw,
        });
        if (!response.ok) {
            throw new Error(`SSE request failed: ${response.status}`);
        }
        // For simplicity, parse the SSE response for the result
        const text = await response.text();
        for (const line of text.split('\n')) {
            if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data) {
                    this.handleMessage(data);
                }
            }
        }
    }
    /**
     * Handle an incoming JSON-RPC message from the transport.
     */
    handleMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            logger.debug(`MCP[${this.config.name}]: Failed to parse message: ${raw.slice(0, 100)}`);
            return;
        }
        // Resolve the matching pending request
        if (msg.id !== undefined) {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
                clearTimeout(pending.timer);
                this.pendingRequests.delete(msg.id);
                if (msg.error) {
                    pending.reject(new Error(`MCP RPC Error (${msg.error.code}): ${msg.error.message}`));
                }
                else {
                    pending.resolve(msg.result);
                }
            }
        }
    }
    // ─── Private: Handshake & Discovery ─────────────────────────────────────
    /**
     * Perform the MCP initialization handshake.
     */
    async initialize() {
        const result = await this.sendRequest('initialize', {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
                tools: { listChanged: true },
                resources: { subscribe: true },
            },
            clientInfo: {
                name: 'agent-nuvira',
                version: '1.14.6',
            },
        });
        this._serverInfo = result.serverInfo;
        logger.debug(`MCP[${this.config.name}]: Initialized — ${result.serverInfo.name} v${result.serverInfo.version} (protocol ${result.protocolVersion})`);
        // Send initialized notification
        this.sendRaw({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
        });
    }
    /**
     * Discover server capabilities after initialization.
     */
    async discoverCapabilities() {
        // Try to list tools
        try {
            await this.listTools();
        }
        catch {
            // Some servers may not support tools
        }
        // Try to list resources
        try {
            await this.listResources();
        }
        catch {
            // Some servers may not support resources
        }
        // Try to list prompts
        try {
            await this.listPrompts();
        }
        catch {
            // Some servers may not support prompts
        }
    }
}
// ─── Factory ─────────────────────────────────────────────────────────────────
/**
 * Create an MCP client from a server configuration.
 */
export function createMCPClient(config) {
    return new MCPClient(config);
}
//# sourceMappingURL=client.js.map