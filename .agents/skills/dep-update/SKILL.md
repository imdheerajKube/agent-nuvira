---
name: dep-update
description: Update dependencies safely: audit for outdated versions and vulnerabilities, select update targets, update, run tests, fix breakages, and document changes. Use when the goal asks to update deps, upgrade packages, fix vulnerabilities, or modernize dependencies.
version: 1.0.0
---

# dep-update

Update dependencies safely: audit for outdated versions and vulnerabilities, select update targets, update, run tests, fix breakages, and document changes. Use when the goal asks to update deps, upgrade packages, fix vulnerabilities, or modernize dependencies.

## Goal pattern

dependency update upgrade packages outdated vulnerability fix npm pip go mod modernize

## Parameters

- strategy (choice [default: patch]): Update strategy: patch (safe), minor (features), major (breaking)

## Steps

1. [context-gatherer] Audit the current dependency state:
- Run `npm outdated` / `pip list --outdated` / `go list -m -u all` to see what's behind
- Run `npm audit` / `pip audit` / `govulncheck` for known vulnerabilities
- Read package.json / requirements.txt for pinned versions
- Note which deps are production vs dev (production deps affect the shipped product)
Produce: a list of outdated deps with current → latest version, and any with known CVEs.

2. [planner] Select update targets in priority order:
- P0: security fixes (any dep with a known CVE — update immediately)
- P1: patch updates (bug fixes, no breaking changes — safe to batch)
- P2: minor updates (new features, backward-compatible — usually safe)
- P3: major updates (breaking changes — one at a time, with migration guide)
For major updates: read the changelog/migration guide first, note what breaks, and plan the code changes. (after: step-0)

3. [runner] Apply updates in batches:
- P0 (security): update all vulnerable deps immediately
- P1+P2 (patch+minor): batch update — Run `npm update` / `pip install --upgrade` / `go get -u`
- P3 (major): update ONE major dep at a time, fix breakages before moving to the next
After each batch: run the test suite to catch breakages early. (after: step-1)

4. [tester] Verify after each update batch:
- Run the full test suite: Run `npm test` or equivalent
- Run the build to catch compile-time breakages: Run `npm run build` or equivalent
- Check for deprecation warnings in the output
- If a test fails: read the error, fix the code (not the dep version), re-run
Never roll back a dep version to fix a test — fix the code to work with the new version. (after: step-2)

5. [writer] Document the updates:
- Update CHANGELOG.md with the dep changes (name, old version → new version, reason)
- Note any breaking changes that require code updates
- Update the lock file (package-lock.json, poetry.lock, go.sum) — commit it
The lock file is the source of truth for reproducible builds. (after: step-3)
