# Rename Project: buff → nuvira

**Project Lead:** Dheeraj Sharma
**Created:** August 21, 2026
**Status:** 🟡 Assessment Complete — Awaiting Decision

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| Aug 21 | Assessment complete | 186+ code refs, 539+ doc refs, 67 env vars |

**Decision pending:** Full rename vs gradual transition

---

## Task Tracker

### Phase 1: Preparation (No breaking changes)

- [ ] 1.1 Add `nuvira` as secondary binary in package.json
- [ ] 1.2 Add `NUVIRA_*` env var support with `BUFF_*` fallback
- [ ] 1.3 Add `~/.nuvira/` path support with `~/.buff/` fallback
- [ ] 1.4 Create migration script: `nuvira migrate`
- [ ] 1.5 Update README with both forms
- [ ] 1.6 Add deprecation warnings on `buff` usage

### Phase 2: Code Changes

- [ ] 2.1 Rename package.json bin: `buff` → `nuvira` (keep buff as alias)
- [ ] 2.2 Update all 67 env vars: `BUFF_*` → `NUVIRA_*`
- [ ] 2.3 Update config paths: `~/.buff/` → `~/.nuvira/`
- [ ] 2.4 Update config file: `buffconfig.json` → `nuviraconfig.json`
- [ ] 2.5 Update CLI help text (100+ occurrences)
- [ ] 2.6 Update logger messages (50+ occurrences)
- [ ] 2.7 Update dashboard UI text
- [ ] 2.8 Update platform config env vars

### Phase 3: Documentation

- [ ] 3.1 Update README.md
- [ ] 3.2 Update CHANGELOG.md (new entries only)
- [ ] 3.3 Update docs/*.md (539+ references)
- [ ] 3.4 Update API documentation
- [ ] 3.5 Update example scripts

### Phase 4: Testing

- [ ] 4.1 Update all test expectations
- [ ] 4.2 Update mock data
- [ ] 4.3 Run full test suite
- [ ] 4.4 Test CLI commands
- [ ] 4.5 Test dashboard
- [ ] 4.6 Test gateway
- [ ] 4.7 Test migration script

### Phase 5: Deployment

- [ ] 5.1 Publish new npm package
- [ ] 5.2 Update launchd plist
- [ ] 5.3 Update homebrew formula (if any)
- [ ] 5.4 Announce deprecation
- [ ] 5.5 Monitor issues

---

## Impact Assessment

### Breaking Changes (User-facing)

| Change | Impact | Migration |
|--------|--------|-----------|
| CLI command `buff` | 🔴 HIGH | `buff` still works as alias |
| Env vars `BUFF_*` | 🔴 HIGH | Fallback to `BUFF_*` |
| Config path `~/.buff/` | 🔴 HIGH | Auto-migrate |
| Config file name | 🟡 MEDIUM | Auto-rename |

### Non-breaking Changes (Internal)

| Change | Impact | Notes |
|--------|--------|-------|
| Logger messages | 🟢 LOW | Cosmetic only |
| Help text | 🟢 LOW | Cosmetic only |
| Comments | 🟢 LOW | No runtime effect |
| Tests | 🟢 LOW | Dev-only |

---

## File Change Map

### Critical Files (Must change)

| File | Changes | Risk |
|------|---------|------|
| `package.json` | bin name, package name | 🔴 |
| `src/config/paths.ts` | All path constants | 🔴 |
| `src/gateway/platform-config.ts` | All env vars | 🔴 |
| `src/cli/router.ts` | CLI name | 🔴 |
| `src/web-dashboard/server.ts` | Config paths | 🟡 |

### High Priority Files

| File | Changes | Risk |
|------|---------|------|
| `src/cli/*.ts` | Help text, commands | 🟡 |
| `src/gateway/*.ts` | Env vars, paths | 🟡 |
| `src/web-dashboard/*.ts` | UI text | 🟡 |
| `tests/**/*.ts` | Expectations | 🟡 |

### Low Priority Files

| File | Changes | Risk |
|------|---------|------|
| `docs/*.md` | Documentation | 🟢 |
| `CHANGELOG.md` | New entries only | 🟢 |
| `README.md` | Examples | 🟢 |
| Comments in code | No change needed | 🟢 |

---

## Estimated Effort

| Phase | Hours | Days |
|-------|-------|------|
| Phase 1: Preparation | 40 | 5 |
| Phase 2: Code Changes | 60 | 7.5 |
| Phase 3: Documentation | 20 | 2.5 |
| Phase 4: Testing | 20 | 2.5 |
| Phase 5: Deployment | 10 | 1.25 |
| **Total** | **150** | **~4 weeks** |

---

## Success Criteria

- [ ] `nuvira` command works identically to `buff`
- [ ] All `BUFF_*` env vars work with `NUVIRA_*` prefix
- [ ] Config migration works automatically
- [ ] All tests pass
- [ ] Dashboard displays correctly
- [ ] Gateway functions normally
- [ ] Documentation is accurate

---

## Notes

- **Do NOT rush this** — it touches every part of the system
- **Keep backward compatibility** for at least 6 months
- **Test thoroughly** — this is a rename, not a refactor
- **User communication** — announce deprecation timeline early
