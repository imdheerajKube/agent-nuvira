/**
 * "Verify next N" — the run behind the Timeline's one action.
 *
 * What this file pins is not that probing works (that is `model-probe`'s job) but
 * that a run is SAFE TO PUT BEHIND A BUTTON:
 *
 *   1. it spends budget only on models that are actually unknown and reachable —
 *      never re-probing a proven model, never probing a provider with no
 *      credentials;
 *   2. it is bounded, whatever the client asks for;
 *   3. it is single-flight — two runs would read the same candidate list and
 *      probe the same models twice;
 *   4. it makes PROGRESS: the outcomes are recorded against the registry, so the
 *      actionable backlog shrinks and a repeat run has less to do. This is the
 *      property the whole feature exists for, and it is the one that would break
 *      silently if the seam were only counted rather than applied.
 *
 * Hermetic: a throwaway memory dir, and an INJECTED spot-check — the real one
 * talks to a provider.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getModelRegistry,
  resetModelRegistry,
  type ModelRegistryEntry,
} from '../../src/learning/model-registry.js';
import {
  VERIFY_BACKLOG_DEFAULT_PER_RUN,
  VERIFY_BACKLOG_MAX_PER_RUN,
  clampVerifyCount,
  getVerifyBacklogState,
  resetVerifyBacklog,
  startVerifyBacklogRun,
  type SpotCheckOutcome,
  type VerifyBacklogState,
} from '../../src/learning/model-verify-job.js';
import type { ConfigManager } from '../../src/config/manager.js';

let dir = '';
let originalDir: string | undefined;

/** A registry entry with only the fields the candidate selector reads. */
function entry(
  provider: string,
  model: string,
  status: ModelRegistryEntry['status'],
  lastProbedAt: number,
): ModelRegistryEntry {
  return {
    provider,
    model,
    status,
    lastVerifiedAt: status === 'verified' ? lastProbedAt : 0,
    lastProbedAt,
    lastUsedAt: 0,
    errorRate: 0,
    quotaParkedUntil: 0,
    source: 'probe',
  } as ModelRegistryEntry;
}

/** Seed the on-disk registry, then load it. */
function seed(entries: ModelRegistryEntry[]): void {
  const map: Record<string, ModelRegistryEntry> = {};
  for (const e of entries) map[`${e.provider}|${e.model}`] = e;
  writeFileSync(
    join(dir, 'model-registry.json'),
    JSON.stringify({ version: 1, entries: map, updatedAt: Date.now() }),
    'utf-8',
  );
  resetModelRegistry();
}

/** Only these providers can serve — everything else must be skipped. */
const SERVABLE = ['gemini', 'groq'];
const configManager = {
  hasRequiredCredentials: (p: string) => SERVABLE.includes(p),
} as unknown as ConfigManager;

const AGED = Date.now() - 60 * 60 * 1000; // past the 10-minute probe throttle

/**
 * A seam that APPLIES its outcome to the registry, exactly as the real
 * `spotCheckModel` does. Applying it is the point: a run that merely counted
 * outcomes would leave the backlog exactly where it was.
 */
function applyingSeam(
  outcome: SpotCheckOutcome | ((provider: string, model: string) => SpotCheckOutcome),
): { calls: string[]; seam: (p: string, m: string) => Promise<SpotCheckOutcome> } {
  const calls: string[] = [];
  const seam = async (provider: string, model: string): Promise<SpotCheckOutcome> => {
    calls.push(`${provider}/${model}`);
    const result = typeof outcome === 'function' ? outcome(provider, model) : outcome;
    const registry = getModelRegistry();
    if (result === 'verified') registry.markVerified(provider, model, 'spot-check', 42, 'spot-check');
    else if (result === 'unavailable') {
      registry.markUnavailable(provider, model, 'spot-check: 404', 'spot-check', 0, 'spot-check');
    }
    return result;
  };
  return { calls, seam };
}

/** Wait for the background loop to land. */
async function waitForDone(timeoutMs = 3_000): Promise<VerifyBacklogState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = getVerifyBacklogState();
    if (s.status === 'done') return s;
    if (Date.now() > deadline) {
      throw new Error(`run never finished: ${JSON.stringify(getVerifyBacklogState())}`);
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuvira-verify-next-'));
  originalDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = dir;
  resetModelRegistry();
  resetVerifyBacklog();
});

afterEach(() => {
  resetVerifyBacklog();
  resetModelRegistry();
  if (originalDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = originalDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('clampVerifyCount — the bound is the server\'s, not the client\'s', () => {
  it('caps at the per-run ceiling', () => {
    // A UI field is a suggestion; every model in the list is a real generation.
    expect(clampVerifyCount(1_000)).toBe(VERIFY_BACKLOG_MAX_PER_RUN);
    expect(clampVerifyCount(VERIFY_BACKLOG_MAX_PER_RUN + 1)).toBe(VERIFY_BACKLOG_MAX_PER_RUN);
  });

  it('floors at 1 rather than accepting zero or a negative', () => {
    expect(clampVerifyCount(0)).toBe(1);
    expect(clampVerifyCount(-5)).toBe(1);
  });

  it('falls back to the default for a non-number', () => {
    expect(clampVerifyCount(Number.NaN)).toBe(VERIFY_BACKLOG_DEFAULT_PER_RUN);
    expect(clampVerifyCount(Number.POSITIVE_INFINITY)).toBe(VERIFY_BACKLOG_DEFAULT_PER_RUN);
  });

  it('truncates a fractional ask', () => {
    expect(clampVerifyCount(7.9)).toBe(7);
  });
});

describe('startVerifyBacklogRun — what it is allowed to spend', () => {
  it('probes only the never-verified models', async () => {
    seed([
      entry('groq', 'unknown', 'unverified', AGED),
      entry('groq', 'proven', 'verified', AGED),
      entry('groq', 'dead', 'unavailable', AGED),
    ]);
    const { calls, seam } = applyingSeam('verified');
    const started = startVerifyBacklogRun(configManager, 10, { spotCheck: seam });
    expect(started.started).toBe(true);
    await waitForDone();
    expect(calls).toEqual(['groq/unknown']);
  });

  it('spends its budget where the pool is THINNEST, and honours the cap', async () => {
    // groq has no proven model, gemini has one: verifying a second gemini model
    // changes nothing about how the agent behaves, so groq comes first.
    seed([
      entry('gemini', 'working', 'verified', AGED),
      entry('gemini', 'spare-1', 'unverified', AGED),
      entry('gemini', 'spare-2', 'unverified', AGED),
      entry('groq', 'first', 'unverified', AGED),
    ]);
    const { calls, seam } = applyingSeam('verified');
    startVerifyBacklogRun(configManager, 2, { spotCheck: seam });
    const done = await waitForDone();
    expect(calls).toEqual(['groq/first', 'gemini/spare-1']);
    expect(done.planned).toBe(2);
  });

  it('cannot be pointed at a provider with no credentials', async () => {
    seed([entry('openrouter', 'no-key', 'unverified', AGED)]);
    const { calls, seam } = applyingSeam('verified');
    const started = startVerifyBacklogRun(configManager, 10, { spotCheck: seam });
    expect(started.started).toBe(false);
    expect(calls).toEqual([]);
  });

  it('refuses a second run while one is in flight, and does not double-spend', async () => {
    seed([entry('groq', 'a', 'unverified', AGED), entry('groq', 'b', 'unverified', AGED)]);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const calls: string[] = [];
    const seam = async (provider: string, model: string): Promise<SpotCheckOutcome> => {
      calls.push(`${provider}/${model}`);
      await gate;
      getModelRegistry().markVerified(provider, model, 'spot-check', 1, 'spot-check');
      return 'verified';
    };

    const first = startVerifyBacklogRun(configManager, 2, { spotCheck: seam });
    expect(first.started).toBe(true);
    expect(getVerifyBacklogState().status).toBe('running');

    const second = startVerifyBacklogRun(configManager, 2, { spotCheck: seam });
    expect(second.started).toBe(false);
    expect(second.error).toMatch(/already in progress/i);

    release();
    const done = await waitForDone();
    // Two models asked for, two models probed — the refused second run spent
    // nothing, which is the entire reason it is refused rather than queued.
    expect(calls).toEqual(['groq/a', 'groq/b']);
    expect(done.verified).toBe(2);
  });
});

describe('startVerifyBacklogRun — outcomes', () => {
  it('records each result in the order it was tried, and counts them', async () => {
    seed([
      entry('groq', 'good', 'unverified', AGED),
      entry('groq', 'bad', 'unverified', AGED),
      entry('gemini', 'odd', 'unverified', AGED),
    ]);
    const { seam } = applyingSeam((_p, m) =>
      m === 'bad' ? 'unavailable' : m === 'odd' ? 'error' : 'verified',
    );
    startVerifyBacklogRun(configManager, 10, { spotCheck: seam });
    const done = await waitForDone();

    expect(done.planned).toBe(3);
    expect(done.processed).toBe(3);
    expect(done.verified).toBe(1);
    expect(done.unavailable).toBe(1);
    expect(done.errored).toBe(1);
    expect(done.skipped).toBe(0);
    // Order = thinnest provider first, then provider name, then model name —
    // every provider here has zero verified models, so `gemini` precedes `groq`.
    expect(done.results.map((r) => `${r.provider}/${r.model}:${r.outcome}`)).toEqual([
      'gemini/odd:error',
      'groq/bad:unavailable',
      'groq/good:verified',
    ]);
  });

  it('continues past a model that throws — one dead id is not a failed run', async () => {
    seed([
      entry('groq', 'throws', 'unverified', AGED),
      entry('groq', 'fine', 'unverified', AGED),
    ]);
    const calls: string[] = [];
    const seam = async (provider: string, model: string): Promise<SpotCheckOutcome> => {
      calls.push(`${provider}/${model}`);
      if (model === 'throws') throw new Error('provider exploded');
      getModelRegistry().markVerified(provider, model, 'spot-check', 1, 'spot-check');
      return 'verified';
    };
    startVerifyBacklogRun(configManager, 10, { spotCheck: seam });
    const done = await waitForDone();

    // Both were attempted (same provider, so alphabetical): "fine" returned,
    // "throws" did not — and the run still finished the list.
    expect(calls).toEqual(['groq/fine', 'groq/throws']);
    expect(done.errored).toBe(1);
    expect(done.verified).toBe(1);
    expect(done.processed).toBe(2);
  });

  it('reports an errored model as still unknown, never as verified', async () => {
    seed([entry('groq', 'flaky', 'unverified', AGED)]);
    const { seam } = applyingSeam('error');
    startVerifyBacklogRun(configManager, 10, { spotCheck: seam });
    const done = await waitForDone();
    expect(done.verified).toBe(0);
    expect(done.errored).toBe(1);
    // The entry is untouched, so it is still a candidate — the honest reading of
    // a network blip is "we still do not know".
    expect(getModelRegistry().getEntry('groq', 'flaky')?.status).toBe('unverified');
  });

  it('clears `current` when the run lands', async () => {
    seed([entry('groq', 'only', 'unverified', AGED)]);
    const { seam } = applyingSeam('verified');
    startVerifyBacklogRun(configManager, 10, { spotCheck: seam });
    const done = await waitForDone();
    expect(done.current).toBeNull();
    expect(done.finishedAt).not.toBeNull();
    expect(done.status).toBe('done');
  });
});

describe('startVerifyBacklogRun — working the backlog DOWN', () => {
  it('shrinks the actionable backlog, and says by how much', async () => {
    seed([
      entry('groq', 'a', 'unverified', AGED),
      entry('groq', 'b', 'unverified', AGED),
      entry('groq', 'c', 'unverified', AGED),
    ]);
    const { seam } = applyingSeam('verified');
    startVerifyBacklogRun(configManager, 10, { spotCheck: seam });
    const done = await waitForDone();
    // Every candidate was verified, so nothing actionable remains.
    expect(done.verified).toBe(3);
    expect(done.remaining).toBe(0);
  });

  it('is SELF-CONSUMING: a repeat run has nothing left and does not re-probe', async () => {
    seed([entry('groq', 'a', 'unverified', AGED), entry('groq', 'b', 'unverified', AGED)]);
    const first = applyingSeam('verified');
    startVerifyBacklogRun(configManager, 1, { spotCheck: first.seam });
    await waitForDone();
    expect(first.calls).toEqual(['groq/a']);

    const second = applyingSeam('verified');
    const started = startVerifyBacklogRun(configManager, 10, { spotCheck: second.seam });
    expect(started.started).toBe(true);
    const secondDone = await waitForDone();
    // The model verified by run one is gone from the plan; only the remaining
    // unknown is probed. This is what "worked down from the UI" has to mean.
    expect(second.calls).toEqual(['groq/b']);
    expect(secondDone.remaining).toBe(0);
  });

  it('reads the registry from disk before planning, not from a boot-time snapshot', async () => {
    // Reproduces the real hazard: another process (the gateway) verifies a model
    // and persists it AFTER this process loaded its copy. A run must not re-probe
    // what the file already says is proven.
    seed([entry('groq', 'unknown', 'unverified', AGED)]);
    getModelRegistry(); // load the boot-time snapshot into the singleton

    const map: Record<string, ModelRegistryEntry> = {
      'groq|unknown': entry('groq', 'unknown', 'verified', AGED),
    };
    writeFileSync(
      join(dir, 'model-registry.json'),
      JSON.stringify({ version: 1, entries: map, updatedAt: Date.now() }),
      'utf-8',
    );

    const { calls, seam } = applyingSeam('verified');
    const started = startVerifyBacklogRun(configManager, 10, { spotCheck: seam });
    expect(started.started).toBe(false);
    expect(calls).toEqual([]);
  });

  it('refuses rather than reporting a failed run when there is nothing to do', () => {
    seed([entry('groq', 'proven', 'verified', AGED)]);
    const { calls, seam } = applyingSeam('verified');
    const started = startVerifyBacklogRun(configManager, 10, { spotCheck: seam });
    expect(started.started).toBe(false);
    expect(started.error).toBeUndefined();
    expect(started.state.status).toBe('idle');
    expect(started.state.refusal).toMatch(/nothing to verify/i);
    expect(started.state.remaining).toBe(0);
    expect(calls).toEqual([]);
  });
});
