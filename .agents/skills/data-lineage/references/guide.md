# Data Lineage Reference Guide

## Overview
Data lineage tracking: origin, transformations, dependencies, and impact analysis. Use when tracking data flow through systems.

## # data-lineage

Data lineage tracking: origin, transformations, dependencies, and impact analysis. Use when tracking data flow through systems.

## Goal pattern

data lineage tracking origin transformations dependencies impact analysis

## Steps

0. [context-gatherer] Map data flow: what are the data sources? What transformations occur? What are the downstream consumers?

1. [planner] Design lineage tracking:
1. Capture: metadata at each stage
2. Model: directed acyclic graph
3. Visualize: lineage graphs
4. Impact: analyze downstream effects
5. Compliance: regulatory requirements
6. Integration: catalog, governance (after: 'step-0')

2. [runner] Implement lineage tracking:
1. Instrument data pipelines
2. Capture metadata
3. Build lineage graph
4. Create visualization
5. Implement impact analysis
6. Integrate with catalog (after: 'step-1')

3. [reviewer] Verify: lineage is captured, graph is accurate, impact analysis works, integration is complete. (after: 'step-2')

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
