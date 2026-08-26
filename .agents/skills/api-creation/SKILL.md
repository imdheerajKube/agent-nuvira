---
name: api-creation
description: Create a complete API: design endpoints, implement routes, add auth/rate-limiting, write tests, generate OpenAPI docs, and deploy. Use when the goal asks to create an API, build a backend service, or scaffold an HTTP server with routes.
version: 1.0.0
---

# api-creation

Create a complete API: design endpoints, implement routes, add auth/rate-limiting, write tests, generate OpenAPI docs, and deploy. Use when the goal asks to create an API, build a backend service, or scaffold an HTTP server with routes.

## Goal pattern

API create build backend service REST GraphQL HTTP server routes endpoints implement deploy

## Parameters

- framework (choice [default: auto]): HTTP framework — express, fastify, hono, flask, fastapi, spring, auto
- database (choice [default: auto]): Database — postgresql, mongodb, sqlite, mysql, in-memory, auto
- auth (choice [default: jwt]): Authentication method — jwt, api-key, oauth2, session, none

## Steps

1. [context-gatherer] Analyze the project and API requirements:
   - Read package.json / pyproject.toml for framework (Express, Fastify, Hono, Flask, FastAPI, Spring Boot)
   - Identify resources (nouns → endpoints) and operations (CRUD)
   - Note auth requirements (API key, JWT, OAuth2)
   - Note database (PostgreSQL, MongoDB, SQLite, in-memory)
   - Note deployment target (local, Docker, cloud)
   Produce: resource list, framework choice, auth strategy, and database plan.

2. [writer] Implement the API:
   - Set up the project structure (routes/, models/, middleware/, utils/)
   - Implement route handlers for each resource
   - Add input validation (Joi, Zod, Pydantic, express-validator)
   - Add error handling middleware (consistent error response format)
   - Add auth middleware (JWT verification, API key check)
   - Add rate limiting (express-rate-limit, slowapi)
   - Wire everything into the app entry point
   Follow REST conventions: proper HTTP methods, status codes, and response shapes.

3. [writer] Generate OpenAPI/Swagger documentation:
   - Create openapi.yaml or openapi.json with all endpoints
   - Define request/response schemas
   - Add authentication definitions
   - Add example requests and responses
   - Set up Swagger UI (if web framework supports it)
   The spec is the contract — implementation must match it exactly.

4. [tester] Write and run integration tests:
   - Test each endpoint: happy path, error paths (400, 401, 404, 500)
   - Test auth: unauthenticated → 401, unauthorized → 403
   - Test validation: invalid input → 400 with error details
   - Test edge cases: empty body, missing fields, duplicate resources
   - Run the full test suite: `npm test` or `pytest`
   All tests must pass before proceeding.

5. [runner] Set up deployment:
   - Create Dockerfile (multi-stage build)
   - Create docker-compose.yml (if database needed)
   - Add health check endpoint (GET /health)
   - Add environment variable configuration
   - Create a README with API documentation and usage examples
   - Verify the app starts and responds to requests
