---
name: compliance-check
description: Check regulatory compliance: GDPR, HIPAA, SOC2, PCI-DSS. Covers requirements mapping, gap analysis, control implementation, and audit preparation. Use when ensuring an application meets compliance standards.
version: 1.0.0
---

# compliance-check

Check regulatory compliance: GDPR, HIPAA, SOC2, PCI-DSS. Covers requirements mapping, gap analysis, control implementation, and audit preparation. Use when ensuring an application meets compliance standards.

## Goal pattern

compliance GDPR HIPAA SOC2 PCI-DSS audit requirements gap analysis controls regulatory

## Parameters

(none)

## Steps

1. [context-gatherer] Map the compliance landscape: what regulations apply (GDPR, HIPAA, SOC2, PCI-DSS)? What data is processed? What controls exist? What gaps are known?

2. [planner] Plan the compliance check:
1. Requirements mapping: regulation → specific requirements → current controls
2. Gap analysis: what requirements are not met
3. Control implementation: technical and organizational measures
4. Documentation: policies, procedures, evidence
5. Audit preparation: evidence collection, walkthrough readiness
6. Continuous monitoring: ongoing compliance checks (after: step-0)

3. [runner] Execute the check:
1. Map requirements to current implementation
2. Identify gaps
3. Implement missing controls
4. Create documentation
5. Collect evidence
6. Prepare audit materials (after: step-1)

4. [reviewer] Review: verify all requirements addressed, evidence is sufficient, controls are effective, documentation is complete. (after: step-2)
