# Dependency Audit Reference Guide

## Overview
Audit project dependencies for vulnerabilities, outdated versions, license compliance, and supply chain risks. Use when ensuring dependency health and security.

## # dependency-audit

Audit project dependencies for vulnerabilities, outdated versions, license compliance, and supply chain risks. Use when ensuring dependency health and security.

## Goal pattern

dependency audit vulnerability outdated license supply chain security npm audit

## Steps

0. [context-gatherer] Map the dependencies: what package manager (npm, pip, cargo)? How many direct and transitive dependencies? Current lockfile?

1. [planner] Plan the audit:
1. Vulnerability scan: npm audit, pip-audit, cargo audit
2. Outdated check: npm outdated, pip list --outdated
3. License audit: license-checker, licensee
4. Supply chain: verify checksums, check maintainer reputation
5. Update strategy: semver compatibility, breaking changes
6. Automation: Dependabot, Renovate bot (after: 'step-0')

2. [runner] Execute the audit:
1. Run vulnerability scanner
2. Check for outdated packages
3. Audit licenses for compliance
4. Review high-risk dependencies
5. Create update plan
6. Set up automated updates (after: 'step-1')

3. [reviewer] Review: verify all vulnerabilities addressed, licenses compliant, update plan is feasible, automation configured. (after: 'step-2')

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
