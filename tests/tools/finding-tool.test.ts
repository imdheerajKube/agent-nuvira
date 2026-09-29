/**
 * WS1 (#23) — `finding`: the model states the claim, the gate decides the verdict.
 *
 * The whole point of this tool is the parameter it does NOT have. A `verdict`
 * argument would let the model type "CONFIRMED", which is the false-success
 * defect this repository has shipped three times, so the tests below pin the
 * three things that make the gate real rather than decorative:
 *
 *   1. a claim with usable evidence is promoted, and the evidence travels with it;
 *   2. a claim with no usable evidence — omitted, or present but blank — is
 *      recorded PLAUSIBLE, with the refusal named in its own outcome;
 *   3. a call that records nothing at all (no claim, no outcome) FAILS, because
 *      the loop's accounting reads a non-`Error:` string as work that happened.
 *
 * The registry/core checks at the end are the reachability half: a finding tool
 * the tiered loop cannot see proves nothing.
 */

import { describe, it, expect } from 'vitest';

import {
  FINDING_TOOL_NAME,
  FINDING_EVENT,
  findingSchema,
  recordFinding,
} from '../../src/tools/finding-tool.js';
import { CORE_TOOL_NAMES, isCoreTool, toolsetForTool } from '../../src/tools/toolsets.js';
import { getTool } from '../../src/tools/registry.js';
import { evidenceOf, type WireFinding } from '../../src/findings/verdicts.js';

const EVIDENCE = { kind: 'command' as const, ref: 'npx vitest run tests/tools', detail: '42 passed' };

describe('a finding cannot be born CONFIRMED', () => {
  it('promotes a claim only when a usable evidence reference was supplied', () => {
    const result = recordFinding({
      claim: 'the tools suite is green',
      outcome: 'checked before answering',
      evidence: [EVIDENCE],
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.finding.verdict).toBe('CONFIRMED');
    expect(result.finding.evidence).toEqual([EVIDENCE]);
    // The rendered line shows the evidence, so the model reads back WHAT was
    // checked rather than only that a check happened.
    expect(result.text).toContain('✅');
    expect(result.text).toContain('npx vitest run tests/tools');
  });

  it('REFUSES the promotion for a blank reference, and says why in the outcome', () => {
    const result = recordFinding({
      claim: 'the deploy worked',
      outcome: 'reported after the fact',
      evidence: [{ kind: 'file', ref: '   ' }],
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.finding.verdict).toBe('PLAUSIBLE');
    expect(result.finding.outcome).toContain('no usable evidence');
    // The blank is DROPPED from the usable set (`evidenceOf`, the same filter
    // `toWire`/`describeFinding` use), so a renderer can never show a check that
    // did not happen.
    expect(evidenceOf(result.finding)).toEqual([]);
    expect(result.text).toContain('not verified');
  });

  it('records a claim with no evidence at all as PLAUSIBLE — an honest result, not an error', () => {
    const result = recordFinding({ claim: 'the bug is probably in the parser', outcome: 'still open' });
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.finding.verdict).toBe('PLAUSIBLE');
    expect(result.finding.evidence).toEqual([]);
  });

  it('cannot be handed a verdict: an extra `verdict` argument is ignored, never honoured', () => {
    // The bypass this pins: a caller (or a model) passing verdict=CONFIRMED
    // alongside no evidence. The zod object strips the unknown key, and the gate
    // still refuses — so the promoted verdict cannot be typed in.
    const parsed = findingSchema.parse({
      claim: 'unchecked',
      outcome: 'asserted',
      verdict: 'CONFIRMED',
    }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('verdict');
    const result = recordFinding(findingSchema.parse(parsed));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.finding.verdict).toBe('PLAUSIBLE');
  });

  it('FAILS a call that would record nothing, so the loop does not count it as work', () => {
    const noClaim = recordFinding({ claim: '  ', outcome: 'something' });
    expect('error' in noClaim).toBe(true);
    if ('error' in noClaim) expect(noClaim.error.startsWith('Error:')).toBe(true);

    const noOutcome = recordFinding({ claim: 'something', outcome: '' });
    expect('error' in noOutcome).toBe(true);
    if ('error' in noOutcome) expect(noOutcome.error.startsWith('Error:')).toBe(true);
  });
});

describe('the structured copy reaches the surface', () => {
  it('emits the WIRE form on the context bus — the shape every surface reports', () => {
    const emitted: WireFinding[] = [];
    recordFinding(
      {
        claim: 'the parity harness drives five surfaces',
        outcome: 'checked',
        evidence: [{ kind: 'observation', ref: 'all five reported the same verdict' }],
      },
      { emit: (event, data) => {
        expect(event).toBe(FINDING_EVENT);
        emitted.push(data as WireFinding);
      } },
    );
    expect(emitted).toEqual([
      {
        claim: 'the parity harness drives five surfaces',
        verdict: 'CONFIRMED',
        outcome: 'checked',
        evidence: [{ kind: 'observation', ref: 'all five reported the same verdict' }],
        source: 'agent',
      },
    ]);
  });

  it('never lets a broken listener break the tool', () => {
    const result = recordFinding(
      { claim: 'x', outcome: 'y' },
      { emit: () => {
        throw new Error('listener exploded');
      } },
    );
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.finding.claim).toBe('x');
  });
});

describe('reachability — a gate the loop cannot call proves nothing', () => {
  it('is registered', () => {
    expect(getTool(FINDING_TOOL_NAME)).toBeDefined();
  });

  it('is in the always-exposed CORE set, so the default tiered loop can call it', () => {
    // The default exposure is 'tiered' (`toolsets.ts`), which hands the model the
    // CORE schemas only. A finding tool behind `tool_search` would be exactly the
    // unreachable-capability shape this repository keeps catching.
    expect(CORE_TOOL_NAMES).toContain(FINDING_TOOL_NAME);
    expect(isCoreTool(FINDING_TOOL_NAME)).toBe(true);
  });

  it('belongs to exactly one toolset, so a toggle can gate it', () => {
    expect(toolsetForTool(FINDING_TOOL_NAME)?.name).toBe('experience');
  });
});
