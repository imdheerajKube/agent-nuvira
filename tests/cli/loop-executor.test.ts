/**
 * Loop executor tests (`tests/cli/loop-executor.test.ts`) —
 * AGENTIC_CAPABILITY_ASSESSMENT Addendum v4 Phase 1.1: `runToolLoop` as the
 * executor behind `nuvira execute` dispatch. Driven with a scripted provider
 * stub (vi.doMock of the provider router) — no network, no TTY. Asserts the
 * telemetry contract (toolCalls, erroredTools, bounded, durationMs,
 * engineExplanation) the Phase 0 arm comparison relies on, plus failure
 * degradation (never throws).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../../src/config/manager.js';
import type { InferenceProvider, ToolCallResponse, ToolMessage, ToolSchema } from '../../src/inference/interface.js';

/** A scripted provider: queued native tool responses and/or fallback texts. */
function scriptedProvider(opts: {
  native?: boolean;
  responses?: ToolCallResponse[];
  fallbackText?: string[];
  generateError?: Error;
}): InferenceProvider {
  let nativeIdx = 0;
  let fallbackIdx = 0;
  return {
    name: 'Scripted',
    async generate(): Promise<string> {
      throw new Error('generate() should not be reached when generateStream exists');
    },
    async generateStream(_prompt: string, _options: unknown, onToken?: (t: string) => void): Promise<string> {
      if (opts.generateError) throw opts.generateError;
      const text = opts.fallbackText?.[fallbackIdx++] ?? 'no more scripted output';
      // The executor collects the streamed chunks — the token sink must fire
      // (real streaming providers push tokens through it).
      onToken?.(text);
      return text;
    },
    ...(opts.native
      ? {
          async generateTools(_messages: ToolMessage[], _tools: ToolSchema[]): Promise<ToolCallResponse> {
            return opts.responses?.[nativeIdx++] ?? { content: 'done', toolCalls: [] };
          },
        }
      : {}),
  } as InferenceProvider;
}

describe('loop executor — happy path (native transport)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('../../src/cli/router.js');
    vi.resetModules();
  });

  it('runs tools and returns the final answer with full telemetry', async () => {
    const provider = scriptedProvider({
      native: true,
      responses: [
        { content: '', toolCalls: [{ id: 'c1', name: 'list_dir', arguments: { path: '.' } }] },
        { content: 'The directory has src/ and tests/.', toolCalls: [] },
      ],
    });
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'scripted', provider }),
    }));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('list the project files', new ConfigManager(), {
      provider: 'scripted',
      skipProjectContext: true,
      quiet: true,
    });

    expect(result.generationFailed).toBe(false);
    expect(result.content).toBe('The directory has src/ and tests/.');
    expect(result.toolCalls).toEqual(['list_dir']);
    expect(result.erroredTools).toEqual([]);
    expect(result.bounded).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.provider).toBe('scripted');
    expect(typeof result.engineExplanation).toBe('string');
  });

  it('captures errored tools from tool:called events', async () => {
    const provider = scriptedProvider({
      native: true,
      responses: [
        // read_file on a nonexistent path errors → the loop feeds the error
        // back; the next step answers without tools.
        { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'definitely-missing-file.xyz' } }] },
        { content: 'The file does not exist.', toolCalls: [] },
      ],
    });
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'scripted', provider }),
    }));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('read the missing file', new ConfigManager(), {
      provider: 'scripted',
      skipProjectContext: true,
      quiet: true,
    });
    expect(result.erroredTools).toContain('read_file');
    expect(result.toolCalls).toContain('read_file');
  });
});

describe('loop executor — JSON fallback transport', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('../../src/cli/router.js');
    vi.resetModules();
  });

  it('parses the fallback JSON tool block and continues the turn', async () => {
    const provider = scriptedProvider({
      fallbackText: [
        'I will check.\n{"tool":"list_dir","arguments":{"path":"."}}',
        'Found src/ and tests/.',
      ],
    });
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'scripted', provider }),
    }));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('what is in this project?', new ConfigManager(), {
      provider: 'scripted',
      skipProjectContext: true,
      quiet: true,
    });
    expect(result.generationFailed).toBe(false);
    expect(result.content).toBe('Found src/ and tests/.');
    expect(result.toolCalls).toEqual(['list_dir']);
  });
});

describe('loop executor — failure semantics', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('../../src/cli/router.js');
    vi.resetModules();
  });

  it('a provider failure returns a shape-complete failed result (never throws)', async () => {
    const provider = scriptedProvider({ fallbackText: ['x'], generateError: new Error('provider down') });
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'scripted', provider }),
    }));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('do something', new ConfigManager(), {
      provider: 'scripted',
      skipProjectContext: true,
      quiet: true,
    });
    expect(result).toHaveProperty('generationFailed');
    expect(result).toHaveProperty('toolCalls');
    expect(result).toHaveProperty('durationMs');
    expect(result.provider).toBe('scripted');
  });
});

describe('loop executor — engine decision echo', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('../../src/cli/router.js');
    vi.resetModules();
  });

  it('engineExplanation reflects the tier decision for a local provider', async () => {
    const provider = scriptedProvider({ native: true, responses: [{ content: 'done', toolCalls: [] }] });
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'local', provider }),
    }));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('x', new ConfigManager(), {
      provider: 'local',
      skipProjectContext: true,
      quiet: true,
    });
    expect(result.engineExplanation).toContain('local');
  });
});

describe('loop executor — ambient project context', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('../../src/cli/router.js');
    vi.resetModules();
  });

  it('completes with skipProjectContext=false on a non-project cwd (best-effort builder)', async () => {
    const provider = scriptedProvider({ native: true, responses: [{ content: 'ok', toolCalls: [] }] });
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'scripted', provider }),
    }));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('hi', new ConfigManager(), {
      provider: 'scripted',
      skipProjectContext: false,
      quiet: true,
    });
    expect(result.generationFailed).toBe(false);
    expect(result.content).toBe('ok');
  });
});

describe('loop executor — loop-side skill match hint (Phase 3.2)', () => {
  let memDir = '';
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    envBackup.NUVIRA_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;
    memDir = mkdtempSync(join(tmpdir(), 'buff-exec-hint-'));
    process.env.NUVIRA_MEMORY_DIR = memDir;
  });

  afterEach(() => {
    if (envBackup.NUVIRA_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = envBackup.NUVIRA_MEMORY_DIR;
    rmSync(memDir, { recursive: true, force: true });
    vi.doUnmock('../../src/cli/router.js');
    vi.resetModules();
  });

  it('a matching goal does not break the turn and the hint stays out of the final answer', async () => {
    const provider = scriptedProvider({ native: true, responses: [{ content: 'done', toolCalls: [] }] });
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'scripted', provider }),
    }));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    // A capability-skill goal (the bundled batch is seeded into the fresh store).
    const result = await runLoopExecutor('assess the code quality of this project and give recommendations', new ConfigManager(), {
      provider: 'scripted',
      skipProjectContext: true,
      quiet: true,
    });
    expect(result.generationFailed).toBe(false);
    expect(result.content).toBe('done');
  });

  it('skipSkillHint bypasses the hint path entirely (hint-free comparison)', async () => {
    const provider = scriptedProvider({ native: true, responses: [{ content: 'ok', toolCalls: [] }] });
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'scripted', provider }),
    }));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('assess the code quality of this project and give recommendations', new ConfigManager(), {
      provider: 'scripted',
      skipProjectContext: true,
      skipSkillHint: true,
      quiet: true,
    });
    expect(result.generationFailed).toBe(false);
    expect(result.content).toBe('ok');
  });
});
