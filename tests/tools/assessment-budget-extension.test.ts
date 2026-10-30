/**
 * The assessment budget is driven by YIELD, not by the step count.
 *
 * Measured: two audits of the same repository stopped after exactly 81 steps —
 * one with 20 substantiated defects, one with 11 — because the bound was blind
 * to what the work produced. The rule pinned here:
 *
 *   - a round that ADDED a finding keeps the budget open (so a large tree gets
 *     the steps it needs for the parts nobody has read yet);
 *   - a whole round that added NONE ends the run early (so a small project does
 *     not spend every continuation re-reading the same twelve files).
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runToolLoop, type ToolLoopDeps, type StepResponse, type ToolLoopOptions } from '../../src/tools/tool-loop.js';

const ASK = 'Audit this repository and write the complete report to ../REPORT.md, then stop.';

function report(bugs: number): string {
  const lines = ['# Audit', '', '## 4. Bug Discovery', ''];
  for (let i = 1; i <= bugs; i += 1) {
    lines.push(`### BUG-${String(i).padStart(2, '0')} - HIGH - defect number ${i} in the tree`, '');
  }
  return lines.join('\n');
}

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), 'assess-budget-'));
  const cwd = join(root, 'repo');
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

function harness(cwd: string, onCall: (round: number) => void): { deps: ToolLoopDeps; events: string[] } {
  let round = 0;
  const events: string[] = [];
  const deps: ToolLoopDeps = {
    // Each round READS a file (a successful tool call) and the report gains a
    // defect that round — the shape of a real audit round.
    callModel: vi.fn(async () => {
      onCall(round);
      const step: StepResponse = {
        content: '',
        // A DIFFERENT file each round: the loop refuses a repeated identical
        // read, and a refused call must not stand in for progress here.
        toolCalls: [{ id: `r${round}`, name: 'read_file', arguments: { path: `src/module_${round}.py` } }],
      };
      round += 1;
      return step;
    }),
    executeTool: vi.fn(async () => 'ok'),
    onEvent: (event: string) => events.push(event),
  };
  void cwd;
  return { deps, events };
}

function run(deps: ToolLoopDeps, cwd: string) {
  return runToolLoop({
    messages: [{ role: 'user', content: ASK }],
    context: { cwd, configManager: {} },
    deps,
    maxSteps: 1,
    maxContinuations: 0,
    continuationSteps: 1,
  } as unknown as ToolLoopOptions & { deps: ToolLoopDeps });
}

describe('assessment budget follows findings', () => {
  it('extends while the report keeps gaining findings', async () => {
    const cwd = setup();
    const parent = join(cwd, '..');
    writeFileSync(join(parent, 'REPORT.md'), report(1));

    // Each round the model adds one more substantiated defect to the report.
    const { deps } = harness(cwd, (round) => {
      writeFileSync(join(parent, 'REPORT.md'), report(1 + round));
    });

    const result = await run(deps, cwd);
    // 1 base step + the small-tree extension cap (2) — every extension earned
    // by a NEW finding.
    expect(result.steps).toBe(3);
  });

  it('stops early when a whole round adds nothing new', async () => {
    const cwd = setup();
    writeFileSync(join(cwd, '..', 'REPORT.md'), report(3));
    const { deps, events } = harness(cwd, () => {
      // The model re-reads, re-verifies, and writes no new defect.
    });

    const result = await run(deps, cwd);
    // The first bound credits the three findings and grants one continuation;
    // the next bound sees no new finding and ends the run instead of spending
    // another round on the same material.
    expect(result.steps).toBe(2);
    expect(events.some((e) => e.includes('No new findings this round'))).toBe(true);
  });

  it('does not stop before the report has any finding in it', async () => {
    const cwd = setup();
    writeFileSync(join(cwd, '..', 'REPORT.md'), '# Audit\n\n## 1. Project Understanding\n\nstill writing\n');
    const { deps } = harness(cwd, () => {});

    const result = await run(deps, cwd);
    // A report opened but not yet carrying a defect is work in progress, not a
    // dry round: the first bound grants the continuation.
    expect(result.steps).toBeGreaterThan(1);
  });

  it('leaves a non-assessment turn on the old budget rules', async () => {
    const cwd = setup();
    const events: string[] = [];
    const deps: ToolLoopDeps = {
      callModel: vi.fn(
        async () =>
          ({ content: '', toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'README.md' } }] }) as StepResponse,
      ),
      executeTool: vi.fn(async () => 'ok'),
      onEvent: (event: string) => events.push(event),
    };
    writeFileSync(join(cwd, '..', 'REPORT.md'), report(3));

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'Read the README and tell me what the project does.' }],
      context: { cwd, configManager: {} },
      deps,
      maxSteps: 1,
      maxContinuations: 0,
      continuationSteps: 1,
    } as unknown as ToolLoopOptions & { deps: ToolLoopDeps });

    expect(result.steps).toBe(1);
    expect(events.some((e) => e.includes('No new findings'))).toBe(false);
  });

  it('leaves the report itself untouched', async () => {
    const cwd = setup();
    writeFileSync(join(cwd, '..', 'REPORT.md'), report(2));
    const before = readFileSync(join(cwd, '..', 'REPORT.md'), 'utf8');
    const { deps } = harness(cwd, () => {});
    await run(deps, cwd);
    expect(readFileSync(join(cwd, '..', 'REPORT.md'), 'utf8')).toBe(before);
  });
});
