/**
 * WS1/A3 — evidence PROVENANCE, not merely presence.
 *
 * `confirmFinding` promotes on a non-blank reference; that is necessary and not
 * sufficient. A model that cannot type `CONFIRMED` can still type a `command`
 * ref for a command it never ran and have the finding recorded as fact. Found
 * live: a turn whose build FAILED (exit 1) recorded a `CONFIRMED` finding citing
 * `pyinstaller --clean -y AukatCheck.spec` — a command that appears nowhere in
 * the run. See `docs/ISSUE_false-success_model-vs-framework.md`.
 *
 * These tests pin the gate (`enforceEvidenceProvenance`), the tool that now
 * applies it (`recordFinding` with a ledger), and the wiring that makes the
 * ledger real (the tool loop appends every executed call to the shared context
 * the `finding` tool receives).
 */

import { describe, it, expect } from 'vitest';

import {
  confirmFinding,
  describeFinding,
  enforceEvidenceProvenance,
  evidenceOf,
  plausibleFinding,
  type ExecutedAction,
  type Finding,
} from '../../src/findings/verdicts.js';
import { recordFinding } from '../../src/tools/finding-tool.js';
import { getTool, type ToolContext } from '../../src/tools/registry.js';
import { runToolLoop, type StepResponse } from '../../src/tools/tool-loop.js';

/** A finding born CONFIRMED off a `command` reference. */
function confirmed(ref: string, over: Partial<Finding> = {}): Finding {
  return {
    ...confirmFinding(
      plausibleFinding({ claim: 'the app was rebuilt and launches without crashing', outcome: 'verified', source: 'agent' }),
      [{ kind: 'command', ref, detail: 'assumed output' }],
      { outcome: 'verified' },
    ).finding,
    ...over,
  };
}

/** The action ledger a turn would produce for a command that really ran. */
function ran(command: string): ExecutedAction[] {
  return [{ tool: 'run_terminal', command, ok: false }];
}

describe('enforceEvidenceProvenance — a citation must correspond to something the turn did', () => {
  it('demotes a CONFIRMED finding whose only evidence never happened', () => {
    const result = enforceEvidenceProvenance(confirmed('pyinstaller --clean -y AukatCheck.spec'), ran('pyinstaller AukatCheck.spec'));
    expect(result.demoted).toBe(true);
    expect(result.finding.verdict).toBe('PLAUSIBLE');
    expect(result.finding.outcome).toContain('evidence not corroborated');
    expect(result.unproven[0]?.ref).toBe('pyinstaller --clean -y AukatCheck.spec');
    // The fabricated reference is DROPPED, so no renderer can show a check that
    // did not happen.
    expect(evidenceOf(result.finding)).toEqual([]);
    expect(describeFinding(result.finding)).toContain('not verified');
  });

  it('keeps a CONFIRMED finding whose cited command really ran (even if it failed)', () => {
    // Provenance is about whether the command HAPPENED, not whether it
    // succeeded — a failing command is real evidence about a failure.
    const result = enforceEvidenceProvenance(confirmed('npx vitest run tests/tools'), ran('npx vitest run tests/tools'));
    expect(result.demoted).toBe(false);
    expect(result.finding.verdict).toBe('CONFIRMED');
    expect(result.unproven).toEqual([]);
  });

  it('tolerates formatting but not a different command', () => {
    expect(enforceEvidenceProvenance(confirmed('$  npx   vitest run tests/tools'), ran('npx vitest run tests/tools')).demoted).toBe(false);
    expect(enforceEvidenceProvenance(confirmed('`npx vitest run tests/tools`'), ran('npx vitest run tests/tools')).demoted).toBe(false);
    expect(enforceEvidenceProvenance(confirmed('pyinstaller --clean -y x.spec'), ran('pyinstaller x.spec')).demoted).toBe(true);
  });

  it('corroborates a file reference against a path that was really read or written', () => {
    const actions: ExecutedAction[] = [{ tool: 'read_file', path: '/work/src/main.py', ok: true }];
    const fileFinding = { ...plausibleFinding({ claim: 'main.py exits early', outcome: 'read', source: 'agent' }), verdict: 'CONFIRMED' as const };
    expect(enforceEvidenceProvenance({ ...fileFinding, evidence: [{ kind: 'file', ref: 'src/main.py' }] }, actions).demoted).toBe(false);
    expect(enforceEvidenceProvenance({ ...fileFinding, evidence: [{ kind: 'file', ref: 'src/other.py' }] }, actions).demoted).toBe(true);
  });

  it('leaves a PLAUSIBLE finding and non-checkable evidence alone', () => {
    const plausible = plausibleFinding({ claim: 'probably the parser', outcome: 'open', source: 'agent' });
    expect(enforceEvidenceProvenance(plausible, ran('anything')).demoted).toBe(false);

    // A quote or observation cannot be mechanically corroborated; it is named as
    // a residual rather than treated as fabricated.
    const quote = confirmed('from the request: "fix the crash"', { evidence: [{ kind: 'quote', ref: 'fix the crash' }] });
    const result = enforceEvidenceProvenance(quote, []);
    expect(result.demoted).toBe(false);
    expect(result.unproven).toEqual([]);
  });

  it('strips only the unproven refs when at least one is real', () => {
    const mixed = confirmed('npx vitest run tests/tools', {
      evidence: [
        { kind: 'command', ref: 'npx vitest run tests/tools' },
        { kind: 'command', ref: 'npx tsc --noEmit' },
      ],
    });
    const result = enforceEvidenceProvenance(mixed, ran('npx vitest run tests/tools'));
    expect(result.demoted).toBe(false);
    expect(result.finding.verdict).toBe('CONFIRMED');
    expect(evidenceOf(result.finding).map((e) => e.ref)).toEqual(['npx vitest run tests/tools']);
    expect(result.unproven.map((u) => u.ref)).toEqual(['npx tsc --noEmit']);
  });
});

describe('the finding tool applies provenance only when the loop supplies a ledger', () => {
  it('demotes a command citation the turn never executed', () => {
    const result = recordFinding(
      {
        claim: 'the app was rebuilt and launches without crashing',
        outcome: 'verified',
        evidence: [{ kind: 'command', ref: 'pyinstaller --clean -y AukatCheck.spec' }],
      },
      { executedActions: ran('pyinstaller AukatCheck.spec') },
    );
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.finding.verdict).toBe('PLAUSIBLE');
    expect(result.text).toContain('not verified');
  });

  it('leaves the verdict alone when no ledger was supplied (a direct call)', () => {
    // A direct caller cannot distinguish "nothing ran" from "no ledger", so it
    // must not demote on the strength of an empty list — that would turn every
    // legitimate direct finding into a PLAUSIBLE one.
    const result = recordFinding({
      claim: 'the tools suite is green',
      outcome: 'checked',
      evidence: [{ kind: 'command', ref: 'npx vitest run tests/tools' }],
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.finding.verdict).toBe('CONFIRMED');
  });
});

describe('the tool loop feeds the finding tool its action ledger', () => {
  it('records the command a prior step ran, so a later fabricated citation is demoted', async () => {
    // Step 1 runs a build; step 2 records a finding citing a DIFFERENT command
    // for the same deliverable — exactly the live failure. The loop must carry
    // step 1's action into step 2's finding call.
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'run_terminal', arguments: { command: 'pyinstaller AukatCheck.spec' } }] },
      {
        content: '',
        toolCalls: [
          {
            id: 'c2',
            name: 'finding',
            arguments: {
              claim: 'the app was rebuilt and launches without crashing',
              outcome: 'verified',
              evidence: [{ kind: 'command', ref: 'pyinstaller --clean -y AukatCheck.spec' }],
            },
          },
        ],
      },
      { content: 'Done.', toolCalls: [] },
    ];
    let findingResult = '';
    let i = 0;
    const deps = {
      callModel: async () => script[Math.min(i++, script.length - 1)],
      executeTool: async (name: string, args: Record<string, unknown>, c: ToolContext) => {
        if (name === 'run_terminal') return 'Error: exit 1 — dist/ not empty (use -y)';
        if (name === 'finding') {
          findingResult = await getTool('finding')!.run(args, c);
          return findingResult;
        }
        return `executed ${name}`;
      },
    };
    await runToolLoop({ messages: [{ role: 'user', content: 'rebuild the app and verify it' }], context: { configManager: {} }, deps });

    expect(findingResult).toContain('not verified');
    expect(findingResult).not.toContain('✅');
  });
});
