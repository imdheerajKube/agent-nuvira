---
name: email-setup
description: Set up transactional email: design responsive HTML templates, configure SMTP/API delivery (SendGrid, Resend, Mailgun, Postmark), and build email sending functions. Use when the goal asks to send emails, build email templates, or configure email delivery.
version: 1.0.0
---

# email-setup

Set up transactional email: design responsive HTML templates, configure SMTP/API delivery (SendGrid, Resend, Mailgun, Postmark), and build email sending functions. Use when the goal asks to send emails, build email templates, or configure email delivery.

## Goal pattern

email send template smtp resend sendgrid mailgun postmark newsletter transactional email

## Parameters

- provider (choice [default: auto]): Email provider

## Steps

1. [analyst] Choose the email provider and create an account. Install the SDK (e.g. resend, @sendgrid/mail). Set up env vars for API keys.

2. [analyst] Design HTML email templates: create responsive templates for transactional emails (welcome, password reset, notifications). Use tables for email client compatibility. (after: step-1)

3. [analyst] Build the send function: wrap the provider SDK with a typed send() function that handles from/to/subject/template/variables. Add retry logic for transient failures. (after: step-2)

4. [analyst] Test end-to-end: send a test email, verify delivery, check spam score, and validate that links and tracking work. Test with multiple email clients. (after: step-3)

5. [analyst] Add webhook handlers for delivery events (delivered, opened, clicked, bounced). Log events for analytics and monitoring. (after: step-4)
