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

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { logger } from '../utils/logger.js';
import {
  type Tool,
  type Resource,
  type Prompt,
  type CallToolResult,
  type TextContent,
  type EmbeddedResource,
  type Implementation,
  type MCPServerConfig,
  type MCPConnectionState,
} from './types.js';

// ─── Events ──────────────────────────────────────────────────────────────────

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

const CLIENT_NAME = 'agent-nuvira';
const CLIENT_VERSION = '1.61.1';

// ─── MCP Client ─────────────────────────────────────────────────────────────

export class MCPClient extends EventEmitter {
  private config: MCPServerConfig;
  private client: Client | null = null;
  private transport: Transport | null = null;
  private transportFactory: TransportFactory | undefined;

  private _connected = false;
  private _serverInfo: Implementation | null = null;
  private _tools: Tool[] = [];
  private _resources: Resource[] = [];
  private _prompts: Prompt[] = [];

  /** Timeout for JSON-RPC requests (ms) — passed through to the SDK. */
  private readonly requestTimeoutMs: number;

  constructor(config: MCPServerConfig, requestTimeoutMs = 15_000, transportFactory?: TransportFactory) {
    super();
    this.config = config;
    this.requestTimeoutMs = requestTimeoutMs;
    this.transportFactory = transportFactory;
  }

  // ─── Public Accessors ─────────────────────────────────────────────────────

  get name(): string { return this.config.name; }
  get connected(): boolean { return this._connected; }
  get serverInfo(): Implementation | null { return this._serverInfo; }
  get tools(): Tool[] { return this._tools; }
  get resources(): Resource[] { return this._resources; }
  get prompts(): Prompt[] { return this._prompts; }

  get state(): MCPConnectionState {
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
   * for sse transport this connects to the Streamable HTTP endpoint. The SDK
   * performs the initialize handshake inside `client.connect(transport)`.
   */
  async connect(): Promise<void> {
    if (this._connected) {
      logger.debug(`MCP[${this.config.name}]: Already connected`);
      return;
    }

    try {
      const transport = this.transportFactory
        ? this.transportFactory(this.config)
        : this.buildTransport();
      this.transport = transport;

      const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
      this.client = client;

      // Race the SDK connect against our request timeout so a transport that
      // starts but never completes the handshake can't hang the pipeline.
      await this.withTimeout(client.connect(transport, { timeout: this.requestTimeoutMs }));

      // Surface runtime transport errors as 'error' events. The SDK routes
      // transport errors through `client.onerror`; without a handler they are
      // silently dropped. Set only AFTER a successful connect so a connect
      // failure emits exactly one 'error' (from the catch below), never two.
      client.onerror = (err) => {
        this.emit('error', err);
      };

      this._connected = true;
      const serverInfo = client.getServerVersion();
      this._serverInfo = serverInfo ? { name: serverInfo.name, version: serverInfo.version } : null;
      this.emit('connected');

      logger.debug(`MCP[${this.config.name}]: Connected (${this._serverInfo?.name ?? 'unknown'} ${this._serverInfo?.version ?? ''})`);

      // Discover available capabilities
      await this.discoverCapabilities();

      logger.debug(`MCP[${this.config.name}]: Connected (tools: ${this._tools.length}, resources: ${this._resources.length})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`MCP[${this.config.name}]: Connection failed: ${msg}`);
      this.emit('error', err instanceof Error ? err : new Error(msg));
      // Best-effort teardown so a half-started transport / spawned child
      // can't leak and keep the CLI process alive.
      await this.closeClient().catch(() => {});
      throw new Error(`MCP[${this.config.name}]: Failed to connect: ${msg}`);
    }
  }

  /**
   * Disconnect from the MCP server. The SDK's close() reaps the stdio child
   * (stdin end → SIGTERM → SIGKILL) or tears down the HTTP stream. Sync by
   * design — callers (MCPManager.disconnectAll) tear down in a loop.
   */
  disconnect(): void {
    this._connected = false;
    this._serverInfo = null;
    const client = this.client;
    this.client = null;
    if (client) {
      void client.close().catch((err) => {
        logger.debug(`MCP[${this.config.name}]: close error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    this.emit('disconnected');
    logger.debug(`MCP[${this.config.name}]: Disconnected`);
  }

  // ─── Tool Invocation ─────────────────────────────────────────────────────

  /**
   * List all tools available from this MCP server.
   */
  async listTools(): Promise<Tool[]> {
    if (!this.ensureConnected()) throw this.notConnectedError();
    const result = await this.client!.listTools({}, { timeout: this.requestTimeoutMs });
    const tools = (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));
    const changed = tools.length !== this._tools.length
      || tools.some((t, i) => t.name !== this._tools[i]?.name);
    this._tools = tools;
    if (changed) this.emit('tool-list-changed');
    return this._tools;
  }

  /**
   * Call a tool on the MCP server.
   *
   * @param name — The tool name to call
   * @param args — Arguments to pass to the tool
   * @returns The tool call result with content blocks
   */
  async callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.ensureConnected()) throw this.notConnectedError();
    const result = await this.client!.callTool({ name, arguments: args }, undefined, {
      timeout: this.requestTimeoutMs,
    });
    return {
      content: result.content as CallToolResult['content'],
      isError: result.isError as boolean | undefined,
    };
  }

  // ─── Resource Access ─────────────────────────────────────────────────────

  /**
   * List all resources available from this MCP server.
   */
  async listResources(): Promise<Resource[]> {
    if (!this.ensureConnected()) throw this.notConnectedError();
    const result = await this.client!.listResources({}, { timeout: this.requestTimeoutMs });
    const resources = (result.resources ?? []).map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
    const changed = resources.length !== this._resources.length
      || resources.some((r, i) => r.uri !== this._resources[i]?.uri);
    this._resources = resources;
    if (changed) this.emit('resource-list-changed');
    return this._resources;
  }

  /**
   * Read a resource by URI. Returns the first content block (the SDK
   * normalizes `resources/read` to `{ contents: [...] }`).
   *
   * @param uri — The resource URI to read
   */
  async readResource(uri: string): Promise<TextContent | EmbeddedResource> {
    if (!this.ensureConnected()) throw this.notConnectedError();
    const result = await this.client!.readResource({ uri }, { timeout: this.requestTimeoutMs });
    const first = result.contents?.[0];
    if (!first) return { type: 'text', text: '' };
    if ('text' in first) {
      return { type: 'text', text: first.text ?? '' };
    }
    return { type: 'resource', resource: { uri: first.uri, mimeType: first.mimeType, blob: first.blob } };
  }

  // ─── Prompt Access ───────────────────────────────────────────────────────

  /**
   * List all prompts available from this MCP server.
   */
  async listPrompts(): Promise<Prompt[]> {
    if (!this.ensureConnected()) throw this.notConnectedError();
    const result = await this.client!.listPrompts({}, { timeout: this.requestTimeoutMs });
    this._prompts = (result.prompts ?? []).map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    }));
    return this._prompts;
  }

  /**
   * Get a specific prompt by name with optional arguments.
   */
  async getPrompt(name: string, args?: Record<string, string>): Promise<unknown> {
    if (!this.ensureConnected()) throw this.notConnectedError();
    const result = await this.client!.getPrompt({ name, arguments: args }, {
      timeout: this.requestTimeoutMs,
    });
    return result;
  }

  // ─── Private: Transport Construction ─────────────────────────────────────

  /** Build the SDK transport for this server's config (stdio vs sse). */
  private buildTransport(): Transport {
    if (this.config.transport === 'stdio') {
      if (!this.config.command) {
        throw new Error(`MCP[${this.config.name}]: No command specified for stdio transport`);
      }
      const transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        env: this.config.env ?? {},
        // Pipe stderr so the old client's debug logging behavior is preserved
        // (the getter returns a PassThrough immediately — safe to attach
        // before start()).
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          logger.debug(`MCP[${this.config.name}] stderr: ${text}`);
        }
      });
      return transport;
    }

    if (!this.config.url) {
      throw new Error(`MCP[${this.config.name}]: No URL specified for SSE transport`);
    }
    // Request-level timeouts are enforced per-call via `{ timeout }` on the
    // client; the transport itself doesn't take one in SDK v1.30.
    return new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: this.config.headers ? { headers: this.config.headers } : undefined,
    });
  }

  // ─── Private: Handshake & Discovery ─────────────────────────────────────

  /**
   * Discover server capabilities after initialization. The SDK already
   * re-lists tools/resources when the server advertises `listChanged`; this
   * is the explicit initial snapshot (mirrors the old client).
   */
  private async discoverCapabilities(): Promise<void> {
    // Try to list tools
    try {
      await this.listTools();
    } catch {
      // Some servers may not support tools
    }

    // Try to list resources
    try {
      await this.listResources();
    } catch {
      // Some servers may not support resources
    }

    // Try to list prompts
    try {
      await this.listPrompts();
    } catch {
      // Some servers may not support prompts
    }
  }

  /** Reject if `p` doesn't settle within the request timeout. */
  private withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Connection timed out after ${this.requestTimeoutMs}ms`)),
        this.requestTimeoutMs,
      );
    });
    return Promise.race([p, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /** Whether the SDK client is usable (connected + created). */
  private ensureConnected(): boolean {
    return this._connected && this.client !== null;
  }

  /** The not-connected error message (stable across callers/tests). */
  private notConnectedError(): Error {
    return new Error('Not connected to MCP server');
  }

  /** Fire-and-forget teardown used on connect failure paths. */
  private async closeClient(): Promise<void> {
    if (this.client) {
      const client = this.client;
      this.client = null;
      await client.close();
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an MCP client from a server configuration.
 */
export function createMCPClient(config: MCPServerConfig): MCPClient {
  return new MCPClient(config);
}
