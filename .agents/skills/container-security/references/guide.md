# Container Security Reference Guide

## Overview
Container security: image scanning, runtime protection, network policies, and secrets management. Use when securing containerized applications.

## # container-security

Container security: image scanning, runtime protection, network policies, and secrets management. Use when securing containerized applications.

## Goal pattern

container security image scanning runtime protection network policies secrets management

## Steps

0. [context-gatherer] Assess container security: what images are used? What runtime policies exist? What network controls are in place?

1. [planner] Design container security:
1. Image scanning: CVE scanning, base image updates
2. Runtime: seccomp, AppArmor, read-only rootfs
3. Network: network policies, service mesh mTLS
4. Secrets: vault integration, sealed secrets
5. Compliance: CIS benchmarks, OPA policies
6. Monitoring: runtime threat detection (after: 'step-0')

2. [runner] Implement container security:
1. Enable image scanning in CI/CD
2. Apply runtime policies
3. Configure network policies
4. Set up secrets management
5. Implement OPA policies
6. Enable runtime monitoring (after: 'step-1')

3. [reviewer] Verify: images are scanned, runtime is protected, network is restricted, secrets are managed. (after: 'step-2')

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
