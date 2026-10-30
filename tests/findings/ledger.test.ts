/**
 * Findings ledger — the cross-run reader.
 *
 * Pins the gap the head-to-head measured: a run's findings were recorded on its
 * own trace and unreadable from the next run, so a second pass over the same tree
 * re-derived every conclusion — and could re-raise a claim a previous pass had
 * already retracted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beginTrace, endTrace, recordTraceFindings } from '../../src/learning/reasoning-trace.js';
import { confirmFinding, plausibleFinding, toWire, withdrawFinding } from '../../src/findings/verdicts.js';
import { findingsBlockFor, findingsForProject } from '../../src/findings/ledger.js';

let memoryDir: string;
let previous: string | undefined;

beforeEach(() => {
  memoryDir = mkdtempSync(join(tmpdir(), 'nuvira-findings-'));
  previous = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = memoryDir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = previous;
  rmSync(memoryDir, { recursive: true, force: true });
});

/** One run in `project`, recording the findings it produced. */
function run(project: string | undefined, findings: Parameters<typeof recordTraceFindings>[1]): string {
  const id = beginTrace({ goal: 'audit', source: 'loop', ...(project ? { workingDirectory: project } : {}) });
  recordTraceFindings(id, findings);
  endTrace(id, true);
  return id;
}

describe('findingsForProject', () => {
  it('recalls a settled finding for the project that recorded it, not another', () => {
    const confirmed = confirmFinding(
      plausibleFinding({ claim: 'the default judge model is retired', outcome: 'raised', source: 'audit' }),
      [{ kind: 'command', ref: 'curl https://api/gemini' }],
    ).finding;
    run('/projects/alpha', [toWire(confirmed)]);
    run('/projects/beta', [
      toWire(
        confirmFinding(plausibleFinding({ claim: 'beta has a leak', outcome: 'raised', source: 'audit' }), [
          { kind: 'file', ref: 'beta/x.py' },
        ]).finding,
      ),
    ]);

    const alpha = findingsForProject('/projects/alpha');
    expect(alpha).toHaveLength(1);
    expect(alpha[0]!.claim).toContain('judge model');
    expect(alpha[0]!.verdict).toBe('CONFIRMED');
    expect(alpha[0]!.runId).toMatch(/^trace-/);
  });

  it('does not attribute a trace that recorded no project', () => {
    const finding = confirmFinding(
      plausibleFinding({ claim: 'unattributable claim', outcome: 'raised', source: 'audit' }),
      [{ kind: 'file', ref: 'x.py' }],
    ).finding;
    run(undefined, [toWire(finding)]);

    expect(findingsForProject('/projects/alpha')).toEqual([]);
  });

  it('lets the NEWEST verdict win, so a withdrawal cannot be overwritten by an older confirmation', () => {
    const claim = 'the demo fails exactly four inspections';
    const confirmed = confirmFinding(
      plausibleFinding({ claim, outcome: 'raised', source: 'audit' }),
      [{ kind: 'command', ref: 'nuvira run -p mock' }],
    ).finding;
    run('/projects/alpha', [toWire(confirmed)]);
    // A later run checked it again and retracted it.
    run('/projects/alpha', [toWire(withdrawFinding(confirmed, 'three runs failed 3, 4 and 5'))]);

    const recalled = findingsForProject('/projects/alpha');
    expect(recalled).toHaveLength(1);
    expect(recalled[0]!.verdict).toBe('WITHDRAWN');
    expect(recalled[0]!.outcome).toContain('three runs failed');
  });

  it('does not recall an unverified guess by default, and does when asked', () => {
    run('/projects/alpha', [
      toWire(plausibleFinding({ claim: 'maybe a race in the runner', outcome: 'raised', source: 'audit' })),
    ]);

    expect(findingsForProject('/projects/alpha')).toEqual([]);
    expect(findingsForProject('/projects/alpha', { verdicts: ['PLAUSIBLE'] })).toHaveLength(1);
  });

  it('drops a later PLAUSIBLE re-statement rather than resurrecting the old confirmation', () => {
    const claim = 'the ci numerator double-rounds';
    const confirmed = confirmFinding(
      plausibleFinding({ claim, outcome: 'raised', source: 'audit' }),
      [{ kind: 'file', ref: 'ci.py' }],
    ).finding;
    run('/projects/alpha', [toWire(confirmed)]);
    run('/projects/alpha', [toWire(plausibleFinding({ claim, outcome: 're-examined', source: 'audit' }))]);

    expect(findingsForProject('/projects/alpha')).toEqual([]);
  });

  it('caps what it recalls so the block stays bounded', () => {
    const findings = Array.from({ length: 6 }, (_, i) =>
      toWire(
        confirmFinding(
          plausibleFinding({ claim: `defect ${i}`, outcome: 'raised', source: 'audit' }),
          [{ kind: 'file', ref: `f${i}.py` }],
        ).finding,
      ),
    );
    run('/projects/alpha', findings);

    expect(findingsForProject('/projects/alpha', { max: 2 })).toHaveLength(2);
  });
});

describe('findingsBlockFor', () => {
  it('is empty when nothing is settled, so a fresh project adds no prompt weight', () => {
    expect(findingsBlockFor('/projects/nothing')).toBe('');
  });

  it('states the settled ground and forbids re-raising a withdrawal', () => {
    const confirmed = confirmFinding(
      plausibleFinding({ claim: 'the CI numerator double-rounds', outcome: 'confirmed', source: 'audit' }),
      [{ kind: 'file', ref: 'proportion_ci.py' }],
    ).finding;
    const withdrawn = withdrawFinding(
      plausibleFinding({ claim: 'the suite hangs at 33%', outcome: 'raised', source: 'audit' }),
      'it was a slow test, not a hang',
    );
    run('/projects/alpha', [toWire(confirmed), toWire(withdrawn)]);

    const block = findingsBlockFor('/projects/alpha');
    expect(block).toContain('settled by EARLIER RUNS');
    expect(block).toContain('double-rounds');
    expect(block).toContain('⛔');
    expect(block).toContain('do not re-raise');
  });
});
