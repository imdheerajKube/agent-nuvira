# Incident Response Reference Guide

## Overview
Incident response procedures: detection, containment, eradication, recovery, and post-incident review. Use when responding to security incidents.

## # incident-response

Incident response procedures: detection, containment, eradication, recovery, and post-incident review. Use when responding to security incidents.

## Goal pattern

incident response security breach detection containment eradication recovery review

## Steps

0. [context-gatherer] Assess the incident: what happened? What systems are affected? What is the impact? What is the timeline?

1. [planner] Plan incident response:
1. Detection: identify the incident type and scope
2. Containment: isolate affected systems
3. Eradication: remove the threat
4. Recovery: restore systems to normal
5. Review: conduct post-incident analysis
6. Lessons: document improvements (after: 'step-0')

2. [runner] Execute incident response:
1. Document incident details
2. Isolate affected systems
3. Collect evidence
4. Remove threat
5. Restore from backups
6. Conduct post-mortem (after: 'step-1')

3. [reviewer] Verify: incident is contained, systems are restored, documentation is complete, improvements are identified. (after: 'step-2')

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
