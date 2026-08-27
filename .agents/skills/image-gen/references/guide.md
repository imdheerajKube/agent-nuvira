# Image Gen Reference Guide

## Overview
Generate images using AI APIs (OpenAI DALL-E, Stability AI, etc.)

## # Image Generation Skill

Generate images using AI APIs. This skill demonstrates the execution engine's ability to run Python scripts with API key injection.

## How It Works

1. Receives a prompt and optional parameters
2. Calls the OpenAI DALL-E API to generate an image
3. Saves the result to a file
4. Returns the file path

## Usage

When the user asks to generate an image, execute this skill with the prompt as the argument.

## Security

- API keys are injected via environment variables (never hardcoded)
- Provider credentials (ANTHROPIC_API_KEY, OPENAI_API_KEY) are blocked from passthrough for security
- This skill requires the user to set OPENAI_API_KEY in their environment

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
