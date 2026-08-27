---
name: structured-logging
description: Implement structured logging with JSON output. Use when the goal asks to add logging, log aggregation, or log-based debugging.
version: 2.0.0
whenToUse: Application logging, log aggregation, debugging with structured data, compliance logging, audit trails
whenNotToUse: Simple console.log debugging, performance profiling (use APM), metrics collection (use Prometheus)
---

# Structured Logging

Implement structured logging with enterprise patterns.

## Goal pattern

logging structured json log aggregation elk loki Winston pino

## Parameters

- library (choice [default: pino]): Logging library
- transport (choice [default: stdout]): Log transport
- aggregation (choice [default: none]): Log aggregation system

## Steps

### Step 1: [analyst] — Analyze logging requirements

```bash
# Check existing logging
grep -r "console.log\|logger\|winston\|pino" src/ --include="*.ts" | head -10

# Check log levels in use
grep -r "LOG_LEVEL\|loglevel" . --include="*.env*" 2>/dev/null

# Check if log aggregation exists
docker ps | grep -E "elk|loki|fluentd" 2>/dev/null
```

- What log levels needed? (debug, info, warn, error, fatal)
- What context to include? (request ID, user ID, trace ID)
- What transport? (stdout, file, ELK, Loki)
- What compliance? (audit logging, PII masking)

### Step 2: [analyst] — Implement structured logging

**Pino logger setup:**
```typescript
// src/lib/logger.ts
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (bindings) => ({
      pid: bindings.pid,
      hostname: bindings.hostname,
      service: 'myapp',
      version: process.env.APP_VERSION || 'unknown',
    }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    err: pino.stdSerializers.err,
    req: (req) => ({
      method: req.method,
      url: req.url,
      query: req.query,
      params: req.params,
      userAgent: req.headers?.['user-agent'],
      userId: req.headers?.['x-user-id'],
      requestId: req.headers?.['x-request-id'],
    }),
    res: (res) => ({
      statusCode: res.statusCode,
      responseTime: res.responseTime,
    }),
  },
  redact: {
    paths: ['req.headers.authorization', 'req.body.password', 'req.body.creditCard'],
    censor: '[REDACTED]',
  },
});

// Request context middleware
export function requestLogger(req, res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  req.log = logger.child({ requestId: req.id });
  
  const start = Date.now();
  res.on('finish', () => {
    req.log.info({
      req,
      res: { statusCode: res.statusCode, responseTime: Date.now() - start },
      msg: 'request completed',
    });
  });
  
  next();
}

// Business event logging
export function logEvent(event: string, data: Record<string, unknown>) {
  logger.info({ event, ...data, timestamp: new Date().toISOString() });
}

// Error logging with context
export function logError(err: Error, context: Record<string, unknown> = {}) {
  logger.error({ err, ...context, msg: err.message });
}
```

### Step 3: [analyst] — Configure log transport

```bash
# Development: stdout with pretty printing
LOG_LEVEL=debug node -e "require('./dist/lib/logger').logger.info('test')"

# Production: JSON to stdout (collected by Fluentd/DaemonSet)
cat > /etc/fluentd/conf.d/app.conf << 'EOF'
<source>
  @type tail
  path /var/log/app/*.log
  pos_file /var/log/app/app.pos
  tag app
  <parse>
    @type json
    time_key timestamp
    time_format %Y-%m-%dT%H:%M:%S.%NZ
  </parse>
</source>

<match app>
  @type elasticsearch
  host elasticsearch
  port 9200
  index_name app-logs
  <buffer>
    flush_interval 5s
    chunk_limit_size 2M
  </buffer>
</match>
EOF
```

### Step 4: [analyst] — Verify logging works

```bash
# Verify structured output
node -e "require('./dist/lib/logger').logger.info({test: true}, 'structured log')"

# Check logs are collected
curl -s 'http://elasticsearch:9200/app-logs/_search?size=1' | jq '.hits.hits[0]._source'

# Verify PII is redacted
grep -r "password\|creditCard" /var/log/app/ | grep -v REDACTED

# Check log levels
LOG_LEVEL=warn node app.js  # Should not see info/debug logs
```

**Verification checklist:**
- [ ] Logs are valid JSON
- [ ] Request ID present in all request logs
- [ ] PII fields are redacted
- [ ] Error logs include stack trace
- [ ] Log levels filter correctly
- [ ] Logs reach aggregation system
- [ ] No sensitive data in plaintext

## Reference Documents

Load deep-dive content with `skill_view('structured-logging', 'references/guide.md')`.
