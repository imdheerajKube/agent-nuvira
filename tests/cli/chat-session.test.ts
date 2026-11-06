/**
 * CHAT TURNS ARE RESUMABLE — the layer that was missing.
 *
 * `execute` and subagents checkpointed their thread; `chat` did not, so a chat
 * build that hit its step budget or lost its process left NOTHING on disk. These
 * tests drive the real `runChatAnswer` twice, on a hermetic memory directory:
 *
 *   1. a bounded turn leaves its session OPEN (the snapshot `nuvira resume` reads),
 *   2. the next turn on the same ask REHYDRATES that transcript (the model sees the
 *      prior tool result without being told it again),
 *   3. a clean turn CLOSES the session, so a finished conversation is never resumed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatCommand } from '../../src/cli/chat.js';
import { ConfigManager } from '../../src/config/manager.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';
import {
  findResumableSessionFor,
  listSessionSnapshots,
} from '../../src/learning/session-store.js';
import type { InferenceProvider } from '../../src/inference/interface.js';

const GOAL = 'build the resumable checkout flow';
const MARKER = 'MARKER-FROM-THE-DEAD-TURN-9f2a';

describe('chat session checkpointing + rehydration', () => {
  let tempDir: string;
  let workCwd: string;
  let originalCwd: string;
  let origMemory: string | undefined;
  let origConfig: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), 'buff-chat-session-'));
    origMemory = process.env.NUVIRA_MEMORY_DIR;
    origConfig = process.env.NUVIRA_CONFIG_DIR;
    process.env.NUVIRA_MEMORY_DIR = join(tempDir, 'memory');
    process.env.NUVIRA_CONFIG_DIR = join(tempDir, 'config');
    // The workspace is the temp dir, so a bounded turn cannot touch the repo.
    process.chdir(tempDir);
    // macOS: /var is a symlink to /private/var, and `process.cwd()` returns the
    // RESOLVED path. The session id hashes cwd, so every lookup in this test must
    // use the same resolved string the store wrote with.
    workCwd = process.cwd();
    writeFileSync(join(workCwd, 'marker.txt'), MARKER, 'utf-8');
    resetModelRegistry();

    // Keep the bounded turn cheap and deterministic: the budget under test is the
    // session store, not the step policy.
    new ConfigManager().save({ turn: { maxSteps: 2, maxTotalSteps: 3 } } as never);
  });

  afterEach(() => {
    resetModelRegistry();
    try {
      process.chdir(originalCwd);
    } catch {
      /* noop */
    }
    if (origMemory === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = origMemory;
    if (origConfig === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = origConfig;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
    vi.restoreAllMocks();
  });

  /** A provider that keeps reading a file, so the turn runs to its step bound. */
  function loopingProvider(): InferenceProvider {
    let id = 0;
    return {
      name: 'Mock',
      generateTools: vi.fn(async () => {
        id += 1;
        return {
          content: '',
          toolCalls: [{ id: `c${id}`, name: 'read_file', arguments: { path: 'marker.txt' } }],
        };
      }),
      generate: vi.fn().mockResolvedValue('unused'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;
  }

  /** A provider that answers cleanly, capturing the thread it was handed. */
  function answeringProvider(): { provider: InferenceProvider; thread: () => Array<{ role: string; content: string }> } {
    const seen: Array<Array<{ role: string; content: string }>> = [];
    let step = 0;
    const provider = {
      name: 'Mock',
      generateTools: vi.fn(async (messages: Array<{ role: string; content: string }>) => {
        if (seen.length === 0) seen.push(messages.slice());
        step += 1;
        if (step === 1) {
          return { content: '', toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'marker.txt' } }] };
        }
        return { content: 'All done.', toolCalls: [] };
      }),
      generate: vi.fn().mockResolvedValue('unused'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;
    return { provider, thread: () => seen[0] ?? [] };
  }

  const runTurn = async (provider: InferenceProvider) => {
    const cmd = new ChatCommand() as unknown as { runChatAnswer: Function };
    return cmd.runChatAnswer(
      GOAL,
      [],
      { type: 'groq', provider, model: 'mock-model' },
      {},
      false,
      { auto: false },
    );
  };

  it('a bounded turn stays OPEN, and the next turn continues from it', async () => {
    const first = await runTurn(loopingProvider());
    expect(first.bounded).toBe(true);

    // 1. The work is on disk and reachable by `nuvira resume`.
    const open = findResumableSessionFor(GOAL, workCwd);
    const stored = listSessionSnapshots().map((s) => ({ goal: s.goal, cwd: s.cwd, open: s.open, steps: s.accumulators.steps }));
    expect(
      open,
      `the bounded chat turn left an OPEN snapshot (bounded=${String(first.bounded)}, steps=${String(first.steps)}, stored=${JSON.stringify(stored)})`,
    ).not.toBeNull();
    expect(open!.accumulators.steps).toBeGreaterThan(0);
    const listed = listSessionSnapshots().filter((s) => s.open && s.goal === GOAL);
    expect(listed.length).toBe(1);

    // 2. The next turn on the SAME ask is handed the prior transcript: the
    //    marker file's content arrives as a tool result the model did not re-read.
    const second = answeringProvider();
    const out = await runTurn(second.provider);
    expect(out.content).toBe('All done.');
    const thread = second.thread();
    expect(
      thread.some((m) => m.role === 'tool' && m.content.includes(MARKER)),
      'the rehydrated thread carries the dead turn’s tool result',
    ).toBe(true);

    // 3. A clean turn CLOSES the session — history, not a resume point.
    expect(findResumableSessionFor(GOAL, workCwd)).toBeNull();
  });

  it('a clean turn never leaves a resumable snapshot (no accidental continuation)', async () => {
    const provider = {
      name: 'Mock',
      generateTools: vi.fn().mockResolvedValue({ content: 'Answered directly.', toolCalls: [] }),
      generate: vi.fn().mockResolvedValue('unused'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;

    const out = await runTurn(provider);
    expect(out.bounded).toBeFalsy();
    expect(findResumableSessionFor(GOAL, workCwd)).toBeNull();
  });
});
