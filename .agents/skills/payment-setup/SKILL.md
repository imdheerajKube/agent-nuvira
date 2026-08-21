---
name: payment-setup
description: Integrate payment processing with Stripe: implement checkout, subscriptions, webhooks, and invoice handling. Use when the goal asks to add payments, billing, subscriptions, or checkout to an app.
version: 1.0.0
---

# payment-setup

Integrate payment processing with Stripe: implement checkout, subscriptions, webhooks, and invoice handling. Use when the goal asks to add payments, billing, subscriptions, or checkout to an app.

## Goal pattern

payment stripe checkout subscription billing invoice payment processing recurring charge

## Parameters

- mode (choice [default: full]): Integration mode

## Steps

1. [analyst] Set up Stripe: create an account, install the SDK, configure API keys (test + live), and define products/prices in the Stripe dashboard.

2. [analyst] Implement checkout: create a checkout session endpoint, handle success/cancel redirects, and store the session ID for reconciliation. (after: step-1)

3. [analyst] Handle webhooks: register endpoint for checkout.session.completed, invoice.paid, subscription.deleted events. Verify webhook signatures for security. (after: step-2)

4. [analyst] Implement subscriptions: create pricing tables, handle plan changes (upgrade/downgrade), proration, and cancellation flows. (after: step-3)

5. [analyst] Test end-to-end: use Stripe test cards, verify webhook delivery, test failure scenarios (declined cards, failed payments), and validate receipt emails. (after: step-4)
