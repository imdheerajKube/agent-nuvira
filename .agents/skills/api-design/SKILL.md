---
name: api-design
description: Design and implement a REST API: gather requirements, design endpoints with proper HTTP methods/status codes, produce an OpenAPI spec, implement routes, and write integration tests. Use when the goal asks to create an API, design endpoints, build a REST service, or scaffold an HTTP backend.
version: 2.0.0
---

# api-design

Design and implement a REST API: gather requirements, design endpoints with proper HTTP methods/status codes, produce an OpenAPI spec, implement routes, and write integration tests. Use when the goal asks to create an API, design endpoints, build a REST service, or scaffold an HTTP backend.

## Goal pattern

API design REST endpoint route HTTP backend server create implement OpenAPI swagger

## Parameters

- framework (choice [default: auto]): HTTP framework (auto-detected from package.json if not specified)
- authType (choice [default: api-key]): Authentication method (default: API key)

## Steps

1. [context-gatherer] ## Step 1: Gather User Preferences

Before designing the API, ask the user for:
- **Resources**: What entities does the API manage? (users, orders, products)
- **Operations**: What actions can be performed? (CRUD, custom actions)
- **Auth**: What authentication method? (API key, JWT, OAuth2, none)
- **Format**: What data format? (JSON, XML, form-encoded)
- **Pagination**: How to handle large lists? (cursor-based, offset, none)

Use sensible defaults if the user doesn't care, but always ask before designing.

## Step 2: Detect Project State

Check the working directory:
```bash
ls -la
cat package.json 2>/dev/null || cat pyproject.toml 2>/dev/null || echo "No project config found"
```

If greenfield (empty directory):
- Choose framework based on language preference
- Initialize project structure
- Set up build tools

If existing project:
- Use the same framework
- Follow existing code style
- Integrate with existing build system

## Step 3: Identify Resources

Map resources to endpoints:
```
Resource     Operations                    Endpoint
─────────────────────────────────────────────────────
Users        List, Get, Create, Update, Delete  /api/users
             Get user by ID                      /api/users/:id
             Get user orders                     /api/users/:id/orders
Orders       List, Get, Create, Cancel           /api/orders
             Get order by ID                     /api/orders/:id
             Cancel order                        /api/orders/:id/cancel
Products     List, Get, Create, Update, Delete   /api/products
             Search products                     /api/products/search
```

2. [planner] ## Step 4: Design Endpoint Contract

### 4.1 REST Conventions

| Verb   | HTTP Method | Path              | Status Code | Description |
|--------|-------------|-------------------|-------------|-------------|
| List   | GET         | /api/resources    | 200         | Get all     |
| Get    | GET         | /api/resources/:id| 200         | Get one     |
| Create | POST        | /api/resources    | 201         | Create one  |
| Update | PUT         | /api/resources/:id| 200         | Update one  |
| Delete | DELETE      | /api/resources/:id| 204         | Delete one  |

### 4.2 Request/Response Schemas

**Create User Request:**
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "secure123"
}
```

**Create User Response (201):**
```json
{
  "id": "usr_123",
  "name": "John Doe",
  "email": "john@example.com",
  "createdAt": "2026-08-27T10:00:00Z"
}
```

**Error Response (400):**
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Email is required",
    "details": [
      {"field": "email", "message": "Email is required"}
    ]
  }
}
```

### 4.3 Pagination

**Cursor-based (recommended):**
```
GET /api/users?limit=20&cursor=usr_123

Response:
{
  "data": [...],
  "pagination": {
    "nextCursor": "usr_456",
    "hasMore": true
  }
}
```

**Offset-based:**
```
GET /api/users?offset=20&limit=20

Response:
{
  "data": [...],
  "pagination": {
    "offset": 20,
    "limit": 20,
    "total": 100
  }
}
```

### 4.4 Auth Middleware

**JWT Authentication:**
```javascript
// middleware/auth.js
function authenticate(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
}
```

**API Key Authentication:**
```javascript
// middleware/auth.js
function authenticateApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: "Invalid API key" });
  }
  next();
}
``` (after: step-1)

3. [writer] ## Step 5: Write OpenAPI Spec

Create `openapi.yaml` or `openapi.json`:

```yaml
openapi: 3.0.3
info:
  title: My API
  version: 1.0.0
  description: REST API for managing users and orders
servers:
  - url: http://localhost:3000
    description: Development
  - url: https://api.example.com
    description: Production
paths:
  /api/users:
    get:
      summary: List all users
      tags: [Users]
      parameters:
        - name: limit
          in: query
          schema:
            type: integer
            default: 20
        - name: cursor
          in: query
          schema:
            type: string
      responses:
        "200":
          description: Successful response
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/UserList"
    post:
      summary: Create a user
      tags: [Users]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/CreateUserRequest"
      responses:
        "201":
          description: User created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/User"
        "400":
          description: Validation error
components:
  schemas:
    User:
      type: object
      properties:
        id:
          type: string
        name:
          type: string
        email:
          type: string
          format: email
        createdAt:
          type: string
          format: date-time
    CreateUserRequest:
      type: object
      required: [name, email, password]
      properties:
        name:
          type: string
        email:
          type: string
          format: email
        password:
          type: string
          minLength: 8
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
security:
  - bearerAuth: []
```

Validate the spec:
```bash
npx swagger-cli validate openapi.yaml
# Or
npx @redocly/cli lint openapi.yaml
``` (after: step-2)

4. [runner] ## Step 6: Implement Routes

### 6.1 Project Structure
```
src/
├── routes/
│   ├── users.ts
│   ├── orders.ts
│   └── index.ts
├── middleware/
│   ├── auth.ts
│   ├── validate.ts
│   └── errorHandler.ts
├── models/
│   ├── user.ts
│   └── order.ts
├── services/
│   ├── userService.ts
│   └── orderService.ts
└── app.ts
```

### 6.2 Express Example
```typescript
// src/routes/users.ts
import { Router, Request, Response } from "express";
import { UserService } from "../services/userService";
import { authenticate } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { CreateUserSchema } from "../schemas/user";

const router = Router();
const userService = new UserService();

// GET /api/users
router.get("/", async (req: Request, res: Response) => {
  const { limit = 20, cursor } = req.query;
  const users = await userService.list(Number(limit), cursor as string);
  res.json(users);
});

// GET /api/users/:id
router.get("/:id", async (req: Request, res: Response) => {
  const user = await userService.getById(req.params.id);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  res.json(user);
});

// POST /api/users
router.post("/",
  authenticate,
  validate(CreateUserSchema),
  async (req: Request, res: Response) => {
    const user = await userService.create(req.body);
    res.status(201).json(user);
  }
);

// PUT /api/users/:id
router.put("/:id",
  authenticate,
  async (req: Request, res: Response) => {
    const user = await userService.update(req.params.id, req.body);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json(user);
  }
);

// DELETE /api/users/:id
router.delete("/:id",
  authenticate,
  async (req: Request, res: Response) => {
    const deleted = await userService.delete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "User not found" });
    }
    res.status(204).send();
  }
);

export default router;
```

### 6.3 FastAPI Example
```python
# src/routes/users.py
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime

router = APIRouter(prefix="/api/users", tags=["users"])

class User(BaseModel):
    id: str
    name: str
    email: str
    created_at: datetime

class CreateUserRequest(BaseModel):
    name: str
    email: str
    password: str

@router.get("/", response_model=List[User])
async def list_users(limit: int = 20, cursor: Optional[str] = None):
    users = await user_service.list(limit, cursor)
    return users

@router.get("/{user_id}", response_model=User)
async def get_user(user_id: str):
    user = await user_service.get_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user

@router.post("/", response_model=User, status_code=201)
async def create_user(request: CreateUserRequest):
    user = await user_service.create(request)
    return user
``` (after: step-3)

5. [tester] ## Step 7: Write Integration Tests

### 7.1 Test Structure
```
tests/
├── users.test.ts
├── orders.test.ts
├── helpers.ts
└── setup.ts
```

### 7.2 Test Examples

**Express + Vitest:**
```typescript
// tests/users.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/app";

describe("Users API", () => {
  let authToken: string;

  beforeAll(async () => {
    // Get auth token
    const res = await request(app)
      .post("/auth/login")
      .send({ email: "test@example.com", password: "password" });
    authToken = res.body.token;
  });

  describe("GET /api/users", () => {
    it("should return list of users", async () => {
      const res = await request(app)
        .get("/api/users")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(res.body).toHaveProperty("data");
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it("should return 401 without auth", async () => {
      await request(app)
        .get("/api/users")
        .expect(401);
    });
  });

  describe("POST /api/users", () => {
    it("should create a user", async () => {
      const res = await request(app)
        .post("/api/users")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          name: "Test User",
          email: "test@example.com",
          password: "password123"
        })
        .expect(201);

      expect(res.body).toHaveProperty("id");
      expect(res.body.name).toBe("Test User");
    });

    it("should return 400 for invalid data", async () => {
      await request(app)
        .post("/api/users")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ name: "" })
        .expect(400);
    });
  });
});
```

### 7.3 Run Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npm test tests/users.test.ts
```

### 7.4 Verify Contract

- All endpoints return correct status codes
- Response shapes match OpenAPI spec
- Auth works correctly (401 for missing token, 403 for invalid)
- Validation works (400 for invalid input)
- Pagination works (cursor/offset) (after: step-4)
