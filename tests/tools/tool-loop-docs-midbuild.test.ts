/**
 * Documentation is asked for MID-BUILD, not at the ceiling.
 *
 * The measured 2026-10-26 failure this pins: a 210-step benchmark turn wrote 89
 * files and 14.9 K lines, and the README nudge arrived at step 209 — one step
 * before the step ceiling — so the documentation row was scored 45/100 with no
 * README in the tree. Every arm of every round failed the same row the same way,
 * because documentation is the deliverable that gets deferred to "the end".
 *
 * So there are two assertions here, and the second is the point of the first: the
 * duty has to SPEAK EARLY (step 40, while there is budget), and a short turn that
 * never reaches step 40 still has to be told at the close.
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
  root = mkdtempSync(join(tmpdir(), 'docs-midbuild-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type Args = Record<string, unknown>;

/**
 * Drive the loop for `steps` calls, each one writing a real file. The filesystem
 * is really written (`write_file`), because the duty reads the TREE: a stub would
 * prove nothing about what the gate can see.
 */
async function run(input: { ask: string; steps: number; files: string[] }) {
  const events: string[] = [];
  const gates: string[] = [];
  const threads: ToolMessage[][] = [];
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
        const step = call;
        call += 1;
        if (step >= input.steps) return { content: 'All done.', toolCalls: [] } as never;
        const path = input.files[step % input.files.length];
        // Arguments are OBJECTS here, exactly as the real adapter hands them over:
        // a string would arrive as `{0:…}` and the write would be refused, which
        // would make this test pass for the wrong reason.
        return {
          content: '',
          toolCalls: [{ id: `w${step}`, name: 'write_file', arguments: { path, content: '// work\n'.repeat(20) } }],
        } as never;
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
        return 'ok';
      },
      onEvent: (line: string) => events.push(line),
    } as never,
    onTraceEvent: (e: { gate?: string }) => {
      if (e.gate) gates.push(e.gate);
    },
    maxSteps: input.steps + 4,
    maxContinuations: 0,
    maxStepExtensions: 0,
    requireVerification: false,
    requireSelfReview: false,
    requirePlan: false,
    requireAction: false,
    servedRoute: () => ({ providerType: 'deepseek', model: 'deepseek-flash' }),
  });
  return { result, events, gates, threads };
}

/** Every `[harness]` directive the model was actually sent, in order. */
function directives(threads: ToolMessage[][]): string[] {
  const seen: string[] = [];
  for (const thread of threads) {
    for (const m of thread) {
      if (m.role === 'system' && String(m.content).startsWith('[harness] ')) {
        const text = String(m.content);
        if (!seen.includes(text)) seen.push(text);
      }
    }
  }
  return seen;
}

describe('the documentation duty speaks while there is still budget', () => {
  it('asks for the quickstart at step 40 of a long turn — not at the end', async () => {
    const { threads, events, gates } = await run({
      ask: 'Build the service and document how to run it.',
      steps: 44,
      files: ['package.json', 'src/index.ts', 'src/db.ts'],
    });

    const readme = directives(threads).filter((d) => d.includes('did not document how to run it'));
    expect(readme, 'the turn produced a runnable project and must be asked for a README').toHaveLength(1);
    // It arrived MID-BUILD: the model saw it with steps left, not as the closing note.
    expect(events.some((e) => e.includes('asked mid-build'))).toBe(true);
    expect(gates.filter((g) => g === 'docs')).toHaveLength(1);
    // …and the directive is a harness instruction, not a user turn it would answer.
    expect(readme[0].startsWith('[harness] ')).toBe(true);
  });

  it('still asks at the close when the turn ends before the mid-build mark', async () => {
    const { threads } = await run({
      ask: 'Build the service and document how to run it.',
      steps: 3,
      files: ['package.json', 'src/index.ts', 'src/db.ts'],
    });

    const readme = directives(threads).filter((d) => d.includes('did not document how to run it'));
    expect(readme).toHaveLength(1);
  });

  it('repeats the ask ONCE when a long turn ignored the first one', async () => {
    // Measured 2026-10-27 (benchmark re-run): the quickstart ask landed at step 40,
    // the model wrote 20 more backend files, never mentioned the README again, and
    // the turn ran to its wall-clock cap with `readmeBytes: 0`. A single ask in a
    // 600-call turn is droppable; the duty must be able to say it twice — and only
    // twice, or it becomes the nag the bound exists to prevent.
    const { threads, events, gates } = await run({
      ask: 'Build the service and document how to run it.',
      steps: 130,
      files: ['package.json', 'src/index.ts', 'src/db.ts'],
    });

    // Count OCCURRENCES, not distinct texts: the repeat deliberately says the same
    // thing again, so a unique-text filter would see one and hide the fix.
    const lastThread = threads[threads.length - 1] ?? [];
    const readme = lastThread.filter(
      (m) => m.role === 'system' && String(m.content).startsWith('[harness] ') && String(m.content).includes('did not document how to run it'),
    );
    expect(readme, 'the ignored ask is repeated, and the bound still holds at two').toHaveLength(2);
    expect(events.filter((e) => e.includes('asked mid-build'))).toHaveLength(2);
    expect(gates.filter((g) => g === 'docs')).toHaveLength(2);
  });

  it('says nothing when the tree already has a real README', async () => {
    writeFileSync(join(root, 'README.md'), '# Service\n\n## Run\n\n```bash\nnpm start\n```\n' + 'detail\n'.repeat(300));
    const { threads, gates } = await run({
      ask: 'Build the service and document how to run it.',
      steps: 44,
      files: ['package.json', 'src/index.ts', 'src/db.ts'],
    });

    expect(directives(threads).filter((d) => d.includes('did not document how to run it'))).toHaveLength(0);
    expect(gates.filter((g) => g === 'docs')).toHaveLength(0);
  });
});
