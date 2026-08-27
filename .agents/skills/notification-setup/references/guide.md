# Notification Setup Reference Guide

## Overview
Build a notification system: push notifications, in-app alerts, email digests, and preference management. Use when the goal asks to add notifications, alerts, or user notification preferences.

## # notification-setup

Build a notification system: push notifications, in-app alerts, email digests, and preference management. Use when the goal asks to add notifications, alerts, or user notification preferences.

## Goal pattern

notification push alert in-app email digest preference bell notification center

## Parameters

- channels (choice [default: all]): Notification channels

## Steps

1. [analyst] Define notification types: in-app, email, push, SMS. Map events to notification templates and delivery channels.

2. [analyst] Build the notification store: create the schema for notifications (user_id, type, title, body, read, created_at). (after: step-0)

3. [analyst] Implement delivery: send in-app notifications via API, queue email/SMS for async delivery, register push tokens. (after: step-1)

4. [analyst] Add preference management: let users toggle notification types, set quiet hours, and choose channels. (after: step-2)

5. [analyst] Build the UI: notification bell with unread count, notification center with filters, and mark-as-read. (after: step-3)

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
