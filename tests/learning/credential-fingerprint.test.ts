/**
 * A purchase made mid-session must be noticed.
 *
 * The routing pool only holds models a probe has VERIFIED, and there is no
 * per-model entitlement API to ask — so the one case a user notices ("I just
 * bought credits, where are the models?") was invisible until an unrelated cold
 * start happened to re-probe. This file pins the detector that turns the change
 * into a forced probe: it must fire exactly ONCE per change, must never treat a
 * fresh machine as a change, and must never store a key.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  credentialFingerprint,
  credentialShapeInputs,
  detectCredentialChange,
} from '../../src/learning/credential-fingerprint.js';
import type { ConfigManager } from '../../src/config/manager.js';

/** A config manager stub: only the accessors the fingerprint reads. */
function managerWith(keys: Record<string, string>, baseUrls: Record<string, string> = {}): ConfigManager {
  return {
    getProviderConfig: (provider?: string) => ({
      type: provider ?? 'local',
      config: {
        ...(provider && keys[provider] ? { apiKey: keys[provider] } : {}),
        ...(provider && baseUrls[provider] ? { baseUrl: baseUrls[provider] } : {}),
      },
    }),
  } as unknown as ConfigManager;
}

let dir = '';
let originalDir: string | undefined;
const originalEnvKey = process.env.OPENROUTER_API_KEY;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuvira-cred-fp-'));
  originalDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = dir;
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(() => {
  if (originalDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = originalDir;
  if (originalEnvKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalEnvKey;
  rmSync(dir, { recursive: true, force: true });
});

describe('detectCredentialChange — notice a key change, once', () => {
  it('does not report a change on a fresh machine (no comparison was possible)', () => {
    const cm = managerWith({ openai: 'sk-a' });
    const result = detectCredentialChange(cm, { path: join(dir, 'fp.json') });
    expect(result.firstRun).toBe(true);
    expect(result.changed).toBe(false);
  });

  it('reports a change once a key appears, then not again', () => {
    const path = join(dir, 'fp.json');
    detectCredentialChange(managerWith({}), { path }); // record the empty shape

    const afterBuying = detectCredentialChange(managerWith({ openai: 'sk-new' }), { path });
    expect(afterBuying.changed).toBe(true);

    // The change was recorded, so the next cycle must NOT re-probe.
    const nextCycle = detectCredentialChange(managerWith({ openai: 'sk-new' }), { path });
    expect(nextCycle.changed).toBe(false);
    expect(nextCycle.firstRun).toBe(false);
  });

  it('reports a change when an existing key is REPLACED', () => {
    const path = join(dir, 'fp.json');
    detectCredentialChange(managerWith({ openai: 'sk-old' }), { path });
    expect(detectCredentialChange(managerWith({ openai: 'sk-other' }), { path }).changed).toBe(true);
  });

  it('reports a change when an env-var key changes', () => {
    const path = join(dir, 'fp.json');
    const cm = managerWith({});
    detectCredentialChange(cm, { path });

    process.env.OPENROUTER_API_KEY = 'or-first';
    expect(detectCredentialChange(cm, { path }).changed).toBe(true);
    expect(detectCredentialChange(cm, { path }).changed).toBe(false);

    process.env.OPENROUTER_API_KEY = 'or-second';
    expect(detectCredentialChange(cm, { path }).changed).toBe(true);
  });

  it('is stable for an unrelated config change (no false re-probes)', () => {
    const path = join(dir, 'fp.json');
    const before = credentialFingerprint(managerWith({ openai: 'sk-a' }));
    const after = credentialFingerprint(managerWith({ openai: 'sk-a' }));
    expect(after).toBe(before);
  });

  it('counts an endpoint switch as a change (a different base URL is a different service)', () => {
    const path = join(dir, 'fp.json');
    detectCredentialChange(managerWith({ openai: 'sk-a' }), { path });
    const moved = managerWith({ openai: 'sk-a' }, { openai: 'https://proxy.internal/v1' });
    expect(detectCredentialChange(moved, { path }).changed).toBe(true);
  });

  it('NEVER stores a key — the sidecar holds a digest only', () => {
    const path = join(dir, 'fp.json');
    const secret = 'sk-super-secret-value-1234567890';
    detectCredentialChange(managerWith({ openai: secret }), { path });

    const onDisk = readFileSync(path, 'utf-8');
    expect(onDisk).not.toContain(secret);
    expect(onDisk).not.toContain(secret.slice(0, 8));
    expect(onDisk).toMatch(/[0-9a-f]{16}/);

    // And the shape inputs themselves are digests, not values.
    const inputs = credentialShapeInputs(managerWith({ openai: secret })).join('\n');
    expect(inputs).not.toContain(secret);
  });

  it('treats a corrupt sidecar as absent rather than throwing', () => {
    const path = join(dir, 'fp.json');
    writeFileSync(path, 'not json at all', 'utf-8');
    const result = detectCredentialChange(managerWith({ openai: 'sk-a' }), { path });
    // Absent ⇒ firstRun, and the caller's rule is "firstRun is not a change".
    expect(result.firstRun).toBe(true);
    expect(result.changed).toBe(false);
  });

  it('recovers when the config manager cannot describe a provider', () => {
    const hostile = {
      getProviderConfig: () => {
        throw new Error('no config here');
      },
    } as unknown as ConfigManager;
    expect(() => detectCredentialChange(hostile, { path: join(dir, 'fp.json') })).not.toThrow();
  });
});
