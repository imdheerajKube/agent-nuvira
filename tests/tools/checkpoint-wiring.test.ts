/**
 * Pre-write workspace checkpoint — the undo point.
 *
 * The capability existed and was never used automatically. These tests pin the three
 * things that make it a safety net rather than a decoration: it is taken BEFORE the
 * first write, exactly once per turn, it can actually restore the file, and it can be
 * turned off.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runToolLoop, type ToolLoopDeps, type StepResponse } from '../../src/tools/tool-loop.js';
import type { ToolContext } from '../../src/tools/registry.js';
import {
  listCheckpoints,
  readCheckpoint,
  restoreWorkspaceCheckpoint,
} from '../../src/learning/workspace-checkpoint.js';
import { shouldPruneAutoStore } from '../../src/tools/tool-loop.js';

let memoryDir: string;
let storeDir: string;
let project: string;
let previousMemory: string | undefined;
let previousStore: string | undefined;

beforeEach(() => {
  memoryDir = mkdtempSync(join(tmpdir(), 'nuvira-cp-mem-'));
  storeDir = mkdtempSync(join(tmpdir(), 'nuvira-cp-store-'));
  previousMemory = process.env.NUVIRA_MEMORY_DIR;
  previousStore = process.env.NUVIRA_CHECKPOINT_DIR;
  process.env.NUVIRA_MEMORY_DIR = memoryDir;
  process.env.NUVIRA_CHECKPOINT_DIR = storeDir;
  // The harness turns the pre-write snapshot OFF for the suite by default (it hashes
  // the project root, and the root in a test is the whole repository). This file is
  // the one that asserts the behaviour, and its project root is the two-file fixture
  // below, so it is cheap to turn back on.
  process.env.NUVIRA_CHECKPOINT_BEFORE_WRITE = '1';

  project = mkdtempSync(join(tmpdir(), 'nuvira-cp-proj-'));
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(project, 'package.json'), '{"name":"cp-fixture"}\n');
});

afterEach(() => {
  if (previousMemory === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = previousMemory;
  if (previousStore === undefined) delete process.env.NUVIRA_CHECKPOINT_DIR;
  else process.env.NUVIRA_CHECKPOINT_DIR = previousStore;
  delete process.env.NUVIRA_CHECKPOINT_BEFORE_WRITE;
  rmSync(memoryDir, { recursive: true, force: true });
  rmSync(storeDir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const ctx: ToolContext = { configManager: {} } as ToolContext;

function depsFor(script: StepResponse[]): ToolLoopDeps {
  const callModel = vi.fn();
  let i = 0;
  callModel.mockImplementation(async () => script[Math.min(i++, script.length - 1)]);
  return {
    callModel,
    // The real write is performed by the test's tool stub, so the file on disk is
    // genuinely changed — that is what the restore has to undo.
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'write_file' && typeof args.path === 'string') {
        writeFileSync(args.path, String(args.content ?? ''));
      }
      return 'ok';
    }),
    onEvent: vi.fn(),
  } as unknown as ToolLoopDeps;
}

function planThenWrite(path: string, content: string): StepResponse[] {
  return [
    {
      content: '',
      toolCalls: [
        { id: 'p1', name: 'plan_todo', arguments: { action: 'create', goal: 'edit', steps: ['change it'] } },
        { id: 'w1', name: 'write_file', arguments: { path, content } },
      ],
    },
    { content: 'Done.', toolCalls: [] },
  ];
}

describe('pre-write workspace checkpoint', () => {
  it('takes a checkpoint and the result carries the id to restore from', async () => {
    const file = join(project, 'src', 'a.ts');
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'change a.ts' }],
      context: { ...ctx, cwd: project } as ToolContext,
      deps: depsFor(planThenWrite(file, 'export const a = 999;\n')),
      maxSteps: 3,
      maxStepExtensions: 0,
    });

    expect(result.workspaceCheckpointId).toBeTruthy();
    expect(listCheckpoints({ storeDir }).some((c) => c.id === result.workspaceCheckpointId)).toBe(true);
    // Marked as the automatic net, which is what lets the store bound itself
    // without ever deleting a checkpoint the user asked for.
    expect(readCheckpoint(result.workspaceCheckpointId!, { storeDir })?.origin).toBe('loop');
    expect(shouldPruneAutoStore(10)).toBe(true);
    expect(shouldPruneAutoStore(9)).toBe(false);
    expect(shouldPruneAutoStore(0)).toBe(false);
    // The write really happened…
    expect(readFileSync(file, 'utf8')).toContain('999');

    // …and the recorded copy is the content BEFORE it.
    const restored = restoreWorkspaceCheckpoint(result.workspaceCheckpointId!, { storeDir });
    expect(restored.restored).toBeGreaterThan(0);
    expect(readFileSync(file, 'utf8')).toContain('export const a = 1;');
  });

  it('takes exactly one checkpoint per turn, however many files it writes', async () => {
    const a = join(project, 'src', 'a.ts');
    const b = join(project, 'src', 'b.ts');
    writeFileSync(b, 'export const b = 1;\n');

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'change both' }],
      context: { ...ctx, cwd: project } as ToolContext,
      deps: depsFor([
        {
          content: '',
          toolCalls: [
            { id: 'p1', name: 'plan_todo', arguments: { action: 'create', goal: 'edit', steps: ['change them'] } },
            { id: 'w1', name: 'write_file', arguments: { path: a, content: 'export const a = 2;\n' } },
            { id: 'w2', name: 'write_file', arguments: { path: b, content: 'export const b = 2;\n' } },
          ],
        },
        { content: 'Done.', toolCalls: [] },
      ]),
      maxSteps: 3,
      maxStepExtensions: 0,
    });

    expect(result.workspaceCheckpointId).toBeTruthy();
    expect(listCheckpoints({ storeDir })).toHaveLength(1);
  });

  it('does not snapshot a turn that only reads', async () => {
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'what is in a.ts?' }],
      context: { ...ctx, cwd: project } as ToolContext,
      deps: depsFor([
        { content: '', toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: join(project, 'src', 'a.ts') } }] },
        { content: 'It is a constant.', toolCalls: [] },
      ]),
      maxSteps: 3,
      maxStepExtensions: 0,
    });

    expect(result.workspaceCheckpointId).toBeUndefined();
    expect(listCheckpoints({ storeDir })).toHaveLength(0);
  });

  it('can be turned off with NUVIRA_CHECKPOINT_BEFORE_WRITE=0', async () => {
    process.env.NUVIRA_CHECKPOINT_BEFORE_WRITE = '0';
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'change a.ts' }],
      context: { ...ctx, cwd: project } as ToolContext,
      deps: depsFor(planThenWrite(join(project, 'src', 'a.ts'), 'export const a = 3;\n')),
      maxSteps: 3,
      maxStepExtensions: 0,
    });

    expect(result.workspaceCheckpointId).toBeUndefined();
    expect(existsSync(storeDir) ? listCheckpoints({ storeDir }).length : 0).toBe(0);
  });
});
