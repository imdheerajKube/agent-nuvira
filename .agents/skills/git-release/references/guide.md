# Git Release Reference Guide

## Overview
Manage git releases: changelog generation, semantic versioning, release branches, tagging, and publishing to package registries. Use when the goal asks to cut a release, create a changelog, or publish a package.

## # git-release

Manage git releases: changelog generation, semantic versioning, release branches, tagging, and publishing to package registries. Use when the goal asks to cut a release, create a changelog, or publish a package.

## Goal pattern

release changelog semantic version semver tag publish npm github release hotfix

## Parameters

- type (choice [default: auto]): Release type

## Steps

1. [analyst] Determine the version bump: analyze commit messages since last release, classify as major/minor/patch using conventional commits.

2. [analyst] Generate the changelog: group commits by type (feat, fix, chore, docs), write release notes with contributor attributions. (after: step-1)

3. [analyst] Create a release branch (release/X.Y.Z), update version in package.json / Cargo.toml / pyproject.toml, and commit. (after: step-2)

4. [analyst] Tag the release (vX.Y.Z), push the tag and branch, and create a GitHub/GitLab release with the changelog body. (after: step-3)

5. [analyst] Publish: run npm publish / cargo publish / twine upload. Verify the package appears in the registry. Merge the release branch back to main. (after: step-4)

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
