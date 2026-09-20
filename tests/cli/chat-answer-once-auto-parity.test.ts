/**
 * ChatCommand.answerOnce — configured-default parity between surfaces.
 *
 * The dashboard chat console (`ChatConsole.answer` → `answerOnce(message, {})`)
 * and the gateway chat engine call answerOnce with NO provider and NO model.
 * The CLI's interactive chat resolves its mode from the CONFIG (the shipped
 * `defaultProvider: "auto"`), so it walks every ranked candidate on failure.
 *
 * Live regression this pins (2026-09-20): because auto mode was only ever
 * enabled by an EXPLICIT 'auto' (flag or `nuvira model switch` state), the
 * dashboard silently resolved ONE concrete provider and ran with `auto: false`.
 * The non-auto path only walks `fallback.providers` (which ships empty), so a
 * single provider 400 ended the whole turn with the canned "the language model
 * was unavailable" line — while the CLI answered the identical prompt, because
 * the CLI got auto routing. Same engine, same config, two different modes.
 *
 * The active-model state is pinned to "nothing set" so this test does not
 * depend on the developer's `~/.nuvira/active-model.json`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/cli/model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/model.js')>();
  return {
    ...actual,
    // `nuvira model switch` state is absent → the caller's options are untouched.
    applyActiveModel: (options: { provider?: string; model?: string }) => options,
  };
});

import { ChatCommand } from '../../src/cli/chat.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';
import type { InferenceProvider } from '../../src/inference/interface.js';

describe('ChatCommand.answerOnce — no explicit provider/model honors defaultProvider', () => {
  let tempDir: string;
  let origMemory: string | undefined;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'buff-answer-once-parity-'));
    // Hermetic: a fresh config dir still defaults to `defaultProvider: 'auto'`.
    origMemory = process.env.NUVIRA_MEMORY_DIR;
    origConfigDir = process.env.NUVIRA_CONFIG_DIR;
    process.env.NUVIRA_MEMORY_DIR = tempDir;
    process.env.NUVIRA_CONFIG_DIR = join(tempDir, 'config');
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (origMemory === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = origMemory;
    if (origConfigDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = origConfigDir;
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function mockProvider(): InferenceProvider {
    return {
      name: 'Mock',
      generateTools: vi.fn(async () => ({ content: 'Answered.', toolCalls: [] })),
      generate: vi.fn().mockResolvedValue('Answered.'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;
  }

  type Proto = { getProvider: (o?: unknown) => Promise<{ type: string; provider: InferenceProvider }>; routeMessageAuto: (m: string) => Promise<{ type: string; provider: InferenceProvider; model?: string }> };

  it("engages auto routing when the caller passes neither provider nor model", async () => {
    const provider = mockProvider();
    const getProvider = vi
      .spyOn(ChatCommand.prototype as unknown as Proto, 'getProvider')
      .mockResolvedValue({ type: 'groq', provider });
    const routeMessageAuto = vi
      .spyOn(ChatCommand.prototype as unknown as Proto, 'routeMessageAuto')
      .mockResolvedValue({ type: 'gemini', provider, model: 'mock-model' });

    const out = await (new ChatCommand() as unknown as { answerOnce: Function }).answerOnce('hello there', {});

    // The AUTO branch resolves the initial provider with NO hint, then routes
    // per message. Both of the next two assertions are the regression pins:
    // before the fix routeMessageAuto was never called (auto mode off) and the
    // turn was reported against the CONCRETE default provider (groq).
    const initial = getProvider.mock.calls[0]?.[0] as { provider?: string; model?: string } | undefined;
    expect(initial?.provider).toBeUndefined();
    expect(initial?.model).toBeUndefined();
    expect(routeMessageAuto).toHaveBeenCalledWith('hello there');
    expect(out.content).toBe('Answered.');
    expect(out.provider).toBe('gemini');
  });

  it('still pins an explicit provider/model (no auto routing)', async () => {
    const provider = mockProvider();
    const getProvider = vi
      .spyOn(ChatCommand.prototype as unknown as Proto, 'getProvider')
      .mockResolvedValue({ type: 'groq', provider });
    const routeMessageAuto = vi.spyOn(ChatCommand.prototype as unknown as Proto, 'routeMessageAuto');

    const out = await (new ChatCommand() as unknown as { answerOnce: Function }).answerOnce('hello there', {
      provider: 'groq',
      model: 'mock-model',
    });

    expect(getProvider).toHaveBeenCalledWith(expect.objectContaining({ provider: 'groq', model: 'mock-model' }));
    expect(routeMessageAuto).not.toHaveBeenCalled();
    expect(out.content).toBe('Answered.');
    expect(out.provider).toBe('groq');
  });
});
