/**
 * The routing pool must GROW (Models-page audit).
 *
 * The audit found the pool frozen and then decaying: 12 verified models across 3
 * providers against 496 unverified ones, with one model taking 87% of a day's
 * calls and four of the twelve within 24h of the registry's 7-day staleness
 * cutoff. Two mechanisms caused it, and this file pins both fixes:
 *
 *   1. The warmup cycle only considered models THIS process had already used
 *      (`usageMap`), so a model that had never served a call could never be
 *      verified — and could never serve a call. Worse, it bailed out entirely on
 *      an empty map, which is the state of every short-lived CLI run.
 *   2. The daemon only ever started from the COLD-START branch (registry has NO
 *      verified providers), so from the first verified model onward nothing
 *      warmed or verified anything at all.
 *   3. Nothing refreshed a VERIFIED model either: exploration selects
 *      `unverified` rows only, so a pooled model could only AGE toward the
 *      registry's 7-day retirement — and since the health ranking reads
 *      `lastVerifiedAt`, routing kept ranking it on evidence that had stopped
 *      describing it. The third half re-spot-checks the stale end of the pool,
 *      bounded and old-first.
 *
 * Hermetic: a throwaway memory dir, and an INJECTED spot-check (the real one
 * talks to a provider).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getModelRegistry,
  resetModelRegistry,
  type ModelRegistryEntry,
} from '../../src/learning/model-registry.js';
import {
  selectExplorationCandidates,
  selectPoolRefreshCandidates,
  runWarmupCycle,
  startWarmupDaemon,
  stopWarmupDaemon,
  warmupConfig,
  type WarmupDeps,
} from '../../src/learning/model-warmup.js';
import type { ConfigManager } from '../../src/config/manager.js';

let dir = '';
let originalDir: string | undefined;

/** A registry entry with only the fields the warmup logic reads. */
function entry(provider: string, model: string, status: ModelRegistryEntry['status'], lastProbedAt: number): ModelRegistryEntry {
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuvira-warmup-'));
  originalDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = dir;
  resetModelRegistry();
});

afterEach(() => {
  stopWarmupDaemon();
  resetModelRegistry();
  if (originalDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = originalDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('selectExplorationCandidates — the models the router cannot see', () => {
  it('offers unverified models for a spot-check', () => {
    seed([entry('gemini', 'unverified-a', 'unverified', AGED)]);
    const picked = selectExplorationCandidates(getModelRegistry(), configManager, Date.now(), 5);
    expect(picked.map((c) => `${c.provider}/${c.model}`)).toEqual(['gemini/unverified-a']);
  });

  it('broadens PROVIDERS first — the thinnest pool is what freezes behaviour', () => {
    // gemini already has a working model; groq has none. Verifying a 2nd gemini
    // model changes nothing about how the agent behaves — verifying the FIRST
    // groq model does.
    seed([
      entry('gemini', 'working', 'verified', AGED),
      entry('gemini', 'spare', 'unverified', AGED),
      entry('groq', 'first', 'unverified', AGED),
    ]);
    const picked = selectExplorationCandidates(getModelRegistry(), configManager, Date.now(), 5);
    expect(picked[0].provider).toBe('groq');
    expect(picked[0].model).toBe('first');
  });

  it('never spends the budget on a provider that cannot serve', () => {
    seed([
      entry('ghost', 'no-adapter', 'unverified', AGED),
      entry('openrouter', 'no-credentials', 'unverified', AGED),
      entry('groq', 'real', 'unverified', AGED),
    ]);
    const picked = selectExplorationCandidates(getModelRegistry(), configManager, Date.now(), 5);
    expect(picked.map((c) => c.provider)).toEqual(['groq']);
  });

  it('does not re-probe a model inside the throttle window', () => {
    seed([entry('groq', 'just-probed', 'unverified', Date.now())]);
    expect(selectExplorationCandidates(getModelRegistry(), configManager, Date.now(), 5)).toEqual([]);
  });

  it('leaves verified and dead models alone', () => {
    seed([
      entry('groq', 'verified-one', 'verified', AGED),
      entry('groq', 'dead-one', 'unavailable', AGED),
    ]);
    expect(selectExplorationCandidates(getModelRegistry(), configManager, Date.now(), 5)).toEqual([]);
  });

  it('honours the per-cycle budget', () => {
    seed(Array.from({ length: 20 }, (_, i) => entry('groq', `m${i}`, 'unverified', AGED)));
    expect(selectExplorationCandidates(getModelRegistry(), configManager, Date.now(), 3)).toHaveLength(3);
    expect(selectExplorationCandidates(getModelRegistry(), configManager, Date.now(), 0)).toEqual([]);
  });
});

describe('runWarmupCycle — exploration runs even with nothing in use', () => {
  /**
   * Record which provider/model pairs were spot-checked, and answer `verified`.
   *
   * `detectCredentialChange` is pinned to "no change" by default so a cycle's
   * behaviour is about warmup, not about whatever the developer's real key set
   * happens to be.
   */
  function recorder(outcome: 'verified' | 'unavailable' | 'error' = 'verified') {
    const calls: string[] = [];
    const refreshCatalog = vi.fn(async () => ({}));
    const deps: WarmupDeps = {
      spotCheck: vi.fn(async (provider: string, model: string) => {
        calls.push(`${provider}/${model}`);
        return outcome;
      }),
      detectCredentialChange: () => ({ changed: false }),
      refreshCatalog,
    };
    return { calls, deps, refreshCatalog };
  }

  it('explores unverified models on a FRESH process (the old early-return bug)', async () => {
    // The old cycle returned immediately when `usageMap` was empty — which is
    // the state of every short-lived run, i.e. exactly when exploration matters.
    seed([entry('groq', 'never-used', 'unverified', AGED)]);
    const { calls, deps } = recorder();

    const result = await runWarmupCycle(configManager, deps);

    expect(calls).toEqual(['groq/never-used']);
    expect(result.explored).toBe(1);
    expect(result.verified).toBe(1);
    expect(result.warmed).toBe(0);
  });

  it('reports a failed spot-check as explored but not verified', async () => {
    seed([entry('groq', 'broken', 'unverified', AGED)]);
    const { deps } = recorder('unavailable');

    const result = await runWarmupCycle(configManager, deps);
    expect(result.explored).toBe(1);
    expect(result.verified).toBe(0);
  });

  it('is bounded per cycle', async () => {
    seed(Array.from({ length: 20 }, (_, i) => entry('groq', `m${i}`, 'unverified', AGED)));
    const { calls, deps } = recorder();

    const result = await runWarmupCycle(configManager, deps);
    expect(result.explored).toBeLessThanOrEqual(6);
    expect(calls.length).toBe(result.explored);
  });

  it('does nothing when there is nothing worth checking', async () => {
    seed([entry('groq', 'already', 'verified', AGED)]);
    const { calls, deps } = recorder();
    const result = await runWarmupCycle(configManager, deps);
    expect(calls).toEqual([]);
    expect(result).toEqual({
      warmed: 0,
      explored: 0,
      poolRefreshed: 0,
      verified: 0,
      skipped: 0,
      catalogRefreshed: false,
      // It RAN — and did nothing, which is different from being refused the
      // duty lease (see the `ran: false` case below).
      ran: true,
    });
  });

  it('re-probes the catalog when the credential set changed — and only then', async () => {
    // The case a user actually notices: "I just bought credits, where are my
    // models?" A purchase changes the KEY SET, so the change is detectable even
    // though there is no per-model entitlement API to ask.
    seed([entry('groq', 'never-used', 'unverified', AGED)]);
    const { deps, refreshCatalog } = recorder();
    (deps as { detectCredentialChange?: () => { changed: boolean } }).detectCredentialChange = () => ({
      changed: true,
    });

    const result = await runWarmupCycle(configManager, deps);

    expect(refreshCatalog).toHaveBeenCalledTimes(1);
    expect(result.catalogRefreshed).toBe(true);
    // …and the exploration half still runs, so newly-listed models get verified.
    expect(result.explored).toBe(1);
  });

  it('does not re-probe on an unchanged credential set', async () => {
    seed([entry('groq', 'never-used', 'unverified', AGED)]);
    const { deps, refreshCatalog } = recorder();
    const result = await runWarmupCycle(configManager, deps);
    expect(refreshCatalog).not.toHaveBeenCalled();
    expect(result.catalogRefreshed).toBe(false);
  });

  it('survives a failing catalog re-probe (best-effort, never breaks warmup)', async () => {
    seed([entry('groq', 'never-used', 'unverified', AGED)]);
    const { deps } = recorder();
    (deps as { detectCredentialChange?: () => { changed: boolean } }).detectCredentialChange = () => ({
      changed: true,
    });
    deps.refreshCatalog = vi.fn(async () => {
      throw new Error('probe exploded');
    });

    await expect(runWarmupCycle(configManager, deps)).resolves.toMatchObject({ explored: 1 });
  });
});

/**
 * ONE SWEEP AT A TIME, ACROSS PROCESSES.
 *
 * Every warmup candidate is a REAL generation on the user's free tier, so two
 * processes sweeping the same list is not merely redundant — it is the exact
 * traffic that turns warmup into 429s, and it wastes the budget the pool growth
 * depends on. The in-process `isRunning` guard cannot see the other process; the
 * duty lease can (see `duty-lease.ts`).
 */
describe('runWarmupCycle — the duty lease', () => {
  const LEASE = 'model-warmup';

  /** Write a lease as if another process had taken it `ageMs` ago. */
  function writeForeignLease(ageMs: number): void {
    const path = join(dir, 'duties', `${LEASE}.lease`);
    mkdirSync(join(dir, 'duties'), { recursive: true });
    const at = Date.now() - ageMs;
    writeFileSync(
      path,
      JSON.stringify({ name: LEASE, pid: 999_999, host: 'another-machine', startedAt: at, renewedAt: at }),
    );
    const seconds = at / 1000;
    utimesSync(path, seconds, seconds);
  }

  it('REFUSES a cycle while another process holds the lease — and spends nothing', async () => {
    seed([entry('groq', 'never-used', 'unverified', AGED)]);
    writeForeignLease(1_000);
    const spotCheck = vi.fn(async () => 'verified' as const);

    const result = await runWarmupCycle(configManager, {
      spotCheck,
      detectCredentialChange: () => ({ changed: false }),
    });

    expect(result.ran).toBe(false);
    expect(result.explored).toBe(0);
    expect(result.verified).toBe(0);
    expect(result.leaseHeldBy?.pid).toBe(999_999);
    // The point of the lease: no generation was spent.
    expect(spotCheck).not.toHaveBeenCalled();
  });

  it('steals a STALE lease and sweeps — a killed holder must not switch warmup off', async () => {
    seed([entry('groq', 'never-used', 'unverified', AGED)]);
    // Older than any stale window these tests can produce.
    writeForeignLease(60 * 60 * 1000);

    const result = await runWarmupCycle(configManager, {
      spotCheck: async () => 'verified',
      detectCredentialChange: () => ({ changed: false }),
    });

    expect(result.ran).toBe(true);
    expect(result.explored).toBe(1);
  });

  it('releases the lease when the cycle finishes, so the next one can run', async () => {
    seed([entry('groq', 'never-used', 'unverified', AGED)]);
    const deps: WarmupDeps = {
      spotCheck: async () => 'verified',
      detectCredentialChange: () => ({ changed: false }),
    };
    const first = await runWarmupCycle(configManager, deps);
    const second = await runWarmupCycle(configManager, deps);
    // The second is refused by the PROBE THROTTLE (the model was just probed),
    // not by a leaked lease — which is exactly what `ran: true` shows.
    expect(first.ran).toBe(true);
    expect(second.ran).toBe(true);
  });
});

describe('warmupConfig — the sweep\'s bounds are configuration, not constants', () => {
  it('defaults every bound when nothing is overridden', () => {
    const cfg = warmupConfig({} as NodeJS.ProcessEnv);
    expect(cfg).toEqual({
      intervalMs: 60_000,
      warmThrottleMs: 300_000,
      hotPerCycle: 10,
      explorePerCycle: 6,
      exploreThrottleMs: 600_000,
      hotWindowMs: 30_600_000,
      warmWindowMs: 86_400_000,
      poolRefreshPerCycle: 4,
      poolStalenessMs: 43_200_000,
    });
  });

  it('honours env overrides (a free tier can dial the sweep down)', () => {
    const cfg = warmupConfig({
      NUVIRA_WARMUP_EXPLORE_PER_CYCLE: '1',
      NUVIRA_WARMUP_INTERVAL_MS: '5000',
    } as NodeJS.ProcessEnv);
    expect(cfg.explorePerCycle).toBe(1);
    expect(cfg.intervalMs).toBe(5000);
  });

  it('ignores nonsense rather than disarming the sweep or spinning it up', () => {
    const cfg = warmupConfig({
      NUVIRA_WARMUP_EXPLORE_PER_CYCLE: 'lots',
      NUVIRA_WARMUP_INTERVAL_MS: '-5',
      NUVIRA_WARMUP_HOT_PER_CYCLE: '0',
    } as NodeJS.ProcessEnv);
    expect(cfg.explorePerCycle).toBe(6);
    expect(cfg.intervalMs).toBe(60_000);
    expect(cfg.hotPerCycle).toBe(10);
  });

  it('the cycle actually uses the configured budget', async () => {
    process.env.NUVIRA_WARMUP_EXPLORE_PER_CYCLE = '2';
    try {
      seed(Array.from({ length: 20 }, (_, i) => entry('groq', `m${i}`, 'unverified', AGED)));
      const calls: string[] = [];
      const result = await runWarmupCycle(configManager, {
        spotCheck: async (p: string, m: string) => {
          calls.push(`${p}/${m}`);
          return 'verified';
        },
        detectCredentialChange: () => ({ changed: false }),
      });
      expect(result.explored).toBe(2);
      expect(calls).toHaveLength(2);
    } finally {
      delete process.env.NUVIRA_WARMUP_EXPLORE_PER_CYCLE;
    }
  });
});

describe('the STALE half — a verified pool must not quietly expire', () => {
  /** Verified 13h ago: past the 12h in-pool staleness window. */
  const VERY_OLD = Date.now() - 13 * 60 * 60 * 1000;

  it('re-spot-checks a verified model that has gone stale', () => {
    seed([entry('groq', 'pooled', 'verified', VERY_OLD)]);
    const picked = selectPoolRefreshCandidates(getModelRegistry(), configManager, Date.now(), 5);
    expect(picked.map((c) => `${c.provider}/${c.model}`)).toEqual(['groq/pooled']);
  });

  it('leaves a FRESHLY verified model alone (hours, not the 7-day rule)', () => {
    seed([entry('groq', 'fresh', 'verified', Date.now() - 60 * 60 * 1000)]);
    expect(selectPoolRefreshCandidates(getModelRegistry(), configManager, Date.now(), 5)).toEqual([]);
  });

  it('leaves unverified and unavailable rows to exploration', () => {
    seed([
      entry('groq', 'never-verified', 'unverified', VERY_OLD),
      entry('groq', 'dead', 'unavailable', VERY_OLD),
    ]);
    expect(selectPoolRefreshCandidates(getModelRegistry(), configManager, Date.now(), 5)).toEqual([]);
  });

  it('skips a quota-parked model — a park is a rest with a known end', () => {
    const parked = entry('groq', 'resting', 'verified', VERY_OLD);
    parked.quotaParkedUntil = Date.now() + 60_000;
    seed([parked]);
    expect(selectPoolRefreshCandidates(getModelRegistry(), configManager, Date.now(), 5)).toEqual([]);
  });

  it('takes the MOST stale models first, and stays bounded per cycle', () => {
    seed([
      ...Array.from({ length: 10 }, (_, i) =>
        entry('groq', `stale-${i}`, 'verified', Date.now() - (14 + i) * 60 * 60 * 1000),
      ),
    ]);
    const picked = selectPoolRefreshCandidates(getModelRegistry(), configManager, Date.now(), 3);
    expect(picked).toHaveLength(3);
    // `stale-9` has been unverified the longest.
    expect(picked[0].model).toBe('stale-9');
  });

  it('runs as part of a cycle and is reported separately from exploration', async () => {
    seed([
      entry('groq', 'pooled', 'verified', VERY_OLD),
      entry('groq', 'never-seen', 'unverified', AGED),
    ]);
    const calls: string[] = [];
    const result = await runWarmupCycle(configManager, {
      spotCheck: async (p: string, m: string) => {
        calls.push(`${p}/${m}`);
        return 'verified';
      },
      detectCredentialChange: () => ({ changed: false }),
    });

    expect(calls).toContain('groq/pooled');
    expect(result.poolRefreshed).toBe(1);
    expect(result.explored).toBe(1);
    // Refreshing the pool is not "warming a hot model" — the counters stay honest.
    expect(result.warmed).toBe(0);
  });
});

describe('startWarmupDaemon', () => {
  it('is idempotent and stoppable', () => {
    seed([]);
    startWarmupDaemon(configManager, { spotCheck: async () => 'skipped' });
    startWarmupDaemon(configManager, { spotCheck: async () => 'skipped' }); // no-op
    stopWarmupDaemon();
    expect(() => stopWarmupDaemon()).not.toThrow();
  });
});
