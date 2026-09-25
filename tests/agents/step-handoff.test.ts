/**
 * Step hand-off — the durable record a FAILED step leaves for whoever runs next.
 *
 * Every case below is drawn from the live NVDA-addon failure, so these tests
 * double as its regression record:
 *   - 18 attempts, each re-planning a step whose files a previous attempt had
 *     already half-produced, because no record survived the hand-off
 *   - a "completed" step whose declared file was never on disk
 *   - a declared package that exists as a valid 22-byte zip holding ZERO entries
 *
 * The one rule these tests exist to protect: what a hand-off reports as LANDED
 * is re-derived from the filesystem on every read, never echoed from the last
 * write. A hand-off that remembered a claim would recreate the exact false
 * completion it was built to end.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_ATTEMPTS,
  MAX_BLOCK_CHARS,
  clearProjectHandoffs,
  clearStepHandoff,
  deliverablesNamedIn,
  formatHandoffs,
  handoffBlockFor,
  loadOpenHandoffs,
  loadStepHandoff,
  reconcileHandoff,
  recordStepHandoff,
  stepKeyFor,
} from '../../src/agents/step-handoff.js';

/** The exact 22 bytes `zip` writes when it matches nothing. */
function emptyZipBytes(): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  return eocd;
}

let memDir: string;
let project: string;
let prevMemDir: string | undefined;

beforeEach(() => {
  memDir = mkdtempSync(join(tmpdir(), 'nuvira-handoff-mem-'));
  project = mkdtempSync(join(tmpdir(), 'nuvira-handoff-proj-'));
  prevMemDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = memDir;
});

afterEach(() => {
  if (prevMemDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = prevMemDir;
  rmSync(memDir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

/** The ask from the live failure, verbatim in shape. */
const NVDA_GOAL =
  'can you develop an NVDA add on compatible to 2026.2 , when user presses NVDA key+alt+9 than it says ' +
  '"Mote butter, dekh ye addon whatsapp se bana hai" , Need a deplorable package for nvda deployment ' +
  'Save this in folder ' + '/Users/dheeraj/Documents/kuttaaddon/';

describe('stepKeyFor', () => {
  it('keys on the DECLARED ARTIFACTS, so the same deliverable asked for differently is one step', () => {
    const a = stepKeyFor({ declared: ['manifest.ini', 'globalPlugins/kutta_addon.py'] });
    const b = stepKeyFor({ declared: ['./globalPlugins/kutta_addon.py', 'manifest.ini'] });
    expect(a).toBe(b);
    // Different spelling of the same path (backslashes, case) also collides.
    expect(stepKeyFor({ declared: ['GlobalPlugins\\Kutta_Addon.PY'] })).toBe(
      stepKeyFor({ declared: ['globalPlugins/kutta_addon.py'] }),
    );
  });

  it('treats different deliverables as different steps', () => {
    expect(stepKeyFor({ declared: ['manifest.ini'] })).not.toBe(stepKeyFor({ declared: ['installTasks.py'] }));
  });

  it('falls back to the description, and survives trivial rewording', () => {
    const a = stepKeyFor({ stepDescription: 'Package the add-on' });
    const b = stepKeyFor({ stepDescription: 'package  the addon' });
    expect(a).toBe(b);
    expect(a).not.toBe(stepKeyFor({ stepDescription: 'Write the manual' }));
  });
});

describe('recordStepHandoff + loadStepHandoff', () => {
  it('records an attempt and reports what is still missing', () => {
    const h = recordStepHandoff({
      projectPath: project,
      goal: NVDA_GOAL,
      stepDescription: 'Create manifest.ini and the global plugin',
      declared: ['manifest.ini', 'globalPlugins/kutta_addon.py'],
      route: 'gemini:gemini-2.0-flash',
      kind: 'failed',
      reason: 'the provider returned an empty response',
    });

    expect(h.remaining).toEqual(['manifest.ini', 'globalPlugins/kutta_addon.py']);
    expect(h.landed).toEqual([]);
    expect(h.attempts).toHaveLength(1);

    const loaded = loadStepHandoff(project, h.stepKey);
    expect(loaded).not.toBeNull();
    expect(loaded!.attempts[0]!.route).toBe('gemini:gemini-2.0-flash');
  });

  it('accumulates attempts, oldest-first, capped', () => {
    for (let i = 0; i < MAX_ATTEMPTS + 4; i += 1) {
      recordStepHandoff({
        projectPath: project,
        goal: NVDA_GOAL,
        stepDescription: 'Package the add-on',
        declared: ['kuttaaddon.nvda-addon'],
        route: `openrouter:model-${i}`,
        kind: 'failed',
        reason: `attempt ${i}`,
      });
    }
    const h = loadStepHandoff(project, stepKeyFor({ declared: ['kuttaaddon.nvda-addon'] }))!;
    expect(h.attempts).toHaveLength(MAX_ATTEMPTS);
    // The cap drops the OLDEST — the newest failure is the one that matters.
    expect(h.attempts[h.attempts.length - 1]!.route).toBe(`openrouter:model-${MAX_ATTEMPTS + 3}`);
  });

  it('keeps the failure KIND, because a refusal and an outage need different repairs', () => {
    const h = recordStepHandoff({
      projectPath: project,
      goal: NVDA_GOAL,
      stepDescription: 'write_file → /Users/dheeraj/Documents/kuttaaddon/manifest.ini',
      declared: ['/Users/dheeraj/Documents/kuttaaddon/manifest.ini'],
      route: 'loop',
      kind: 'refused',
      reason: 'declined — the path is outside the workspace the tools may touch',
    });
    expect(h.attempts[0]!.kind).toBe('refused');
    expect(formatHandoffs([h])).toContain('refused by a tool gate');
  });
});

describe('reconcileHandoff — the filesystem is the authority, not the record', () => {
  it('moves a declared file to `landed` once it exists', () => {
    recordStepHandoff({
      projectPath: project,
      goal: NVDA_GOAL,
      stepDescription: 'Create the plugin',
      declared: ['globalPlugins/kutta_addon.py', 'manifest.ini'],
      route: 'gemini:gemini-2.0-flash',
      kind: 'failed',
      reason: 'stalled after writing one file',
    });

    // The previous attempt DID land one of the two files.
    mkdirSync(join(project, 'globalPlugins'), { recursive: true });
    writeFileSync(join(project, 'globalPlugins/kutta_addon.py'), 'import globalPluginHandler\n');

    const h = loadStepHandoff(project, stepKeyFor({ declared: ['globalPlugins/kutta_addon.py', 'manifest.ini'] }))!;
    expect(h.landed).toEqual(['globalPlugins/kutta_addon.py']);
    expect(h.remaining).toEqual(['manifest.ini']);
  });

  it('re-opens work whose file has since DISAPPEARED', () => {
    const declared = ['src/thing.ts'];
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(join(project, 'src/thing.ts'), 'export const a = 1;\n');
    recordStepHandoff({
      projectPath: project,
      goal: 'build the thing',
      stepDescription: 'Write src/thing.ts',
      declared,
      route: 'groq:llama-3.3-70b',
      kind: 'failed',
      reason: 'crashed',
    });
    expect(loadOpenHandoffs(project)).toHaveLength(0);

    // Something (a rollback, a bad repair) removed it — the hand-off must not
    // keep claiming it landed.
    rmSync(join(project, 'src/thing.ts'));
    const open = loadOpenHandoffs(project);
    expect(open).toHaveLength(1);
    expect(open[0]!.remaining).toEqual(['src/thing.ts']);
  });

  it('does not count an EMPTY ARCHIVE as landed — the live 22-byte package', () => {
    const declared = ['kuttaaddon.nvda-addon'];
    writeFileSync(join(project, 'kuttaaddon.nvda-addon'), emptyZipBytes());
    recordStepHandoff({
      projectPath: project,
      goal: NVDA_GOAL,
      stepDescription: 'Package the add-on',
      declared,
      route: 'loop',
      kind: 'failed',
      reason: 'zip matched none of its declared inputs',
    });

    const h = loadStepHandoff(project, stepKeyFor({ declared }))!;
    // It exists and is 22 bytes — and it is still not a deliverable.
    expect(h.remaining).toEqual(declared);
    expect(h.landed).toEqual([]);
  });

  it('honours allowEmpty for a file the plan legitimately asks to be empty', () => {
    writeFileSync(join(project, 'installTasks.py'), '');
    const h = reconcileHandoff({
      goal: 'g',
      projectPath: project,
      stepKey: 'k',
      stepDescription: 'd',
      declared: ['installTasks.py'],
      landed: [],
      remaining: ['installTasks.py'],
      attempts: [],
      allowEmpty: ['installTasks.py'],
      updatedAt: Date.now(),
    });
    expect(h.landed).toEqual(['installTasks.py']);
  });
});

describe('loadOpenHandoffs — project-scoped, so a REWORDED ask resumes', () => {
  it('finds outstanding work from a previous, differently-worded ask', () => {
    // Attempt 1: the long original wording.
    recordStepHandoff({
      projectPath: project,
      goal: NVDA_GOAL,
      stepDescription: 'Create manifest.ini',
      declared: ['manifest.ini'],
      route: 'gemini:gemini-2.0-flash',
      kind: 'failed',
      reason: 'empty response',
    });

    // Attempt 2 asks the same thing in different words and looks the project up.
    const open = loadOpenHandoffs(project);
    expect(open).toHaveLength(1);
    expect(open[0]!.remaining).toEqual(['manifest.ini']);
    expect(open[0]!.goal).toBe(NVDA_GOAL);
  });

  it('is scoped to the project — another folder does not inherit it', () => {
    recordStepHandoff({
      projectPath: project,
      goal: 'build the thing',
      stepDescription: 'Write src/thing.ts',
      declared: ['src/thing.ts'],
      route: 'groq:llama-3.3-70b',
      kind: 'failed',
      reason: 'crashed',
    });
    const other = mkdtempSync(join(tmpdir(), 'nuvira-other-'));
    try {
      expect(loadOpenHandoffs(other)).toHaveLength(0);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('drops finished work, and work with nothing declared to describe', () => {
    // Finished: nothing left to do.
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(join(project, 'src/done.ts'), 'export {};\n');
    recordStepHandoff({
      projectPath: project,
      goal: 'g',
      stepDescription: 'Write src/done.ts',
      declared: ['src/done.ts'],
      route: 'r',
      kind: 'failed',
      reason: 'x',
    });
    // Undescribable: no declaration at all.
    recordStepHandoff({
      projectPath: project,
      goal: 'g',
      stepDescription: 'Think about the design',
      route: 'r',
      kind: 'failed',
      reason: 'y',
    });
    expect(loadOpenHandoffs(project)).toHaveLength(0);
  });

  it('clearStepHandoff removes exactly one step; the project clear removes the rest', () => {
    const key = stepKeyFor({ declared: ['manifest.ini'] });
    recordStepHandoff({
      projectPath: project,
      goal: 'g',
      stepDescription: 'Create manifest.ini',
      declared: ['manifest.ini'],
      route: 'r',
      kind: 'failed',
      reason: 'x',
    });
    recordStepHandoff({
      projectPath: project,
      goal: 'g',
      stepDescription: 'Package it',
      declared: ['out.nvda-addon'],
      route: 'r',
      kind: 'failed',
      reason: 'y',
    });
    expect(loadOpenHandoffs(project)).toHaveLength(2);

    clearStepHandoff(project, key);
    expect(loadOpenHandoffs(project)).toHaveLength(1);

    clearProjectHandoffs(project);
    expect(loadOpenHandoffs(project)).toHaveLength(0);
  });
});

describe('formatHandoffs — the block the next model actually reads', () => {
  it('is empty when there is nothing outstanding (no prompt weight)', () => {
    expect(formatHandoffs([])).toBe('');
    expect(handoffBlockFor(project)).toBe('');
  });

  it('names what landed, what is missing, and why the last attempt stopped', () => {
    mkdirSync(join(project, 'globalPlugins'), { recursive: true });
    writeFileSync(join(project, 'globalPlugins/kutta_addon.py'), 'import globalPluginHandler\n');
    recordStepHandoff({
      projectPath: project,
      goal: NVDA_GOAL,
      stepDescription: 'Create manifest.ini and the global plugin',
      declared: ['globalPlugins/kutta_addon.py', 'manifest.ini'],
      route: 'gemini:gemini-2.0-flash',
      kind: 'failed',
      reason: 'the provider returned an empty response',
    });

    const block = formatHandoffs(loadOpenHandoffs(project));
    expect(block).toContain('Hand-off');
    expect(block).toContain('already on disk (do NOT redo)');
    expect(block).toContain('globalPlugins/kutta_addon.py');
    expect(block).toContain('still missing');
    expect(block).toContain('manifest.ini');
    expect(block).toContain('gemini');
    expect(block).toContain('empty response');
  });

  it('tells the incoming model how many attempts already failed', () => {
    for (let i = 0; i < 3; i += 1) {
      recordStepHandoff({
        projectPath: project,
        goal: 'g',
        stepDescription: 'Package the add-on',
        declared: ['out.nvda-addon'],
        route: `provider-${i}:m`,
        kind: 'failed',
        reason: 'zip matched none of its declared inputs',
      });
    }
    const block = formatHandoffs(loadOpenHandoffs(project));
    expect(block).toContain('3 attempts so far');
    expect(block).toContain('take a different one');
  });

  it('is bounded, so it cannot recreate the context drift it exists to stop', () => {
    for (let i = 0; i < 8; i += 1) {
      recordStepHandoff({
        projectPath: project,
        goal: 'g',
        stepDescription: `Step number ${i} with a fairly long description to add weight ${'x'.repeat(120)}`,
        declared: [`deliverable-${i}-${'y'.repeat(80)}.nvda-addon`],
        route: `provider-${i}:model-with-a-long-name`,
        kind: 'failed',
        reason: 'a reasonably long failure reason that also takes up space',
      });
    }
    const block = formatHandoffs(loadOpenHandoffs(project, { limit: 8 }));
    expect(block.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS + 60);
    expect(block).toContain('truncated to fit the context budget');
  });
});

describe('deliverablesNamedIn', () => {
  it('finds the destination DIRECTORY the live ask named', () => {
    // The real prompt named a destination folder and never named the package —
    // the agent chose `kuttaaddon.nvda-addon` itself — so extension matching
    // alone found nothing to hold the run accountable to.
    expect(deliverablesNamedIn(NVDA_GOAL)).toContain('/Users/dheeraj/Documents/kuttaaddon/');
  });

  it('finds a named package with an extension', () => {
    expect(
      deliverablesNamedIn('build the add-on and leave kuttaaddon.nvda-addon in the repo'),
    ).toContain('kuttaaddon.nvda-addon');
  });

  it('finds an absolute destination path', () => {
    const found = deliverablesNamedIn('Save the report in /Users/dheeraj/docs/report.pdf please');
    expect(found).toContain('/Users/dheeraj/docs/report.pdf');
  });

  it('ignores prose that names no artifact', () => {
    expect(deliverablesNamedIn('make the dashboard faster and fix the login bug')).toEqual([]);
  });

  it('dedupes and caps', () => {
    const noisy = Array.from({ length: 20 }, (_, i) => `out-${i}.zip`).join(' ');
    const found = deliverablesNamedIn(noisy);
    expect(found.length).toBeLessThanOrEqual(8);
    expect(new Set(found).size).toBe(found.length);
  });
});
