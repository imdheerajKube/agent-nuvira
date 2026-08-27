---
name: osint-investigation
description: Conduct open-source intelligence (OSINT) investigations: reconnaissance, data collection, analysis, and reporting. Covers OSINT tools, techniques, and ethical guidelines. Use when gathering intelligence from public sources.
version: 1.0.0
---

# osint-investigation

Conduct open-source intelligence (OSINT) investigations: reconnaissance, data collection, analysis, and reporting. Covers OSINT tools, techniques, and ethical guidelines. Use when gathering intelligence from public sources.

## Goal pattern

OSINT open source intelligence investigation reconnaissance data collection analysis public sources

## Parameters

(none)

## Steps

1. [context-gatherer] Map the investigation: target (person, company, domain, IP)? What OSINT categories (domain, IP, email, social media, public records)? Ethical/legal constraints?

2. [planner] Plan the investigation:
1. Reconnaissance: domain WHOIS, DNS records, subdomains
2. IP intelligence: geolocation, ASN, reverse DNS
3. Email: breach databases, social media profiles
4. Social media: profile analysis, connections, activity
5. Public records: company filings, certificates
6. Documentation: evidence collection, chain of custody (after: step-0)

3. [runner] Conduct the investigation:
1. Run WHOIS and DNS queries
2. Check IP reputation and geolocation
3. Search for email/domain breaches
4. Analyze social media presence
5. Check public records
6. Document all findings with sources (after: step-1)

4. [reviewer] Review findings: verify sources, cross-reference data, assess reliability, check legal compliance, produce final report. (after: step-2)
