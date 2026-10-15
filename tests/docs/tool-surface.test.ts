/**
 * The User Manual's tool count is a claim about the LIVE registry.
 *
 * WHY THIS EXISTS. `docs/USER_MANUAL.md` said "The agent has **110 tools**" while
 * the registry had grown to 115 — five tools were added and the sentence nobody
 * re-reads kept promising the old number. That is the cheapest kind of
 * documentation lie: it is trivially checkable, so a reader who checks it once
 * stops trusting the rest of the manual.
 *
 * The count is the ONE number in that document that can be checked without
 * running anything, so it is pinned here rather than left to discipline. Both
 * places that state it are asserted (the §9 summary sentence and the
 * verification table row), because they had drifted together and would drift
 * apart next.
 *
 * `nuvira tools list` prints exactly one line per registered tool (verified
 * 2026-10-15: 115 lines for 115 registered), so the registry list is the same
 * number the documented command shows.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listTools } from '../../src/tools/registry.js';

const repoRoot = resolve(__dirname, '..', '..');
const manual = readFileSync(join(repoRoot, 'docs', 'USER_MANUAL.md'), 'utf-8');

describe('docs/USER_MANUAL.md — the tool count matches the registry', () => {
  it('§9 states the registry’s tool count', () => {
    const stated = /The agent has \*\*(\d+) tools\*\*/.exec(manual);
    expect(stated, '§9 must state the tool count ("The agent has **N tools**")').not.toBeNull();
    expect(Number(stated![1])).toBe(listTools().length);
  });

  it('the verification table agrees with §9 and with `nuvira tools list`', () => {
    const row = /\| (\d+) tools \| `nuvira tools list`/.exec(manual);
    expect(row, 'the verification table must carry the `nuvira tools list` row').not.toBeNull();
    expect(Number(row![1])).toBe(listTools().length);
  });
});
