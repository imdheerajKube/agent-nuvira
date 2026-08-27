# Approval Tool Reference Guide

## Overview
Implement approval workflows: request approval before dangerous actions, track approval decisions, and enforce approval policies. Use when adding safety gates to agent operations.

## # approval-tool

Implement approval workflows: request approval before dangerous actions, track approval decisions, and enforce approval policies. Use when adding safety gates to agent operations.

## Goal pattern

approval workflow request approval safety gate dangerous action policy enforcement

## Steps

0. [context-gatherer] Map the approval needs: what actions need approval? Who can approve? What is the approval workflow? What is the timeout?

1. [planner] Design the approval system:
1. Action classification: safe, requires-approval, blocked
2. Approval request: present action details, risk assessment
3. Decision: approve, deny, modify
4. Timeout: what happens if no response
5. Audit: log all approval decisions
6. Policy: rules for auto-approve vs manual review (after: 'step-0')

2. [runner] Implement approval workflow:
1. Classify actions by risk level
2. Create approval request UI/format
3. Implement decision handling
4. Add timeout behavior
5. Log all decisions
6. Configure auto-approve rules (after: 'step-1')

3. [reviewer] Verify: approval requests are clear, decisions are recorded, timeout works, policies are enforced. (after: 'step-2')

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
