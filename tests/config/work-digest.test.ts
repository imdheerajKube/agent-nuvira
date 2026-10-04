/**
 * Work-digest scope — the user control over the loop's compaction digest.
 *
 * The product decision these pin: the digest is a pure improvement, so it is ON
 * by default in every mode. But a user who wants the leanest `balanced` prompt
 * can scope it to `max`, or turn it off. The default must never regress routing
 * or the digest's own behavior for someone who sets nothing.
 */

import { describe, it, expect, afterEach } from 'vitest';

import {
  DEFAULT_WORK_DIGEST_SCOPE,
  parseWorkDigestScope,
  resolveWorkDigestScope,
  isWorkDigestEnabled,
} from '../../src/config/work-digest.js';
import type { ConfigManager } from '../../src/config/manager.js';

const ENV_NAMES = ['NUVIRA_WORK_DIGEST', 'BUFF_WORK_DIGEST', 'NUVIRA_CAPABILITY_MODE', 'BUFF_CAPABILITY_MODE'];
const backup: Record<string, string | undefined> = {};
for (const n of ENV_NAMES) backup[n] = process.env[n];

afterEach(() => {
  for (const n of ENV_NAMES) {
    if (backup[n] === undefined) delete process.env[n];
    else process.env[n] = backup[n];
  }
});

function cm(routing: Record<string, unknown>): ConfigManager {
  return { getAll: () => ({ routing }) } as unknown as ConfigManager;
}

describe('parseWorkDigestScope', () => {
  it('accepts canonical values and intuitive synonyms', () => {
    expect(parseWorkDigestScope('all')).toBe('all');
    expect(parseWorkDigestScope('always')).toBe('all');
    expect(parseWorkDigestScope('on')).toBe('all');
    expect(parseWorkDigestScope('max')).toBe('max');
    expect(parseWorkDigestScope('performance-first')).toBe('max');
    expect(parseWorkDigestScope('off')).toBe('off');
    expect(parseWorkDigestScope('none')).toBe('off');
  });

  it('returns null for empty or unrecognized values (never guesses)', () => {
    expect(parseWorkDigestScope('')).toBeNull();
    expect(parseWorkDigestScope(undefined)).toBeNull();
    expect(parseWorkDigestScope('sometimes')).toBeNull();
  });
});

describe('resolveWorkDigestScope — env, then config, then default', () => {
  it('defaults to all when nothing is set (the digest is a pure improvement)', () => {
    delete process.env.NUVIRA_WORK_DIGEST;
    delete process.env.BUFF_WORK_DIGEST;
    expect(DEFAULT_WORK_DIGEST_SCOPE).toBe('all');
    expect(resolveWorkDigestScope()).toBe('all');
    expect(resolveWorkDigestScope(cm({}))).toBe('all');
  });

  it('reads the config value when no env is set', () => {
    delete process.env.NUVIRA_WORK_DIGEST;
    delete process.env.BUFF_WORK_DIGEST;
    expect(resolveWorkDigestScope(cm({ workDigest: 'max' }))).toBe('max');
  });

  it('lets a shell export win over the config file', () => {
    process.env.NUVIRA_WORK_DIGEST = 'off';
    expect(resolveWorkDigestScope(cm({ workDigest: 'all' }))).toBe('off');
  });

  it('never throws on a broken config read', () => {
    const broken = { getAll: () => { throw new Error('boom'); } } as unknown as ConfigManager;
    delete process.env.NUVIRA_WORK_DIGEST;
    delete process.env.BUFF_WORK_DIGEST;
    expect(resolveWorkDigestScope(broken)).toBe('all');
  });
});

describe('isWorkDigestEnabled — scope folded with the capability mode', () => {
  it('all → always on; off → always off', () => {
    delete process.env.NUVIRA_CAPABILITY_MODE;
    process.env.NUVIRA_WORK_DIGEST = 'all';
    expect(isWorkDigestEnabled(cm({}))).toBe(true);
    process.env.NUVIRA_WORK_DIGEST = 'off';
    expect(isWorkDigestEnabled(cm({}))).toBe(false);
  });

  it('max → on only under the max capability mode', () => {
    process.env.NUVIRA_WORK_DIGEST = 'max';
    process.env.NUVIRA_CAPABILITY_MODE = 'balanced';
    expect(isWorkDigestEnabled(cm({}))).toBe(false);
    process.env.NUVIRA_CAPABILITY_MODE = 'max';
    expect(isWorkDigestEnabled(cm({}))).toBe(true);
  });
});
