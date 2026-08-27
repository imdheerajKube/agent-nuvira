---
name: newsletter
description: Build a newsletter system: subscriber management, email composition, scheduling, analytics, and compliance (CAN-SPAM, GDPR). Use when the goal is to create and manage an email newsletter.
version: 1.0.0
---

# newsletter

Build a newsletter system: subscriber management, email composition, scheduling, analytics, and compliance (CAN-SPAM, GDPR). Use when the goal is to create and manage an email newsletter.

## Goal pattern

newsletter email subscriber management scheduling analytics CAN-SPAM GDPR compose template

## Parameters

(none)

## Steps

1. [context-gatherer] Map the newsletter: subscriber list size? Sending frequency? Content type (text, HTML, mixed)? Growth mechanism (signup form)? Compliance requirements?

2. [planner] Design the newsletter system:
1. Subscriber management: signup, unsubscribe, preferences, list segments
2. Composition: rich text editor or HTML templates
3. Scheduling: queue-based sending with time zone support
4. Analytics: open rates, click rates, unsubscribes
5. Compliance: CAN-SPAM (unsubscribe link, physical address), GDPR (consent, data export)
6. Growth: signup forms, referral programs (after: step-0)

3. [runner] Implement the newsletter:
1. Build subscriber management (add, remove, segment)
2. Create email template system
3. Implement sending queue
4. Add tracking pixels and click tracking
5. Build unsubscribe flow
6. Create signup form (after: step-1)

4. [reviewer] Verify: subscribe, send test newsletter, check delivery, verify unsubscribe, check analytics, test compliance (CAN-SPAM, GDPR). (after: step-2)
