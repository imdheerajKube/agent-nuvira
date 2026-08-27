# Payment Gateway Reference Guide

## Overview
Integrate payment processing: Stripe, PayPal, or Square. Covers checkout flows, subscriptions, refunds, webhooks, and PCI compliance. Use when the goal is to accept payments in an application.

## # payment-gateway

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
