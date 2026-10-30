/**
 * The required-artifacts gate — a build turn may not end with the files its own
 * request named still missing.
 *
 * Measured (2026-10-25, three-agent build benchmark): nuvira finished in 14 of its
 * 30 minutes, green build and green tests, and produced no todo.md, progress.md,
 * issues.md, changelog.md or README, although the prompt named every one. The turn
 * ended because the model stopped calling tools — nothing compared the RESULT to
 * the ask. These tests pin the two halves: the gate fires (bounded to two nudges)
 * when artifacts are missing after real work, and never fires when the ask is a
 * question or the artifacts already exist.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  root = mkdtempSync(join(tmpdir(), 'artifacts-gate-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ASK = [
  'Build a SaaS platform. Maintain todo.md, progress.md, issues.md and changelog.md.',
  'Write a README and unit tests, integration tests and e2e tests.',
].join('\n');

async function run(script: Array<{ content: string; toolCalls: unknown[] }>) {
  const events: string[] = [];
  const gates: string[] = [];
  const threads: ToolMessage[][] = [];
  let call = 0;
  await runToolLoop({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: ASK },
    ],
    context: { cwd: root } as never,
    deps: {
      callModel: async (thread: ToolMessage[]) => {
        threads.push(thread.map((m) => ({ ...m })));
        const step = script[Math.min(call, script.length - 1)];
        call += 1;
        return step as never;
      },
      executeTool: async () => 'ok',
      onEvent: (line: string) => events.push(line),
    } as never,
    onTraceEvent: (e: { gate?: string }) => {
      if (e.gate) gates.push(e.gate);
    },
    maxSteps: 10,
    maxContinuations: 1,
    requireVerification: false,
    requireSelfReview: false,
    requirePlan: false,
    requireAction: false,
    servedRoute: () => ({ providerType: 'deepseek', model: 'deepseek-flash' }),
  });
  return { events, gates, threads };
}

const write = (path: string) => ({ content: '', toolCalls: [{ id: `w-${path}`, name: 'write_file', arguments: { path } }] });

describe('required-artifacts gate', () => {
  it('stops a finished build turn that left the named files missing, twice at most', async () => {
    const { gates, threads, events } = await run([
      write('src/app.ts'),
      { content: 'Implementation complete.', toolCalls: [] },
      { content: 'Implementation complete.', toolCalls: [] },
      { content: 'Implementation complete.', toolCalls: [] },
    ]);

    // Exactly two bounded nudges, then the turn ends — no spin.
    expect(gates.filter((g) => g === 'required-artifacts')).toHaveLength(2);

    // The LAST thread is the one sent after both nudges; every earlier capture
    // still contains the first one, so counting across all of them would triple it.
    const lastThread = threads[threads.length - 1];
    // This gate's own opening line, not "Before this turn ends": the adoption-kit
    // gate shares that sentence (a production-ready SaaS ask also owes a security
    // document), and counting it here would be counting another gate's message.
    const nudges = lastThread.filter((m) => String(m.content ?? '').includes('the request names artifacts that do not exist'));
    expect(nudges).toHaveLength(2);
    // The nudge names the ACTUAL missing files, not a generic "check requirements".
    expect(String(nudges[0].content)).toContain('todo.md');
    expect(String(nudges[0].content)).toContain('README.md');
    expect(String(nudges[0].content)).toContain('end-to-end tests');
    expect(events.some((e) => e.includes('📋') && e.includes('artifact'))).toBe(true);
  });

  it('does not fire when the artifacts already exist', async () => {
    put('todo.md', 'x'.repeat(60));
    put('progress.md', 'x'.repeat(60));
    put('issues.md', 'x'.repeat(60));
    put('changelog.md', 'x'.repeat(60));
    put('README.md', 'x'.repeat(60));
    put('tests/unit/a.test.ts', "it('a', () => { expect(1).toBe(1); });\n");
    put('tests/integration/b.test.ts', "it('b integration', () => { expect(1).toBe(1); });\n");
    put('e2e/c.spec.ts', "it('c e2e', () => { expect(1).toBe(1); });\n");

    const { gates } = await run([write('src/app.ts'), { content: 'Implementation complete.', toolCalls: [] }]);
    expect(gates).not.toContain('required-artifacts');
  });

  it('does not fire for a turn that never touched the workspace', async () => {
    const { gates } = await run([{ content: 'Here is what that repository does: …', toolCalls: [] }]);
    expect(gates).not.toContain('required-artifacts');
  });
});
