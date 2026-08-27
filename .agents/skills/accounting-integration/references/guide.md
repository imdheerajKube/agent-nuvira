# Accounting Integration Reference Guide

## Overview
Integrate accounting software: QuickBooks, Xero, or FreshBooks API integration for invoices, expenses, and financial reporting. Use when the goal is to sync financial data with an accounting system.

## # accounting-integration

Integrate accounting software: QuickBooks, Xero, or FreshBooks API integration for invoices, expenses, and financial reporting. Use when the goal is to sync financial data with an accounting system.

## Goal pattern

accounting quickbooks xero freshbooks invoice expense financial reporting integration API

## Steps

0. [context-gatherer] Map the integration: what accounting platform? What data to sync (invoices, expenses, customers, products)? Sync direction (bidirectional, push, pull)? Frequency?

1. [planner] Design the integration:
1. Auth: OAuth2 flow for API access
2. Data mapping: your models → accounting platform models
3. Sync: create/update invoices, expenses, contacts
4. Webhooks: receive updates from accounting platform
5. Error handling: retry, conflict resolution
6. Reporting: pull financial data for dashboards (after: 'step-0')

2. [runner] Implement the integration:
1. Set up OAuth2 authentication
2. Create API client for the accounting platform
3. Implement data sync functions
4. Add webhook handlers
5. Build conflict resolution logic
6. Test with sandbox account (after: 'step-1')

3. [reviewer] Verify: create invoice via API, verify it appears in accounting platform, test expense sync, verify financial reports pull correctly. (after: 'step-2')

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
