# Rename Assessment: buff → nuvira

**Date:** August 21, 2026
**Status:** Assessment Complete — Awaiting Approval

---

## Executive Summary

| Metric | Count |
|--------|-------|
| **"buff" references** | 186+ in code, 539+ in docs |
| **"freebuff" references** | 36 |
| **"codebuff" references** | 23 |
| **Env vars (BUFF_*)** | 67 unique |
| **Config files** | buffconfig.json, ~/.buff/ |
| **CLI commands** | All use `buff <command>` |
| **Risk Level** | 🔴 HIGH — breaking change across entire system |

---

## 1. Package & Binary Names

| Current | Proposed | Files |
|---------|----------|-------|
| `agent-nuvira` (npm package) | `nuvira` | package.json |
| `buff` (CLI binary) | `nuvira` | package.json bin |
| `freebuff` (Freebuff wrapper) | `nuvira` | /opt/homebrew/bin/freebuff |

**Impact:** Users must reinstall: `npm install -g nuvira`

---

## 2. Environment Variables (67 vars)

All `BUFF_*` env vars must become `NUVIRA_*`:

| Category | Current | Proposed |
|----------|---------|----------|
| **Dashboard** | `BUFF_DASHBOARD_PORT` | `NUVIRA_DASHBOARD_PORT` |
| **Gateway** | `BUFF_TELEGRAM_TOKEN` | `NUVIRA_TELEGRAM_TOKEN` |
| **Config** | `BUFF_CONFIG_DIR` | `NUVIRA_CONFIG_DIR` |
| **Memory** | `BUFF_MEMORY_DIR` | `NUVIRA_MEMORY_DIR` |
| **Gateway policy** | `BUFF_GATEWAY_ALLOW_IDS` | `NUVIRA_GATEWAY_ALLOW_IDS` |
| **...and 62 more** | `BUFF_*` | `NUVIRA_*` |

**Impact:** All existing `.env` files must be migrated. Users must update shell profiles.

---

## 3. Config Files & Paths

| Current | Proposed | Notes |
|---------|----------|-------|
| `~/.buff/` | `~/.nuvira/` | All config, memory, gateway data |
| `~/.buff/.env` | `~/.nuvira/.env` | Env vars |
| `~/.buff/buffconfig.json` | `~/.nuvira/nuviraconfig.json` | Main config |
| `~/.buff/gateway/` | `~/.nuvira/gateway/` | Aliases, contacts, inbox |
| `~/.buff/memory/` | `~/.nuvira/memory/` | Vectors, trajectories |
| `BUFF_CONFIG_DIR` env | `NUVIRA_CONFIG_DIR` env | Override path |

**Impact:** Must migrate existing data or support both paths during transition.

---

## 4. CLI Commands

All commands change from `buff <cmd>` to `nuvira <cmd>`:

| Current | Proposed |
|---------|----------|
| `buff dashboard start` | `nuvira dashboard start` |
| `buff gateway start` | `nuvira gateway start` |
| `buff chat "hello"` | `nuvira chat "hello"` |
| `buff config set` | `nuvira config set` |
| `buff gateway contact approve` | `nuvira gateway contact approve` |
| `buff provider health` | `nuvira provider health` |
| `buff doctor` | `nuvira doctor` |
| ...and 50+ more commands | ... |

**Impact:** All shell scripts, aliases, documentation must be updated.

---

## 5. Source Code References

### 5.1 Logger Messages (50+ occurrences)
```typescript
// Before
logger.info('Run `buff gateway start`');
logger.info('See ~/.buff/.env');

// After
logger.info('Run `nuvira gateway start`');
logger.info('See ~/.nuvira/.env');
```

### 5.2 Help Text (100+ occurrences)
```typescript
// Before
.description('Send a message: buff gateway send telegram:123 "hi"')

// After
.description('Send a message: nuvira gateway send telegram:123 "hi"')
```

### 5.3 Config File References
```typescript
// Before
const CONFIG_FILE = 'buffconfig.json';
const configPath = join(homedir(), '.buff', 'buffconfig.json');

// After
const CONFIG_FILE = 'nuviraconfig.json';
const configPath = join(homedir(), '.nuvira', 'nuviraconfig.json');
```

### 5.4 Platform Config
```typescript
// Before
export const PLATFORM_ENV_VARS = {
  telegram: ['BUFF_TELEGRAM_TOKEN'],
  whatsapp: ['BUFF_WHATSAPP_SESSION_DIR'],
};

// After
export const PLATFORM_ENV_VARS = {
  telegram: ['NUVIRA_TELEGRAM_TOKEN'],
  whatsapp: ['NUVIRA_WHATSAPP_SESSION_DIR'],
};
```

---

## 6. Dashboard UI

### 6.1 Page Titles
```tsx
// Before
<h1>Agent Hub — Nuvira Dashboard</h1>

// After
<h1>Nuvira Dashboard</h1>
```

### 6.2 Navigation
```tsx
// Before
{ path: '/hub', label: 'Agent Hub', icon: '🧰' }

// After
{ path: '/hub', label: 'Hub', icon: '🧰' }
```

### 6.3 Help Text
```tsx
// Before
<p>Run `buff gateway start` to begin</p>

// After
<p>Run `nuvira gateway start` to begin</p>
```

---

## 7. Tests

### 7.1 Test Expectations
```typescript
// Before
expect(output).toContain('buff gateway start');

// After
expect(output).toContain('nuvira gateway start');
```

### 7.2 Mock Data
```typescript
// Before
const mockConfig = { name: 'buffconfig.json' };

// After
const mockConfig = { name: 'nuviraconfig.json' };
```

---

## 8. Documentation

### 8.1 README.md
- All CLI examples: `buff` → `nuvira`
- Config paths: `~/.buff` → `~/.nuvira`
- Installation: `npm install -g agent-nuvira` → `npm install -g nuvira`

### 8.2 CHANGELOG.md
- Historical entries can keep "buff" (they're past tense)
- New entries use "nuvira"

### 8.3 docs/*.md
- 539+ references to update
- All CLI examples, config paths, env vars

---

## 9. External References

### 9.1 GitHub
- Repository name: `agent-nuvira` → `nuvira`
- Issues URL
- README badges

### 9.2 npm
- Package name: `agent-nuvira` → `nuvira`
- README on npmjs.com

### 9.3 LaunchAgent
```xml
<!-- Before -->
<key>Label</key>
<string>com.agent-nuvira.dashboard</string>

<!-- After -->
<key>Label</key>
<string>com.nuvira.dashboard</string>
```

---

## 10. "freebuff" References

The `freebuff` binary is a wrapper that:
1. Checks for updates
2. Downloads new versions
3. Spawns the actual binary

Must rename to `nuvira` and update:
- `/opt/homebrew/bin/freebuff` → `/opt/homebrew/bin/nuvira`
- Update launcher.js package name
- Update telemetry events

---

## 11. "codebuff" References

Mostly in comments and internal references:
- `Co-Authored-By: Codebuff` (in git commits — can stay)
- Internal code comments referencing the original project
- Test fixtures

**Recommendation:** Keep "Codebuff" in git commit footers (it's the tool, not the product).

---

## 12. Migration Strategy

### Phase 1: Preparation (No breaking changes)
1. Add `nuvira` as secondary binary in package.json
2. Add `NUVIRA_*` env var support (fallback to `BUFF_*`)
3. Add `~/.nuvira/` path support (fallback to `~/.buff/`)
4. Update docs to show both forms

### Phase 2: Transition
1. Ship both `buff` and `nuvira` binaries
2. Deprecation warnings on `buff` usage
3. Migration script: `nuvira migrate` (copies ~/.buff → ~/.nuvira)

### Phase 3: Cutover
1. Remove `buff` binary
2. Remove `BUFF_*` env var fallbacks
3. Remove `~/.buff/` path support
4. Full rename complete

---

## 13. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Users can't find `buff` command | 🔴 HIGH | Keep `buff` as alias for 6 months |
| Env vars stop working | 🔴 HIGH | Support both `BUFF_*` and `NUVIRA_*` |
| Config files not found | 🔴 HIGH | Auto-migrate on first run |
| Dashboard breaks | 🟡 MEDIUM | Test all endpoints |
| Gateway stops working | 🟡 MEDIUM | Test all adapters |
| Tests fail | 🟡 MEDIUM | Update all test expectations |
| Documentation outdated | 🟢 LOW | Phase docs update last |

---

## 14. Effort Estimate

| Phase | Effort | Duration |
|-------|--------|----------|
| Assessment | ✅ Done | — |
| Phase 1: Preparation | 40 hours | 1 week |
| Phase 2: Transition | 20 hours | 3 days |
| Phase 3: Cutover | 10 hours | 2 days |
| Testing | 20 hours | 3 days |
| **Total** | **90 hours** | **~3 weeks** |

---

## 15. Recommendation

**DO NOT do a hard rename.** Instead:

1. **Keep `buff` as the primary CLI** for now
2. **Add `nuvira` as an alias** (package.json bin)
3. **Gradually replace references** in new code
4. **Deprecate `buff`** in v2.0.0 with warnings
5. **Remove `buff`** in v3.0.0

This avoids breaking the 1000+ existing users while allowing new branding.

---

## 16. Decision Required

| Option | Pros | Cons |
|--------|------|------|
| **A: Full rename now** | Clean break, new identity | Breaks everything, 3 weeks work |
| **B: Gradual transition** | No breakage, smooth | 6 months of dual naming |
| **C: Keep buff, add nuvira alias** | Zero breakage | Confusing dual names |

**Awaiting user decision before proceeding.**
