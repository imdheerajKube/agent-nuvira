---
name: cdn-setup
description: Configure CDN for static assets. Use when the goal asks to set up CDN, optimize asset delivery, or reduce latency.
version: 2.0.0
whenToUse: Static asset delivery, global content distribution, cache optimization, DDoS protection, edge computing
whenNotToUse: Dynamic API responses (use application caching), database queries, real-time WebSocket
---

# CDN Setup

Configure CDN for optimal content delivery.

## Goal pattern

CDN content delivery network static assets cache edge cloudflare cloudfront

## Parameters

- provider (choice [default: cloudflare]): CDN provider
- caching (choice [default: aggressive]): Caching strategy
- ssl (boolean [default: true]): SSL termination at edge

## Steps

### Step 1: [analyst] — Analyze content and traffic patterns

```bash
# Check current asset sizes
find public/ -type f -exec ls -lh {} \; | sort -k5 -h | tail -20

# Check existing CDN setup
curl -I https://example.com/static/bundle.js 2>/dev/null | grep -i "cf-ray\|x-amz-cf\|x-fastly"

# Check DNS
dig example.com +short
dig CNAME example.com +short
```

- What content to serve? (images, JS, CSS, videos)
- What origin server? (S3, EC2, GCS, custom)
- What cache behavior? (long TTL for static, short for HTML)
- What security needs? (DDoS protection, WAF, rate limiting)

### Step 2: [analyst] — Configure CDN

**Cloudflare configuration:**
```javascript
// wrangler.toml (Cloudflare Workers for edge logic)
name = "myapp-cdn"
main = "src/worker.ts"
compatibility_date = "2024-01-01"

[site]
bucket = "./public"

# Cache rules
[[rules]]
pattern = "*.js"
cache = true
ttl = 31536000  # 1 year

[[rules]]
pattern = "*.css"
cache = true
ttl = 31536000

[[rules]]
pattern = "*.html"
cache = true
ttl = 3600  # 1 hour
```

**AWS CloudFront distribution:**
```json
{
  "CallerReference": "myapp-2024",
  "Origins": {
    "Quantity": 2,
    "Items": [
      {
        "Id": "s3-static",
        "DomainName": "myapp-static.s3.amazonaws.com",
        "S3OriginConfig": {
          "OriginAccessIdentity": ""
        }
      },
      {
        "Id": "api-origin",
        "DomainName": "api.example.com",
        "CustomOriginConfig": {
          "HTTPPort": 80,
          "HTTPSPort": 443,
          "OriginProtocolPolicy": "https-only"
        }
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3-static",
    "ViewerProtocolPolicy": "redirect-to-https",
    "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6",  # CachingOptimized
    "Compress": true
  },
  "CacheBehaviors": {
    "Quantity": 2,
    "Items": [
      {
        "PathPattern": "/api/*",
        "TargetOriginId": "api-origin",
        "ViewerProtocolPolicy": "https-only",
        "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",  # CachingDisabled
        "OriginRequestPolicyId": "216adef6-5c7f-47e4-b989-5492eafa07d3"
      },
      {
        "PathPattern": "/static/*",
        "TargetOriginId": "s3-static",
        "ViewerProtocolPolicy": "redirect-to-https",
        "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6",
        "Compress": true
      }
    ]
  },
  "CustomErrorResponses": {
    "Quantity": 1,
    "Items": [
      {
        "ErrorCode": 404,
        "ResponsePagePath": "/404.html",
        "ResponseCode": "404",
        "ErrorCachingMinTTL": 300
      }
    ]
  },
  "ViewerCertificate": {
    "ACMCertificateArn": "arn:aws:acm:us-east-1:123456789:certificate/abc123",
    "SSLSupportMethod": "sni-only",
    "MinimumProtocolVersion": "TLSv1.2_2021"
  },
  "WebACLId": "arn:aws:wafv2:us-east-1:123456789:global/webacl/myapp/abc123"
}
```

### Step 3: [analyst] — Deploy CDN configuration

```bash
# Cloudflare: deploy worker
npm run wrangler deploy

# CloudFront: create distribution
aws cloudfront create-distribution --distribution-config file://cloudfront.json

# Verify CDN is working
curl -I https://example.com/static/bundle.js | grep -i "cf-ray\|x-cache\|age"

# Purge cache
curl -X POST "https://api.cloudflare.com/client/v4/zones/ZONE_ID/purge_cache" \
  -H "Authorization: Bearer API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"purge_everything":true}'
```

### Step 4: [analyst] — Verify CDN performance

```bash
# Check cache hit ratio
curl -s "https://api.cloudflare.com/client/v4/zones/ZONE_ID/analytics/dashboard" \
  -H "Authorization: Bearer API_TOKEN" | jq '.result.totals.requests'

# Test global latency
for region in us-west us-east eu-west ap-south; do
  echo -n "$region: "
  curl -o /dev/null -s -w "%{time_total}s\n" https://example.com/
done

# Verify SSL
openssl s_client -connect example.com:443 -servername example.com

# Check headers
curl -I https://example.com/static/bundle.js | grep -E "Cache-Control|ETag|Vary"
```

**Verification checklist:**
- [ ] Cache hit ratio > 80%
- [ ] SSL grade A+
- [ ] Static assets served from edge
- [ ] API requests pass through to origin
- [ ] Cache headers correct (Cache-Control, ETag)
- [ ] DDoS protection enabled
- [ ] Global latency < 100ms

## Reference Documents

Load deep-dive content with `skill_view('cdn-setup', 'references/guide.md')`.
