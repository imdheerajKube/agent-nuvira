/**
 * Golden provider-wire fixtures — the request-side drift guard.
 *
 * Every other test in this repo asserts on a RESPONSE (what the engine did).
 * This one asserts on the REQUEST — the exact bytes the core loop puts on the
 * provider wire: model, messages (in order), tool schemas (in order),
 * temperature, max_tokens. That is the class of change that otherwise lands
 * silently (a tool schema edited, a message-ordering rule changed), because
 * nothing else looks at the outbound shape.
 *
 * The capture runs the REAL loop against the REAL Groq adapter pointed at a
 * loopback recorder — no network, no model, no test seam in production code.
 *
 * When the wire legitimately changes, regenerate with:
 *   npm run docs:wire:update      (or: node scripts/check-provider-wire.mjs --update)
 * and review the diff — that review IS the guard.
 */

import { describe, it, expect } from 'vitest';

import {
  captureCoreLoopRequests,
  listWireFixtures,
  readWireFixture,
  wireDiff,
} from '../../src/parity/wire-fixtures.js';

describe('golden provider-wire fixtures', () => {
  it('has committed fixtures to check against', () => {
    const cases = listWireFixtures();
    expect(cases.length).toBeGreaterThan(0);
    expect(cases).toContain('tool-call-roundtrip');
    expect(cases).toContain('plain-turn');
  });

  it('the core loop still sends the recorded wire shape', async () => {
    const captured = await captureCoreLoopRequests();
    expect(captured.length).toBeGreaterThan(0);

    const problems: string[] = [];
    for (const actual of captured) {
      const golden = readWireFixture(actual.case);
      if (!golden) {
        problems.push(`  ${actual.case}: no committed fixture — run npm run docs:wire:update`);
        continue;
      }
      const diffs = wireDiff(golden.requests, actual.requests);
      if (diffs.length > 0) {
        problems.push(
          `  ${actual.case}: ${diffs.length} wire difference(s):\n` +
            diffs
              .slice(0, 10)
              .map(
                (d) =>
                  `    ${d.path}\n      golden: ${JSON.stringify(d.golden)}\n      actual: ${JSON.stringify(d.actual)}`,
              )
              .join('\n'),
        );
      }
    }

    expect(
      problems,
      `The provider wire drifted from the recorded fixtures:\n${problems.join('\n')}\n\n` +
        'If the change is intended, run `npm run docs:wire:update` and review the diff.',
    ).toEqual([]);
  });
});
