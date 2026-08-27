# Api Testing Reference Guide

## Overview
Test REST and GraphQL APIs: write automated tests for endpoints, validate status codes, response schemas, auth flows, and edge cases. Use when the goal asks to test, validate, or verify an API.

## # api-testing

Test REST and GraphQL APIs: write automated tests for endpoints, validate status codes, response schemas, auth flows, and edge cases. Use when the goal asks to test, validate, or verify an API.

## Goal pattern

test api endpoint rest graphql http request validate response status auth

## Parameters

- framework (choice [default: auto]): Test framework

## Steps

1. [analyst] Discover endpoints: parse OpenAPI/Swagger specs, route files, or scan source code for route definitions. List all endpoints with methods, paths, and expected parameters.

2. [analyst] Group tests by endpoint: happy path, error cases (400, 401, 403, 404, 500), boundary values, and auth scenarios (unauthenticated, expired token, insufficient scope). (after: step-1)

3. [analyst] Write test files using the project test framework (vitest, jest, pytest, go test). Include setup for test DB, mocks for external services, and fixtures for request bodies. (after: step-2)

4. [analyst] Run tests and fix failures iteratively. Cover edge cases: empty bodies, invalid JSON, missing required fields, SQL-injection payloads in params. (after: step-3)

5. [analyst] Generate coverage report: total endpoints tested, pass/fail counts, response-time assertions, and schema validation results. (after: step-4)

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
