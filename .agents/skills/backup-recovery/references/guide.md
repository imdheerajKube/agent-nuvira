# Backup Recovery Reference Guide

## Overview
Design and implement backup and disaster recovery: automated database backups, point-in-time recovery, S3 snapshots, and runbook documentation. Use when the goal asks to set up backups, recovery, or disaster resilience.

## # backup-recovery

Design and implement backup and disaster recovery: automated database backups, point-in-time recovery, S3 snapshots, and runbook documentation. Use when the goal asks to set up backups, recovery, or disaster resilience.

## Goal pattern

backup recovery disaster recovery database backup restore snapshots runbook resilience

## Parameters

- scope (choice [default: full-stack]): Backup scope

## Steps

1. [analyst] Audit current state: identify all data stores (DB, file storage, cache), their backup capabilities, and current RPO/RTO targets.

2. [analyst] Design backup strategy: define frequency (continuous, hourly, daily), retention policy, storage location (S3, GCS, separate region), and encryption. (after: step-1)

3. [analyst] Implement automated backups: write cron jobs or scheduled tasks for database dumps, file snapshots, and configuration backups. Verify checksums. (after: step-2)

4. [analyst] Test recovery: perform a full restore to an isolated environment, verify data integrity, measure recovery time. (after: step-3)

5. [analyst] Write a disaster recovery runbook: step-by-step recovery procedures, contact list, escalation path, and post-mortem template. (after: step-4)

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
