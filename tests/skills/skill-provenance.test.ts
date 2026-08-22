/**
 * Tests for the Skill Provenance system.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import {
  computeHash,
  computeFileHash,
  verifyHash,
  verifyFileHash,
  recordProvenance,
  verifyProvenance,
  getProvenance,
  getAllProvenance,
  getProvenanceStats,
  removeProvenance,
  updateProvenance,
} from '../../src/skills/skill-provenance.js';

describe('Skill Provenance', () => {
  const testDir = join(tmpdir(), 'provenance-test-' + Date.now());
  const testFile = join(testDir, 'test-skill.sh');
  const testContent = '#!/bin/bash\necho "hello"';

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(testFile, testContent, 'utf-8');
    // Clear any existing provenance entries
    const entries = await getAllProvenance();
    for (const entry of entries) {
      await removeProvenance(entry.skillName);
    }
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('Hash Functions', () => {
    it('computes SHA-256 hash', () => {
      const hash = computeHash('hello world');
      expect(hash).toHaveLength(64); // SHA-256 produces 64 hex chars
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });

    it('computes consistent hashes', () => {
      const hash1 = computeHash('hello');
      const hash2 = computeHash('hello');
      expect(hash1).toBe(hash2);
    });

    it('produces different hashes for different content', () => {
      const hash1 = computeHash('hello');
      const hash2 = computeHash('world');
      expect(hash1).not.toBe(hash2);
    });

    it('computes file hash', async () => {
      const hash = await computeFileHash(testFile);
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });

    it('verifies hash matches', () => {
      const hash = computeHash(testContent);
      expect(verifyHash(testContent, hash)).toBe(true);
    });

    it('detects hash mismatch', () => {
      const hash = computeHash('different content');
      expect(verifyHash(testContent, hash)).toBe(false);
    });

    it('verifies file hash', async () => {
      const hash = await computeFileHash(testFile);
      const result = await verifyFileHash(testFile, hash);
      expect(result.verified).toBe(true);
      expect(result.actualHash).toBe(hash);
    });

    it('detects file hash mismatch', async () => {
      const result = await verifyFileHash(testFile, 'wrong-hash');
      expect(result.verified).toBe(false);
    });
  });

  describe('Provenance Recording', () => {
    it('records provenance for a skill', async () => {
      const entry = await recordProvenance({
        skillName: 'test-skill',
        filePath: testFile,
        origin: 'marketplace',
        version: '1.0.0',
        author: 'Test Author',
      });

      expect(entry.skillName).toBe('test-skill');
      expect(entry.origin).toBe('marketplace');
      expect(entry.version).toBe('1.0.0');
      expect(entry.author).toBe('Test Author');
      expect(entry.verified).toBe(true);
      expect(entry.hash).toHaveLength(64);
      expect(entry.recordedAt).toBeGreaterThan(0);
    });

    it('stores provenance persistently', async () => {
      await recordProvenance({
        skillName: 'test-skill',
        filePath: testFile,
        origin: 'bundled',
      });

      const entry = await getProvenance('test-skill');
      expect(entry).not.toBeNull();
      expect(entry!.skillName).toBe('test-skill');
    });

    it('overwrites existing provenance', async () => {
      await recordProvenance({
        skillName: 'test-skill',
        filePath: testFile,
        origin: 'marketplace',
        version: '1.0.0',
      });

      await recordProvenance({
        skillName: 'test-skill',
        filePath: testFile,
        origin: 'marketplace',
        version: '2.0.0',
      });

      const entry = await getProvenance('test-skill');
      expect(entry!.version).toBe('2.0.0');
      expect(entry!.previousHash).toBeDefined();
    });
  });

  describe('Provenance Verification', () => {
    it('verifies provenance matches file', async () => {
      await recordProvenance({
        skillName: 'test-skill',
        filePath: testFile,
        origin: 'marketplace',
      });

      const result = await verifyProvenance('test-skill', testFile);
      expect(result.verified).toBe(true);
      expect(result.entry).not.toBeNull();
    });

    it('detects tampered file', async () => {
      await recordProvenance({
        skillName: 'test-skill',
        filePath: testFile,
        origin: 'marketplace',
      });

      // Tamper with the file
      await writeFile(testFile, 'tampered content', 'utf-8');

      const result = await verifyProvenance('test-skill', testFile);
      expect(result.verified).toBe(false);
      expect(result.reason).toContain('Hash mismatch');
    });

    it('returns false for unknown skill', async () => {
      const result = await verifyProvenance('unknown-skill', testFile);
      expect(result.verified).toBe(false);
      expect(result.reason).toContain('No provenance record');
    });
  });

  describe('Provenance Management', () => {
    it('gets all provenance entries', async () => {
      await recordProvenance({
        skillName: 'skill-1',
        filePath: testFile,
        origin: 'bundled',
      });

      await recordProvenance({
        skillName: 'skill-2',
        filePath: testFile,
        origin: 'marketplace',
      });

      const entries = await getAllProvenance();
      expect(entries.length).toBe(2);
    });

    it('removes provenance', async () => {
      await recordProvenance({
        skillName: 'test-skill',
        filePath: testFile,
        origin: 'local',
      });

      const removed = await removeProvenance('test-skill');
      expect(removed).toBe(true);

      const entry = await getProvenance('test-skill');
      expect(entry).toBeNull();
    });

    it('returns false when removing unknown skill', async () => {
      const removed = await removeProvenance('unknown-skill');
      expect(removed).toBe(false);
    });

    it('updates provenance', async () => {
      await recordProvenance({
        skillName: 'test-skill',
        filePath: testFile,
        origin: 'marketplace',
        version: '1.0.0',
      });

      const updated = await updateProvenance('test-skill', testFile, {
        version: '2.0.0',
      });

      expect(updated).not.toBeNull();
      expect(updated!.version).toBe('2.0.0');
      expect(updated!.previousHash).toBeDefined();
    });

    it('returns null when updating unknown skill', async () => {
      const updated = await updateProvenance('unknown-skill', testFile, {
        version: '2.0.0',
      });
      expect(updated).toBeNull();
    });
  });

  describe('Statistics', () => {
    it('calculates statistics', async () => {
      await recordProvenance({
        skillName: 'skill-1',
        filePath: testFile,
        origin: 'bundled',
      });

      await recordProvenance({
        skillName: 'skill-2',
        filePath: testFile,
        origin: 'marketplace',
      });

      await recordProvenance({
        skillName: 'skill-3',
        filePath: testFile,
        origin: 'local',
      });

      const stats = await getProvenanceStats();
      expect(stats.total).toBe(3);
      expect(stats.byOrigin['bundled']).toBe(1);
      expect(stats.byOrigin['marketplace']).toBe(1);
      expect(stats.byOrigin['local']).toBe(1);
      expect(stats.verified).toBe(3);
      expect(stats.unverified).toBe(0);
    });
  });
});
