/**
 * MCP CLI Command — Manage MCP (Model Context Protocol) server connections.
 *
 * Usage:
 *   nuvira mcp list              — List all discovered MCP servers and their tools
 *   nuvira mcp connect <name>    — Connect to a specific MCP server
 *   nuvira mcp connect --all     — Connect to all discovered MCP servers
 *   nuvira mcp call <tool>       — Call a tool with arguments
 *   nuvira mcp call <tool> --server <name>
 *   nuvira mcp call <tool> --args '{"key":"value"}'
 *   nuvira mcp info <name>       — Show detailed info for an MCP server
 *   nuvira mcp refresh           — Re-discover and reconnect to MCP servers
 *   nuvira mcp serve             — Expose agent tools as an MCP server (stdio)
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class MCPCommand extends BaseCommand {
    create(): Command;
    private listServers;
    private connectServer;
    private callTool;
    private showInfo;
    private refreshServers;
    private serveTools;
    private renderToolResult;
}
//# sourceMappingURL=mcp.d.ts.map