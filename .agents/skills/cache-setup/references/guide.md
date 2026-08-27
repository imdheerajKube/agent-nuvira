# Cache Setup Reference Guide

## Overview
Set up caching: Redis, Memcached, or in-memory caching for API responses, sessions, and expensive computations. Use when the goal asks to add caching, improve response times, or reduce database load.

## # cache-setup

Set up caching: Redis, Memcached, or in-memory caching for API responses, sessions, and expensive computations. Use when the goal asks to add caching, improve response times, or reduce database load.

## Goal pattern

cache redis memcached caching performance speed up response time

## Parameters

- backend (choice [default: auto]): Cache backend

## Steps

1. [analyst] Identify cache targets: expensive queries, API responses, session data, and computed results. Choose the cache backend.

2. [analyst] Set up the cache client: install Redis/Memcached driver, configure connection, add health checks. (after: step-0)

3. [analyst] Implement caching patterns: cache-aside, write-through, or write-behind. Define TTLs and invalidation strategies. (after: step-1)

4. [analyst] Add cache warming: pre-populate hot keys on startup. Add cache stampede protection (locks/lease). (after: step-2)

5. [analyst] Monitor and tune: add hit/miss metrics, measure latency improvement, and tune TTLs based on access patterns. (after: step-3)

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
