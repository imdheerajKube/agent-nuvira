---
name: terraform
description: Write Terraform infrastructure-as-code. Use when the goal asks to provision, manage, or version cloud infrastructure.
version: 1.0.0
---

# terraform

Write Terraform infrastructure-as-code. Use when the goal asks to provision, manage, or version cloud infrastructure.

## Goal pattern

terraform infrastructure iac provision cloud resource module state

## Parameters

- provider (choice [default: aws]): Cloud provider

## Steps

1. [analyst] Define infrastructure resources, data sources, and variables. Choose state backend (S3, GCS, TF Cloud).

2. [analyst] Write resource configurations with proper tagging, encryption, and networking. (after: step-0)

3. [analyst] Add modules for reusable components. Implement workspace isolation. (after: step-1)

4. [analyst] Set up plan/apply pipeline with approval gates. Add drift detection. (after: step-2)
