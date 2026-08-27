# Database Migration Patterns

## Zero-Downtime Migration Strategy

### 1. Expand Phase (Add new columns/tables)
```sql
-- Add new column (nullable)
ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT NULL;

-- Add new table
CREATE TABLE user_sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  token VARCHAR(255) NOT NULL,
  expires_at TIMESTAMP NOT NULL
);
```

### 2. Migrate Phase (Backfill data)
```sql
-- Backfill in batches to avoid locking
UPDATE users SET email_verified = false WHERE email_verified IS NULL LIMIT 10000;

-- Use a script for large tables
-- migrate.js
const batchSize = 10000;
let offset = 0;
while (true) {
  const result = await db.query(
    'UPDATE users SET email_verified = false WHERE email_verified IS NULL LIMIT $1',
    [batchSize]
  );
  if (result.rowCount === 0) break;
  offset += batchSize;
}
```

### 3. Switch Phase (Update application code)
```javascript
// Deploy new code that reads from both columns
const user = await db.query('SELECT *, COALESCE(email_verified, false) as verified FROM users WHERE id = $1', [id]);
```

### 4. Clean Phase (Remove old columns)
```sql
-- After confirming new code works
ALTER TABLE users DROP COLUMN old_column;
```

## Rollback Strategies

### Forward Rollback (Preferred)
```sql
-- Create a rollback migration
CREATE TABLE users_backup AS SELECT * FROM users;
-- Run forward migration
-- If issues, restore from backup
TRUNCATE users;
INSERT INTO users SELECT * FROM users_backup;
```

### Backward Rollback
```sql
-- Keep old column during transition
ALTER TABLE users ADD COLUMN email_verified_new BOOLEAN;
-- Migrate data
-- Deploy new code
-- Remove old column only after verification
```

## Schema Versioning

```sql
-- Add version tracking table
CREATE TABLE schema_versions (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  description TEXT
);

-- Track migrations
INSERT INTO schema_versions (version, description) VALUES (1, 'Add email_verified column');
```

## Common Patterns

### Rename Column (Safe)
```sql
-- 1. Add new column
ALTER TABLE users ADD COLUMN email_address VARCHAR(255);
-- 2. Copy data
UPDATE users SET email_address = email;
-- 3. Deploy code using new column
-- 4. Drop old column
ALTER TABLE users DROP COLUMN email;
```

### Add Index (Safe)
```sql
-- Use CONCURRENTLY to avoid locking
CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
```

### Change Column Type (Safe)
```sql
-- 1. Add new column
ALTER TABLE users ADD COLUMN age_new INTEGER;
-- 2. Copy data
UPDATE users SET age_new = age::INTEGER;
-- 3. Deploy code
-- 4. Drop old column
ALTER TABLE users DROP COLUMN age;
-- 5. Rename new column
ALTER TABLE users RENAME COLUMN age_new TO age;
```
