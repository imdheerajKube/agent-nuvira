---
name: backup-strategy
description: Design and implement backup strategies. Use when the goal asks to set up backups, disaster recovery, or data protection.
version: 2.0.0
whenToUse: Backup automation, disaster recovery, data retention, compliance, cross-region replication
whenNotToUse: Real-time replication (use database replication), caching (use redis-cache), log aggregation
---

# Backup Strategy

Design and implement backup strategies with enterprise patterns.

## Goal pattern

backup disaster recovery retention snapshot restore data protection RPO RTO

## Parameters

- strategy (choice [default: incremental]): Backup strategy
- storage (choice [default: s3]): Backup storage location
- encryption (boolean [default: true]): Encrypt backups

## Steps

### Step 1: [context-gatherer] — Analyze backup requirements

```bash
# Check data to backup
du -sh /var/lib/postgresql/ 2>/dev/null
du -sh /var/lib/mysql/ 2>/dev/null
du -sh /app/data/ 2>/dev/null

# Check existing backups
ls -la /var/backups/ 2>/dev/null
aws s3 ls s3://my-backups/ 2>/dev/null

# Check disk space
df -h /var/backups
```

- What data? (database, files, configurations)
- What RPO? (Recovery Point Objective - max data loss)
- What RTO? (Recovery Time Objective - max downtime)
- What retention? (7 days, 30 days, 1 year)
- What compliance? (GDPR, HIPAA, SOC2)

### Step 2: [writer] — Implement backup solution

**Database backup script:**
```bash
#!/bin/bash
# /usr/local/bin/backup-db.sh
set -euo pipefail

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/var/backups/db"
S3_BUCKET="s3://my-backups/database"
RETENTION_DAYS=30

# Create backup
pg_dump mydb | gzip > "$BACKUP_DIR/mydb_$TIMESTAMP.sql.gz"

# Encrypt backup
gpg --encrypt --recipient admin@example.com "$BACKUP_DIR/mydb_$TIMESTAMP.sql.gz"
rm "$BACKUP_DIR/mydb_$TIMESTAMP.sql.gz"

# Upload to S3
aws s3 cp "$BACKUP_DIR/mydb_$TIMESTAMP.sql.gz.gpg" "$S3_BUCKET/"

# Cleanup old backups
find "$BACKUP_DIR" -name "*.gz.gpg" -mtime +$RETENTION_DAYS -delete

# Log
echo "Backup completed: mydb_$TIMESTAMP.sql.gz.gpg" >> /var/log/backup.log
```

**File backup with restic:**
```bash
# Initialize restic repository
restic -r s3:s3.amazonaws.com/my-backups init

# Backup files
restic -r s3:s3.amazonaws.com/my-backups backup /app/data \
  --verbose \
  --exclude="*.tmp" \
  --exclude="node_modules"

# List snapshots
restic -r s3:s3.amazonaws.com/my-backups snapshots

# Restore from backup
restic -r s3:s3.amazonaws.com/my-backups restore latest --target /restore
```

**Automated backup cron:**
```bash
# /etc/cron.d/backup
0 2 * * * root /usr/local/bin/backup-db.sh >> /var/log/backup.log 2>&1
0 3 * * * root /usr/local/bin/backup-files.sh >> /var/log/backup.log 2>&1
0 4 * * 0 root /usr/local/bin/backup-verify.sh >> /var/log/backup.log 2>&1
```

### Step 3: [runner] — Deploy and test

```bash
# Run backup manually
/usr/local/bin/backup-db.sh

# Verify backup exists
ls -la /var/backups/db/

# Test restore
gunzip -k /var/backups/db/mydb_20240101_020000.sql.gz
psql mydb < /var/backups/db/mydb_20240101_020000.sql

# Verify S3 upload
aws s3 ls s3://my-backups/database/ | tail -5
```

### Step 4: [reviewer] — Verify backup strategy

```bash
# Check backup logs
tail -100 /var/log/backup.log

# Verify backup integrity
gpg --verify /var/backups/db/mydb_*.gpg

# Test restore to different location
createdb mydb_restore
psql mydb_restore < /var/backups/db/mydb_*.sql

# Check retention
find /var/backups -name "*.gz.gpg" -mtime +30 | wc -l
```

**Verification checklist:**
- [ ] Backups complete successfully
- [ ] Backups encrypted
- [ ] Backups uploaded to offsite storage
- [ ] Restore tested successfully
- [ ] Retention policy enforced
- [ ] Backup logs monitored
- [ ] RPO/RTO targets met

## Reference Documents

Load deep-dive content with `skill_view('backup-strategy', 'references/guide.md')`.
