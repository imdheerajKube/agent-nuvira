---
name: budget-config
description: Configure and manage budgets: API usage tracking, cost alerts, spending limits, and billing optimization. Use when setting up cost controls for API usage or cloud resources.
version: 1.0.0
---

# budget-config

Configure and manage budgets: API usage tracking, cost alerts, spending limits, and billing optimization. Use when setting up cost controls for API usage or cloud resources.

## Goal pattern

budget cost tracking API usage billing alerts spending limits optimization cloud costs

## Steps

0. [context-gatherer] Map the budget: what services to track? What budget limits? What alert thresholds? What billing period?

1. [planner] Design the budget system:
1. Tracking: log API calls, tokens used, compute time
2. Limits: daily, weekly, monthly caps
3. Alerts: at 50%, 80%, 100% of budget
4. Optimization: cache results, batch requests, use cheaper models
5. Reporting: daily/weekly cost breakdown
6. Auto-shutoff: stop services when budget exceeded (after: 'step-0')

2. [runner] Implement budget controls:
1. Add usage tracking to API clients
2. Create budget configuration
3. Implement alert system
4. Add cost optimization logic
5. Build reporting dashboard
6. Test with budget limits (after: 'step-1')

3. [reviewer] Verify: usage tracked correctly, alerts fire at thresholds, limits enforced, reports accurate. (after: 'step-2')
