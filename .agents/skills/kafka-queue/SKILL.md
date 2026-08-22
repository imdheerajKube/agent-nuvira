---
name: kafka-queue
description: Set up Kafka message queues. Use when the goal asks to add event streaming, message queues, or async processing with Kafka.
version: 1.0.0
---

# kafka-queue

Set up Kafka message queues. Use when the goal asks to add event streaming, message queues, or async processing with Kafka.

## Goal pattern

kafka message queue event streaming async processing producer consumer

## Parameters

- serialization (choice [default: json]): Message format

## Steps

1. [analyst] Design topic schema and partition strategy. Define producer and consumer groups.

2. [analyst] Implement producers with batching, compression, and idempotent writes. (after: step-0)

3. [analyst] Implement consumers with offset management, dead-letter queues, and retry logic. (after: step-1)

4. [analyst] Monitor consumer lag, throughput, and set up alerts. (after: step-2)
