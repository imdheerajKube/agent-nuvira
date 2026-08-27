# Error Tracking Reference Guide

## Overview
Set up error tracking: Sentry, Bugsnag, or Rollbar for frontend and backend error monitoring. Use when the goal asks to add error tracking, exception monitoring, or crash reporting.

## # error-tracking

Set up error tracking: Sentry, Bugsnag, or Rollbar for frontend and backend error monitoring. Use when the goal asks to add error tracking, exception monitoring, or crash reporting.

## Goal pattern

error tracking sentry bugsnag rollbar crash monitoring exception reporting

## Parameters

- service (choice [default: auto]): Error tracking service

## Steps

1. [analyst] Choose the error tracking service: Sentry (most popular), Bugsnag, or Rollbar. Create an account and get the DSN.

2. [analyst] Install and configure the SDK: add to both frontend and backend. Configure source maps, release tracking, and environment. (after: step-0)

3. [analyst] Add context: user info, breadcrumbs, tags, and extra data. Set up error grouping rules. (after: step-1)

4. [analyst] Configure alerts: email/Slack alerts for new errors, regression detection, and volume spikes. (after: step-2)

5. [analyst] Test: throw test errors in dev, verify they appear in the dashboard, and check source maps work. (after: step-3)

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
