---
name: api-design
description: Design and implement a REST API: gather requirements, design endpoints with proper HTTP methods/status codes, produce an OpenAPI spec, implement routes, and write integration tests. Use when the goal asks to create an API, design endpoints, build a REST service, or scaffold an HTTP backend.
version: 1.0.0
---

# api-design

Design and implement a REST API: gather requirements, design endpoints with proper HTTP methods/status codes, produce an OpenAPI spec, implement routes, and write integration tests. Use when the goal asks to create an API, design endpoints, build a REST service, or scaffold an HTTP backend.

## Goal pattern

API design REST endpoint route HTTP backend server create implement OpenAPI swagger

## Parameters

- framework (choice [default: auto]): HTTP framework (auto-detected from package.json if not specified)
- authType (choice [default: api-key]): Authentication method (default: API key)

## Steps

1. [context-gatherer] Gather requirements with evidence:
- Read the project manifest (package.json / pyproject.toml) for the framework (Express, Fastify, Hono, Flask, FastAPI)
- Read existing route files if any — note the patterns (file structure, middleware, error handling)
- Identify the resources (nouns that become endpoints) and operations (CRUD + custom actions)
- Note auth requirements (API keys, JWT, session), rate limiting needs, and pagination strategy
Produce: a resource list, an operation-per-resource matrix, and the framework conventions to follow.

2. [planner] Design the endpoint contract:
- For each resource: list endpoints with HTTP method, path, request/response schema, status codes
- Follow REST conventions: nouns for resources, proper HTTP verbs (GET=read, POST=create, PUT/PATCH=update, DELETE=remove)
- Define error response shape (consistent across all endpoints)
- Plan pagination (cursor-based or offset), filtering, and sorting
- Decide auth middleware placement and error handler strategy
Produce an endpoint matrix table. (after: step-0)

3. [writer] Write the OpenAPI 3.0 spec (openapi.yaml or openapi.json):
- paths: every endpoint with method, parameters, request body schema, response schemas (200/201/400/401/404/500)
- components/schemas: reusable types for request/response bodies
- security: define the auth scheme (Bearer token, API key, etc.)
- Validate the spec: Run `npx swagger-cli validate openapi.yaml` (install if needed)
The spec is the contract — implementation must match it exactly. (after: step-1)

4. [runner] Implement the routes following the framework conventions and the OpenAPI spec:
- Create route files (e.g. src/routes/users.ts, src/routes/orders.ts)
- Apply middleware: auth, validation (request body against schema), error handling
- Use the status codes from the spec (201 for create, 204 for delete, 400 for validation errors)
- Wire routes into the app entry point
Each route handler should validate input, call the service layer, and return the spec-defined response shape. (after: step-2)

5. [tester] Write and run integration tests that verify the contract:
- For each endpoint: test the happy path, error paths (400, 401, 404), and edge cases
- Verify response shapes match the OpenAPI spec (status code + body structure)
- Test auth: unauthenticated requests get 401, unauthorized access gets 403
- Run the tests: Run `npm test` or equivalent
The tests are the proof that implementation matches the spec. (after: step-3)
