# Threat Intel Reference Guide

## Overview
Threat intelligence: IOC collection, threat hunting, attribution, and intelligence sharing. Use when gathering and analyzing threat intelligence.

## # threat-intel

Threat intelligence: IOC collection, threat hunting, attribution, and intelligence sharing. Use when gathering and analyzing threat intelligence.

## Goal pattern

threat intelligence IOC collection hunting attribution sharing analysis

## Steps

0. [context-gatherer] Identify threat landscape: what threats are relevant? What intelligence sources exist? What IOCs are known?

1. [planner] Design threat intel program:
1. Collection: feeds, sources, automation
2. Analysis: IOC enrichment, correlation
3. Hunting: proactive threat searching
4. Attribution: identify threat actors
5. Sharing: STIX/TAXII, ISACs
6. Integration: SIEM, SOAR integration (after: 'step-0')

2. [runner] Implement threat intel:
1. Set up intelligence feeds
2. Automate IOC collection
3. Create hunting queries
4. Analyze collected intelligence
5. Share with community
6. Integrate with security tools (after: 'step-1')

3. [reviewer] Verify: feeds are active, IOCs are enriched, hunting is effective, intelligence is shared. (after: 'step-2')

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
