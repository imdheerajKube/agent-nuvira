# Ssl Cert Reference Guide

## Overview
Manage SSL/TLS certificates with Let Encrypt or commercial CAs. Use when the goal asks to set up HTTPS, renew certificates, or fix SSL issues.

## # ssl-cert

Manage SSL/TLS certificates with Let Encrypt or commercial CAs. Use when the goal asks to set up HTTPS, renew certificates, or fix SSL issues.

## Goal pattern

ssl tls certificate letsencrypt https renew acme

## Parameters

- provider (choice [default: letsencrypt]): Certificate provider

## Steps

1. [analyst] Choose certificate provider (Let Encrypt, commercial CA). Generate CSR and private key.

2. [analyst] Complete domain validation (HTTP-01, DNS-01 challenge). Install certificate. (after: step-0)

3. [analyst] Configure auto-renewal with certbot or acme.sh. Set up renewal hooks. (after: step-1)

4. [analyst] Test SSL configuration with SSL Labs. Fix any vulnerabilities. (after: step-2)

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
