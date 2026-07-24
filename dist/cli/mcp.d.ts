/**
 * MCP CLI Command — Manage MCP (Model Context Protocol) server connections.
 *
 * Usage:
 *   buff mcp list              — List all discovered MCP servers and their tools
 *   buff mcp connect <name>    — Connect to a specific MCP server
 *   buff mcp connect --all     — Connect to all discovered MCP servers
 *   buff mcp call <tool>       — Call a tool with arguments
 *   buff mcp call <tool> --server <name>
 *   buff mcp call <tool> --args '{"key":"value"}'
 *   buff mcp info <name>       — Show detailed info for an MCP server
 *   buff mcp refresh           — Re-discover and reconnect to MCP servers
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
    private renderToolResult;
}
//# sourceMappingURL=mcp.d.ts.map