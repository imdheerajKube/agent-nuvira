---
name: secrets-manager
description: Set up secrets management with Vault, AWS Secrets Manager, or similar. Use when the goal asks to manage secrets, rotate credentials, or secure sensitive data.
version: 1.0.0
---

# secrets-manager

Set up secrets management with Vault, AWS Secrets Manager, or similar. Use when the goal asks to manage secrets, rotate credentials, or secure sensitive data.

## Goal pattern

secrets manager vault credentials rotate sensitive password key

## Parameters

- provider (choice [default: vault]): Secrets manager

## Steps

1. [analyst] Choose secrets manager (HashiCorp Vault, AWS Secrets Manager, Azure Key Vault).

2. [analyst] Define secret structure, access policies, and rotation schedules. (after: step-0)

3. [analyst] Implement secret injection into applications (env vars, mounted files, API calls). (after: step-1)

4. [analyst] Set up audit logging, access reviews, and emergency revocation procedures. (after: step-2)
