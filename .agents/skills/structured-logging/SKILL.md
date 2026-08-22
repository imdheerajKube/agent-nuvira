---
name: structured-logging
description: Implement structured logging with JSON output. Use when the goal asks to add logging, log aggregation, or log-based debugging.
version: 1.0.0
---

# structured-logging

Implement structured logging with JSON output. Use when the goal asks to add logging, log aggregation, or log-based debugging.

## Goal pattern

logging structured json log aggregation elk loki Winston pino

## Parameters

- library (choice [default: pino]): Logging library

## Steps

1. [analyst] Choose logging library (Winston, Pino, bunyan). Define log levels and structured fields.

2. [analyst] Implement request context logging (request ID, user ID, trace ID) for correlation. (after: step-0)

3. [analyst] Add log transport: stdout for dev, file/ELK/Loki for production. (after: step-1)

4. [analyst] Add log-based alerting and debugging dashboards. (after: step-2)
