# Websocket Setup Reference Guide

## Overview
Set up WebSocket connections: real-time chat, notifications, live updates, and collaboration features. Use when the goal asks to add real-time features, WebSocket connections, or live data.

## # websocket-setup

Set up WebSocket connections: real-time chat, notifications, live updates, and collaboration features. Use when the goal asks to add real-time features, WebSocket connections, or live data.

## Goal pattern

websocket realtime live chat notification collaboration socket real-time update

## Parameters

- library (choice [default: auto]): WebSocket library

## Steps

1. [analyst] Choose the WebSocket library: ws, Socket.IO, or native WebSocket. Consider scaling needs (sticky sessions, Redis adapter).

2. [analyst] Implement the server: create WebSocket server with connection handling, rooms/channels, and message routing. (after: step-0)

3. [analyst] Implement the client: connect, handle reconnection, send/receive messages, and manage connection state. (after: step-1)

4. [analyst] Add authentication: verify tokens on connection, implement per-room permissions, and handle disconnections. (after: step-2)

5. [analyst] Scale and monitor: add Redis adapter for multi-instance, track connections, and monitor message throughput. (after: step-3)

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
