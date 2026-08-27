# Api Call Reference Guide

## Overview
Make API calls with authentication, retry logic, and response parsing

## # API Call Skill

Make API calls with authentication, retry logic, and response parsing. This skill demonstrates the execution engine's ability to run Node.js scripts.

## How It Works

1. Receives endpoint, method, and optional data/headers
2. Makes HTTP request to API_BASE_URL + endpoint
3. Handles authentication via API_KEY environment variable
4. Implements retry logic with exponential backoff
5. Returns structured response

## Usage

When the user needs to make an API call, execute this skill with the endpoint and method.

## Security

- API keys are injected via environment variables
- Base URL is configured via API_BASE_URL
- Retry logic prevents excessive requests

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
