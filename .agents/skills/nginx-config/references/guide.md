# Nginx Config Reference Guide

## Overview
Configure Nginx as reverse proxy, load balancer, or web server. Use when the goal asks to set up Nginx, configure SSL, or optimize web serving.

## # nginx-config

Configure Nginx as reverse proxy, load balancer, or web server. Use when the goal asks to set up Nginx, configure SSL, or optimize web serving.

## Goal pattern

nginx reverse proxy load balancer web server ssl tls

## Parameters

- role (choice [default: reverse-proxy]): Nginx role

## Steps

1. [analyst] Define server blocks, upstream pools, and location routing rules.

2. [analyst] Configure SSL/TLS with certificates, OCSP stapling, and HSTS. (after: step-0)

3. [analyst] Add rate limiting, request buffering, and gzip compression. (after: step-1)

4. [analyst] Set up health checks, graceful shutdown, and log rotation. (after: step-2)

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
