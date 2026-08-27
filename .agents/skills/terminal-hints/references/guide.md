# Terminal Hints Reference Guide

## Overview
Provide intelligent terminal assistance: command suggestions, error interpretation, shell completions, and workflow automation. Use when helping users with terminal commands or diagnosing shell errors.

## # terminal-hints

Provide intelligent terminal assistance: command suggestions, error interpretation, shell completions, and workflow automation. Use when helping users with terminal commands or diagnosing shell errors.

## Goal pattern

terminal hints command suggestion error interpretation shell completion workflow automation

## Steps

0. [context-gatherer] Map the terminal context: what shell (bash, zsh, fish, PowerShell)? What was the user trying to do? What error occurred?

1. [planner] Plan the terminal assistance:
1. Error interpretation: parse error messages, suggest fixes
2. Command suggestions: based on partial input or intent
3. Shell completions: tab completion for commands
4. Workflow automation: alias, function, or script suggestions
5. Cross-platform: handle Windows/Linux/macOS differences
6. Safety: warn about destructive commands (after: 'step-0')

2. [runner] Provide terminal assistance:
1. Parse the error message
2. Identify the likely cause
3. Suggest the fix command
4. Explain what the command does
5. Warn about side effects
6. Offer to execute or let user run it (after: 'step-1')

3. [reviewer] Verify: suggestion is correct, command is safe, explanation is clear, cross-platform compatible. (after: 'step-2')

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
