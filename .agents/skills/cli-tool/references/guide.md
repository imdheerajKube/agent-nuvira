# Cli Tool Reference Guide

## Overview
Create a command-line tool with argument parsing, help text, subcommands, and packaging. Use when the goal asks to create a CLI tool, command-line utility, or terminal application.

## # cli-tool

Create a command-line tool with argument parsing, help text, subcommands, and packaging. Use when the goal asks to create a CLI tool, command-line utility, or terminal application.

## Goal pattern

CLI command line tool terminal utility terminal app argparse cobra click yargs commander

## Parameters

- language (choice [default: auto]): Programming language — node, python, go, rust, auto

## Steps

1. [context-gatherer] Analyze the CLI tool requirements:
   - What does the tool do? (one-liner description)
   - What language? (Node.js, Python, Go, Rust)
   - What arguments/flags/options?
   - Does it need subcommands?
   - Does it need a config file?
   - How will it be distributed? (npm, pip, cargo, go install, standalone binary)
   Produce: a CLI specification with commands, flags, and distribution plan.

2. [writer] Implement the CLI tool:
   - Set up the project structure (package.json / pyproject.toml / go.mod / Cargo.toml)
   - Implement argument parsing (commander.js / argparse / cobra / clap)
   - Add help text and usage examples
   - Implement subcommands if needed
   - Add config file support (if needed)
   - Add input validation and error handling
   Write clean, well-documented code with proper error messages.

3. [tester] Write and run tests:
   - Unit tests for core logic
   - Integration tests for argument parsing
   - Test help output and error messages
   - Test edge cases (missing args, invalid input, --version)
   Run the test suite and fix any failures.

4. [runner] Package and publish:
   - npm: set bin field in package.json, run `npm publish`
   - Python: create setup.py/pyproject.toml, run `python -m build`
   - Go: run `go install` or create a release with `goreleaser`
   - Rust: run `cargo publish`
   - Add shell completions (if supported)
   Verify the tool installs and runs correctly.

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
