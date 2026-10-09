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
  RAPID_FAILURE_COOLDOWN_MS,
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

const mockLedger = vi.hoisted(() => ({
  parkProvider: vi.fn(),
  // PER-MODEL parking: a 429 on one model parks that model (parkModel) and
  // leaves its siblings routable. getParkedModelCount defaults to 1 — a single
  // model · 429 must NOT escalate to a provider-wide park.
  parkModel: vi.fn(),
  getParkedModelCount: vi.fn(() => 1),
  recordEvent: vi.fn(),
}));
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
  originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = tempDir;
  originalTelemetryAction = process.env.NUVIRA_TELEMETRY_ACTION;
  delete process.env.NUVIRA_TELEMETRY_ACTION;
  resetModelRegistry();
  vi.clearAllMocks();
});

afterEach(() => {
  resetModelRegistry();
  if (originalMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
  if (originalTelemetryAction === undefined) delete process.env.NUVIRA_TELEMETRY_ACTION;
  else process.env.NUVIRA_TELEMETRY_ACTION = originalTelemetryAction;
  rmSync(tempDir, { recursive: true, force: true });
});

/** A park below this is the short base (10s); above it, the T4 escalation. */
const RAPID_FLOOR_PROBE_MS = 30_000;

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
    // Model tracking ON — the production shape (chat passes this map), so
    // rate-limit failures land model-scoped and a provider's siblings survive.
    sessionFailedModels: new Map<string, number>(),
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

    // MODEL-scoped session exclusion: the failing model is excluded, the
    // provider is NOT (its siblings keep serving) — the per-model quota key.
    const expiry = session.sessionFailedModels!.get('groq|llama-3.3-70b-versatile')!;
    expect(expiry).toBeGreaterThanOrEqual(before + RATE_LIMIT_EXCLUSION_MS);
    expect(expiry).toBeLessThan(before + RATE_LIMIT_EXCLUSION_MS + 100);
    expect(session.sessionFailedProviders.has('groq')).toBe(false);
    expect(session.sessionTransientFailedProviders.has('groq')).toBe(false);
    // The LEDGER park is per-model too, until the CONFIGURED window (5000ms),
    // not the 24h default — and the provider is not parked as a whole.
    expect(mockLedger.parkModel).toHaveBeenCalledWith('groq', 'llama-3.3-70b-versatile', expect.any(Number), 'rate-limit');
    const parkExpiry = mockLedger.parkModel.mock.calls[0][2] as number;
    expect(parkExpiry).toBeGreaterThanOrEqual(before + 5000);
    expect(parkExpiry).toBeLessThan(before + 5000 + 100);
    expect(mockLedger.parkProvider).not.toHaveBeenCalled();
    // Rate-limit parks but does NOT demote the entry (transient — the model
    // must auto-recover when the window lapses).
    expect(getModelRegistry().getEntry('groq', 'llama-3.3-70b-versatile')?.status).not.toBe('unavailable');
  });

  it('rate-limit without hint or config: parks for MIN_RATE_LIMIT_PARK_MS (10s, not 24h)', () => {
    const session = makeSession();
    const before = Date.now();

    recordActionFailure(session, 'groq', new Error('quota exceeded'), makeConfig(), { action: 'chat' });

    // FIX: No Retry-After hint AND no configured windowMs → use
    // MIN_RATE_LIMIT_PARK_MS (10s) instead of the bare 24h window. The
    // provider will tell us when the limit resets via Retry-After if it
    // has a longer window.
    const parkExpiry = mockLedger.parkProvider.mock.calls[0][1] as number;
    expect(parkExpiry).toBeGreaterThanOrEqual(before + 10_000);
    expect(parkExpiry).toBeLessThan(before + 10_000 + 100);
  });

  it('rate-limit WITH a provider reset hint parks for the HINT, not the 24h default', () => {
    const session = makeSession();
    const before = Date.now();
    // Groq-style 429 that names its own reset time — the user's exact
    // scenario: "available again in ~16 minutes" must not become a day-long
    // exclusion.
    recordActionFailure(
      session,
      'groq',
      new Error(
        '429 Rate limit reached for model `llama-3.3-70b-versatile` on tokens per minute (TPM). Please try again in 16.5s.',
      ),
      makeConfig(),
      { model: 'llama-3.3-70b-versatile', action: 'chat' },
    );

    // Per-model park (the failure was attributed to a concrete model).
    expect(mockLedger.parkModel).toHaveBeenCalledWith('groq', 'llama-3.3-70b-versatile', expect.any(Number), 'rate-limit');
    const parkExpiry = mockLedger.parkModel.mock.calls[0][2] as number;
    // ~16.5s (floored at 10s) — NOT the 24h default.
    expect(parkExpiry).toBeGreaterThanOrEqual(before + 10_000);
    expect(parkExpiry).toBeLessThan(before + 20_000);
  });

  it('rate-limit on several models of one provider escalates to a PROVIDER park (shared quota)', () => {
    const session = makeSession();
    // Groq's free-tier TPM is shared across ALL its models — round-robining
    // siblings can never escape it. Once a 2nd distinct model of the same
    // provider is parked, the limit is provider-wide.
    mockLedger.getParkedModelCount.mockReturnValueOnce(2);

    recordActionFailure(session, 'groq', new Error('429 rate limit reached'), makeConfig(), {
      model: 'openai/gpt-oss-120b',
      action: 'execute',
    });

    // Both the model AND the provider end up parked.
    expect(mockLedger.parkModel).toHaveBeenCalledWith('groq', 'openai/gpt-oss-120b', expect.any(Number), 'rate-limit');
    expect(mockLedger.parkProvider).toHaveBeenCalledWith(
      'groq',
      expect.any(Number),
      'rate-limit (shared across models)',
    );
    // The escalation also excludes the provider at the session level.
    expect(session.sessionFailedProviders.get('groq')).toBeGreaterThan(0);
  });

  it('rate-limit with NO attributable model parks the PROVIDER (honest scope)', () => {
    const session = makeSession();

    recordActionFailure(session, 'groq', new Error('429 Too Many Requests'), makeConfig(), { action: 'chat' });

    // No model was passed → we cannot claim a per-model limit, so the park is
    // provider-wide and the model-scoped APIs are not used.
    expect(mockLedger.parkProvider).toHaveBeenCalledWith('groq', expect.any(Number), 'rate-limit');
    expect(mockLedger.parkModel).not.toHaveBeenCalled();
    expect(session.sessionFailedProviders.get('groq')).toBeGreaterThan(0);
  });

  it('rate-limit hint wins over configured window (provider knows its limits)', () => {
    const session = makeSession();
    const before = Date.now();
    // Provider says reset in 5 min — the provider knows its own rate-limit
    // window, so we honor the hint. The configured windowMs is only used when
    // NO hint is present.
    recordActionFailure(session, 'groq', new Error('429 try again in 300s'), makeConfig({ groq: { windowMs: 60_000 } }), {
      action: 'chat',
    });
    const parkExpiry = mockLedger.parkProvider.mock.calls[0][1] as number;
    expect(parkExpiry).toBeGreaterThanOrEqual(before + 300_000);
    expect(parkExpiry).toBeLessThan(before + 300_000 + 100);
  });

  /**
   * The failing run's own error text (trace-1791547245754-dmqwmu, 2026-10-09),
   * verbatim. It names a 429, so without the exhaustion patterns in
   * `classifyFallbackError` it classified as `rate-limit` — and this branch was
   * never reached.
   */
  const LIVE_OLLAMA_USAGE_LIMIT =
    'Ollama API error (429): {"error":"you (imdheeraj) have reached your monthly usage limit, ' +
    'upgrade for higher limits: https://ollama.com/upgrade or add usage credits: ' +
    'https://ollama.com/settings (ref: 4e7dec63-24fd-4805-9a84-57900faeb895)"}';

  it('an exhausted account excludes the PAIR for the WHOLE session — there is no window to wait out', () => {
    const session = makeSession();

    recordActionFailure(session, 'local', new Error(LIVE_OLLAMA_USAGE_LIMIT), makeConfig(), {
      model: 'gpt-oss:120b-cloud',
      action: 'execute',
    });

    // DEFINITIVE, like auth: `Number.MAX_SAFE_INTEGER` and not a 60s "transient"
    // re-admit, which is exactly what let the next step re-pick the exhausted
    // pair ten seconds later while working pairs sat unused.
    expect(session.sessionFailedModels!.get('local|gpt-oss:120b-cloud')).toBe(Number.MAX_SAFE_INTEGER);
    expect(session.sessionFailedProviders.has('local')).toBe(false);
    expect(session.sessionTransientFailedProviders.has('local')).toBe(false);
    // NO ledger park: a park expires, and this must not (the registry demotes
    // the pair to `unavailable`, which the router skips predictively).
    expect(mockLedger.parkModel).not.toHaveBeenCalled();
    expect(mockLedger.parkProvider).not.toHaveBeenCalled();
    expect(getModelRegistry().getEntry('local', 'gpt-oss:120b-cloud')?.status).toBe('unavailable');
  });

  it('an exhausted account with NO attributable model excludes the PROVIDER for the session', () => {
    const session = makeSession();

    recordActionFailure(session, 'local', new Error(LIVE_OLLAMA_USAGE_LIMIT), makeConfig(), { action: 'chat' });

    expect(session.sessionFailedProviders.get('local')).toBe(Number.MAX_SAFE_INTEGER);
    expect(session.sessionTransientFailedProviders.has('local')).toBe(false);
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

  it('NUVIRA_TELEMETRY_ACTION env override re-tags the registry write (VS Code spawns)', () => {
    const session = makeSession();
    process.env.NUVIRA_TELEMETRY_ACTION = 'ide-chat';

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

    // Session exclusion still applied and the breaker is fed.
    expect(session.sessionFailedProviders.get('openrouter')).toBe(Number.MAX_SAFE_INTEGER);
    expect(mockRecordFailure).toHaveBeenCalledWith('openrouter');
    // No model was attributed (options.model is undefined → the config
    // sentinel 'default'), and the registry's write guard refuses to track the
    // sentinel as a real model — so nothing bogus is persisted.
    expect(getModelRegistry().getEntry('openrouter', 'default')).toBeUndefined();
  });
});

// T4 — RPM/TPM rapid-failure breaker: a burst of free-tier 429s must raise the
// park floor to a full minute (the RPM window) instead of the blind 10s base.
describe('FailureBookkeeping — T4 rapid-failure (RPM/TPM) breaker', () => {
  it('the FIRST blind 429 keeps the short base park (no regression)', () => {
    const session = makeSession();
    const before = Date.now();

    recordActionFailure(session, 'gemini', new Error('quota exceeded'), makeConfig(), { action: 'chat' });

    const parkExpiry = mockLedger.parkProvider.mock.calls[0][1] as number;
    expect(parkExpiry).toBeLessThan(before + RAPID_FLOOR_PROBE_MS);
  });

  it('a THIRD failure inside the window escalates the park to a full minute', () => {
    const session = makeSession();
    // Two prior blind 429s in the same turn (the tool-loop burst).
    recordActionFailure(session, 'gemini', new Error('quota exceeded'), makeConfig(), { action: 'execute' });
    recordActionFailure(session, 'gemini', new Error('quota exceeded'), makeConfig(), { action: 'execute' });
    const before = Date.now();

    recordActionFailure(session, 'gemini', new Error('quota exceeded'), makeConfig(), { action: 'execute' });

    const parkExpiry = mockLedger.parkProvider.mock.calls[2][1] as number;
    expect(parkExpiry).toBeGreaterThanOrEqual(before + RAPID_FAILURE_COOLDOWN_MS);
  });

  it('the breaker is SESSION-scoped: a fresh session starts over', () => {
    const first = makeSession();
    recordActionFailure(first, 'gemini', new Error('quota exceeded'), makeConfig(), { action: 'execute' });
    recordActionFailure(first, 'gemini', new Error('quota exceeded'), makeConfig(), { action: 'execute' });

    const fresh = makeSession();
    const before = Date.now();
    recordActionFailure(fresh, 'gemini', new Error('quota exceeded'), makeConfig(), { action: 'execute' });

    expect(mockLedger.parkProvider.mock.calls.at(-1)![1] as number).toBeLessThan(before + RAPID_FLOOR_PROBE_MS);
  });
});
