/**
 * WS5 (#27) — the resume ledger.
 *
 * The claims worth pinning are the ones that decide whether a replay is an ANSWER
 * or a fabrication: a step is served only for a byte-identical input; a recorded
 * provider FAILURE is never inherited; the run reports what it LOADED separately
 * from what it REPLAYED, and says why when nothing replayed. All of them are
 * asserted on real files in a temp store, since the record surviving to the next
 * run is the entire mechanism.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { checkpointIdFor } from '../../src/agents/checkpoint-store.js';
import {
  RESUME_ENABLE_ENV,
  closeResume,
  openResume,
  resolveResumeRequest,
  stepDigest,
  type ResumeRequest,
} from '../../src/learning/step-checkpoint.js';

const previousMemoryDir = process.env.NUVIRA_MEMORY_DIR;
const previousResume = process.env[RESUME_ENABLE_ENV];
const made: string[] = [];
let memoryDir = '';

beforeEach(() => {
  memoryDir = mkdtempSync(join(tmpdir(), 'ws5-memory-'));
  made.push(memoryDir);
  process.env.NUVIRA_MEMORY_DIR = memoryDir;
  delete process.env[RESUME_ENABLE_ENV];
});

afterAll(() => {
  if (previousMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = previousMemoryDir;
  if (previousResume === undefined) delete process.env[RESUME_ENABLE_ENV];
  else process.env[RESUME_ENABLE_ENV] = previousResume;
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

/** A step answer, in the shape the loop records. */
function answer(text: string) {
  return { content: text, toolCalls: [] };
}

const ask = { goal: 'add the retry test and make it pass', cwd: '/tmp/project' };

/** A record id for a request, the way `openResume` resolves one. */
function idFor(resume: ResumeRequest): string {
  return openResume({ ...ask, resume }).id;
}

describe('WS5 resume — the request', () => {
  it('is off unless somebody asks, and an explicit decline outranks the environment', () => {
    expect(resolveResumeRequest({})).toBeUndefined();
    process.env[RESUME_ENABLE_ENV] = '1';
    expect(resolveResumeRequest({})).toEqual({});
    expect(resolveResumeRequest({ resume: false })).toBeUndefined();
    delete process.env[RESUME_ENABLE_ENV];
    expect(resolveResumeRequest({ resume: true })).toEqual({});
  });

  it('reads a NAMED record from the environment, and treats an empty name as the auto record', () => {
    process.env[RESUME_ENABLE_ENV] = 'ci-run-7';
    expect(resolveResumeRequest({})).toEqual({ id: 'ci-run-7' });
    process.env[RESUME_ENABLE_ENV] = '0';
    expect(resolveResumeRequest({})).toBeUndefined();
    delete process.env[RESUME_ENABLE_ENV];
    expect(resolveResumeRequest({ resume: 'ci-run-7' })).toEqual({ id: 'ci-run-7' });
    // `--resume` with no id means "this ask, here" — an empty string is not a name.
    expect(resolveResumeRequest({ resume: '' })).toEqual({});
  });

  it('resolves the auto record from the goal and the directory', () => {
    expect(idFor({})).toBe(checkpointIdFor(ask.goal, ask.cwd));
    expect(idFor({ id: 'named-run' })).toBe('named-run');
  });
});

describe('WS5 resume — the digest', () => {
  it('is the same for the same input, whatever the key order', () => {
    const a = stepDigest([{ role: 'user', content: 'hi' }], [{ name: 'read_file' }]);
    const b = stepDigest([{ content: 'hi', role: 'user' }], [{ name: 'read_file' }]);
    expect(a).toBe(b);
  });

  it('changes when any part of the input changes', () => {
    const base = stepDigest([{ role: 'user', content: 'hi' }], [{ name: 'read_file' }]);
    // A changed tool result, a changed schema and an edited goal all MISS.
    expect(stepDigest([{ role: 'user', content: 'hi!' }], [{ name: 'read_file' }])).not.toBe(base);
    expect(stepDigest([{ role: 'user', content: 'hi' }], [{ name: 'write_file' }])).not.toBe(base);
    expect(stepDigest([{ role: 'user', content: 'hi' }], [])).not.toBe(base);
  });
});

describe('WS5 resume — the ledger', () => {
  it('opens on a fresh ask with nothing loaded, and says it will write a record', () => {
    const run = openResume({ ...ask, resume: { id: 'fresh' } });
    expect(run.ledger.openNotice()).toContain('no record for this ask in this directory yet');
    const outcome = closeResume(run, ask);
    expect(outcome.replayed).toBe(0);
    expect(outcome.modelCalls).toBe(0);
    expect(outcome.notice).toContain('replayed 0, made 0 model call(s)');
  });

  it('replays a recorded step when its input is unchanged, and pays for nothing', () => {
    const digest = stepDigest([{ role: 'user', content: 'hi' }], []);
    const first = openResume({ ...ask, resume: { id: 'replay-me' } });
    first.ledger.record('model:1', digest, answer('ANSWER-1'));
    expect(closeResume(first, ask).saved).toBe(true);

    // A SECOND run of the same ask: the record is read, and the step comes back.
    const second = openResume({ ...ask, resume: { id: 'replay-me' } });
    expect(second.ledger.openNotice()).toContain('1 recorded step(s) loaded');
    const replayed = second.ledger.replay('model:1', digest);
    expect(replayed).toEqual(answer('ANSWER-1'));
    const outcome = closeResume(second, ask);
    expect(outcome.replayed).toBe(1);
    expect(outcome.modelCalls).toBe(0);
    expect(outcome.saved).toBe(true);
    expect(outcome.notice).toContain('replayed 1, made 0 model call(s)');

    // And the replayed step survives for the NEXT run — a resume that did not pay
    // for a step must not lose it.
    const third = openResume({ ...ask, resume: { id: 'replay-me' } });
    expect(third.ledger.replay('model:1', digest)).toEqual(answer('ANSWER-1'));
  });

  it('MISSES when the input changed, and says why', () => {
    const before = stepDigest([{ role: 'user', content: 'hi' }], []);
    const first = openResume({ ...ask, resume: { id: 'changed' } });
    first.ledger.record('model:1', before, answer('ANSWER-1'));
    closeResume(first, ask);

    const second = openResume({ ...ask, resume: { id: 'changed' } });
    const after = stepDigest([{ role: 'user', content: 'hi, and also this' }], []);
    expect(second.ledger.replay('model:1', after)).toBeNull();
    const outcome = closeResume(second, ask);
    expect(outcome.replayed).toBe(0);
    expect(outcome.notice).toContain('why not: its input changed (1)');
  });

  it('MISSES a step the record does not have, and says which case it was', () => {
    const run = openResume({ ...ask, resume: { id: 'missing-key' } });
    expect(run.ledger.replay('model:1', 'anything')).toBeNull();
    expect(closeResume(run, ask).notice).toContain('why not: not in the record (1)');
  });

  it('NEVER replays a recorded provider failure', () => {
    // A response with no text and no tool call is a failure, not an answer:
    // inheriting it would reproduce the failure and hide that the provider was
    // never consulted.
    const digest = stepDigest([{ role: 'user', content: 'hi' }], []);
    const first = openResume({ ...ask, resume: { id: 'empty' } });
    first.ledger.record('model:1', digest, { content: '', toolCalls: [] });
    closeResume(first, ask);

    const second = openResume({ ...ask, resume: { id: 'empty' } });
    expect(second.ledger.replay('model:1', digest)).toBeNull();
    const outcome = closeResume(second, ask);
    expect(outcome.replayed).toBe(0);
    expect(outcome.notice).toContain('the recorded step was an empty provider response (1)');
  });

  it('counts a paid-for step as a model call, and reports both numbers', () => {
    const digest = stepDigest([{ role: 'user', content: 'hi' }], []);
    const run = openResume({ ...ask, resume: { id: 'counts' } });
    run.ledger.replay('model:1', digest); // misses: nothing recorded yet
    run.ledger.record('model:1', digest, answer('ANSWER-1'));
    run.ledger.record('model:2', stepDigest([{ role: 'user', content: 'more' }], []), answer('ANSWER-2'));
    const outcome = closeResume(run, ask);
    expect(outcome.modelCalls).toBe(2);
    expect(outcome.replayed).toBe(0);
    expect(outcome.notice).toContain('replayed 0, made 2 model call(s)');
  });

  it('treats a corrupt record as a miss rather than crashing the run', () => {
    const id = 'corrupt';
    const run = openResume({ ...ask, resume: { id } });
    run.ledger.record('model:1', 'digest', answer('ANSWER'));
    closeResume(run, ask);
    writeFileSync(join(memoryDir, 'checkpoints', 'steps', `${id}.json`), '{ not json', 'utf-8');
    const reopened = openResume({ ...ask, resume: { id } });
    expect(reopened.ledger.openNotice()).toContain('no record for this ask in this directory yet');
  });

  it('writes the record where the pipeline checkpoints live, and only when asked', () => {
    const run = openResume({ ...ask, resume: { id: 'on-disk' } });
    expect(run.ledger.replay('model:1', 'd')).toBeNull();
    run.ledger.record('model:1', 'd', answer('ANSWER'));
    closeResume(run, ask);
    const path = join(memoryDir, 'checkpoints', 'steps', 'on-disk.json');
    const file = JSON.parse(readFileSync(path, 'utf-8')) as {
      id: string;
      goal: string;
      steps: Array<{ key: string }>;
    };
    expect(file.id).toBe('on-disk');
    expect(file.goal).toBe(ask.goal);
    expect(file.steps.map((step) => step.key)).toEqual(['model:1']);
  });
});
