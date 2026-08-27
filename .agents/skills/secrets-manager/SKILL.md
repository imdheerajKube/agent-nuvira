---
name: secrets-manager
description: Set up secrets management with Vault, AWS Secrets Manager, or similar. Use when the goal asks to manage secrets, rotate credentials, or secure sensitive data.
version: 2.0.0
whenToUse: Secrets storage, credential rotation, API key management, database passwords, encryption keys
whenNotToUse: Environment variables (use env-setup), config files (use config management), SSL certificates (use ssl-cert)
---

# Secrets Manager

Set up secrets management with enterprise patterns.

## Goal pattern

secrets manager vault AWS secrets manager credential rotation encryption key management

## Parameters

- provider (choice [default: aws-secrets-manager]): Secrets provider
- rotation (boolean [default: true]): Enable automatic rotation
- encryption (boolean [default: true]): Encrypt secrets at rest

## Steps

### Step 1: [analyst] — Analyze secrets requirements

```bash
# Check existing secrets
ls -la ~/.aws/credentials 2>/dev/null
env | grep -i "SECRET\|KEY\|TOKEN\|PASSWORD" | wc -l

# Check secrets manager
aws secretsmanager list-secrets 2>/dev/null | head -10
vault status 2>/dev/null

# Check .env files
find . -name ".env*" -exec ls -la {} \;
```

- What secrets? (API keys, passwords, tokens, certificates)
- What access pattern? (read-heavy, write-heavy, rotation)
- What compliance? (SOC2, HIPAA, PCI-DSS)
- What encryption? (AES-256, KMS, HSM)

### Step 2: [analyst] — Implement secrets management

**AWS Secrets Manager:**
```python
# src/secrets/aws_secrets.py
import boto3
import json
from functools import lru_cache

class SecretsManager:
    def __init__(self, region_name='us-east-1'):
        self.client = boto3.client('secretsmanager', region_name=region_name)
    
    @lru_cache(maxsize=128)
    def get_secret(self, secret_name: str) -> dict:
        """Retrieve secret with caching."""
        response = self.client.get_secret_value(SecretId=secret_name)
        return json.loads(response['SecretString'])
    
    def create_secret(self, name: str, secret: dict):
        """Create a new secret."""
        self.client.create_secret(
            Name=name,
            SecretString=json.dumps(secret),
            Tags=[
                {'Key': 'Environment', 'Value': 'production'},
                {'Key': 'ManagedBy', 'Value': 'terraform'}
            ]
        )
    
    def rotate_secret(self, secret_name: str, rotation_lambda: str):
        """Enable automatic rotation."""
        self.client.rotate_secret(
            SecretId=secret_name,
            RotationLambdaARN=rotation_lambda,
            RotationRules={
                'AutomaticallyAfterDays': 30
            }
        )

# Usage
sm = SecretsManager()
db_credentials = sm.get_secret('prod/myapp/database')
```

**HashiCorp Vault:**
```bash
# Enable secrets engine
vault secrets enable -path=secret kv-v2

# Store secret
vault kv put secret/myapp/api-key \
  key="sk-1234567890" \
  expires="2025-01-01"

# Read secret
vault kv get -field=key secret/myapp/api-key

# Enable dynamic secrets (database)
vault secrets enable database
vault write database/config/postgres \
  plugin_name=postgresql-database-plugin \
  connection_url="postgresql://{{username}}:{{password}}@db.example.com:5432/mydb" \
  allowed_roles="myapp" \
  username="vault" \
  password="vault-password"

vault write database/roles/myapp \
  db_name=postgres \
  default_ttl="1h" \
  max_ttl="24h"
```

### Step 3: [analyst] — Deploy and configure

```bash
# Store secrets in AWS
aws secretsmanager create-secret \
  --name prod/myapp/database \
  --secret-string '{"username":"admin","password":"changeme"}'

# Enable rotation
aws secretsmanager rotate-secret \
  --secret-id prod/myapp/database \
  --rotation-lambda-arn arn:aws:lambda:us-east-1:123456789:function/rotate-secret

# Verify secret access
aws secretsmanager get-secret-value \
  --secret-id prod/myapp/database

# Test application can read secrets
python -c "
from src.secrets.aws_secrets import SecretsManager
sm = SecretsManager()
print(sm.get_secret('prod/myapp/database'))
"
```

### Step 4: [analyst] — Verify secrets management

```bash
# Check secret access logs
aws logs filter-log-events \
  --log-group-name /aws/secretsmanager \
  --filter-pattern "GetSecretValue"

# Verify rotation schedule
aws secretsmanager describe-secret \
  --secret-id prod/myapp/database \
  --query 'RotationEnabled'

# Test secret retrieval
curl -H "Authorization: Bearer $(vault kv get -field=token secret/myapp/api-key)" \
  https://api.example.com

# Check encryption
aws kms describe-key --key-id alias/aws/secretsmanager
```

**Verification checklist:**
- [ ] Secrets stored securely (encrypted at rest)
- [ ] Access logging enabled
- [ ] Automatic rotation configured
- [ ] Least-privilege access policies
- [ ] No secrets in code or config files
- [ ] Backup and recovery tested
- [ ] Audit trail maintained

## Reference Documents

Load deep-dive content with `skill_view('secrets-manager', 'references/guide.md')`.
