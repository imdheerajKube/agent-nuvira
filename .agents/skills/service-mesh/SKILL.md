---
name: service-mesh
description: Set up a service mesh (Istio, Linkerd, Consul Connect): traffic management, mTLS, observability, and resilience. Use when the goal is to add networking capabilities to a microservices architecture.
version: 1.0.0
---

# service-mesh

Set up a service mesh (Istio, Linkerd, Consul Connect): traffic management, mTLS, observability, and resilience. Use when the goal is to add networking capabilities to a microservices architecture.

## Goal pattern

service mesh istio linkerd consul mTLS traffic management observability resilience microservices

## Parameters

(none)

## Steps

1. [context-gatherer] Map the services: how many services? What Kubernetes version? What mesh (Istio, Linkerd, Consul)? What capabilities needed (mTLS, traffic splitting, circuit breaking)?

2. [planner] Design the mesh configuration:
1. Installation: control plane + sidecar injection
2. mTLS: strict mode for service-to-service
3. Traffic: canary deployments, circuit breaking, retries
4. Observability: Kiali dashboard, Jaeger tracing, Prometheus metrics
5. Authorization: service-to-service access policies (after: step-0)

3. [runner] Deploy the mesh:
1. Install control plane
2. Enable sidecar injection for namespaces
3. Configure mTLS
4. Set up traffic rules
5. Deploy observability stack
6. Test service communication (after: step-1)

4. [reviewer] Verify: mTLS between services, traffic splitting works, traces appear in Jaeger, metrics in Prometheus, authorization policies enforced. (after: step-2)
