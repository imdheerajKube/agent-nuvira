---
name: dns-setup
description: Configure DNS records and domains. Use when the goal asks to set up DNS, configure domains, or manage DNS records.
version: 1.0.0
---

# dns-setup

Configure DNS records and domains. Use when the goal asks to set up DNS, configure domains, or manage DNS records.

## Goal pattern

dns domain records aaaaaa cname mx txt spf dkim

## Parameters

- provider (choice [default: cloudflare]): DNS provider

## Steps

1. [analyst] Choose DNS provider (Cloudflare, Route53, Google DNS). Transfer or register domain.

2. [analyst] Configure A/AAAA, CNAME, MX, TXT records. Set up SPF, DKIM, DMARC for email. (after: step-0)

3. [analyst] Add CDN configuration, DNS caching, and geo-routing. (after: step-1)

4. [analyst] Monitor DNS propagation, uptime, and set up alerts for DNS failures. (after: step-2)
