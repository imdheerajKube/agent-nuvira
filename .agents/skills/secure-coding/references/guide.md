# Secure Coding Reference Guide

## Overview
Secure coding practices: input validation, output encoding, authentication, authorization, and cryptographic operations. Use when implementing security controls.

## # secure-coding

Secure coding practices: input validation, output encoding, authentication, authorization, and cryptographic operations. Use when implementing security controls.

## Goal pattern

secure coding input validation output encoding authentication authorization cryptography

## Steps

0. [context-gatherer] Identify security requirements: what threats exist? What controls are needed? What compliance standards apply?

1. [planner] Design secure coding practices:
1. Input validation: whitelist, sanitize, validate
2. Output encoding: prevent injection
3. Authentication: MFA, password policies
4. Authorization: RBAC, least privilege
5. Cryptography: encryption, hashing, key management
6. Error handling: secure error messages (after: 'step-0')

2. [runner] Implement secure coding:
1. Add input validation
2. Implement output encoding
3. Configure authentication
4. Set up authorization
5. Implement cryptographic operations
6. Add secure error handling (after: 'step-1')

3. [reviewer] Verify: input is validated, output is encoded, authentication works, authorization is enforced. (after: 'step-2')

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
