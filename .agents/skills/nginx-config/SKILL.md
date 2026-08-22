---
name: nginx-config
description: Configure Nginx as reverse proxy, load balancer, or web server. Use when the goal asks to set up Nginx, configure SSL, or optimize web serving.
version: 1.0.0
---

# nginx-config

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
