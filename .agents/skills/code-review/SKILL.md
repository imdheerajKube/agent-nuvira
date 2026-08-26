---
name: code-review
description: Conduct thorough code reviews: correctness, security, performance, readability, and test coverage. Covers review checklists, constructive feedback, and automated review tools. Use when reviewing pull requests or code changes.
version: 1.0.0
---

# code-review

Conduct thorough code reviews: correctness, security, performance, readability, and test coverage. Covers review checklists, constructive feedback, and automated review tools. Use when reviewing pull requests or code changes.

## Goal pattern

code review pull request PR review feedback correctness security performance readability test coverage

## Steps

0. [context-gatherer] Map the change: what files changed? What is the PR description? What tests exist? What is the change scope (bug fix, feature, refactor)?

1. [planner] Plan the review:
1. Correctness: does the code do what it claims? Edge cases handled?
2. Security: injection, auth bypass, data exposure?
3. Performance: O(n²) loops? N+1 queries? Memory leaks?
4. Readability: clear naming, comments where needed, DRY?
5. Tests: adequate coverage? Edge cases tested?
6. Architecture: fits the existing patterns? Appropriate abstractions? (after: 'step-0')

2. [runner] Conduct the review:
1. Read the full diff with context
2. Check each file against review criteria
3. Verify tests pass and cover edge cases
4. Check for security issues
5. Note performance concerns
6. Write constructive feedback with specific suggestions (after: 'step-1')

3. [reviewer] Finalize the review: categorize findings (blocking, suggestion, nit), verify all feedback is actionable, ensure tone is constructive. (after: 'step-2')
