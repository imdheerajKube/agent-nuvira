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
 *
 * B2 adds a fourth: the REASONING TIER was decided by `desc.includes('hi')`, a
 * substring of `this`/`which`/`anything`, so 81 of the 160 distinct tasks in the
 * local routing history rated `low` (2 rated `high`) and the weights preferred
 * small models — the `low` tier set the MoE's fit back to 1.0, cancelling the
 * active-width fix in claim 1.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getModelRegistry, resetModelRegistry } from '../../src/learning/model-registry.js';
import {
  buildModelCandidates,
  countEligibleModels,
  estimateTaskRequirements,
  isPairPlausible,
} from '../../src/learning/model-first-router.js';
import {
  estimateTaskRequirements as estimateTaskRequirementsProviderFirst,
} from '../../src/learning/model-scoring.js';
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

/**
 * B2 — THE REASONING TIER, MEASURED ON A FRESH CANDIDATE POOL.
 *
 * The P6 fix above reads a MoE's ACTIVE width and drops its `capabilityFit` to
 * 0.2 for a high-stakes ask — and it was being cancelled one step later, because
 * `estimateTaskRequirements` decided the stakes with `desc.includes('hi')`.
 * 'hi' is a substring of `this`, `which`, `anything`, `nothing`, `architecture`,
 * `crashing`…, so the parity ask (a multi-provider routing design that happens
 * to contain the word "this") was rated `reasoningNeed: 'low'`, which set the
 * MoE's fit back to 1.0 and made the weights prefer small models. Measured on the
 * live ask: `gemini/gemma-4-26b-a4b-it` ranked #1 at 0.9206, with
 * `local/qwen2.5:0.5b` #2 and `gemini/allam-2-7b` #3 — the walk then fell
 * through three providers. Across the 160 distinct tasks in the local routing
 * history, 81 rated `low` and 2 rated `high`; 77 of the 160 matched only the
 * substring.
 */
describe('B2 — the reasoning tier is read from a WORD, not a substring', () => {
  /** The live ask, trimmed to the part that triggered the bug. */
  const PARITY_ASK =
    'I want you to write a best in class routing for an Ai Agent; a model can be available on ' +
    'multiple providers; this will work as a model facilitator to the agent based on task ' +
    'complexity and task type';

  it('rates a complex engineering ask as needing high reasoning', () => {
    expect(estimateTaskRequirements(PARITY_ASK, 'complex').reasoningNeed).toBe('high');
  });

  it('is not moved by prose that merely contains a greeting', () => {
    // Every one of these was measured in the routing history as a `low` rating.
    const measurements = [
      'this will work as a model facilitator',
      'create a dependency diagram which depicts the modules',
      'you never answered anything about the last run',
      'change the hot key to ctrl+shift+t',
      'nothing happened when i selected text',
      'the app is crashing on launch',
      'graphify the report into a diagram',
      'write the architecture design for the router',
    ];
    for (const text of measurements) {
      expect(
        estimateTaskRequirements(text, 'complex').reasoningNeed,
        `expected ${JSON.stringify(text)} to keep the complexity-implied tier`,
      ).toBe('high');
    }
  });

  it('still rates an ask that IS only a greeting as needing low reasoning', () => {
    // The rule the substring test was reaching for, still enforced.
    expect(estimateTaskRequirements('hi', 'moderate').reasoningNeed).toBe('low');
    expect(estimateTaskRequirements('hello, how are you?', 'moderate').reasoningNeed).toBe('low');
  });

  it('leaves the P6 active-width fix able to do its job on the live ask', () => {
    const registry = getModelRegistry();
    registry.markListed('gemini', ['gemma-4-26b-a4b-it', 'gemini-3.1-flash-lite']);
    registry.markVerified('gemini', 'gemma-4-26b-a4b-it', 'telemetry');
    registry.markVerified('gemini', 'gemini-3.1-flash-lite', 'telemetry');
    const candidates = buildModelCandidates(PARITY_ASK, 'complex', undefined, ['gemini']);
    const moe = candidates.find((c) => c.model === 'gemma-4-26b-a4b-it');
    const flashLite = candidates.find((c) => c.model === 'gemini-3.1-flash-lite');
    expect(moe).toBeDefined();
    expect(flashLite).toBeDefined();
    // ~4B active width against a high-stakes ask — not a capability match.
    expect(moe!.dimensions.capabilityFit).toBeLessThanOrEqual(0.2);
    // ...so the proven mid-tier model outranks the pair the live run picked first.
    expect(candidates.indexOf(flashLite!)).toBeLessThan(candidates.indexOf(moe!));
  });

  it('keeps the two `estimateTaskRequirements` copies from drifting apart', () => {
    // There are two implementations (model-first-router and model-scoring) and
    // they had already diverged on other phrases. They must at least agree that a
    // greeting is a word and the whole message, since either can decide a walk.
    const texts = [
      PARITY_ASK,
      'this will work',
      'hi',
      'hello, how are you?',
      'hi, build me a RAG pipeline',
      'which module owns the retry logic',
    ];
    for (const text of texts) {
      expect(
        estimateTaskRequirementsProviderFirst(text, 'complex').reasoningNeed,
        `the two definitions disagree about ${JSON.stringify(text)}`,
      ).toBe(estimateTaskRequirements(text, 'complex').reasoningNeed);
    }
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
