# Terraform Reference Guide

## Overview
Write Terraform infrastructure-as-code. Use when the goal asks to provision, manage, or version cloud infrastructure.

## # terraform

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
