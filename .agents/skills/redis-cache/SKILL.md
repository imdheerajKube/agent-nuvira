---
name: redis-cache
description: Set up Redis caching layer. Use when the goal asks to add caching, session storage, or rate limiting with Redis.
version: 2.0.0
whenToUse: Caching database queries, session storage, rate limiting, pub/sub messaging, real-time leaderboards, job queues
whenNotToUse: Simple key-value storage (use SQLite), persistent relational data (use PostgreSQL), large object storage (use S3)
---

# Redis Cache

Set up Redis caching layer with enterprise-grade patterns.

## Goal pattern

redis cache session store rate limit pub sub queue

## Parameters

- strategy (choice [default: cache-aside]): Caching strategy
- clusterMode (boolean [default: false]): Use Redis Cluster for HA
- evictionPolicy (choice [default: allkeys-lru]): Memory eviction policy

## Steps

### Step 1: [analyst] — Analyze caching requirements

Map the caching needs:
- **Read/write ratio**: High-read workloads benefit most from caching
- **Data volatility**: Frequently changing data needs shorter TTLs
- **Consistency requirements**: Strong consistency needs write-through; eventual consistency works with cache-aside
- **Memory budget**: Estimate working set size (`redis-cli INFO memory`)
- **Access patterns**: Hot keys, range queries, pub/sub channels

```bash
# Check Redis availability
redis-cli ping
# Check current memory usage
redis-cli INFO memory | grep used_memory_human
# Check connected clients
redis-cli INFO clients
```

### Step 2: [analyst] — Implement Redis connection and caching layer

Choose strategy based on requirements:

**Cache-Aside (Lazy Loading)** — Best for read-heavy workloads:
```python
import redis
from functools import wraps

pool = redis.ConnectionPool(
    host='localhost', port=6379, db=0,
    max_connections=20,
    decode_responses=True,
    socket_connect_timeout=5,
    socket_timeout=5,
    retry_on_timeout=True
)
r = redis.Redis(connection_pool=pool)

def cache_result(ttl=300, prefix="cache"):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            key = f"{prefix}:{func.__name__}:{hash(str(args) + str(kwargs))}"
            cached = r.get(key)
            if cached:
                return json.loads(cached)
            result = func(*args, **kwargs)
            r.setex(key, ttl, json.dumps(result))
            return result
        return wrapper
    return decorator
```

**Write-Through** — Best for consistency-critical data:
```python
def write_through(key, data, ttl=300):
    # Write to database first
    db.update(key, data)
    # Then write to cache
    r.setex(key, ttl, json.dumps(data))
    return True
```

**Rate Limiting** — Sliding window pattern:
```python
def is_rate_limited(user_id, max_requests=100, window=60):
    key = f"ratelimit:{user_id}"
    now = time.time()
    pipe = r.pipeline()
    pipe.zremrangebyscore(key, 0, now - window)  # Remove old entries
    pipe.zadd(key, {str(now): now})  # Add current request
    pipe.zcard(key)  # Count requests in window
    pipe.expire(key, window)  # Set expiry
    results = pipe.execute()
    return results[2] > max_requests
```

### Step 3: [analyst] — Configure Redis for production

```bash
# Redis config for production
cat > /etc/redis/redis.conf << 'EOF'
# Memory management
maxmemory 2gb
maxmemory-policy allkeys-lru

# Persistence (RDB + AOF)
save 900 1
save 300 10
appendonly yes
appendfsync everysec

# Security
requirepass YOUR_PASSWORD
rename-command FLUSHALL ""
rename-command FLUSHDB ""

# Performance
tcp-backlog 511
timeout 300
tcp-keepalive 60
databases 16
EOF

# Restart Redis
sudo systemctl restart redis

# Verify configuration
redis-cli CONFIG GET maxmemory
redis-cli CONFIG GET maxmemory-policy
```

### Step 4: [analyst] — Verify caching works correctly

```bash
# Test cache hit/miss
redis-cli SET test:key "hello" EX 60
redis-cli GET test:key

# Monitor cache performance
redis-cli INFO stats | grep -E "keyspace_hits|keyspace_misses"

# Check memory usage
redis-cli INFO memory | grep used_memory_human

# Test rate limiting
redis-cli ZRANGEBYSCORE ratelimit:user1 0 $(date +%s)
```

**Verification checklist:**
- [ ] Cache hit ratio > 80% after warmup
- [ ] No memory leaks (used_memory stable)
- [ ] Connection pool doesn't exhaust (connected_clients < max)
- [ ] Rate limiter blocks excess requests
- [ ] TTLs expire correctly
- [ ] Failover works (kill primary, verify replica promotes)

## Reference Documents

Load deep-dive content with `skill_view('redis-cache', 'references/guide.md')`.
