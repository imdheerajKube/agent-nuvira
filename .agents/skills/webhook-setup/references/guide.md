# Webhook Setup Reference Guide

## Overview
Set up webhooks: receive and verify incoming webhooks from third-party services (Stripe, GitHub, Twilio). Use when the goal asks to handle webhooks, verify webhook signatures, or process webhook events.

## # webhook-setup

Set up webhooks: receive and verify incoming webhooks from third-party services (Stripe, GitHub, Twilio). Use when the goal asks to handle webhooks, verify webhook signatures, or process webhook events.

## Goal pattern

webhook receive verify signature stripe github twilio event callback

## Parameters

- provider (choice [default: auto]): Webhook source

## Steps

1. [analyst] Identify webhook sources: list the third-party services sending webhooks and their event types.

2. [analyst] Implement the endpoint: create a POST handler that receives raw body, verifies the signature, and parses the event. (after: step-0)

3. [analyst] Add signature verification: implement HMAC-SHA256 verification for each provider. Handle timestamp tolerance. (after: step-1)

4. [analyst] Process events: route events to handlers, implement idempotency (dedup by event ID), and acknowledge quickly. (after: step-2)

5. [analyst] Add resilience: retry logic for failed processing, dead-letter queue for poison events, and monitoring. (after: step-3)

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
