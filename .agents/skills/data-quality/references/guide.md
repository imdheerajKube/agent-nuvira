# Data Quality Reference Guide

## Overview
Data quality management: validation rules, profiling, cleansing, and monitoring. Use when ensuring data accuracy and completeness.

## # data-quality

Data quality management: validation rules, profiling, cleansing, and monitoring. Use when ensuring data accuracy and completeness.

## Goal pattern

data quality validation profiling cleansing monitoring accuracy completeness

## Steps

0. [context-gatherer] Assess data quality: what data sources exist? What quality issues are known? What validation rules are needed?

1. [planner] Design data quality framework:
1. Profiling: understand data characteristics
2. Validation: define quality rules
3. Cleansing: fix quality issues
4. Monitoring: track quality metrics
5. Alerting: notify on quality degradation
6. Reporting: quality dashboards (after: 'step-0')

2. [runner] Implement data quality:
1. Profile data sources
2. Define validation rules
3. Implement cleansing logic
4. Set up monitoring
5. Configure alerts
6. Create quality dashboards (after: 'step-1')

3. [reviewer] Verify: data is profiled, rules are defined, cleansing works, monitoring is active. (after: 'step-2')

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
