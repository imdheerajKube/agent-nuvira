# Backup Strategy Reference Guide

## Overview
Design and implement backup strategies. Use when the goal asks to set up backups, disaster recovery, or data protection.

## # backup-strategy

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
