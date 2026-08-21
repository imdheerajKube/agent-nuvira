---
name: schema-design
description: Design database schemas and data models: entities, relationships, indexes, constraints, and normalization. Use when the goal asks to design, model, or restructure a database schema.
version: 1.0.0
---

# schema-design

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
