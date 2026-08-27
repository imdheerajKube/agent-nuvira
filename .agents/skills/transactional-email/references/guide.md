# Transactional Email Reference Guide

## Overview
Set up transactional email sending: SMTP configuration, email templates, delivery tracking, bounce handling, and provider integration (SendGrid, Postmark, SES). Use when the goal is to send system emails (password resets, notifications, receipts).

## # transactional-email

Set up transactional email sending: SMTP configuration, email templates, delivery tracking, bounce handling, and provider integration (SendGrid, Postmark, SES). Use when the goal is to send system emails (password resets, notifications, receipts).

## Goal pattern

transactional email SMTP SendGrid Postmark SES template delivery tracking bounce password reset notification

## Steps

0. [context-gatherer] Map the email needs: what types of emails (welcome, reset, receipt, notification)? What provider? What domain for sending? What templates needed?

1. [planner] Design the email system:
1. Provider setup: domain verification, SPF/DKIM/DMARC records
2. SMTP/API integration: SendGrid API, Postmark API, or SES
3. Templates: HTML + plain text, responsive design, variable interpolation
4. Delivery: queue-based sending, retry logic, rate limiting
5. Tracking: delivery, open, click events
6. Bounce/complaint handling: webhook endpoints, list management (after: 'step-0')

2. [runner] Implement email sending:
1. Set up provider API client
2. Create email templates
3. Implement sending function with retry
4. Add tracking webhooks
5. Handle bounces and complaints
6. Test with seed list (after: 'step-1')

3. [reviewer] Verify: send test emails, check delivery, verify tracking, test bounce handling, check spam score. (after: 'step-2')

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
