/**
 * The built-in floor's human summary must not describe a floor that has moved.
 *
 * `BUILT_IN_DENY_SUMMARY` is what `nuvira config policy list` and the dashboard
 * page show. If a rule is renamed, narrowed or removed in `run-terminal.ts`, the
 * summary would keep advertising a refusal that no longer happens (or name the
 * wrong rule) — this test walks every example through the REAL classifier.
 */

import { describe, it, expect } from 'vitest';
import { BUILT_IN_DENY_SUMMARY, describeDenial } from '../../src/tools/run-terminal.js';

describe('built-in deny summary', () => {
  it('has an example for every advertised rule', () => {
    expect(BUILT_IN_DENY_SUMMARY.length).toBeGreaterThanOrEqual(6);
    for (const entry of BUILT_IN_DENY_SUMMARY) {
      expect(entry.rule.trim()).not.toBe('');
      expect(entry.example.trim()).not.toBe('');
    }
  });

  it('every example is refused, by the rule the summary names', () => {
    for (const entry of BUILT_IN_DENY_SUMMARY) {
      expect(describeDenial(entry.example), entry.example).toBe(entry.rule);
    }
  });
});
