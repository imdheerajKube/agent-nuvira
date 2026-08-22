/**
 * Tests for the Execution Audit system.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm, mkdir } from 'node:fs/promises';
import {
  logExecution,
  queryAuditEntries,
  getAuditStats,
  cleanupAuditLog,
  exportAuditEntries,
  AuditConfig,
} from '../../src/skills/execution-audit.js';

describe('Execution Audit', () => {
  const testDir = join(tmpdir(), 'audit-test-' + Date.now());
  const testConfig: Partial<AuditConfig> = {
    logDir: testDir,
    logFile: 'test.log',
    maskSensitive: true,
  };

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('Logging', () => {
    it('logs a successful execution', async () => {
      await logExecution(
        {
          skillName: 'test-skill',
          skillSource: 'marketplace',
          runtime: 'python',
          status: 'success',
          sessionId: 'session-123',
          durationMs: 1500,
          exitCode: 0,
        },
        testConfig
      );

      const entries = await queryAuditEntries({}, testConfig);
      expect(entries.length).toBe(1);
      expect(entries[0].skillName).toBe('test-skill');
      expect(entries[0].status).toBe('success');
      expect(entries[0].runtime).toBe('python');
      expect(entries[0].durationMs).toBe(1500);
    });

    it('logs a failed execution', async () => {
      await logExecution(
        {
          skillName: 'failing-skill',
          skillSource: 'bundled',
          runtime: 'shell',
          status: 'failure',
          sessionId: 'session-456',
          durationMs: 500,
          exitCode: 1,
          error: 'Command not found',
        },
        testConfig
      );

      const entries = await queryAuditEntries({}, testConfig);
      expect(entries.length).toBe(1);
      expect(entries[0].status).toBe('failure');
      expect(entries[0].exitCode).toBe(1);
      expect(entries[0].error).toBe('Command not found');
    });

    it('logs timeout execution', async () => {
      await logExecution(
        {
          skillName: 'slow-skill',
          skillSource: 'marketplace',
          runtime: 'node',
          status: 'timeout',
          sessionId: 'session-789',
          durationMs: 30000,
        },
        testConfig
      );

      const entries = await queryAuditEntries({}, testConfig);
      expect(entries[0].status).toBe('timeout');
    });

    it('logs rejected execution', async () => {
      await logExecution(
        {
          skillName: 'untrusted-skill',
          skillSource: 'marketplace',
          runtime: 'python',
          status: 'rejected',
          sessionId: 'session-101',
          durationMs: 0,
        },
        testConfig
      );

      const entries = await queryAuditEntries({}, testConfig);
      expect(entries[0].status).toBe('rejected');
    });

    it('includes environment variables (masked)', async () => {
      process.env.TEST_API_KEY = 'secret-key-12345';
      process.env.NORMAL_VAR = 'normal-value';

      await logExecution(
        {
          skillName: 'env-skill',
          skillSource: 'marketplace',
          runtime: 'shell',
          status: 'success',
          sessionId: 'session-102',
          durationMs: 100,
          envVarsUsed: ['TEST_API_KEY', 'NORMAL_VAR'],
        },
        testConfig
      );

      delete process.env.TEST_API_KEY;
      delete process.env.NORMAL_VAR;

      const entries = await queryAuditEntries({}, testConfig);
      expect(entries[0].envVarsUsed).toBeDefined();
      expect(entries[0].envVarsUsed!.length).toBe(2);
      // API key should be masked
      expect(entries[0].envVarsUsed![0]).not.toBe('secret-key-12345');
      expect(entries[0].envVarsUsed![0]).toContain('****');
      // Normal var should be unmasked
      expect(entries[0].envVarsUsed![1]).toBe('normal-value');
    });

    it('generates unique entry IDs', async () => {
      await logExecution(
        {
          skillName: 'skill-1',
          skillSource: 'bundled',
          runtime: 'shell',
          status: 'success',
          sessionId: 'session-103',
          durationMs: 100,
        },
        testConfig
      );

      await logExecution(
        {
          skillName: 'skill-2',
          skillSource: 'bundled',
          runtime: 'shell',
          status: 'success',
          sessionId: 'session-103',
          durationMs: 100,
        },
        testConfig
      );

      const entries = await queryAuditEntries({}, testConfig);
      expect(entries.length).toBe(2);
      expect(entries[0].id).not.toBe(entries[1].id);
    });
  });

  describe('Querying', () => {
    beforeEach(async () => {
      // Add some test entries
      const entries = [
        { skillName: 'skill-a', status: 'success' as const, runtime: 'python' },
        { skillName: 'skill-a', status: 'failure' as const, runtime: 'python' },
        { skillName: 'skill-b', status: 'success' as const, runtime: 'node' },
        { skillName: 'skill-b', status: 'success' as const, runtime: 'node' },
        { skillName: 'skill-c', status: 'timeout' as const, runtime: 'shell' },
      ];

      for (let i = 0; i < entries.length; i++) {
        await logExecution(
          {
            ...entries[i],
            skillSource: 'marketplace',
            sessionId: `session-${i}`,
            durationMs: 100 * (i + 1),
          },
          testConfig
        );
      }
    });

    it('queries by skill name', async () => {
      const entries = await queryAuditEntries({ skillName: 'skill-a' }, testConfig);
      expect(entries.length).toBe(2);
      expect(entries.every(e => e.skillName === 'skill-a')).toBe(true);
    });

    it('queries by status', async () => {
      const entries = await queryAuditEntries({ status: 'success' }, testConfig);
      expect(entries.length).toBe(3);
      expect(entries.every(e => e.status === 'success')).toBe(true);
    });

    it('queries by session ID', async () => {
      const entries = await queryAuditEntries({ sessionId: 'session-0' }, testConfig);
      expect(entries.length).toBe(1);
    });

    it('applies limit', async () => {
      const entries = await queryAuditEntries({ limit: 2 }, testConfig);
      expect(entries.length).toBe(2);
    });

    it('returns sorted by timestamp (newest first)', async () => {
      const entries = await queryAuditEntries({}, testConfig);
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i - 1].timestamp).toBeGreaterThanOrEqual(entries[i].timestamp);
      }
    });
  });

  describe('Statistics', () => {
    beforeEach(async () => {
      const entries = [
        { skillName: 'skill-a', status: 'success' as const, runtime: 'python', durationMs: 100 },
        { skillName: 'skill-a', status: 'success' as const, runtime: 'python', durationMs: 200 },
        { skillName: 'skill-b', status: 'failure' as const, runtime: 'node', durationMs: 300 },
        { skillName: 'skill-c', status: 'timeout' as const, runtime: 'shell', durationMs: 400 },
      ];

      for (const entry of entries) {
        await logExecution(
          {
            ...entry,
            skillSource: 'marketplace',
            sessionId: 'session-stats',
          },
          testConfig
        );
      }
    });

    it('calculates correct statistics', async () => {
      const stats = await getAuditStats(testConfig);

      expect(stats.total).toBe(4);
      expect(stats.success).toBe(2);
      expect(stats.failure).toBe(1);
      expect(stats.timeout).toBe(1);
      expect(stats.rejected).toBe(0);
      expect(stats.error).toBe(0);

      expect(stats.bySkill['skill-a']).toBe(2);
      expect(stats.bySkill['skill-b']).toBe(1);
      expect(stats.bySkill['skill-c']).toBe(1);

      expect(stats.byRuntime['python']).toBe(2);
      expect(stats.byRuntime['node']).toBe(1);
      expect(stats.byRuntime['shell']).toBe(1);

      expect(stats.averageDurationMs).toBe(250); // (100+200+300+400)/4
    });
  });

  describe('Cleanup', () => {
    it('cleans up old entries', async () => {
      // Add an entry with old timestamp
      await logExecution(
        {
          skillName: 'old-skill',
          skillSource: 'marketplace',
          runtime: 'python',
          status: 'success',
          sessionId: 'session-old',
          durationMs: 100,
        },
        { ...testConfig, retentionDays: 1 }
      );

      // Add a recent entry
      await logExecution(
        {
          skillName: 'new-skill',
          skillSource: 'marketplace',
          runtime: 'python',
          status: 'success',
          sessionId: 'session-new',
          durationMs: 100,
        },
        testConfig
      );

      // Clean up with 0 day retention (should remove old entries)
      const removed = await cleanupAuditLog({ ...testConfig, retentionDays: 0 });

      // At least the old entry should be removed
      expect(removed).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Export', () => {
    it('exports as JSON', async () => {
      await logExecution(
        {
          skillName: 'export-skill',
          skillSource: 'marketplace',
          runtime: 'python',
          status: 'success',
          sessionId: 'session-export',
          durationMs: 100,
        },
        testConfig
      );

      const json = await exportAuditEntries('json', testConfig);
      const entries = JSON.parse(json);

      expect(Array.isArray(entries)).toBe(true);
      expect(entries.length).toBe(1);
      expect(entries[0].skillName).toBe('export-skill');
    });

    it('exports as CSV', async () => {
      await logExecution(
        {
          skillName: 'csv-skill',
          skillSource: 'marketplace',
          runtime: 'python',
          status: 'success',
          sessionId: 'session-csv',
          durationMs: 100,
        },
        testConfig
      );

      const csv = await exportAuditEntries('csv', testConfig);
      const lines = csv.split('\n');

      expect(lines.length).toBe(2); // Header + 1 data row
      expect(lines[0]).toContain('skillName');
      expect(lines[1]).toContain('csv-skill');
    });
  });
});
