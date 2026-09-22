/**
 * Engine router tests (`tests/learning/engine-router.test.ts`) —
 * AGENTIC_CAPABILITY_ASSESSMENT Addendum v4 Phase 2: "Route MODE as well as
 * model." Pure + deterministic decisions: config override wins, local/weak
 * tier → pipeline, strong/unknown → loop. No network, no config files.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveEngine,
  engineForTask,
  isWeakTierProvider,
  readEngineModeConfig,
} from '../../src/learning/engine-router.js';

describe('engine router — config override', () => {
  it('an explicit pipeline override wins over everything (CI semantics)', () => {
    const d = resolveEngine({
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      configManager: { getAll: () => ({ routing: { engineMode: 'pipeline' } }) },
    });
    expect(d.engine).toBe('pipeline');
    expect(d.reason).toBe('config-override');
  });

  it('an explicit loop override wins even for a local provider', () => {
    const d = resolveEngine({
      provider: 'local',
      configManager: { getAll: () => ({ routing: { engineMode: 'loop' } }) },
    });
    expect(d.engine).toBe('loop');
    expect(d.reason).toBe('config-override');
  });
});

describe('engine router — auto (tier decides)', () => {
  it('local runner → pipeline (the weak-model advantage kept honestly)', () => {
    const d = resolveEngine({ provider: 'local', model: 'llama3' });
    expect(d.engine).toBe('pipeline');
    expect(d.reason).toBe('local-provider');
  });

  it('every documented local-runner id routes to pipeline', () => {
    for (const p of ['local', 'ollama', 'lmstudio', 'vllm']) {
      expect(engineForTask(p, undefined, undefined)).toBe('pipeline');
    }
  });

  it('strong cloud provider → loop (the universal engine)', () => {
    const d = resolveEngine({ provider: 'groq', model: 'llama-3.3-70b-versatile' });
    expect(d.engine).toBe('loop');
    expect(d.reason).toBe('strong-tier-default');
  });

  it('gemini/anthropic (post Phase 1.2) route to loop', () => {
    expect(engineForTask('gemini', 'gemini-2.0-flash', undefined)).toBe('loop');
    expect(engineForTask('anthropic', 'claude-3-5-haiku', undefined)).toBe('loop');
  });

  it('unknown provider defaults to loop (weakness must be proven, not assumed)', () => {
    const d = resolveEngine({ provider: 'some-plugin-provider' });
    expect(d.engine).toBe('loop');
    expect(d.reason).toBe('unknown-provider-default');
  });

  it('an unrouted call (no provider) still resolves deterministically to loop', () => {
    expect(engineForTask(undefined, undefined, undefined)).toBe('loop');
  });

  it('decision inputs are echoed for the audit trail', () => {
    const d = resolveEngine({ provider: 'groq', model: 'm1', complexity: 'moderate' });
    expect(d.inputs).toEqual({
      provider: 'groq',
      model: 'm1',
      complexity: 'moderate',
      configMode: 'auto',
    });
  });
});

describe('engine router — helpers', () => {
  it('isWeakTierProvider matches local ids and catalog reasoning floors', () => {
    expect(isWeakTierProvider('local')).toBe(true);
    expect(isWeakTierProvider('groq')).toBe(false);
    expect(isWeakTierProvider(undefined)).toBe(false);
    expect(isWeakTierProvider('unknown-plugin')).toBe(false);
  });

  it('readEngineModeConfig falls back to auto on absence/failure', () => {
    expect(readEngineModeConfig(undefined)).toBe('auto');
    expect(readEngineModeConfig({ getAll: () => ({ routing: {} }) })).toBe('auto');
    expect(readEngineModeConfig({ getAll: () => ({ routing: { engineMode: 'pipeline' } }) })).toBe('pipeline');
    expect(
      readEngineModeConfig({
        getAll: () => {
          throw new Error('boom');
        },
      }),
    ).toBe('auto');
  });

  it('a malformed config value degrades to auto (never throws)', () => {
    expect(readEngineModeConfig({ getAll: () => ({ routing: { engineMode: 'bogus' as never } }) })).toBe('auto');
  });
});

/**
 * G13b — an AUTHORED ARTIFACT the user asked to be produced goes to the
 * pipeline, whatever the provider tier.
 *
 * WHY THE TIER WAS THE WRONG INPUT. The loop produced a complete, genuinely
 * good 12-page story for `write a 12 page story at /path/Mahagatha.md` and wrote
 * NOTHING to disk, while the same ask on the pipeline finished unattended with
 * the chapters and the assembled book. The loop is optimised for a turn that
 * ACTS with tools; an authored deliverable needs units, continuity across
 * batches and an assembly step.
 *
 * The negations matter as much as the rule: this must not capture a CHAT ask for
 * the same content, and it must not override an explicit user choice of engine.
 */
describe('engine router — authored artifact routing (G13b)', () => {
  const strong = 'groq';

  it('routes an authored deliverable that names a destination to the pipeline', () => {
    const d = resolveEngine({
      provider: strong,
      goal: 'write a 12 page story to /Users/d/story/Mahagatha.md about a village boy',
    });
    expect(d.engine).toBe('pipeline');
    expect(d.reason).toBe('authored-artifact');
    expect(d.explanation).toMatch(/authored deliverable/i);
  });

  it('routes an authored deliverable with no path (the ask is still for a file)', () => {
    const d = resolveEngine({ provider: strong, goal: 'write a 5 page story called Kharig Nights' });
    expect(d.engine).toBe('pipeline');
    expect(d.reason).toBe('authored-artifact');
  });

  it('routes a HYBRID web book to the pipeline (phases, not a single-mode plan)', () => {
    const d = resolveEngine({
      provider: strong,
      goal: 'develop an interactive web-based book with voice narration for every chapter',
    });
    expect(d.engine).toBe('pipeline');
    expect(d.reason).toBe('authored-artifact');
  });

  it('leaves a CHAT story ask on the loop — no artifact was requested', () => {
    const d = resolveEngine({ provider: strong, goal: 'tell me a story about a village boy' });
    expect(d.engine).toBe('loop');
    expect(d.reason).toBe('strong-tier-default');
  });

  it('leaves a question ABOUT the work on the loop', () => {
    const d = resolveEngine({
      provider: strong,
      goal: 'explain how to write a story to a file',
    });
    expect(d.engine).toBe('loop');
  });

  it('leaves a genuine engineering ask on the loop', () => {
    const d = resolveEngine({
      provider: strong,
      goal: 'fix the calculator so division by zero returns 0',
    });
    expect(d.engine).toBe('loop');
  });

  it('still obeys an explicit loop override — which is why the loop gate exists', () => {
    const d = resolveEngine({
      provider: strong,
      goal: 'write a 12 page story to /Users/d/story/Mahagatha.md',
      configManager: { getAll: () => ({ routing: { engineMode: 'loop' } }) },
    });
    expect(d.engine).toBe('loop');
    expect(d.reason).toBe('config-override');
  });

  it('is unchanged when no goal is supplied (every existing caller)', () => {
    const d = resolveEngine({ provider: strong, model: 'm' });
    expect(d.engine).toBe('loop');
    expect(d.reason).toBe('strong-tier-default');
    // The echoed inputs do not grow a `goal` key it was never given.
    expect('goal' in d.inputs).toBe(false);
  });

  it('stays deterministic — the same goal always yields the same engine', () => {
    const goal = 'write a 12 page story called Kharig Nights';
    const first = resolveEngine({ provider: strong, goal });
    const second = resolveEngine({ provider: strong, goal });
    expect(second.engine).toBe(first.engine);
    expect(second.reason).toBe(first.reason);
  });
});
