/**
 * Wiring — the two ledgers, driven through the REAL loop.
 *
 * The unit tests prove each ledger works; this file proves something the unit
 * tests cannot: that a turn which actually reads a file LEAVES a record the next
 * turn sees, and that a settled finding from an earlier run reaches the project
 * context of the next one. Without this, both ledgers could be correct and called
 * by nobody — which is the failure mode this whole exercise is about.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runToolLoop, type ToolLoopDeps, type StepResponse } from '../../src/tools/tool-loop.js';
import type { ToolContext } from '../../src/tools/registry.js';
import { coverageFor, getWorkingState, workingStateBlock } from '../../src/learning/working-state.js';
import { beginTrace, endTrace, recordTraceFindings } from '../../src/learning/reasoning-trace.js';
import { confirmFinding, plausibleFinding, toWire } from '../../src/findings/verdicts.js';
import { buildLoopProjectContext } from '../../src/tools/loop-project-context.js';

let memoryDir: string;
let project: string;
let previousMemory: string | undefined;

beforeEach(() => {
  memoryDir = mkdtempSync(join(tmpdir(), 'nuvira-wiring-mem-'));
  previousMemory = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = memoryDir;

  project = mkdtempSync(join(tmpdir(), 'nuvira-wiring-proj-'));
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(project, 'package.json'), '{"name":"wiring-fixture"}\n');
});

afterEach(() => {
  if (previousMemory === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = previousMemory;
  rmSync(memoryDir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function depsFor(script: StepResponse[]): ToolLoopDeps {
  const callModel = vi.fn();
  let i = 0;
  callModel.mockImplementation(async () => script[Math.min(i++, script.length - 1)]);
  return {
    callModel,
    executeTool: vi.fn(async (name: string) =>
      name === 'read_file' ? 'export const a = 1;' : `executed ${name}`,
    ),
    onEvent: vi.fn(),
  } as unknown as ToolLoopDeps;
}

const ctx: ToolContext = { configManager: {} } as ToolContext;

describe('coverage, written by a real turn', () => {
  it('records a read_file at read depth, stamped with the run id', async () => {
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: join(project, 'src', 'a.ts') } }] },
      { content: 'Read it.', toolCalls: [] },
    ];

    await runToolLoop({
      messages: [{ role: 'user', content: 'what does a.ts do?' }],
      context: { ...ctx, cwd: project } as ToolContext,
      deps: depsFor(script),
      runId: 'trace-wiring',
      maxSteps: 3,
    });

    const entry = getWorkingState(project)?.coverage?.['src/a.ts'];
    expect(entry?.depth).toBe('read');
    expect(entry?.runId).toBe('trace-wiring');
    // The record is written and still describes the file that is on disk.
    expect(coverageFor(project).find((c) => c.path === 'src/a.ts')?.stale).toBe(false);
  });

  it('makes the next turn cheaper: the examined path is in ITS block', async () => {
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: join(project, 'src', 'a.ts') } }] },
      { content: 'Read it.', toolCalls: [] },
    ];
    await runToolLoop({
      messages: [{ role: 'user', content: 'what does a.ts do?' }],
      context: { ...ctx, cwd: project } as ToolContext,
      deps: depsFor(script),
      maxSteps: 3,
    });

    const block = workingStateBlock(project);
    expect(block).toContain('Already examined');
    expect(block).toContain('src/a.ts (read');
  });

  it('does not claim a read that FAILED', async () => {
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: join(project, 'src', 'missing.ts') } }] },
      { content: 'It is not there.', toolCalls: [] },
    ];
    const deps = depsFor(script);
    (deps as { executeTool: unknown }).executeTool = vi.fn(async () => 'Error: file not found');

    await runToolLoop({
      messages: [{ role: 'user', content: 'read missing.ts' }],
      context: { ...ctx, cwd: project } as ToolContext,
      deps,
      maxSteps: 3,
    });

    expect(getWorkingState(project)?.coverage?.['src/missing.ts']).toBeUndefined();
  });
});

describe('breadth of an edit, stated to a build turn', () => {
  it('names the unopened caller of a changed file once, and does not loop on it', async () => {
    // b.ts is the file the turn edits; a.ts calls it and is never opened.
    writeFileSync(join(project, 'src', 'a.ts'), "import { b } from './b';\nexport const a = b;\n");
    writeFileSync(join(project, 'src', 'b.ts'), 'export const b = 1;\n');

    // A plan first: the loop refuses a file write before one is declared, which is
    // its own gate doing its job — the test drives the real sequence.
    const script: StepResponse[] = [
      {
        content: '',
        toolCalls: [
          { id: 'p1', name: 'plan_todo', arguments: { action: 'create', goal: 'rename the export', steps: ['change b.ts', 'check callers'] } },
          { id: 'c1', name: 'write_file', arguments: { path: join(project, 'src', 'b.ts'), content: 'export const b = 2;\n' } },
        ],
      },
      { content: 'Changed b.', toolCalls: [] },
    ];
    // Snapshot each thread: the loop mutates ONE array in place, so a recorded
    // `call[0]` reference would show the final state for every call.
    const snapshots: string[] = [];
    const deps = depsFor(script);
    const inner = deps.callModel as unknown as (msgs: Array<{ content: string }>) => Promise<StepResponse>;
    (deps as { callModel: unknown }).callModel = vi.fn(async (msgs: Array<{ content: string }>) => {
      snapshots.push(msgs.map((m) => m.content).join('\n'));
      return inner(msgs);
    });

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'rename the export in b.ts' }],
      context: { ...ctx, cwd: project } as ToolContext,
      deps,
      maxSteps: 1,
      maxStepExtensions: 0,
    });

    // The second model call is the one that saw the push: the caller named, the
    // file it relates to, and the permission to answer with a reason.
    const secondCall = deps.callModel.mock.calls[1]![0] as Array<{ role: string; content: string }>;
    const pushed = secondCall.map((m) => m.content).join('\n');
    expect(pushed).toContain('breadth of this edit');
    expect(pushed).toContain('src/a.ts');
    expect(pushed).toContain('a caller of the code you just changed');

    // ONCE, and only AFTER the edit: the first call cannot know what the turn was
    // going to touch, and the fact must never be asked a second time.
    expect(snapshots[0]).not.toContain('breadth of this edit');
    expect(snapshots.at(-1)!.split('breadth of this edit').length - 1).toBe(1);
    expect(result.content).toBe('Changed b.');
  });
});

describe('findings, recalled into the next turn`s project context', () => {
  it('carries a settled finding from an earlier run into the context block', async () => {
    const finding = confirmFinding(
      plausibleFinding({ claim: 'the runner never awaits its child', outcome: 'confirmed', source: 'audit' }),
      [{ kind: 'file', ref: 'src/a.ts' }],
    ).finding;
    const id = beginTrace({ goal: 'audit', source: 'loop', workingDirectory: project });
    recordTraceFindings(id, [toWire(finding)]);
    endTrace(id, true);

    const block = await buildLoopProjectContext(project, { goal: 'fix the runner' });
    expect(block).toContain('Findings ledger');
    expect(block).toContain('never awaits its child');
    expect(block).toContain('Do not re-derive these');
  });

  it('leaves a project with no history out of the context entirely', async () => {
    const block = await buildLoopProjectContext(project, { goal: 'fix the runner' });
    expect(block).not.toContain('Findings ledger');
  });
});
