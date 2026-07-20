# MCP (Model Context Protocol) Server Examples

Example configuration files for MCP servers. Drop these into `~/.buff/mcp/`
to make them available to `buff mcp` commands and the Orchestrator.

## Usage

```bash
# Connect to all configured MCP servers
buff mcp connect --all

# List servers and their tools
buff mcp list

# Call a tool
buff mcp call read_file --args '{"path":"path/to/file.txt"}'

# View server details
buff mcp info filesystem
```

## Available Examples

| File | Server Type | Description |
|------|-------------|-------------|
| `filesystem.json` | Filesystem | Read/write files and directories on the local machine |

## Creating Your Own Config

Create a JSON file in `~/.buff/mcp/` with the following structure:

```json
{
  "name": "my-server",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-mytool", "."],
  "enabled": true
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique name for this server connection |
| `transport` | `"stdio"` \| `"sse"` | Transport protocol (stdio for local, sse for remote) |
| `command` | string | For stdio: the command to run |
| `args` | string[] | For stdio: command arguments |
| `url` | string | For sse: the SSE endpoint URL |
| `env` | object | Optional environment variables for the subprocess |
| `enabled` | boolean | Set to `false` to temporarily disable |

## Official MCP Servers

Browse available MCP servers at [modelcontextprotocol.io/servers](https://modelcontextprotocol.io/servers).
