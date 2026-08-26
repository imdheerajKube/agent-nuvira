---
name: mcp-connector
description: Bridge APIs to MCP: wrap existing REST/GraphQL APIs as MCP servers with auto-generated tool schemas. Use when you need to expose an existing API to AI agents without rewriting it.
version: 1.0.0
---

# mcp-connector

Bridge APIs to MCP: wrap existing REST/GraphQL APIs as MCP servers with auto-generated tool schemas. Use when you need to expose an existing API to AI agents without rewriting it.

## Goal pattern

MCP connector bridge REST API GraphQL auto-generate tools schema wrapper

## Steps

0. [context-gatherer] Map the API: what endpoints? What authentication? What request/response formats? What rate limits?

1. [planner] Design the connector:
1. Schema generation: parse OpenAPI/GraphQL schema → MCP tool definitions
2. Tool mapping: API endpoint → MCP tool with matching input/output
3. Authentication: proxy API keys or OAuth tokens
4. Error mapping: API errors → MCP error responses
5. Rate limiting: respect API limits
6. Caching: cache tool schemas, optionally cache responses (after: 'step-0')

2. [runner] Implement the connector:
1. Parse API schema (OpenAPI or GraphQL)
2. Generate MCP tool definitions
3. Create tool handlers that call the API
4. Add authentication proxy
5. Map error responses
6. Test end-to-end (after: 'step-1')

3. [reviewer] Verify: generate tools from schema, call each tool, verify API responses, test error handling, check auth flow. (after: 'step-2')
