---
name: terraform
description: Write Terraform infrastructure-as-code. Use when the goal asks to provision, manage, or version cloud infrastructure.
version: 2.0.0
whenToUse: Provisioning cloud resources (AWS/GCP/Azure), managing infrastructure state, multi-environment setups, infrastructure versioning
whenNotToUse: Simple Docker Compose setups, Kubernetes-only deployments (use Helm), application-level config
---

# Terraform

Write Terraform infrastructure-as-code with enterprise patterns.

## Goal pattern

terraform infrastructure iac provision cloud resource module state

## Parameters

- provider (choice [default: aws]): Cloud provider
- stateBackend (choice [default: s3]): Remote state backend
- moduleStrategy (choice [default: compositional]): Module organization

## Steps

### Step 1: [analyst] — Map infrastructure requirements

```bash
# Check Terraform version
terraform version

# Check cloud provider CLI
aws --version 2>/dev/null || gcloud --version 2>/dev/null || az --version 2>/dev/null

# Check current state
terraform state list 2>/dev/null || echo "No existing state"
```

- What cloud provider? (AWS, GCP, Azure, multi-cloud)
- What resources? (VPC, ECS, RDS, S3, Lambda)
- How many environments? (dev, staging, prod)
- What state backend? (S3+DynamoDB, GCS, Terraform Cloud)
- What compliance requirements? (encryption, tagging, logging)

### Step 2: [analyst] — Write Terraform configurations

**Project structure:**
```
terraform/
├── modules/
│   ├── vpc/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   ├── ecs/
│   └── rds/
├── environments/
│   ├── dev/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   ├── terraform.tfvars
│   │   └── backend.tf
│   ├── staging/
│   └── prod/
└── shared/
    └── modules.tf
```

**Example VPC module:**
```hcl
# modules/vpc/main.tf
resource "aws_vpc" "main" {
  cidr_block           = var.cidr_block
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(var.tags, {
    Name        = "${var.project}-${var.environment}-vpc"
    Environment = var.environment
    ManagedBy   = "terraform"
  })
}

resource "aws_subnet" "private" {
  count             = length(var.private_subnets)
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnets[count.index]
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = merge(var.tags, {
    Name = "${var.project}-${var.environment}-private-${count.index}"
    Tier = "private"
  })
}

resource "aws_subnet" "public" {
  count                   = length(var.public_subnets)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnets[count.index]
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = merge(var.tags, {
    Name = "${var.project}-${var.environment}-public-${count.index}"
    Tier = "public"
  })
}
```

**Backend configuration:**
```hcl
# environments/prod/backend.tf
terraform {
  backend "s3" {
    bucket         = "myproject-terraform-state"
    key            = "prod/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "terraform-locks"
    encrypt        = true
  }
}
```

### Step 3: [analyst] — Apply infrastructure

```bash
# Initialize
terraform init -upgrade

# Validate
terraform validate

# Plan (review before apply)
terraform plan -out=tfplan -var-file="environments/prod/terraform.tfvars"

# Apply
terraform apply tfplan

# Verify resources
terraform state list
terraform output
```

**CI/CD pipeline (GitHub Actions):**
```yaml
- name: Terraform Plan
  run: |
    terraform init
    terraform plan -out=tfplan
    terraform show -no-color tfplan > plan.txt
    
- name: Terraform Apply
  if: github.ref == 'refs/heads/main'
  run: terraform apply -auto-approve tfplan
```

### Step 4: [analyst] — Verify infrastructure

```bash
# Check for drift
terraform plan -detailed-exitcode

# Verify all resources exist
terraform state list | wc -l

# Check outputs
terraform output -json | jq .

# Verify tagging compliance
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=ManagedBy,Values=terraform
```

**Verification checklist:**
- [ ] All resources created successfully
- [ ] No drift detected (`terraform plan` shows no changes)
- [ ] Tags applied correctly
- [ ] Encryption enabled on storage resources
- [ ] VPC flow logs enabled
- [ ] State file encrypted at rest
- [ ] Module outputs accessible

## Reference Documents

Load deep-dive content with `skill_view('terraform', 'references/aws-resources.md')`.
