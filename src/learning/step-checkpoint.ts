/**
 * WS5 (#27) — the resume ledger: replay a run's unchanged MODEL CALLS.
 *
 * WHY REPLAYING MODEL CALLS IS THE USEFUL UNIT. `--resume` already existed for the
 * pipeline engine, where it skips completed TASKS (`agents/checkpoint-store.ts`).
 * A task is a coarse unit: one that half-finished is re-run from its start, and on
 * an agent LOOP — where a turn is many model calls, each of which may have cost a
 * slow provider round trip — the expensive thing is the calls, not the tasks. So
 * this ledger records each step's answer and replays the ones whose input has not
 * changed, which is what makes a re-run cost two calls instead of twenty.
 *
 * WHY THE KEY IS A DIGEST OF THE WHOLE INPUT, NOT THE STEP NUMBER. A step's number
 * is the same on every run and means nothing about its content: replay by position
 * and a plan that shifted by one step serves an answer to a question that was never
 * asked — silently, because a replayed answer is indistinguishable from a fresh one
 * in the transcript. The digest covers the whole thread AND the tool schema, so a
 * changed tool result, a changed schema, a reordered message or an edited goal all
 * MISS and the step is paid for again.
 *
 * WHY AN EMPTY RECORDED STEP IS NEVER REPLAYED. A response with no text and no tool
 * call is a provider failure, not an answer. Replaying it would reproduce the
 * failure while removing the only thing that would have fixed it — the call itself
 * — and would hide the fact that the provider was never consulted.
 *
 * WHY NOTHING HAPPENS WITHOUT A REQUEST. An ordinary run must not read, write, or
 * even look for a record: `--resume` is the only thing that opens the store, and a
 * turn that was never asked to resume pays no filesystem cost and cannot inherit
 * another run's answers by accident.
 *
 * WHY IT REPORTS WHAT IT LOADED AND WHAT IT REPLAYED SEPARATELY. At open time the
 * only knowable fact is what the RECORD holds; whether any of it will be usable is
 * decided step by step, once the thread is actually built. Announcing an outcome at
 * open is how a resumed run came to print "nothing to replay" before it had tried
 * anything — including on runs that then replayed everything.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkpointIdFor } from '../agents/checkpoint-store.js';
import { envBuff, resolveNuviraHome } from '../config/paths.js';
import type { ToolCallResponse } from '../inference/interface.js';

/** The environment key a deployment asks for a resume through. */
export const RESUME_ENABLE_ENV = 'NUVIRA_RESUME';

/** Why a recorded step could not be used. Reported, never merely logged. */
const CHANGED_REASON = 'its input changed';
const EMPTY_REASON = 'the recorded step was an empty provider response';
const MISSING_REASON = 'not in the record';

/** ─── Requests ─────────────────────────────────────────────────────────────── */

/**
 * A resolved resume request.
 *
 * An absent `id` means "the record for this ask, in this directory" — resolved at
 * open time through `checkpointIdFor`, which is what makes `--resume` with no
 * argument mean the LAST run of the same ask HERE, rather than some global newest.
 */
export interface ResumeRequest {
  id?: string;
}

/**
 * Resolve a resume request from a caller's option, with the environment as the
 * fallback.
 *
 * `undefined` means nobody said anything, and only then does `NUVIRA_RESUME`
 * decide (`1` asks for the auto record, any other value names one). An explicit
 * `false` is a DECISION and outranks the environment, so a surface with an off
 * switch can decline a request a deployment made for every turn.
 */
export function resolveResumeRequest(input: { resume?: string | boolean }): ResumeRequest | undefined {
  const explicit = input.resume;
  if (explicit === false) return undefined;
  if (typeof explicit === 'string') {
    const id = explicit.trim();
    // An empty string is not a record name; it is "this ask, this directory".
    return id === '' ? {} : { id };
  }
  if (explicit === true) return {};

  const raw = envBuff('RESUME');
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === '' || value === '0' || value.toLowerCase() === 'false') return undefined;
  if (value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes') return {};
  return { id: value };
}

/** ─── Digests ──────────────────────────────────────────────────────────────── */

/**
 * The key a step is stored under: a hash of its whole input.
 *
 * Key ORDER is normalised, so a tool-call argument object that came back with its
 * keys in a different order hashes the same — that is a JSON-round-trip artefact,
 * not a change of input — while a different VALUE anywhere hashes differently.
 */
export function stepDigest(thread: readonly unknown[], schemas: readonly unknown[]): string {
  return createHash('sha256').update(stableJson({ thread, schemas })).digest('hex');
}

/** JSON with object keys sorted, so two equal values always encode identically. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item === undefined ? null : item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

/** ─── Storage ──────────────────────────────────────────────────────────────── */

/** One recorded step: its key, the digest it was recorded under, and its answer. */
interface StepEntry {
  key: string;
  digest: string;
  response: ToolCallResponse;
}

/** A record on disk: the steps of one ask, in this directory. */
interface StepRecordFile {
  id: string;
  goal: string;
  cwd: string;
  savedAt: number;
  steps: StepEntry[];
}

function stepsDir(): string {
  const base = envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
  return join(base, 'checkpoints', 'steps');
}

function recordPath(id: string): string {
  return join(stepsDir(), `${id}.json`);
}

/** Read a record, best-effort. A corrupt record is a miss, never a crash. */
function readRecord(id: string): StepEntry[] {
  try {
    const path = recordPath(id);
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as StepRecordFile;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.steps)) return [];
    return parsed.steps.filter(
      (entry): entry is StepEntry =>
        !!entry && typeof entry.key === 'string' && typeof entry.digest === 'string',
    );
  } catch {
    return [];
  }
}

/** Write a record, best-effort. Returns whether it reached the disk. */
function writeRecord(file: StepRecordFile): boolean {
  try {
    mkdirSync(stepsDir(), { recursive: true });
    writeFileSync(recordPath(file.id), JSON.stringify(file, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** ─── The ledger ───────────────────────────────────────────────────────────── */

/**
 * The ledger a loop threads its steps through.
 *
 * Deliberately tiny: `replay` answers "was this step already answered, and for
 * THIS input", `record` files an answer for the next run, and `openNotice` says
 * what the record held. Everything a caller needs to decide is here; how the
 * numbers are reported is `closeResume`'s job.
 */
export interface StepReplay {
  /** The recorded answer for this exact input, or null (with a reason recorded). */
  replay(key: string, digest: string): ToolCallResponse | null;
  /** File an answer this run paid for, so the next one can replay it. */
  record(key: string, digest: string, response: ToolCallResponse): void;
  /** What the RECORD held, said before any step was attempted. */
  openNotice(): string;
}

interface LedgerState {
  id: string;
  goal: string;
  cwd: string;
  /** Steps the record held when it was opened (what `openNotice` reports). */
  loaded: number;
  replayed: number;
  modelCalls: number;
  /** Why a step missed, counted by reason, in the order they were first seen. */
  misses: Map<string, number>;
  /** The record this run will write: replayed entries carried forward, plus new. */
  staged: Map<string, StepEntry>;
}

/** The ledger instances this module created, so `closeResume` can read its state. */
const STATES = new WeakMap<StepReplay, LedgerState>();

/** A response with no text and no tool call is a provider failure, not an answer. */
function isEmptyResponse(response: ToolCallResponse): boolean {
  if (!response || typeof response !== 'object') return true;
  const text = typeof response.content === 'string' ? response.content.trim() : '';
  const calls = Array.isArray(response.toolCalls) ? response.toolCalls.length : 0;
  return text === '' && calls === 0;
}

/** An opened resume: its record id, and the ledger to thread through the run. */
export interface OpenResume {
  id: string;
  goal: string;
  cwd: string;
  ledger: StepReplay;
}

/**
 * Open the record for this ask, reading it once (a record is not re-read per step).
 */
export function openResume(input: { goal: string; cwd: string; resume: ResumeRequest }): OpenResume {
  const id = input.resume.id?.trim() || checkpointIdFor(input.goal, input.cwd);
  const prior = readRecord(id);
  const state: LedgerState = {
    id,
    goal: input.goal,
    cwd: input.cwd,
    loaded: prior.length,
    replayed: 0,
    modelCalls: 0,
    misses: new Map(),
    staged: new Map(),
  };
  const byKey = new Map(prior.map((entry) => [entry.key, entry]));

  const ledger: StepReplay = {
    replay(key, digest) {
      const entry = byKey.get(key);
      if (!entry) {
        countMiss(state, MISSING_REASON);
        return null;
      }
      if (entry.digest !== digest) {
        countMiss(state, CHANGED_REASON);
        return null;
      }
      if (isEmptyResponse(entry.response)) {
        countMiss(state, EMPTY_REASON);
        return null;
      }
      state.replayed += 1;
      // Carried forward: a step this run did not PAY for is still part of what the
      // next resume should be able to replay, so it goes back into the record.
      state.staged.set(key, entry);
      return entry.response;
    },
    record(key, digest, response) {
      state.modelCalls += 1;
      state.staged.set(key, { key, digest, response });
    },
    openNotice() {
      return state.loaded > 0
        ? `↩️  resumed: ${state.loaded} recorded step(s) loaded — a step replays only when its whole input is unchanged`
        : '↩️ no record for this ask in this directory yet — this run will write one';
    },
  };
  STATES.set(ledger, state);
  return { id, goal: input.goal, cwd: input.cwd, ledger };
}

function countMiss(state: LedgerState, reason: string): void {
  state.misses.set(reason, (state.misses.get(reason) ?? 0) + 1);
}

/** What a resumed run replayed, what it paid for, and whether the record survived. */
export interface ResumeOutcome {
  id: string;
  /** Steps served from the record (each one a model call NOT made). */
  replayed: number;
  /** Model calls the RESUMED run still made (0 = every step came from the record). */
  modelCalls: number;
  /** False when the record could not be written (the run itself still happened). */
  saved: boolean;
  /** The operator-facing line: the counts, and why nothing replayed when it didn't. */
  notice: string;
}

/**
 * Close the ledger: write back what this run learned, and report the real counts.
 *
 * The record is rewritten only from what this run staged — the entries it replayed
 * plus the ones it paid for — which is what makes the chain work: the next resume
 * replays what this one learned, and a step nobody could use is not carried along
 * as if it had been.
 */
export function closeResume(resume: OpenResume, input: { goal: string; cwd: string }): ResumeOutcome {
  const state = STATES.get(resume.ledger);
  if (!state) {
    const notice = '↩️  resume probe: replayed 0, made 0 model call(s)';
    return { id: resume.id, replayed: 0, modelCalls: 0, saved: false, notice };
  }
  const steps = [...state.staged.values()];
  let saved: boolean;
  if (steps.length === 0) {
    // Nothing was learned and nothing was replayed. Writing an empty record would
    // REPLACE a usable one with nothing, so the file is left alone.
    saved = true;
  } else {
    saved = writeRecord({
      id: state.id,
      goal: input.goal,
      cwd: input.cwd,
      savedAt: Date.now(),
      steps,
    });
  }

  const lines = [
    `↩️  resume probe: replayed ${state.replayed}, made ${state.modelCalls} model call(s)`,
  ];
  if (state.replayed === 0 && state.misses.size > 0) {
    const reasons = [...state.misses.entries()].map(([reason, count]) => `${reason} (${count})`);
    lines.push(`     why not: ${reasons.join(', ')}`);
  }
  if (!saved) {
    lines.push('     the record could not be written — the next resume will not see this run');
  }
  return {
    id: state.id,
    replayed: state.replayed,
    modelCalls: state.modelCalls,
    saved,
    notice: lines.join('\n'),
  };
}
