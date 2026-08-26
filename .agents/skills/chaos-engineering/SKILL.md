---
name: chaos-engineering
description: Practice chaos engineering: inject faults, measure resilience, and improve system reliability. Covers experiment design, fault injection (network, CPU, memory), and blast radius control. Use when testing system resilience.
version: 1.0.0
---

# chaos-engineering

Practice chaos engineering: inject faults, measure resilience, and improve system reliability. Covers experiment design, fault injection (network, CPU, memory), and blast radius control. Use when testing system resilience.

## Goal pattern

chaos engineering fault injection resilience testing reliability litmus chaos mesh game day

## Steps

0. [context-gatherer] Map the system: what services to test? What failure modes to explore? What observability exists? What is the blast radius limit?

1. [planner] Design chaos experiments:
1. Steady state: define normal behavior metrics
2. Hypothesis: "the system will continue serving requests when X fails"
3. Fault injection: network latency/loss, pod kills, CPU/memory stress
4. Blast radius: start small, expand gradually
5. Rollback: automatic rollback on breach of SLO
6. Observability: monitor during experiment (after: 'step-0')

2. [runner] Run the experiment:
1. Verify steady state
2. Inject fault (Litmus, Chaos Mesh, or custom)
3. Monitor system behavior
4. Observe if hypothesis holds
5. Stop experiment
6. Analyze results (after: 'step-1')

3. [reviewer] Review: did the system handle the fault? What degraded? What broke? What improvements are needed? Document findings and action items. (after: 'step-2')
