---
name: discord-bot
description: Build a Discord bot with slash commands, embeds, buttons, modals, and event handlers. Covers bot setup, permission configuration, deployment, and hosting. Use when the goal is to create a bot for a Discord server.
version: 1.0.0
---

# discord-bot

Build a Discord bot with slash commands, embeds, buttons, modals, and event handlers. Covers bot setup, permission configuration, deployment, and hosting. Use when the goal is to create a bot for a Discord server.

## Goal pattern

discord bot slash command embed button modal event handler discord.js

## Parameters

(none)

## Steps

1. [context-gatherer] Map the bot: what commands does it need? What events to listen for? What permissions? What hosting (self-hosted, cloud)? What language (discord.js, discord.py)?

2. [planner] Design the bot:
1. Command registration: slash commands with options and autocomplete
2. Event handling: message, reaction, member join/leave, voice state
3. Embeds: rich message formatting with colors, fields, images
4. Components: buttons, select menus, modals for interactive flows
5. Permissions: role-based command access, channel restrictions
6. Error handling: graceful failures, user-facing error messages
7. Hosting: PM2, Docker, or serverless (AWS Lambda with discord-interactions) (after: step-0)

3. [runner] Implement the bot:
1. Set up Discord.js project with TypeScript
2. Create command handler with auto-registration
3. Implement event listeners
4. Build commands with embeds and components
5. Add permission checks
6. Deploy and test in a test server (after: step-1)

4. [reviewer] Test: register commands, test each slash command, verify embeds render correctly, test button interactions, test permission restrictions, verify error handling. (after: step-2)
