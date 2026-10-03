/**
 * G1 — the same-STEP hand-off.
 *
 * `callModel` is the loop's PER-STEP model call, and its candidate walk tries a
 * second provider within the SAME step when the first fails. That second
 * candidate already shares the conversation thread, but until this change it was
 * NOT told what the ask's deliverable still owed: the hand-off written on
 * failure was only injected on the NEXT context build.
 *
 * These tests pin the new behaviour: the next candidate's prompt carries the
 * just-recorded, disk-reconciled hand-off — and a successful first candidate
 * adds nothing.
 *
 * Only the TRANSPORT is stubbed (router + auto-router), mirroring
 * `tests/integration/loop-failover-429.test.ts`; the hand-off ledger is the REAL
 * one, pointed at a temp memory dir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '../../src/config/manager.js';
import type { InferenceProvider, ToolCallResponse, ToolMessage, ToolSchema } from '../../src/inference/interface.js';
import { resetQuotaLedger } from '../../src/learning/quota-ledger.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';
import { resetProviderFallback } from '../../src/learning/provider-fallback.js';
import { resetAutoRouter } from '../../src/learning/auto-router.js';
import { resetRouterBandit } from '../../src/learning/router-bandit.js';

let tempDir: string;
let originalMemoryDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-loop-handoff-'));
  originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = tempDir;
  resetQuotaLedger();
  resetModelRegistry();
  resetProviderFallback();
  resetAutoRouter();
  resetRouterBandit();
  vi.resetModules();
});

afterEach(() => {
  for (const m of [
    '../../src/cli/router.js',
    '../../src/learning/auto-router.js',
    '../../src/learning/resilient-call.js',
    '../../src/inference/model-validator.js',
  ]) {
    vi.doUnmock(m);
  }
  resetQuotaLedger();
  resetModelRegistry();
  resetProviderFallback();
  resetAutoRouter();
  resetRouterBandit();
  vi.resetModules();
  if (originalMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
  rmSync(tempDir, { recursive: true, force: true });
});

/** Install the transport mocks: auto resolves to `primary`, deep pool is [primary, secondary]. */
function mockTransport(primary: InferenceProvider, secondary: InferenceProvider): void {
  vi.doMock('../../src/learning/auto-router.js', async (orig) => ({
    ...(await orig<typeof import('../../src/learning/auto-router.js')>()),
    getAutoRouter: () => ({
      resolve: async () => ({ provider: 'primary', model: 'primary-model', fallbackChain: [] }),
      resolveModel: () => 'resolved-model',
    }),
  }));
  vi.doMock('../../src/learning/resilient-call.js', async (orig) => ({
    ...(await orig<typeof import('../../src/learning/resilient-call.js')>()),
    buildDeepFailoverPool: () => [
      { provider: 'primary', model: 'primary-model' },
      { provider: 'secondary', model: 'secondary-model' },
    ],
    createFailoverExclusionFilter: () => () => false,
  }));
  vi.doMock('../../src/inference/model-validator.js', async (orig) => ({
    ...(await orig<typeof import('../../src/inference/model-validator.js')>()),
    resolveWorkingModel: async (_p: unknown, _t: string, desired?: string) => desired ?? 'resolved',
  }));
  vi.doMock('../../src/cli/router.js', () => ({
    resolveProvider: (_cm: unknown, type: string) => ({
      type,
      provider: type === 'primary' ? primary : secondary,
    }),
  }));
}

describe('G1 — the next candidate in the SAME step receives the fresh hand-off', () => {
  it('injects the recorded hand-off into the failing step\u2019s next candidate', async () => {
    const primary: InferenceProvider = {
      name: 'Primary',
      isAvailable: async () => true,
      async generate(): Promise<string> {
        throw new Error('should not be reached');
      },
      async generateTools(): Promise<ToolCallResponse> {
        throw new Error('Primary tool-calling API error (429): quota exceeded');
      },
    } as unknown as InferenceProvider;

    const received: ToolMessage[][] = [];
    const secondary: InferenceProvider = {
      name: 'Secondary',
      isAvailable: async () => true,
      async generate(): Promise<string> {
        return 'secondary answer';
      },
      async generateTools(messages: ToolMessage[]): Promise<ToolCallResponse> {
        received.push([...messages]);
        return { content: 'secondary answer', toolCalls: [] };
      },
    } as unknown as InferenceProvider;

    mockTransport(primary, secondary);

    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('produce the release archive app.zip', new ConfigManager(), {
      skipProjectContext: true,
      skipSkillHint: true,
      quiet: true,
    });

    // The turn survived on the next candidate.
    expect(result.generationFailed).toBe(false);
    expect(result.content).toBe('secondary answer');

    // …and that candidate was TOLD what the ask still owes. The note names the
    // declared deliverable and that it is still missing.
    const handedNote = received[0].find((m) => m.role === 'user' && m.content.includes('Hand-off'));
    expect(handedNote, `expected a hand-off note, got: ${JSON.stringify(received[0])}`).toBeTruthy();
    expect(handedNote!.content).toContain('app.zip');
    expect(handedNote!.content).toContain('still missing');
  });

  it('adds no hand-off when the first candidate succeeds', async () => {
    const seen: ToolMessage[][] = [];
    const primary: InferenceProvider = {
      name: 'Primary',
      isAvailable: async () => true,
      async generate(): Promise<string> {
        return 'primary answer';
      },
      async generateTools(messages: ToolMessage[]): Promise<ToolCallResponse> {
        seen.push([...messages]);
        return { content: 'primary answer', toolCalls: [] };
      },
    } as unknown as InferenceProvider;

    mockTransport(primary, primary);

    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('produce the release archive app.zip', new ConfigManager(), {
      skipProjectContext: true,
      skipSkillHint: true,
      quiet: true,
    });

    expect(result.generationFailed).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    // A clean first attempt adds no prompt weight.
    expect(seen[0].some((m) => m.content.includes('Hand-off'))).toBe(false);
  });
});
