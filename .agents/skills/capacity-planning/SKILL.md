---
name: capacity-planning
description: Capacity planning: load testing, performance baselines, growth forecasting, and scaling strategies. Use when planning for system growth.
version: 1.0.0
---

# capacity-planning

Capacity planning: load testing, performance baselines, growth forecasting, and scaling strategies. Use when planning for system growth.

## Goal pattern

capacity planning load testing performance baseline growth forecasting scaling

## Parameters

(none)

## Steps

1. [context-gatherer] Map the current capacity: what are the performance baselines? What is the expected growth? What are the scaling limits?

2. [planner] Design capacity plan:
1. Baselines: current performance metrics
2. Load testing: simulate expected traffic
3. Forecasting: project growth over 6-12 months
4. Scaling: horizontal vs vertical scaling
5. Thresholds: when to trigger scaling
6. Budget: cost of additional capacity (after: step-0)

3. [runner] Implement capacity planning:
1. Establish performance baselines
2. Run load tests
3. Create growth forecast
4. Implement auto-scaling
5. Set up scaling alerts
6. Document capacity plan (after: step-1)

4. [reviewer] Verify: baselines are accurate, load tests pass, scaling works, forecast is realistic. (after: step-2)
