/**
 * The gates added after the 2026-10-26 re-bench, driven through the REAL loop.
 *
 * Three measured failures, one mechanism each:
 *
 *   1. A 210-step build reached its ceiling with every artifact gate satisfied and
 *      NO FRONTEND — nothing asked about a part that was absent rather than
 *      incomplete. (`deliverables`)
 *   2. `CHANGE_REQUEST.md` had been written into the workspace by the benchmark
 *      harness for two rounds and no agent ever mentioned it, so the adaptability
 *      aspect could not be exercised at all. (`change-request`)
 *   3. The same prompt earned 178, 115 and 210 steps depending on which hardcoded
 *      extension cap the build happened to carry — the LOWEST budget produced the
 *      worst delivery. A build's length is a property of the ask, so the budget now
 *      ends on a requirement fact (satisfied, or stalled), not on a count.
 *      (`requirementDrivenBudget`)
 *
 * These are end-to-end: the gates read the FILESYSTEM, so the scripted model really
 * writes files. A stub that pretends would test nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runToolLoop } from '../../src/tools/tool-loop.js';
import { getTool } from '../../src/tools/registry.js';
import { missingSurfaceGaps } from '../../src/learning/deliverable-coverage.js';
import {
  changeRequestStatus,
  distinctiveWords,
  readChangeRequest,
} from '../../src/learning/change-request.js';
import type { ToolMessage } from '../../src/inference/interface.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deliverable-gate-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type Args = Record<string, unknown>;

interface Scripted {
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Args }>;
}

function put(path: string, content: string): void {
  const abs = join(root, path);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

async function run(input: {
  ask: string;
  script: Scripted[];
  maxSteps?: number;
  maxContinuations?: number;
  maxStepExtensions?: number;
  requirementDrivenBudget?: boolean;
  /** Runs after the Nth model call returns, before its tools execute. */
  between?: (call: number) => void;
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
        input.between?.(call);
        return { content: step.content, toolCalls: step.toolCalls ?? [] } as never;
      },
      executeTool: async (name: string, args: Args, ctx: never) => {
        if (name === 'finish') return getTool('finish')!.run(args, ctx);
        if (name === 'write_file') {
          put(String(args.path ?? ''), String(args.content ?? ''));
          return `Wrote ${String(args.path ?? '')}`;
        }
        if (name === 'run_terminal') return 'Error: 3 tests failed';
        return 'file body';
      },
      onEvent: (line: string) => events.push(line),
    } as never,
    onTraceEvent: (e: { gate?: string }) => {
      if (e.gate) gates.push(e.gate);
    },
    maxSteps: input.maxSteps ?? 4,
    maxContinuations: input.maxContinuations ?? 1,
    ...(input.maxStepExtensions !== undefined ? { maxStepExtensions: input.maxStepExtensions } : {}),
    ...(input.requirementDrivenBudget !== undefined
      ? { requirementDrivenBudget: input.requirementDrivenBudget }
      : {}),
    requireVerification: false,
    requireSelfReview: false,
    requirePlan: false,
    requireAction: false,
    servedRoute: () => ({ providerType: 'deepseek', model: 'deepseek-flash' }),
  });
  return { result, threads, gates, events };
}

const directives = (threads: ToolMessage[][]): string[] =>
  threads.flat().map((m) => String(m.content ?? '')).filter((c) => c.includes('[harness]'));

const BUILD_ASK =
  'Build a production-ready SaaS platform. Requirements: Next.js frontend, Node.js backend, ' +
  'PostgreSQL, JWT auth, an admin dashboard. Write a README.';

const WRITE_API = {
  content: '',
  toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'apps/api/src/server.ts', content: 'export const app = 1;' } }],
};
const WRITE_WEB = {
  content: '',
  toolCalls: [{ id: 'w2', name: 'write_file', arguments: { path: 'apps/web/src/app/page.tsx', content: 'export default function Page() { return null; }' } }],
};
const ANSWER = { content: 'The platform is complete and production ready.' };

describe('missingSurfaceGaps — the ask names it, the tree lacks it', () => {
  it('reports a frontend when only an API exists', () => {
    put('apps/api/src/server.ts', 'export const app = 1;');
    const gaps = missingSurfaceGaps({ ask: BUILD_ASK, cwd: root });
    expect(gaps.map((g) => g.id)).toContain('frontend');
  });

  it('accepts a dependency line as NO evidence: "next" in package.json is not a UI', () => {
    put('apps/web/package.json', JSON.stringify({ dependencies: { next: '15.0.0' } }));
    put('apps/api/src/server.ts', 'export const app = 1;');
    const gaps = missingSurfaceGaps({ ask: BUILD_ASK, cwd: root });
    // The measured false positive: the benchmark's own scorer credited a frontend
    // to a tree whose apps/web held nothing but this file.
    expect(gaps.map((g) => g.id)).toContain('frontend');
  });

  it('is silent once every surface the ask named exists', () => {
    put('apps/api/src/server.ts', 'export const app = 1;');
    put('apps/web/src/app/page.tsx', 'export default function Page() { return null; }');
    put('apps/api/migrations/001_init.sql', 'create table users (id uuid primary key);');
    expect(missingSurfaceGaps({ ask: BUILD_ASK, cwd: root })).toHaveLength(0);
  });

  it('sees a backend and a database in ANY language, not only JS/TS filenames', () => {
    // Measured 2026-10-30 (GREENFIELD-API, the head-to-head): a working stdlib
    // Python service was reported as missing "backend / API" and "database /
    // schema" — twice, AFTER `finish` had been accepted — because every evidence
    // pattern was a JS/TS filename (`server.ts`, `schema.prisma`, `migrations/`).
    // The model then spent closing steps running `ls server.py` to prove its server
    // existed. Evidence has to include the code that IS the surface.
    put('server.py', [
      'import sqlite3',
      'from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer',
      '',
      'db = sqlite3.connect("notes.db")',
      'db.execute("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY)")',
      '',
      'class Handler(BaseHTTPRequestHandler):',
      '    pass',
      '',
      'ThreadingHTTPServer(("127.0.0.1", 0), Handler).serve_forever()',
      '',
    ].join('\n'));
    const ask = 'Build a JSON HTTP API with a sqlite database and token auth.';
    expect(missingSurfaceGaps({ ask, cwd: root }).map((g) => g.id)).toEqual([]);
  });

  it('still reports a backend the ask named when the tree only has docs', () => {
    // The looser evidence must not make the surface free: prose is not a server.
    put('README.md', 'This will be a REST API with a postgres database.\n');
    put('notes.md', 'We plan to expose a REST API.\n');
    const gaps = missingSurfaceGaps({ ask: 'Build a REST API with a postgres database.', cwd: root });
    expect(gaps.map((g) => g.id)).toContain('backend');
    expect(gaps.map((g) => g.id)).toContain('database');
  });

  it('never fires on a question or a narrow change request', () => {
    expect(missingSurfaceGaps({ ask: 'What does the Next.js frontend do?', cwd: root })).toHaveLength(0);
    // Build-shaped (a product noun), but nothing is being CREATED.
    expect(missingSurfaceGaps({ ask: 'Fix the login bug in the React app.', cwd: root })).toHaveLength(0);
  });
});

describe('closing gate — deliverables', () => {
  it('asks for the frontend the ask named, and names what it looked for', async () => {
    const { gates, threads } = await run({
      ask: BUILD_ASK,
      script: [WRITE_API, ANSWER, ANSWER, ANSWER],
      maxSteps: 2,
    });
    // Bounded to two, like the artifacts gate: a build can be missing more than one
    // surface, and one message listing them is often acted on partially.
    const asks = gates.filter((g) => g === 'deliverables').length;
    expect(asks).toBeGreaterThanOrEqual(1);
    expect(asks).toBeLessThanOrEqual(2);
    const nudge = directives(threads).find((d) => d.includes('parts of the product that do not exist'));
    expect(nudge).toBeDefined();
    expect(nudge).toContain('frontend / UI');
    expect(nudge).toContain('no `next.config.*`');
  });

  it('asks MID-BUILD at step 40, not only at the end — a gate that speaks after the budget is spent is a receipt', async () => {
    // Real progress every step (a NEW file each time) so the turn never stalls —
    // this is a build that is busy, not a loop that is spinning.
    const script: Scripted[] = Array.from({ length: 45 }, (_, i) => ({
      content: '',
      toolCalls: [
        { id: `w${i}`, name: 'write_file', arguments: { path: `apps/api/src/module-${i}.ts`, content: 'export const m = 1;' } },
      ],
    }));
    const { threads, events } = await run({
      ask: BUILD_ASK,
      script,
      maxSteps: 3,
      maxContinuations: 0,
    });
    expect(events.some((e) => e.includes('Still missing frontend / UI'))).toBe(true);
    expect(directives(threads).some((d) => d.includes('parts of the product that do not exist'))).toBe(true);
  });

  it('stays silent when every named surface exists', async () => {
    put('apps/api/src/server.ts', 'export const app = 1;');
    put('apps/api/migrations/001_init.sql', 'create table users (id uuid primary key);');
    const { gates } = await run({
      ask: BUILD_ASK,
      script: [WRITE_WEB, ANSWER, ANSWER],
      maxSteps: 2,
    });
    expect(gates).not.toContain('deliverables');
  });
});

describe('change request — the requirement that arrives mid-turn', () => {
  const CR = [
    '# Requirement change — Teams replace Projects',
    '',
    '- Users now need TEAMS instead of Projects.',
    '- Every task belongs to a team.',
    '',
  ].join('\n');

  it('delivers a mid-turn change to the model the moment it appears', async () => {
    const { threads } = await run({
      ask: 'Build the app with docs.',
      script: [WRITE_API, WRITE_API, ANSWER, ANSWER, ANSWER],
      maxSteps: 6,
      // The harness writes the file while the turn is running — exactly what
      // scripts/bench/platform/inject-events.mjs does.
      between: (call) => {
        if (call === 1) put('CHANGE_REQUEST.md', CR);
      },
    });
    const delivered = directives(threads).find((d) => d.includes('A CHANGE REQUEST arrived'));
    expect(delivered).toBeDefined();
    expect(delivered).toContain('Teams replace Projects');
    // The directive must carry the requirement, not a pointer to it.
    expect(delivered).toContain('Users now need TEAMS instead of Projects.');
  });

  it('reports the bullets the tree never heard, and says which', async () => {
    put('CHANGE_REQUEST.md', CR);
    const request = readChangeRequest(root)!;
    const status = changeRequestStatus({ cwd: root, request, treeText: 'export const app = 1;' });
    expect(status.unheard).toContain('Users now need TEAMS instead of Projects.');

    const answered = changeRequestStatus({
      cwd: root,
      request,
      treeText: 'model team { members } // teams own tasks; team_id on every task',
    });
    expect(answered.unheard).toHaveLength(0);
  });

  it('is silent when there is no change request', () => {
    expect(readChangeRequest(root)).toBeNull();
  });

  it('ignores the request file itself as evidence (it mentions every word)', () => {
    put('CHANGE_REQUEST.md', CR);
    const request = readChangeRequest(root)!;
    const status = changeRequestStatus({ cwd: root, request });
    expect(status.unheard.length).toBe(request.bullets.length);
  });

  it('keeps stopwords out of "distinctive", so prose glue cannot fake adaptation', () => {
    const words = distinctiveWords('Users now need TEAMS instead of Projects.');
    expect(words).toContain('teams');
    expect(words).toContain('projects');
    expect(words).not.toContain('now');
    expect(words).not.toContain('instead');
  });
});

describe('requirement-driven budget — the ask decides when the turn is done', () => {
  /**
   * A build that keeps producing NEW work while an ask-named artifact is still
   * missing must not be cut off at a count. The script writes eleven distinct files
   * and never writes the README the ask named, so the ledger keeps an open row.
   */
  it('extends past the old extension cap while requirements are still moving', async () => {
    const ask = 'Build the app and write a README that explains how to run it.';
    const script: Scripted[] = Array.from({ length: 11 }, (_, i) => ({
      content: '',
      toolCalls: [
        { id: `w${i}`, name: 'write_file', arguments: { path: `src/module-${i}.ts`, content: `export const x${i} = ${i};` } },
      ],
    }));
    script.push(ANSWER);

    const { result, events } = await run({
      ask,
      script,
      maxSteps: 3,
      maxContinuations: 1,
    });

    // The fixed cap (3 base + 16 continuation + 16 extension) would have stopped at
    // step 3. This turn ran the whole script, because every step moved a file and a
    // requirement row was still open.
    expect(result.steps).toBeGreaterThan(3);
    expect(events.some((e) => e.includes('no fixed cap: the ask decides'))).toBe(true);
  });

  it('stops on a STALL, not on a count: two granted rounds that move nothing', async () => {
    const ask = 'Build the app and write a README that explains how to run it.';
    // A read that always succeeds but writes nothing and satisfies no row: the old
    // loop would call this "progress" forever. The script repeats its last entry, so
    // 40 identical reads is enough to reach two grants that moved nothing.
    const READ = {
      content: '',
      toolCalls: [{ id: 'r', name: 'read_file', arguments: { path: 'src/app.ts' } }],
    };
    const { events, result } = await run({
      ask,
      script: Array.from({ length: 40 }, () => READ),
      maxSteps: 3,
      maxContinuations: 0,
    });
    expect(events.some((e) => e.includes('moved no requirement'))).toBe(true);
    expect(result.bounded).toBe(true);
    // It stopped well before the absolute escape hatch: a stall is a fact, not a cap.
    expect(result.steps).toBeLessThan(60);
  });
});
