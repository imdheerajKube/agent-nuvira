# Doc Gen Reference Guide

## Overview
Generate documentation from code: scan for public APIs, extract signatures and docstrings, generate structured docs (API reference + guides), validate links, and produce publishable output. Use when the goal asks to document, generate docs, write API reference, create a README, or produce developer documentation.

## # doc-gen

Generate documentation from code: scan for public APIs, extract signatures and docstrings, generate structured docs (API reference + guides), validate links, and produce publishable output. Use when the goal asks to document, generate docs, write API reference, create a README, or produce developer documentation.

## Goal pattern

documentation generate docs API reference README JSDoc docstring developer guide publish

## Parameters

- format (choice [default: markdown]): Output format (default: markdown)
- audience (choice [default: api-consumers]): Target audience (default: API consumers)

## Steps

1. [context-gatherer] Scan the codebase for documentation targets:
- Read package.json / pyproject.toml for the project name, description, and existing doc scripts
- Find public APIs: exported functions/classes/types (TypeScript: `export`, Python: `__all__`), CLI commands, HTTP routes
- Note existing docs (README.md, docs/, JSDoc/docstrings already present)
- Identify the target audience: API consumers, contributors, end users
Produce: a map of what needs documenting, what already has docs, and the output format.

2. [writer] Generate the API reference documentation:
- For each exported function/class: name, parameters (type + description), return type, example usage
- For CLI commands: name, description, arguments, options, examples
- For HTTP routes: method, path, request/response schema, status codes
- Preserve existing JSDoc/docstrings — supplement, don't overwrite
Output as structured markdown with consistent formatting. (after: step-0)

3. [writer] Write the guides and README:
- README.md: project name, one-line description, installation, quick start, key features, license
- CONTRIBUTING.md: setup, development workflow, code style, PR process
- Architecture guide (if complex): module map, data flow, design decisions
Keep guides concise — link to the API reference for details, don't duplicate. (after: step-1)

4. [reviewer] Validate the documentation:
- Check internal links: every `[text](path)` resolves to an existing file
- Check code examples: every snippet should be syntactically valid
- Verify accuracy: cross-reference documented parameters against actual code
- Check for completeness: every public API has a doc entry
Fix any broken links, invalid examples, or missing entries. (after: step-2)

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
