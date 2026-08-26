---
name: terminal-hints
description: Provide intelligent terminal assistance: command suggestions, error interpretation, shell completions, and workflow automation. Use when helping users with terminal commands or diagnosing shell errors.
version: 1.0.0
---

# terminal-hints

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
