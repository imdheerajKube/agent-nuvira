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
import { MCPClient } from '../mcp/client.js';
import { getMCPManager } from '../mcp/manager.js';
import { type MCPServerConfig, MCP_CONFIG_DIR } from '../mcp/types.js';
import { logger } from '../utils/logger.js';

export class MCPCommand extends BaseCommand {
  create(): Command {
    const command = new Command('mcp')
      .description('Manage MCP (Model Context Protocol) server connections')
      .addHelpText('after', `
Examples:
  buff mcp list                          # List servers and tools
  buff mcp connect filesystem            # Connect to a server by name
  buff mcp connect --all                 # Connect to all discovered servers
  buff mcp call get_weather              # Call a tool (uses first connected server)
  buff mcp call read_file --server fs    # Call a tool on a specific server
  buff mcp call read_file --args '{"path":"/tmp/test.txt"}'
  buff mcp info filesystem               # Show server details
  buff mcp refresh                       # Re-discover and reconnect

Configured via JSON files in: ~/${MCP_CONFIG_DIR}/
  `);

    // ── list ──────────────────────────────────────────────────────────────
    command
      .command('list')
      .description('List all discovered MCP servers and their tools')
      .action(async () => {
        await this.listServers();
      });

    // ── connect ───────────────────────────────────────────────────────────
    command
      .command('connect')
      .description('Connect to an MCP server')
      .argument('[name]', 'Server name (omit with --all)')
      .option('--all', 'Connect to all discovered servers')
      .action(async (name?: string, options?: { all?: boolean }) => {
        await this.connectServer(name, options || {});
      });

    // ── call ──────────────────────────────────────────────────────────────
    command
      .command('call')
      .description('Call a tool on an MCP server')
      .argument('<tool-name>', 'Name of the tool to call')
      .option('-s, --server <name>', 'Server name (uses first found if omitted)')
      .option('-a, --args <json>', 'Tool arguments as JSON string')
      .action(async (toolName: string, options?: { server?: string; args?: string }) => {
        await this.callTool(toolName, options || {});
      });

    // ── info ──────────────────────────────────────────────────────────────
    command
      .command('info')
      .description('Show detailed information for an MCP server')
      .argument('<name>', 'Server name')
      .action(async (name: string) => {
        await this.showInfo(name);
      });

    // ── refresh ───────────────────────────────────────────────────────────
    command
      .command('refresh')
      .description('Re-discover and reconnect to all MCP servers')
      .action(async () => {
        await this.refreshServers();
      });

    return command;
  }

  // ── Action Handlers ──────────────────────────────────────────────────────

  private async listServers(): Promise<void> {
    const manager = getMCPManager();
    const states = manager.getAllStates();
    const allTools = manager.getAllTools();

    logger.highlight('═'.repeat(60));
    logger.highlight('  🔌  MCP Server Connections');
    logger.highlight('═'.repeat(60));
    console.log('');

    if (states.length === 0) {
      logger.info(`No MCP servers configured. Add config files to ~/${MCP_CONFIG_DIR}/`);
      console.log('');
      console.log('  Example config (filesystem.json):');
      console.log('  {');
      console.log('    "name": "filesystem",');
      console.log('    "transport": "stdio",');
      console.log('    "command": "npx",');
      console.log('    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/project"],');
      console.log('    "enabled": true');
      console.log('  }');
      console.log('');
      return;
    }

    for (const state of states) {
      const statusIcon = state.status === 'connected' ? '🟢' : state.status === 'error' ? '🔴' : '⚪';
      const toolCount = state.tools.length;
      const resourceCount = state.resources.length;

      console.log(`  ${statusIcon} ${state.name} (${state.transport}, ${state.status})`);
      console.log(`     Server: ${state.serverInfo ? `${state.serverInfo.name} v${state.serverInfo.version}` : 'N/A'}`);
      console.log(`     Tools: ${toolCount}  |  Resources: ${resourceCount}  |  Prompts: ${state.prompts.length}`);
      console.log('');
    }

    if (allTools.length > 0) {
      logger.highlight(`  🛠️  All Available Tools (${allTools.length})`);
      console.log('');

      // Group tools by server
      const byServer = new Map<string, typeof allTools>();
      for (const entry of allTools) {
        const list = byServer.get(entry.server) || [];
        list.push(entry);
        byServer.set(entry.server, list);
      }

      for (const [server, tools] of byServer) {
        console.log(`  ${server}:`);
        for (const { tool } of tools) {
          const desc = tool.description ? ` — ${tool.description.slice(0, 60)}` : '';
          console.log(`    • ${tool.name}${desc}`);
        }
        console.log('');
      }

      logger.info('Run `buff mcp call <tool-name>` to invoke a tool.');
    }

    console.log('');
  }

  private async connectServer(
    name: string | undefined,
    options: { all?: boolean },
  ): Promise<void> {
    const manager = getMCPManager();

    if (options.all) {
      logger.info('Connecting to all discovered MCP servers...');
      console.log('');

      const connected = await manager.connectAll();

      if (connected.length === 0) {
        logger.info('No MCP servers found or connected.');
        console.log('');
        return;
      }

      logger.success(`Connected to ${connected.length} MCP server(s)`);
      for (const client of connected) {
        const toolCount = client.tools.length;
        const serverVersion = client.serverInfo ? `${client.serverInfo.name} v${client.serverInfo.version}` : 'unknown';
        console.log(`  🟢 ${client.name} — ${serverVersion} (${toolCount} tools)`);
      }
      console.log('');
      return;
    }

    if (!name) {
      logger.error('Specify a server name or use --all to connect to all.');
      console.log('');
      return;
    }

    try {
      logger.info(`Connecting to MCP server '${name}'...`);
      const client = await manager.connect(name);
      logger.success(`Connected to '${name}' (${client.serverInfo?.name || 'unknown'} v${client.serverInfo?.version || '?'})`);
      console.log(`  Tools: ${client.tools.length}`);
      console.log(`  Resources: ${client.resources.length}`);
      console.log(`  Prompts: ${client.prompts.length}`);
      console.log('');
    } catch (err) {
      logger.error(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
      console.log('');
    }
  }

  private async callTool(
    toolName: string,
    options: { server?: string; args?: string },
  ): Promise<void> {
    const manager = getMCPManager();

    let args: Record<string, unknown> | undefined;
    if (options.args) {
      try {
        args = JSON.parse(options.args) as Record<string, unknown>;
      } catch {
        logger.error('Invalid JSON in --args. Use valid JSON like: --args \'{"key":"value"}\'');
        console.log('');
        return;
      }
    }

    if (options.server) {
      // Call on a specific server
      const client = manager.getClient(options.server);
      if (!client) {
        logger.error(`Server '${options.server}' is not connected. Connect first: buff mcp connect ${options.server}`);
        console.log('');
        return;
      }

      logger.info(`Calling ${options.server}.${toolName}...`);
      console.log('');

      try {
        const result = await client.callTool(toolName, args);
        this.renderToolResult(result);
      } catch (err) {
        logger.error(`Tool call failed: ${err instanceof Error ? err.message : String(err)}`);
        console.log('');
      }
    } else {
      // Search across all connected servers
      logger.info(`Searching for tool '${toolName}' across all connected servers...`);
      console.log('');

      const result = await manager.callTool(toolName, args);
      if (!result) {
        logger.error(`Tool '${toolName}' not found on any connected server.`);
        logger.info('Use `buff mcp list` to see available tools.');
        console.log('');
        return;
      }

      logger.success(`Found tool on server '${result.server}'`);
      console.log('');
      this.renderToolResult(result.result);
    }
  }

  private async showInfo(name: string): Promise<void> {
    const manager = getMCPManager();
    const states = manager.getAllStates();
    const state = states.find((s) => s.name === name);

    if (!state) {
      logger.error(`MCP server '${name}' not found.`);
      logger.info(`Add a config file to ~/${MCP_CONFIG_DIR}/ or use a different name.`);
      console.log('');
      return;
    }

    const statusIcon = state.status === 'connected' ? '🟢' : state.status === 'error' ? '🔴' : '⚪';
    logger.highlight(`  ${statusIcon}  ${state.name}`);
    console.log('');
    console.log(`  Transport: ${state.transport}`);
    console.log(`  Status: ${state.status}`);
    if (state.serverInfo) {
      console.log(`  Server: ${state.serverInfo.name} v${state.serverInfo.version}`);
    }
    if (state.error) {
      console.log(`  Error: ${state.error}`);
    }
    console.log('');

    if (state.tools.length > 0) {
      logger.highlight(`  🛠️  Tools (${state.tools.length})`);
      console.log('');
      for (const tool of state.tools) {
        console.log(`  ${tool.name}`);
        if (tool.description) {
          console.log(`    ${tool.description}`);
        }
        if (tool.inputSchema) {
          const props = (tool.inputSchema as any).properties;
          if (props) {
            const paramNames = Object.keys(props).join(', ');
            console.log(`    Params: ${paramNames}`);
          }
        }
        console.log('');
      }
    }

    if (state.resources.length > 0) {
      logger.highlight(`  📄 Resources (${state.resources.length})`);
      console.log('');
      for (const resource of state.resources) {
        console.log(`  ${resource.uri}`);
        console.log(`    ${resource.name}`);
        console.log('');
      }
    }
  }

  private async refreshServers(): Promise<void> {
    const manager = getMCPManager();

    logger.info('Refreshing MCP server connections...');

    // Disconnect all
    manager.disconnectAll();

    // Re-discover and connect
    const connected = await manager.connectAll();

    if (connected.length === 0) {
      logger.info('No MCP servers found to connect.');
      console.log('');
      return;
    }

    logger.success(`Refreshed: ${connected.length} MCP server(s) connected`);
    for (const client of connected) {
      const toolCount = client.tools.length;
      console.log(`  🟢 ${client.name} — ${toolCount} tools`);
    }
    console.log('');
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  private renderToolResult(result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }): void {
    if (result.isError) {
      logger.error('Tool returned an error:');
    } else {
      logger.success('Tool executed successfully:');
    }
    console.log('');

    for (const content of result.content) {
      if (content.type === 'text' && content.text) {
        // Limit output to avoid flooding the terminal
        const maxLength = 2000;
        const text = content.text.length > maxLength
          ? content.text.slice(0, maxLength) + `\n... [truncated, ${content.text.length} total chars]`
          : content.text;
        console.log(text);
        console.log('');
      } else if (content.type === 'image') {
        console.log(`  [Image: ${content.mimeType || 'unknown type'}, ${(content.data?.length || 0)} bytes]`);
        console.log('');
      }
    }
  }
}
