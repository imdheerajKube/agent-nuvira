# Penetration Test Reference Guide

## Overview
Conduct penetration testing: reconnaissance, vulnerability scanning, exploitation, and reporting. Covers OWASP testing guide, common attack vectors, and responsible disclosure. Use when testing application security.

## # penetration-test

Conduct penetration testing: reconnaissance, vulnerability scanning, exploitation, and reporting. Covers OWASP testing guide, common attack vectors, and responsible disclosure. Use when testing application security.

## Goal pattern

penetration testing pen test vulnerability exploitation OWASP attack vector security testing

## Steps

0. [context-gatherer] Map the target: what application type (web, API, mobile)? What scope (full, limited)? Authorization obtained? Testing environment vs production?

1. [planner] Plan the pentest:
1. Reconnaissance: technology fingerprinting, directory enumeration
2. Vulnerability scanning: automated + manual testing
3. Exploitation: attempt to exploit found vulnerabilities
4. Post-exploitation: assess impact, data access
5. Reporting: findings with severity, evidence, remediation
6. Responsible disclosure: timeline for fix verification (after: 'step-0')

2. [runner] Execute the pentest:
1. Run reconnaissance (nmap, whatweb, dirb)
2. Scan for vulnerabilities (nuclei, nikto)
3. Manual testing of high-risk areas
4. Attempt exploitation
5. Document all findings
6. Clean up any test artifacts (after: 'step-1')

3. [reviewer] Review: verify findings are valid, check severity ratings, ensure remediation steps are clear, confirm no production data was accessed. (after: 'step-2')

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
