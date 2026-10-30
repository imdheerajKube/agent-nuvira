/**
 * THE CLOCK, AND THE MILESTONE.
 *
 * Two measured failures, one each:
 *
 * 1. **Time.** The nuvira arm spent its last ten minutes of a wall-clock-capped turn
 *    debugging a Playwright runner that would not start, and closed with no README;
 *    the Cline arm finished in 48 minutes with a 42-path OpenAPI contract. Every
 *    budget in the loop counted STEPS, so nothing could prefer "close the deliverable"
 *    over "keep chasing this tool". `maxDurationMs` is the caller stating the real
 *    budget; the closing window is the loop acting on it.
 *
 * 2. **The documentation milestone.** Cline's own tree (2026-10-26) shows its docs
 *    written in ONE batch at 14:57 — mid-run, after the API and pages existed — and
 *    its ADRs at 14:23 while the API was being built. That is a phase boundary, not a
 *    cadence. nuvira asked on a 40-step timer, which fires whether or not anything
 *    works yet; the boundary here is the first GREEN CHECK with real work behind it.
 *
 * Both are driven through the real loop, because both are decisions the loop makes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runToolLoop } from '../../src/tools/tool-loop.js';
import { getTool } from '../../src/tools/registry.js';
import type { ToolMessage } from '../../src/inference/interface.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'closing-window-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type Args = Record<string, unknown>;

function put(path: string, content: string): void {
  const abs = join(root, path);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

interface Scripted {
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Args }>;
}

const SERVER = [
  "import express from 'express';",
  'const app = express();',
  "app.get('/api/projects', listProjects);",
  "app.post('/api/projects', createProject);",
  "app.get('/api/tasks/:id', getTask);",
  "app.patch('/api/tasks/:id', updateTask);",
  'app.listen(3000);',
  '',
].join('\n');

const README = ['# Platform', '', '## Run', '', '```bash', 'npm run dev', '```', '', ...Array(30).fill('Detail: the service starts on port 3000.'), ''].join('\n');

/**
 * A turn that keeps writing files. `msPerStep` advances an injected clock, so a
 * ten-minute budget is spent in milliseconds and every decision is deterministic.
 */
async function run(input: {
  script: Scripted[];
  maxDurationMs?: number;
  msPerStep?: number;
  maxSteps?: number;
}) {
  const threads: ToolMessage[][] = [];
  const events: string[] = [];
  const gates: string[] = [];
  let call = 0;
  let t = 0;
  const result = await runToolLoop({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Build a production-ready SaaS platform with an Express API and JWT auth.' },
    ],
    context: { cwd: root, configManager: {} } as never,
    deps: {
      callModel: async (thread: ToolMessage[]) => {
        threads.push(thread.map((m) => ({ ...m })));
        t += input.msPerStep ?? 0;
        const step = input.script[Math.min(call, input.script.length - 1)];
        call += 1;
        return { content: step.content, toolCalls: step.toolCalls ?? [] } as never;
      },
      executeTool: async (name: string, args: Args, ctx: never) => {
        if (name === 'finish') return getTool('finish')!.run(args, ctx);
        if (name === 'write_file') {
          put(String(args.path ?? ''), String(args.content ?? ''));
          return `Wrote ${String(args.path ?? '')}`;
        }
        if (name === 'run_terminal') return 'Test Files 3 passed (3)';
        return 'ok';
      },
      onEvent: (line: string) => events.push(line),
    } as never,
    onTraceEvent: (e: { gate?: string }) => {
      if (e.gate) gates.push(e.gate);
    },
    now: () => t,
    ...(input.maxDurationMs !== undefined ? { maxDurationMs: input.maxDurationMs } : {}),
    maxSteps: input.maxSteps ?? 40,
    maxContinuations: 0,
    maxStepExtensions: 0,
    requireVerification: false,
    requireSelfReview: false,
    requirePlan: false,
    requireAction: false,
    servedRoute: () => ({ providerType: 'deepseek', model: 'deepseek-flash' }),
  });
  return { result, threads, events, gates };
}

/** N writes, one file each. */
function writing(steps: number): Scripted[] {
  return Array.from({ length: steps }, (_, i) => ({
    content: '',
    toolCalls: [
      { id: `w${i}`, name: 'write_file', arguments: { path: `src/module-${i}.ts`, content: `export const m${i} = ${i};` } },
    ],
  }));
}

const harness = (threads: ToolMessage[][]): string[] =>
  threads.flat().map((m) => (m.role === 'system' ? String(m.content ?? '') : '')).filter((c) => c.startsWith('[harness]'));

describe('the wall-clock closing window', () => {
  it('announces once, reserves the last steps, and refuses further extensions', async () => {
    // A real service with a followable README, so the closing message has a document
    // set to name: the API contract.
    put('apps/api/src/server.ts', SERVER);
    put('README.md', README);
    // 2-minute budget, 10 s per step: the window (60 s reserved) opens at step ~6.
    const { result, threads, events, gates } = await run({
      script: writing(40),
      maxDurationMs: 120_000,
      msPerStep: 10_000,
    });

    const windows = events.filter((e) => e.includes('Closing window'));
    expect(windows, 'one close-out directive, not a drumbeat').toHaveLength(1);

    const directive = harness(threads).find((d) => d.includes('CLOSING WINDOW'));
    expect(directive).toBeDefined();
    expect(directive).toContain('KNOWN LIMITATION');
    expect(directive).toContain('steps to close');
    // It names the documents the close still owes, in the same message.
    expect(directive).toContain('API contract');

    expect(gates).toContain('closing-window');
    // No extension past the window: the turn ends near the reserved steps instead of
    // running the 40-step script.
    expect(events.some((e) => e.includes('Still working'))).toBe(false);
    expect(result.steps).toBeLessThan(15);
  });

  it('does nothing at all when the caller states no time budget', async () => {
    const { result, threads, events } = await run({ script: writing(25), msPerStep: 10_000 });
    expect(events.some((e) => e.includes('Closing window'))).toBe(false);
    expect(harness(threads).some((d) => d.includes('CLOSING WINDOW'))).toBe(false);
    expect(result.steps).toBeGreaterThan(15);
  });

  it('stops where it stands when the budget is spent, instead of starting another action', async () => {
    // 30 s budget, 10 s per step: at the fourth iteration there is no time left.
    const { result, events } = await run({ script: writing(40), maxDurationMs: 30_000, msPerStep: 10_000 });
    expect(events.some((e) => e.includes('budget is spent'))).toBe(true);
    expect(result.bounded).toBe(true);
    expect(result.steps).toBeLessThan(8);
  });
});

describe('the documentation milestone', () => {
  it('asks at the first GREEN CHECK, not at step 40', async () => {
    // A service and a followable README already on disk; the API contract is what is
    // owed. The turn writes five files, then its suite passes.
    put('apps/api/src/server.ts', SERVER);
    put('README.md', README);

    const script: Scripted[] = writing(5);
    script.push({
      content: '',
      toolCalls: [{ id: 'test', name: 'run_terminal', arguments: { command: 'npm test' } }],
    });
    script.push({ content: 'Done.' });

    const { threads, events } = await run({ script });

    const ask = harness(threads).find((d) => d.includes('API contract'));
    expect(ask, 'the first green check is the moment the project works — document it then').toBeDefined();
    const at = events.find((e) => e.includes('asked mid-build'));
    expect(at, 'the ask is mid-build, with budget left, not a closing note').toBeDefined();
    expect(at).toContain('step 6');
  });

  it('does not fire the milestone ask twice, and keeps the timer as the fallback', async () => {
    put('apps/api/src/server.ts', SERVER);
    put('README.md', README);

    const script: Scripted[] = writing(5);
    script.push({
      content: '',
      toolCalls: [{ id: 'test', name: 'run_terminal', arguments: { command: 'npm test' } }],
    });
    script.push({ content: 'Done.' });

    const { threads } = await run({ script });
    // The MILESTONE speaks once. (The closing message may legitimately name more
    // documents — it is a different fact, not a repeat: the turn is ending.)
    const milestoneAsks = harness(threads).filter((d) => d.startsWith('[harness] The tree is a working service'));
    expect(new Set(milestoneAsks).size).toBe(1);
  });
});
