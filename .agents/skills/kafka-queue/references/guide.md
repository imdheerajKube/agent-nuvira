# Kafka Queue Reference Guide

## Overview
Set up Kafka message queues. Use when the goal asks to add event streaming, message queues, or async processing with Kafka.

## # kafka-queue

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
