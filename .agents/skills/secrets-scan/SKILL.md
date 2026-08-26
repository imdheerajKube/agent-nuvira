---
name: secrets-scan
description: Scan codebases for leaked secrets: API keys, passwords, tokens, certificates. Covers detection patterns, false positive handling, and remediation. Use when auditing for credential exposure.
version: 1.0.0
---

# secrets-scan

Scan codebases for leaked secrets: API keys, passwords, tokens, certificates. Covers detection patterns, false positive handling, and remediation. Use when auditing for credential exposure.

## Goal pattern

secrets scan API key password token credential leak detection remediation gitleaks trufflehog

## Steps

0. [context-gatherer] Map the scan scope: what repositories? What file types to scan? What secret patterns to detect? What history depth?

1. [planner] Plan the secrets scan:
1. Tools: gitleaks, trufflehog, or custom regex patterns
2. Patterns: AWS keys, GitHub tokens, database URLs, private keys
3. Exclusions: test fixtures, example files, documentation
4. False positive handling: baseline, allowlists
5. Remediation: rotate secrets, add to .gitignore, use vault
6. Prevention: pre-commit hooks, CI/CD scanning (after: 'step-0')

2. [runner] Execute the scan:
1. Run secret detection tool against repo
2. Review findings, filter false positives
3. Document all confirmed secrets
4. Verify secrets are not active (test them)
5. Create remediation plan
6. Set up prevention (pre-commit hooks) (after: 'step-1')

3. [reviewer] Review: verify all secrets found, confirm rotation happened, check prevention is in place, verify no active secrets remain. (after: 'step-2')
