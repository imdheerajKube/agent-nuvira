---
name: queue-setup
description: Set up message queues: BullMQ, RabbitMQ, or SQS for background jobs, task processing, and event-driven architecture. Use when the goal asks to add background jobs, task queues, or async processing.
version: 1.0.0
---

# queue-setup

Set up message queues: BullMQ, RabbitMQ, or SQS for background jobs, task processing, and event-driven architecture. Use when the goal asks to add background jobs, task queues, or async processing.

## Goal pattern

queue job background worker bullmq rabbitmq sqs async processing task

## Parameters

- backend (choice [default: auto]): Queue backend

## Steps

1. [analyst] Identify job types: email sending, image processing, data sync, report generation. Choose the queue backend.

2. [analyst] Set up the queue: install the library, configure Redis/connection, define job schemas with TypeScript types. (after: step-0)

3. [analyst] Implement producers: add enqueue functions with retry logic, priority, delays, and deduplication. (after: step-1)

4. [analyst] Implement consumers: write worker processors with concurrency limits, error handling, and dead-letter queues. (after: step-2)

5. [analyst] Add monitoring: dashboard for queue depth, processing times, failures. Set up alerts for stuck jobs. (after: step-3)
