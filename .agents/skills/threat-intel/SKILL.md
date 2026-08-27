---
name: threat-intel
description: Threat intelligence: IOC collection, threat hunting, attribution, and intelligence sharing. Use when gathering and analyzing threat intelligence.
version: 1.0.0
---

# threat-intel

Threat intelligence: IOC collection, threat hunting, attribution, and intelligence sharing. Use when gathering and analyzing threat intelligence.

## Goal pattern

threat intelligence IOC collection hunting attribution sharing analysis

## Parameters

(none)

## Steps

1. [context-gatherer] Identify threat landscape: what threats are relevant? What intelligence sources exist? What IOCs are known?

2. [planner] Design threat intel program:
1. Collection: feeds, sources, automation
2. Analysis: IOC enrichment, correlation
3. Hunting: proactive threat searching
4. Attribution: identify threat actors
5. Sharing: STIX/TAXII, ISACs
6. Integration: SIEM, SOAR integration (after: step-0)

3. [runner] Implement threat intel:
1. Set up intelligence feeds
2. Automate IOC collection
3. Create hunting queries
4. Analyze collected intelligence
5. Share with community
6. Integrate with security tools (after: step-1)

4. [reviewer] Verify: feeds are active, IOCs are enriched, hunting is effective, intelligence is shared. (after: step-2)
