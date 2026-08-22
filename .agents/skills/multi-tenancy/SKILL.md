---
name: multi-tenancy
description: Implement multi-tenancy: tenant isolation, shared databases with row-level security, or separate schemas. Use when the goal asks to add multi-tenancy, tenant isolation, or SaaS data separation.
version: 1.0.0
---

# multi-tenancy

Implement multi-tenancy: tenant isolation, shared databases with row-level security, or separate schemas. Use when the goal asks to add multi-tenancy, tenant isolation, or SaaS data separation.

## Goal pattern

multi-tenancy tenant isolation saas data separation row-level security shared database

## Parameters

- model (choice [default: auto]): Tenancy model

## Steps

1. [analyst] Choose the tenancy model: shared database (row-level), schema-per-tenant, or database-per-tenant. Assess isolation requirements.

2. [analyst] Implement tenant context: add tenant ID to all requests via middleware, JWT claims, or subdomain routing. (after: step-0)

3. [analyst] Enforce isolation: add row-level security policies, schema switching, or database routing based on tenant context. (after: step-1)

4. [analyst] Handle tenant lifecycle: implement tenant creation, suspension, deletion, and data migration between tiers. (after: step-2)

5. [analyst] Test isolation: verify tenant A cannot access tenant B data, test cross-tenant queries fail, and audit the security. (after: step-3)
