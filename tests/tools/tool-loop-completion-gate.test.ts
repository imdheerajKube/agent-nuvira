/**
 * The completion gate is the direct answer to the measured 2026-10-25 run: the
 * request named tests, a README and four tracking files, the turn ended with them
 * outstanding, and every gate the loop owned was satisfied because a check HAD run.
 *
 * These tests drive the real loop with a scripted model, so what is verified is the
 * end-to-end behaviour: one bounded nudge that NAMES the gap, no nudge at all when
 * the evidence is clean, and the residual on the result either way.
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
  root = mkdtempSync(join(tmpdir(), 'completion-gate-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type Args = Record<string, unknown>;

interface Scripted {
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Args }>;
}

/**
 * Drive the loop with a script. `executeTool` really performs `write_file` (the
 * gates read the FILESYSTEM, so a stub that pretends would test nothing) and routes
 * `finish` to the real tool with the loop's own context.
 */
async function run(input: {
  ask: string;
  script: Scripted[];
  maxSteps?: number;
  maxContinuations?: number;
  maxStepExtensions?: number;
  /** Result of a `run_terminal` call — the default is a failed suite. */
  terminal?: (command: string) => string;
}) {
  const threads: ToolMessage[][] = [];
  const gates: string[] = [];
  const events: string[] = [];
  let call = 0;
  const result = await runToolLoop({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: input.ask },
    ],
    context: { cwd: root, configManager: {} } as never,
    deps: {
      callModel: async (thread: ToolMessage[]) => {
        threads.push(thread.map((m) => ({ ...m })));
        const step = input.script[Math.min(call, input.script.length - 1)];
        call += 1;
        return { content: step.content, toolCalls: step.toolCalls ?? [] } as never;
      },
      executeTool: async (name: string, args: Args, ctx: never) => {
        if (name === 'finish') return getTool('finish')!.run(args, ctx);
        if (name === 'write_file') {
          const path = String(args.path ?? '');
          const abs = join(root, path);
          mkdirSync(join(abs, '..'), { recursive: true });
          writeFileSync(abs, String(args.content ?? ''));
          return `Wrote ${path}`;
        }
        if (name === 'run_terminal') {
          return input.terminal ? input.terminal(String(args.command ?? '')) : 'Error: 3 tests failed';
        }
        return 'file body';
      },
      onEvent: (line: string) => events.push(line),
    } as never,
    onTraceEvent: (e: { gate?: string }) => {
      if (e.gate) gates.push(e.gate);
    },
    maxSteps: input.maxSteps ?? 8,
    maxContinuations: input.maxContinuations ?? 1,
    ...(input.maxStepExtensions !== undefined ? { maxStepExtensions: input.maxStepExtensions } : {}),
    requireVerification: false,
    requireSelfReview: false,
    requirePlan: false,
    requireAction: false,
    servedRoute: () => ({ providerType: 'deepseek', model: 'deepseek-flash' }),
  });
  return { result, threads, gates, events };
}

/** The harness delivers a nudge as a marked system directive (`[harness] …`). */
function nudgeContaining(threads: ToolMessage[][], needle: string): string | undefined {
  return threads
    .flat()
    .map((m) => String(m.content ?? ''))
    .find((c) => c.includes(needle));
}

const READ_ONE = { content: '', toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'src/app.ts' } }] };
const ANSWER = { content: 'I have built the platform and everything works.' };

describe('completion gate — the ask\'s own rows', () => {
  const ASK = 'Build the app. Deliver a README explaining how to run it, and run the tests so they pass.';

  it('spends ONE nudge naming the rows the turn left outstanding — and no more', async () => {
    const { gates, threads, result } = await run({ ask: ASK, script: [READ_ONE, ANSWER, ANSWER] });

    expect(gates.filter((g) => g === 'completion')).toHaveLength(1);
    const nudge = nudgeContaining(threads, 'the request asked for things');
    expect(nudge).toContain('README.md');
    expect(nudge).toContain('the test suite must actually RUN');
    // The residual reaches the caller on every ending.
    expect(result.unmetRequirements?.join(' ')).toContain('README.md');
  });

  it('does NOT fire when the turn satisfied what the ask named', async () => {
    const README = '# app\n\n' + 'Run `npm run dev` and open http://localhost:3000.\n'.repeat(40);
    const { gates, result } = await run({
      ask: 'Build the app. Deliver a README explaining how to run it.',
      script: [
        {
          content: '',
          toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'README.md', content: README } }],
        },
        ANSWER,
      ],
    });
    expect(gates).not.toContain('completion');
    expect(result.unmetRequirements).toBeUndefined();
    expect(result.requirementYield?.satisfied).toBe(1);
  });

  it('fires on a RED check — a failed suite is not "the tests pass"', async () => {
    const { threads, gates } = await run({
      ask: 'Run the tests and report whether they pass.',
      script: [
        { content: '', toolCalls: [{ id: 't1', name: 'run_terminal', arguments: { command: 'npm test' } }] },
        { content: 'All tests pass.' },
        { content: 'All tests pass.' },
      ],
    });
    expect(gates).toContain('completion');
    // The row names the command AND its verdict — the turn must answer that, not
    // restate the claim in prose.
    expect(nudgeContaining(threads, 'the request asked for things')).toContain('npm test ran and FAILED');
  });

  it('leaves a turn with NOTHING to check exactly as it was (zero cost)', async () => {
    let calls = 0;
    const { gates } = await run({
      ask: 'What does src/app.ts do?',
      script: [
        { content: '', toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'src/app.ts' } }] },
        { content: 'It exports the app.' },
      ],
    });
    expect(gates).toEqual([]);
    calls += 1;
    expect(calls).toBe(1);
  });

  it('carries an accepted verified:false claim\'s gap list into the answer', async () => {
    const { gates, result } = await run({
      ask: 'Build the app. Deliver a README explaining how to run it.',
      script: [
        {
          content: '',
          toolCalls: [
            {
              id: 'f1',
              name: 'finish',
              arguments: {
                summary: 'Built the app',
                verified: false,
                unmet: ['README could not be written — the workspace is read-only'],
              },
            },
          ],
        },
        { content: 'The app is built.' },
      ],
    });
    // A stated gap is an accepted ending: the gate does not ask again…
    expect(gates).not.toContain('completion');
    // …but it must not be swallowed. The promise the tool makes is kept here.
    expect(result.content).toContain('**Not done in this turn**');
    expect(result.content).toContain('README could not be written');
    expect(result.unmetRequirements?.join(' ')).toContain('README could not be written');
  });

  it('is silenced by an ACCEPTED finish claim', async () => {
    const { gates, threads } = await run({
      ask: 'Build the app. Deliver a README explaining how to run it.',
      // A verified claim needs an observing check, so the script runs one — and
      // it passes. The point of the test is what the ACCEPTED claim does to the
      // gate, not whether the gate can be dodged.
      terminal: () => 'ok',
      script: [
        {
          content: '',
          toolCalls: [
            { id: 'w1', name: 'write_file', arguments: { path: 'README.md', content: '# app\n\n' + 'x'.repeat(1500) } },
            { id: 't1', name: 'run_terminal', arguments: { command: 'npx tsc --noEmit' } },
          ],
        },
        {
          content: '',
          toolCalls: [{ id: 'f1', name: 'finish', arguments: { summary: 'Built it with a README', verified: true } }],
        },
        { content: 'Done — README is in place.' },
      ],
    });
    expect(gates).not.toContain('completion');
    expect(nudgeContaining(threads, 'Completion accepted')).toBeDefined();
  });

  it('puts the deployment question in front of a "production-ready" claim, and lets the model decide', async () => {
    // The 25-point documentation row, at the ONE exit that could bypass the closing
    // gates: `finish` is judged before they run, so the deployment fact has to travel
    // in the snapshot. Measured 2026-10-26 — a 9.5 KB README, API docs and
    // architecture, and no compose file, no Dockerfile, no deploy doc: 75/100.
    //
    // It is an OBSERVATION, not a refusal: "production-ready" is a phrase in the ask,
    // not proof that a compose file was promised, and the model is the one that can
    // tell the difference. The gate asks for a decision, never a lie.
    const ASK = 'Build a production-ready SaaS platform with an Express API.';
    const readme = '# App\n\n' + 'Run `npm start`.\n'.repeat(120);
    const write = (path: string, content: string) => ({
      content: '',
      toolCalls: [{ id: `w-${path}`, name: 'write_file', arguments: { path, content } }],
    });

    const observed = await run({
      ask: ASK,
      terminal: () => 'ok',
      script: [
        write('package.json', '{"scripts":{"start":"node index.js","test":"vitest run"}}'),
        write('README.md', readme),
        { content: '', toolCalls: [{ id: 't1', name: 'run_terminal', arguments: { command: 'npm test' } }] },
        { content: '', toolCalls: [{ id: 'f1', name: 'finish', arguments: { summary: 'Built it', verified: true } }] },
        { content: 'It is production-ready.' },
      ],
    });
    // The claim is not refused on a phrase, and the fact is not dropped either: the
    // tool result names the missing deployment story and says a command outranks it.
    expect(nudgeContaining(observed.threads, 'Completion accepted')).toBeDefined();
    const note = nudgeContaining(observed.threads, 'how it reaches a server') ?? '';
    expect(note).toContain('production-ready');

    // The honest ending stays open: `verified:false` + `unmet` is accepted, and the
    // gate asks for a DECISION (ship it, or say it does not ship), never a lie.
    const stated = await run({
      ask: ASK,
      terminal: () => 'ok',
      script: [
        write('package.json', '{"scripts":{"start":"node index.js","test":"vitest run"}}'),
        write('README.md', readme),
        { content: '', toolCalls: [{ id: 't1', name: 'run_terminal', arguments: { command: 'npm test' } }] },
        {
          content: '',
          toolCalls: [
            {
              id: 'f1',
              name: 'finish',
              arguments: {
                summary: 'Built the platform',
                verified: false,
                unmet: ['no deployment artefact — it runs locally only'],
              },
            },
          ],
        },
        { content: 'The platform runs locally; deployment is not included.' },
      ],
    });
    expect(nudgeContaining(stated.threads, 'Completion accepted')).toBeDefined();
    expect(nudgeContaining(stated.threads, 'Completion NOT accepted')).toBeUndefined();
  });
});

describe('observation contract — the gate is a fact the model may judge', () => {
  it('delivers the gate with the standing invitation, and records what the model did with it', async () => {
    const { result, threads, gates } = await run({
      ask: 'Build the app. Deliver a README explaining how to run it.',
      script: [
        { content: '', toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'src/a.ts', content: 'export const a = 1;\n' } }] },
        // The turn tries to end here; the gate speaks BEFORE this response reaches
        // the user, so the next response is the model's answer to it.
        { content: 'The module is written.' },
        // A judgment, not a compliance step: the model says why it does not apply.
        { content: 'This patch is to an existing module, so a README is not part of the ask.' },
        { content: 'Stopped with that judgment on the record.' },
      ],
    });

    // The gate spoke, and what it said was an observation rather than an order.
    expect(gates.length).toBeGreaterThan(0);
    const directive = nudgeContaining(threads, 'not an order') ?? '';
    expect(directive).toContain('does not apply to THIS request');

    // The model's answer is on the record, so a reader can see the gate was
    // considered — not silently obeyed and not silently ignored.
    const observations = result.observations ?? [];
    expect(observations.length).toBeGreaterThan(0);
    expect(observations[0].gate).toBeTruthy();
    expect(observations[0].directive).toBeTruthy();
    expect(observations.some((o) => (o.answer ?? '').includes('not part of the ask'))).toBe(true);
  });
});

describe('completion gate — modules this turn wrote', () => {
  it('names a new module that no test imports', async () => {
    const module = (name: string) => ({
      content: '',
      toolCalls: [
        {
          id: `w-${name}`,
          name: 'write_file',
          arguments: { path: `src/modules/${name}/service.ts`, content: `export function ${name}() { return 1; }\n` },
        },
      ],
    });
    const { gates, threads } = await run({
      ask: 'Build the app with the orders, billing and reports modules.',
      script: [module('orders'), module('billing'), module('reports'), ANSWER, ANSWER],
    });
    expect(gates).toContain('completion');
    const nudge = nudgeContaining(threads, 'the request asked for things');
    expect(nudge).toContain('no test imports it');
    expect(nudge).toMatch(/src\/modules\/(orders|billing|reports)\/service\.ts/);
  });
});

describe('completion gate — the STEP CEILING (where the measured run ended)', () => {
  it('asks for the named files at the ceiling, instead of stopping silently', async () => {
    const { gates, threads, result } = await run({
      ask: 'Build the app. Deliver a README explaining how to run it.',
      script: [
        { content: '', toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'src/a.ts', content: 'export const a = 1;\n' } }] },
        { content: '', toolCalls: [{ id: 'w2', name: 'write_file', arguments: { path: 'src/b.ts', content: 'export const b = 1;\n' } }] },
        { content: 'Ran out of steps.', toolCalls: [] },
      ],
      maxSteps: 2,
      // No continuation and no progress extension: the run reaches the CEILING,
      // which is the state the benchmark run actually ended in.
      maxContinuations: 0,
      maxStepExtensions: 0,
    });

    // Without the ceiling ask this run would end with the README unmentioned —
    // the measured failure, exactly.
    expect(gates).toContain('completion');
    expect(nudgeContaining(threads, 'the request asked for things')).toContain('README.md');
    expect(result.unmetRequirements?.join(' ')).toContain('README.md');
  });
});

describe('docs gate — quickstart duty', () => {
  it('asks for a README when the turn made the project runnable', async () => {
    const { gates, threads } = await run({
      ask: 'Build the app.',
      script: [
        {
          content: '',
          toolCalls: [
            {
              id: 'p1',
              name: 'write_file',
              arguments: { path: 'package.json', content: JSON.stringify({ scripts: { dev: 'next dev' } }) },
            },
          ],
        },
        ANSWER,
        ANSWER,
        ANSWER,
      ],
    });
    expect(gates).toContain('docs');
    const nudge = nudgeContaining(threads, 'This turn produced a runnable project');
    expect(nudge).toContain('README.md');
    expect(nudge).toContain('npm run');
  });

  it('does not fire when a real README already exists', async () => {
    writeFileSync(join(root, 'README.md'), '# app\n\n' + 'Run `npm run dev` and open the app in a browser.\n'.repeat(80));
    const { gates } = await run({
      ask: 'Build the app.',
      script: [
        {
          content: '',
          toolCalls: [
            {
              id: 'p1',
              name: 'write_file',
              arguments: { path: 'package.json', content: JSON.stringify({ scripts: { dev: 'next dev' } }) },
            },
          ],
        },
        ANSWER,
      ],
    });
    expect(gates).not.toContain('docs');
  });
});
