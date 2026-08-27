# Osint Investigation Reference Guide

## Overview
Conduct open-source intelligence (OSINT) investigations: reconnaissance, data collection, analysis, and reporting. Covers OSINT tools, techniques, and ethical guidelines. Use when gathering intelligence from public sources.

## # osint-investigation

Conduct open-source intelligence (OSINT) investigations: reconnaissance, data collection, analysis, and reporting. Covers OSINT tools, techniques, and ethical guidelines. Use when gathering intelligence from public sources.

## Goal pattern

OSINT open source intelligence investigation reconnaissance data collection analysis public sources

## Steps

0. [context-gatherer] Map the investigation: target (person, company, domain, IP)? What OSINT categories (domain, IP, email, social media, public records)? Ethical/legal constraints?

1. [planner] Plan the investigation:
1. Reconnaissance: domain WHOIS, DNS records, subdomains
2. IP intelligence: geolocation, ASN, reverse DNS
3. Email: breach databases, social media profiles
4. Social media: profile analysis, connections, activity
5. Public records: company filings, certificates
6. Documentation: evidence collection, chain of custody (after: 'step-0')

2. [runner] Conduct the investigation:
1. Run WHOIS and DNS queries
2. Check IP reputation and geolocation
3. Search for email/domain breaches
4. Analyze social media presence
5. Check public records
6. Document all findings with sources (after: 'step-1')

3. [reviewer] Review findings: verify sources, cross-reference data, assess reliability, check legal compliance, produce final report. (after: 'step-2')

## Best Practices

- Follow the skill's methodology step by step
- Verify each step before proceeding to the next
- Use the appropriate tools for each task
- Document any deviations from the standard approach

## Common Patterns

- Start with context gathering to understand the current state
- Plan the implementation before writing code
- Test changes before committing
- Review for security and performance implications

## Troubleshooting

- If the skill fails, check the prerequisites first
- Verify environment variables are set correctly
- Check for conflicting configurations
- Review logs for detailed error messages

## Further Reading

- Refer to the main SKILL.md for complete methodology
- Check official documentation for the specific technology
- Review related skills in the registry for complementary approaches
