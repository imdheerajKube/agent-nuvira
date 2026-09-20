/**
 * Skill execution audit — round-trip + isolation.
 *
 * Two bugs are pinned here, both verified before the fix:
 *
 * 1. NOTHING WROTE IT. The audit backend was complete and referenced nowhere, so
 *    a skill execution left no inspectable record at all. `runSkillExecute` now
 *    logs every run — this test proves the write/read round-trip works.
 * 2. IT WROTE TO THE REAL PROFILE. `logDir` was `join(homedir(), '.nuvira',
 *    'audit')` evaluated at MODULE LOAD, so a hermetic run pointed at
 *    NUVIRA_CONFIG_DIR still wrote into the user's real home — the same
 *    isolation class already fixed for credentials and the failure ledger.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { logExecution, queryAuditEntries, getAuditStats } from '../../src/skills/execution-audit.js';

let tempDir: string;
let originalConfigDir: string | undefined;
let originalAuditDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-audit-'));
  originalConfigDir = process.env.NUVIRA_CONFIG_DIR;
  originalAuditDir = process.env.NUVIRA_AUDIT_DIR;
  process.env.NUVIRA_CONFIG_DIR = tempDir;
  delete process.env.NUVIRA_AUDIT_DIR;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = originalConfigDir;
  if (originalAuditDir === undefined) delete process.env.NUVIRA_AUDIT_DIR;
  else process.env.NUVIRA_AUDIT_DIR = originalAuditDir;
  rmSync(tempDir, { recursive: true, force: true });
});

const entry = (skillName: string, status: 'success' | 'failure' = 'success') => ({
  skillName,
  skillSource: 'local',
  runtime: 'node',
  status,
  sessionId: 's1',
  durationMs: 12,
  exitCode: status === 'success' ? 0 : 1,
});

describe('skill execution audit', () => {
  it('round-trips a logged execution back out of the query API', async () => {
    await logExecution(entry('demo-skill'));

    const entries = await queryAuditEntries({ skillName: 'demo-skill' });

    expect(entries).toHaveLength(1);
    expect(entries[0].skillName).toBe('demo-skill');
    expect(entries[0].status).toBe('success');
    expect(entries[0].runtime).toBe('node');
  });

  it('writes INSIDE the configured dir — never the real user profile', async () => {
    await logExecution(entry('isolated-skill'));

    // The default audit dir is resolved lazily from the config dir, so the
    // hermetic run's log lands under the temp dir it was given.
    expect(existsSync(join(tempDir, 'audit'))).toBe(true);
    expect(readdirSync(join(tempDir, 'audit')).length).toBeGreaterThan(0);
  });

  it('honours an explicit NUVIRA_AUDIT_DIR override', async () => {
    const explicit = mkdtempSync(join(tmpdir(), 'buff-audit-explicit-'));
    process.env.NUVIRA_AUDIT_DIR = explicit;
    try {
      await logExecution(entry('explicit-dir-skill'));
      expect(existsSync(join(explicit, 'skill-executions.log'))).toBe(true);
    } finally {
      rmSync(explicit, { recursive: true, force: true });
    }
  });

  it('exposes aggregate stats the dashboard panel reports', async () => {
    await logExecution(entry('ok-skill', 'success'));
    await logExecution(entry('bad-skill', 'failure'));

    const stats = await getAuditStats();

    expect(stats.total).toBeGreaterThanOrEqual(2);
    expect(stats.success).toBeGreaterThanOrEqual(1);
    expect(stats.failure).toBeGreaterThanOrEqual(1);
  });

  it('filters by status, so a failing-only view is possible', async () => {
    await logExecution(entry('a', 'success'));
    await logExecution(entry('b', 'failure'));

    const failures = await queryAuditEntries({ status: 'failure' });

    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures.every((e) => e.status === 'failure')).toBe(true);
  });
});
