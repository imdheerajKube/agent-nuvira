/**
 * CheckpointStore — checkpoint save/load/resume tests.
 *
 * Covers:
 * 1. saveCheckpoint persists a vault snapshot to BUFF_MEMORY_DIR/checkpoints
 * 2. loadCheckpoint round-trips the context (task plan statuses preserved)
 * 3. checkpointIdFor is deterministic for the same goal + cwd
 * 4. listCheckpoints returns newest-first metadata
 * 5. loadCheckpoint returns null for missing/corrupt files
 * 6. JSON round-trip drops function fields (onRateLimit) safely
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkpointIdFor,
  saveCheckpoint,
  loadCheckpoint,
  listCheckpoints,
} from '../../src/agents/checkpoint-store.js';
import type { AgentContext } from '../../src/agents/agent.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tempDir: string;
let originalMemoryDir: string | undefined;

function makeContext(goal: string, doneSteps: number): AgentContext {
  const steps = [
    { id: 'step-1', description: 'Gather context', agentType: 'context-gatherer', dependsOn: [] as string[], status: 'completed' as const, result: 'done' },
    { id: 'step-2', description: 'Write code', agentType: 'writer', dependsOn: ['step-1'], status: 'pending' as const },
  ];
  return {
    goal,
    workingDirectory: tempDir,
    taskPlan: doneSteps >= 1 ? steps : [steps[1]],
    artifacts: [],
    conversations: [],
    fileChanges: [],
    metadata: { routingContext: { complexity: 'moderate' } },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('CheckpointStore', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-cp-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
  });

  afterEach(() => {
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('saves a checkpoint to BUFF_MEMORY_DIR/checkpoints', () => {
    const context = makeContext('Implement auth', 1);
    const id = saveCheckpoint(context);

    const dir = join(tempDir, 'checkpoints');
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, `${id}.json`))).toBe(true);
  });

  it('round-trips the task plan with per-step statuses', () => {
    const context = makeContext('Implement auth', 1);
    const id = saveCheckpoint(context);

    const loaded = loadCheckpoint(id);
    expect(loaded).not.toBeNull();
    expect(loaded!.goal).toBe('Implement auth');
    expect(loaded!.context.taskPlan).toHaveLength(2);
    expect(loaded!.context.taskPlan[0].status).toBe('completed');
    expect(loaded!.context.taskPlan[1].status).toBe('pending');
    // Metadata survives so routing context is preserved on resume
    expect(loaded!.context.metadata.routingContext).toEqual({ complexity: 'moderate' });
  });

  it('checkpointIdFor is deterministic for the same goal + cwd', () => {
    const a = checkpointIdFor('implement auth', tempDir);
    const b = checkpointIdFor('implement auth', tempDir);
    const c = checkpointIdFor('implement other', tempDir);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('cp-')).toBe(true);
  });

  it('listCheckpoints returns newest-first metadata', () => {
    saveCheckpoint(makeContext('first goal', 1));
    saveCheckpoint(makeContext('second goal', 0));

    const list = listCheckpoints();
    expect(list.length).toBe(2);
    expect(list[0].savedAt).toBeGreaterThanOrEqual(list[1].savedAt);
    expect(list.some((c) => c.goal === 'first goal')).toBe(true);
    expect(list.some((c) => c.goal === 'second goal')).toBe(true);
  });

  it('loadCheckpoint returns null for missing id', () => {
    expect(loadCheckpoint('cp-does-not-exist')).toBeNull();
  });

  it('loadCheckpoint returns null for corrupt files', () => {
    const dir = join(tempDir, 'checkpoints');
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cp-broken.json'), '{not valid json', 'utf-8');
    expect(loadCheckpoint('cp-broken')).toBeNull();
  });

  it('the auto id for goal + cwd resolves the saved checkpoint', () => {
    const context = makeContext('resume me', 1);
    const id = saveCheckpoint(context);
    expect(id).toBe(checkpointIdFor('resume me', tempDir));

    // Bare `--resume` resolves the auto id and finds the checkpoint
    const loaded = loadCheckpoint(checkpointIdFor('resume me', tempDir));
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(id);
  });

  it('JSON serialization drops function fields (onRateLimit) without crashing', () => {
    const context = makeContext('fn goal', 1);
    (context as any).onRateLimit = () => Promise.resolve({ action: 'retry' as const });
    const id = saveCheckpoint(context);

    const raw = JSON.parse(readFileSync(join(tempDir, 'checkpoints', `${id}.json`), 'utf-8'));
    expect(raw.context.onRateLimit).toBeUndefined();
    expect(loadCheckpoint(id)).not.toBeNull();
  });

  it('returns null (not the id) when the write fails, so callers can log honestly', () => {
    // Fail NATURALLY without mocking node builtins (ESM live bindings can't be
    // intercepted via require): make the checkpoints path a regular FILE, so
    // writeFileSync(<file>/<id>.json) throws ENOTDIR. saveCheckpoint catches it
    // and returns null — no checkpoint file is created.
    const dir = join(tempDir, 'checkpoints');
    writeFileSync(dir, 'i am a file, not a directory', 'utf-8');

    const context = makeContext('fail goal', 1);
    expect(saveCheckpoint(context)).toBeNull();
    expect(existsSync(join(dir, checkpointIdFor('fail goal', tempDir) + '.json'))).toBe(false);
  });
});
