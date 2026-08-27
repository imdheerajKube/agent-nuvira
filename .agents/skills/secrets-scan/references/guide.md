# Secrets Scan Reference Guide

## Overview
Scan codebases for leaked secrets: API keys, passwords, tokens, certificates. Covers detection patterns, false positive handling, and remediation. Use when auditing for credential exposure.

## # secrets-scan

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
