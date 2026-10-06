/**
 * fix_model_routing P6 — SELECTION TRUTHFULNESS (RC4, RC6).
 *
 * Three claims the router was making that the evidence did not support:
 *
 *   1. A MoE model's TOTAL parameter count was read as its capability width.
 *      `gemma-4-26b-a4b-it` (26B total, ~4B active) ranked #1 at 0.87 for a
 *      moderate task — above `gemini-3.1-flash-lite` — in the very run that then
 *      returned five empty responses in a row.
 *   2. An entry the registry had already judged `unavailable` kept scoring as a
 *      capability match for the task.
 *   3. The pool offered pairs that cannot exist (`gemini/qwen2.5:0.5b`,
 *      `groq/wire-stub-model` were marked VERIFIED), and counted providers this
 *      machine has no credential for — 538 "models" across 23 "providers" while
 *      17 pairs had ever been verified.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getModelRegistry, resetModelRegistry } from '../../src/learning/model-registry.js';
import {
  buildModelCandidates,
  countEligibleModels,
  isPairPlausible,
} from '../../src/learning/model-first-router.js';
import { ConfigManager } from '../../src/config/manager.js';

let tempDir: string;
const ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;
const ORIG_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-router-truth-'));
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

/** Score one pair through the real candidate builder. */
function scoreOf(provider: string, model: string, task = 'implement a feature with tests'): number {
  const candidates = buildModelCandidates(task, 'moderate', undefined, [provider]);
  const hit = candidates.find((c) => c.model === model);
  if (!hit) throw new Error(`${provider}/${model} was not a candidate at all`);
  return hit.score;
}

describe('P6 — capability reads the ACTIVE width of a mixture-of-experts model', () => {
  it('classifies an a4b MoE by its ~4B active params, not its 26B total', () => {
    const registry = getModelRegistry();
    registry.markListed('gemini', ['gemma-4-26b-a4b-it', 'gemma-4-26b-it']);
    registry.markVerified('gemini', 'gemma-4-26b-a4b-it', 'telemetry');
    registry.markVerified('gemini', 'gemma-4-26b-it', 'telemetry');
    const candidates = buildModelCandidates('implement a feature with tests', 'moderate', undefined, ['gemini']);
    const moe = candidates.find((c) => c.model === 'gemma-4-26b-a4b-it');
    const dense = candidates.find((c) => c.model === 'gemma-4-26b-it');
    expect(moe).toBeDefined();
    expect(dense).toBeDefined();
    // The tag is the provider telling us the active width; they are not equals.
    expect(moe!.dimensions.capabilityFit).toBeLessThan(dense!.dimensions.capabilityFit);
    expect(moe!.dimensions.capabilityFit).toBeLessThanOrEqual(0.4);
  });

  it('ranks the proven mid-tier model above the broken MoE it lost to live', () => {
    const registry = getModelRegistry();
    registry.markListed('gemini', ['gemma-4-26b-a4b-it', 'gemini-3.1-flash-lite']);
    registry.markVerified('gemini', 'gemma-4-26b-a4b-it', 'telemetry');
    registry.markVerified('gemini', 'gemini-3.1-flash-lite', 'telemetry');
    const candidates = buildModelCandidates('build a knowledge base web app', 'moderate', undefined, ['gemini']);
    const order = candidates.map((c) => c.model);
    const moe = order.indexOf('gemma-4-26b-a4b-it');
    const flashLite = order.indexOf('gemini-3.1-flash-lite');
    expect(flashLite).toBeGreaterThanOrEqual(0);
    // The live failure was exactly this ordering being the other way round.
    expect(flashLite).toBeLessThan(moe);
  });
});

describe('P6 — a pair the registry judged unusable stops claiming capability', () => {
  it('caps the capability fit of an `unavailable` entry', () => {
    const registry = getModelRegistry();
    registry.markListed('groq', ['openai/gpt-oss-120b']);
    registry.markVerified('groq', 'openai/gpt-oss-120b', 'telemetry');
    const healthy = scoreOf('groq', 'openai/gpt-oss-120b');

    registry.markUnavailable('groq', 'openai/gpt-oss-120b', 'server error', 'telemetry');
    const candidates = buildModelCandidates('implement a feature with tests', 'moderate', undefined, ['groq']);
    const entry = candidates.find((c) => c.model === 'openai/gpt-oss-120b')!;
    expect(entry.dimensions.capabilityFit).toBeLessThanOrEqual(0.2);
    expect(entry.score).toBeLessThan(healthy);
  });
});

describe('P6 — pool hygiene: a pair that cannot exist is not a candidate', () => {
  it('rejects an Ollama-style tag on a hosted provider, keeps it on a local runner', () => {
    expect(isPairPlausible('gemini', 'qwen2.5:0.5b')).toBe(false);
    expect(isPairPlausible('groq', 'qwen2.5:0.5b')).toBe(false);
    expect(isPairPlausible('local', 'qwen2.5:0.5b')).toBe(true);
    expect(isPairPlausible('local', 'gpt-oss:120b-cloud')).toBe(true); // live, real
    expect(isPairPlausible('gemini', 'gemini-3.1-flash-lite')).toBe(true);
  });

  it('rejects a test fixture id', () => {
    expect(isPairPlausible('groq', 'wire-stub-model')).toBe(false);
    expect(isPairPlausible('groq', 'test-model-1')).toBe(false);
    expect(isPairPlausible('groq', 'llama-3.3-70b-versatile')).toBe(true);
  });

  it('drops the impossible verified pair from the pool', () => {
    const registry = getModelRegistry();
    registry.markListed('gemini', ['qwen2.5:0.5b', 'gemini-3.1-flash-lite']);
    registry.markVerified('gemini', 'qwen2.5:0.5b', 'telemetry'); // the false claim on disk
    const candidates = buildModelCandidates('implement a feature', 'moderate', undefined, ['gemini']);
    const pairs = candidates.map((c) => `${c.provider}/${c.model}`);
    expect(pairs).not.toContain('gemini/qwen2.5:0.5b');
    expect(pairs).toContain('gemini/gemini-3.1-flash-lite');
  });
});

describe('P5/P6 — the pool count is CREDENTIALED, so a shortage claim is checkable', () => {
  function configWithOnly(providers: Record<string, unknown>): ConfigManager {
    const dir = join(tempDir, 'cfg');
    mkdtempSync(dir + '-');
    writeFileSync(join(tempDir, 'buffconfig.json'), JSON.stringify({ providers }), 'utf-8');
    return new ConfigManager(tempDir);
  }

  it('counts only providers this machine can actually call', () => {
    const cm = configWithOnly({ groq: { apiKey: 'test-key-not-real' } });
    const credentialed = countEligibleModels(undefined, cm);
    const unfiltered = countEligibleModels();

    // The gated count can never exceed the catalog count, and it must exclude
    // providers with no credential (openai, anthropic, xai, … the ones that made
    // the live report say "538 models").
    expect(credentialed.models).toBeLessThanOrEqual(unfiltered.models);
    const providers = new Set(
      buildModelCandidates('implement a feature', 'moderate', cm).map((c) => c.provider),
    );
    expect(providers.has('gemini')).toBe(false);
    expect(providers.has('openai')).toBe(false);
    expect(providers.has('anthropic')).toBe(false);
    // Keyless local runners are always callable by definition.
    expect(providers.has('local')).toBe(true);
  });

  it('keeps the legacy unfiltered count when no ConfigManager is supplied', () => {
    // The number is unchanged for callers that deliberately want the catalog
    // (probes, diagnostics) — only the credential-aware call is narrowed.
    expect(typeof countEligibleModels().models).toBe('number');
    expect(countEligibleModels().models).toBeGreaterThan(0);
  });
});
