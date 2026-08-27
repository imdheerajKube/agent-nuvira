---
name: load-balancer
description: Configure load balancing with Nginx, HAProxy, or cloud LBs. Use when the goal asks to distribute traffic, set up health checks, or configure failover.
version: 2.0.0
whenToUse: Traffic distribution, high availability, health checks, session persistence, SSL termination
whenNotToUse: Single server setups, CDN-only delivery, DNS-based routing only
---

# Load Balancer

Configure load balancing with production patterns.

## Goal pattern

load balancer nginx haproxy health check failover session persistence round-robin

## Parameters

- algorithm (choice [default: least-conn]): Load balancing algorithm
- healthCheck (boolean [default: true]): Enable health checks
- ssl (boolean [default: true]): SSL termination at LB

## Steps

### Step 1: [analyst] — Analyze load balancing requirements

```bash
# Check backend servers
curl -s http://backend1:8080/health
curl -s http://backend2:8080/health
curl -s http://backend3:8080/health

# Check current traffic
netstat -an | grep :80 | wc -l
ss -s
```

- How many backends? (2, 3, 5+)
- What algorithm? (round-robin, least-conn, IP hash)
- What health checks? (HTTP, TCP, custom)
- What session needs? (sticky sessions, stateless)

### Step 2: [analyst] — Configure load balancer

**Nginx load balancer:**
```nginx
upstream backend {
    # Load balancing algorithm
    least_conn;
    
    # Backend servers
    server backend1.example.com:8080 weight=5 max_fails=3 fail_timeout=30s;
    server backend2.example.com:8080 weight=3 max_fails=3 fail_timeout=30s;
    server backend3.example.com:8080 weight=2 backup;
    
    # Session persistence (IP hash)
    # ip_hash;
    
    # Keepalive connections
    keepalive 32;
}

server {
    listen 443 ssl;
    server_name example.com;
    
    ssl_certificate /etc/ssl/certs/example.com.pem;
    ssl_certificate_key /etc/ssl/private/example.com.key;
    
    location / {
        proxy_pass http://backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Health check
        proxy_connect_timeout 5s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        
        # Retry on failure
        proxy_next_upstream error timeout http_502 http_503 http_504;
        proxy_next_upstream_tries 3;
    }
}
```

**HAProxy configuration:**
```haproxy
global
    maxconn 4096
    log /dev/log local0

defaults
    mode http
    timeout connect 5s
    timeout client 30s
    timeout server 30s

frontend http_front
    bind *:80
    redirect scheme https code 301

frontend https_front
    bind *:443 ssl crt /etc/ssl/certs/example.com.pem
    default_backend backend_servers

backend backend_servers
    balance leastconn
    option httpchk GET /health
    http-check expect status 200
    
    server backend1 10.0.0.1:8080 check inter 5s fall 3 rise 2
    server backend2 10.0.0.2:8080 check inter 5s fall 3 rise 2
    server backend3 10.0.0.3:8080 check inter 5s fall 3 rise 2 backup
```

### Step 3: [analyst] — Deploy and test

```bash
# Test load balancing
for i in $(seq 1 10); do
    curl -s http://example.com/whoami
done

# Verify health checks
curl -s http://backend1:8080/health
curl -s http://backend2:8080/health

# Simulate backend failure
docker stop backend1
sleep 5
curl -s http://example.com/whoami  # Should route to backend2/3

# Check connection stats
curl -s http://localhost/nginx_status
```

### Step 4: [analyst] — Verify load balancing works

```bash
# Verify traffic distribution
for i in $(seq 1 100); do
    curl -s http://example.com/whoami | grep "server"
done | sort | uniq -c

# Verify failover
docker stop backend1
for i in $(seq 1 10); do
    curl -s -o /dev/null -w "%{http_code}\n" http://example.com/
done

# Verify SSL termination
curl -I https://example.com | grep -i "ssl\|server"

# Check response times
ab -n 100 -c 10 http://example.com/
```

**Verification checklist:**
- [ ] Traffic distributed across backends
- [ ] Health checks detect failed backends
- [ ] Failover works (no downtime)
- [ ] SSL termination at load balancer
- [ ] Session persistence works (if needed)
- [ ] Response times acceptable
- [ ] No single point of failure

## Reference Documents

Load deep-dive content with `skill_view('load-balancer', 'references/guide.md')`.
