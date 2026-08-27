# Compliance Check Reference Guide

## Overview
Check regulatory compliance: GDPR, HIPAA, SOC2, PCI-DSS. Covers requirements mapping, gap analysis, control implementation, and audit preparation. Use when ensuring an application meets compliance standards.

## # compliance-check

Check regulatory compliance: GDPR, HIPAA, SOC2, PCI-DSS. Covers requirements mapping, gap analysis, control implementation, and audit preparation. Use when ensuring an application meets compliance standards.

## Goal pattern

compliance GDPR HIPAA SOC2 PCI-DSS audit requirements gap analysis controls regulatory

## Steps

0. [context-gatherer] Map the compliance landscape: what regulations apply (GDPR, HIPAA, SOC2, PCI-DSS)? What data is processed? What controls exist? What gaps are known?

1. [planner] Plan the compliance check:
1. Requirements mapping: regulation → specific requirements → current controls
2. Gap analysis: what requirements are not met
3. Control implementation: technical and organizational measures
4. Documentation: policies, procedures, evidence
5. Audit preparation: evidence collection, walkthrough readiness
6. Continuous monitoring: ongoing compliance checks (after: 'step-0')

2. [runner] Execute the check:
1. Map requirements to current implementation
2. Identify gaps
3. Implement missing controls
4. Create documentation
5. Collect evidence
6. Prepare audit materials (after: 'step-1')

3. [reviewer] Review: verify all requirements addressed, evidence is sufficient, controls are effective, documentation is complete. (after: 'step-2')

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
