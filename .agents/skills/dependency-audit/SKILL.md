---
name: dependency-audit
description: Audit project dependencies for vulnerabilities, outdated versions, license compliance, and supply chain risks. Use when ensuring dependency health and security.
version: 1.0.0
---

# dependency-audit

Audit project dependencies for vulnerabilities, outdated versions, license compliance, and supply chain risks. Use when ensuring dependency health and security.

## Goal pattern

dependency audit vulnerability outdated license supply chain security npm audit

## Parameters

(none)

## Steps

1. [context-gatherer] Map the dependencies: what package manager (npm, pip, cargo)? How many direct and transitive dependencies? Current lockfile?

2. [planner] Plan the audit:
1. Vulnerability scan: npm audit, pip-audit, cargo audit
2. Outdated check: npm outdated, pip list --outdated
3. License audit: license-checker, licensee
4. Supply chain: verify checksums, check maintainer reputation
5. Update strategy: semver compatibility, breaking changes
6. Automation: Dependabot, Renovate bot (after: step-0)

3. [runner] Execute the audit:
1. Run vulnerability scanner
2. Check for outdated packages
3. Audit licenses for compliance
4. Review high-risk dependencies
5. Create update plan
6. Set up automated updates (after: step-1)

4. [reviewer] Review: verify all vulnerabilities addressed, licenses compliant, update plan is feasible, automation configured. (after: step-2)
