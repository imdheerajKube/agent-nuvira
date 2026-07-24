# MCP (Model Context Protocol) Server Examples

Example configuration files for MCP servers. Drop these into `~/.buff/mcp/`
to make them available to `buff mcp` commands and the Orchestrator.

## Usage

```bash
# Connect to all configured MCP servers
buff mcp connect --all

# List servers and their tools
buff mcp list

# Call a tool on a specific server
buff mcp call read_file --server filesystem --args '{"path":"path/to/file.txt"}'

# View server details
buff mcp info filesystem
```

## Available Examples

| File | Server Type | Transport | Description |
|------|-------------|-----------|-------------|
| `filesystem.json` | Filesystem | stdio | Read/write files and directories on the local machine |

## Creating Your Own Config

Create a JSON file in `~/.buff/mcp/` with the following structure.

### stdio Transport (Local Subprocess)

For servers that run as a local process:

```json
{
  "name": "my-server",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-mytool", "."],
  "env": {
    "API_KEY": "your-key-here"
  },
  "enabled": true
}
```

### sse Transport (Remote HTTP)

For remote MCP servers accessed via HTTP with Server-Sent Events:

```json
{
  "name": "my-remote-server",
  "transport": "sse",
  "url": "https://api.example.com/mcp",
  "headers": {
    "Authorization": "Bearer YOUR_API_KEY"
  },
  "enabled": true
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique name for this server connection |
| `transport` | `"stdio"` or `"sse"` | Yes | stdio for local processes, sse for remote HTTP |
| `command` | string | For stdio | The command to run (binary, npx, node, etc.) |
| `args` | string[] | For stdio | Command arguments |
| `url` | string | For sse | The SSE endpoint URL |
| `headers` | object | Optional | Custom HTTP headers (e.g., Authorization for SSE auth) |
| `env` | object | Optional | Environment variables for the stdio subprocess |
| `enabled` | boolean | Yes | Set to `false` to temporarily disable |

## Official MCP Servers

Browse available MCP servers at [modelcontextprotocol.io/servers](https://modelcontextprotocol.io/servers).
