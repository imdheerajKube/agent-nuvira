# REST API Best Practices

## URL Design

### Use Nouns, Not Verbs
```
# BAD
GET /getUsers
POST /createUser
DELETE /deleteUser/123

# GOOD
GET /users
POST /users
DELETE /users/123
```

### Resource Hierarchy
```
GET /users                    # List users
GET /users/123               # Get user 123
POST /users                   # Create user
PUT /users/123               # Update user 123
DELETE /users/123            # Delete user 123

GET /users/123/orders       # List orders for user 123
GET /users/123/orders/456   # Get order 456 for user 123
```

### Query Parameters for Filtering
```
GET /users?status=active&role=admin&page=1&limit=20
GET /products?category=electronics&min_price=100&max_price=500
GET /orders?created_after=2024-01-01&sort=created_at&order=desc
```

## HTTP Methods

| Method | Idempotent | Safe | Use Case |
|--------|------------|------|----------|
| GET | Yes | Yes | Retrieve resources |
| POST | No | No | Create resources |
| PUT | Yes | No | Replace resource |
| PATCH | No | No | Partial update |
| DELETE | Yes | No | Delete resource |

## Status Codes

### Success (2xx)
- `200 OK` — Successful request
- `201 Created` — Resource created
- `204 No Content` — Successful deletion
- `206 Partial Content` — Range request

### Client Error (4xx)
- `400 Bad Request` — Invalid input
- `401 Unauthorized` — Authentication required
- `403 Forbidden` — Insufficient permissions
- `404 Not Found` — Resource not found
- `409 Conflict` — Resource conflict
- `422 Unprocessable Entity` — Validation error
- `429 Too Many Requests` — Rate limit exceeded

### Server Error (5xx)
- `500 Internal Server Error` — Server error
- `502 Bad Gateway` — Upstream error
- `503 Service Unavailable` — Service unavailable

## Request/Response Format

### JSON Structure
```json
// Success response
{
  "success": true,
  "data": {
    "id": 123,
    "name": "John Doe",
    "email": "john@example.com"
  }
}

// List response
{
  "success": true,
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "pages": 5
  }
}

// Error response
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input",
    "details": [
      {
        "field": "email",
        "message": "Must be a valid email address"
      }
    ]
  }
}
```

## Authentication

### JWT Tokens
```javascript
// Generate token
const jwt = require('jsonwebtoken');
const token = jwt.sign(
  { userId: user.id, role: user.role },
  process.env.JWT_SECRET,
  { expiresIn: '24h' }
);

// Verify token
const decoded = jwt.verify(token, process.env.JWT_SECRET);
```

### API Keys
```javascript
// Middleware to validate API key
function validateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || !isValidApiKey(apiKey)) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid API key' }
    });
  }
  next();
}
```

## Rate Limiting

```javascript
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests, please try again later'
    }
  }
});

app.use('/api/', limiter);
```

## Versioning

### URL Versioning (Recommended)
```
/api/v1/users
/api/v2/users
```

### Header Versioning
```
Accept: application/vnd.myapi.v1+json
```

## Pagination

### Offset-Based
```
GET /users?page=2&limit=20
```

### Cursor-Based (Recommended)
```
GET /users?cursor=eyJpZCI6MTIzfQ&limit=20
```

## Sorting and Filtering

```
GET /users?sort=name:asc,created_at:desc
GET /products?filter[category]=electronics&filter[min_price]=100
```

## Error Handling

```javascript
// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';
  
  res.status(status).json({
    success: false,
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    }
  });
});

// Custom error class
class AppError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.status = statusCode;
    this.code = code;
  }
}

// Usage
throw new AppError('User not found', 404, 'NOT_FOUND');
```

## Documentation

### OpenAPI/Swagger
```yaml
openapi: 3.0.0
info:
  title: My API
  version: 1.0.0
paths:
  /users:
    get:
      summary: List users
      responses:
        '200':
          description: Successful response
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/User'
```
