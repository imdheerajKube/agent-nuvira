/**
 * The budget must see what the close-out gate sees, and a silent grant must not be
 * able to renew itself forever.
 *
 * Measured 2026-11-06 (the RAG benchmark): the patched arm ended at its 50-step
 * budget while announcing "2 requirement(s) the ask named are still unmet". The
 * budget asked only the requirement ledger, but the close-out gate also counts
 * named files and the sections a report owes — so the loop stopped while holding
 * work it could name.
 *
 * The same run exposed the second half: `stalledGrants` was reset on EVERY grant,
 * so "two consecutive grants that moved no requirement" could never accumulate and
 * a turn that kept calling tools without changing the tree extended until the
 * absolute guard (1000). Both are pinned here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runToolLoop } from '../../src/tools/tool-loop.js';
import type { StepResponse } from '../../src/tools/tool-loop.js';

const ASK = [
  'Write an audit report to docs/REPORT.md. It must cover:',
  '- Findings. Real defects with evidence.',
  '- Limitations. What was not checked.',
  '- Citations. path:line for every claim.',
].join('\n');

/** The file exists, so the OLD gates are satisfied — but it lacks two sections. */
const WRITE_REPORT: StepResponse = {
  content: '',
  toolCalls: [
    {
      id: 'w1',
      name: 'write_file',
      arguments: {
        path: 'docs/REPORT.md',
        content: '# Audit\n\n## Findings\n\nThe parser drops empty lines.\n',
      },
    },
  ],
};

/** Work that calls a tool every step but never changes the tree. */
function filler(n: number): StepResponse {
  return {
    content: '',
    toolCalls: [{ id: `r${n}`, name: 'run_terminal', arguments: { command: `true # ${n}` } }],
  };
}

describe('close-out facts extend the budget, and a silent grant cannot renew it', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'closeout-budget-'));
    mkdirSync(join(root, 'repo'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function run(script: StepResponse[]) {
    let call = 0;
    const events: string[] = [];
    const result = await runToolLoop({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: ASK },
      ],
      context: { cwd: join(root, 'repo'), configManager: {} } as never,
      deps: {
        callModel: async () => script[Math.min(call++, script.length - 1)]!,
        executeTool: async (name: string, args: Record<string, unknown>) => {
          if (name === 'write_file') {
            const abs = join(join(root, 'repo'), String(args.path ?? ''));
            mkdirSync(join(abs, '..'), { recursive: true });
            writeFileSync(abs, String(args.content ?? ''));
            return `Wrote ${String(args.path ?? '')}`;
          }
          return 'ok';
        },
        onEvent: (line: string) => events.push(line),
      } as never,
      maxSteps: 4,
      maxContinuations: 0,
      continuationSteps: 4,
      requirementDrivenBudget: true,
      requireVerification: false,
      requireSelfReview: false,
      requirePlan: false,
      requireAction: false,
      servedRoute: () => ({ providerType: 'deepseek', model: 'deepseek-flash' }),
    } as never);
    return { result, events };
  }

  it('extends for a report that exists but lacks required sections', async () => {
    const script = [WRITE_REPORT, ...Array.from({ length: 20 }, (_, n) => filler(n))];
    const { result, events } = await run(script);

    // The old budget saw: named deliverable EXISTS, plan closed, ledger empty — and
    // stopped at 4. The report's shape is the remaining work.
    expect(result.steps).toBeGreaterThan(4);
    expect(events.some((line) => line.includes('close-out fact(s)'))).toBe(true);
  });

  it('stops after two silent grants instead of running to the absolute guard', async () => {
    const script = [WRITE_REPORT, ...Array.from({ length: 40 }, (_, n) => filler(n))];
    const { result, events } = await run(script);

    // 4 base + two silent grants of 4 = 12, plus at most one close-out nudge step.
    expect(result.steps).toBeLessThan(20);
    expect(events.some((line) => line.includes('moved no requirement'))).toBe(true);
    // The turn is honestly bounded, not delivered: the loop says it stopped
    // advancing the ask rather than pretending the work was finished.
    expect(result.termination).not.toBe('delivered');
  });
});
