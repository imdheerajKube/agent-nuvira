---
name: data-sync
description: Set up data synchronization between systems: ETL pipelines, API sync, database replication, and real-time streaming. Use when the goal asks to sync data, build ETL pipelines, or connect data sources.
version: 1.0.0
---

# data-sync

Set up data synchronization between systems: ETL pipelines, API sync, database replication, and real-time streaming. Use when the goal asks to sync data, build ETL pipelines, or connect data sources.

## Goal pattern

data sync etl pipeline replicate stream transform migrate connect sources

## Parameters

- approach (choice [default: auto]): Sync approach

## Steps

1. [analyst] Map data sources: identify source and destination systems, data formats, sync frequency, and conflict resolution strategy.

2. [analyst] Choose the sync approach: batch ETL, CDC (change data capture), API polling, or real-time streaming (WebSocket/SSE). (after: step-0)

3. [analyst] Implement the pipeline: write extract/transform/load functions with error handling, idempotency, and logging. (after: step-1)

4. [analyst] Add scheduling: cron-based runs, event-driven triggers, or manual invocation. Handle partial failures and retries. (after: step-2)

5. [analyst] Monitor: track sync status, record metrics (rows synced, duration, errors), and set up alerts for failures. (after: step-3)
