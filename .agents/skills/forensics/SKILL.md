---
name: forensics
description: Digital forensics: evidence collection, chain of custody, analysis, and reporting. Use when investigating security incidents.
version: 1.0.0
---

# forensics

Digital forensics: evidence collection, chain of custody, analysis, and reporting. Use when investigating security incidents.

## Goal pattern

digital forensics evidence collection chain of custody analysis reporting investigation

## Steps

0. [context-gatherer] Identify evidence sources: what systems need forensic analysis? What evidence exists? What is the chain of custody?

1. [planner] Plan forensic investigation:
1. Evidence collection: disk images, memory dumps, logs
2. Chain of custody: document handling
3. Analysis: timeline, artifacts, indicators
4. Reporting: findings and recommendations
5. Legal: ensure admissibility
6. Preservation: maintain evidence integrity (after: 'step-0')

2. [runner] Conduct investigation:
1. Create forensic images
2. Document chain of custody
3. Analyze evidence
4. Create timeline
5. Write report
6. Preserve evidence (after: 'step-1')

3. [reviewer] Verify: evidence is preserved, chain of custody is documented, analysis is thorough, report is complete. (after: 'step-2')
