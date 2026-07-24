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
// ─── Default MCP Config Directory ───────────────────────────────────────────
/** The default directory where MCP server configs are stored */
export const MCP_CONFIG_DIR = '.buff/mcp';
/** The current MCP protocol version */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
//# sourceMappingURL=types.js.map