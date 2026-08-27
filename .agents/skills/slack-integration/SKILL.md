---
name: slack-integration
description: Build Slack integrations: bots, app actions, slash commands, modals, and workflow builder steps. Covers Slack Bolt framework, OAuth, and deployment. Use when creating a Slack app or bot.
version: 1.0.0
---

# slack-integration

Build Slack integrations: bots, app actions, slash commands, modals, and workflow builder steps. Covers Slack Bolt framework, OAuth, and deployment. Use when creating a Slack app or bot.

## Goal pattern

slack app bot integration slash command modal workflow bolt framework

## Parameters

(none)

## Steps

1. [context-gatherer] Map the integration: what triggers (slash command, event, action)? What responses (message, modal, workflow step)? What OAuth scopes needed? What hosting?

2. [planner] Design the Slack app:
1. App manifest: define commands, events, OAuth scopes
2. Event handling: message, reaction, app_mention
3. Interactivity: slash commands, buttons, modals, shortcuts
4. Workflow steps: custom steps for Workflow Builder
5. OAuth: install flow, token management
6. Error handling: graceful degradation, retry logic (after: step-0)

3. [runner] Implement with Bolt.js:
1. Set up Bolt project with TypeScript
2. Define app manifest
3. Implement command handlers
4. Add event listeners
5. Build interactive components
6. Deploy with Socket Mode or HTTP receiver (after: step-1)

4. [reviewer] Test: install app in test workspace, test each command, verify events fire, test modal submissions, verify OAuth flow. (after: step-2)
