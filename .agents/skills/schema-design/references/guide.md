# Schema Design Reference Guide

## Overview
Design database schemas and data models: entities, relationships, indexes, constraints, and normalization. Use when the goal asks to design, model, or restructure a database schema.

## # schema-design

Design database schemas and data models: entities, relationships, indexes, constraints, and normalization. Use when the goal asks to design, model, or restructure a database schema.

## Goal pattern

schema design database model entity relationship normalize index migration erd data model

## Parameters

- dbType (choice [default: auto]): Target database

## Steps

1. [analyst] Gather requirements: identify the business entities, their attributes, and the relationships between them (1:1, 1:N, N:M).

2. [analyst] Create an ER diagram: draw entities with attributes, cardinalities, and optional/mandatory participation. Identify primary and foreign keys. (after: step-1)

3. [analyst] Normalize to 3NF: eliminate redundancy, decompose composite attributes, and ensure every non-key attribute depends on the full primary key. (after: step-2)

4. [analyst] Add performance optimizations: design indexes for common queries, add composite indexes for multi-column lookups, and consider denormalization for read-heavy paths. (after: step-3)

5. [analyst] Generate the migration SQL and ORM models. Write the schema documentation with examples of common queries. (after: step-4)

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
