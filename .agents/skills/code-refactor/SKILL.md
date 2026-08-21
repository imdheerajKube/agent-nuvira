---
name: code-refactor
description: Refactor code safely: analyze the target, identify patterns to improve, plan the changes, apply the refactoring surgically, and verify with tests. Use when the goal asks to refactor, restructure, extract, inline, rename, clean up, or improve code organization.
version: 1.0.0
---

# code-refactor

Refactor code safely: analyze the target, identify patterns to improve, plan the changes, apply the refactoring surgically, and verify with tests. Use when the goal asks to refactor, restructure, extract, inline, rename, clean up, or improve code organization.

## Goal pattern

refactor restructure extract inline rename clean up code organization DRY SOLID improve pattern

## Parameters

- refactorType (choice [default: auto]): Type of refactoring (auto-detected from code analysis if not specified)
- target (file-path): File or function to refactor

## Steps

1. [context-gatherer] Analyze the target code with evidence:
- Read the file(s) to refactor — understand the current structure, dependencies, and callers
- Use code_search to find all callers/references to the code being refactored
- Note the test coverage: are there existing tests for this code? (glob for *.test.* matching the file)
- Identify the refactoring type: extract function/class, inline, rename, move, restructure
Produce: the current structure, all callers, test coverage, and the refactoring type.

2. [planner] Plan the refactoring changes:
- What moves where (old location → new location)
- What breaks (callers that need updating)
- The order of operations (rename first, then extract, then update callers)
- Whether to do it in one commit or multiple (atomic refactors are safer)
Write a step-by-step plan with file paths and the specific changes. (after: step-0)

3. [runner] Apply the refactoring surgically:
- Make one change at a time (don't rename + extract + move in one edit)
- After each change: save and verify the file still parses (no syntax errors)
- Update all callers (use code_search to find every reference)
- Run the test suite after each meaningful change: Run `npm test` or equivalent
If a test breaks: the refactoring changed behavior — fix the refactoring, not the test. (after: step-1)

4. [tester] Verify the refactoring:
- Run the full test suite: Run `npm test` or equivalent
- Run the type checker: Run `npx tsc --noEmit` or equivalent
- Verify behavior is identical: the refactoring must not change external behavior
- If new tests are needed (the refactoring exposed untested paths), add them
The refactoring is complete only when all tests pass and the code is cleaner. (after: step-2)
