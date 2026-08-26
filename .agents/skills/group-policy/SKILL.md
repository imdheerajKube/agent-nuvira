---
name: group-policy
description: Manage Group Policy: Local Group Policy Editor, GPO creation, policy deployment, and troubleshooting. Use when configuring Windows security and administrative policies.
version: 1.0.0
---

# group-policy

Manage Group Policy: Local Group Policy Editor, GPO creation, policy deployment, and troubleshooting. Use when configuring Windows security and administrative policies.

## Goal pattern

group policy GPO windows security configuration deployment management local policy

## Steps

0. [context-gatherer] Map the policy requirements: what policies needed (security, software restriction, folder redirection)? Local or domain? What OU structure?

1. [planner] Design the group policy:
1. Policy type: computer config vs user config
2. Security policies: password, account lockout, audit
3. Software restriction: app whitelisting, execution policies
4. Folder redirection: desktop, documents, app data
5. Deployment: local GPO vs domain GPO vs Intune
6. Troubleshooting: gpresult, rsop.msc (after: 'step-0')

2. [runner] Configure group policy:
1. Open Group Policy Editor
2. Configure computer/user policies
3. Set security settings
4. Apply folder redirection if needed
5. Run gpupdate /force
6. Verify with gpresult (after: 'step-1')

3. [reviewer] Verify: policies applied (gpresult), security settings enforced, no conflicts with existing policies, rollback plan documented. (after: 'step-2')
