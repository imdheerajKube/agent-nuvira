---
name: rate-limit
description: Implement rate limiting: per-IP, per-user, or per-API-key limits with sliding window, token bucket, or fixed window algorithms. Use when the goal asks to add rate limiting, throttle requests, or prevent abuse.
version: 1.0.0
---

# rate-limit

Implement rate limiting: per-IP, per-user, or per-API-key limits with sliding window, token bucket, or fixed window algorithms. Use when the goal asks to add rate limiting, throttle requests, or prevent abuse.

## Goal pattern

rate limit throttle abuse prevention api protection sliding window token bucket

## Parameters

- algorithm (choice [default: auto]): Algorithm

## Steps

1. [analyst] Define rate limit policies: limits per endpoint, per user/IP, window size, and response headers (X-RateLimit-*).

2. [analyst] Choose the algorithm: sliding window (Redis), token bucket, or fixed window. Pick the storage backend. (after: step-0)

3. [analyst] Implement middleware: Express/Fastify middleware that checks limits, increments counters, and returns 429 with Retry-After. (after: step-1)

4. [analyst] Add bypass rules: whitelist admin IPs, exempt health checks, and support dynamic limits per tier. (after: step-2)

5. [analyst] Test: verify limits trigger correctly, check 429 responses, measure overhead, and test distributed scenarios. (after: step-3)
