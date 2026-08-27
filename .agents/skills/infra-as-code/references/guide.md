# Infra As Code Reference Guide

## Overview
Define infrastructure with code: Terraform, Pulumi, or CloudFormation. Covers modules, state management, drift detection, and multi-environment setups. Use when the goal is to provision or manage cloud infrastructure.

## # infra-as-code

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
