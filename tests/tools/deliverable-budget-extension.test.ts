/**
 * The step-bound extension must not require an OPEN PLAN.
 *
 * Measured failure: an audit turn had no plan store, spent its continuations
 * while staging a report inside the repo, and returned a 0-byte deliverable.
 * The extension existed but was gated on `planStillOpen`, so a turn whose only
 * remaining work was "put the named file on disk" could never qualify.
 *
 * These tests pin the two halves of the fix, with the plan CLOSED in both cases
 * so the plan half of the condition cannot be what grants the extension: it
 * fires on a missing (or empty) named deliverable, and not once that deliverable
 * holds content.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runToolLoop, type ToolLoopDeps, type StepResponse, type ToolLoopOptions } from '../../src/tools/tool-loop.js';
import { getTool, type ToolContext } from '../../src/tools/registry.js';

const PLAN: StepResponse = {
  content: '',
  toolCalls: [
    { id: 'p1', name: 'plan_todo', arguments: { action: 'create', goal: 'g', steps: [{ id: 's1', description: 'd' }] } },
  ],
};
const CLOSE_PLAN: StepResponse = {
  content: '',
  toolCalls: [{ id: 'p2', name: 'plan_todo', arguments: { action: 'update', id: 's1', status: 'done', note: 'done' } }],
};
const DONE: StepResponse = { content: 'the audit is complete', toolCalls: [] };

const ASK = 'Audit this repository and write the complete report to ../REPORT.md, then stop.';

function harness(script: StepResponse[]) {
  let i = 0;
  const events: string[] = [];
  const deps: ToolLoopDeps = {
    callModel: vi.fn(async () => script[Math.min(i++, script.length - 1)]),
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>, ctx: ToolContext) => {
      const tool = getTool(name);
      if (!tool) throw new Error(`no tool ${name}`);
      return tool.run(args, ctx);
    }),
    onEvent: (event: string) => events.push(event),
  };
  return { deps, events };
}

function run(deps: ToolLoopDeps, cwd: string) {
  return runToolLoop({
    messages: [{ role: 'user', content: ASK }],
    context: { cwd, configManager: {} } as ToolContext,
    deps,
    // Two steps: create + close the plan, then the bound is reached with the
    // deliverable still owed and no continuation left.
    maxSteps: 2,
    maxContinuations: 0,
    continuationSteps: 4,
  } as ToolLoopOptions & { deps: ToolLoopDeps });
}

describe('deliverable-aware step extension', () => {
  it('extends when the ask names an artifact that is not on disk yet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'deliv-ext-'));
    const cwd = join(root, 'repo');
    mkdirSync(cwd, { recursive: true });

    const { deps, events } = harness([PLAN, CLOSE_PLAN, DONE]);
    const result = await run(deps, cwd);

    expect(events.some((e) => e.includes('../REPORT.md is not on disk yet'))).toBe(true);
    expect(result.steps).toBeGreaterThan(2);
  });

  it('does not extend once the named artifact holds content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'deliv-ext-'));
    const cwd = join(root, 'repo');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(root, 'REPORT.md'), '# audit\n\nreal content\n');

    const { deps, events } = harness([PLAN, CLOSE_PLAN, DONE]);
    await run(deps, cwd);

    expect(events.some((e) => e.includes('is not on disk yet'))).toBe(false);
  });

  it('treats a 0-byte artifact as not delivered', async () => {
    const root = mkdtempSync(join(tmpdir(), 'deliv-ext-'));
    const cwd = join(root, 'repo');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(root, 'REPORT.md'), '');

    const { deps, events } = harness([PLAN, CLOSE_PLAN, DONE]);
    await run(deps, cwd);

    expect(events.some((e) => e.includes('../REPORT.md is not on disk yet'))).toBe(true);
  });
});
