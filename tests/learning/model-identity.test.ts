/**
 * MODEL IDENTITY (A1) — when two provider × model rows are the same model.
 *
 * The properties that matter, in the order they matter:
 *
 *   1. a DECLARED pair groups — `deepseek/deepseek-v4.1-flash` and
 *      `deepseek-flash` are one model, which is what lets a pin dead on
 *      `openrouter` point at the funded twin;
 *   2. a SIMILAR but undeclared pair does NOT group — `deepseek-v4-flash` and
 *      `deepseek-v4.1-flash` are different models, and no amount of string
 *      similarity may join them;
 *   3. an id in no declaration still gets the exact/bare-id rule, so the table
 *      can only ever fail toward "unknown", never toward a wrong grouping;
 *   4. the table itself is CONSISTENT — a member in two entries would make
 *      identity depend on entry order, which is exactly the kind of silent
 *      divergence this programme exists to remove.
 */

import { describe, it, expect } from 'vitest';
import {
  DECLARED_MODEL_ALIASES,
  declaredAliasFor,
  identityKey,
  identityProvenance,
  sameModel,
} from '../../src/learning/model-identity.js';

describe('identityKey — declared aliases widen the bare-id rule', () => {
  it('groups the DECLARED pair that the registry could not previously relate', () => {
    // The measured rows: `openrouter|deepseek/deepseek-v4.1-flash` (credit-
    // exhausted) beside `deepseek|deepseek-flash` (verified). Before A1 nothing
    // could say these are one model.
    expect(identityKey('deepseek/deepseek-v4.1-flash')).toBe(identityKey('deepseek-flash'));
    expect(sameModel('deepseek/deepseek-v4.1-flash', 'deepseek-flash')).toBe(true);
  });

  it('groups a declared member regardless of the vendor prefix or the `~` alias marker', () => {
    expect(identityKey('~deepseek/deepseek-flash')).toBe(identityKey('deepseek-flash'));
    expect(identityKey('DEEPSEEK-FLASH')).toBe(identityKey('deepseek-flash'));
    expect(identityKey('  deepseek/deepseek-v4.1-flash  ')).toBe(identityKey('deepseek-flash'));
  });

  it('does NOT group similar-but-undeclared ids', () => {
    // Both DeepSeek, both "flash", one version apart — and deliberately NOT the
    // same model. This is the assertion that keeps the table from becoming a
    // family guess.
    expect(sameModel('deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4.1-flash')).toBe(false);
    expect(sameModel('deepseek-v4-flash', 'deepseek-flash')).toBe(false);
    // Sanity: the same shape WITHOUT a declaration is still related by bare id.
    expect(sameModel('vendor/some-model', 'some-model')).toBe(true);
  });

  it('never claims two empty ids are the same model', () => {
    expect(identityKey('')).toBe('');
    expect(identityKey(undefined)).toBe('');
    expect(identityKey(null)).toBe('');
    expect(sameModel('', '')).toBe(false);
    expect(sameModel(undefined, 'deepseek-flash')).toBe(false);
  });

  it('keeps ids that are not declared on the exact/bare-id rule', () => {
    expect(identityKey('llama-3.3-70b-versatile')).toBe('bare:llama-3.3-70b-versatile');
    expect(identityKey('openrouter/meta-llama/llama-3.1-8b-instruct')).toBe('bare:llama-3.1-8b-instruct');
    // A canonical group can never collide with a bare id that merely reads the same.
    expect(identityKey('deepseek-flash')).not.toBe(identityKey('deepseek-v4.1-flash').replace('canonical:', 'bare:'));
  });
});

describe('provenance — a declared grouping says so', () => {
  it('names the entry and the date for a declared id', () => {
    const alias = declaredAliasFor('deepseek/deepseek-v4.1-flash');
    expect(alias?.canonical).toBe('deepseek-v4.1-flash');
    expect(alias?.declaredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(identityProvenance('deepseek-flash')).toContain('declared alias');
  });

  it('returns nothing for an id no entry declares', () => {
    expect(declaredAliasFor('llama-3.3-70b-versatile')).toBeUndefined();
    expect(identityProvenance('llama-3.3-70b-versatile')).toBeUndefined();
    expect(identityProvenance(undefined)).toBeUndefined();
  });
});

describe('the declared table is consistent', () => {
  it('never puts one member in two entries', () => {
    // Two entries sharing a member would make `identityKey` return whichever came
    // first in the file — an order-dependent identity, which is a silent wrong
    // answer for everyone after the reorder.
    const seen = new Map<string, string>();
    for (const alias of DECLARED_MODEL_ALIASES) {
      for (const id of [alias.canonical, ...alias.members]) {
        const key = id.trim().toLowerCase();
        const owner = seen.get(key);
        expect(owner === undefined || owner === alias.canonical, `${key} declared in ${owner} and ${alias.canonical}`).toBe(true);
        seen.set(key, alias.canonical);
      }
    }
  });

  it('gives every entry a canonical id, a basis and a date', () => {
    for (const alias of DECLARED_MODEL_ALIASES) {
      expect(alias.canonical.trim(), alias.canonical).not.toBe('');
      expect(alias.members.length, alias.canonical).toBeGreaterThan(0);
      expect(alias.declaredAt, alias.canonical).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(alias.note.trim().length, alias.canonical).toBeGreaterThan(20);
    }
  });
});
