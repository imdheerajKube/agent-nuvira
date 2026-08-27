# Health Data Reference Guide

## Overview
Integrate health data APIs: Apple HealthKit, Google Fit, or Fitbit for reading and writing health metrics. Covers authorization, data types, and privacy compliance. Use when building health or wellness applications.

## # health-data

Integrate health data APIs: Apple HealthKit, Google Fit, or Fitbit for reading and writing health metrics. Covers authorization, data types, and privacy compliance. Use when building health or wellness applications.

## Goal pattern

health data healthkit google fit fitbit wellness metrics privacy HIPAA integration

## Steps

0. [context-gatherer] Map the health data: what platform (iOS, Android, web)? What metrics (steps, heart rate, sleep, weight)? What provider (HealthKit, Google Fit, Fitbit)? Privacy requirements (HIPAA)?

1. [planner] Design the health integration:
1. Authorization: OAuth scopes for health data
2. Data types: map app data types to platform types
3. Reading: fetch historical and real-time data
4. Writing: save workout data, custom health metrics
5. Privacy: data encryption, user consent, data deletion
6. Sync: background sync, conflict resolution (after: 'step-0')

2. [runner] Implement the integration:
1. Set up API credentials
2. Implement authorization flow
3. Create data reading functions
4. Add data writing functions
5. Handle data normalization
6. Test with sample data (after: 'step-1')

3. [reviewer] Verify: authorize access, read health data, write test data, verify sync, check privacy controls. (after: 'step-2')

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
