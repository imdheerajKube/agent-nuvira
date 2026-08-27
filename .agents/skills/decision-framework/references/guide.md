# Decision Framework Reference Guide

## Overview
Apply structured decision-making frameworks: RICE scoring, weighted matrix, decision trees, and ADR (Architecture Decision Records). Use when the goal is to make a systematic, well-documented technical or product decision.

## # decision-framework

Apply structured decision-making frameworks: RICE scoring, weighted matrix, decision trees, and ADR (Architecture Decision Records). Use when the goal is to make a systematic, well-documented technical or product decision.

## Goal pattern

decision framework RICE weighted matrix decision tree ADR architecture decision record evaluation trade-off

## Steps

0. [context-gatherer] Map the decision: what is being decided? What are the options? What criteria matter? Who are the stakeholders? What constraints exist?

1. [planner] Choose and apply the framework:
1. RICE: Reach × Impact × Confidence / Effort for prioritization
2. Weighted matrix: criteria × weights × scores for complex decisions
3. Decision tree: branching logic for conditional decisions
4. ADR: document the decision context, options, rationale, and consequences
5. Pros/cons: structured comparison for simpler decisions
6. Six Thinking Hats: explore from multiple perspectives (after: 'step-0')

2. [runner] Execute the framework:
1. Define options clearly
2. Score each option against criteria
3. Calculate weighted scores or RICE scores
4. Document the analysis
5. Make the recommendation
6. Write the ADR if it's an architecture decision (after: 'step-1')

3. [reviewer] Review the decision: verify scoring is objective, check for bias, validate the recommendation against constraints, document in ADR format. (after: 'step-2')

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
