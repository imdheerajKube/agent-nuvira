/**
 * output.ts — the Agent-Nuvira Output channel.
 *
 * The point of this module is that it can never break the thing it reports on:
 * a user with a missing CLI, or a test with no real `vscode`, must not see the
 * extension die because a log line failed. These tests pin both the happy path
 * (lines reach the channel, timestamped) and the failure path (a throwing
 * channel is swallowed).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// The extension imports the real `vscode` module; point it at the mock.
vi.mock('vscode', () => import('./__mocks__/vscode.js'));

import { log, logError, getOutputChannel } from '../output.js';
import { outputChannelLines } from './__mocks__/vscode.js';

beforeEach(() => {
  outputChannelLines.length = 0;
});

describe('output channel', () => {
  it('writes a timestamped line to the Agent-Nuvira channel', () => {
    log('hello world');

    expect(outputChannelLines).toHaveLength(1);
    expect(outputChannelLines[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\] hello world$/);
  });

  it('prefixes errors so they can be grepped out of the log', () => {
    logError('CLI not found');
    expect(outputChannelLines[0]).toMatch(/ERROR CLI not found$/);
  });

  it('creates the channel lazily and reuses it', () => {
    const first = getOutputChannel();
    const second = getOutputChannel();
    expect(first).toBe(second);
  });

  it('never throws when the channel itself throws', () => {
    const channel = getOutputChannel() as unknown as { appendLine: (s: string) => void };
    const spy = vi.spyOn(channel, 'appendLine').mockImplementation(() => {
      throw new Error('channel exploded');
    });

    expect(() => log('this must not escape')).not.toThrow();
    spy.mockRestore();
  });
});
