/**
 * Unit tests for CLIManager.getQuotaStatus().
 *
 * Fixture-driven: writes real quota-ledger.json / quota-events.jsonl files
 * into a temp dir and points BUFF_MEMORY_DIR at it, then asserts the reader
 * parses them into the QuotaStatusInfo shape the QuotaPanel renders.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock vscode module (CLIManager imports it at module load)
vi.mock('vscode', () => {
  return import('./__mocks__/vscode.js');
});

import { CLIManager } from '../cliManager.js';

describe('CLIManager.getQuotaStatus', () => {
  const defaultConfig = {
    cliPath: 'buff',
    defaultProvider: '',
    defaultModel: '',
    autoApplyChanges: false,
    maxTokens: 4096,
    showProgressPanel: true,
    useAutoRouting: false,
  };

  let fixtureDir: string;
  let memoryDir: string;

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'buff-quota-test-'));
    memoryDir = join(fixtureDir, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    process.env.BUFF_MEMORY_DIR = memoryDir;
  });

  afterEach(() => {
    delete process.env.BUFF_MEMORY_DIR;
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('returns the empty shape when no ledger files exist', async () => {
    const manager = new CLIManager(defaultConfig);
    const status = await manager.getQuotaStatus();
    expect(status.enabled).toBe(false);
    expect(status.entries).toEqual([]);
    expect(status.events).toEqual([]);
    expect(status.freeTokens).toBe(0);
    expect(status.paidTokens).toBe(0);
    expect(status.estimatedSavedUsd).toBe(0);
  });

  it('never throws on a corrupt ledger file (best-effort read)', async () => {
    writeFileSync(join(memoryDir, 'quota-ledger.json'), '{{{ not json');
    writeFileSync(join(memoryDir, 'quota-events.jsonl'), 'not-json\n{also bad}\n');
    const manager = new CLIManager(defaultConfig);
    const status = await manager.getQuotaStatus();
    expect(status.enabled).toBe(false);
    expect(status.entries).toEqual([]);
  });

  it('parses ledger entries and buckets free vs paid tokens', async () => {
    const now = Date.now();
    const windowLengthMs = 24 * 60 * 60 * 1000;
    const ledger = {
      entries: {
        'local:qwen2.5-coder:7b': {
          provider: 'local',
          model: 'qwen2.5-coder:7b',
          tokensConsumed: 120_000,
          requests: 24,
          windowStart: now - 6 * 60 * 60 * 1000,
          windowLengthMs,
          cooldownUntil: 0,
        },
        'gemini:gemini-2.0-flash': {
          provider: 'gemini',
          model: 'gemini-2.0-flash',
          tokensConsumed: 250_000,
          requests: 40,
          windowStart: now - 2 * 60 * 60 * 1000,
          windowLengthMs,
          cooldownUntil: 0,
        },
        'groq:llama-3.3-70b-versatile': {
          provider: 'groq',
          model: 'llama-3.3-70b-versatile',
          tokensConsumed: 80_000,
          requests: 12,
          windowStart: now - 3 * 60 * 60 * 1000,
          windowLengthMs,
          cooldownUntil: now + 45 * 60 * 1000, // parked for 45 more minutes
        },
      },
    };
    writeFileSync(join(memoryDir, 'quota-ledger.json'), JSON.stringify(ledger));

    const manager = new CLIManager(defaultConfig);
    const status = await manager.getQuotaStatus();

    expect(status.enabled).toBe(true);
    expect(status.entries).toHaveLength(3);
    expect(status.freeTokens).toBe(370_000); // local + gemini
    expect(status.freeRequests).toBe(64);
    expect(status.paidTokens).toBe(80_000); // groq
    expect(status.paidRequests).toBe(12);
    expect(status.estimatedSavedUsd).toBeGreaterThan(0);

    // Parked detection from cooldownUntil
    const parked = status.entries.filter((e) => e.parked);
    expect(parked).toHaveLength(1);
    expect(parked[0].provider).toBe('groq');
    expect(parked[0].cooldownRemaining).toBeGreaterThan(0);

    // resetsInMs computed from windowStart + windowLengthMs
    const reset = status.entries.find((e) => e.provider === 'local');
    expect(reset!.resetsInMs).toBeGreaterThan(0);
    expect(reset!.resetsInMs).toBeLessThanOrEqual(windowLengthMs);
  });

  it('parses the failover timeline (newest first, corrupt lines skipped)', async () => {
    const now = Date.now();
    const lines = [
      { type: 'parked', provider: 'gemini', reason: 'daily free quota exhausted', timestamp: now - 10 * 60 * 1000 },
      { type: 'failover', provider: 'gemini', reason: 'switched to groq', timestamp: now - 9 * 60 * 1000 },
      { type: 're-enabled', provider: 'gemini', reason: 'window reset', timestamp: now - 5 * 60 * 1000 },
      'corrupt-line',
    ];
    writeFileSync(join(memoryDir, 'quota-events.jsonl'), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');

    const manager = new CLIManager(defaultConfig);
    const status = await manager.getQuotaStatus();

    expect(status.enabled).toBe(true);
    expect(status.events).toHaveLength(3);
    // Newest first
    expect(status.events[0].type).toBe('re-enabled');
    expect(status.events[1].type).toBe('failover');
    expect(status.events[2].type).toBe('parked');
  });

  it('caps the timeline at the most recent 50 events', async () => {
    const now = Date.now();
    const lines: string[] = [];
    for (let i = 0; i < 70; i++) {
      lines.push(JSON.stringify({ type: 'failover', provider: 'groq', timestamp: now + i }));
    }
    writeFileSync(join(memoryDir, 'quota-events.jsonl'), lines.join('\n') + '\n');

    const manager = new CLIManager(defaultConfig);
    const status = await manager.getQuotaStatus();
    expect(status.events.length).toBeLessThanOrEqual(50);
    // Newest 50, so the oldest (now+0) is dropped
    expect(status.events.some((e) => e.timestamp === now)).toBe(false);
  });
});
