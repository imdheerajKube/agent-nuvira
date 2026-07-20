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

export interface Tool {
  /** The name of the tool (unique within the server) */
  name: string;
  /** A human-readable description of the tool */
  description?: string;
  /** JSON Schema defining the expected parameters */
  inputSchema?: Record<string, unknown>;
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
  /** Environment variables for the stdio subprocess */
  env?: Record<string, string>;
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
export const MCP_CONFIG_DIR = '.buff/mcp';

/** The current MCP protocol version */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
