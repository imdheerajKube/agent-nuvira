/**
 * Bundle 31 — the dashboard chat console records deliverable-corpus candidates.
 *
 * The console drives the SAME `ChatCommand.answerOnce` the CLI does (that is the
 * whole design of the shared engine), so the collection path Bundle 29 added is
 * not CLI-only: a turn that authors a single, on-length artifact THROUGH THE
 * DASHBOARD produces a corpus row — which is exactly the row a dashboard 👍/👎 on
 * the Trace tab can then label. This test pins the wiring from the console down to
 * the corpus, so the surface cannot silently stop collecting again.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatConsole, type ChatEngine } from '../../src/web-dashboard/chat-console.js';
import { ChatCommand } from '../../src/cli/chat.js';
import { readDeliverableCandidates } from '../../src/learning/deliverable-corpus.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';
import type { InferenceProvider } from '../../src/inference/interface.js';

describe('dashboard chat console — deliverable-corpus collection', () => {
  let tempDir: string;
  let origMemory: string | undefined;
  let origConfig: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'buff-console-corpus-'));
    origMemory = process.env.NUVIRA_MEMORY_DIR;
    origConfig = process.env.NUVIRA_CONFIG_DIR;
    process.env.NUVIRA_MEMORY_DIR = tempDir;
    process.env.NUVIRA_CONFIG_DIR = join(tempDir, 'config');
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (origMemory === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = origMemory;
    if (origConfig === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = origConfig;
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** A real ChatCommand engine (the console's default) with the turn's heavy lifting stubbed. */
  function engineWithTurn(answer: Record<string, unknown>): ChatEngine {
    const provider = {
      name: 'Mock',
      generateTools: vi.fn(),
      generate: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;
    vi.spyOn(
      ChatCommand.prototype as unknown as { getProvider: (...a: unknown[]) => unknown },
      'getProvider',
    ).mockResolvedValue({ type: 'groq', provider });
    // This test is about the wiring AFTER the turn returns — the console cannot
    // run a real tool loop here, so the engine result is supplied directly.
    vi.spyOn(
      ChatCommand.prototype as unknown as { runChatAnswer: (...a: unknown[]) => unknown },
      'runChatAnswer',
    ).mockResolvedValue({
      content: 'Wrote GUIDE.md.',
      followups: [],
      toolCalls: [],
      successfulToolCalls: [],
      provider: 'groq',
      model: 'mock-model',
      ...answer,
    });
    return new ChatCommand() as unknown as ChatEngine;
  }

  it('records a corpus candidate for a turn that authored a single deliverable', async () => {
    const engine = engineWithTurn({
      authoredDeliverable: {
        path: 'GUIDE.md',
        deliveredWords: 3200,
        targetWords: 3000,
        excerpt: '# Guide\n\nReal prose about key-value stores.',
      },
    });
    const console_ = new ChatConsole({ engine });

    const r = await console_.answer('s1', 'Write me a 3000-word guide to key-value stores, save it to GUIDE.md', {
      provider: 'groq',
      model: 'mock-model',
    });
    expect(r.ok).toBe(true);

    const rows = readDeliverableCandidates();
    expect(rows.length).toBe(1);
    expect(rows[0].path).toBe('GUIDE.md');
    expect(rows[0].deliveredWords).toBe(3200);
    // Unjudged until the user rates it — silence is not acceptance.
    expect(rows[0].verdict).toBeNull();
  });

  it('records NOTHING when the turn authored no deliverable', async () => {
    const engine = engineWithTurn({ content: 'Here is a plain answer.' });
    const console_ = new ChatConsole({ engine });

    const r = await console_.answer('s2', 'explain how the router picks a model', {
      provider: 'groq',
      model: 'mock-model',
    });
    expect(r.ok).toBe(true);
    expect(readDeliverableCandidates().length).toBe(0);
  });
});
