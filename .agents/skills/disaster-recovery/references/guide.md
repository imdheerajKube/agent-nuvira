# Disaster Recovery Reference Guide

## Overview
Disaster recovery planning: backup strategies, failover mechanisms, RTO/RPO targets, and DR testing. Use when planning for system resilience.

## # disaster-recovery

Disaster recovery planning: backup strategies, failover mechanisms, RTO/RPO targets, and DR testing. Use when planning for system resilience.

## Goal pattern

disaster recovery backup failover RTO RPO DR planning resilience

## Steps

0. [context-gatherer] Map the critical systems: what services need DR? What are the RTO/RPO targets? What backup infrastructure exists?

1. [planner] Design DR strategy:
1. Backup: frequency, retention, cross-region replication
2. Failover: active-passive vs active-active
3. RTO/RPO: define targets for each system
4. Testing: regular DR drills
5. Documentation: runbooks for failover
6. Monitoring: backup verification alerts (after: 'step-0')

2. [runner] Implement DR:
1. Configure backup schedules
2. Set up cross-region replication
3. Implement failover mechanisms
4. Create DR runbooks
5. Conduct DR test
6. Document procedures (after: 'step-1')

3. [reviewer] Verify: backups are running, failover works, RTO/RPO targets are met, DR test was successful. (after: 'step-2')

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
