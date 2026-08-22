---
name: ssl-cert
description: Manage SSL/TLS certificates with Let Encrypt or commercial CAs. Use when the goal asks to set up HTTPS, renew certificates, or fix SSL issues.
version: 1.0.0
---

# ssl-cert

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
