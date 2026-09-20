/**
 * Harness-fault attribution (R5) — a deterministic REQUEST-SHAPE rejection must
 * never be booked as a provider or model failure.
 *
 * Why this file exists: a real run died on step 2 with
 *
 *   Gemini tool-calling API error (400): "Function call is missing a
 *   thought_signature in functionCall parts."
 *
 * That is our adapter's bug — it fails identically for EVERY model on that
 * transport. The generic failure path booked it as a Gemini failure anyway, so
 * the router parked a healthy provider, decayed a healthy model's health score,
 * tripped the circuit breaker, and taught the bandit "this model is weak" from a
 * bug that would have broken any model. The router then AVOIDS the model that was
 * actually fine.
 *
 * The closing contrast test is the important one: the guard must be NARROW. If it
 * swallowed real failures, a genuinely broken provider could never be
 * deprioritized — a worse bug than the one being fixed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordActionFailure, type FailureSessionState } from '../../src/learning/failure-bookkeeping.js';
import { isHarnessFault } from '../../src/learning/provider-fallback.js';
import {
  resetModelRegistry,
  getModelRegistry,
  readActionTelemetryFile,
  ACTION_LOG_FILENAME,
} from '../../src/learning/model-registry.js';
import type { ConfigManager } from '../../src/config/manager.js';

// ─── Mocks (only the two side-effect singletons; the classifier is REAL) ────

const mockLedger = vi.hoisted(() => ({
  parkProvider: vi.fn(),
  parkModel: vi.fn(),
  getParkedModelCount: vi.fn(() => 1),
  recordEvent: vi.fn(),
}));
const mockRecordFailure = vi.hoisted(() => vi.fn());

vi.mock('../../src/learning/quota-ledger.js', () => ({
  getQuotaLedger: () => mockLedger,
}));

vi.mock('../../src/learning/provider-fallback.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/learning/provider-fallback.js')>();
  return { ...actual, getProviderFallback: vi.fn(() => ({ recordFailure: mockRecordFailure })) };
});

// ─── Hermetic storage isolation ─────────────────────────────────────────────

let tempDir: string;
let originalMemoryDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-harness-fault-'));
  originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = tempDir;
  resetModelRegistry();
  vi.clearAllMocks();
});

afterEach(() => {
  resetModelRegistry();
  if (originalMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(): ConfigManager {
  return { getAll: () => ({ routing: { quota: {} } }) } as unknown as ConfigManager;
}

function makeSession(): FailureSessionState {
  return {
    sessionFailedProviders: new Map<string, number>(),
    sessionTransientFailedProviders: new Set<string>(),
    sessionFailedModels: new Map<string, number>(),
  };
}

function actionLogEntries() {
  return readActionTelemetryFile(join(tempDir, ACTION_LOG_FILENAME));
}

/** The exact message a real Gemini multi-turn tool call produced. */
const LIVE_GEMINI_ERROR =
  'Gemini tool-calling API error (400): {"error":{"code":400,"message":"Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly... Additional data, function call `default_api:plan_todo` , position 3.","status":"INVALID_ARGUMENT"}}';

// ─── Classification ─────────────────────────────────────────────────────────

describe('isHarnessFault', () => {
  it('classifies the live Gemini thought_signature rejection as a harness fault', () => {
    expect(isHarnessFault(new Error(LIVE_GEMINI_ERROR))).toBe(true);
  });

  it('classifies other request-shape defects as harness faults', () => {
    expect(isHarnessFault(new Error('400 invalid_request_error: unknown parameter "tools"'))).toBe(true);
    expect(isHarnessFault(new Error('INVALID_ARGUMENT: unsupported content part type'))).toBe(true);
    expect(isHarnessFault(new Error('failed to parse the tool arguments as JSON'))).toBe(true);
  });

  it('does NOT classify genuine provider or model failures as harness faults', () => {
    // An auth failure, an exhausted quota, a provider outage and a retired model
    // are all about the PROVIDER/MODEL, and must keep their normal bookkeeping.
    expect(isHarnessFault(new Error('401 Unauthorized — invalid API key'))).toBe(false);
    expect(isHarnessFault(new Error('429 Too Many Requests'))).toBe(false);
    expect(isHarnessFault(new Error('503 This model is currently experiencing high demand'))).toBe(false);
    expect(isHarnessFault(new Error('404 model `gpt-oss:120b` not found for provider groq'))).toBe(false);
    expect(isHarnessFault(new Error('fetch failed: ECONNREFUSED 127.0.0.1:11434'))).toBe(false);
  });

  it('never throws on a non-Error thrower', () => {
    expect(isHarnessFault(undefined)).toBe(false);
    expect(isHarnessFault(null)).toBe(false);
    expect(() => isHarnessFault({ weird: true })).not.toThrow();
  });
});

// ─── Attribution ────────────────────────────────────────────────────────────

describe('recordActionFailure — harness faults book nothing', () => {
  it('a harness fault leaves every routing surface untouched', () => {
    const session = makeSession();

    recordActionFailure(session, 'gemini', new Error(LIVE_GEMINI_ERROR), makeConfig(), {
      model: 'gemini-2.5-flash',
      action: 'chat',
    });

    // No session exclusion of any scope.
    expect(session.sessionFailedProviders.size).toBe(0);
    expect(session.sessionTransientFailedProviders.size).toBe(0);
    expect(session.sessionFailedModels?.size).toBe(0);
    // No quota parking (provider or model).
    expect(mockLedger.parkProvider).not.toHaveBeenCalled();
    expect(mockLedger.parkModel).not.toHaveBeenCalled();
    // No circuit-breaker trip.
    expect(mockRecordFailure).not.toHaveBeenCalled();
    // No registry write-through: the model is NOT marked unavailable.
    expect(getModelRegistry().getEntry('gemini', 'gemini-2.5-flash')).toBeUndefined();
    expect(actionLogEntries()).toHaveLength(0);
  });

  it('the fault is still visible on the quota timeline (observable, just unattributed)', () => {
    recordActionFailure(makeSession(), 'gemini', new Error(LIVE_GEMINI_ERROR), makeConfig(), {
      model: 'gemini-2.5-flash',
      action: 'chat',
    });

    // Silence would be its own bug — the dash must be able to show WHY a run
    // failed, without that reason ever reaching a routing score.
    expect(mockLedger.recordEvent).toHaveBeenCalledTimes(1);
    const [, provider, detail] = mockLedger.recordEvent.mock.calls[0];
    expect(provider).toBe('gemini');
    expect(String(detail)).toContain('harness-fault');
  });

  it('CONTRAST: a real 503 IS still booked against the provider', () => {
    const session = makeSession();

    recordActionFailure(
      session,
      'gemini',
      new Error('503 This model is currently experiencing high demand.'),
      makeConfig(),
      { model: 'gemini-2.5-flash', action: 'chat' },
    );

    // The guard is narrow: a genuine outage keeps its full bookkeeping, so a
    // broken provider can still be deprioritized.
    expect(session.sessionFailedProviders.get('gemini')).toBeGreaterThan(Date.now());
    expect(session.sessionTransientFailedProviders.has('gemini')).toBe(true);
    expect(mockRecordFailure).toHaveBeenCalledWith('gemini');
    expect(actionLogEntries().length).toBeGreaterThan(0);
  });
});
