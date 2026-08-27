# Newsletter Reference Guide

## Overview
Build a newsletter system: subscriber management, email composition, scheduling, analytics, and compliance (CAN-SPAM, GDPR). Use when the goal is to create and manage an email newsletter.

## # newsletter

Build a newsletter system: subscriber management, email composition, scheduling, analytics, and compliance (CAN-SPAM, GDPR). Use when the goal is to create and manage an email newsletter.

## Goal pattern

newsletter email subscriber management scheduling analytics CAN-SPAM GDPR compose template

## Steps

0. [context-gatherer] Map the newsletter: subscriber list size? Sending frequency? Content type (text, HTML, mixed)? Growth mechanism (signup form)? Compliance requirements?

1. [planner] Design the newsletter system:
1. Subscriber management: signup, unsubscribe, preferences, list segments
2. Composition: rich text editor or HTML templates
3. Scheduling: queue-based sending with time zone support
4. Analytics: open rates, click rates, unsubscribes
5. Compliance: CAN-SPAM (unsubscribe link, physical address), GDPR (consent, data export)
6. Growth: signup forms, referral programs (after: 'step-0')

2. [runner] Implement the newsletter:
1. Build subscriber management (add, remove, segment)
2. Create email template system
3. Implement sending queue
4. Add tracking pixels and click tracking
5. Build unsubscribe flow
6. Create signup form (after: 'step-1')

3. [reviewer] Verify: subscribe, send test newsletter, check delivery, verify unsubscribe, check analytics, test compliance (CAN-SPAM, GDPR). (after: 'step-2')

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
