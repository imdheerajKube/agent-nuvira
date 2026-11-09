/**
 * The new-task backlog — separate work is captured, never absorbed.
 *
 * The measured failure this prevents is lossy advice: "recommend submitting this as
 * a new task" throws the user's words away. Here the text is durable, linked to the
 * run that produced it, and paired with a concrete action that starts the work as
 * its own task. The ACTIVE run never absorbs it.
 */

import { newBacklogId } from './ids.js';
import { appendJournal, ensureRun, readBacklog, writeBacklog } from './store.js';
import type { BacklogItem, ChangeAssessment, ChangeRequestRecord } from './types.js';

function firstLine(text: string, limit = 90): string {
  const line = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  const value = line || 'New task';
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/** Add one backlog item, idempotent per change id. */
export function addBacklogItem(input: {
  runId: string;
  change: ChangeRequestRecord;
  assessment?: ChangeAssessment;
  now?: number;
}): BacklogItem | null {
  const now = input.now ?? Date.now();
  const items = readBacklog(input.runId);
  const existing = items.find((item) => item.changeId === input.change.id);
  if (existing) return existing;

  const newTask = input.assessment?.newTask;
  const item: BacklogItem = {
    id: newBacklogId(now),
    runId: input.runId,
    changeId: input.change.id,
    text: input.change.rawText,
    title: newTask?.title?.trim() || firstLine(input.change.rawText),
    description: newTask?.description?.trim() || input.change.rawText,
    reason:
      newTask?.reason?.trim() ||
      input.assessment?.rationale ||
      'Separate work outside the active objective.',
    priority: input.assessment?.impact === 'high' ? 'high' : 'normal',
    status: 'open',
    createdAt: new Date(now).toISOString(),
  };
  if (!writeBacklog(input.runId, [...items, item].slice(-200))) return null;
  appendJournal(input.runId, {
    type: 'change.backlogged',
    actor: 'policy',
    changeId: input.change.id,
    data: { backlogId: item.id, title: item.title },
  });
  return item;
}

export function listBacklog(runId: string): BacklogItem[] {
  return readBacklog(runId);
}

/** Mark an item scheduled/dismissed after its surface action ran. */
export function setBacklogStatus(
  runId: string,
  backlogId: string,
  status: BacklogItem['status'],
): BacklogItem | null {
  const items = readBacklog(runId);
  const at = items.findIndex((item) => item.id === backlogId);
  if (at === -1) return null;
  const next = { ...items[at], status };
  items[at] = next;
  writeBacklog(runId, items);
  appendJournal(runId, {
    type: 'backlog.updated',
    actor: 'user',
    data: { backlogId, status },
  });
  return next;
}

/**
 * The "create task" action. It returns both the exact prompt to hand to a new run
 * and the CLI command that runs it — so the user is not asked to retype anything
 * the backlog already holds.
 */
export function createBacklogTaskPrompt(
  item: BacklogItem,
): { prompt: string; command: string } {
  const prompt = [item.title, '', item.description].join('\n').trim();
  const quoted = prompt.replace(/"/g, '\\"');
  return { prompt, command: `nuvira chat "${quoted}"` };
}

/** Ensure the backlog file exists (a surface may open an empty run). */
export function ensureBacklog(runId: string, goal: string, cwd: string): void {
  ensureRun({ runId, goal, cwd, engine: 'loop', surface: 'cli' });
}
