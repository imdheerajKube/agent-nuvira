# JWT Authentication Patterns

## Token Structure

```javascript
// Access Token (short-lived: 15 minutes)
{
  sub: userId,
  role: 'user',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 15 * 60, // 15 minutes
  type: 'access'
}

// Refresh Token (long-lived: 7 days)
{
  sub: userId,
  type: 'refresh',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days
  jti: uuid() // unique token ID for revocation
}
```

## Implementation

```javascript
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Generate tokens
function generateTokens(user) {
  const accessToken = jwt.sign(
    { sub: user.id, role: user.role, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
  
  const refreshToken = jwt.sign(
    { sub: user.id, type: 'refresh', jti: crypto.randomUUID() },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );
  
  return { accessToken, refreshToken };
}

// Verify middleware
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'access') {
      return res.status(401).json({ error: 'Invalid token type' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Role-based access control
function authorize(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
```

## Refresh Token Flow

```javascript
// Refresh endpoint
app.post('/auth/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  
  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    
    // Check if token is revoked
    const isRevoked = await redis.get(`revoked:${decoded.jti}`);
    if (isRevoked) {
      return res.status(401).json({ error: 'Token revoked' });
    }
    
    // Get user
    const user = await db.users.findById(decoded.sub);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    // Generate new tokens
    const tokens = generateTokens(user);
    
    // Revoke old refresh token
    await redis.set(`revoked:${decoded.jti}`, 'true', 'EX', 7 * 24 * 60 * 60);
    
    res.json(tokens);
  } catch (err) {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// Logout endpoint
app.post('/auth/logout', authenticate, async (req, res) => {
  const { refreshToken } = req.body;
  
  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    await redis.set(`revoked:${decoded.jti}`, 'true', 'EX', 7 * 24 * 60 * 60);
    res.json({ message: 'Logged out' });
  } catch (err) {
    res.json({ message: 'Logged out' });
  }
});
```

## Security Best Practices

1. **Use short-lived access tokens** (15 minutes max)
2. **Store refresh tokens securely** (httpOnly cookie or secure storage)
3. **Implement token revocation** (Redis blacklist)
4. **Validate token type** (access vs refresh)
5. **Use different secrets** for access and refresh tokens
6. **Rotate secrets periodically**
7. **Never store sensitive data in JWT payload**
8. **Use HTTPS only**
9. **Implement rate limiting** on auth endpoints
10. **Log authentication events** for audit trail
