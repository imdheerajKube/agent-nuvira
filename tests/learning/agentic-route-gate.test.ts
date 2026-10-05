/**
 * Workstream B — the shared agentic route gate.
 *
 * Governing rule: NEVER a silent weak model for an agentic task. The explicit
 * per-session ASK is the primary mechanism on interactive surfaces;
 * `routing.weakModelPolicy` is a non-interactive fallback only, so a gateway
 * turn can never hang on a consent prompt.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  assertAgenticRoute,
  getWeakModelConsent,
  parseWeakModelPolicy,
  resetWeakModelConsent,
  resolveWeakModelPolicy,
  setWeakModelConsent,
  weakRouteNotice,
  DEFAULT_WEAK_MODEL_POLICY,
  WEAK_MODEL_POLICY_ENV,
  WEAK_MODEL_POLICY_ENV_LEGACY,
} from '../../src/learning/agentic-route-gate.js';

type Decision = Parameters<typeof assertAgenticRoute>[0];

function weakDecision(over: Partial<Decision> = {}): Decision {
  return {
    complexity: 'moderate',
    // @ts-expect-error — the gate only needs intent + requiresVerification
    taskProfile: { intent: 'coding', requiresVerification: false },
    provider: 'local',
    model: 'gemma4:e4b',
    agenticCapable: false,
    ...over,
  };
}

let savedEnv: string | undefined;
let savedLegacy: string | undefined;

beforeEach(() => {
  resetWeakModelConsent();
  savedEnv = process.env[WEAK_MODEL_POLICY_ENV];
  savedLegacy = process.env[WEAK_MODEL_POLICY_ENV_LEGACY];
  delete process.env[WEAK_MODEL_POLICY_ENV];
  delete process.env[WEAK_MODEL_POLICY_ENV_LEGACY];
});

afterEach(() => {
  resetWeakModelConsent();
  if (savedEnv === undefined) delete process.env[WEAK_MODEL_POLICY_ENV];
  else process.env[WEAK_MODEL_POLICY_ENV] = savedEnv;
  if (savedLegacy === undefined) delete process.env[WEAK_MODEL_POLICY_ENV_LEGACY];
  else process.env[WEAK_MODEL_POLICY_ENV_LEGACY] = savedLegacy;
});

describe('parseWeakModelPolicy', () => {
  it('accepts the canonical values and common aliases, rejects noise', () => {
    expect(parseWeakModelPolicy('ask')).toBe('ask');
    expect(parseWeakModelPolicy('AUTO-ALLOW')).toBe('auto-allow');
    expect(parseWeakModelPolicy('allow')).toBe('auto-allow');
    expect(parseWeakModelPolicy('yes')).toBe('auto-allow');
    expect(parseWeakModelPolicy('deny')).toBe('deny');
    expect(parseWeakModelPolicy('no')).toBe('deny');
    expect(parseWeakModelPolicy('maybe')).toBeUndefined();
    expect(parseWeakModelPolicy(undefined)).toBeUndefined();
  });
});

describe('resolveWeakModelPolicy', () => {
  it('defaults to ask', () => {
    expect(resolveWeakModelPolicy()).toBe(DEFAULT_WEAK_MODEL_POLICY);
    expect(DEFAULT_WEAK_MODEL_POLICY).toBe('ask');
  });

  it('reads config, then env wins over config', () => {
    const cm = { getAll: () => ({ routing: { weakModelPolicy: 'deny' } }) };
    expect(resolveWeakModelPolicy(cm as any)).toBe('deny');
    process.env[WEAK_MODEL_POLICY_ENV] = 'auto-allow';
    expect(resolveWeakModelPolicy(cm as any)).toBe('auto-allow');
  });

  it('falls back to the default on an unknown configured value', () => {
    const cm = { getAll: () => ({ routing: { weakModelPolicy: 'nonsense' } }) };
    expect(resolveWeakModelPolicy(cm as any)).toBe('ask');
  });
});

describe('weakRouteNotice', () => {
  it('is null for a non-agentic ask and names the weak pair for an agentic one', () => {
    expect(weakRouteNotice({ provider: 'local', model: 'gemma4:e4b' }, false)).toBeNull();
    const n = weakRouteNotice({ provider: 'local', model: 'gemma4:e4b' }, true);
    expect(n).toContain('local/gemma4:e4b');
  });
});

describe('session consent store', () => {
  it('records and clears per session', () => {
    setWeakModelConsent('s1', 'granted');
    setWeakModelConsent('s2', 'denied');
    expect(getWeakModelConsent('s1')).toBe('granted');
    expect(getWeakModelConsent('s2')).toBe('denied');
    resetWeakModelConsent('s1');
    expect(getWeakModelConsent('s1')).toBeUndefined();
    expect(getWeakModelConsent('s2')).toBe('denied');
    resetWeakModelConsent();
    expect(getWeakModelConsent('s2')).toBeUndefined();
  });
});

describe('assertAgenticRoute', () => {
  it('proceeds silently when the ask is not agentic (no weak-model noise)', () => {
    const v = assertAgenticRoute(
      weakDecision({
        // @ts-expect-error minimal profile is enough for the gate
        taskProfile: { intent: 'creative', requiresVerification: false },
        complexity: 'simple',
      }),
    );
    expect(v.agentic).toBe(false);
    expect(v.weak).toBe(false);
    expect(v.action).toBe('proceed');
    expect(v.notice).toBeNull();
  });

  it('proceeds silently when an agentic ask landed on a capable model', () => {
    const v = assertAgenticRoute(
      weakDecision({ provider: 'groq', model: 'llama-3.3-70b-versatile', agenticCapable: true }),
    );
    expect(v.agentic).toBe(true);
    expect(v.weak).toBe(false);
    expect(v.action).toBe('proceed');
  });

  it('ASKS once on an interactive surface when consent is unset (the default)', () => {
    const v = assertAgenticRoute(weakDecision(), { sessionId: 's1' });
    expect(v.action).toBe('ask');
    expect(v.notice).toContain('local/gemma4:e4b');
  });

  it('proceeds on a granted consent and retries on a denied one', () => {
    setWeakModelConsent('s1', 'granted');
    expect(assertAgenticRoute(weakDecision(), { sessionId: 's1' }).action).toBe(
      'proceed-weak-consented',
    );
    setWeakModelConsent('s1', 'denied');
    expect(assertAgenticRoute(weakDecision(), { sessionId: 's1' }).action).toBe('retry-strong');
  });

  it('honors an explicit auto-allow policy without asking', () => {
    const v = assertAgenticRoute(weakDecision(), { sessionId: 's1', policy: 'auto-allow' });
    expect(v.action).toBe('proceed-weak-consented');
    expect(v.notice).not.toBeNull();
  });

  it('honors an explicit deny policy without asking', () => {
    const v = assertAgenticRoute(weakDecision(), { sessionId: 's1', policy: 'deny' });
    expect(v.action).toBe('retry-strong');
  });

  it('NEVER asks on a non-interactive surface — falls to deny/retry on the default policy', () => {
    const v = assertAgenticRoute(weakDecision(), { sessionId: 's1', interactive: false });
    expect(v.action).toBe('retry-strong');
  });

  it('proceeds on a non-interactive surface only when the policy allows it', () => {
    const v = assertAgenticRoute(weakDecision(), { policy: 'auto-allow', interactive: false });
    expect(v.action).toBe('proceed-weak-consented');
  });
});
