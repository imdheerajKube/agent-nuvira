# Data Migration Reference Guide

## Overview
Plan and execute data migrations: schema mapping, ETL pipelines, validation, rollback strategies, and zero-downtime migrations. Use when moving data between systems or databases.

## # data-migration

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
