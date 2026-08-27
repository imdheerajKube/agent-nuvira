# Kubernetes Reference Guide

## Overview
Configure and manage Kubernetes clusters. Use when the goal asks to deploy, scale, or manage containerized applications on Kubernetes.

## # kubernetes

Configure and manage Kubernetes clusters. Use when the goal asks to deploy, scale, or manage containerized applications on Kubernetes.

## Goal pattern

kubernetes k8s cluster pod deployment service ingress helm

## Parameters

- tool (choice [default: kubectl]): K8s management tool

## Steps

1. [analyst] Create Kubernetes manifests: Deployment, Service, ConfigMap, Secret, Ingress.

2. [analyst] Configure resource limits, health checks (liveness/readiness probes), and autoscaling (HPA). (after: step-0)

3. [analyst] Set up Helm charts for templated deployments with environment-specific values. (after: step-1)

4. [analyst] Configure RBAC, network policies, and monitoring (Prometheus/Grafana). (after: step-2)

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
