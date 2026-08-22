---
name: cdn-setup
description: Configure CDN for static assets. Use when the goal asks to set up CDN, optimize asset delivery, or reduce latency.
version: 1.0.0
---

# cdn-setup

Configure CDN for static assets. Use when the goal asks to set up CDN, optimize asset delivery, or reduce latency.

## Goal pattern

cdn cloudflare cloudfront fastly cache static assets edge

## Parameters

- provider (choice [default: cloudflare]): CDN provider

## Steps

1. [analyst] Choose CDN provider (Cloudflare, CloudFront, Fastly). Configure custom domain and SSL.

2. [analyst] Set up cache rules: TTLs, purge strategies, and cache-by-header. (after: step-0)

3. [analyst] Configure origin shielding, mid-tier caching, and failover origins. (after: step-1)

4. [analyst] Monitor cache hit ratio, bandwidth savings, and latency improvements. (after: step-2)
