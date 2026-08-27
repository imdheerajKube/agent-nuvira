# Cors Setup Reference Guide

## Overview
Configure CORS: cross-origin resource sharing for APIs, web apps, and embedded content. Use when the goal asks to fix CORS errors, configure cross-origin access, or set up CORS headers.

## # cors-setup

Configure CORS: cross-origin resource sharing for APIs, web apps, and embedded content. Use when the goal asks to fix CORS errors, configure cross-origin access, or set up CORS headers.

## Goal pattern

cors cross-origin access origin header preflight error fix configuration

## Parameters

- framework (choice [default: auto]): Framework

## Steps

1. [analyst] Audit current CORS setup: check which origins are allowed, what headers are exposed, and identify any CORS errors in the browser.

2. [analyst] Define the CORS policy: allowed origins, methods, headers, credentials, max-age, and preflight behavior. (after: step-0)

3. [analyst] Implement CORS middleware: use the cors package or custom middleware. Handle preflight OPTIONS requests. (after: step-1)

4. [analyst] Test cross-origin requests: verify preflight works, credentials are sent, and headers are exposed correctly. (after: step-2)

5. [analyst] Harden: restrict origins in production, add Vary: Origin header, and document the CORS policy. (after: step-3)

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
