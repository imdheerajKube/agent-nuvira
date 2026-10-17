/**
 * THE CONTRACT OF A NAMED MODEL — a pin holds, and switching needs permission.
 *
 * Pins the fix for a real, expensive failure (2026-10-16): a run launched with
 * `-p deepseek -m deepseek-flash` had its final synthesis answered by
 * `local/deepseek-coder:latest` — a small local model — because strict mode was
 * OFF by default and the pin was treated as a preference. The paid tokens were
 * spent on DeepSeek, the report the user would trust came from a model they never
 * named, and the comparison it was part of had to be discarded.
 *
 * Three states have to stay distinct, or the fix becomes its own bug:
 *   - a NAMED pair holds (new default),
 *   - `=1` still forces the rule for an UNPINNED run,
 *   - `=0` is an explicit "substitution is allowed" for a caller that would
 *     rather deliver on a stand-in than not deliver.
 * A per-turn `withStrictModel` scope outranks all three, because that is what the
 * dashboard's per-chat switch and the CLI's own pin use.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { strictModelMode, strictPinPolicy, withStrictModel } from '../../src/inference/route-resolver.js';

const ENV_KEY = 'NUVIRA_STRICT_MODEL';
const original = process.env[ENV_KEY];

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
});

describe('strictPinPolicy — a named pair holds', () => {
  it('HOLDS when a model was named and the env is unset (the fix)', () => {
    delete process.env[ENV_KEY];
    expect(strictPinPolicy(true)).toBe(true);
  });

  it('leaves an UNPINNED run exactly as it was (no behaviour change)', () => {
    delete process.env[ENV_KEY];
    expect(strictPinPolicy(false)).toBe(false);
    // The same answer the pre-existing predicate gives, and the one every
    // unpinned path already relied on.
    expect(strictPinPolicy(false)).toBe(strictModelMode());
  });

  it('=1 forces the rule for an unpinned run as well', () => {
    process.env[ENV_KEY] = '1';
    expect(strictPinPolicy(false)).toBe(true);
    expect(strictPinPolicy(true)).toBe(true);
  });

  it('=0 is an explicit permission to substitute, even for a named pair', () => {
    process.env[ENV_KEY] = '0';
    expect(strictPinPolicy(true)).toBe(false);
    expect(strictPinPolicy(false)).toBe(false);
  });

  it('follows the documented strict-one rule: only the literal 1 means ON', () => {
    delete process.env[ENV_KEY];
    for (const value of ['true', 'yes', 'TRUE', '']) {
      process.env[ENV_KEY] = value;
      // 'true' is NOT '1' — so it reads as unset, and the pin decides.
      expect(strictPinPolicy(true)).toBe(true);
      expect(strictPinPolicy(false)).toBe(false);
      expect(strictModelMode()).toBe(false);
    }
  });
});

describe('the per-turn scope outranks the environment', () => {
  it('a scoped FALSE lets a pinned run be repaired (the dashboard switch, lock off)', () => {
    process.env[ENV_KEY] = '1';
    expect(withStrictModel(false, () => strictPinPolicy(true))).toBe(false);
  });

  it('a scoped TRUE holds a pinned run even when the env opted out', () => {
    process.env[ENV_KEY] = '0';
    expect(withStrictModel(true, () => strictPinPolicy(true))).toBe(true);
  });

  it('the scope does not leak to the next turn', () => {
    process.env[ENV_KEY] = '0';
    withStrictModel(true, () => strictPinPolicy(true));
    expect(strictPinPolicy(true)).toBe(false);
  });

  it('survives an await inside the scope (the turn is async)', async () => {
    process.env[ENV_KEY] = '0';
    const inside = await withStrictModel(true, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return strictPinPolicy(true);
    });
    expect(inside).toBe(true);
  });
});
