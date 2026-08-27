---
name: ssl-cert
description: Manage SSL/TLS certificates with Let's Encrypt or commercial CAs. Use when the goal asks to set up HTTPS, renew certificates, or fix SSL issues.
version: 2.0.0
whenToUse: SSL/TLS setup, certificate renewal, HTTPS configuration, mTLS setup, certificate management
whenNotToUse: DNS configuration (use dns-setup), CDN setup (use cdn-setup), reverse proxy (use nginx-config)
---

# SSL Certificate

Manage SSL/TLS certificates with enterprise patterns.

## Goal pattern

SSL TLS certificate HTTPS Let's Encrypt certbot ACME wildcard renewal

## Parameters

- provider (choice [default: letsencrypt]): Certificate provider
- wildcard (boolean [default: false]): Wildcard certificate
- autoRenew (boolean [default: true]): Automatic renewal

## Steps

### Step 1: [context-gatherer] — Analyze certificate requirements

```bash
# Check existing certificates
ls -la /etc/letsencrypt/live/ 2>/dev/null
openssl x509 -in /etc/letsencrypt/live/example.com/fullchain.pem -noout -subject -dates

# Check certificate expiry
echo | openssl s_client -connect example.com:443 2>/dev/null | openssl x509 -noout -dates

# Check certbot
certbot --version 2>/dev/null
certbot certificates 2>/dev/null
```

- What domains? (single, wildcard, multiple SANs)
- What provider? (Let's Encrypt, DigiCert, Sectigo)
- What server? (Nginx, Apache, Cloudflare)
- What auto-renewal? (certbot, custom script)

### Step 2: [writer] — Configure certificates

**Let's Encrypt with certbot:**
```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx

# Obtain certificate
sudo certbot --nginx \
  -d example.com \
  -d www.example.com \
  --email admin@example.com \
  --agree-tos \
  --non-interactive

# Wildcard certificate (DNS challenge)
sudo certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d "*.example.com" \
  -d example.com
```

**Auto-renewal cron:**
```bash
# /etc/cron.d/certbot
0 0,12 * * * root certbot renew --quiet --deploy-hook "systemctl reload nginx"
```

**Certificate chain verification:**
```bash
# Verify full chain
openssl verify -CAfile /etc/letsencrypt/live/example.com/chain.pem \
  /etc/letsencrypt/live/example.com/fullchain.pem

# Check certificate details
openssl x509 -in /etc/letsencrypt/live/example.com/fullchain.pem -noout -text
```

### Step 3: [runner] — Deploy and verify

```bash
# Test SSL configuration
curl -I https://example.com | grep -i "ssl\|certificate"

# Check certificate grade
# Visit: https://www.ssllabs.com/ssltest/

# Verify certificate chain
openssl s_client -connect example.com:443 -servername example.com < /dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates

# Test auto-renewal
sudo certbot renew --dry-run
```

### Step 4: [reviewer] — Verify SSL works

```bash
# Verify HTTPS redirects
curl -I http://example.com | grep -i "location.*https"

# Check HSTS header
curl -I https://example.com | grep -i "strict-transport"

# Verify certificate expiry
echo | openssl s_client -connect example.com:443 2>/dev/null | openssl x509 -noout -enddate

# Test mTLS (if configured)
curl --cert client.pem --key client-key.pem https://example.com
```

**Verification checklist:**
- [ ] Certificate valid and not expired
- [ ] Full chain present (no intermediate missing)
- [ ] HTTPS redirects work
- [ ] HSTS header present
- [ ] Auto-renewal configured and tested
- [ ] Certificate grade A+ on SSL Labs
- [ ] No mixed content warnings

## Reference Documents

Load deep-dive content with `skill_view('ssl-cert', 'references/guide.md')`.
