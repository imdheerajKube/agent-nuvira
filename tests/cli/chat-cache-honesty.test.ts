/**
 * #30 — the response cache must never replay a flagged answer as clean.
 *
 * The cache stores TEXT only. Before this fix a turn that ended with an honesty
 * flag was written to the shared cache as plain text, so a later identical prompt
 * — on the CLI, the dashboard or the gateway — was served the reply with every
 * flag absent: a claimed-but-unperformed action replayed as a settled answer, on
 * every surface at once. A flagged turn is now NOT cached and re-derives.
 *
 * The other half of #30 is that a legitimate cache hit must report the ACTIVITY
 * the cached turn recorded (`toolCalls`), not just the text — a replay that
 * dropped it rendered no tool cards on the dashboard while the first run did.
 *
 * Driven through `runChatAnswer` with MOCK providers and `cacheEnabled: true`,
 * so the assertions are about the real engine's cache decision, not a re-derivation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatCommand, turnCarriesHonestyFlag } from '../../src/cli/chat.js';
import type { InferenceProvider } from '../../src/inference/interface.js';
import type { StepResponse } from '../../src/tools/tool-loop.js';

/** A provider whose native transport cycles a fixed script of step responses. */
function scriptedProvider(script: StepResponse[], counter?: { n: number }): InferenceProvider {
  let i = 0;
  return {
    name: 'Mock',
    generateTools: vi.fn(async () => {
      if (counter) counter.n += 1;
      return script[Math.min(i++, script.length - 1)];
    }),
    generate: vi.fn().mockResolvedValue('unused'),
    isAvailable: vi.fn().mockResolvedValue(true),
    getInfo: () => 'Mock',
    listModels: vi.fn().mockResolvedValue([]),
  } as unknown as InferenceProvider;
}

type RunResult = { content: string; toolCalls?: string[]; unverifiedActionClaim?: boolean };

describe('#30 — the response cache and the honesty flags', () => {
  let tempDir: string;
  let origMemory: string | undefined;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'nuvira-cache-honesty-'));
    // Hermetic on BOTH env vars: NUVIRA_MEMORY_DIR (cache + checkpoints) and
    // NUVIRA_CONFIG_DIR (the debug-log dir) — the engine must never write into the
    // real ~/.nuvira while a test drives it.
    origMemory = process.env.NUVIRA_MEMORY_DIR;
    origConfigDir = process.env.NUVIRA_CONFIG_DIR;
    process.env.NUVIRA_MEMORY_DIR = tempDir;
    process.env.NUVIRA_CONFIG_DIR = join(tempDir, 'config');
  });

  afterEach(() => {
    if (origMemory === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = origMemory;
    if (origConfigDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = origConfigDir;
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const cacheFile = () => join(tempDir, 'cache.json');
  const cachedEntryCount = (): number => {
    if (!existsSync(cacheFile())) return 0;
    const data = JSON.parse(readFileSync(cacheFile(), 'utf8')) as { entries?: Record<string, unknown> };
    return Object.keys(data.entries ?? {}).length;
  };

  it('does NOT cache a turn that carries an honesty flag — the repeat re-derives it, never replays it clean', async () => {
    // A claimed-but-unperformed delivery: the model says it sent the poem, and no
    // `gateway_send` ran. The loop flags it; the cache must not store it.
    const ask = 'send the poem to Alex';
    const provider = scriptedProvider([{ content: 'I have sent the poem to Alex via WhatsApp.', toolCalls: [] }]);

    const cmd = new ChatCommand() as unknown as { runChatAnswer: Function };
    const first = (await cmd.runChatAnswer(
      ask,
      [],
      { type: 'groq', provider, model: 'mock-model' },
      {},
      true,
      { auto: false },
    )) as RunResult;

    expect(first.unverifiedActionClaim).toBe(true);
    // The truthfulness hole: a flagged answer was written to the shared cache.
    expect(cachedEntryCount()).toBe(0);

    // A repeat of the IDENTICAL prompt re-derives the flag (it was never served
    // from a cache entry with the flag stripped).
    const secondProvider = scriptedProvider([{ content: 'I have sent the poem to Alex via WhatsApp.', toolCalls: [] }]);
    const second = (await cmd.runChatAnswer(
      ask,
      [],
      { type: 'groq', provider: secondProvider, model: 'mock-model' },
      {},
      true,
      { auto: false },
    )) as RunResult;
    expect(second.unverifiedActionClaim).toBe(true);
    expect(cachedEntryCount()).toBe(0);
  });

  it('caches an unflagged turn and a HIT reports the recorded tool calls, not just the text', async () => {
    const ask = 'list the files in this project';
    const firstProvider = scriptedProvider([
      { content: '', toolCalls: [{ id: 'c1', name: 'list_dir', arguments: { path: '.' } }] },
      { content: 'Directory listed.', toolCalls: [] },
    ]);

    const cmd = new ChatCommand() as unknown as { runChatAnswer: Function };
    const first = (await cmd.runChatAnswer(
      ask,
      [],
      { type: 'groq', provider: firstProvider, model: 'mock-model' },
      {},
      true,
      { auto: false },
    )) as RunResult;

    expect(first.content).toBe('Directory listed.');
    expect(first.toolCalls).toContain('list_dir');
    // The UNFLAGGED turn is cached (this is the normal path).
    expect(cachedEntryCount()).toBe(1);

    // The second, identical turn must be served from the cache: the provider is
    // never called, and the recorded activity rides with the answer.
    const counter = { n: 0 };
    const secondProvider = scriptedProvider([{ content: 'should never be reached', toolCalls: [] }], counter);
    const second = (await cmd.runChatAnswer(
      ask,
      [],
      { type: 'groq', provider: secondProvider, model: 'mock-model' },
      {},
      true,
      { auto: false },
    )) as RunResult;

    expect(counter.n).toBe(0); // cache hit — no model call
    expect(second.content).toBe('Directory listed.');
    // The dropped-activity defect: a replay rendered no tool cards.
    expect(second.toolCalls).toContain('list_dir');
  });
});

describe('#30 — turnCarriesHonestyFlag classifies every honesty flag', () => {
  it('is true for each flag on its own', () => {
    expect(turnCarriesHonestyFlag({ unverifiedActionClaim: true })).toBe(true);
    expect(turnCarriesHonestyFlag({ unfulfilledPromise: true })).toBe(true);
    expect(turnCarriesHonestyFlag({ undeliveredArtifact: true })).toBe(true);
    expect(turnCarriesHonestyFlag({ unverifiedBuildClaim: true })).toBe(true);
    expect(turnCarriesHonestyFlag({ unverifiedEdit: true })).toBe(true);
    expect(turnCarriesHonestyFlag({ unverifiedEditClaim: true })).toBe(true);
    expect(turnCarriesHonestyFlag({ noActionTaken: true })).toBe(true);
    // Bundle 19 — a file the turn wrote admits its own content was omitted. The
    // guard's name claims it classifies EVERY flag, so a new flag omitted here is
    // a silently unprotected one: it would still pass while the flag went
    // unclassified in `turnCarriesHonestyFlag`.
    expect(turnCarriesHonestyFlag({ artifactIncomplete: { path: 'DESIGN.md', statement: 'content omitted' } })).toBe(true);
    // Bundle 20 — a reply that claims a file no write backs.
    expect(turnCarriesHonestyFlag({ unverifiedFileClaim: true })).toBe(true);
    // Bundle 23 — an artifact far short of a magnitude the ask named.
    expect(
      turnCarriesHonestyFlag({
        artifactShortfall: { path: 'GUIDE.md', deliveredWords: 500, targetWords: 5000, source: '"5000 words"' },
      }),
    ).toBe(true);
  });

  it('is false for a clean turn', () => {
    expect(turnCarriesHonestyFlag({})).toBe(false);
    expect(
      turnCarriesHonestyFlag({
        unverifiedActionClaim: false,
        unfulfilledPromise: false,
        undeliveredArtifact: false,
      }),
    ).toBe(false);
  });
});
