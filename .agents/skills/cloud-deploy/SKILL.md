---
name: cloud-deploy
description: Deploy applications to AWS, GCP, or Azure. Use when the goal asks to deploy, host, or infrastructure-as-code for cloud platforms.
version: 1.0.0
---

# cloud-deploy

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
