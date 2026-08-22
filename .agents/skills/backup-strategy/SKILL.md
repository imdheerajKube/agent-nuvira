---
name: backup-strategy
description: Design and implement backup strategies. Use when the goal asks to set up backups, disaster recovery, or data protection.
version: 1.0.0
---

# backup-strategy

Design and implement backup strategies. Use when the goal asks to set up backups, disaster recovery, or data protection.

## Goal pattern

backup disaster recovery retention snapshot restore data protection

## Parameters

- strategy (choice [default: incremental]): Backup strategy

## Steps

1. [analyst] Define RPO (Recovery Point Objective) and RTO (Recovery Time Objective). Identify critical data.

2. [analyst] Implement backup strategy: full, incremental, differential. Choose storage (S3, GCS, tape). (after: step-0)

3. [analyst] Add encryption, compression, and versioning. Implement retention policies. (after: step-1)

4. [analyst] Test restore procedures regularly. Document runbooks and verify backups. (after: step-2)
