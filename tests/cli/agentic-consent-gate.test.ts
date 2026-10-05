/**
 * Workstream B — the ask-first weak-model CONSENT gate, driven through the
 * shared chat engine (`ChatCommand.answerOnce`).
 *
 * Contract: an agentic/software turn must never silently run on a weak model.
 * On an interactive surface it ASKS once for the session (approve / wait for a
 * strong model); the answer is remembered per session and a new session asks
 * again. Nothing capable available + "wait" → an honest refusal, never a silent
 * downgrade.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ChatCommand } from '../../src/cli/chat.js';
import { logger } from '../../src/utils/logger.js';
import { resetWeakModelConsent } from '../../src/learning/agentic-route-gate.js';

/** A weak routed decision (agentic ask → local ≤4B model). */
function weakRouted() {
  return {
    type: 'local',
    provider: { name: 'Local', isAvailable: vi.fn().mockResolvedValue(true) },
    model: 'gemma4:e4b',
    ranked: ['local'],
    complexity: 'moderate',
    score: 0.4,
    agenticCapable: false,
    taskProfile: { intent: 'coding', requiresVerification: false },
  };
}

function makeCommand(over: { askUser?: unknown } = {}) {
  const cmd = new ChatCommand() as any;
  cmd.configManager = { getAll: () => ({}), getProviderConfig: () => ({ type: 'local', config: {} }) };
  cmd.getProvider = vi.fn(async () => ({
    type: 'local',
    provider: { name: 'Local', isAvailable: vi.fn().mockResolvedValue(true) },
  }));
  cmd.routeMessageAuto = vi.fn(async () => weakRouted());
  cmd.runChatAnswer = vi.fn(async () => ({ content: 'worked', followups: [], toolCalls: [] }));
  return cmd;
}

const opts = (extra: Record<string, unknown> = {}) => ({
  provider: 'auto',
  debugSession: 's1',
  history: [],
  ...extra,
});

describe('answerOnce — ask-first weak-model consent gate', () => {
  beforeEach(() => {
    resetWeakModelConsent();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const m of ['info', 'warn', 'error', 'success', 'highlight'] as const) {
      vi.spyOn(logger, m).mockImplementation(() => {});
    }
  });
  afterEach(() => {
    resetWeakModelConsent();
    vi.restoreAllMocks();
  });

  it('ASKS once, then proceeds on approval (and remembers the session)', async () => {
    const askUser = vi.fn(async () => ({ answer: 'approve', index: 0 }));
    const cmd = makeCommand();
    const out = await cmd.answerOnce('build a tauri app', opts({ askUser }));

    expect(askUser).toHaveBeenCalledTimes(1);
    expect(out.content).toBe('worked');
    // One re-route attempt is NOT made on approval — the weak model is used.
    expect(cmd.routeMessageAuto).toHaveBeenCalledTimes(1);

    // A second turn in the SAME session does not ask again (consent latched).
    await cmd.answerOnce('build it again', opts({ askUser }));
    expect(askUser).toHaveBeenCalledTimes(1);
  });

  it('REFUSES honestly when the user chooses to wait and nothing capable exists', async () => {
    const askUser = vi.fn(async () => ({ answer: 'wait', index: 1 }));
    const cmd = makeCommand();
    const out = await cmd.answerOnce('build a tauri app', opts({ askUser }));

    expect(askUser).toHaveBeenCalledTimes(1);
    // retry-strong re-routes excluding the weak provider, still lands weak →
    expect(out.refused).toBe(true);
    expect(out.generationFailed).toBe(true);
    expect(String(out.content)).toMatch(/weak model|capable/i);
    // The work never ran on the weak model.
    expect(cmd.runChatAnswer).not.toHaveBeenCalled();
  });

  it('does NOT ask when a capable model is routed (no noise)', async () => {
    const askUser = vi.fn(async () => ({ answer: 'approve', index: 0 }));
    const cmd = makeCommand();
    cmd.routeMessageAuto = vi.fn(async () => ({
      ...weakRouted(),
      type: 'groq',
      provider: { name: 'Groq', isAvailable: vi.fn().mockResolvedValue(true) },
      model: 'llama-3.3-70b-versatile',
      agenticCapable: true,
    }));
    const out = await cmd.answerOnce('build a tauri app', opts({ askUser }));

    expect(askUser).not.toHaveBeenCalled();
    expect(out.content).toBe('worked');
  });

  it('does NOT ask for a NON-agentic ask even on a weak model', async () => {
    const askUser = vi.fn(async () => ({ answer: 'approve', index: 0 }));
    const cmd = makeCommand();
    cmd.routeMessageAuto = vi.fn(async () => ({
      ...weakRouted(),
      complexity: 'simple',
      taskProfile: { intent: 'creative', requiresVerification: false },
    }));
    const out = await cmd.answerOnce('write a poem', opts({ askUser }));

    expect(askUser).not.toHaveBeenCalled();
    expect(out.content).toBe('worked');
  });
});
