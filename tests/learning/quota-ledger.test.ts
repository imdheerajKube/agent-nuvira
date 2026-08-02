/**
 * QuotaLedger — central quota tracking tests.
 *
 * Covers:
 * 1. recordUsage write-through (tokens/requests per provider × model)
 * 2. Window rotation — counters reset when the window rolls (calendar-aware
 *    auto re-enable)
 * 3. Configured-limit exhaustion parks a provider until the window resets
 * 4. Explicit parkProvider cooldown + releaseProvider
 * 5. getRouterQuotaStatus feed shape consumed by the AutoModelRouter
 * 6. getBestAvailable filters parked providers, never returns empty
 * 7. Persistence honors BUFF_MEMORY_DIR + reset()
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QuotaLedger, resetQuotaLedger, getQuotaLedger } from '../../src/learning/quota-ledger.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tempDir: string;
let originalMemoryDir: string | undefined;

function makeConfigManager(quota?: Record<string, unknown>) {
  return {
    getAll: () => ({ routing: { quota } }),
  } as any;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('QuotaLedger — usage recording', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-quota-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
    resetQuotaLedger();
  });

  afterEach(() => {
    resetQuotaLedger();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('records tokens and requests per provider × model', () => {
    const ledger = new QuotaLedger();
    ledger.recordUsage('gemini', 'gemini-2.5-flash', 1000, 500);
    ledger.recordUsage('gemini', 'gemini-2.5-flash', 200, 300);
    ledger.recordUsage('groq', 'llama-3.3-70b-versatile', 50, 10);

    const status = ledger.getStatus();
    const gemini = status.find((s) => s.provider === 'gemini' && s.model === 'gemini-2.5-flash');
    const groq = status.find((s) => s.provider === 'groq');

    expect(gemini).toBeDefined();
    expect(gemini!.tokensConsumed).toBe(2000); // 1000+500 + 200+300
    expect(gemini!.requests).toBe(2);
    expect(groq).toBeDefined();
    expect(groq!.tokensConsumed).toBe(60);
    expect(groq!.requests).toBe(1);
  });

  it('persists to BUFF_MEMORY_DIR', () => {
    const ledger = new QuotaLedger();
    ledger.recordUsage('groq', 'llama-3.3-70b-versatile', 100, 50);

    const path = join(tempDir, 'quota-ledger.json');
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    expect(raw.entries['groq|llama-3.3-70b-versatile']).toBeDefined();
  });

  it('auto-re-enables when the reset window rolls (calendar-aware, not a timer)', () => {
    const ledger = new QuotaLedger();
    // Small window so tests don't wait: 50ms
    ledger.recordUsage('gemini', 'default', 100, 0, 50);

    const statusBefore = ledger.getStatus().find((s) => s.provider === 'gemini')!;
    expect(statusBefore.tokensConsumed).toBe(100);
    expect(statusBefore.requests).toBe(1);

    // Wait for the window to roll, then record again — counters reset first.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        ledger.recordUsage('gemini', 'default', 10, 5, 50);
        const statusAfter = ledger.getStatus().find((s) => s.provider === 'gemini')!;
        expect(statusAfter.tokensConsumed).toBe(15); // fresh window, not 115
        expect(statusAfter.requests).toBe(1);
        resolve();
      }, 70);
    });
  });
});

describe('QuotaLedger — exhaustion & parking', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-quota-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
    resetQuotaLedger();
  });

  afterEach(() => {
    resetQuotaLedger();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('isExhausted flips true when a configured limit is hit in the current window', () => {
    const ledger = new QuotaLedger();
    const limit = { requestsPerWindow: 2, windowMs: 86_400_000 };

    expect(ledger.isExhausted('gemini', 'default', limit)).toBe(false);
    ledger.recordUsage('gemini', 'default', 100, 50);
    expect(ledger.isExhausted('gemini', 'default', limit)).toBe(false);
    ledger.recordUsage('gemini', 'default', 100, 50);
    expect(ledger.isExhausted('gemini', 'default', limit)).toBe(true);
  });

  it('getRouterQuotaStatus reports an exhausted provider with ms remaining until reset', () => {
    const ledger = new QuotaLedger();
    const config = makeConfigManager({
      gemini: { requestsPerWindow: 1, windowMs: 3_600_000 },
    });

    ledger.recordUsage('gemini', 'default', 100, 50);
    const parked = ledger.getRouterQuotaStatus(config);
    expect(parked.some((p) => p.provider === 'gemini' && p.cooldownRemaining > 0)).toBe(true);

    // Not exhausted → not reported
    const configGroq = makeConfigManager({ groq: { requestsPerWindow: 10 } });
    expect(ledger.getRouterQuotaStatus(configGroq).some((p) => p.provider === 'groq')).toBe(false);
  });

  it('parkProvider excludes a provider until the given time; releaseProvider un-parks', () => {
    const ledger = new QuotaLedger();
    const config = makeConfigManager({});

    expect(ledger.getRouterQuotaStatus(config)).toHaveLength(0);

    ledger.parkProvider('gemini', Date.now() + 60_000);
    const parked = ledger.getRouterQuotaStatus(config);
    expect(parked.some((p) => p.provider === 'gemini')).toBe(true);

    ledger.releaseProvider('gemini');
    expect(ledger.getRouterQuotaStatus(config)).toHaveLength(0);
  });

  it('getBestAvailable filters parked providers but never returns an empty list', () => {
    const ledger = new QuotaLedger();
    const config = makeConfigManager({ gemini: { requestsPerWindow: 1 } });

    ledger.recordUsage('gemini', 'default', 100, 50);

    // gemini exhausted → only groq/local survive
    const usable = ledger.getBestAvailable(['gemini', 'groq', 'local'], config);
    expect(usable).not.toContain('gemini');
    expect(usable).toContain('groq');

    // Everything parked → returns the input unchanged (caller surfaces availability)
    const allParked = ledger.getBestAvailable(['gemini'], config);
    expect(allParked).toEqual(['gemini']);
  });

  it('reset clears all entries', () => {
    const ledger = new QuotaLedger();
    ledger.recordUsage('gemini', 'default', 100, 50);
    ledger.recordUsage('groq', 'llama-3.3-70b-versatile', 10, 5);

    expect(ledger.getStatus()).toHaveLength(2);
    ledger.reset();
    expect(ledger.getStatus()).toHaveLength(0);
  });

  it('singleton honors BUFF_MEMORY_DIR like the bandit', () => {
    const ledger = getQuotaLedger();
    ledger.recordUsage('nim', 'default', 10, 5);
    const path = join(tempDir, 'quota-ledger.json');
    expect(existsSync(path)).toBe(true);
  });

  it('formatStatus renders a human-readable summary (CLI)', () => {
    const ledger = new QuotaLedger();
    ledger.recordUsage('gemini', 'default', 1000, 500);

    const text = ledger.formatStatus(makeConfigManager({}));
    expect(text).toContain('gemini');
    expect(text).toContain('tokens');
    expect(text).toContain('resets in');
  });
});
