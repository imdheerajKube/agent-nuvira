# Cdn Setup Reference Guide

## Overview
Configure CDN for static assets. Use when the goal asks to set up CDN, optimize asset delivery, or reduce latency.

## # cdn-setup

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
