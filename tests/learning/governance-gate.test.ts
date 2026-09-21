/**
 * The ADMIN GOVERNANCE GATE for paths that pick a provider themselves.
 *
 * WHY THIS EXISTS
 *
 * `autoRouter.resolve()` enforces the admin policy (provider/model allow+deny
 * lists, the PII privacy hard-gate) inside its constraint slot. Every path that
 * BYPASSES the router — an explicit `--provider` pin, the pinned fallback walk
 * in chat, `loop-executor`'s pinned pool — never consulted it. The policy was
 * therefore decorative in the worst possible way: a user could pin the very
 * provider their deny-list forbids, and a PII-classified task whose pinned
 * (compliant) provider failed would silently CONTINUE on a provider the privacy
 * policy rules out.
 *
 * These tests pin the two properties that matter:
 *   1. no policy configured → permissive (byte-for-byte unchanged behaviour), and
 *   2. a configured policy is enforced for a pinned provider×model, with a
 *      reason the user can act on.
 */

import { describe, it, expect } from 'vitest';

import { governanceVerdict, governancePolicyOf, governanceActive, isPiiTask } from '../../src/learning/auto-router.js';

/** ConfigManager-shaped stub carrying a governance policy. */
function makeConfig(governance?: unknown, providers: Record<string, unknown> = {}): any {
  return {
    getAll: () => ({ providers, routing: governance === undefined ? {} : { governance } }),
    hasRequiredCredentials: () => true,
    getProviderConfig: (p: string) => ({ type: p, config: {} }),
  };
}

describe('governanceVerdict — no policy means no restriction', () => {
  it('is permissive with no policy, an empty policy, and an unreadable config', () => {
    expect(governanceVerdict(makeConfig(), 'gemini').allowed).toBe(true);
    expect(governanceVerdict(makeConfig({}), 'gemini').allowed).toBe(true);
    expect(governanceVerdict(undefined, 'gemini').allowed).toBe(true);
    expect(governanceVerdict({ getAll: () => { throw new Error('bad config'); } } as any, 'gemini').allowed).toBe(true);
  });

  it('reports the policy shape it acts on', () => {
    expect(governancePolicyOf(makeConfig())).toBeUndefined();
    expect(governanceActive(undefined)).toBe(false);
    expect(governanceActive({})).toBe(false);
    expect(governanceActive({ denyProviders: ['gemini'] })).toBe(true);
  });
});

describe('governanceVerdict — admin allow/deny lists', () => {
  it('blocks a provider on the deny list even when it is explicitly pinned', () => {
    const config = makeConfig({ denyProviders: ['gemini'] });
    const verdict = governanceVerdict(config, 'gemini');
    expect(verdict.allowed).toBe(false);
    expect(verdict.kind).toBe('admin');
    expect(verdict.reason).toMatch(/denyProviders/);
  });

  it('blocks a provider absent from a non-empty allow list', () => {
    const config = makeConfig({ allowProviders: ['local'] });
    expect(governanceVerdict(config, 'local').allowed).toBe(true);
    const blocked = governanceVerdict(config, 'groq');
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/allowProviders/);
  });

  it('enforces model allow/deny lists against the model that would be served', () => {
    const deny = makeConfig({ denyModels: ['gemini-2.5-pro'] });
    expect(governanceVerdict(deny, 'gemini', { model: 'gemini-2.5-pro' }).allowed).toBe(false);
    expect(governanceVerdict(deny, 'gemini', { model: 'gemini-2.5-flash' }).allowed).toBe(true);

    const allow = makeConfig({ allowModels: ['gemini-2.5-flash'] });
    expect(governanceVerdict(allow, 'gemini', { model: 'gemini-2.5-pro' }).allowed).toBe(false);
    expect(governanceVerdict(allow, 'gemini', { model: 'gemini-2.5-flash' }).allowed).toBe(true);
    // An UNKNOWN model ('default' sentinel) is not second-guessed by a model
    // list — the provider-level rules are what apply.
    expect(governanceVerdict(allow, 'gemini', { model: 'default' }).allowed).toBe(true);
  });
});

describe('governanceVerdict — the PII privacy hard gate', () => {
  const config = makeConfig({ piiPatterns: ['password', 'api[_-]?key'], minPrivacyForPii: 1.0 });

  it('blocks a low-privacy cloud provider for a PII task, however it was chosen', () => {
    const verdict = governanceVerdict(config, 'gemini', { taskText: 'rotate the api_key in production' });
    expect(verdict.allowed).toBe(false);
    expect(verdict.kind).toBe('pii');
    expect(verdict.reason).toMatch(/PII-domain task/);
  });

  it('allows a fully-local provider for the same task', () => {
    // local's catalog privacy is 1.00, the default requirement.
    expect(governanceVerdict(config, 'local', { taskText: 'rotate the api_key in production' }).allowed).toBe(true);
  });

  it('leaves a non-PII task alone (the pattern must actually match)', () => {
    expect(governanceVerdict(config, 'gemini', { taskText: 'write a poem about elephants' }).allowed).toBe(true);
    expect(isPiiTask(governancePolicyOf(config), 'write a poem about elephants')).toBe(false);
    expect(isPiiTask(governancePolicyOf(config), 'rotate the API_KEY')).toBe(true);
  });

  it('ignores a malformed pattern instead of breaking routing', () => {
    const broken = makeConfig({ piiPatterns: ['[unclosed', 'password'], minPrivacyForPii: 1.0 });
    expect(governanceVerdict(broken, 'gemini', { taskText: 'my password is hunter2' }).allowed).toBe(false);
    expect(governanceVerdict(broken, 'gemini', { taskText: 'hello' }).allowed).toBe(true);
  });

  it('honours a lower privacy bar (0.5 admits mid-privacy providers)', () => {
    const relaxed = makeConfig({ piiPatterns: ['password'], minPrivacyForPii: 0.1 });
    expect(governanceVerdict(relaxed, 'gemini', { taskText: 'reset my password' }).allowed).toBe(true);
  });
});

describe('governanceVerdict — without a task text, only the static rules apply', () => {
  it('does not apply the PII gate when no task text is supplied', () => {
    const config = makeConfig({ piiPatterns: ['password'], minPrivacyForPii: 1.0 });
    expect(governanceVerdict(config, 'gemini').allowed).toBe(true);
  });
});
