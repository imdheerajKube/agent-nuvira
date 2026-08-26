---
name: health-data
description: Integrate health data APIs: Apple HealthKit, Google Fit, or Fitbit for reading and writing health metrics. Covers authorization, data types, and privacy compliance. Use when building health or wellness applications.
version: 1.0.0
---

# health-data

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
