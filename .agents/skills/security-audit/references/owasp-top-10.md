# OWASP Top 10 (2021) Security Risks

## A01:2021 – Broken Access Control

**Description:** Restrictions on what authenticated users are allowed to do are not properly enforced.

**Common Vulnerabilities:**
- Violation of the principle of least privilege
- Bypassing access control checks by modifying the URL, API requests, or HTML page
- Viewing or editing someone else's account by providing its unique identifier
- Accessing API with missing access controls for POST, PUT, and DELETE
- Escalating privileges by acting as a user without being logged in

**Prevention:**
```javascript
// BAD: Client-side access control
if (user.role === 'admin') {
  showAdminPanel();
}

// GOOD: Server-side access control
app.get('/admin', authenticate, authorize('admin'), (req, res) => {
  // Only accessible by admin users
});

// Middleware for access control
function authorize(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}
```

## A02:2021 – Cryptographic Failures

**Description:** Failures related to cryptography which often leads to exposure of sensitive data.

**Common Vulnerabilities:**
- Data transmitted in clear text (HTTP, FTP, SMTP)
- Old or weak cryptographic algorithms
- Default crypto keys in use
- Missing or weak crypto key management

**Prevention:**
```javascript
// BAD: Storing passwords in plain text
await db.query('INSERT INTO users (password) VALUES ($1)', [password]);

// GOOD: Using bcrypt for password hashing
const bcrypt = require('bcrypt');
const SALT_ROUNDS = 12;
const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
await db.query('INSERT INTO users (password) VALUES ($1)', [hashedPassword]);

// GOOD: Using AES-256 for encryption
const crypto = require('crypto');
const algorithm = 'aes-256-gcm';
const key = crypto.randomBytes(32);
const iv = crypto.randomBytes(16);

function encrypt(text) {
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return { encrypted, iv: iv.toString('hex'), authTag: authTag.toString('hex') };
}
```

## A03:2021 – Injection

**Description:** User-supplied data is not validated, filtered, or sanitized by the application.

**Common Vulnerabilities:**
- SQL injection
- NoSQL injection
- OS command injection
- LDAP injection
- Cross-site scripting (XSS)

**Prevention:**
```javascript
// BAD: SQL injection vulnerability
const query = `SELECT * FROM users WHERE id = ${userId}`;
db.query(query);

// GOOD: Parameterized query
const query = 'SELECT * FROM users WHERE id = $1';
db.query(query, [userId]);

// GOOD: Using ORM (e.g., Prisma)
const user = await prisma.user.findUnique({
  where: { id: userId }
});

// GOOD: Input validation with Joi
const schema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required()
});
const { error, value } = schema.validate(req.body);
```

## A04:2021 – Insecure Design

**Description:** Risks related to design flaws, missing or ineffective security controls.

**Prevention:**
- Use secure design patterns and reference architectures
- Integrate security language and controls into user stories
- Integrate threat modeling into the development lifecycle
- Write integration and unit tests to validate all critical flows

## A05:2021 – Security Misconfiguration

**Description:** Missing appropriate security hardening across any part of the application stack.

**Common Vulnerabilities:**
- Missing appropriate security hardening
- Improperly configured permissions on cloud services
- Unnecessary features enabled
- Default accounts and passwords enabled
- Error handling reveals stack traces

**Prevention:**
```javascript
// GOOD: Secure Express.js configuration
const helmet = require('helmet');
app.use(helmet());

// GOOD: CORS configuration
const cors = require('cors');
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || [],
  credentials: true
}));

// GOOD: Rate limiting
const rateLimit = require('express-rate-limit');
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
}));
```

## A06:2021 – Vulnerable and Outdated Components

**Description:** Using components (libraries, frameworks) with known vulnerabilities.

**Prevention:**
```bash
# Check for vulnerable dependencies
npm audit
yarn audit
pip check

# Use Snyk for continuous monitoring
snyk test
snyk monitor

# Keep dependencies updated
npm update
npm install <package>@latest
```

## A07:2021 – Identification and Authentication Failures

**Description:** Confirmation of the user's identity, authentication, and session management is not implemented correctly.

**Prevention:**
```javascript
// GOOD: Strong password policy
const passwordPolicy = {
  minLength: 12,
  requireUppercase: true,
  requireLowercase: true,
  requireNumbers: true,
  requireSpecialChars: true
};

// GOOD: Multi-factor authentication
const speakeasy = require('speakeasy');
const secret = speakeasy.generateSecret();
const token = speakeasy.totp.verify({
  secret: secret.base32,
  encoding: 'base32',
  token: req.body.token
});

// GOOD: Session management
const session = require('express-session');
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true, // HTTPS only
    httpOnly: true, // No JavaScript access
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));
```

## A08:2021 – Software and Data Integrity Failures

**Description:** Code and infrastructure that does not protect against integrity violations.

**Prevention:**
- Use digital signatures to verify software/data
- Ensure libraries and dependencies are consuming trusted repositories
- Use a software supply chain security tool (OWASP Dependency-Check, OWASP CycloneDX)
- Ensure CI/CD pipeline has proper segregation and configuration

## A09:2021 – Security Logging and Monitoring Failures

**Description:** Insufficient logging, detection, monitoring, and active response.

**Prevention:**
```javascript
// GOOD: Security event logging
const winston = require('winston');
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'security.log' })
  ]
});

// Log authentication events
logger.info('Login attempt', {
  userId: user.id,
  ip: req.ip,
  userAgent: req.headers['user-agent'],
  success: true
});

// Log failed attempts
logger.warn('Failed login attempt', {
  email: req.body.email,
  ip: req.ip,
  attemptCount: failedAttempts
});
```

## A10:2021 – Server-Side Request Forgery (SSRF)

**Description:** SSRF flaws occur when a web application fetches a remote resource without validating the user-supplied URL.

**Prevention:**
```javascript
// BAD: Fetching user-supplied URL without validation
const response = await fetch(req.body.url);

// GOOD: URL validation and allowlist
const allowedHosts = ['api.example.com', 'cdn.example.com'];
const url = new URL(req.body.url);

if (!allowedHosts.includes(url.hostname)) {
  throw new Error('Invalid URL host');
}

// GOOD: Using a proxy service
const response = await fetch(`https://proxy.example.com/fetch?url=${encodeURIComponent(req.body.url)}`);
```
