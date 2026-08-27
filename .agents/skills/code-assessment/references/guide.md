# Code Assessment Reference Guide

## Overview
Perform a structured codebase assessment: read the project, evaluate it across correctness/security/performance/architecture/testability dimensions, produce a gap-findings list, and deliver prioritized recommendations with effort estimates. Use when the goal asks to assess, evaluate, review, audit, or analyze code quality.

## # code-assessment

Perform a structured codebase assessment: read the project, evaluate it across correctness/security/performance/architecture/testability dimensions, produce a gap-findings list, and deliver prioritized recommendations with effort estimates. Use when the goal asks to assess, evaluate, review, audit, or analyze code quality.

## Goal pattern

assess evaluate review audit analyze code quality codebase project architecture security performance correctness gaps recommendations

## Parameters

- target (file-path [default: .]): Path or scope to assess (default: the whole project)
- focus (string): Optional comma-separated dimension focus (e.g. security, performance)

## Steps

1. [context-gatherer] Map the project first — read the top level (list_dir) and key manifests: package.json / pyproject.toml / go.mod, README, tsconfig / eslint config, and the test layout. Determine:
- the language/framework stack and entry points
- the build/test/typecheck commands (from package.json scripts or equivalent)
- the module boundaries (src/, lib/, app/ dirs) and their sizes
Record the file count and rough LOC per top-level area so the assessment has scope context.

2. [reviewer] Evaluate the code across these dimensions — read real files (read_file / code_search), never guess:
- correctness: error handling, edge cases, null/undefined paths, boundary conditions
- security: secrets in code, injection (SQL/command/HTML), authn/authz gaps, unsafe deserialization, dependency risk
- performance: obvious O(n^2) patterns, N+1 queries, blocking calls in hot paths, unbounded caches
- architecture: coupling, god modules, duplicate logic, missing interfaces, config sprawl, dead code
- testability: coverage gaps, untestable functions (hidden side effects), missing unit/integration boundaries
For each finding record: file:line, the issue, why it matters, and a severity (critical / major / minor). (after: step-0)

3. [writer] Produce the assessment artifact with this exact structure:
1. Scope — what was assessed (stack, size, areas)
2. Gap findings — each with file:line, severity, and why it matters (sorted critical → minor)
3. Strengths — what is already done well (keep it honest)
4. Prioritized recommendations — grouped by quick wins / this quarter / later, each with effort (S/M/L) and risk
5. Suggested next step — the single highest-leverage action to take first
Deliver it as a structured markdown artifact (heading per section, bullets per finding). (after: step-1)

4. [reviewer] Verify the artifact: every critical/major finding has a file:line reference (no vague "somewhere in the codebase" claims), severities are consistent, and the recommendations are actionable (a concrete change, not a platitude). Revise the artifact if any finding lacks evidence. (after: step-2)

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
