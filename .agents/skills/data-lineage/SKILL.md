---
name: data-lineage
description: Data lineage tracking: origin, transformations, dependencies, and impact analysis. Use when tracking data flow through systems.
version: 1.0.0
---

# data-lineage

Data lineage tracking: origin, transformations, dependencies, and impact analysis. Use when tracking data flow through systems.

## Goal pattern

data lineage tracking origin transformations dependencies impact analysis

## Parameters

(none)

## Steps

1. [context-gatherer] Map data flow: what are the data sources? What transformations occur? What are the downstream consumers?

2. [planner] Design lineage tracking:
1. Capture: metadata at each stage
2. Model: directed acyclic graph
3. Visualize: lineage graphs
4. Impact: analyze downstream effects
5. Compliance: regulatory requirements
6. Integration: catalog, governance (after: step-0)

3. [runner] Implement lineage tracking:
1. Instrument data pipelines
2. Capture metadata
3. Build lineage graph
4. Create visualization
5. Implement impact analysis
6. Integrate with catalog (after: step-1)

4. [reviewer] Verify: lineage is captured, graph is accurate, impact analysis works, integration is complete. (after: step-2)
