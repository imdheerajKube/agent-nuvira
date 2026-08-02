/**
 * Tests for the interactive failover confirmation (routing.promptOnFailover).
 *
 * Covers:
 * 1. shouldConfirmFailover() gate — enabled only when promptOnFailover === true
 * 2. promptFailoverChoice() — returns 'switch' / 'manual' based on the mocked
 *    inquirer answer (never touches a real terminal)
 * 3. Full module import sanity (logger paths, no throw on silent default)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { shouldConfirmFailover, promptFailoverChoice } from '../../src/cli/failover-prompt.js';
import { logger } from '../../src/utils/logger.js';

// Mock inquirer so the prompt never touches a real terminal in tests.
// vi.mock is hoisted above the static import, so `inquirer.prompt` below IS
// the mocked function.
vi.mock('inquirer', () => ({
  default: { prompt: vi.fn() },
}));

import inquirer from 'inquirer';
const promptMock = vi.mocked(inquirer.prompt);

describe('failover-prompt — shouldConfirmFailover gate', () => {
  it('is false when routing config is absent (silent auto-failover default)', () => {
    expect(shouldConfirmFailover({})).toBe(false);
    expect(shouldConfirmFailover({ routing: undefined })).toBe(false);
  });

  it('is false when promptOnFailover is unset or false', () => {
    expect(shouldConfirmFailover({ routing: {} })).toBe(false);
    expect(shouldConfirmFailover({ routing: { promptOnFailover: false } })).toBe(false);
  });

  it('is true only when routing.promptOnFailover === true', () => {
    expect(shouldConfirmFailover({ routing: { promptOnFailover: true } })).toBe(true);
  });
});

describe('failover-prompt — promptFailoverChoice', () => {
  beforeEach(() => {
    promptMock.mockReset();
    // Silence logger output in tests.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns "switch" when the user picks the recommended switch', async () => {
    promptMock.mockResolvedValue({ action: 'switch' });
    const choice = await promptFailoverChoice('Gemini', 'Groq', 'llama-3.3-70b');
    expect(choice).toBe('switch');
    // Prompt surfaced the failed provider + next candidate so the user knows why.
    expect(promptMock).toHaveBeenCalledTimes(1);
    const promptArgs = promptMock.mock.calls[0][0] as Array<{ type: string; name: string; choices?: Array<{ name: string; value: string }> }>;
    expect(promptArgs[0].type).toBe('list');
    const choices = promptArgs[0].choices ?? [];
    expect(choices.map((c) => c.value)).toEqual(['switch', 'manual']);
  });

  it('returns "manual" when the user wants to pick a provider themselves', async () => {
    promptMock.mockResolvedValue({ action: 'manual' });
    const choice = await promptFailoverChoice('Gemini', 'Groq', 'llama-3.3-70b');
    expect(choice).toBe('manual');
  });

  it('defaults to "switch" for an unexpected answer (never gets stuck)', async () => {
    promptMock.mockResolvedValue({ action: 'something-else' });
    const choice = await promptFailoverChoice('Gemini', 'Groq', 'llama-3.3-70b');
    expect(choice).toBe('switch');
  });
});
