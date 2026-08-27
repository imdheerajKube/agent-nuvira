# Security Audit Reference Guide

## Overview
Perform a security audit: scan the codebase for vulnerabilities (injection, secrets, unsafe deserialization, SSRF, path traversal, XSS), classify by severity, produce a prioritized fix plan, and verify fixes. Use when the goal asks to audit security, find vulnerabilities, harden the app, or review for OWASP Top 10.

## # security-audit

Perform a security audit: scan the codebase for vulnerabilities (injection, secrets, unsafe deserialization, SSRF, path traversal, XSS), classify by severity, produce a prioritized fix plan, and verify fixes. Use when the goal asks to audit security, find vulnerabilities, harden the app, or review for OWASP Top 10.

## Goal pattern

security audit vulnerability scan OWASP injection secrets harden SSRF XSS path traversal authz unsafe deserialization CVE

## Parameters

- scope (file-path [default: .]): Path or scope to audit (default: the whole project)
- focus (string): Optional comma-separated focus areas (e.g. injection, secrets, authz)

## Steps

1. [context-gatherer] Map the attack surface with evidence:
- Read entry points: HTTP handlers, CLI commands, webhook endpoints, message consumers
- Identify auth boundaries: login, session, JWT, API keys, RBAC checks
- Trace data flows: user input → parsing → storage → output
- Note the dependency list (package.json / requirements.txt) and any known-CVE candidates
Record every entry point with its file:line so findings have evidence.

2. [security] Scan for vulnerability classes — read real files (read_file / code_search), never guess:
- injection: SQL (string concat in queries), command (exec/spawn with user input), template (unescaped user data in HTML)
- secrets: hardcoded API keys, passwords, tokens, connection strings (grep for patterns like AKIA, sk-, password=, token=)
- unsafe deserialization: JSON.parse on untrusted input without schema validation, pickle.loads, eval()
- SSRF: user-controlled URLs passed to fetch/http.get without allowlist
- path traversal: user input in file paths without normalization/chroot
- XSS: unescaped output in HTML responses, dangerouslySetInnerHTML without sanitization
- authz: missing authorization checks on sensitive endpoints, IDOR (user can access other users' resources by changing an ID)
For each finding record: file:line, the vulnerability class, the exact code pattern, and a PoC sketch (what input triggers it). (after: step-0)

3. [reviewer] Classify and prioritize findings using a CVSS-like severity scale:
- critical: RCE, auth bypass, SQL injection with data exfil, hardcoded root credentials
- high: SSRF, stored XSS, IDOR with PII access, unsafe deserialization leading to code exec
- medium: reflected XSS, path traversal (read-only), missing rate limiting, verbose errors leaking internals
- low: missing security headers, information disclosure via debug endpoints, verbose logging of sensitive data
For each finding assign: severity, exploitability (trivial / requires craft / theoretical), and blast radius (what data/systems are affected). (after: step-1)

4. [writer] Produce the security audit artifact:
1. Executive summary — total findings by severity, top risk
2. Findings table — file:line, class, severity, exploitability, blast radius, evidence snippet
3. Fix plan — ordered by severity, each fix with: the code change (concrete, not vague), the file to edit, and verification step
4. Quick wins — fixes under 5 minutes that eliminate the most risk
5. Deferred items — findings that are low-severity or require architectural changes
Deliver as structured markdown. (after: step-2)

5. [runner] Apply the quick-win fixes and verify each one:
- For each quick-win fix: edit the file (edit_file), then verify the fix by re-scanning the specific pattern (code_search) or running the affected code path
- Run the test suite to confirm no regressions: Run `npm test` or equivalent
Report which fixes were applied and which require deeper architectural work. (after: step-3)

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
