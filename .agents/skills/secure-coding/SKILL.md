---
name: secure-coding
description: Secure coding practices: input validation, output encoding, authentication, authorization, and cryptographic operations. Use when implementing security controls.
version: 1.0.0
---

# secure-coding

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
