---
name: data-migration
description: Plan and execute data migrations: schema mapping, ETL pipelines, validation, rollback strategies, and zero-downtime migrations. Use when moving data between systems or databases.
version: 1.0.0
---

# data-migration

Plan and execute data migrations: schema mapping, ETL pipelines, validation, rollback strategies, and zero-downtime migrations. Use when moving data between systems or databases.

## Goal pattern

data migration ETL schema mapping validation rollback zero-downtime database migration

## Steps

0. [context-gatherer] Map the migration: source and target systems? Data volume? Schema differences? Downtime tolerance? Rollback requirements?

1. [planner] Design the migration:
1. Schema mapping: source → target field mapping, type conversions
2. ETL: extract, transform, load pipeline design
3. Validation: row counts, checksums, business rules
4. Rollback: backup strategy, reverse migration plan
5. Zero-downtime: dual-write, CDC, or scheduled cutover
6. Monitoring: progress tracking, error alerts (after: 'step-0')

2. [runner] Execute the migration:
1. Create backup of source data
2. Run ETL pipeline on sample data, validate
3. Run full migration with progress tracking
4. Validate target data
5. Switch traffic to new system
6. Monitor and keep rollback ready (after: 'step-1')

3. [reviewer] Verify: row count match, checksum validation, business rule validation, performance benchmarks, rollback tested. (after: 'step-2')
