/**
 * Followup selection — single-shot chat/execute flows.
 *
 * Regression tests for the "followups are printed but the process quits"
 * bug: `buff chat "<prompt>"` and `buff execute "<goal>"` on a real terminal
 * printed the suggested followups and then exited, so nothing was selectable.
 *
 * Covered here:
 * - chat single-shot on a TTY: picking a number runs that followup as the
 *   next turn (conversation threaded); pressing Enter ends the session.
 * - chat single-shot on a non-TTY (scripts/CI/pipes): prints the list and
 *   exits — automation is never blocked by a prompt.
 * - execute single-shot on a TTY: a picked followup runs as the next goal
 *   instead of quitting.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import inquirer from 'inquirer';

import { ChatCommand } from '../../src/cli/chat.js';
import { ExecuteCommand } from '../../src/cli/execute.js';
import { logger } from '../../src/utils/logger.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';
import type { InferenceProvider } from '../../src/inference/interface.js';

// ─── TTY helpers ────────────────────────────────────────────────────────────
// In vitest, process.stdin is piped (isTTY undefined). These helpers let a
// test simulate a real terminal so the interactive followup paths run.

const ORIGINAL_IS_TTY = (process.stdin as { isTTY?: boolean }).isTTY;

function setTTY(on: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
}

function restoreTTY(): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: ORIGINAL_IS_TTY, configurable: true });
}

// ─── ChatCommand single-shot ────────────────────────────────────────────────

describe('ChatCommand single-shot — selectable followups', () => {
  let tempDir: string;
  let originalMemoryDir: string | undefined;
  let cmd: ChatCommand;

  // The provider only needs isAvailable for the single-shot path; the turn
  // itself is stubbed via runChatAnswer.
  const mockProvider = {
    name: 'Mock',
    isAvailable: vi.fn().mockResolvedValue(true),
    generate: vi.fn().mockResolvedValue('unused'),
    getInfo: () => 'Mock',
    listModels: vi.fn().mockResolvedValue([]),
  } as unknown as InferenceProvider;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'highlight').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'buff-followups-chat-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
    resetModelRegistry();
    cmd = new ChatCommand();
    vi.spyOn(cmd as unknown as { getProvider: Function }, 'getProvider').mockResolvedValue({
      type: 'mock',
      provider: mockProvider,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreTTY();
    resetModelRegistry();
    if (originalMemoryDir === undefined) delete process.env.BUFF_MEMORY_DIR;
    else process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('runs a picked followup as the next turn, then falls through to interactive mode on Enter', async () => {
    setTTY(true);

    // The chat answer is stubbed: turn 1 answers with 2 followups, the picked
    // followup answers with no more followups (Enter falls through to interactive).
    const runChatAnswer = vi
      .spyOn(cmd as unknown as { runChatAnswer: Function }, 'runChatAnswer')
      .mockResolvedValueOnce({
        content: 'First answer.',
        followups: [
          { prompt: 'Tell me more', label: 'Tell me more' },
          { prompt: 'Do something else', label: 'Do something else' },
        ],
      })
      .mockResolvedValueOnce({
        content: 'Followup answer.',
        followups: [],
      });

    // User picks followup #1, then presses Enter (falls through to interactive),
    // then types /exit to quit the interactive loop.
    const inquirerPrompt = vi.spyOn(inquirer, 'prompt').mockResolvedValueOnce({ n: '1' } as any);
    // Mock readMultiLineInput to return /exit so the interactive loop exits.
    vi.spyOn(cmd as unknown as { readMultiLineInput: Function }, 'readMultiLineInput')
      .mockResolvedValue('/exit');
    // Mock process.exit to prevent vitest from failing.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await (cmd as unknown as { execute: Function }).execute('my first prompt', {
      provider: 'mock',
      model: 'mock-model',
      cache: false,
    });

    // The followup was executed as turn 2, threaded with turn 1's history.
    expect(runChatAnswer).toHaveBeenCalledTimes(2);
    const secondCall = runChatAnswer.mock.calls[1];
    expect(secondCall[0]).toBe('Tell me more');
    // The continuation history carries the original prompt + turn-1 answer
    // (slice: the recorded call holds the live array, which the loop later
    // appends the followup answer to).
    expect(secondCall[1].slice(0, 2)).toEqual([
      { role: 'user', content: 'my first prompt' },
      { role: 'assistant', content: 'First answer.' },
    ]);
    // The followup answer was printed, and the menu ended on Enter.
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Followup answer.'));
    expect(inquirerPrompt).toHaveBeenCalledTimes(1);
    // process.exit was called (interactive loop ended via /exit).
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it('prints the followup list and exits without prompting on a non-TTY', async () => {
    setTTY(false);

    const runChatAnswer = vi
      .spyOn(cmd as unknown as { runChatAnswer: Function }, 'runChatAnswer')
      .mockResolvedValueOnce({
        content: 'The answer.',
        followups: [{ prompt: 'Next step', label: 'Next step' }],
      });

    const inquirerPrompt = vi.spyOn(inquirer, 'prompt');

    await (cmd as unknown as { execute: Function }).execute('automation prompt', {
      provider: 'mock',
      model: 'mock-model',
      cache: false,
    });

    // One turn only — no continuation, no interactive pick.
    expect(runChatAnswer).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('The answer.'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Next step'));
    expect(inquirerPrompt).not.toHaveBeenCalled();
  });
});

// ─── ExecuteCommand single-shot ─────────────────────────────────────────────

describe('ExecuteCommand single-shot — followup runs as next goal', () => {
  let tempDir: string;
  let originalMemoryDir: string | undefined;
  let cmd: ExecuteCommand;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'highlight').mockImplementation(() => {});
    vi.spyOn(logger, 'success').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'buff-followups-exec-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
    resetModelRegistry();
    cmd = new ExecuteCommand();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreTTY();
    resetModelRegistry();
    if (originalMemoryDir === undefined) delete process.env.BUFF_MEMORY_DIR;
    else process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('runs a picked followup as the next goal and exits when the user says so', async () => {
    setTTY(true);

    const successResult = {
      success: true,
      orchestrationResult: {
        goal: 'initial goal',
        success: true,
        summary: 'Done',
        error: '',
        fileChanges: '',
        runOutput: '',
        agentResults: [],
        tasksCompleted: 1,
        tasksTotal: 1,
        trajectoryId: '',
      },
    };

    const runSingleGoal = vi.spyOn(cmd as unknown as { runSingleGoal: Function }, 'runSingleGoal').mockResolvedValue(successResult);

    // Post-run menu #1: user picks the followup goal. Menu #2 (after the
    // followup ran): user exits.
    const handlePostExecution = vi
      .spyOn(cmd as unknown as { handlePostExecution: Function }, 'handlePostExecution')
      .mockResolvedValueOnce({
        action: { type: 'followup', goal: 'Suggested next goal' },
        updatedLastFailed: null,
      })
      .mockResolvedValueOnce({
        action: { type: 'exit' },
        updatedLastFailed: null,
      });

    await (cmd as unknown as { execute: Function }).execute('initial goal', {
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
    });

    // The followup ran as a real second goal — the process did NOT quit after
    // printing the suggestions.
    expect(runSingleGoal).toHaveBeenCalledTimes(2);
    expect(runSingleGoal.mock.calls[0][0]).toBe('initial goal');
    expect(runSingleGoal.mock.calls[1][0]).toBe('Suggested next goal');
    expect(handlePostExecution).toHaveBeenCalledTimes(2);
    expect(logger.success).toHaveBeenCalledWith(expect.stringContaining('Done. Happy coding'));
  });
});
