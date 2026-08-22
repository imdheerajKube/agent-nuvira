---
name: kubernetes
description: Configure and manage Kubernetes clusters. Use when the goal asks to deploy, scale, or manage containerized applications on Kubernetes.
version: 1.0.0
---

# kubernetes

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
