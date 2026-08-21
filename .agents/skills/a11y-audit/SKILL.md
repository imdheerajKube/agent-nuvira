---
name: a11y-audit
description: Audit web applications for accessibility (WCAG 2.1 AA compliance): check color contrast, keyboard navigation, screen-reader compatibility, ARIA attributes, and semantic HTML. Use when the goal asks to audit, fix, or improve accessibility.
version: 1.0.0
---

# a11y-audit

Audit web applications for accessibility (WCAG 2.1 AA compliance): check color contrast, keyboard navigation, screen-reader compatibility, ARIA attributes, and semantic HTML. Use when the goal asks to audit, fix, or improve accessibility.

## Goal pattern

accessibility a11y wcag audit screen reader keyboard nav aria contrast wcag

## Parameters

- scope (choice [default: full]): Audit scope

## Steps

1. [analyst] Scan the codebase for accessibility issues: run automated tools (axe-core, pa11y, lighthouse) or inspect JSX for missing alt text, labels, ARIA roles, and semantic landmarks.

2. [analyst] Categorize issues by severity: critical (blocks users), serious (hard to use), moderate (annoying), minor (cosmetic). Map to WCAG success criteria. (after: step-1)

3. [analyst] Fix critical and serious issues: add missing alt text, labels, ARIA attributes, keyboard handlers, focus management, and color contrast adjustments. (after: step-2)

4. [analyst] Test fixes: verify keyboard-only navigation, screen-reader output, and color contrast ratios. Re-run automated scanner. (after: step-3)

5. [analyst] Write an accessibility report: WCAG 2.1 AA conformance status, remaining issues by severity, and an accessibility statement for the project. (after: step-4)
