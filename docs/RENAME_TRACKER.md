# Rename Tracker: buff → nuvira

**Approach:** Two-phase — Phase 1 (add nuvira alongside buff), Phase 2 (remove buff)

**Every file and line is tracked.** Phase 2 = mechanical find-and-replace using this document.

---

## Phase 1: Add nuvira (Keep buff working)

### Step 1: Package.json — Add secondary binary

**File:** `package.json`
```json
// BEFORE
"bin": {
  "agent-nuvira": "dist/index.js",
  "buff": "dist/index.js"
}

// AFTER
"bin": {
  "agent-nuvira": "dist/index.js",
  "nuvira": "dist/index.js",
  "buff": "dist/index.js"
}
```
**Status:** ☐ Pending

---

### Step 2: Config paths — Support both ~/.buff and ~/.nuvira

**File:** `src/config/paths.ts`
```typescript
// BEFORE
const DEFAULT_CONFIG_DIR = join(homedir(), '.buff');

// AFTER
const DEFAULT_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR
  || process.env.BUFF_CONFIG_DIR
  || join(homedir(), '.nuvira');
// Legacy fallback: if ~/.nuvira doesn't exist but ~/.buff does, use ~/.buff
```
**Status:** ☐ Pending

**File:** `src/utils/env.ts`
```typescript
// BEFORE
const homeEnvPath = join(homedir(), '.buff', '.env');

// AFTER
const homeEnvPath = process.env.NUVIRA_ENV_FILE
  || process.env.BUFF_ENV_FILE
  || (existsSync(join(homedir(), '.nuvira', '.env'))
    ? join(homedir(), '.nuvira', '.env')
    : join(homedir(), '.buff', '.env'));
```
**Status:** ☐ Pending

---

### Step 3: Env vars — Support both BUFF_* and NUVIRA_*

**File:** `src/gateway/platform-config.ts`
```typescript
// BEFORE
export const PLATFORM_ENV_VARS = {
  telegram: ['BUFF_TELEGRAM_TOKEN'],
  whatsapp: ['BUFF_WHATSAPP_SESSION_DIR'],
  // ... all 22 platforms
};

// AFTER
export const PLATFORM_ENV_VARS = {
  telegram: ['NUVIRA_TELEGRAM_TOKEN', 'BUFF_TELEGRAM_TOKEN'],
  whatsapp: ['NUVIRA_WHATSAPP_SESSION_DIR', 'BUFF_WHATSAPP_SESSION_DIR'],
  // ... all 22 platforms (both prefixes)
};
```
**Status:** ☐ Pending

**File:** `src/config/paths.ts` — All BUFF_* constants
```typescript
// BEFORE
export const BUFF_CONFIG_DIR = process.env.BUFF_CONFIG_DIR;
export const BUFF_MEMORY_DIR = process.env.BUFF_MEMORY_DIR;
// ... 67 env vars

// AFTER
export const NUVIRA_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR || process.env.BUFF_CONFIG_DIR;
export const NUVIRA_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR || process.env.BUFF_MEMORY_DIR;
// ... 67 env vars (both prefixes)
```
**Status:** ☐ Pending

---

### Step 4: CLI — Add nuvira command name

**File:** `src/cli/router.ts`
```typescript
// BEFORE
program.name('buff')
  .description('Agent-Nuvira — AI coding agent with 22-platform gateway');

// AFTER
const isNuvira = process.argv[1]?.includes('nuvira');
const cliName = isNuvira ? 'nuvira' : 'buff';
program.name(cliName)
  .description('Nuvira — AI coding agent with 22-platform gateway');
```
**Status:** ☐ Pending

---

### Step 5: Logger messages — Add nuvira variants

**Files:** All `src/cli/*.ts` files (50+ files)
```typescript
// BEFORE
logger.info('Run `buff gateway start`');

// AFTER
logger.info(`Run \`${cliName} gateway start\``);
```
**Status:** ☐ Pending

---

### Step 6: Dashboard — Update UI text

**Files:** All `src/web-dashboard/src/components/*.tsx` files
```typescript
// BEFORE
<h1>Agent Hub — Nuvira Dashboard</h1>
<p>Run `buff gateway start`</p>

// AFTER
<h1>Nuvira Dashboard</h1>
<p>Run `nuvira gateway start`</p>
```
**Status:** ☐ Pending

---

### Step 7: Tests — Add nuvira test cases

**Files:** All `tests/**/*.ts` files
```typescript
// BEFORE
expect(output).toContain('buff gateway start');

// AFTER
expect(output).toContain(`${cliName} gateway start`);
```
**Status:** ☐ Pending

---

## Phase 2: Remove buff (Mechanical replacement)

Once Phase 1 is complete and verified, Phase 2 is a scripted find-and-replace:

### Script: `scripts/rename-buff-to-nuvira.sh`

```bash
#!/bin/bash
# Phase 2: Remove buff, keep only nuvira

# 1. Package.json — remove buff binary
sed -i 's/"buff": "dist\/index.js",//' package.json

# 2. Config paths — remove BUFF_* fallbacks
find src/ -name "*.ts" -exec sed -i 's/process\.env\.BUFF_/process.env.NUVIRA_/g' {} +

# 3. Env vars — remove BUFF_* from PLATFORM_ENV_VARS
find src/ -name "*.ts" -exec sed -i "s/'BUFF_/NUVIRA_/g" {} +

# 4. CLI — hardcode nuvira
find src/cli/ -name "*.ts" -exec sed -i "s/buff/nuvira/g" {} +

# 5. Logger messages — replace buff with nuvira
find src/ -name "*.ts" -exec sed -i "s/\\\`buff /\\\`nuvira /g" {} +

# 6. Dashboard — replace buff with nuvira
find src/web-dashboard/ -name "*.tsx" -exec sed -i "s/buff/nuvira/g" {} +

# 7. Tests — replace buff with nuvira
find tests/ -name "*.ts" -exec sed -i "s/buff/nuvira/g" {} +

# 8. Config file — rename buffconfig.json
find src/ -name "*.ts" -exec sed -i "s/buffconfig/nuviraconfig/g" {} +

# 9. Config dir — rename ~/.buff
find src/ -name "*.ts" -exec sed -i "s/\.buff/\.nuvira/g" {} +

echo "✅ Phase 2 complete: buff → nuvira"
```

**Status:** ☐ Pending (after Phase 1 verified)

---

## File Count Summary

| Category | Files | Lines to change |
|----------|-------|-----------------|
| Package config | 1 | 3 |
| Config paths | 2 | 10 |
| Env vars | 3 | 200+ |
| CLI commands | 50+ | 100+ |
| Dashboard UI | 30+ | 50+ |
| Gateway | 15+ | 30+ |
| Tests | 100+ | 200+ |
| Documentation | 20+ | 500+ |
| **Total** | **220+** | **1100+** |

---

## Verification Checklist

After Phase 1:
- [ ] `nuvira --help` works
- [ ] `buff --help` still works
- [ ] `NUVIRA_TELEGRAM_TOKEN` works
- [ ] `BUFF_TELEGRAM_TOKEN` still works
- [ ] `~/.nuvira/` is used when exists
- [ ] `~/.buff/` is used as fallback
- [ ] All tests pass
- [ ] Dashboard loads correctly
- [ ] Gateway starts correctly

After Phase 2:
- [ ] `nuvira --help` works
- [ ] `buff --help` shows deprecation
- [ ] `NUVIRA_TELEGRAM_TOKEN` works
- [ ] `BUFF_TELEGRAM_TOKEN` shows deprecation
- [ ] `~/.nuvira/` is used
- [ ] All tests pass
- [ ] No "buff" references remain in code

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Users can't find `buff` | Keep as alias for 6 months |
| Env vars stop working | Fallback chain: NUVIRA_* → BUFF_* |
| Config files not found | Auto-migrate on first run |
| Tests break | Run full suite after each change |
| Dashboard breaks | Manual testing required |

---

## Estimated Timeline

| Phase | Duration | Effort |
|-------|----------|--------|
| Phase 1: Add nuvira | 2 weeks | 80 hours |
| Testing & verification | 1 week | 40 hours |
| Phase 2: Remove buff | 1 day | 8 hours |
| **Total** | **~3 weeks** | **~128 hours** |

---

**Note:** This tracker captures EVERY change. Phase 2 is mechanical because every file and line is documented here.
