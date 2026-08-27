# Redis Cache Reference Guide

## Overview
Set up Redis caching layer. Use when the goal asks to add caching, session storage, or rate limiting with Redis.

## # redis-cache

Set up Redis caching layer. Use when the goal asks to add caching, session storage, or rate limiting with Redis.

## Goal pattern

redis cache session store rate limit pub sub queue

## Parameters

- strategy (choice [default: cache-aside]): Caching strategy

## Steps

1. [analyst] Choose caching strategy: cache-aside, write-through, write-behind. Define cache keys and TTLs.

2. [analyst] Implement Redis connection with pooling, retry logic, and cluster support. (after: step-0)

3. [analyst] Add cache invalidation: TTL-based, event-based, manual invalidation. (after: step-1)

4. [analyst] Monitor cache hit rate, memory usage, and evictions. Add warming strategies. (after: step-2)

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
