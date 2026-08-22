---
name: redis-cache
description: Set up Redis caching layer. Use when the goal asks to add caching, session storage, or rate limiting with Redis.
version: 1.0.0
---

# redis-cache

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
