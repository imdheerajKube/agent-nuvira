---
name: log-rotation
description: Set up log rotation and management. Use when the goal asks to configure log rotation, manage log files, or prevent disk filling.
version: 2.0.0
whenToUse: Log file rotation, disk space management, log archival, compliance retention, log compression
whenNotToUse: Structured logging setup (use structured-logging), log aggregation (use prometheus), monitoring
---

# Log Rotation

Set up log rotation with enterprise patterns.

## Goal pattern

log rotation compress archive retention disk space cleanup syslog

## Parameters

- retention (choice [default: 30d]): Log retention period
- compression (boolean [default: true]): Compress rotated logs
- archival (boolean [default: false]): Archive to cold storage

## Steps

### Step 1: [context-gatherer] — Analyze logging setup

```bash
# Check current log sizes
du -sh /var/log/* 2>/dev/null | sort -rh | head -10

# Check logrotate config
cat /etc/logrotate.conf
ls /etc/logrotate.d/

# Check disk usage
df -h /var/log

# Find large logs
find /var/log -name "*.log" -size +100M -exec ls -lh {} \;
```

- What log files? (app logs, system logs, access logs)
- What rotation schedule? (daily, weekly, on size)
- What retention? (7 days, 30 days, 1 year)
- What compression? (gzip, bzip2, xz)

### Step 2: [writer] — Configure log rotation

**Logrotate configuration:**
```bash
# /etc/logrotate.d/myapp
/var/log/myapp/*.log {
    daily
    rotate 30
    compress
    delaycompress
    notifempty
    missingok
    create 0640 www-data www-data
    sharedscripts
    postrotate
        [ -f /var/run/nginx.pid ] && kill -USR1 $(cat /var/run/nginx.pid)
    endscript
}

# Application logs with size-based rotation
/var/log/myapp/app.log {
    size 100M
    rotate 10
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}

# Access logs
/var/log/nginx/access.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0640 www-data adm
    sharedscripts
    postrotate
        [ -f /var/run/nginx.pid ] && kill -USR1 $(cat /var/run/nginx.pid)
    endscript
}
```

**Systemd journal configuration:**
```bash
# /etc/systemd/journald.conf
[Journal]
SystemMaxUse=1G
SystemMaxFileSize=100M
MaxRetentionSec=30day
MaxFileSec=1day
Compress=yes
```

**Custom rotation script:**
```bash
#!/bin/bash
# /usr/local/bin/log-cleanup.sh
set -euo pipefail

LOG_DIR="/var/log/myapp"
RETENTION_DAYS=30
ARCHIVE_DIR="/var/archive/logs"

# Create archive directory
mkdir -p "$ARCHIVE_DIR"

# Rotate logs older than retention
find "$LOG_DIR" -name "*.log" -mtime +$RETENTION_DAYS -exec gzip {} \;
find "$LOG_DIR" -name "*.gz" -mtime +$RETENTION_DAYS -exec mv {} "$ARCHIVE_DIR/" \;

# Clean old archives
find "$ARCHIVE_DIR" -name "*.gz" -mtime +365 -delete

# Log cleanup action
logger "Log cleanup completed: rotated $(find "$LOG_DIR" -name "*.log.gz" | wc -l) files"
```

### Step 3: [runner] — Deploy and test

```bash
# Test logrotate configuration
logrotate -d /etc/logrotate.d/myapp  # Dry run

# Force rotation
logrotate -f /etc/logrotate.d/myapp

# Verify rotation
ls -la /var/log/myapp/

# Check cron for logrotate
cat /etc/cron.daily/logrotate

# Run custom cleanup script
chmod +x /usr/local/bin/log-cleanup.sh
/usr/local/bin/log-cleanup.sh
```

### Step 4: [reviewer] — Verify rotation works

```bash
# Check disk usage after rotation
du -sh /var/log/myapp/

# Verify compression
ls -la /var/log/myapp/*.gz

# Check logrotate status
cat /var/lib/logrotate/status | grep myapp

# Monitor disk usage over time
df -h /var/log
```

**Verification checklist:**
- [ ] Logs rotate on schedule
- [ ] Old logs compressed
- [ ] Disk usage stays within limits
- [ ] No log loss during rotation
- [ ] Application continues logging after rotation
- [ ] Archives cleaned up
- [ ] Compliance retention met

## Reference Documents

Load deep-dive content with `skill_view('log-rotation', 'references/guide.md')`.
