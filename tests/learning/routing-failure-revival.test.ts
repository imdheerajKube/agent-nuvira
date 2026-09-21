/**
 * Cross-pipeline ROUTING FAILURE records — they must expire, and they must die
 * with the credential that earned them.
 *
 * WHY THIS EXISTS
 *
 * `nuvira-routing-failures.json` is the router's memory across processes: a
 * provider (or one provider×model) that failed is skipped next time so the user
 * does not pay the same timeout twice. It got that wrong in the one direction
 * that is invisible until it bites:
 *
 *   - an `auth` failure was recorded with `Number.MAX_SAFE_INTEGER` as its
 *     lifetime ("the key is dead, skip it always"), so the record never expired.
 *     The loader prunes only entries whose `expiresAt` has passed, so ONE 401 —
 *     a key that was missing during setup, rotated, or misclassified — excluded
 *     that provider in every future process. Fixing the key did not bring the
 *     provider back, and nothing surfaced WHY it was being skipped. Live
 *     evidence on disk 2026-09-21: `deepinfra → kind: auth`.
 *   - the record carried no link to the credential it was earned with, so a
 *     changed key could not invalidate it.
 *
 * The exclusions now (1) live for a bounded window, (2) are dropped the moment
 * the provider's credential fingerprint changes, and (3) re-anchor legacy
 * forever-records to the bounded window so an upgrade heals existing state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFailoverExclusionFilter, credentialFingerprint } from '../../src/learning/resilient-call.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';

const FAILURE_FILE = 'nuvira-routing-failures.json';

let tempDir: string;
let originalConfigDir: string | undefined;

/** A ConfigManager-shaped stub whose credential set is the test's. */
function makeConfig(apiKey: string | undefined): any {
  return {
    getAll: () => ({ providers: {} }),
    hasRequiredCredentials: () => !!apiKey,
    getProviderConfig: (provider: string) => ({
      type: provider,
      config: apiKey === undefined ? {} : { apiKey },
    }),
  };
}

/** Write a routing-failures file into the isolated config dir. */
function writeFailures(data: Record<string, unknown>): void {
  writeFileSync(join(tempDir, FAILURE_FILE), JSON.stringify(data, null, 2));
}

function readFailures(): Record<string, { expiresAt: number; credentialFingerprint?: string }> {
  return JSON.parse(readFileSync(join(tempDir, FAILURE_FILE), 'utf-8'));
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-routing-failures-'));
  originalConfigDir = process.env.NUVIRA_CONFIG_DIR;
  process.env.NUVIRA_CONFIG_DIR = tempDir;
  resetModelRegistry();
});

afterEach(() => {
  resetModelRegistry();
  if (originalConfigDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = originalConfigDir;
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── The credential fingerprint ─────────────────────────────────────────────

describe('credentialFingerprint', () => {
  it('is stable while the key is unchanged and differs once it changes', () => {
    const a = credentialFingerprint(makeConfig('sk-aaa'), 'gemini');
    const againA = credentialFingerprint(makeConfig('sk-aaa'), 'gemini');
    const b = credentialFingerprint(makeConfig('sk-bbb'), 'gemini');

    expect(a).toBeDefined();
    expect(againA).toBe(a);
    expect(b).not.toBe(a);
  });

  it('never contains the secret, and is undefined without credential material', () => {
    const fp = credentialFingerprint(makeConfig('sk-super-secret-value'), 'gemini')!;
    expect(fp).not.toContain('sk-super-secret-value');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(credentialFingerprint(makeConfig(undefined), 'gemini')).toBeUndefined();
    expect(credentialFingerprint(undefined, 'gemini')).toBeUndefined();
  });

  it('is per-provider, so two providers on one key do not share a fingerprint', () => {
    const gemini = credentialFingerprint(makeConfig('sk-aaa'), 'gemini');
    const groq = credentialFingerprint(makeConfig('sk-aaa'), 'groq');
    expect(gemini).not.toBe(groq);
  });
});

// ─── Legacy forever-records heal on load ────────────────────────────────────

describe('routing-failure records — the MAX_SAFE_INTEGER auth record', () => {
  it('does NOT exclude a provider forever (legacy record is re-anchored and pruned)', () => {
    const day = 24 * 60 * 60_000;
    writeFailures({
      deepinfra: {
        expiresAt: Date.now() + Number.MAX_SAFE_INTEGER,
        kind: 'auth',
        recordedAt: Date.now() - 8 * day, // 8 days ago — a bounded window has lapsed
      },
    });

    const isExcluded = createFailoverExclusionFilter();

    expect(isExcluded('deepinfra')).toBe(false);
  });

  it('keeps a legacy record alive until its bounded window has actually passed', () => {
    writeFailures({
      gemini: {
        expiresAt: Date.now() + Number.MAX_SAFE_INTEGER,
        kind: 'auth',
        recordedAt: Date.now() - 60_000, // one minute ago — still inside the window
      },
    });

    expect(createFailoverExclusionFilter()('gemini')).toBe(true);
  });

  it('honors a normal, in-window cooldown and drops an expired one', () => {
    writeFailures({
      groq: { expiresAt: Date.now() + 30 * 60_000, kind: 'rate-limit', recordedAt: Date.now() },
      nim: { expiresAt: Date.now() - 1000, kind: 'timeout', recordedAt: Date.now() - 40_000 },
    });

    const isExcluded = createFailoverExclusionFilter();

    expect(isExcluded('groq')).toBe(true);
    expect(isExcluded('nim')).toBe(false);
  });
});

// ─── A changed credential invalidates what the old one earned ───────────────

describe('routing-failure records — key rotation', () => {
  it('ignores a persisted exclusion recorded against a DIFFERENT credential', () => {
    const oldFingerprint = credentialFingerprint(makeConfig('sk-old'), 'gemini')!;
    writeFailures({
      gemini: { expiresAt: Date.now() + 30 * 60_000, kind: 'auth', recordedAt: Date.now(), credentialFingerprint: oldFingerprint },
    });

    // The user rotated / repaired the key: the 401 said nothing about this one.
    const isExcluded = createFailoverExclusionFilter({
      credentialFingerprint: (provider) => credentialFingerprint(makeConfig('sk-new'), provider),
    });

    expect(isExcluded('gemini')).toBe(false);
  });

  it('still honors the exclusion when the credential is unchanged', () => {
    const fingerprint = credentialFingerprint(makeConfig('sk-same'), 'gemini')!;
    writeFailures({
      gemini: { expiresAt: Date.now() + 30 * 60_000, kind: 'auth', recordedAt: Date.now(), credentialFingerprint: fingerprint },
    });

    const isExcluded = createFailoverExclusionFilter({
      credentialFingerprint: (provider) => credentialFingerprint(makeConfig('sk-same'), provider),
    });

    expect(isExcluded('gemini')).toBe(true);
  });

  it('is model-scoped: a rotated key does not take the provider-wide path with it', () => {
    const old = credentialFingerprint(makeConfig('sk-old'), 'groq')!;
    writeFailures({
      'groq|llama-3.3-70b-versatile': {
        expiresAt: Date.now() + 30 * 60_000,
        kind: 'rate-limit',
        recordedAt: Date.now(),
        credentialFingerprint: old,
      },
    });

    const isExcluded = createFailoverExclusionFilter({
      credentialFingerprint: (provider) => credentialFingerprint(makeConfig('sk-new'), provider),
    });

    expect(isExcluded('groq', 'llama-3.3-70b-versatile')).toBe(false);
    expect(isExcluded('groq', 'openai/gpt-oss-120b')).toBe(false);
  });

  it('leaves the file on disk untouched (revival is a READ-side decision)', () => {
    const day = 24 * 60 * 60_000;
    writeFailures({
      deepinfra: { expiresAt: Date.now() + Number.MAX_SAFE_INTEGER, kind: 'auth', recordedAt: Date.now() - 8 * day },
      groq: { expiresAt: Date.now() + 30 * 60_000, kind: 'rate-limit', recordedAt: Date.now() },
    });

    createFailoverExclusionFilter();

    // A load is not a write: nothing else may race on the file.
    const onDisk = readFailures();
    expect(onDisk.deepinfra).toBeDefined();
    expect(onDisk.groq).toBeDefined();
    expect(existsSync(join(tempDir, FAILURE_FILE))).toBe(true);
  });
});

// ─── The regression that started this ──────────────────────────────────────

describe('the live 2026-09-21 state (deepinfra auth, no fingerprint)', () => {
  it('does not keep a provider out of routing with no way back', () => {
    const spy = vi.fn();
    writeFailures({
      deepinfra: { expiresAt: 9008988551510452, kind: 'auth', recordedAt: 1789296769460 },
    });

    const isExcluded = createFailoverExclusionFilter({ credentialFingerprint: spy });

    // The record is 8+ days old: its bounded window lapsed, so the provider is
    // routable again even though the old policy promised "never".
    expect(isExcluded('deepinfra')).toBe(false);
    expect(spy).not.toHaveBeenCalled(); // pruned before any fingerprint work
  });
});
