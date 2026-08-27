# Load Balancer Reference Guide

## Overview
Configure load balancing with Nginx, HAProxy, or cloud LBs. Use when the goal asks to distribute traffic, set up health checks, or configure failover.

## # load-balancer

Configure load balancing with Nginx, HAProxy, or cloud LBs. Use when the goal asks to distribute traffic, set up health checks, or configure failover.

## Goal pattern

load balancer nginx haproxy traffic distribute health check failover

## Parameters

- provider (choice [default: nginx]): Load balancer type

## Steps

1. [analyst] Choose load balancer (Nginx, HAProxy, ALB/NLB). Define backend pools and routing rules.

2. [analyst] Configure health checks, session affinity, and connection draining. (after: step-0)

3. [analyst] Add SSL termination, rate limiting, and DDoS protection. (after: step-1)

4. [analyst] Monitor traffic distribution, latency, and error rates. Set up alerts. (after: step-2)

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
