/**
 * DEAD PAIRS — a model the provider itself said does not exist must never be
 * offered again.
 *
 * Live evidence (2026-09-21): the failover pool offered
 * `local/gemini-3.1-flash-lite` — the `local` provider is an Ollama runner that
 * cannot serve a Google model. The registry had already learned "model not
 * found" for the pair, and `buildModelCandidates` handed it back as a candidate
 * anyway, so every walk spent a fallback slot and a 404 round trip that a
 * servable sibling should have had.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getModelRegistry, resetModelRegistry } from '../../src/learning/model-registry.js';
import { buildModelCandidates } from '../../src/learning/model-first-router.js';
import {
  describeRoutingExclusions,
  formatRoutingExclusion,
  renderModelBreadthReport,
  type ModelBreadthReport,
} from '../../src/learning/resilient-call.js';

let tempDir: string;
const ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;
const ORIG_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-deadpair-'));
  process.env.NUVIRA_CONFIG_DIR = tempDir;
  process.env.NUVIRA_MEMORY_DIR = join(tempDir, 'memory');
  resetModelRegistry();
});

afterEach(() => {
  resetModelRegistry();
  if (ORIG_CONFIG_DIR === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = ORIG_CONFIG_DIR;
  if (ORIG_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = ORIG_MEMORY_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

const IMPOSSIBLE = 'gemini-3.1-flash-lite';

describe('the registry retires a pair the provider said does not exist', () => {
  it('marks a "model not found" as a dead pair and lists it', () => {
    const registry = getModelRegistry();
    registry.markListed('local', ['gpt-oss:120b-cloud', IMPOSSIBLE]);
    registry.markUnavailable('local', IMPOSSIBLE, 'model not found', 'telemetry');

    expect(registry.isDeadPair('local', IMPOSSIBLE)).toBe(true);
    expect(registry.isDeadPair('local', 'gpt-oss:120b-cloud')).toBe(false);
    expect(registry.getDeadPairs()).toEqual([{ provider: 'local', model: IMPOSSIBLE }]);
  });

  it('does NOT retire a pair for a repairable failure (auth, quota, permission)', () => {
    const registry = getModelRegistry();
    for (const reason of ['403 permission denied', 'auth (invalid key / forbidden)', 'rate-limit', 'timed out']) {
      registry.markUnavailable('groq', `model-${reason.length}`, reason, 'telemetry');
      expect(registry.isDeadPair('groq', `model-${reason.length}`), reason).toBe(false);
    }
  });

  it('a real success clears the retirement (the provider added the model)', () => {
    const registry = getModelRegistry();
    registry.markUnavailable('local', IMPOSSIBLE, 'model not found', 'telemetry');
    expect(registry.isDeadPair('local', IMPOSSIBLE)).toBe(true);

    registry.recordCall('local', IMPOSSIBLE, true);
    expect(registry.isDeadPair('local', IMPOSSIBLE)).toBe(false);
  });

  it('a fresh model LIST also clears it — the provider is authoritative about its own models', () => {
    const registry = getModelRegistry();
    registry.markUnavailable('local', IMPOSSIBLE, 'model not found', 'telemetry');
    registry.markListed('local', [IMPOSSIBLE]);
    expect(registry.isDeadPair('local', IMPOSSIBLE)).toBe(false);
  });

  it('HEALS pre-flag data: an unavailable entry with a not-found reason is a dead pair', () => {
    // Entries written before the flag existed (or by a surface that doesn't set
    // it) must be honoured too — otherwise the live impossible pair would stay
    // in the pool until it failed once more.
    const registry = getModelRegistry();
    registry.markListed('local', [IMPOSSIBLE]);
    registry.markUnavailable('local', IMPOSSIBLE, 'model not found', 'telemetry');
    // Simulate an old snapshot: same shape, no flag.
    const entry = registry.getEntry('local', IMPOSSIBLE)!;
    delete entry.deadPair;
    expect(registry.isDeadPair('local', IMPOSSIBLE)).toBe(true);
    expect(registry.getDeadPairs()).toContainEqual({ provider: 'local', model: IMPOSSIBLE });
  });
});

describe('the candidate pool no longer offers a dead pair', () => {
  it('drops the dead pair while keeping its servable sibling', () => {
    const registry = getModelRegistry();
    registry.markListed('groq', ['llama-3.3-70b-versatile', IMPOSSIBLE]);
    registry.markUnavailable('groq', IMPOSSIBLE, 'model not found', 'telemetry');

    const candidates = buildModelCandidates('implement a feature with tests', 'moderate', undefined, ['groq']);
    const pairs = candidates.map((c) => `${c.provider}/${c.model}`);
    expect(pairs).not.toContain(`groq/${IMPOSSIBLE}`);
    expect(pairs).toContain('groq/llama-3.3-70b-versatile');
  });

  it('still offers an UNAVAILABLE (repairable) model — retirement is only for impossible pairs', () => {
    const registry = getModelRegistry();
    registry.markListed('groq', ['llama-3.3-70b-versatile']);
    registry.markUnavailable('groq', 'llama-3.3-70b-versatile', '403 permission denied', 'telemetry');

    const candidates = buildModelCandidates('implement a feature with tests', 'moderate', undefined, ['groq']);
    expect(candidates.map((c) => `${c.provider}/${c.model}`)).toContain('groq/llama-3.3-70b-versatile');
  });
});

describe('the exclusion report explains a dead pair', () => {
  it('reports it as a model-scoped ruling, not a parked provider', () => {
    const registry = getModelRegistry();
    registry.markUnavailable('local', IMPOSSIBLE, 'model not found', 'telemetry');

    const report = describeRoutingExclusions().find((r) => r.model === IMPOSSIBLE);
    expect(report).toMatchObject({
      provider: 'local',
      model: IMPOSSIBLE,
      kind: 'model-not-found',
      scope: 'model',
      active: true,
      source: 'registry',
    });
    expect(formatRoutingExclusion(report!)).toMatch(/does not exist on that provider/);
  });

  it('renders under "Ruled out" and promises no recovery for it', () => {
    const registry = getModelRegistry();
    registry.markUnavailable('local', IMPOSSIBLE, 'model not found', 'telemetry');

    const breadth: ModelBreadthReport = {
      tried: [{ provider: 'groq', model: 'llama-3.3-70b-versatile', kind: 'rate-limit', skipped: false, reason: 'rate limited (quota) — still logged in, just throttled' }],
      parked: describeRoutingExclusions().filter((r) => r.active),
    };
    const text = renderModelBreadthReport(breadth, { task: 'explain the router' })!;
    expect(text).toContain('Ruled out (this model does not exist on that provider):');
    expect(text).toContain(`  • local/${IMPOSSIBLE}`);
    // It must NOT be presented as a temporary park with a free-up time.
    expect(text).not.toMatch(new RegExp(`local/${IMPOSSIBLE.replace(/\./g, '\\.')} —`));
  });
});
