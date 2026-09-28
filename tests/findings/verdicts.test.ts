/**
 * WS1 (#23) — the findings model and its gate.
 *
 * The gate is the whole point, so it is tested the way a gate has to be: a
 * refusal is asserted as loudly as a promotion. A `CONFIRMED` verdict that can
 * be obtained without evidence is not a weaker version of this feature — it is
 * the false-success defect this repository has already shipped three times, with
 * a nicer name.
 */

import { describe, it, expect } from 'vitest';

import {
  confirmFinding,
  demoteFinding,
  describeFinding,
  enforceVerdicts,
  evidenceOf,
  fromWire,
  hasEvidence,
  plausibleFinding,
  summarizeVerdicts,
  toWire,
  unsupportedConfirmations,
  type Finding,
} from '../../src/findings/verdicts.js';

/** A finding that has been checked: a command whose real output backs the claim. */
const CHECKED = { kind: 'command' as const, ref: 'npx vitest run tests/parity', detail: '3 files passed' };

function claim(over: Partial<Finding> = {}): Finding {
  return { ...plausibleFinding({ claim: 'the parity suite covers all five surfaces', outcome: 'reported', source: 'test' }), ...over };
}

describe('a finding cannot be born confirmed', () => {
  it('starts PLAUSIBLE with the claim, outcome and source it was given', () => {
    const finding = plausibleFinding({
      claim: 'the gateway records each tool call',
      outcome: 'reported to the operator',
      source: 'review',
    });

    expect(finding.verdict).toBe('PLAUSIBLE');
    expect(finding.claim).toBe('the gateway records each tool call');
    expect(finding.outcome).toBe('reported to the operator');
    expect(finding.source).toBe('review');
    expect(finding.evidence).toEqual([]);
    expect(hasEvidence(finding)).toBe(false);
  });

  it('keeps evidence handed to the constructor without promoting itself', () => {
    // Evidence and the decision to promote are separate acts on purpose: a
    // constructor that promoted on sight would collapse "what we checked" into
    // "what we concluded" and leave nothing to audit.
    const finding = plausibleFinding({
      claim: 'x',
      outcome: 'y',
      source: 'test',
      evidence: [CHECKED],
    });
    expect(finding.verdict).toBe('PLAUSIBLE');
    expect(hasEvidence(finding)).toBe(true);
  });
});

describe('promotion requires evidence', () => {
  it('REFUSES to promote a finding with no evidence, and says why', () => {
    const result = confirmFinding(claim());
    expect(result.promoted).toBe(false);
    expect(result.finding.verdict).toBe('PLAUSIBLE');
    expect(result.reason).toContain('no usable evidence');
    // The refusal is a normal outcome, not an exception: the turn that asked
    // must survive a probe that could not check anything.
    expect(result.finding.claim).toBe(claim().claim);
  });

  it('REFUSES evidence whose reference is blank — a satisfied type is not a check', () => {
    // The hole this closes: `evidence: [{ kind: 'file', ref: ' ' }]` type-checks,
    // reads as evidence in a diff, and records nothing that was checked.
    const result = confirmFinding(claim(), [{ kind: 'file', ref: '   ' }]);
    expect(result.promoted).toBe(false);
    expect(result.finding.verdict).toBe('PLAUSIBLE');
  });

  it('promotes once real evidence is supplied, and records the outcome it earned', () => {
    const result = confirmFinding(claim(), [CHECKED], { outcome: 'verified by running it' });
    expect(result.promoted).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.finding.verdict).toBe('CONFIRMED');
    expect(result.finding.outcome).toBe('verified by running it');
    expect(result.finding.evidence).toEqual([CHECKED]);
    expect(hasEvidence(result.finding)).toBe(true);
  });

  it('does not promote a second time, and says the verdict is already recorded', () => {
    const promoted = confirmFinding(claim(), [CHECKED]).finding;
    const again = confirmFinding(promoted, [CHECKED]);
    expect(again.promoted).toBe(false);
    expect(again.finding.verdict).toBe('CONFIRMED');
    expect(again.reason).toContain('already CONFIRMED');
  });

  it('drops blank evidence from the usable set, so a renderer never shows it', () => {
    const finding: Finding = claim({ evidence: [{ kind: 'file', ref: '' }, CHECKED] });
    expect(evidenceOf(finding)).toEqual([CHECKED]);
  });
});

describe('the gate is enforced on the way OUT, not just at the door', () => {
  it('demotes a hand-assembled CONFIRMED finding with no evidence, and names it', () => {
    // This is the case the door cannot catch: a finding built as a literal by a
    // module that never called `confirmFinding` — the false-success shape.
    const forged: Finding = {
      claim: 'every surface reports the verdict',
      verdict: 'CONFIRMED',
      outcome: 'reported',
      evidence: [],
      source: 'somewhere-else',
    };

    const { findings, demoted } = enforceVerdicts([forged]);
    expect(findings[0]!.verdict).toBe('PLAUSIBLE');
    expect(findings[0]!.outcome).toContain('not promoted: no usable evidence');
    // Named, not silently repaired: the demotion is correct behaviour, and its
    // cause is still a wiring bug a caller should see.
    expect(demoted).toEqual(['every surface reports the verdict']);
  });

  it('leaves a properly confirmed finding alone', () => {
    const confirmed = confirmFinding(claim(), [CHECKED]).finding;
    const { findings, demoted } = enforceVerdicts([confirmed, claim()]);
    expect(findings[0]).toEqual(confirmed);
    expect(findings[1]!.verdict).toBe('PLAUSIBLE');
    expect(demoted).toEqual([]);
  });

  it('reports the claims that would be unverifiable, for a caller that would rather fail', () => {
    const forged: Finding = claim({ claim: 'unchecked', verdict: 'CONFIRMED' });
    expect(unsupportedConfirmations([forged, claim()])).toEqual(['unchecked']);
  });
});

describe('the wire form is what makes five surfaces comparable', () => {
  it('reflects a demotion back, so a reader does not have to trust the producer', () => {
    const wire = {
      claim: 'the child reported the triple',
      verdict: 'CONFIRMED' as const,
      outcome: 'reported',
      evidence: [],
      source: 'subagent',
    };
    const read = fromWire(wire);
    expect(read?.verdict).toBe('PLAUSIBLE');
  });

  it('round-trips a real finding', () => {
    const confirmed = confirmFinding(claim(), [CHECKED], { outcome: 'verified' }).finding;
    expect(fromWire(toWire(confirmed))).toEqual(confirmed);
  });

  it('leaves timing out of the wire form, because it differs on every invocation', () => {
    // Same reason `observation.ts` keeps identity and timing out of the compared
    // projection: a field that changes every run cannot be part of a comparison
    // between surfaces that behaved identically.
    const confirmed = confirmFinding(claim(), [CHECKED], { at: Date.now() }).finding;
    expect(confirmed.at).toBeDefined();
    expect(toWire(confirmed)).not.toHaveProperty('at');
  });

  it('refuses to read a malformed payload rather than guessing at it', () => {
    expect(fromWire(undefined)).toBeUndefined();
    expect(fromWire({ claim: 'x' })).toBeUndefined();
    expect(fromWire({ claim: 'x', verdict: 'LIKELY', outcome: 'y', source: 'z' })).toBeUndefined();
    expect(fromWire({ claim: '   ', verdict: 'PLAUSIBLE', outcome: 'y', source: 'z' })).toBeUndefined();
  });

  it('drops evidence of an unknown kind instead of carrying it through', () => {
    const read = fromWire({
      claim: 'x',
      verdict: 'PLAUSIBLE',
      outcome: 'y',
      source: 'z',
      evidence: [{ kind: 'vibes', ref: 'it felt right' }, CHECKED],
    });
    expect(read?.evidence).toEqual([CHECKED]);
  });
});

describe('rendering', () => {
  it('shows the evidence behind a CONFIRMED verdict', () => {
    const text = describeFinding(confirmFinding(claim(), [CHECKED], { outcome: 'verified' }).finding);
    expect(text).toContain('✅');
    expect(text).toContain('ran npx vitest run tests/parity');
    expect(text).toContain('verified');
  });

  it('says out loud that a PLAUSIBLE finding is unverified', () => {
    // The line a report must never omit: an unchecked claim that renders like a
    // checked one is the whole defect.
    const text = describeFinding(claim());
    expect(text).toContain('🔎');
    expect(text).toContain('no evidence — reported as PLAUSIBLE, not verified.');
  });

  it('never reports a total without the confirmed/plausible split', () => {
    const confirmed = confirmFinding(claim(), [CHECKED]).finding;
    expect(summarizeVerdicts([confirmed, claim(), claim()])).toBe('3 finding(s): 1 confirmed, 2 plausible');
  });

  it('demotes a finding with a reason attached, and leaves a PLAUSIBLE one untouched', () => {
    const confirmed = confirmFinding(claim(), [CHECKED]).finding;
    const demoted = demoteFinding(confirmed, 'the evidence was withdrawn');
    expect(demoted.verdict).toBe('PLAUSIBLE');
    expect(demoted.outcome).toContain('the evidence was withdrawn');
    expect(demoteFinding(demoted, 'again')).toEqual(demoted);
  });
});
