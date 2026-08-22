---
name: webhook-setup
description: Set up webhooks: receive and verify incoming webhooks from third-party services (Stripe, GitHub, Twilio). Use when the goal asks to handle webhooks, verify webhook signatures, or process webhook events.
version: 1.0.0
---

# webhook-setup

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
