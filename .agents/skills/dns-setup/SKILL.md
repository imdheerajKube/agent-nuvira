---
name: dns-setup
description: Configure DNS records and domains. Use when the goal asks to set up DNS, configure domains, or manage DNS records.
version: 2.0.0
whenToUse: Domain configuration, DNS records, email authentication (SPF/DKIM/DMARC), subdomain setup, CDN configuration
whenNotToUse: SSL certificate management (use ssl-cert), CDN setup (use cdn-setup), load balancing (use load-balancer)
---

# DNS Setup

Configure DNS records with enterprise patterns.

## Goal pattern

DNS domain records MX SPF DKIM DMARC A CNAME TXT subdomain

## Parameters

- provider (choice [default: cloudflare]): DNS provider
- emailAuth (boolean [default: true]): Set up email authentication
- cdnIntegration (boolean [default: false]): Integrate with CDN

## Steps

### Step 1: [context-gatherer] — Analyze DNS requirements

```bash
# Check current DNS
dig example.com ANY +noall +answer
dig example.com MX +short
dig example.com TXT +short

# Check existing records
dig example.com A +short
dig example.com CNAME +short
dig www.example.com CNAME +short

# Check email auth
dig example.com TXT | grep -E "spf|dkim|dmarc"
```

- What records needed? (A, AAAA, CNAME, MX, TXT)
- What subdomains? (www, api, mail, staging)
- What email auth? (SPF, DKIM, DMARC)
- What TTL values? (300s for dynamic, 3600s for stable)

### Step 2: [writer] — Create DNS records

**Zone file configuration:**
```dns
; Zone file for example.com
$TTL 3600
@       IN      SOA     ns1.example.com. admin.example.com. (
                        2024010101  ; Serial
                        3600        ; Refresh
                        900         ; Retry
                        604800      ; Expire
                        86400       ; Minimum TTL
                        )

; Nameservers
@       IN      NS      ns1.example.com.
@       IN      NS      ns2.example.com.

; A Records
@       IN      A       203.0.113.10
api     IN      A       203.0.113.20
staging IN      A       203.0.113.30

; CNAME Records
www     IN      CNAME   example.com.
cdn     IN      CNAME   d123456.cloudfront.net.

; MX Records (Email)
@       IN      MX      10 mail.example.com.
@       IN      MX      20 mail2.example.com.

; TXT Records (Email Auth)
@       IN      TXT     "v=spf1 mx a ip4:203.0.113.0/24 -all"
_dmarc  IN      TXT     "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com; pct=100"
default._domainkey IN TXT "v=DKIM1; k=rsa; p=MIIBIjANBgkq..."

; SRV Records (Service Discovery)
_sip._tcp   IN  SRV 10 60 5060 sip.example.com.
_imaps._tcp IN  SRV 10 60 993 mail.example.com.
```

**Cloudflare API configuration:**
```bash
# Create DNS records via API
curl -X POST "https://api.cloudflare.com/client/v4/zones/ZONE_ID/dns_records" \
  -H "Authorization: Bearer API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "type": "A",
    "name": "example.com",
    "content": "203.0.113.10",
    "ttl": 300,
    "proxied": true
  }'

# Create CNAME for www
curl -X POST "https://api.cloudflare.com/client/v4/zones/ZONE_ID/dns_records" \
  -H "Authorization: Bearer API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "type": "CNAME",
    "name": "www",
    "content": "example.com",
    "ttl": 300,
    "proxied": true
  }'
```

### Step 3: [runner] — Apply DNS configuration

```bash
# Verify DNS propagation
dig example.com A +short
dig www.example.com CNAME +short

# Test MX records
dig example.com MX +short
dig example.com TXT | grep spf

# Test DMARC
dig _dmarc.example.com TXT +short

# Check DKIM
dig default._domainkey.example.com TXT +short

# Verify email delivery
# Send test email and check headers
```

### Step 4: [reviewer] — Verify DNS works

```bash
# Check all records
for type in A AAAA CNAME MX TXT NS; do
  echo "=== $type Records ==="
  dig example.com $type +short
done

# Verify email authentication
# Use mail-tester.com or similar

# Check DNS propagation globally
for server in 8.8.8.8 1.1.1.1 208.67.222.222; do
  echo -n "DNS $server: "
  dig @$server example.com A +short
done

# Verify SSL works with DNS
curl -I https://example.com | grep -i "ssl\|certificate"
```

**Verification checklist:**
- [ ] All DNS records resolve correctly
- [ ] Email authentication passes (SPF, DKIM, DMARC)
- [ ] www redirects to apex (or vice versa)
- [ ] TTL values appropriate
- [ ] CDN integration works
- [ ] SSL certificate validates
- [ ] No DNS propagation issues

## Reference Documents

Load deep-dive content with `skill_view('dns-setup', 'references/guide.md')`.
