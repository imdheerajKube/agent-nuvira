---
name: infra-as-code
description: Define infrastructure with code: Terraform, Pulumi, or CloudFormation. Covers modules, state management, drift detection, and multi-environment setups. Use when the goal is to provision or manage cloud infrastructure.
version: 1.0.0
---

# infra-as-code

Define infrastructure with code: Terraform, Pulumi, or CloudFormation. Covers modules, state management, drift detection, and multi-environment setups. Use when the goal is to provision or manage cloud infrastructure.

## Goal pattern

infrastructure as code terraform pulumi cloudformation modules state drift multi-environment provisioning

## Steps

0. [context-gatherer] Map the infrastructure: what cloud provider? What resources (VPC, ECS, RDS, S3)? How many environments (dev, staging, prod)? What state backend (S3, Terraform Cloud)?

1. [planner] Design the IaC structure:
1. Module design: reusable modules for VPC, ECS, RDS, etc.
2. State management: remote state with locking
3. Variables: input variables, outputs, data sources
4. Environments: workspace or directory-based separation
5. CI/CD: plan → apply pipeline with approval gates
6. Drift detection: scheduled plan checks (after: 'step-0')

2. [runner] Implement infrastructure:
1. Write Terraform/Pulumi modules
2. Configure state backend
3. Define variables and outputs
4. Create environment-specific configs
5. Run terraform plan/apply
6. Verify resources in cloud console (after: 'step-1')

3. [reviewer] Verify: check terraform state matches reality, run plan with no changes (no drift), verify all outputs, test destroy/recreate cycle. (after: 'step-2')
