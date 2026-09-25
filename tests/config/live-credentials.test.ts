/**
 * The credential-stripping rule has to be tested, because it is the difference
 * between a suite that measures the code and a suite that measures whoever
 * launched it.
 *
 * Live evidence, which is why these assertions are specific rather than generic:
 * the release pipeline spawns `npm test` with `~/.nuvira/.env` loaded, so the
 * suite inherited real GROQ / GEMINI / NVIDIA NIM / OPENROUTER keys and Twilio /
 * Slack / Telegram tokens. Tests conditioned on a key existing then took real
 * network paths: 7 failed files and 25 x `Test timed out in 15000ms`, against
 * 349 green in a shell without those keys.
 *
 * The release's own `GITHUB_TOKEN` is stripped too, and that is the subtler half:
 * `IssueTriageAgent.detectSource` returns `github` merely because a token EXISTS,
 * so `should detect auto when no keyword matches` failed on every release — the
 * suite was reading the operator's shell, not the code. Tests that need a token
 * set one themselves (tests/agents/credential-store.test.ts does exactly that).
 */

import { describe, it, expect } from 'vitest';
import { PROVIDER_CATALOG } from '../../src/inference/provider-catalog.js';
import {
  PROVIDER_CREDENTIAL_ENV_KEYS,
  SIDE_EFFECT_CREDENTIAL_ENV_KEYS,
  TEST_UNSAFE_ENV_KEYS,
  deleteTestUnsafeEnv,
  stripTestUnsafeEnv,
} from '../../src/config/live-credentials.js';

describe('live credentials — what a test process may not hold', () => {
  it('derives the provider keys from the catalog instead of copying them', () => {
    const catalogKeys = Object.values(PROVIDER_CATALOG)
      .map((p) => p.envVar)
      .filter((v): v is string => Boolean(v));
    for (const key of catalogKeys) {
      expect(PROVIDER_CREDENTIAL_ENV_KEYS, `${key} should be stripped`).toContain(key);
    }
    // The keys that were actually live during the failing release run.
    expect(PROVIDER_CREDENTIAL_ENV_KEYS).toContain('GROQ_API_KEY');
    expect(PROVIDER_CREDENTIAL_ENV_KEYS).toContain('GEMINI_API_KEY');
    expect(PROVIDER_CREDENTIAL_ENV_KEYS).toContain('OPENROUTER_API_KEY');
  });

  it('covers the credentials that cause an outward action, not just inference', () => {
    for (const key of ['TWILIO_AUTH_TOKEN', 'TWILIO_ACCOUNT_SID', 'SLACK_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN']) {
      expect(SIDE_EFFECT_CREDENTIAL_ENV_KEYS).toContain(key);
      expect(TEST_UNSAFE_ENV_KEYS, `${key} must reach TEST_UNSAFE_ENV_KEYS`).toContain(key);
    }
  });

  it('strips the NUVIRA_ / BUFF_ spellings too — one alias left behind is the whole leak', () => {
    expect(TEST_UNSAFE_ENV_KEYS).toContain('NUVIRA_GEMINI_API_KEY');
    expect(TEST_UNSAFE_ENV_KEYS).toContain('BUFF_GEMINI_API_KEY');
    // `TELEGRAM_TOKEN` is what `NUVIRA_TELEGRAM_TOKEN` prefixes, so both exist.
    expect(TEST_UNSAFE_ENV_KEYS).toContain('NUVIRA_TELEGRAM_TOKEN');
    expect(TEST_UNSAFE_ENV_KEYS).toContain('NUVIRA_SLACK_BOT_TOKEN');
  });

  it('strips the release\u2019s own git/npm credentials too \u2014 presence alone changes behaviour', () => {
    expect(TEST_UNSAFE_ENV_KEYS).toContain('GITHUB_TOKEN');
    expect(TEST_UNSAFE_ENV_KEYS).toContain('GH_TOKEN');
    expect(TEST_UNSAFE_ENV_KEYS).toContain('NPM_TOKEN');
  });

  it('stripTestUnsafeEnv returns a copy and never mutates the input', () => {
    const env = {
      GROQ_API_KEY: 'live-groq',
      NUVIRA_TELEGRAM_TOKEN: 'live-telegram',
      GITHUB_TOKEN: 'release-push-token',
      NPM_TOKEN: 'release-publish-token',
      NUVIRA_MEMORY_DIR: '/tmp/whatever',
      PATH: '/usr/bin',
    };

    const stripped = stripTestUnsafeEnv(env);

    expect(stripped.GROQ_API_KEY).toBeUndefined();
    expect(stripped.NUVIRA_TELEGRAM_TOKEN).toBeUndefined();
    expect(stripped.GITHUB_TOKEN).toBeUndefined();
    expect(stripped.NPM_TOKEN).toBeUndefined();
    // Not-a-credential config is untouched.
    expect(stripped.NUVIRA_MEMORY_DIR).toBe('/tmp/whatever');
    expect(stripped.PATH).toBe('/usr/bin');
    // The caller's object still has everything: the release keeps its own env.
    expect(env.GROQ_API_KEY).toBe('live-groq');
  });

  it('deleteTestUnsafeEnv removes in place and reports what was actually present', () => {
    const env: NodeJS.ProcessEnv = { GEMINI_API_KEY: 'live', PATH: '/usr/bin' };

    const removed = deleteTestUnsafeEnv(env);

    expect(removed).toEqual(['GEMINI_API_KEY']);
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    // Idempotent: a second pass has nothing left to close and says so.
    expect(deleteTestUnsafeEnv(env)).toEqual([]);
  });
});
