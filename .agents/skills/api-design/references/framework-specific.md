# Framework-Specific API Design Guide

## Express.js (Node.js)

### Project Setup
```bash
# Initialize project
mkdir my-api && cd my-api
npm init -y

# Install dependencies
npm install express cors helmet morgan
npm install -D typescript @types/node @types/express ts-node nodemon

# Initialize TypeScript
npx tsc --init
```

### Project Structure
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
├── schemas/
│   ├── user.ts
│   └── order.ts
├── app.ts
└── server.ts
```

### App Setup
```typescript
// src/app.ts
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { errorHandler } from "./middleware/errorHandler";
import routes from "./routes";

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());

// Routes
app.use("/api", routes);

// Error handling
app.use(errorHandler);

export { app };
```

### Router Setup
```typescript
// src/routes/index.ts
import { Router } from "express";
import usersRouter from "./users";
import ordersRouter from "./orders";

const router = Router();

router.use("/users", usersRouter);
router.use("/orders", ordersRouter);

export default router;
```

### Validation Middleware
```typescript
// src/middleware/validate.ts
import { Request, Response, NextFunction } from "express";
import { ZodSchema } from "zod";

export const validate = (schema: ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          details: error.errors,
        },
      });
    }
  };
};
```

---

## FastAPI (Python)

### Project Setup
```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # Linux/macOS
# or
venv\Scripts\activate  # Windows

# Install dependencies
pip install fastapi uvicorn pydantic python-multipart

# Run server
uvicorn main:app --reload
```

### Project Structure
```
src/
├── routes/
│   ├── __init__.py
│   ├── users.py
│   └── orders.py
├── models/
│   ├── __init__.py
│   ├── user.py
│   └── order.py
├── schemas/
│   ├── __init__.py
│   ├── user.py
│   └── order.py
├── services/
│   ├── __init__.py
│   ├── user_service.py
│   └── order_service.py
├── middleware/
│   ├── __init__.py
│   └── auth.py
├── dependencies.py
└── main.py
```

### App Setup
```python
# src/main.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .routes import users, orders
from .middleware.error_handler import add_error_handlers

app = FastAPI(
    title="My API",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routes
app.include_router(users.router, prefix="/api/users", tags=["users"])
app.include_router(orders.router, prefix="/api/orders", tags=["orders"])

# Error handlers
add_error_handlers(app)
```

### Route Example
```python
# src/routes/users.py
from fastapi import APIRouter, HTTPException, Depends, Query
from typing import List, Optional
from ..schemas.user import User, CreateUserRequest
from ..services.user_service import UserService
from ..dependencies import get_user_service, get_current_user

router = APIRouter()

@router.get("/", response_model=List[User])
async def list_users(
    limit: int = Query(20, ge=1, le=100),
    cursor: Optional[str] = None,
    user_service: UserService = Depends(get_user_service),
):
    """List all users with pagination."""
    return await user_service.list(limit, cursor)

@router.get("/{user_id}", response_model=User)
async def get_user(
    user_id: str,
    user_service: UserService = Depends(get_user_service),
):
    """Get a user by ID."""
    user = await user_service.get_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user

@router.post("/", response_model=User, status_code=201)
async def create_user(
    request: CreateUserRequest,
    user_service: UserService = Depends(get_user_service),
    current_user = Depends(get_current_user),
):
    """Create a new user."""
    return await user_service.create(request)
```

---

## Hono (TypeScript)

### Project Setup
```bash
# Initialize project
npm create hono@latest my-api

# Install dependencies
npm install hono @hono/node-server

# Run server
npm run dev
```

### App Setup
```typescript
// src/index.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { usersRouter } from "./routes/users";
import { ordersRouter } from "./routes/orders";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use("*", cors());
app.use("*", secureHeaders());

// Routes
app.route("/api/users", usersRouter);
app.route("/api/orders", ordersRouter);

// Error handling
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
```

### Route Example
```typescript
// src/routes/users.ts
import { Hono } from "hono";
import { z } from "zod";

const app = new Hono();

const CreateUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

app.get("/", async (c) => {
  const limit = Number(c.req.query("limit") || 20);
  const cursor = c.req.query("cursor");
  
  const users = await userService.list(limit, cursor);
  return c.json(users);
});

app.get("/:id", async (c) => {
  const user = await userService.getById(c.req.param("id"));
  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }
  return c.json(user);
});

app.post("/", async (c) => {
  const body = await c.req.json();
  const validated = CreateUserSchema.parse(body);
  
  const user = await userService.create(validated);
  return c.json(user, 201);
});

export { app as usersRouter };
```

---

## Flask (Python)

### Project Setup
```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate

# Install dependencies
pip install flask flask-restful flask-cmarshmallow marshmallow-sqlalchemy

# Run server
flask run
```

### App Setup
```python
# app.py
from flask import Flask
from flask_restful import Api
from flask_cors import CORS
from routes.users import UserList, UserResource
from routes.orders import OrderList, OrderResource

app = Flask(__name__)
CORS(app)
api = Api(app)

# Routes
api.add_resource(UserList, "/api/users")
api.add_resource(UserResource, "/api/users/<string:user_id>")
api.add_resource(OrderList, "/api/orders")
api.add_resource(OrderResource, "/api/orders/<string:order_id>")

if __name__ == "__main__":
    app.run(debug=True)
```

### Route Example
```python
# routes/users.py
from flask_restful import Resource, reqparse
from models.user import User

user_parser = reqparse.RequestParser()
user_parser.add_argument("name", type=str, required=True)
user_parser.add_argument("email", type=str, required=True)
user_parser.add_argument("password", type=str, required=True)

class UserList(Resource):
    def get(self):
        users = User.query.all()
        return [u.to_dict() for u in users], 200
    
    def post(self):
        args = user_parser.parse_args()
        user = User(**args)
        db.session.add(user)
        db.session.commit()
        return user.to_dict(), 201

class UserResource(Resource):
    def get(self, user_id):
        user = User.query.get_or_404(user_id)
        return user.to_dict(), 200
    
    def put(self, user_id):
        user = User.query.get_or_404(user_id)
        args = user_parser.parse_args()
        for key, value in args.items():
            setattr(user, key, value)
        db.session.commit()
        return user.to_dict(), 200
    
    def delete(self, user_id):
        user = User.query.get_or_404(user_id)
        db.session.delete(user)
        db.session.commit()
        return "", 204
```

---

## Common Patterns

### Error Handling
```typescript
// Express
app.use((err, req, res, next) => {
  console.error(err.stack);
  
  if (err.type === "VALIDATION_ERROR") {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: err.message,
        details: err.details,
      },
    });
  }
  
  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
    },
  });
});
```

```python
# FastAPI
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": {
                "code": exc.detail,
                "message": str(exc.detail),
            }
        },
    )
```

### Rate Limiting
```typescript
// Express + express-rate-limit
import rateLimit from "express-rate-limit";

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: "Too many requests",
});

app.use("/api/", limiter);
```

```python
# FastAPI + slowapi
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter

@app.get("/api/users")
@limiter.limit("100/minute")
async def list_users():
    return [...]
```

### Logging
```typescript
// Express + morgan
import morgan from "morgan";

app.use(morgan("combined")); // Apache combined format
```

```python
# FastAPI
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@app.get("/api/users")
async def list_users():
    logger.info("Listing users")
    return [...]
```

### CORS
```typescript
// Express
import cors from "cors";

app.use(cors({
  origin: ["http://localhost:3000", "https://example.com"],
  credentials: true,
}));
```

```python
# FastAPI
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "https://example.com"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

---

## Testing

### Express + Vitest
```typescript
import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app";

describe("Users API", () => {
  it("should list users", async () => {
    const res = await request(app)
      .get("/api/users")
      .expect(200);
    
    expect(res.body).toHaveProperty("data");
  });
});
```

### FastAPI + pytest
```python
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

def test_list_users():
    response = client.get("/api/users")
    assert response.status_code == 200
    assert isinstance(response.json(), list)
```

---

## Deployment

### Docker
```dockerfile
# Dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3000

CMD ["node", "dist/server.js"]
```

### Docker Compose
```yaml
# docker-compose.yml
version: "3.8"

services:
  api:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://user:pass@db:5432/mydb
    depends_on:
      - db
  
  db:
    image: postgres:15-alpine
    environment:
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=pass
      - POSTGRES_DB=mydb
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```
