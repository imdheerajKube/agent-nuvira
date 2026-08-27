# Capacity Planning Reference Guide

## Overview
Capacity planning: load testing, performance baselines, growth forecasting, and scaling strategies. Use when planning for system growth.

## # capacity-planning

Capacity planning: load testing, performance baselines, growth forecasting, and scaling strategies. Use when planning for system growth.

## Goal pattern

capacity planning load testing performance baseline growth forecasting scaling

## Steps

0. [context-gatherer] Map the current capacity: what are the performance baselines? What is the expected growth? What are the scaling limits?

1. [planner] Design capacity plan:
1. Baselines: current performance metrics
2. Load testing: simulate expected traffic
3. Forecasting: project growth over 6-12 months
4. Scaling: horizontal vs vertical scaling
5. Thresholds: when to trigger scaling
6. Budget: cost of additional capacity (after: 'step-0')

2. [runner] Implement capacity planning:
1. Establish performance baselines
2. Run load tests
3. Create growth forecast
4. Implement auto-scaling
5. Set up scaling alerts
6. Document capacity plan (after: 'step-1')

3. [reviewer] Verify: baselines are accurate, load tests pass, scaling works, forecast is realistic. (after: 'step-2')

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
