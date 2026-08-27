# Slack Integration Reference Guide

## Overview
Build Slack integrations: bots, app actions, slash commands, modals, and workflow builder steps. Covers Slack Bolt framework, OAuth, and deployment. Use when creating a Slack app or bot.

## # slack-integration

Build Slack integrations: bots, app actions, slash commands, modals, and workflow builder steps. Covers Slack Bolt framework, OAuth, and deployment. Use when creating a Slack app or bot.

## Goal pattern

slack app bot integration slash command modal workflow bolt framework

## Steps

0. [context-gatherer] Map the integration: what triggers (slash command, event, action)? What responses (message, modal, workflow step)? What OAuth scopes needed? What hosting?

1. [planner] Design the Slack app:
1. App manifest: define commands, events, OAuth scopes
2. Event handling: message, reaction, app_mention
3. Interactivity: slash commands, buttons, modals, shortcuts
4. Workflow steps: custom steps for Workflow Builder
5. OAuth: install flow, token management
6. Error handling: graceful degradation, retry logic (after: 'step-0')

2. [runner] Implement with Bolt.js:
1. Set up Bolt project with TypeScript
2. Define app manifest
3. Implement command handlers
4. Add event listeners
5. Build interactive components
6. Deploy with Socket Mode or HTTP receiver (after: 'step-1')

3. [reviewer] Test: install app in test workspace, test each command, verify events fire, test modal submissions, verify OAuth flow. (after: 'step-2')

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
