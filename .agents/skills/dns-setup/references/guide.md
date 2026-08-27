# Dns Setup Reference Guide

## Overview
Configure DNS records and domains. Use when the goal asks to set up DNS, configure domains, or manage DNS records.

## # dns-setup

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
