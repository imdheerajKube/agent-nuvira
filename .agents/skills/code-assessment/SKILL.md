---
name: code-assessment
description: Perform a structured codebase assessment: read the project, evaluate it across correctness/security/performance/architecture/testability dimensions, produce a gap-findings list, and deliver prioritized recommendations with effort estimates. Use when the goal asks to assess, evaluate, review, audit, or analyze code quality.
version: 1.0.0
---

# code-assessment

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

Then run a STATE-TRACE pass over every surface that HOLDS state (a UI field, a cached value, a module-level variable, a parsed argument). For each one enumerate the values it can actually hold AT RUNTIME — including the intermediate ones OTHER handlers put there — and check every operation applied to it against that whole set. Reading the code is not enough: the most damaging defects live in the gap between what a variable is CALLED and what it can CONTAIN, and they are invisible to anyone who assumes the name.
Worked example of the shape: a calculator display is appended to on every keypress, so it holds a user-typed EXPRESSION ("5+5"), not merely a number. `parseFloat(display.value)` then silently computes on 5, so the neighbouring formatting lines look like the only issue in that function. The finding is only visible after you say out loud: what can `display.value` be here? Name that runtime value set in the finding.

For each finding record: file:line, the issue, why it matters, and a severity (critical / major / minor). (after: step-0)

3. [writer] Produce the assessment artifact with this exact structure:
1. Scope — what was assessed (stack, size, areas)
2. Gap findings — each with file:line, severity, and why it matters (sorted critical → minor)
3. Strengths — what is already done well (keep it honest)
4. Prioritized recommendations — grouped by quick wins / this quarter / later, each with effort (S/M/L) and risk
5. Suggested next step — the single highest-leverage action to take first
Deliver it as a structured markdown artifact (heading per section, bullets per finding). (after: step-1)

4. [reviewer] Verify the artifact with EVIDENCE, not with prose:
- every critical/major finding must carry a FALSIFYING INPUT — the concrete steps (or command) that demonstrate the defect, plus expected-vs-actual. A finding you cannot trigger is a suspicion, not a finding: either produce the input, or downgrade it to "unverified concern" and say what is missing.
- raise — never lower — a severity when the falsifying input shows wrong output or a crash a user would hit.
- keep the file:line reference (no vague "somewhere in the codebase" claims), keep severities consistent with that evidence, and make recommendations actionable (a concrete change, not a platitude).
- if the assessment found ZERO major/critical issues, re-run the state-trace pass over every function that consumes user input before concluding the code is sound. "Nothing found" is only trustworthy AFTER that pass, never instead of it — a clean-looking file with an unexamined input path is the exact failure mode this skill exists to prevent.
Revise the artifact if any finding lacks evidence. (after: step-2)
