---
name: test-strategy
description: Plan and run a deep test pass: map the test surface, choose the right matrix (unit / integration / e2e, focused runs for changed code), execute the real commands (npm test, vitest, pytest, etc.), and deliver a verdict with evidence. Use when the goal asks to test, verify, check for regressions, or prove a change is safe.
version: 1.0.0
---

# test-strategy

Plan and run a deep test pass: map the test surface, choose the right matrix (unit / integration / e2e, focused runs for changed code), execute the real commands (npm test, vitest, pytest, etc.), and deliver a verdict with evidence. Use when the goal asks to test, verify, check for regressions, or prove a change is safe.

## Goal pattern

test verify regression check coverage suite unit integration e2e pass run tests prove safe

## Parameters

- scope (choice [default: full]): Scope of the test pass: focused | unit | integration | full (default: full)
- target (file-path): Path or files to focus on (for scope=focused)

## Steps

1. [context-gatherer] Map the test surface with evidence: read the test config (vitest/jest/pytest config in the manifests), list the test files (glob "**/*.test.*" or tests/), and note the commands that run them (from package.json scripts or equivalent). Identify:
- the unit test entry points and how fast they are
- any integration/e2e suites and their prerequisites (services, fixtures, env vars)
- which areas changed and deserve a focused run first

2. [planner] Choose the matrix — never just "run everything":
- focused: the tests touching the changed code (fastest, run FIRST)
- unit: the full unit suite (the main regression net)
- integration: the suites that exercise real boundaries (DB, HTTP, filesystem)
- e2e: the slow end-to-end flows — run only when unit+integration are green
- typecheck/build: static verification alongside the tests
Record the exact commands and the order, with the reason each level matters. (after: step-0)

3. [runner] Execute the matrix IN ORDER with the real commands via run_terminal (never claim tests pass without running them):
- start with the focused run — a failure here tells you the change broke something before the slow suites waste time
- then the full unit suite
- then integration (and e2e only if the cheaper levels are green)
- run typecheck/build as the static gate
On a failure: read the failing test + the code (read_file), fix, and re-run that focused test until green before moving up the matrix. (after: step-1)

4. [reviewer] Deliver the verdict with evidence: what ran (exact commands + pass/fail counts), what passed, what failed and why (file:line), coverage gaps that matter, and a clear recommendation (safe to merge / needs fixes / needs more tests). Never state "tests pass" without the actual run output. (after: step-2)
