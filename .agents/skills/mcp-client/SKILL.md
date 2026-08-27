---
name: mcp-client
description: Build an MCP client: connect to MCP servers, discover tools/resources, and execute operations. Covers server management, tool calling, and resource reading. Use when your agent needs to consume MCP servers.
version: 1.0.0
---

# mcp-client

Build an MCP client: connect to MCP servers, discover tools/resources, and execute operations. Covers server management, tool calling, and resource reading. Use when your agent needs to consume MCP servers.

## Goal pattern

MCP client connect server discover tools resources execute operations agent integration

## Parameters

(none)

## Steps

1. [context-gatherer] Map the client needs: what servers to connect to? What transport (stdio, HTTP)? What tools to use? What resources to read? Error handling requirements?

2. [planner] Design the MCP client:
1. Server management: connect, disconnect, reconnect
2. Tool discovery: list available tools with schemas
3. Tool calling: invoke tools with arguments, handle results
4. Resource reading: list and read resources
5. Error handling: timeouts, connection failures, tool errors
6. Caching: cache tool schemas, resource contents (after: step-0)

3. [runner] Implement the MCP client:
1. Set up MCP SDK client
2. Implement server connection management
3. Add tool discovery and calling
4. Implement resource reading
5. Add error handling and retries
6. Test with sample servers (after: step-1)

4. [reviewer] Verify: connect to test server, discover tools, call tools with various inputs, read resources, test error scenarios. (after: step-2)
