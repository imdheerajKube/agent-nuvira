/**
 * FailureBookkeeping — unit tests for the shared failure composition
 * (Nuvira-Router M0.2 Stage A).
 *
 * Covers the full composition of recordActionFailure:
 *   1. session exclusion (auth / rate-limit / transient)
 *   2. quota-ledger parking on rate-limit
 *   3. registry write-through (incl. model-not-found → unavailable, action tag)
 *   4. quota-timeline failover event
 *   5. circuit-breaker feed
 *   6. best-effort contract (never throws)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  recordActionFailure,
  RATE_LIMIT_EXCLUSION_MS,
  TRANSIENT_FAILURE_EXCLUSION_MS,
  type FailureSessionState,
} from '../../src/learning/failure-bookkeeping.js';
import {
  resetModelRegistry,
  getModelRegistry,
  readActionTelemetryFile,
  ACTION_LOG_FILENAME,
} from '../../src/learning/model-registry.js';
import type { ConfigManager } from '../../src/config/manager.js';

/** Read the per-action telemetry log the registry wrote into the temp dir. */
function actionLogEntries() {
  return readActionTelemetryFile(join(tempDir, ACTION_LOG_FILENAME));
}

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockLedger = vi.hoisted(() => ({ parkProvider: vi.fn(), recordEvent: vi.fn() }));
const mockRecordFailure = vi.hoisted(() => vi.fn());

vi.mock('../../src/learning/quota-ledger.js', () => ({
  getQuotaLedger: () => mockLedger,
}));

// Keep the REAL classifyFallbackError + recordRegistryFailure (registry
// write-through must be exercised end-to-end); only the circuit-breaker
// singleton is stubbed.
vi.mock('../../src/learning/provider-fallback.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/learning/provider-fallback.js')>();
  return { ...actual, getProviderFallback: vi.fn(() => ({ recordFailure: mockRecordFailure })) };
});

// ─── Hermetic storage isolation (registry write-through) ────────────────────

let tempDir: string;
let originalMemoryDir: string | undefined;
let originalTelemetryAction: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-failure-bookkeeping-'));
  originalMemoryDir = process.env.BUFF_MEMORY_DIR;
  process.env.BUFF_MEMORY_DIR = tempDir;
  originalTelemetryAction = process.env.BUFF_TELEMETRY_ACTION;
  delete process.env.BUFF_TELEMETRY_ACTION;
  resetModelRegistry();
  vi.clearAllMocks();
});

afterEach(() => {
  resetModelRegistry();
  if (originalMemoryDir === undefined) delete process.env.BUFF_MEMORY_DIR;
  else process.env.BUFF_MEMORY_DIR = originalMemoryDir;
  if (originalTelemetryAction === undefined) delete process.env.BUFF_TELEMETRY_ACTION;
  else process.env.BUFF_TELEMETRY_ACTION = originalTelemetryAction;
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(quota?: Record<string, { windowMs?: number }>): ConfigManager {
  return {
    getAll: () => ({ routing: { quota: quota ?? {} } }),
  } as unknown as ConfigManager;
}

function makeSession(): FailureSessionState {
  return {
    sessionFailedProviders: new Map<string, number>(),
    sessionTransientFailedProviders: new Set<string>(),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('FailureBookkeeping — recordActionFailure', () => {
  it('auth failure: excludes for the WHOLE session, no transient marker, feeds registry + timeline + breaker', () => {
    const session = makeSession();
    const err = new Error('401 Unauthorized — invalid API key');

    recordActionFailure(session, 'gemini', err, makeConfig(), { model: 'gemini-2.5-flash', action: 'chat' });

    expect(session.sessionFailedProviders.get('gemini')).toBe(Number.MAX_SAFE_INTEGER);
    expect(session.sessionTransientFailedProviders.has('gemini')).toBe(false);
    // Registry learned the combo is dead (auth flips to unavailable).
    expect(getModelRegistry().getEntry('gemini', 'gemini-2.5-flash')?.status).toBe('unavailable');
    // Timeline + breaker fed, in the documented order (registry → timeline →
    // breaker) so Stage B callers can rely on the composition contract.
    expect(mockLedger.recordEvent).toHaveBeenCalledWith('failover', 'gemini', 'auth');
    expect(mockRecordFailure).toHaveBeenCalledWith('gemini');
    expect(mockLedger.recordEvent.mock.invocationCallOrder[0]).toBeLessThan(mockRecordFailure.mock.invocationCallOrder[0]);
    // No parking for auth.
    expect(mockLedger.parkProvider).not.toHaveBeenCalled();
  });

  it('rate-limit failure: short cooldown + quota-ledger park (configured window) + no transient marker', () => {
    const session = makeSession();
    const err = new Error('429 Too Many Requests');
    const config = makeConfig({ groq: { windowMs: 5000 } });
    const before = Date.now();

    recordActionFailure(session, 'groq', err, config, { model: 'llama-3.3-70b-versatile', action: 'chat' });

    const expiry = session.sessionFailedProviders.get('groq')!;
    expect(expiry).toBeGreaterThanOrEqual(before + RATE_LIMIT_EXCLUSION_MS);
    expect(expiry).toBeLessThan(before + RATE_LIMIT_EXCLUSION_MS + 100);
    expect(session.sessionTransientFailedProviders.has('groq')).toBe(false);
    // Parked until the CONFIGURED window (5000ms), not the 24h default.
    expect(mockLedger.parkProvider).toHaveBeenCalledWith('groq', expect.any(Number), 'rate-limit');
    const parkExpiry = mockLedger.parkProvider.mock.calls[0][1] as number;
    expect(parkExpiry).toBeGreaterThanOrEqual(before + 5000);
    expect(parkExpiry).toBeLessThan(before + 5000 + 100);
    expect(getModelRegistry().getEntry('groq', 'llama-3.3-70b-versatile')?.status).toBe('unavailable');
  });

  it('rate-limit without quota config: parks for the 24h default window', () => {
    const session = makeSession();
    const before = Date.now();

    recordActionFailure(session, 'groq', new Error('quota exceeded'), makeConfig(), { action: 'chat' });

    const parkExpiry = mockLedger.parkProvider.mock.calls[0][1] as number;
    expect(parkExpiry).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
    expect(parkExpiry).toBeLessThan(before + 24 * 60 * 60 * 1000 + 100);
  });

  it('transient failure (server): short cooldown + re-verify marker, registry decays (not unavailable)', () => {
    const session = makeSession();
    const before = Date.now();

    recordActionFailure(session, 'nim', new Error('503 Service Unavailable'), makeConfig(), {
      model: 'meta/llama-3.3-70b-instruct',
      action: 'chat',
    });

    const expiry = session.sessionFailedProviders.get('nim')!;
    expect(expiry).toBeGreaterThanOrEqual(before + TRANSIENT_FAILURE_EXCLUSION_MS);
    expect(expiry).toBeLessThan(before + TRANSIENT_FAILURE_EXCLUSION_MS + 100);
    expect(session.sessionTransientFailedProviders.has('nim')).toBe(true);
    // Transient — recorded as a failed call but NOT a definitive unavailable.
    expect(getModelRegistry().getEntry('nim', 'meta/llama-3.3-70b-instruct')?.status).not.toBe('unavailable');
    expect(mockLedger.parkProvider).not.toHaveBeenCalled();
  });

  it('model-not-found: registry entry becomes a definitive unavailable block', () => {
    const session = makeSession();

    recordActionFailure(session, 'gemini', new Error('404 model not found: gemini-2.0-flash-exp'), makeConfig(), {
      model: 'gemini-2.0-flash-exp',
      action: 'chat',
    });

    const entry = getModelRegistry().getEntry('gemini', 'gemini-2.0-flash-exp');
    expect(entry?.status).toBe('unavailable');
    expect(entry?.lastError).toContain('model not found');
  });

  it('writes the action tag into the registry per-action log', () => {
    const session = makeSession();

    recordActionFailure(session, 'groq', new Error('500 server error'), makeConfig(), {
      model: 'llama-3.3-70b-versatile',
      action: 'execute',
    });

    const entries = actionLogEntries();
    expect(entries.some((e) => e.provider === 'groq' && e.model === 'llama-3.3-70b-versatile' && e.action === 'execute')).toBe(true);
  });

  it('BUFF_TELEMETRY_ACTION env override re-tags the registry write (VS Code spawns)', () => {
    const session = makeSession();
    process.env.BUFF_TELEMETRY_ACTION = 'ide-chat';

    recordActionFailure(session, 'groq', new Error('401 Unauthorized'), makeConfig(), {
      model: 'llama-3.3-70b-versatile',
      action: 'chat',
    });

    const entries = actionLogEntries();
    expect(entries.some((e) => e.provider === 'groq' && e.action === 'ide-chat')).toBe(true);
  });

  it('best-effort contract: a throwing ledger never propagates, bookkeeping still completes', () => {
    const session = makeSession();
    mockLedger.recordEvent.mockImplementationOnce(() => {
      throw new Error('ledger exploded');
    });
    mockLedger.parkProvider.mockImplementationOnce(() => {
      throw new Error('park exploded');
    });

    expect(() =>
      recordActionFailure(session, 'openrouter', new Error('401 Unauthorized'), makeConfig(), { action: 'chat' }),
    ).not.toThrow();

    // Session exclusion still applied, registry still updated, breaker fed.
    expect(session.sessionFailedProviders.get('openrouter')).toBe(Number.MAX_SAFE_INTEGER);
    expect(getModelRegistry().getEntry('openrouter', 'default')?.status).toBe('unavailable');
    expect(mockRecordFailure).toHaveBeenCalledWith('openrouter');
  });
});
