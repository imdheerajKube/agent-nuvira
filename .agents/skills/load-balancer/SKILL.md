---
name: load-balancer
description: Configure load balancing with Nginx, HAProxy, or cloud LBs. Use when the goal asks to distribute traffic, set up health checks, or configure failover.
version: 1.0.0
---

# load-balancer

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
