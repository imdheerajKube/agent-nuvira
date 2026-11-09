/**
 * The new-task backlog after capture.
 *
 * `scheduled` used to be a one-way state: the dashboard disabled "Create task"
 * and offered nothing else, so an item could not be re-copied or dismissed. The
 * store itself always allowed both transitions; these tests pin that, so a
 * surface cannot lose the actions again.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  addBacklogItem,
  createBacklogTaskPrompt,
  listBacklog,
  setBacklogStatus,
} from '../../src/steering/backlog.js';
import { ensureRun } from '../../src/steering/store.js';
import type { ChangeAssessment, ChangeRequestRecord } from '../../src/steering/types.js';

function runId(): string {
  return `test-backlog-${randomUUID()}`;
}

function change(run: string): ChangeRequestRecord {
  return {
    id: 'G-test01',
    runId: run,
    source: 'dashboard',
    author: 'admin',
    rawText: 'also add images to web page it looks boring',
    submittedAt: '2026-11-09T10:00:00.000Z',
    planVersionAtSubmit: 1,
    idempotencyKey: 'test-key',
    contentHash: 'test-hash',
    status: 'backlog',
  };
}

const assessment = {
  relation: 'new_task',
  kind: 'add',
  timing: 'after_run',
  impact: 'medium',
  confidence: 0.92,
  affectedStepIds: [],
  conflictsWith: [],
  supersedes: [],
  requiresApproval: false,
  rationale: 'A visual enhancement request outside the current run goal.',
  proposedOps: [],
  conflict: 'none',
  newTask: {
    title: 'Add images to web page',
    description: 'Improve the web page by adding relevant images.',
    reason: 'Separate work.',
  },
} as unknown as ChangeAssessment;

describe('backlog after capture', () => {
  it('captures once, can be scheduled repeatedly, and can be dismissed', () => {
    const run = runId();
    ensureRun({ runId: run, goal: 'test goal', cwd: '/tmp/test', engine: 'loop', surface: 'cli' });

    const first = addBacklogItem({ runId: run, change: change(run), assessment, now: 1_000 });
    expect(first?.status).toBe('open');
    expect(first?.title).toBe('Add images to web page');

    // A duplicate submission is idempotent, not a second backlog item.
    const again = addBacklogItem({ runId: run, change: change(run), assessment, now: 2_000 });
    expect(again?.id).toBe(first?.id);
    expect(listBacklog(run)).toHaveLength(1);

    // Clicking "Create task" again is safe: it re-copies, it does not consume.
    const scheduled = setBacklogStatus(run, first!.id, 'scheduled');
    expect(scheduled?.status).toBe('scheduled');
    expect(setBacklogStatus(run, first!.id, 'scheduled')?.status).toBe('scheduled');

    const prepared = createBacklogTaskPrompt(scheduled!);
    expect(prepared.prompt).toBe(
      'Add images to web page\n\nImprove the web page by adding relevant images.',
    );
    expect(prepared.command).toBe(
      'nuvira chat "Add images to web page\n\nImprove the web page by adding relevant images."',
    );

    const dismissed = setBacklogStatus(run, first!.id, 'dismissed');
    expect(dismissed?.status).toBe('dismissed');
    expect(listBacklog(run)[0].status).toBe('dismissed');
  });
});
