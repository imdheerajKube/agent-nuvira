---
name: db-migration
description: Design and implement a database migration: analyze the current schema, design the migration (what changes, in what order), write the migration SQL/scripts, test backward compatibility, and document the change. Use when the goal asks to migrate a database, add/modify columns, change schema, or restructure tables.
version: 1.0.0
---

# db-migration

Design and implement a database migration: analyze the current schema, design the migration (what changes, in what order), write the migration SQL/scripts, test backward compatibility, and document the change. Use when the goal asks to migrate a database, add/modify columns, change schema, or restructure tables.

## Goal pattern

database migration schema SQL column table alter add modify restructure backward compatible

## Parameters

- dbType (choice [default: auto]): Database type (auto-detected from project config if not specified)
- migrationTool (choice [default: auto]): Migration tool (auto-detected from project if not specified)

## Steps

1. [context-gatherer] Analyze the current schema with evidence:
- Read ORM models (Prisma schema, SQLAlchemy models, Django models, TypeORM entities)
- Read existing migration files (prisma/migrations/, alembic/versions/, db/migrate/)
- Note the database type (PostgreSQL, MySQL, SQLite) and the migration tool in use
- Identify the current tables, columns, indexes, and constraints
Produce a schema snapshot: table → columns (type, nullable, default, index).

2. [planner] Design the migration with backward compatibility in mind:
- Additive changes (new columns with defaults) are safe — old code ignores them
- Column renames: add new column → copy data → drop old (never rename in-place — old code breaks)
- Column type changes: add new column with new type → migrate data → swap → drop old
- New indexes: create concurrently (PostgreSQL) to avoid locking
- Breaking changes: require a multi-step rollout (deploy code that works with BOTH schemas, then migrate, then deploy code that uses the new schema)
Produce a migration plan: ordered steps, each with forward + rollback SQL. (after: step-0)

3. [runner] Write the migration using the project's migration tool:
- Prisma: `npx prisma migrate dev --name <description>` (generates SQL + updates client)
- Alembic: `alembic revision --autogenerate -m <description>` then review generated SQL
- Raw SQL: write a numbered SQL file (001_add_column.sql) with UP + DOWN sections
- Apply: run the migration against a dev/test database: Run `npx prisma migrate dev` or `alembic upgrade head` or `psql -f migration.sql`
Verify the migration applies cleanly (no errors) and rolls back cleanly. (after: step-1)

4. [tester] Test backward compatibility:
- Run the existing test suite against the new schema: Run `npm test` or equivalent
- Verify old code paths still work (the ORM models must be compatible with both old and new schema during rollout)
- Check for data loss: query the affected tables before/after migration
- Verify indexes were created (check with `EXPLAIN ANALYZE` on slow queries)
Report: what changed, what broke (if anything), and whether the migration is safe to deploy. (after: step-2)

5. [writer] Document the migration:
- What changed (table:column, type, default, index)
- Why (the business/technical reason)
- Rollback procedure (the DOWN migration)
- Deployment notes (order of operations: migrate → deploy code, or deploy code → migrate)
Add to CHANGELOG.md or a migration-specific doc. (after: step-3)
