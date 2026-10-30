/**
 * THE ADOPTION KIT, DRIVEN THROUGH THE REAL LOOP.
 *
 * The unit tests pin the FACT (`missingAdoptionItems`). These pin the THING THE
 * BENCHMARK MEASURED: the fact has to reach the model while there is still budget,
 * and the turn must not end without a handover a stranger could follow.
 *
 * The tree is real — a service file, a followable README and a Dockerfile are placed
 * on disk before the turn starts, because the duties read the FILESYSTEM. That is
 * also how the ordering is pinned: with those two documents present, the next thing
 * the duty owes is the API contract, in that order, not at random.
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
  root = mkdtempSync(join(tmpdir(), 'adoption-gate-'));
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

const ASK =
  'Build a production-ready SaaS platform: a Next.js frontend and an Express API with JWT auth, ' +
  'PostgreSQL and multi-tenant projects.';

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

const README = [
  '# Platform',
  '',
  '## Run',
  '',
  '```bash',
  'npm install',
  'npm run dev',
  '```',
  '',
  '## Environment variables',
  '',
  '`DATABASE_URL` points at Postgres; `JWT_SECRET` signs access tokens.',
  '',
  ...Array.from({ length: 30 }, (_, i) => `Detail line ${i}: the service starts on port 3000.`),
  '',
].join('\n');

/**
 * The two documents the earlier duties own, present so the kit is what is left.
 *
 * `opsInReadme: false` keeps the README followable (so the quickstart duty is
 * satisfied) while removing the operations section, which is what a README that only
 * says how to start the dev server actually looks like.
 */
function placeAdoptableBase(opts: { opsInReadme?: boolean } = {}): void {
  put('apps/api/src/server.ts', SERVER);
  put(
    'README.md',
    opts.opsInReadme === false
      ? README.replace(/## Environment variables[\s\S]*?(?=\nDetail line)/, '')
      : README,
  );
  put('Dockerfile', 'FROM node:20\nWORKDIR /app\nCMD ["node","dist/server.js"]\n');
}

interface Scripted {
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Args }>;
}

async function run(input: { ask?: string; script: Scripted[]; steps: number }) {
  const threads: ToolMessage[][] = [];
  const gates: string[] = [];
  const events: string[] = [];
  let call = 0;
  const result = await runToolLoop({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: input.ask ?? ASK },
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
          put(String(args.path ?? ''), String(args.content ?? ''));
          return `Wrote ${String(args.path ?? '')}`;
        }
        return 'ok';
      },
      onEvent: (line: string) => events.push(line),
    } as never,
    onTraceEvent: (e: { gate?: string }) => {
      if (e.gate) gates.push(e.gate);
    },
    maxSteps: input.steps,
    maxContinuations: 0,
    maxStepExtensions: 0,
    requireVerification: false,
    requireSelfReview: false,
    requirePlan: false,
    requireAction: false,
    servedRoute: () => ({ providerType: 'deepseek', model: 'deepseek-flash' }),
  });
  return { result, threads, gates, events };
}

/** Every `[harness]` directive the model was handed, in order. */
const directives = (threads: ToolMessage[][]): string[] =>
  threads.flat().map((m) => (m.role === 'system' ? String(m.content ?? '') : '')).filter((c) => c.startsWith('[harness]'));

/** A build that keeps writing real files and never writes a document. */
function building(steps: number): Scripted[] {
  return Array.from({ length: steps }, (_, i) => ({
    content: '',
    toolCalls: [
      {
        id: `w${i}`,
        name: 'write_file',
        arguments: {
          path: i === 0 ? 'package.json' : `apps/api/src/module-${i}.ts`,
          content: i === 0 ? JSON.stringify({ name: 'app', scripts: { dev: 'next dev' } }) : `export const m${i} = ${i};`,
        },
      },
    ],
  }));
}

describe('the adoption kit reaches the model', () => {
  it('asks for the API contract MID-BUILD at step 40, with steps left to write it', async () => {
    placeAdoptableBase();
    const { threads, events, gates } = await run({ script: building(45), steps: 45 });

    const contract = directives(threads).find((d) => d.includes('API contract'));
    expect(contract, 'a 45-step service build must be asked for a contract while there is budget').toBeDefined();
    expect(contract).toContain('4 route registration(s) found in the files read');
    expect(contract).toContain('openapi.yaml');
    // It arrived as a harness instruction mid-build, not as the closing note.
    expect(events.some((e) => e.includes('asked mid-build'))).toBe(true);
    expect(gates).toContain('docs');
  });

  it('names the one most useful document mid-build, not the whole checklist', async () => {
    placeAdoptableBase();
    const { threads } = await run({ script: building(45), steps: 45 });
    const asked = directives(threads).find((d) => d.includes('API contract'))!;
    // The mid-build ask is about the contract alone: three requirements at once is
    // the message a model skims.
    expect(asked).not.toContain('decision records');
    expect(asked).not.toContain('SECURITY.md');
  });

  it('delivers the whole remaining set as one handover when the turn closes early', async () => {
    placeAdoptableBase({ opsInReadme: false });
    const { threads, events } = await run({
      script: [
        {
          content: '',
          toolCalls: [{ id: 'p', name: 'write_file', arguments: { path: 'package.json', content: '{"name":"app"}' } }],
        },
        { content: 'The platform is complete and production ready.' },
      ],
      steps: 4,
    });

    const handover = directives(threads).find((d) => d.includes('documents are missing'));
    expect(handover).toBeDefined();
    // Three, not four: this ask never mentions decisions/ADRs, and the kit does not
    // invent a requirement the user did not make.
    expect(handover).toContain('3 documents are missing');
    for (const label of ['API contract', 'operations', 'security']) {
      expect(handover).toContain(label);
    }
    expect(handover).not.toContain('decision records');
    expect(events.some((e) => e.includes('missing'))).toBe(true);
  });

  it('is silent once every document exists in an honest form', async () => {
    placeAdoptableBase();
    put(
      'docs/openapi.yaml',
      'openapi: 3.0.0\ninfo: { title: Platform }\npaths:\n  /api/projects:\n    get: {}\n',
    );
    put('SECURITY.md', '# Security\n\nTokens are verified per request; tenants are isolated by `tenant_id`.\n');
    put('docs/adr/0001-postgres.md', '# Postgres\n\n## Decision\n\nPostgres.\n');

    const { threads, gates } = await run({ script: building(45), steps: 45 });
    expect(gates).not.toContain('docs');
    expect(directives(threads).some((d) => d.includes('API contract'))).toBe(false);
  });

  it('puts the README first — a reader cannot run it, so no other document competes', async () => {
    put('apps/api/src/server.ts', SERVER);
    put('Dockerfile', 'FROM node:20\n');
    const { threads, events } = await run({ script: building(45), steps: 45 });

    // The turn's LAST thread, because a directive stays in the thread once pushed:
    // counting across every snapshot would count the same message many times.
    const last = threads[threads.length - 1] ?? [];
    const docsDirectives = last.filter(
      (m) => m.role === 'system' && m.content.startsWith('[harness]') && m.content.includes('did not document how to run it'),
    );
    expect(docsDirectives.length).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e.includes('asked mid-build')).length).toBeGreaterThanOrEqual(1);
    // The contract is a later fact, not a competing message at the same step.
    expect(directives([last]).some((d) => d.includes('API contract'))).toBe(false);
  });
});
