# AWS Services Quick Reference

## Compute

### EC2 (Elastic Compute Cloud)
```bash
# Launch an instance
aws ec2 run-instances \
  --image-id ami-0c55b159cbfafe1f0 \
  --instance-type t2.micro \
  --key-name my-key \
  --security-group-ids sg-12345678

# List instances
aws ec2 describe-instances

# Stop/terminate
aws ec2 stop-instances --instance-ids i-1234567890abcdef0
aws ec2 terminate-instances --instance-ids i-1234567890abcdef0
```

### Lambda
```bash
# Create a function
aws lambda create-function \
  --function-name my-function \
  --runtime nodejs18.x \
  --role arn:aws:iam::123456789012:role/lambda-role \
  --handler index.handler \
  --zip-file fileb://function.zip

# Invoke
aws lambda invoke --function-name my-function output.json

# Update code
aws lambda update-function-code \
  --function-name my-function \
  --zip-file fileb://function.zip
```

### ECS (Elastic Container Service)
```bash
# Create cluster
aws ecs create-cluster --cluster-name my-cluster

# Register task definition
aws ecs register-task-definition \
  --cli-input-json file://task-definition.json

# Run task
aws ecs run-task \
  --cluster my-cluster \
  --task-definition my-task:1

# Create service
aws ecs create-service \
  --cluster my-cluster \
  --service-name my-service \
  --task-definition my-task:1 \
  --desired-count 2
```

## Storage

### S3 (Simple Storage Service)
```bash
# Create bucket
aws s3 mb s3://my-bucket --region us-east-1

# Upload files
aws s3 cp file.txt s3://my-bucket/
aws s3 sync dist/ s3://my-bucket/

# Download
aws s3 cp s3://my-bucket/file.txt .

# Enable static website hosting
aws s3 website s3://my-bucket \
  --index-document index.html \
  --error-document index.html
```

### EBS (Elastic Block Store)
```bash
# Create volume
aws ec2 create-volume \
  --availability-zone us-east-1a \
  --size 100 \
  --volume-type gp3

# Attach to instance
aws ec2 attach-volume \
  --volume-id vol-1234567890abcdef0 \
  --instance-id i-1234567890abcdef0 \
  --device /dev/sdf
```

## Database

### RDS (Relational Database Service)
```bash
# Create database
aws rds create-db-instance \
  --db-instance-identifier mydb \
  --db-instance-class db.t3.micro \
  --engine mysql \
  --master-username admin \
  --master-user-password password123 \
  --allocated-storage 20

# Connect
mysql -h mydb.xxxxx.us-east-1.rds.amazonaws.com -u admin -p

# Backup
aws rds create-db-snapshot \
  --db-instance-identifier mydb \
  --db-snapshot-identifier my-snapshot
```

### DynamoDB
```bash
# Create table
aws dynamodb create-table \
  --table-name my-table \
  --attribute-definitions \
    AttributeName=id,AttributeType=N \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST

# Put item
aws dynamodb put-item \
  --table-name my-table \
  --item '{"id": {"N": "1"}, "name": {"S": "John"}}'

# Query
aws dynamodb query \
  --table-name my-table \
  --key-condition-expression "id = :id" \
  --expression-attribute-values '{":id": {"N": "1"}}'
```

## Networking

### VPC (Virtual Private Cloud)
```bash
# Create VPC
aws ec2 create-vpc --cidr-block 10.0.0.0/16

# Create subnet
aws ec2 create-subnet \
  --vpc-id vpc-12345678 \
  --cidr-block 10.0.1.0/24 \
  --availability-zone us-east-1a

# Create internet gateway
aws ec2 create-internet-gateway
aws ec2 attach-internet-gateway \
  --internet-gateway-id igw-12345678 \
  --vpc-id vpc-12345678
```

### ELB (Elastic Load Balancer)
```bash
# Create load balancer
aws elbv2 create-load-balancer \
  --name my-lb \
  --subnets subnet-12345678 subnet-87654321 \
  --security-groups sg-12345678

# Create target group
aws elbv2 create-target-group \
  --name my-targets \
  --protocol HTTP \
  --port 80 \
  --vpc-id vpc-12345678

# Register targets
aws elbv2 register-targets \
  --target-group-arn arn:aws:elasticloadbalancing:... \
  --targets Id=i-1234567890abcdef0
```

## Security

### IAM (Identity and Access Management)
```bash
# Create user
aws iam create-user --user-name my-user

# Create access key
aws iam create-access-key --user-name my-user

# Create role
aws iam create-role \
  --role-name my-role \
  --assume-role-policy-document file://role-policy.json

# Attach policy
aws iam attach-role-policy \
  --role-name my-role \
  --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess
```

### Secrets Manager
```bash
# Create secret
aws secretsmanager create-secret \
  --name my-secret \
  --secret-string '{"username":"admin","password":"secret123"}'

# Get secret
aws secretsmanager get-secret-value --secret-id my-secret

# Rotate secret
aws secretsmanager rotate-secret --secret-id my-secret
```

## Monitoring

### CloudWatch
```bash
# Put metric data
aws cloudwatch put-metric-data \
  --namespace MyNamespace \
  --metric-name MyMetric \
  --value 100

# Get metric statistics
aws cloudwatch get-metric-statistics \
  --namespace AWS/EC2 \
  --metric-name CPUUtilization \
  --start-time 2024-01-01T00:00:00Z \
  --end-time 2024-01-02T00:00:00Z \
  --period 3600 \
  --statistics Average
```

### SNS (Simple Notification Service)
```bash
# Create topic
aws sns create-topic --name my-topic

# Subscribe
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:123456789012:my-topic \
  --protocol email \
  --notification-endpoint user@example.com

# Publish
aws sns publish \
  --topic-arn arn:aws:sns:us-east-1:123456789012:my-topic \
  --message "Hello from SNS"
```
