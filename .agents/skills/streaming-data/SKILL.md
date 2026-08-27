---
name: streaming-data
description: Streaming data architectures: Kafka, Kinesis, event sourcing, and real-time processing. Use when building real-time data pipelines.
version: 1.0.0
---

# streaming-data

Streaming data architectures: Kafka, Kinesis, event sourcing, and real-time processing. Use when building real-time data pipelines.

## Goal pattern

streaming data kafka kinesis event sourcing real-time processing pipeline

## Parameters

(none)

## Steps

1. [context-gatherer] Map streaming requirements: what data streams exist? What throughput is needed? What latency targets exist?

2. [planner] Design streaming architecture:
1. Ingestion: Kafka, Kinesis, Pub/Sub
2. Processing: Flink, Spark Streaming, Kafka Streams
3. Storage: data lake, time-series DB
4. Serving: real-time queries, materialized views
5. Monitoring: lag, throughput, errors
6. Schema: Avro, Protobuf, schema registry (after: step-0)

3. [runner] Implement streaming pipeline:
1. Set up message broker
2. Create stream processors
3. Configure storage sinks
4. Implement real-time queries
5. Add monitoring
6. Test with sample data (after: step-1)

4. [reviewer] Verify: data flows correctly, processing is real-time, storage is optimized, monitoring is active. (after: step-2)
