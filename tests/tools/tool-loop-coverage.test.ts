/**
 * The assessment's dry round is not allowed to end a NARROW audit.
 *
 * Measured (2026-10-25, Cline head-to-head): nuvira spent its budget on the seams
 * it had touched and stopped, having opened a fraction of the tree — 19 defects
 * against Cline's 24, with the gap in files it declared "not covered". The old
 * plan asked the model to read more; this gate spends ONE bounded reading round,
 * and only when the ledger can name what is unread (coverage below target, or a
 * read file importing a file never opened). Two rounds maximum, and a round that
 * opens nothing new ends the turn.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runToolLoop } from '../../src/tools/tool-loop.js';
import type { ToolMessage } from '../../src/inference/interface.js';

let root = '';

function put(path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coverage-gate-'));
  // a → b → c, plus two modules the audit would have to open to be broad.
  put('src/a.ts', "import { b } from './b';\nexport const a = b;\n");
  put('src/b.ts', "import { c } from './c';\nexport const b = c;\n");
  put('src/c.ts', 'export const c = 1;\n');
  put('src/other.ts', 'export const other = 1;\n');
  put('src/last.ts', 'export const last = 1;\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ASK = 'Audit this project for defects and report every bug you find with file and line.';

/**
 * A model that reports ONE finding and then keeps reading (cycling the list), so
 * the turn always reaches its step bound — which is where the gate lives.
 */
function reader(files: string[]) {
  let call = 0;
  return async () => {
    call += 1;
    if (call === 1) {
      return {
        content: 'BUG-01 - HIGH - the archive is extracted into the wrong directory (src/a.ts:2)',
        toolCalls: [{ id: 'r0', name: 'read_file', arguments: { path: files[0] } }],
      };
    }
    const path = files[(call - 1) % files.length];
    return { content: '', toolCalls: [{ id: `r${call}`, name: 'read_file', arguments: { path } }] };
  };
}

async function run(callModel: () => Promise<unknown>, maxSteps: number) {
  const events: string[] = [];
  const gates: string[] = [];
  const threads: ToolMessage[][] = [];
  await runToolLoop({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: ASK },
    ],
    context: { cwd: root } as never,
    deps: {
      callModel: async (thread: ToolMessage[]) => {
        threads.push(thread.map((m) => ({ ...m })));
        return (await callModel()) as never;
      },
      executeTool: async (name: string) => (name === 'read_file' ? 'file body' : 'ok'),
      onEvent: (line: string) => events.push(line),
    } as never,
    onTraceEvent: (e: { gate?: string }) => {
      if (e.gate) gates.push(e.gate);
    },
    maxSteps,
    maxContinuations: 1,
    requireVerification: false,
    requireSelfReview: false,
    requirePlan: false,
    requireAction: false,
    servedRoute: () => ({ providerType: 'deepseek', model: 'deepseek-flash' }),
  });
  return { events, gates, threads };
}

describe('coverage gate — a dry round on a narrow audit', () => {
  it('grants a bounded reading round and names the unread dependency', async () => {
    const { gates, threads, events } = await run(reader(['src/a.ts', 'src/b.ts']), 2);

    expect(gates).toContain('coverage');
    // The message the model received names a file→file edge, not "read more".
    const nudges = threads.flat().filter((m) => String(m.content ?? '').startsWith('[coverage check'));
    expect(nudges.length).toBeGreaterThanOrEqual(1);
    expect(String(nudges[0].content)).toContain('`src/b.ts` → `src/c.ts`');
    // …and the run says so, with the numbers, in its own log.
    expect(events.some((e) => e.includes('📚 Coverage') && e.includes('source files'))).toBe(true);
  });

  it('caps the reading rounds at 2 and then stops (no unbounded spending)', async () => {
    // A tree big enough that coverage stays low while every round still opens
    // something NEW — so the stop condition is the CAP, not a bought-nothing round.
    const many = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`);
    for (const f of many) put(f, 'export const x = 1;\n');
    const { gates } = await run(reader(many), 2);
    expect(gates.filter((g) => g === 'coverage')).toHaveLength(2);
  });

  it('does NOT fire once the tree is broadly read and the frontier is empty', async () => {
    // Every source file opened before the bound: the dry round is a real end,
    // and the coverage gate must not invent work.
    const all = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/other.ts', 'src/last.ts'];
    let call = 0;
    const { gates, threads } = await run(async () => {
      call += 1;
      if (call === 1) {
        return {
          content: 'BUG-01 - HIGH - a real defect (src/a.ts:1)',
          toolCalls: [{ id: 'r0', name: 'read_file', arguments: { path: all[0] } }],
        };
      }
      const next = all[call - 1];
      if (next) return { content: '', toolCalls: [{ id: `r${call}`, name: 'read_file', arguments: { path: next } }] };
      return { content: 'Audit finished.', toolCalls: [] };
    }, 7);

    expect(gates).not.toContain('coverage');
    expect(threads.flat().some((m) => String(m.content ?? '').startsWith('[coverage check'))).toBe(false);
  });
});
