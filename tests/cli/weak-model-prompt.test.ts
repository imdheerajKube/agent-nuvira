/**
 * Tests for the interactive weak-model decision (routing.promptOnWeakModel).
 *
 * Covers:
 * 1. shouldPromptWeakModel() gate — enabled only when promptOnWeakModel === true
 * 2. promptWeakModelChoice() — returns 'continue' / 'wait' / 'abort' based on
 *    the mocked inquirer answer (never touches a real terminal)
 * 3. The 'wait' option is only offered when waitAvailable is true
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { shouldPromptWeakModel, promptWeakModelChoice } from '../../src/cli/weak-model-prompt.js';
import { logger } from '../../src/utils/logger.js';

// Mock inquirer so the prompt never touches a real terminal in tests.
vi.mock('inquirer', () => ({
  default: { prompt: vi.fn() },
}));

import inquirer from 'inquirer';
const promptMock = vi.mocked(inquirer.prompt);

describe('weak-model-prompt — shouldPromptWeakModel gate', () => {
  it('is false when routing config is absent (silent weak-model continuation default)', () => {
    expect(shouldPromptWeakModel({})).toBe(false);
    expect(shouldPromptWeakModel({ routing: undefined })).toBe(false);
  });

  it('is false when promptOnWeakModel is unset or false', () => {
    expect(shouldPromptWeakModel({ routing: {} })).toBe(false);
    expect(shouldPromptWeakModel({ routing: { promptOnWeakModel: false } })).toBe(false);
  });

  it('is true only when routing.promptOnWeakModel === true', () => {
    expect(shouldPromptWeakModel({ routing: { promptOnWeakModel: true } })).toBe(true);
  });
});

describe('weak-model-prompt — promptWeakModelChoice', () => {
  beforeEach(() => {
    promptMock.mockReset();
    // Silence logger output in tests.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns continue when the user picks continue', async () => {
    promptMock.mockResolvedValue({ action: 'continue' });
    const choice = await promptWeakModelChoice('local/gemma4:e4b', { waitAvailable: false });
    expect(choice).toBe('continue');
    // No 'wait' choice offered when no stronger candidate is recovering.
    const choices = promptMock.mock.calls[0][0][0].choices as Array<{ value: string }>;
    expect(choices.some((c) => c.value === 'wait')).toBe(false);
  });

  it('returns abort when the user picks abort', async () => {
    promptMock.mockResolvedValue({ action: 'abort' });
    const choice = await promptWeakModelChoice('local/gemma4:e4b', { waitAvailable: false });
    expect(choice).toBe('abort');
  });

  it('offers AND returns wait when waitAvailable is true and the user picks it', async () => {
    promptMock.mockResolvedValue({ action: 'wait' });
    const choice = await promptWeakModelChoice('local/gemma4:e4b', { waitAvailable: true });
    expect(choice).toBe('wait');
    const choices = promptMock.mock.calls[0][0][0].choices as Array<{ value: string }>;
    expect(choices.some((c) => c.value === 'wait')).toBe(true);
  });

  it('does not offer wait when waitAvailable is false', async () => {
    promptMock.mockResolvedValue({ action: 'continue' });
    await promptWeakModelChoice('local/gemma4:e4b', { waitAvailable: false });
    const choices = promptMock.mock.calls[0][0][0].choices as Array<{ value: string }>;
    expect(choices.some((c) => c.value === 'wait')).toBe(false);
    expect(choices.some((c) => c.value === 'abort')).toBe(true);
    expect(choices.some((c) => c.value === 'continue')).toBe(true);
  });
});
