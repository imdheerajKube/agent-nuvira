/**
 * Followup selection — single-shot chat/execute flows.
 *
 * Regression tests for the "followups are printed but the process quits"
 * bug: `nuvira chat "<prompt>"` and `nuvira execute "<goal>"` on a real terminal
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
    originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
    process.env.NUVIRA_MEMORY_DIR = tempDir;
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
    if (originalMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
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
    originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
    process.env.NUVIRA_MEMORY_DIR = tempDir;
    resetModelRegistry();
    cmd = new ExecuteCommand();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreTTY();
    resetModelRegistry();
    if (originalMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
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

  /**
   * The reported defect: `nuvira execute` offered only its generic menu while the
   * model's own suggestions were dropped at the result boundary, so the ONE thing
   * a followup is for — clicking it — never happened.
   */
  it('puts the turn\'s OWN suggestions in the post-run menu, without a second model call', async () => {
    const generate = vi.spyOn(cmd as any, 'generateFollowUpSuggestions');

    const actions = await (cmd as any).generatePostExecutionActions(
      {
        success: true,
        content: 'Done.',
        followups: [
          { prompt: 'Add a test for the limiter', label: 'Add a test' },
          { prompt: 'Explain the backpressure trade-off' },
        ],
      },
      undefined,
      undefined,
      {},
    );

    const values = actions.map((a: { value: string }) => a.value);
    expect(values).toContain('followup:Add a test for the limiter');
    expect(values).toContain('followup:Explain the backpressure trade-off');
    expect(actions.map((a: { name: string }) => a.name)).toContain('💡  Add a test');
    // The model already suggested these — inventing others would cost a model
    // call AND be less relevant than what it just offered.
    expect(generate).not.toHaveBeenCalled();
  });

  /**
   * The user-visible half: the arrow-key menu is what a person actually picks
   * from, so the suggestions have to arrive as CHOICES there (`followup:<prompt>
   * ` values), not merely exist on an action list.
   */
  it('offers them as pickable menu choices, and a picked one becomes the next goal', async () => {
    setTTY(true);
    const promptSpy = vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'exit' } as any);
    const actions = await (cmd as any).generatePostExecutionActions(
      {
        success: true,
        content: 'Done.',
        followups: [{ prompt: 'Run the existing test suite', label: 'Run the tests' }],
      },
      undefined,
      undefined,
      {},
    );
    // Wrapped in the same list prompt the interactive loop shows.
    const answer = await inquirer.prompt<{ action: string }>([
      { type: 'list', name: 'action', message: 'What next?', prefix: '🚀', choices: actions },
    ]);
    const choices = (promptSpy.mock.calls[0][0] as Array<{ choices: Array<{ name: string; value: string }> }>)[0].choices;
    const suggested = choices.find((c) => c.value === 'followup:Run the existing test suite');
    expect(suggested).toBeDefined();
    expect(suggested?.name).toBe('💡  Run the tests');
    // And the generic entry is still there, so nothing is taken away.
    expect(choices.some((c) => c.value === 'continue')).toBe(true);
    expect(answer.action).toBe('exit');
    promptSpy.mockRestore();
  });

  it('falls back to the generator when the run reported no suggestions', async () => {
    const generate = vi
      .spyOn(cmd as any, 'generateFollowUpSuggestions')
      .mockResolvedValue([{ label: 'Run the tests', description: '', goal: 'Run the test suite' }]);

    const actions = await (cmd as any).generatePostExecutionActions(
      {
        success: true,
        orchestrationResult: { goal: 'g', success: true, summary: 's', agentResults: [] },
      },
      undefined,
      undefined,
      {},
    );

    expect(generate).toHaveBeenCalledTimes(1);
    expect(actions.map((a: { value: string }) => a.value)).toContain('followup:Run the test suite');
  });
});
