# Debug Helpers Reference Guide

## Overview
Debug application issues: breakpoints, logging, profiling, memory analysis, and network inspection. Covers Chrome DevTools, Node.js inspector, and language-specific debuggers. Use when diagnosing bugs or performance issues.

## # debug-helpers

Debug application issues: breakpoints, logging, profiling, memory analysis, and network inspection. Covers Chrome DevTools, Node.js inspector, and language-specific debuggers. Use when diagnosing bugs or performance issues.

## Goal pattern

debug debugging breakpoints logging profiling memory analysis network inspection devtools inspector

## Steps

0. [context-gatherer] Map the issue: what is the symptom? What runtime (browser, Node.js, Python)? What tools available? Reproduction steps?

1. [planner] Plan the debugging approach:
1. Reproduction: minimal steps to reproduce the issue
2. Logging: add strategic console.log/print statements
3. Breakpoints: set breakpoints at critical points
4. Profiling: CPU profile, memory snapshot
5. Network: request/response inspection
6. Tools: Chrome DevTools, Node inspector, pdb, lldb (after: 'step-0')

2. [runner] Debug the issue:
1. Reproduce the bug
2. Add logging around the suspected area
3. Set breakpoints and step through code
4. Capture memory/CPU profile
5. Identify root cause
6. Implement fix and verify (after: 'step-1')

3. [reviewer] Verify: fix resolves the issue, no regressions, logging is appropriate (not verbose), performance is maintained. (after: 'step-2')

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
