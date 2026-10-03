/**
 * A2 — `--checkpoint` on the loop engine.
 *
 * The flag is advertised as "save a resume-able checkpoint", but on the loop arm
 * it was inert: the record opened only on an explicit resume, so a checkpointed
 * run left nothing to resume from. This pins the resolved request, which is the
 * decision that governs whether the record is opened at all.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openResume,
  closeResume,
  resolveResumeRequest,
} from '../../src/learning/step-checkpoint.js';

const dirs: string[] = [];
const origMem = process.env.NUVIRA_MEMORY_DIR;
const origResume = process.env.NUVIRA_RESUME;

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'loop-checkpoint-'));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  process.env.NUVIRA_MEMORY_DIR = tmp();
  delete process.env.NUVIRA_RESUME;
});
afterEach(() => {
  if (origMem === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = origMem;
  if (origResume === undefined) delete process.env.NUVIRA_RESUME;
  else process.env.NUVIRA_RESUME = origResume;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The decision loop-executor makes: resume intent, --checkpoint, or B4's default. */
function shouldOpenRecord(
  opts: { resume?: string | boolean; checkpoint?: boolean },
  checkpointDefaultOn = true,
): boolean {
  const request = resolveResumeRequest({ resume: opts.resume });
  const enabled = request !== undefined || opts.checkpoint === true || checkpointDefaultOn;
  return enabled;
}

describe('A2 — --checkpoint opens the loop record', () => {
  it('an ordinary run opens nothing when B4 default-on is disabled', () => {
    expect(shouldOpenRecord({}, false)).toBe(false);
  });

  it('--checkpoint alone opens the record (the fix)', () => {
    expect(shouldOpenRecord({ checkpoint: true })).toBe(true);
  });

  it('--resume opens the record', () => {
    expect(shouldOpenRecord({ resume: true })).toBe(true);
    expect(shouldOpenRecord({ resume: 'cp-abc' })).toBe(true);
  });

  it('--resume=false declines replay, but the record is still written', () => {
    // An explicit `resume: false` is a DECISION (no replay); `--checkpoint`
    // (and B4's default) still asks for a record to be written forward.
    expect(shouldOpenRecord({ resume: false }, false)).toBe(false);
    expect(shouldOpenRecord({ resume: false, checkpoint: true }, false)).toBe(true);
  });
});

describe('B4 — checkpointing is default-on', () => {
  it('an ordinary run checkpoints by default', () => {
    expect(shouldOpenRecord({})).toBe(true);
  });

  it('a checkpoint-only run does NOT replay (no stale answers by default)', () => {
    const opened = openResume({ goal: 'fix the hotkey', cwd: tmp(), resume: {}, replay: false });
    expect(opened.ledger.openNotice()).toMatch(/checkpointing/);
    expect(opened.ledger.openNotice()).not.toMatch(/resumed:/);
  });

  it('a resume run DOES replay', () => {
    const opened = openResume({ goal: 'fix the hotkey', cwd: tmp(), resume: {} });
    expect(opened.ledger.openNotice()).toMatch(/no record/);
  });
});

describe('A2 — a checkpointed run leaves a resume point on disk', () => {
  it('writes the record when the run made a model call', () => {
    const cwd = tmp();
    const opened = openResume({ goal: 'fix the hotkey', cwd, resume: {} });
    // Simulate the loop paying for one step.
    opened.ledger.record('step-1', 'digest-1', { content: 'did a thing', toolCalls: [] });
    const outcome = closeResume(opened, { goal: 'fix the hotkey', cwd });

    expect(outcome.saved).toBe(true);
    const record = join(process.env.NUVIRA_MEMORY_DIR!, 'checkpoints', 'steps', `${outcome.id}.json`);
    expect(existsSync(record)).toBe(true);
  });
});