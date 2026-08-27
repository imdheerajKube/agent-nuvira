---
name: cron-job
description: Set up scheduled tasks and cron jobs. Use when the goal asks to automate recurring tasks, schedule jobs, or set up crons.
version: 2.0.0
whenToUse: Scheduled tasks, periodic cleanup, backup automation, report generation, data synchronization
whenNotToUse: Real-time event processing (use message queue), long-running processes (use systemd)
---

# Cron Job

Set up scheduled tasks with enterprise patterns.

## Goal pattern

cron schedule task automate periodic cleanup backup report

## Parameters

- schedule (choice [default: daily]): Task frequency
- logging (boolean [default: true]): Log task output
- monitoring (boolean [default: false]): Monitor task execution

## Steps

### Step 1: [context-gatherer] — Analyze scheduling needs

```bash
# Check existing crontab
crontab -l 2>/dev/null || echo "No crontab"

# Check system cron
ls /etc/cron.d/
cat /etc/crontab

# Check cron service
systemctl status cron 2>/dev/null || systemctl status crond 2>/dev/null
```

- What tasks? (backup, cleanup, report, sync)
- What schedule? (hourly, daily, weekly, custom)
- What dependencies? (database, API, filesystem)
- What notifications? (email, Slack, PagerDuty)

### Step 2: [writer] — Create cron jobs

**System crontab:**
```bash
# /etc/cron.d/myapp
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
MAILTO=admin@example.com

# Database backup daily at 2 AM
0 2 * * * root /usr/local/bin/backup-db.sh >> /var/log/myapp/backup.log 2>&1

# Clean temp files hourly
0 * * * * root /usr/local/bin/cleanup-temp.sh >> /var/log/myapp/cleanup.log 2>&1

# Generate report weekly on Monday at 6 AM
0 6 * * 1 root /usr/local/bin/generate-report.sh >> /var/log/myapp/reports.log 2>&1

# Sync data every 5 minutes
*/5 * * * * root /usr/local/bin/sync-data.sh >> /var/log/myapp/sync.log 2>&1
```

**Application-level scheduler:**
```python
# src/scheduler.py
import schedule
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

def backup_database():
    """Backup database to S3."""
    logger.info("Starting database backup")
    # Your backup logic here
    logger.info("Database backup completed")

def cleanup_temp_files():
    """Clean files older than 7 days."""
    logger.info("Starting temp file cleanup")
    # Your cleanup logic here
    logger.info("Temp file cleanup completed")

def generate_report():
    """Generate weekly report."""
    logger.info("Starting report generation")
    # Your report logic here
    logger.info("Report generation completed")

# Schedule tasks
schedule.every().day.at("02:00").do(backup_database)
schedule.every().hour.do(cleanup_temp_files)
schedule.every().monday.at("06:00").do(generate_report)

while True:
    schedule.run_pending()
    time.sleep(60)
```

**Docker-based cron:**
```yaml
# docker-compose.yml
services:
  cron:
    image: alpine:latest
    volumes:
      - ./scripts:/scripts
      - ./logs:/var/log/cron
    command: >
      sh -c "echo '0 2 * * * /scripts/backup.sh >> /var/log/cron/backup.log 2>&1' > /etc/crontabs/root &&
             crond -f -l 8"
```

### Step 3: [runner] — Deploy and test

```bash
# Deploy crontab
crontab -l > /tmp/crontab
echo "0 2 * * * /usr/local/bin/backup-db.sh" >> /tmp/crontab
crontab /tmp/crontab

# Test task manually
/usr/local/bin/backup-db.sh

# Check cron logs
grep CRON /var/log/syslog | tail -10

# Verify cron service
systemctl status cron
```

### Step 4: [reviewer] — Verify tasks execute

```bash
# Check cron execution
grep "myapp" /var/log/syslog | tail -20

# Verify backup files
ls -la /var/backups/myapp/

# Check task completion
tail -100 /var/log/myapp/backup.log

# Monitor task duration
grep "Starting\|completed" /var/log/myapp/backup.log
```

**Verification checklist:**
- [ ] Cron jobs execute on schedule
- [ ] Task output logged correctly
- [ ] No overlapping executions
- [ ] Error handling works
- [ ] Notifications sent on failure
- [ ] Task duration acceptable
- [ ] Disk space not exhausted by logs

## Reference Documents

Load deep-dive content with `skill_view('cron-job', 'references/guide.md')`.
