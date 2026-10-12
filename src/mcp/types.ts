/**
 * MCP Types — Model Context Protocol types for JSON-RPC 2.0 communication.
 *
 * The MCP protocol enables AI agents to connect to external tools and data
 * sources. This module defines the core types for tool discovery, tool
 * invocation, and resource access.
 *
 * Protocol: JSON-RPC 2.0 over stdio or SSE
 * Spec: https://modelcontextprotocol.io/specification/
 */

// ─── JSON-RPC 2.0 Base ──────────────────────────────────────────────────────

export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: JSONRPCError;
}

export interface JSONRPCError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

// ─── MCP Initialize ─────────────────────────────────────────────────────────

export interface InitializeRequest {
  protocolVersion: string;
  capabilities: ClientCapabilities;
  clientInfo: Implementation;
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: Implementation;
}

export interface Implementation {
  name: string;
  version: string;
}

export interface ClientCapabilities {
  roots?: { listChanged?: boolean };
  sampling?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
}

export interface ServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
}

// ─── Tools ──────────────────────────────────────────────────────────────────

/**
 * MCP `ToolAnnotations` — the SPEC's own effect declaration.
 *
 * Borrowed verbatim from the Model Context Protocol so the agent never has to
 * invent or phrase-match an effect class: a server may DECLARE whether its tool
 * only reads, or is destructive. The capability layer maps these onto its
 * `effectClass`, and an absent annotation means "unknown" — never "safe".
 *
 * Spec: https://modelcontextprotocol.io/specification/ — `ToolAnnotations`.
 */
export interface ToolAnnotations {
  /** A human-readable title for the tool. */
  title?: string;
  /** The tool does not modify its environment (a hint, not a guarantee). */
  readOnlyHint?: boolean;
  /** The tool may perform destructive updates to its environment. */
  destructiveHint?: boolean;
  /** Repeated calls with the same arguments have no additional effect. */
  idempotentHint?: boolean;
  /** The tool may interact with an "open world" of external entities. */
  openWorldHint?: boolean;
}

export interface Tool {
  /** The name of the tool (unique within the server) */
  name: string;
  /** A human-readable description of the tool */
  description?: string;
  /** JSON Schema defining the expected parameters */
  inputSchema?: Record<string, unknown>;
  /**
   * The server's own declaration of what this tool does. CARRIED THROUGH from the
   * SDK — it was previously dropped at `client.ts`, which silently made every MCP
   * tool look effect-unknown to the capability layer.
   */
  annotations?: ToolAnnotations;
}

export interface ListToolsResult {
  tools: Tool[];
}

export interface CallToolRequest {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface CallToolResult {
  content: Array<TextContent | ImageContent | EmbeddedResource>;
  isError?: boolean;
}

// ─── Content Types ──────────────────────────────────────────────────────────

export interface TextContent {
  type: 'text';
  text: string;
  annotations?: Annotations;
}

export interface ImageContent {
  type: 'image';
  data: string; // base64-encoded
  mimeType: string;
  annotations?: Annotations;
}

export interface EmbeddedResource {
  type: 'resource';
  resource: ResourceContents;
  annotations?: Annotations;
}

export interface Annotations {
  audience?: Array<'user' | 'assistant'>;
  priority?: number;
}

// ─── Resources ──────────────────────────────────────────────────────────────

export interface Resource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string; // base64-encoded
}

export interface ListResourcesResult {
  resources: Resource[];
}

export interface ReadResourceRequest {
  uri: string;
}

// ─── Prompts ────────────────────────────────────────────────────────────────

export interface Prompt {
  name: string;
  description?: string;
  arguments?: PromptArgument[];
}

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface ListPromptsResult {
  prompts: Prompt[];
}

export interface GetPromptRequest {
  name: string;
  arguments?: Record<string, string>;
}

// ─── Configuration ──────────────────────────────────────────────────────────

/**
 * OAuth 2.0 for a remote MCP server whose credential is a TOKEN, not a static
 * key — the flow Google Workspace, Slack and Figma's official remote servers
 * require (none of them accept a long-lived API key).
 *
 * WHY IT LIVES IN THE SERVER CONFIG. The credential those servers want is a
 * short-lived access token that must be refreshed, so "install the server" and
 * "authorize the server" are two different moments: the config declares HOW to
 * get a token, and the first connect obtains or refreshes one. Tokens themselves
 * are NEVER written here — they live in the OAuth manager's own store
 * (`~/.nuvira/mcp-oauth.json`), which is where refresh and expiry belong.
 */
export interface MCPOAuthServerConfig {
  /** Token endpoint (required — the code exchange and every refresh go here). */
  tokenEndpoint: string;
  /** Authorization endpoint. Required for the interactive (authorization-code) flow. */
  authorizationEndpoint?: string;
  /**
   * Client credentials. May reference an env var (`${VAR}`), which the catalog
   * installer expands from the resolved environment at install time — so a
   * secret can come from the environment and still land in a 0600 config file.
   */
  clientId?: string;
  clientSecret?: string;
  /** Scopes to request. Also written into the store so a refresh asks for the same set. */
  scopes?: string[];
  /** Use PKCE (S256) — required by Google's installed-app clients. */
  usePKCE?: boolean;
  /**
   * `client_credentials` for a server-to-server token (no user, no browser);
   * default is `authorization_code`, where a user token is obtained once
   * (`nuvira mcp authorize <name>`) and then refreshed forever.
   */
  grant?: 'authorization_code' | 'client_credentials';
}

export interface MCPServerConfig {
  /** A unique name for this MCP server connection */
  name: string;
  /** Transport type: 'stdio' for local subprocess, 'sse' for remote HTTP */
  transport: 'stdio' | 'sse';
  /** For stdio transport: the command to run (e.g., "npx @modelcontextprotocol/server-filesystem") */
  command?: string;
  /** For stdio transport: command arguments */
  args?: string[];
  /** For SSE transport: the SSE endpoint URL */
  url?: string;
  /** Custom HTTP headers for SSE transport (e.g., Authorization) */
  headers?: Record<string, string>;
  /** Environment variables for the stdio subprocess */
  env?: Record<string, string>;
  /**
   * Per-server runtime override: run the stdio `command` through a DIFFERENT
   * interpreter — `runtime.command runtime.args… <command> <args…>`.
   *
   * It exists so one server with a higher Node (or Python) floor cannot raise
   * the product's own floor: `context7-mcp@4.3.0` declares
   * `engines.node ≥ 20.18.1`, while Nuvira ships `≥ 18.18.0`, so that server is
   * started under its own Node instead. Set at install time (`nuvira mcp
   * install context7 --runtime /path/to/node20`) or by configuration
   * (`mcp.servers.<name>.runtime.command`), never by forking the codebase.
   */
  runtime?: { command: string; args?: string[] };
  /**
   * Which catalog variant produced this config (e.g. 'remote', 'npx'), when it
   * came from `nuvira mcp install`. Reported by `nuvira mcp list` / `info`;
   * never required to connect.
   */
  variant?: string;
  /**
   * OAuth 2.0 for a remote server. When present, the connect path resolves a
   * valid access token (reusing or refreshing a stored one) and sends it as
   * `Authorization: Bearer …`; an explicit `headers.Authorization` wins.
   */
  oauth?: MCPOAuthServerConfig;
  /** Whether this server is enabled */
  enabled: boolean;
}

export interface MCPConnectionState {
  name: string;
  transport: 'stdio' | 'sse';
  status: 'connected' | 'disconnected' | 'error';
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
  serverInfo?: Implementation;
  error?: string;
}

// ─── Default MCP Config Directory ───────────────────────────────────────────

/** The default directory where MCP server configs are stored */
export const MCP_CONFIG_DIR = '.nuvira/mcp';

/** The current MCP protocol version */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
