# Payment Setup Reference Guide

## Overview
Integrate payment processing with Stripe: implement checkout, subscriptions, webhooks, and invoice handling. Use when the goal asks to add payments, billing, subscriptions, or checkout to an app.

## # payment-setup

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
