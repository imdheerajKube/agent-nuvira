# Service Mesh Reference Guide

## Overview
Set up a service mesh (Istio, Linkerd, Consul Connect): traffic management, mTLS, observability, and resilience. Use when the goal is to add networking capabilities to a microservices architecture.

## # service-mesh

Set up a service mesh (Istio, Linkerd, Consul Connect): traffic management, mTLS, observability, and resilience. Use when the goal is to add networking capabilities to a microservices architecture.

## Goal pattern

service mesh istio linkerd consul mTLS traffic management observability resilience microservices

## Steps

0. [context-gatherer] Map the services: how many services? What Kubernetes version? What mesh (Istio, Linkerd, Consul)? What capabilities needed (mTLS, traffic splitting, circuit breaking)?

1. [planner] Design the mesh configuration:
1. Installation: control plane + sidecar injection
2. mTLS: strict mode for service-to-service
3. Traffic: canary deployments, circuit breaking, retries
4. Observability: Kiali dashboard, Jaeger tracing, Prometheus metrics
5. Authorization: service-to-service access policies (after: 'step-0')

2. [runner] Deploy the mesh:
1. Install control plane
2. Enable sidecar injection for namespaces
3. Configure mTLS
4. Set up traffic rules
5. Deploy observability stack
6. Test service communication (after: 'step-1')

3. [reviewer] Verify: mTLS between services, traffic splitting works, traces appear in Jaeger, metrics in Prometheus, authorization policies enforced. (after: 'step-2')

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
