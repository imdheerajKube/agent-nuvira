/**
 * Capability mode — the reasoning-vs-cost switch.
 *
 * The product decision these pin: a single bad experience loses a user, so
 * cost-saving that produces a weak, nagging agent is a false economy — but cost
 * is real, so the user owns the trade. `balanced` is the default and leaves
 * routing byte-identical; `max` relaxes the cost gates and prefers capability.
 * What it must NEVER do is widen the safety surface.
 */

import { describe, it, expect, afterEach } from 'vitest';

import {
  DEFAULT_CAPABILITY_MODE,
  MAX_CAPABILITY_MIN_REASONING,
  capabilityRoutingPolicy,
  isMaxCapability,
  parseCapabilityMode,
  resolveCapabilityMode,
} from '../../src/config/capability-mode.js';
import type { ConfigManager } from '../../src/config/manager.js';
import { buildAutoResolveOptions } from '../../src/learning/resolve-options.js';

const ENV_NAMES = ['NUVIRA_CAPABILITY_MODE', 'BUFF_CAPABILITY_MODE'];
const backup: Record<string, string | undefined> = {};
for (const n of ENV_NAMES) backup[n] = process.env[n];

afterEach(() => {
  for (const n of ENV_NAMES) {
    if (backup[n] === undefined) delete process.env[n];
    else process.env[n] = backup[n];
  }
});

/** A ConfigManager stub that only answers getAll(). */
function cm(routing: Record<string, unknown>): ConfigManager {
  return { getAll: () => ({ routing }) } as unknown as ConfigManager;
}

describe('parseCapabilityMode', () => {
  it('accepts the canonical names and their intuitive synonyms', () => {
    expect(parseCapabilityMode('balanced')).toBe('balanced');
    expect(parseCapabilityMode('balance')).toBe('balanced');
    expect(parseCapabilityMode('default')).toBe('balanced');
    expect(parseCapabilityMode('max')).toBe('max');
    expect(parseCapabilityMode('MAXIMUM')).toBe('max');
    expect(parseCapabilityMode('performance-first')).toBe('max');
    expect(parseCapabilityMode('unlimited')).toBe('max');
  });

  it('returns null for empty or unrecognized values (never guesses)', () => {
    expect(parseCapabilityMode('')).toBeNull();
    expect(parseCapabilityMode(undefined)).toBeNull();
    expect(parseCapabilityMode('turbo')).toBeNull();
  });
});

describe('resolveCapabilityMode — env wins over config, config over default', () => {
  it('defaults to balanced when nothing is set', () => {
    delete process.env.NUVIRA_CAPABILITY_MODE;
    delete process.env.BUFF_CAPABILITY_MODE;
    expect(resolveCapabilityMode()).toBe(DEFAULT_CAPABILITY_MODE);
    expect(resolveCapabilityMode(cm({}))).toBe('balanced');
  });

  it('reads the config value when no env is set', () => {
    delete process.env.NUVIRA_CAPABILITY_MODE;
    delete process.env.BUFF_CAPABILITY_MODE;
    expect(resolveCapabilityMode(cm({ capabilityMode: 'max' }))).toBe('max');
  });

  it('lets a shell export win over the config file', () => {
    process.env.NUVIRA_CAPABILITY_MODE = 'max';
    expect(resolveCapabilityMode(cm({ capabilityMode: 'balanced' }))).toBe('max');
  });

  it('accepts the legacy BUFF_ alias', () => {
    delete process.env.NUVIRA_CAPABILITY_MODE;
    process.env.BUFF_CAPABILITY_MODE = 'max';
    expect(resolveCapabilityMode()).toBe('max');
  });

  it('never throws on a broken config read', () => {
    const broken = { getAll: () => { throw new Error('boom'); } } as unknown as ConfigManager;
    delete process.env.NUVIRA_CAPABILITY_MODE;
    delete process.env.BUFF_CAPABILITY_MODE;
    expect(resolveCapabilityMode(broken)).toBe('balanced');
  });

  it('isMaxCapability mirrors the mode', () => {
    process.env.NUVIRA_CAPABILITY_MODE = 'max';
    expect(isMaxCapability()).toBe(true);
    process.env.NUVIRA_CAPABILITY_MODE = 'balanced';
    expect(isMaxCapability()).toBe(false);
  });
});

describe('capabilityRoutingPolicy', () => {
  it('balanced applies NO overrides (routing stays byte-identical)', () => {
    expect(capabilityRoutingPolicy('balanced')).toEqual({});
  });

  it('max prefers capability, always allows paid, and lifts the cost ceiling', () => {
    const policy = capabilityRoutingPolicy('max');
    expect(policy.preferenceMode).toBe('performance-first');
    expect(policy.allowPaid).toBe(true);
    expect(policy.maxCostUsd).toBeUndefined();
  });

  it('max REQUIRES a strong served model — not merely a paid one', () => {
    // The difference between "prefer capability" and "require it": a
    // cheap-but-weak model must not satisfy a mode whose promise is "the
    // strongest model".
    expect(capabilityRoutingPolicy('max').minReasoning).toBe(MAX_CAPABILITY_MIN_REASONING);
    expect(MAX_CAPABILITY_MIN_REASONING).toBeGreaterThanOrEqual(0.7);
    // …and it must be an override the resolve-options assembly can apply.
    expect(capabilityRoutingPolicy('max').minReasoning).toBeTypeOf('number');
  });

  it('balanced never sets a reasoning floor (routing stays untouched)', () => {
    expect(capabilityRoutingPolicy('balanced').minReasoning).toBeUndefined();
  });
});

describe('buildAutoResolveOptions — the policy reaches real routing options', () => {
  it('max sets the strong-model floor; balanced leaves it undefined', () => {
    delete process.env.NUVIRA_CAPABILITY_MODE;
    delete process.env.BUFF_CAPABILITY_MODE;
    const cfg = cm({});
    process.env.NUVIRA_CAPABILITY_MODE = 'max';
    expect(buildAutoResolveOptions(cfg).minReasoning).toBe(MAX_CAPABILITY_MIN_REASONING);
    process.env.NUVIRA_CAPABILITY_MODE = 'balanced';
    expect(buildAutoResolveOptions(cfg).minReasoning).toBeUndefined();
  });

  it('max only ever RAISES a configured floor — it can never weaken it', () => {
    process.env.NUVIRA_CAPABILITY_MODE = 'max';
    // A stricter configured floor wins; max must not lower it to its own value.
    expect(buildAutoResolveOptions(cm({ minReasoning: 0.9 })).minReasoning).toBe(0.9);
    // A laxer configured floor is raised to max's floor.
    expect(buildAutoResolveOptions(cm({ minReasoning: 0.4 })).minReasoning).toBe(MAX_CAPABILITY_MIN_REASONING);
  });
});
