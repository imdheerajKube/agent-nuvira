---
name: debug-helpers
description: Debug application issues: breakpoints, logging, profiling, memory analysis, and network inspection. Covers Chrome DevTools, Node.js inspector, and language-specific debuggers. Use when diagnosing bugs or performance issues.
version: 1.0.0
---

# debug-helpers

Debug application issues: breakpoints, logging, profiling, memory analysis, and network inspection. Covers Chrome DevTools, Node.js inspector, and language-specific debuggers. Use when diagnosing bugs or performance issues.

## Goal pattern

debug debugging breakpoints logging profiling memory analysis network inspection devtools inspector

## Parameters

(none)

## Steps

1. [context-gatherer] Map the issue: what is the symptom? What runtime (browser, Node.js, Python)? What tools available? Reproduction steps?

2. [planner] Plan the debugging approach:
1. Reproduction: minimal steps to reproduce the issue
2. Logging: add strategic console.log/print statements
3. Breakpoints: set breakpoints at critical points
4. Profiling: CPU profile, memory snapshot
5. Network: request/response inspection
6. Tools: Chrome DevTools, Node inspector, pdb, lldb (after: step-0)

3. [runner] Debug the issue:
1. Reproduce the bug
2. Add logging around the suspected area
3. Set breakpoints and step through code
4. Capture memory/CPU profile
5. Identify root cause
6. Implement fix and verify (after: step-1)

4. [reviewer] Verify: fix resolves the issue, no regressions, logging is appropriate (not verbose), performance is maintained. (after: step-2)
