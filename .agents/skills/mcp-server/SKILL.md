---
name: mcp-server
description: Build a Model Context Protocol (MCP) server: expose tools, resources, and prompts to AI agents via the MCP standard. Covers stdio and HTTP transports, tool definitions, resource URIs, and OAuth. Use when making your service available to AI agents.
version: 1.0.0
---

# mcp-server

Build a Model Context Protocol (MCP) server: expose tools, resources, and prompts to AI agents via the MCP standard. Covers stdio and HTTP transports, tool definitions, resource URIs, and OAuth. Use when making your service available to AI agents.

## Goal pattern

MCP model context protocol server tools resources prompts stdio HTTP transport

## Steps

0. [context-gatherer] Map the server: what tools to expose? What resources (files, database, API)? What prompts? What transport (stdio for local, HTTP for remote)? Authentication needed?

1. [planner] Design the MCP server:
1. Tools: define function schemas (name, description, input parameters)
2. Resources: expose data via resource URIs (file://, db://, api://)
3. Prompts: define reusable prompt templates
4. Transport: stdio (child process) or HTTP (SSE/streamable HTTP)
5. Authentication: API key or OAuth for remote servers
6. Error handling: structured error responses (after: 'step-0')

2. [runner] Implement the MCP server:
1. Set up MCP SDK (TypeScript or Python)
2. Define tool handlers with input validation
3. Create resource providers
4. Add prompt templates
5. Configure transport
6. Test with MCP inspector (after: 'step-1')

3. [reviewer] Verify: connect with MCP client, list tools, call tools, list resources, read resources, test error handling. (after: 'step-2')
