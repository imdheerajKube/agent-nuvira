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
