# Queue Setup Reference Guide

## Overview
Set up message queues: BullMQ, RabbitMQ, or SQS for background jobs, task processing, and event-driven architecture. Use when the goal asks to add background jobs, task queues, or async processing.

## # queue-setup

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
