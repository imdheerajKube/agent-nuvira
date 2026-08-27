# Cloud Deploy Reference Guide

## Overview
Deploy applications to AWS, GCP, or Azure. Use when the goal asks to deploy, host, or infrastructure-as-code for cloud platforms.

## # cloud-deploy

Deploy applications to AWS, GCP, or Azure. Use when the goal asks to deploy, host, or infrastructure-as-code for cloud platforms.

## Goal pattern

deploy cloud aws gcp azure serverless lambda ec2

## Parameters

- provider (choice [default: aws]): Cloud provider

## Steps

1. [analyst] Choose cloud provider and deployment strategy (serverless, containers, VMs).

2. [analyst] Configure IAM roles, VPCs, security groups, and networking. (after: step-0)

3. [analyst] Set up CI/CD pipeline for automated deployments with rollback support. (after: step-1)

4. [analyst] Configure monitoring, logging, and alerting for the deployed application. (after: step-2)

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
