---
name: cost-optimization
description: Cloud cost optimization: right-sizing, reserved instances, spot instances, resource tagging, and cost monitoring. Use when optimizing cloud spending.
version: 1.0.0
---

# cost-optimization

Cloud cost optimization: right-sizing, reserved instances, spot instances, resource tagging, and cost monitoring. Use when optimizing cloud spending.

## Goal pattern

cloud cost optimization right-sizing reserved instances spot resource tagging monitoring

## Steps

0. [context-gatherer] Map the cloud usage: what provider (AWS, GCP, Azure)? What services are running? What are the current costs? What usage patterns exist?

1. [planner] Design cost optimization:
1. Right-sizing: analyze utilization, recommend smaller instances
2. Reserved: purchase reserved instances for steady workloads
3. Spot: use spot instances for fault-tolerant workloads
4. Tagging: enforce resource tagging for cost allocation
5. Monitoring: set up cost alerts and budgets
6. Cleanup: identify and remove unused resources (after: 'step-0')

2. [runner] Implement optimization:
1. Analyze current resource usage
2. Identify right-sizing opportunities
3. Purchase reserved instances
4. Configure spot instance pools
5. Set up cost alerts
6. Create cleanup automation (after: 'step-1')

3. [reviewer] Verify: costs are reduced, right-sizing is applied, spot instances are running, alerts are configured. (after: 'step-2')
