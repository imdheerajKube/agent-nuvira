# Streaming Data Reference Guide

## Overview
Streaming data architectures: Kafka, Kinesis, event sourcing, and real-time processing. Use when building real-time data pipelines.

## # streaming-data

Streaming data architectures: Kafka, Kinesis, event sourcing, and real-time processing. Use when building real-time data pipelines.

## Goal pattern

streaming data kafka kinesis event sourcing real-time processing pipeline

## Steps

0. [context-gatherer] Map streaming requirements: what data streams exist? What throughput is needed? What latency targets exist?

1. [planner] Design streaming architecture:
1. Ingestion: Kafka, Kinesis, Pub/Sub
2. Processing: Flink, Spark Streaming, Kafka Streams
3. Storage: data lake, time-series DB
4. Serving: real-time queries, materialized views
5. Monitoring: lag, throughput, errors
6. Schema: Avro, Protobuf, schema registry (after: 'step-0')

2. [runner] Implement streaming pipeline:
1. Set up message broker
2. Create stream processors
3. Configure storage sinks
4. Implement real-time queries
5. Add monitoring
6. Test with sample data (after: 'step-1')

3. [reviewer] Verify: data flows correctly, processing is real-time, storage is optimized, monitoring is active. (after: 'step-2')

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
