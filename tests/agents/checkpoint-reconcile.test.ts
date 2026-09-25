/**
 * Work-ledger reconciliation — the "may I skip this step?" contract.
 *
 * The live NVDA-addon checkpoint said `5/5 tasks completed`, so the old rule
 * ("never silently re-enter a checkpoint") protected the one run that most
 * needed to resume: the plan was 5/5 on paper and empty on disk. These tests pin
 * the replacement rule — a completed step is only skippable if its DECLARED
 * files are actually there.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkpointIdFor,
  findRelatedCheckpointFor,
  goalsLookSame,
  planHasPendingWork,
  reconcileTaskPlan,
  saveCheckpoint,
} from '../../src/agents/checkpoint-store.js';
import type { AgentContext, TaskStep } from '../../src/agents/agent.js';

/** The exact 22 bytes `zip` writes when it matches nothing. */
function emptyZipBytes(): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  return eocd;
}

function step(over: Partial<TaskStep> & { id: string }): TaskStep {
  return {
    description: over.description ?? `step ${over.id}`,
    agentType: over.agentType ?? 'writer',
    dependsOn: over.dependsOn ?? [],
    status: over.status ?? 'pending',
    ...over,
  };
}

function context(plan: TaskStep[], workingDirectory: string, goal = 'a goal'): AgentContext {
  return {
    goal,
    workingDirectory,
    taskPlan: plan,
    artifacts: [],
    conversations: [],
    fileChanges: [],
    metadata: {},
  };
}

let memDir: string;
let project: string;
let prevMemDir: string | undefined;

beforeEach(() => {
  memDir = mkdtempSync(join(tmpdir(), 'nuvira-ledger-mem-'));
  project = mkdtempSync(join(tmpdir(), 'nuvira-ledger-proj-'));
  prevMemDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = memDir;
});

afterEach(() => {
  if (prevMemDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = prevMemDir;
  rmSync(memDir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('reconcileTaskPlan', () => {
  it('re-opens a step that reported success but produced nothing', () => {
    // The live shape: step-04-package-addon flipped to `completed`, and no
    // package exists.
    const ctx = context(
      [
        step({ id: 'step-01', status: 'completed', expectedFiles: ['manifest.ini'] }),
        step({ id: 'step-04', status: 'completed', expectedFiles: ['kuttaaddon.nvda-addon'] }),
      ],
      project,
    );

    const { context: out, demoted } = reconcileTaskPlan(ctx, project);
    expect(demoted.map((d) => d.id)).toEqual(['step-01', 'step-04']);
    expect(out.taskPlan.every((s) => s.status === 'pending')).toBe(true);
    expect(out.taskPlan[0]!.result).toContain('not on disk');
    expect(planHasPendingWork(out)).toBe(true);
  });

  it('leaves a completion alone when the deliverable is really there', () => {
    mkdirSync(join(project, 'globalPlugins'), { recursive: true });
    writeFileSync(join(project, 'manifest.ini'), '[addon]\nname = kutta\n');
    const ctx = context(
      [step({ id: 'step-01', status: 'completed', expectedFiles: ['manifest.ini'] })],
      project,
    );

    const { context: out, demoted } = reconcileTaskPlan(ctx, project);
    expect(demoted).toEqual([]);
    expect(out.taskPlan[0]!.status).toBe('completed');
    expect(planHasPendingWork(out)).toBe(false);
  });

  it('treats an EMPTY ARCHIVE as unfinished — the 22-byte "package"', () => {
    writeFileSync(join(project, 'kuttaaddon.nvda-addon'), emptyZipBytes());
    const ctx = context(
      [step({ id: 'step-04', status: 'completed', expectedFiles: ['kuttaaddon.nvda-addon'] })],
      project,
    );

    const { demoted } = reconcileTaskPlan(ctx, project);
    expect(demoted).toHaveLength(1);
    expect(demoted[0]!.reason).toContain('produced empty');
  });

  it('does NOT demote on prose alone — undeclared steps are left as they are', () => {
    // "Delete legacy.js" looks like an unmet deliverable if artifacts were
    // inferred from the description. They are not: only `expectedFiles` counts,
    // because only that is the planner's contract.
    const ctx = context(
      [step({ id: 'step-09', status: 'completed', description: 'Delete legacy.js from the repo' })],
      project,
    );

    const { demoted } = reconcileTaskPlan(ctx, project);
    expect(demoted).toEqual([]);
    expect(planHasPendingWork(ctx)).toBe(false);
  });

  it('ignores steps that are already pending or failed', () => {
    const ctx = context(
      [
        step({ id: 'a', status: 'pending', expectedFiles: ['nope-a.ts'] }),
        step({ id: 'b', status: 'failed', expectedFiles: ['nope-b.ts'] }),
      ],
      project,
    );
    expect(reconcileTaskPlan(ctx, project).demoted).toEqual([]);
  });

  it('handles an empty plan without inventing work', () => {
    const ctx = context([], project);
    expect(reconcileTaskPlan(ctx, project).demoted).toEqual([]);
    expect(planHasPendingWork(ctx)).toBe(false);
  });
});

describe('goalsLookSame — rewritten asks vs unrelated ones', () => {
  it('matches the same ask worded differently, including add-on / addon', () => {
    expect(
      goalsLookSame(
        'can you develop an NVDA add on compatible to 2026.2 and give me a deployable package saved in /Users/dheeraj/Documents/kuttaaddon/',
        'build the NVDA addon package and save it in /Users/dheeraj/Documents/kuttaaddon/',
      ),
    ).toBe(true);
    expect(goalsLookSame('Package the add-on', 'package the addon for me')).toBe(true);
  });

  it('does NOT match two unrelated asks that share a folder', () => {
    expect(goalsLookSame('fix the dashboard login redirect bug', 'write a python script to rename photos')).toBe(false);
    expect(goalsLookSame('build a calculator app', 'build a snake game in python')).toBe(false);
  });

  it('requires substance — a single shared noun is not enough', () => {
    expect(goalsLookSame('update the readme', 'update the dockerfile')).toBe(false);
    expect(goalsLookSame('', 'anything at all')).toBe(false);
  });
});

describe('findRelatedCheckpointFor', () => {
  it('finds a checkpoint saved under a DIFFERENT wording of the same ask', () => {
    const original =
      'can you develop an NVDA add on compatible to 2026.2 and give me a deployable package saved in /Users/dheeraj/Documents/kuttaaddon/';
    const saved = saveCheckpoint(
      context(
        [
          step({ id: 'step-01', status: 'completed', expectedFiles: ['manifest.ini'] }),
          step({ id: 'step-04', status: 'completed', expectedFiles: ['kuttaaddon.nvda-addon'] }),
        ],
        project,
        original,
      ),
      checkpointIdFor(original, project),
    );
    expect(saved).not.toBeNull();
    // The auto id for the REWORDED ask points somewhere else entirely.
    expect(checkpointIdFor('build the NVDA addon package for me and save it in /Users/dheeraj/Documents/kuttaaddon/', project)).not.toBe(saved);

    const found = findRelatedCheckpointFor(
      project,
      'build the NVDA addon package for me and save it in /Users/dheeraj/Documents/kuttaaddon/',
    );
    expect(found?.id).toBe(saved);
  });

  it('does NOT hand an unrelated run the plan of another goal in the same folder', () => {
    const unrelated = 'write a python script that resizes every image in a folder';
    saveCheckpoint(context([step({ id: 'x', status: 'pending' })], project, unrelated), checkpointIdFor(unrelated, project));

    expect(findRelatedCheckpointFor(project, 'fix the dashboard login redirect bug')).toBeNull();
  });

  it('returns null when the project has no checkpoint at all', () => {
    expect(findRelatedCheckpointFor(project, 'anything')).toBeNull();
  });

  it('skips an unrelated plan sitting in the same folder, and honours excludeId', () => {
    const goal = 'build the nvda addon package for deployment';
    const unrelated = 'resize every image in the pictures folder';
    saveCheckpoint(
      context([step({ id: 'unrelated', status: 'pending' })], project, unrelated),
      checkpointIdFor(unrelated, project),
    );
    saveCheckpoint(context([step({ id: 'first', status: 'pending' })], project, goal), 'cp-first-write');
    saveCheckpoint(context([step({ id: 'second', status: 'pending' })], project, goal), 'cp-second-write');

    // Only the two goal-matching checkpoints are candidates; excludeId drops the
    // one the caller is already handling.
    const found = findRelatedCheckpointFor(project, goal, { excludeId: 'cp-first-write' });
    expect(found?.id).toBe('cp-second-write');
  });

  it('picks the NEWEST matching checkpoint when several match', () => {
    const goal = 'build the nvda addon package for deployment';
    saveCheckpoint(context([step({ id: 'first', status: 'pending' })], project, goal), 'cp-first-write');
    saveCheckpoint(context([step({ id: 'second', status: 'pending' })], project, goal), 'cp-second-write');

    // Two writes in the same millisecond tie on `savedAt`; age one explicitly so
    // the assertion tests ordering rather than clock resolution.
    const older = join(memDir, 'checkpoints', 'cp-second-write.json');
    const parsed = JSON.parse(readFileSync(older, 'utf-8'));
    parsed.savedAt = Date.now() - 60_000;
    writeFileSync(older, JSON.stringify(parsed, null, 2), 'utf-8');

    expect(findRelatedCheckpointFor(project, goal)?.id).toBe('cp-first-write');
  });
});
