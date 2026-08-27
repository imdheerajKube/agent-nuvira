---
name: nginx-config
description: Configure Nginx as reverse proxy, load balancer, or web server. Use when the goal asks to set up Nginx, configure SSL, or optimize web serving.
version: 2.0.0
whenToUse: Reverse proxy setup, load balancing, SSL/TLS termination, static file serving, rate limiting, caching
whenNotToUse: Application-level routing (use the app framework), TCP/UDP load balancing (use HAProxy), WebSocket-heavy (consider Node.js)
---

# Nginx Configuration

Configure Nginx with production-grade patterns.

## Goal pattern

nginx reverse proxy load balancer web server ssl tls

## Parameters

- role (choice [default: reverse-proxy]): Nginx role
- sslProvider (choice [default: letsencrypt]): SSL certificate provider
- caching (boolean [default: true]): Enable proxy caching

## Steps

### Step 1: [analyst] — Analyze serving requirements

```bash
# Check Nginx version and modules
nginx -V 2>&1 | grep -o "with-[^ ]*"

# Check current config
nginx -t
cat /etc/nginx/nginx.conf

# Check SSL certificates
ls -la /etc/letsencrypt/live/ 2>/dev/null
openssl x509 -in /etc/letsencrypt/live/example.com/fullchain.pem -noout -dates

# Check ports in use
ss -tlnp | grep -E ":(80|443|8080)"
```

- What role? (reverse proxy, load balancer, web server)
- What backends? (Node.js, Python, Go, static files)
- What SSL requirements? (Let's Encrypt, custom cert, mTLS)
- What rate limits? (per-IP, per-endpoint, global)
- What caching? (proxy cache, microcaching, browser cache)

### Step 2: [analyst] — Write Nginx configuration

**Reverse proxy with SSL:**
```nginx
# /etc/nginx/sites-available/myapp.conf
upstream backend {
    least_conn;
    server 127.0.0.1:3000 weight=3;
    server 127.0.0.1:3001 weight=2;
    server 127.0.0.1:3002 backup;
    
    keepalive 32;
}

# Rate limiting zone
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=login:10m rate=1r/s;

server {
    listen 80;
    server_name example.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name example.com;

    # SSL configuration
    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
    
    # OCSP stapling
    ssl_stapling on;
    ssl_stapling_verify on;
    resolver 8.8.8.8 8.8.4.4 valid=300s;

    # Security headers
    add_header Strict-Transport-Security "max-age=63072000" always;
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Content-Security-Policy "default-src 'self'" always;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    # Proxy settings
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";

    # API endpoints
    location /api/ {
        limit_req zone=api burst=20 nodelay;
        
        proxy_pass http://backend;
        proxy_connect_timeout 5s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        
        proxy_buffering on;
        proxy_buffer_size 4k;
        proxy_buffers 8 4k;
    }

    # Login endpoint (stricter rate limit)
    location /api/auth/login {
        limit_req zone=login burst=3 nodelay;
        proxy_pass http://backend;
    }

    # Static files
    location /static/ {
        alias /var/www/static/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # Health check
    location /health {
        access_log off;
        return 200 "OK";
    }
}
```

**Load balancer configuration:**
```nginx
upstream app_cluster {
    least_conn;
    server app1.example.com:8080 weight=5;
    server app2.example.com:8080 weight=3;
    server app3.example.com:8080 weight=2 backup;
    
    # Health checks (Nginx Plus or third-party module)
    # health_check interval=10 fails=3 passes=2;
}

server {
    listen 80;
    location / {
        proxy_pass http://app_cluster;
    }
}
```

### Step 3: [analyst] — Apply and test configuration

```bash
# Test configuration
nginx -t

# Reload without downtime
nginx -s reload

# Verify SSL
openssl s_client -connect example.com:443 -servername example.com

# Test rate limiting
for i in $(seq 1 15); do
    curl -s -o /dev/null -w "%{http_code}\n" http://localhost/api/test
done

# Check logs
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log

# Monitor connections
curl http://localhost/nginx_status
```

### Step 4: [analyst] — Verify configuration works

```bash
# Test SSL grade (should be A+)
curl -s "https://api.ssllabs.com/api/v3/analyze?host=example.com"

# Verify security headers
curl -I https://example.com | grep -E "Strict-Transport|X-Frame|X-Content-Type"

# Test load balancing
for i in $(seq 1 10); do
    curl -s http://example.com/api/whoami
done

# Check rate limiting
ab -n 100 -c 10 http://localhost/api/test
```

**Verification checklist:**
- [ ] SSL grade A+ on SSL Labs
- [ ] All security headers present
- [ ] Rate limiting blocks excess requests
- [ ] Load balancing distributes traffic
- [ ] Gzip compression reduces transfer size
- [ ] Static file caching works (304 responses)
- [ ] No 502/504 errors in logs
- [ ] Health checks return 200

## Reference Documents

Load deep-dive content with `skill_view('nginx-config', 'references/reverse-proxy.md')`.
