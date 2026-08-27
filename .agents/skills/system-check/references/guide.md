# System Check Reference Guide

## Overview
Check system health, disk space, memory, CPU, and running processes

## # System Check Skill

Check system health, disk space, memory, CPU, and running processes. This skill demonstrates the execution engine's ability to run shell scripts.

## How It Works

1. Receives check type and threshold parameters
2. Executes system commands to gather metrics
3. Compares against thresholds
4. Returns structured health report

## Usage

When the user wants to check system health, execute this skill with the check type.

## Security

- No API keys required (system-level checks only)
- Read-only operations (no modifications to system)
- Timeout protection prevents hanging

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
