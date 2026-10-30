/**
 * `finish` is the completion ACT — the one mechanism worth taking from Cline's
 * harness. The claim is checked against the turn's OWN evidence, so a model cannot
 * certify a turn the evidence contradicts, and a `verified:false` ending is legal
 * but must say what is missing.
 */

import { describe, it, expect } from 'vitest';

import { getTool, toolJsonSchemas, type ToolContext } from '../../src/tools/registry.js';
import { CORE_TOOL_NAMES, toolsetForTool } from '../../src/tools/toolsets.js';
import { FINISH_ACCEPTED_MARKER, FINISH_REFUSED_MARKER } from '../../src/learning/completion-contract.js';

const CLEAN_LEDGER = {
  unmet: [] as string[],
  redChecks: [] as { command: string; stale: boolean }[],
  unboundModules: [] as string[],
  wroteFiles: true,
  checksRan: 2,
  satisfied: 4,
  total: 4,
  unknown: 0,
} as {
  unmet: string[];
  redChecks: { command: string; stale: boolean }[];
  unboundModules: string[];
  namedDeliverables?: { path: string; exists: boolean }[];
  wroteFiles: boolean;
  checksRan: number;
  satisfied: number;
  total: number;
  unknown: number;
};

function ctxWith(ledger: typeof CLEAN_LEDGER | null): ToolContext {
  return {
    configManager: {},
    ...(ledger ? { turnLedger: () => ledger } : {}),
  } as unknown as ToolContext;
}

describe('registry — finish (completion contract)', () => {
  it('is registered as an experience tool that does NOT end the step', () => {
    const tool = getTool('finish');
    expect(tool).toBeDefined();
    expect(tool!.category).toBe('experience');
    // An ending tool would bypass every end-of-turn gate — the measured escape hatch.
    expect(tool!.endsAgentStep).toBe(false);
    expect(toolsetForTool('finish')?.name).toBe('experience');
    expect(CORE_TOOL_NAMES).toContain('finish');
  });

  it('exposes summary / verified / unmet to the model', () => {
    const params = (toolJsonSchemas(['finish'])[0].parameters as { properties: Record<string, unknown> }).properties;
    expect(params).toHaveProperty('summary');
    expect(params).toHaveProperty('verified');
    expect(params).toHaveProperty('unmet');
    const verified = params.verified as { description?: string };
    expect(verified.description ?? '').toMatch(/tool output/i);
  });

  it('accepts a verified claim the ledger backs', async () => {
    const out = await getTool('finish')!.run(
      { summary: 'Added the order route and its tests', verified: true },
      ctxWith(CLEAN_LEDGER),
    );
    expect(out).toContain(FINISH_ACCEPTED_MARKER);
    expect(out).toContain('4/4 requirement(s) satisfied');
  });

  it('names an unmet requirement row as an OBSERVATION, and lets the model decide', async () => {
    // The row is the request read back automatically. It can be a wrong reading, or
    // already satisfied by work no static reader sees, so it is put in front of the
    // model — which may close it, or say why it does not apply — instead of refusing.
    const out = await getTool('finish')!.run(
      { summary: 'Done', verified: true },
      ctxWith({ ...CLEAN_LEDGER, unmet: ['README.md — what this is and how to run it'], satisfied: 3, total: 4 }),
    );
    expect(out).toContain(FINISH_ACCEPTED_MARKER);
    expect(out).toContain('3/4 requirement(s) satisfied');
    expect(out).toContain('README.md');
    expect(out).toContain('never reasons to refuse an ending');
  });

  it('refuses a verified claim while a check is red', async () => {
    const out = await getTool('finish')!.run(
      { summary: 'All good', verified: true },
      ctxWith({ ...CLEAN_LEDGER, redChecks: [{ command: 'npm test', stale: true }] }),
    );
    expect(out).toContain(FINISH_REFUSED_MARKER);
    expect(out).toContain('npm test');
  });

  it('names a runnable entry point with no README as an OBSERVATION', async () => {
    const out = await getTool('finish')!.run(
      { summary: 'Built the app', verified: true },
      ctxWith({ ...CLEAN_LEDGER, quickstart: { entry: 'package.json' } }),
    );
    expect(out).toContain(FINISH_ACCEPTED_MARKER);
    expect(out).toContain('no README a fresh clone could follow');
  });

  it('can be silenced by the caller that also silenced the loop\'s opinions', async () => {
    const out = await getTool('finish')!.run(
      { summary: 'Built the app', verified: true },
      ctxWith({ ...CLEAN_LEDGER, quickstart: { entry: 'package.json' }, advisoryGates: false }),
    );
    expect(out).toContain(FINISH_ACCEPTED_MARKER);
    expect(out).not.toContain('no README a fresh clone could follow');
  });

  // ── the file the REQUEST named is the deliverable ─────────────────────────
  // Measured 2026-10-29 (BUG-SEEDED): the ask said "Write docs/BUGS_FOUND.md"; the turn
  // fixed all four seeded bugs, wrote tests, and handed in no report. The loop's nudge
  // named the file and the model ended anyway. A path named in the ask is a fact, so a
  // `verified:true` claim without it is refused — not advised against.
  it('refuses verified:true while a file the request named is not on disk', async () => {
    const out = await getTool('finish')!.run(
      { summary: 'Audited and fixed four defects', verified: true },
      ctxWith({ ...CLEAN_LEDGER, namedDeliverables: [{ path: 'docs/BUGS_FOUND.md', exists: false }] }),
    );
    expect(out).toContain(FINISH_REFUSED_MARKER);
    expect(out).toContain('docs/BUGS_FOUND.md');
    expect(out).toContain('does not exist');
  });

  it('accepts the same claim once that file exists', async () => {
    const out = await getTool('finish')!.run(
      { summary: 'Audited and fixed four defects', verified: true },
      ctxWith({ ...CLEAN_LEDGER, namedDeliverables: [{ path: 'docs/BUGS_FOUND.md', exists: true }] }),
    );
    expect(out).toContain(FINISH_ACCEPTED_MARKER);
    expect(out).not.toContain('does not exist');
  });

  it('keeps an honest verified:false open while the named file is missing', async () => {
    // The escape hatch stays open on purpose: the point is that the gap reaches the
    // user, not that the turn must produce a file it decided not to.
    const out = await getTool('finish')!.run(
      {
        summary: 'Fixed four defects; the report is not written',
        verified: false,
        unmet: ['docs/BUGS_FOUND.md'],
      },
      ctxWith({ ...CLEAN_LEDGER, namedDeliverables: [{ path: 'docs/BUGS_FOUND.md', exists: false }] }),
    );
    expect(out).toContain(FINISH_ACCEPTED_MARKER);
    expect(out).toContain('given to the user verbatim');
  });

  it('accepts an honest verified:false that lists the gaps, and says they will be shown', async () => {
    const out = await getTool('finish')!.run(
      { summary: 'Mostly done', verified: false, unmet: ['e2e needs a browser install'] },
      ctxWith(CLEAN_LEDGER),
    );
    expect(out).toContain(FINISH_ACCEPTED_MARKER);
    expect(out).toContain('given to the user verbatim');
    expect(out).not.toContain('Complete.');
  });

  it('treats a missing `verified` as a CLAIM — omission must not skip the check', async () => {
    const out = await getTool('finish')!.run(
      { summary: 'Done' },
      ctxWith({ ...CLEAN_LEDGER, redChecks: [{ command: 'npm test', stale: false }] }),
    );
    expect(out).toContain(FINISH_REFUSED_MARKER);
    expect(out).toContain('npm test');
  });

  it('requires a summary', async () => {
    const out = await getTool('finish')!.run({ verified: true }, ctxWith(CLEAN_LEDGER));
    expect(out).toContain(FINISH_REFUSED_MARKER);
    expect(out).toContain('one line');
  });

  it('says so when no turn ledger is attached, instead of implying verification', async () => {
    const out = await getTool('finish')!.run({ summary: 'Done', verified: true }, ctxWith(null));
    expect(out).toContain(FINISH_ACCEPTED_MARKER);
    expect(out).toContain('no turn ledger is attached');
  });
});
