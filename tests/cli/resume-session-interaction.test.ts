/**
 * TWO RESUME MECHANISMS, ONE WINNER — the session store must not defeat the ledger.
 *
 * THE FLAKE THIS EXPLAINS AND PINS. The parity row `partial-resume` asserts that on
 * every surface the second of a pair of turns replays BOTH recorded steps and makes
 * ZERO model calls. It has failed intermittently (and never reproduced in 24
 * targeted runs, including 12 under six-way CPU contention), because the outcome
 * depends on a piece of state that is neither the ledger nor the scenario: whether
 * the FIRST turn of the pair left an OPEN session snapshot behind.
 *
 * When it did, the second turn's thread was the FIRST turn's transcript (session
 * rehydration) instead of the fresh head + goal (the ledger's input), so every
 * recorded step's digest differed, the replay missed everywhere, and the run
 * re-paid for model calls it had already made — reporting `replayed 0, made 2` for
 * a claim of `replayed 2, made 0`.
 *
 * WHY THAT STATE IS REACHABLE. A session snapshot is written OPEN at every step
 * boundary and closed at a CLEAN end; a run that is killed, cancelled or throws
 * leaves it open by design ("remains resumable"). So any teardown that races the
 * clean end — a timeout under load, a parent killing a child, an abort — is enough
 * to hand the next resumed run a tail the ledger never hashed.
 *
 * THE RULE BOTH ARMS NOW FOLLOW: rehydrate UNLESS this run will replay. An
 * explicit resume is exactly when the ledger replays, and then the ledger's record
 * IS the transcript of model calls — prepending the session tail can only make it
 * unusable. Everywhere else (checkpoint-only runs, ordinary runs) rehydration is
 * unchanged, which is what the second half below holds in place.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '../../src/config/manager.js';
import { findResumableSessionFor, openSession } from '../../src/learning/session-store.js';
import type { InferenceProvider, ToolCallResponse, ToolMessage, ToolSchema } from '../../src/inference/interface.js';

const GOAL = 'add a changelog entry for the parser fix';
/** A message only a rehydrated transcript could carry. */
const MARKER = 'STALE-CONTINUATION-MARKER';

/** A provider that RECORDS the thread it was handed, so rehydration is visible. */
function recordingProvider(responses: ToolCallResponse[]): {
  provider: InferenceProvider;
  calls: () => number;
  firstThread: () => ToolMessage[];
} {
  const seen: ToolMessage[][] = [];
  let i = 0;
  const provider = {
    name: 'Scripted',
    async generate(): Promise<string> {
      throw new Error('generate() must not be reached on the native path');
    },
    async generateTools(messages: ToolMessage[], _tools: ToolSchema[]): Promise<ToolCallResponse> {
      seen.push(messages.slice());
      return responses[i++] ?? { content: 'done', toolCalls: [] };
    },
  } as unknown as InferenceProvider;
  return {
    provider,
    calls: () => i,
    firstThread: () => seen[0] ?? [],
  };
}

const TWO_STEPS: ToolCallResponse[] = [
  { content: '', toolCalls: [{ id: 'c1', name: 'list_dir', arguments: { path: '.' } }] },
  { content: 'Added the entry.', toolCalls: [] },
];

describe('an explicit resume survives a leftover OPEN session snapshot', () => {
  let dir: string;
  let memoryDir: string;
  let previousMemoryDir: string | undefined;
  let previousBuffMemoryDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nuvira-resume-session-'));
    memoryDir = join(dir, 'memory');
    previousMemoryDir = process.env.NUVIRA_MEMORY_DIR;
    previousBuffMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.NUVIRA_MEMORY_DIR = memoryDir;
    process.env.BUFF_MEMORY_DIR = memoryDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (previousMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = previousMemoryDir;
    if (previousBuffMemoryDir === undefined) delete process.env.BUFF_MEMORY_DIR;
    else process.env.BUFF_MEMORY_DIR = previousBuffMemoryDir;
    vi.doUnmock('../../src/cli/router.js');
    vi.resetModules();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A run of the same ask, with a fresh provider so model calls are countable.
   *
   * `vi.resetModules()` BEFORE the import, not just a fresh `doMock`: a mock
   * registered after the module was first imported is not re-read, so the second
   * run of a test would silently reuse the FIRST run's provider — and an assertion
   * like "the second provider was never called" would then hold for the wrong
   * reason (it was never wired up). `second.calls() === 0` is only evidence when
   * the provider was actually in play.
   */
  const run = async (
    provider: InferenceProvider,
    opts: { resume?: boolean; checkpoint?: boolean },
  ) => {
    vi.resetModules();
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'scripted', provider }),
    }));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    return runLoopExecutor(GOAL, new ConfigManager(), {
      provider: 'scripted',
      skipProjectContext: true,
      quiet: true,
      ...opts,
    });
  };

  /**
   * Simulate the run whose teardown raced its clean end: an OPEN snapshot holding a
   * transcript only that dead run could have produced.
   */
  const leaveSequelOpen = (): void => {
    const store = openSession({ goal: GOAL, cwd: process.cwd() });
    store.save([{ role: 'user', content: MARKER }], {
      steps: 1,
      successfulTools: [],
      mutatedPaths: [],
    });
    // The state under test has to EXIST: a best-effort write that failed would
    // leave both halves below passing against nothing at all.
    expect(store.lastSaved(), 'the sabotaged session snapshot reached the disk').toBe(true);
    expect(
      findResumableSessionFor(GOAL, process.cwd()),
      'the open snapshot is what a resume would find',
    ).not.toBeNull();
  };

  it('replays every recorded step with zero model calls, despite the open snapshot', async () => {
    // Turn 1 writes the record (and closes its own session).
    const first = recordingProvider(TWO_STEPS);
    const recorded = await run(first.provider, { resume: true });
    expect(recorded.resume?.replayed).toBe(0);
    expect(recorded.resume?.modelCalls).toBe(2);
    expect(first.calls()).toBe(2);

    // Now the part the flake turned on: a dead run's OPEN transcript for this ask.
    leaveSequelOpen();

    // Turn 2 must come from the RECORD, not from that transcript.
    const second = recordingProvider(TWO_STEPS);
    const resumed = await run(second.provider, { resume: true });

    expect(resumed.resume?.replayed).toBe(2);
    expect(resumed.resume?.modelCalls).toBe(0);
    // The strongest form of the claim: no model was reached at all, so a rehydrated
    // thread could not have been sent to one.
    expect(second.calls()).toBe(0);
  });

  it('still rehydrates an open snapshot when nothing replays (checkpoint-only run)', async () => {
    // A run that only SAVES the record (no replay) — the default `execute` policy.
    const first = recordingProvider(TWO_STEPS);
    await run(first.provider, { checkpoint: true });
    leaveSequelOpen();

    // No explicit resume ⇒ no replay ⇒ the session tail is the continuation, and
    // that behaviour is deliberately unchanged.
    const second = recordingProvider(TWO_STEPS);
    const secondRun = await run(second.provider, { checkpoint: true });

    // Nothing replayed (the ledger was opened to SAVE, not to serve)…
    expect(secondRun.resume?.replayed).toBe(0);
    expect(secondRun.resume?.modelCalls).toBe(2);
    // …and the open transcript IS the continuation, exactly as before this rule.
    const thread = second.firstThread();
    expect(thread.some((m) => typeof m.content === 'string' && m.content.includes(MARKER))).toBe(true);
  });
});
