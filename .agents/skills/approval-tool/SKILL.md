---
name: approval-tool
description: Implement approval workflows: request approval before dangerous actions, track approval decisions, and enforce approval policies. Use when adding safety gates to agent operations.
version: 1.0.0
---

# approval-tool

Implement approval workflows: request approval before dangerous actions, track approval decisions, and enforce approval policies. Use when adding safety gates to agent operations.

## Goal pattern

approval workflow request approval safety gate dangerous action policy enforcement

## Parameters

(none)

## Steps

1. [context-gatherer] Map the approval needs: what actions need approval? Who can approve? What is the approval workflow? What is the timeout?

2. [planner] Design the approval system:
1. Action classification: safe, requires-approval, blocked
2. Approval request: present action details, risk assessment
3. Decision: approve, deny, modify
4. Timeout: what happens if no response
5. Audit: log all approval decisions
6. Policy: rules for auto-approve vs manual review (after: step-0)

3. [runner] Implement approval workflow:
1. Classify actions by risk level
2. Create approval request UI/format
3. Implement decision handling
4. Add timeout behavior
5. Log all decisions
6. Configure auto-approve rules (after: step-1)

4. [reviewer] Verify: approval requests are clear, decisions are recorded, timeout works, policies are enforced. (after: step-2)
