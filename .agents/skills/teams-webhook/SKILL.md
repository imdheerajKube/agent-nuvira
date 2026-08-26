---
name: teams-webhook
description: Build Microsoft Teams integrations: incoming webhooks, outgoing webhooks, bot framework, adaptive cards, and message extensions. Use when connecting a service to Teams.
version: 1.0.0
---

# teams-webhook

Build Microsoft Teams integrations: incoming webhooks, outgoing webhooks, bot framework, adaptive cards, and message extensions. Use when connecting a service to Teams.

## Goal pattern

microsoft teams webhook bot adaptive cards message extensions bot framework integration

## Steps

0. [context-gatherer] Map the integration: incoming or outgoing webhook? Bot Framework adaptive cards? Message extensions? What triggers? What responses?

1. [planner] Design the Teams integration:
1. Incoming webhook: simple notification posting with adaptive cards
2. Bot Framework: conversational bot with message handling
3. Adaptive cards: rich message formatting
4. Message extensions: search and action commands
5. Authentication: Azure AD app registration
6. Deployment: Azure Functions or App Service (after: 'step-0')

2. [runner] Implement the integration:
1. Set up Azure AD app registration
2. Configure webhook or bot endpoint
3. Build adaptive card templates
4. Implement message handling logic
5. Add authentication and token management
6. Deploy to Azure (after: 'step-1')

3. [reviewer] Test: send test webhook, verify card rendering, test bot conversation, verify message extension, check authentication flow. (after: 'step-2')
