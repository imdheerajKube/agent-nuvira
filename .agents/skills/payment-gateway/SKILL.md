---
name: payment-gateway
description: Integrate payment processing: Stripe, PayPal, or Square. Covers checkout flows, subscriptions, refunds, webhooks, and PCI compliance. Use when the goal is to accept payments in an application.
version: 1.0.0
---

# payment-gateway

Integrate payment processing: Stripe, PayPal, or Square. Covers checkout flows, subscriptions, refunds, webhooks, and PCI compliance. Use when the goal is to accept payments in an application.

## Goal pattern

payment gateway stripe paypal square checkout subscription refund webhook PCI compliance

## Steps

0. [context-gatherer] Map the payment flow: one-time or recurring? Currency? Countries supported? What provider (Stripe, PayPal, Square)? What checkout experience (hosted, embedded, custom)?

1. [planner] Design the payment system:
1. Checkout: Stripe Checkout, Payment Intents, or Elements
2. Subscriptions: pricing plans, trial periods, metered billing
3. Webhooks: handle payment events (succeeded, failed, refunded)
4. Refunds: full and partial refund handling
5. PCI: use Stripe Elements (no card data touches your server)
6. Testing: test mode with Stripe test cards (after: 'step-0')

2. [runner] Implement payment processing:
1. Set up Stripe/PayPal SDK
2. Create checkout session
3. Handle success/cancel redirects
4. Implement webhook handler
5. Add subscription management
6. Test with test cards (after: 'step-1')

3. [reviewer] Verify: test checkout flow, verify webhook events, test refund, check subscription lifecycle, verify in provider dashboard. (after: 'step-2')
