# Auth Setup Reference Guide

## Overview
Implement authentication and authorization: OAuth2 (Google, GitHub), magic links, JWT sessions, role-based access control. Use when the goal asks to add login, signup, auth, SSO, or RBAC to an app.

## # auth-setup

Implement authentication and authorization: OAuth2 (Google, GitHub), magic links, JWT sessions, role-based access control. Use when the goal asks to add login, signup, auth, SSO, or RBAC to an app.

## Goal pattern

auth login signup oauth sso jwt session rbac role access control authentication authorization magic link google github

## Parameters

- strategy (choice [default: auto]): Auth strategy

## Steps

1. [analyst] Choose auth strategy: OAuth2 providers, magic links, social login, or self-hosted. Install the auth library (NextAuth, Lucia, Passport, etc.).

2. [analyst] Configure providers: register OAuth apps with Google/GitHub/etc., set callback URLs, configure scopes, and store credentials securely. (after: step-1)

3. [analyst] Implement user flows: signup, login, logout, password reset, email verification. Handle session creation and JWT token refresh. (after: step-2)

4. [analyst] Add RBAC: define roles (admin, editor, viewer), protect routes with middleware, and handle permission checks in the UI. (after: step-3)

5. [analyst] Test and harden: verify CSRF protection, rate-limit login attempts, test role escalation scenarios, and audit token expiration. (after: step-4)

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
