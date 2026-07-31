/**
 * Routing History — Unit tests for the Auto-router decision store.
 *
 * Covers:
 * - recordRoutingDecision() — appends entries, generates ids/timestamps
 * - getRoutingHistory() — most-recent-first ordering, limit
 * - getRoutingUsageStats() — totals, last-24h, per provider/model/source/complexity
 * - clearRoutingHistory() — wipes the store
 * - Cap at MAX_ENTRIES (500) — keeps the most recent entries
 * - Resilience — missing/malformed files return empty state without throwing
 *
 * Uses BUFF_MEMORY_DIR pointed at a temp dir so tests never touch ~/.buff.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// ─── Temp memory dir (BUFF_MEMORY_DIR is read at module import) ────────────

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-routing-history-test-'));
process.env.BUFF_MEMORY_DIR = join(testDir, '.buff', 'memory');

// Import AFTER setting BUFF_MEMORY_DIR so the store writes to the temp dir
const { recordRoutingDecision, getRoutingHistory, getRoutingUsageStats, clearRoutingHistory } =
  await import('../../src/learning/routing-history.js');

afterAll(() => {
  delete process.env.BUFF_MEMORY_DIR;
  rmSync(testDir, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function record(overrides: Partial<Parameters<typeof recordRoutingDecision>[0]> = {}): void {
  recordRoutingDecision({
    source: 'explain',
    agentType: 'chat',
    task: 'implement a login form',
    complexity: 'moderate',
    provider: 'groq',
    model: 'llama-3.3-70b',
    score: 0.8,
    ...overrides,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('recordRoutingDecision', () => {
  beforeEach(() => {
    clearRoutingHistory();
  });

  it('appends entries with generated ids and timestamps', () => {
    record({ task: 'task one' });
    record({ task: 'task two' });

    const history = getRoutingHistory();
    expect(history).toHaveLength(2);
    for (const entry of history) {
      expect(entry.id).toBeTruthy();
      expect(typeof entry.timestamp).toBe('number');
    }
    // Fields round-trip
    expect(history.some((h) => h.task === 'task one')).toBe(true);
    expect(history.some((h) => h.provider === 'groq' && h.model === 'llama-3.3-70b')).toBe(true);
  });

  it('stores the source, agentType, and complexity', () => {
    record({ source: 'chat', agentType: 'writer', complexity: 'critical', provider: 'gemini' });
    const entry = getRoutingHistory()[0];
    expect(entry.source).toBe('chat');
    expect(entry.agentType).toBe('writer');
    expect(entry.complexity).toBe('critical');
    expect(entry.provider).toBe('gemini');
  });

  it('caps the store at 500 entries keeping the most recent', () => {
    for (let i = 0; i < 520; i++) {
      record({ task: `task-${i}` });
    }
    const history = getRoutingHistory(1000);
    expect(history.length).toBe(500);
    // Most recent entries retained
    expect(history[0].task).toBe('task-519');
    expect(history[history.length - 1].task).toBe('task-20');
  });
});

describe('getRoutingHistory', () => {
  beforeEach(() => {
    clearRoutingHistory();
  });

  it('returns entries most-recent-first', () => {
    record({ task: 'old' });
    // Sleep-free ordering relies on timestamp; ids differ, so sort by insertion
    record({ task: 'new' });
    const history = getRoutingHistory();
    expect(history[0].task).toBe('new');
    expect(history[1].task).toBe('old');
  });

  it('respects the limit argument', () => {
    for (let i = 0; i < 10; i++) record({ task: `t${i}` });
    const limited = getRoutingHistory(3);
    expect(limited).toHaveLength(3);
    const full = getRoutingHistory();
    expect(full).toHaveLength(10);
  });

  it('returns empty array when the store is empty', () => {
    expect(getRoutingHistory()).toEqual([]);
  });
});

describe('getRoutingUsageStats', () => {
  beforeEach(() => {
    clearRoutingHistory();
  });

  it('returns zeroed stats for an empty store', () => {
    const stats = getRoutingUsageStats();
    expect(stats.total).toBe(0);
    expect(stats.last24h).toBe(0);
    expect(stats.byProvider).toEqual({});
    expect(stats.byModel).toEqual({});
    expect(stats.bySource).toEqual({});
    expect(stats.byComplexity).toEqual({});
    expect(typeof stats.updatedAt).toBe('number');
  });

  it('aggregates by provider/model/source/complexity', () => {
    record({ source: 'explain', provider: 'groq', model: 'llama-3.3-70b', complexity: 'moderate' });
    record({ source: 'chat', provider: 'groq', model: 'llama-3.3-70b', complexity: 'simple' });
    record({ source: 'orchestrator', provider: 'gemini', model: 'gemini-2.0-flash', complexity: 'critical' });

    const stats = getRoutingUsageStats();
    expect(stats.total).toBe(3);
    expect(stats.byProvider).toEqual({ groq: 2, gemini: 1 });
    expect(stats.byModel).toEqual({ 'llama-3.3-70b': 2, 'gemini-2.0-flash': 1 });
    expect(stats.bySource).toEqual({ explain: 1, chat: 1, orchestrator: 1 });
    expect(stats.byComplexity).toEqual({ moderate: 1, simple: 1, critical: 1 });
  });

  it('counts only decisions within the last 24h in last24h', () => {
    record({ task: 'recent' });
    record({ task: 'old' });
    // The store always stamps now; inject an old timestamp directly via the file
    const { readFileSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    const { join: pathJoin } = require('node:path') as typeof import('node:path');
    const file = pathJoin(testDir, '.buff', 'memory', 'routing-history.json');
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    data.entries[1].timestamp = Date.now() - 25 * 60 * 60 * 1000; // 25h ago
    writeFileSync(file, JSON.stringify(data, null, 2));

    const stats = getRoutingUsageStats();
    expect(stats.total).toBe(2);
    expect(stats.last24h).toBe(1);
  });
});

describe('clearRoutingHistory', () => {
  beforeEach(() => {
    clearRoutingHistory();
  });

  it('wipes all recorded decisions', () => {
    record();
    record();
    expect(getRoutingHistory()).toHaveLength(2);
    clearRoutingHistory();
    expect(getRoutingHistory()).toEqual([]);
    expect(getRoutingUsageStats().total).toBe(0);
  });
});

describe('resilience', () => {
  it('handles a corrupt store file without throwing', () => {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    const { join: pathJoin } = require('node:path') as typeof import('node:path');
    const file = pathJoin(testDir, '.buff', 'memory', 'routing-history.json');
    writeFileSync(file, '{broken json', 'utf-8');
    expect(() => getRoutingHistory()).not.toThrow();
    expect(getRoutingHistory()).toEqual([]);
    // Recording still works after corruption (rewrites the file)
    record({ task: 'after-corruption' });
    expect(getRoutingHistory()).toHaveLength(1);
  });
});
