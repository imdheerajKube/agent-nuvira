---
name: cloud-migration
description: Migrate applications to the cloud: assessment, planning, containerization, deployment, and optimization. Covers AWS, GCP, and Azure migration paths. Use when moving on-premise applications to cloud infrastructure.
version: 1.0.0
---

# cloud-migration

Migrate applications to the cloud: assessment, planning, containerization, deployment, and optimization. Covers AWS, GCP, and Azure migration paths. Use when moving on-premise applications to cloud infrastructure.

## Goal pattern

cloud migration AWS GCP Azure containerization assessment planning deployment optimization lift-and-shift

## Steps

0. [context-gatherer] Map the application: what runtime? What dependencies? What data stores? What networking? Target cloud provider?

1. [planner] Design the migration:
1. Assessment: inventory workloads, dependencies, costs
2. Strategy: lift-and-shift vs re-platform vs refactor
3. Containerization: Dockerize the application
4. Infrastructure: provision cloud resources (VPC, compute, storage)
5. Data migration: database, files, configuration
6. Cutover: DNS switch, traffic migration, monitoring (after: 'step-0')

2. [runner] Execute migration:
1. Containerize the application
2. Push images to cloud registry
3. Provision infrastructure (IaC)
4. Deploy application
5. Migrate data
6. Switch traffic and monitor (after: 'step-1')

3. [reviewer] Verify: application running on cloud, data migrated, performance comparable, costs within budget, rollback plan tested. (after: 'step-2')
