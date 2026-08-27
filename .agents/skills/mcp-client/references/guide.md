# Mcp Client Reference Guide

## Overview
Build an MCP client: connect to MCP servers, discover tools/resources, and execute operations. Covers server management, tool calling, and resource reading. Use when your agent needs to consume MCP servers.

## # mcp-client

Build an MCP client: connect to MCP servers, discover tools/resources, and execute operations. Covers server management, tool calling, and resource reading. Use when your agent needs to consume MCP servers.

## Goal pattern

MCP client connect server discover tools resources execute operations agent integration

## Steps

0. [context-gatherer] Map the client needs: what servers to connect to? What transport (stdio, HTTP)? What tools to use? What resources to read? Error handling requirements?

1. [planner] Design the MCP client:
1. Server management: connect, disconnect, reconnect
2. Tool discovery: list available tools with schemas
3. Tool calling: invoke tools with arguments, handle results
4. Resource reading: list and read resources
5. Error handling: timeouts, connection failures, tool errors
6. Caching: cache tool schemas, resource contents (after: 'step-0')

2. [runner] Implement the MCP client:
1. Set up MCP SDK client
2. Implement server connection management
3. Add tool discovery and calling
4. Implement resource reading
5. Add error handling and retries
6. Test with sample servers (after: 'step-1')

3. [reviewer] Verify: connect to test server, discover tools, call tools with various inputs, read resources, test error scenarios. (after: 'step-2')

## Best Practices

- Follow the skill's methodology step by step
- Verify each step before proceeding to the next
- Use the appropriate tools for each task
- Document any deviations from the standard approach

## Common Patterns

- Start with context gathering to understand the current state
- Plan the implementation before writing code
- Test changes before committing
- Review for security and performance implications

## Troubleshooting

- If the skill fails, check the prerequisites first
- Verify environment variables are set correctly
- Check for conflicting configurations
- Review logs for detailed error messages

## Further Reading

- Refer to the main SKILL.md for complete methodology
- Check official documentation for the specific technology
- Review related skills in the registry for complementary approaches
