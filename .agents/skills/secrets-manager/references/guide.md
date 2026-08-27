# Secrets Manager Reference Guide

## Overview
Set up secrets management with Vault, AWS Secrets Manager, or similar. Use when the goal asks to manage secrets, rotate credentials, or secure sensitive data.

## # secrets-manager

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
