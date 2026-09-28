/**
 * lmTools.ts — the bridge from VS Code's language model to Agent-Nuvira agents.
 *
 * Two properties matter and are pinned here:
 *   1. On a VS Code without the `vscode.lm` tool API, registration is a no-op —
 *      the extension must not crash on the older versions its `engines` allows.
 *   2. A failing agent run must come back as readable text, never as a thrown
 *      error, because a throw inside a tool surfaces to the user as an opaque
 *      chat failure.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('vscode', () => import('./__mocks__/vscode.js'));
vi.mock('../output.js', () => ({
  log: vi.fn(),
  logError: vi.fn(),
  getOutputChannel: vi.fn(),
  disposeOutputChannel: vi.fn(),
}));

import * as vscode from 'vscode';
import {
  registerLanguageModelTools,
  resolveLmApi,
  LM_REVIEW_TOOL,
  LM_EXPLAIN_TOOL,
  LM_EXECUTE_TOOL,
  type LmToolApi,
} from '../lmTools.js';
import type { CLIResult } from '../types.js';

// ─── A fake LM API that records what was registered ─────────────────────────

class FakeTextPart {
  constructor(public text: string) {}
}
class FakeToolResult {
  constructor(public parts: unknown[]) {}
}

function fakeApi() {
  const registered = new Map<string, { invoke(o: { input: Record<string, unknown> }, t: unknown): Promise<unknown> }>();
  const api: LmToolApi = {
    registerTool: (id, tool) => {
      registered.set(id, tool);
      return { dispose: () => { registered.delete(id); } };
    },
    LanguageModelTextPart: FakeTextPart,
    LanguageModelToolResult: FakeToolResult,
  };
  return { api, registered };
}

function okResult(stdout: string): CLIResult {
  return { stdout, stderr: '', exitCode: 0, success: true, durationMs: 1 };
}

function textOf(result: unknown): string {
  const parts = (result as FakeToolResult).parts;
  return (parts[0] as FakeTextPart).text;
}

function fakeCli(overrides: Record<string, unknown> = {}) {
  return {
    reviewFile: vi.fn(async () => okResult('REVIEWED')),
    explainCode: vi.fn(async () => okResult('EXPLAINED')),
    executeGoal: vi.fn(async () => okResult('EXECUTED')),
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  (vscode.window as { activeTextEditor: unknown }).activeTextEditor = null;
});

describe('resolveLmApi', () => {
  it('returns null when the client has no lm tool API', () => {
    // The mock vscode namespace has no `lm`.
    expect(resolveLmApi()).toBeNull();
  });

  it('resolves an injected API', () => {
    const { api } = fakeApi();
    expect(resolveLmApi(api)).not.toBeNull();
  });

  it('returns null when the result classes are missing', () => {
    const { api } = fakeApi();
    expect(resolveLmApi({ ...api, LanguageModelToolResult: undefined as never })).toBeNull();
  });
});

describe('registerLanguageModelTools', () => {
  it('registers nothing (and does not throw) without an API', () => {
    expect(registerLanguageModelTools(fakeCli(), null)).toEqual([]);
  });

  it('registers all three tools', () => {
    const { api, registered } = fakeApi();
    const disposables = registerLanguageModelTools(fakeCli(), api);

    expect(disposables).toHaveLength(3);
    expect([...registered.keys()].sort()).toEqual([LM_EXPLAIN_TOOL, LM_EXECUTE_TOOL, LM_REVIEW_TOOL].sort());
  });
});

describe('review tool', () => {
  it('reviews the given path and returns the CLI output as text', async () => {
    const { api, registered } = fakeApi();
    const cli = fakeCli();
    registerLanguageModelTools(cli, api);

    const result = await registered.get(LM_REVIEW_TOOL)!.invoke({ input: { filePath: '/tmp/a.ts' } }, undefined);

    expect((cli as { reviewFile: ReturnType<typeof vi.fn> }).reviewFile).toHaveBeenCalledWith('/tmp/a.ts');
    expect(textOf(result)).toBe('REVIEWED');
  });

  it('says so when there is no file and no active editor', async () => {
    const { api, registered } = fakeApi();
    registerLanguageModelTools(fakeCli(), api);

    const result = await registered.get(LM_REVIEW_TOOL)!.invoke({ input: {} }, undefined);
    expect(textOf(result)).toMatch(/No file/);
  });

  it('returns a failure message (not a throw) when the CLI fails', async () => {
    const { api, registered } = fakeApi();
    const cli = fakeCli({
      reviewFile: vi.fn(async () => ({ stdout: '', stderr: 'boom', exitCode: 1, success: false, durationMs: 1 })),
    });
    registerLanguageModelTools(cli, api);

    const result = await registered.get(LM_REVIEW_TOOL)!.invoke({ input: { filePath: '/tmp/a.ts' } }, undefined);
    expect(textOf(result)).toMatch(/failed \(exit 1\)/);
  });
});

describe('explain tool', () => {
  it('explains the provided code', async () => {
    const { api, registered } = fakeApi();
    const cli = fakeCli();
    registerLanguageModelTools(cli, api);

    const result = await registered.get(LM_EXPLAIN_TOOL)!.invoke({ input: { code: 'const x = 1;' } }, undefined);

    expect((cli as { explainCode: ReturnType<typeof vi.fn> }).explainCode).toHaveBeenCalled();
    expect(textOf(result)).toBe('EXPLAINED');
  });

  it('says so when there is no code and no selection', async () => {
    const { api, registered } = fakeApi();
    registerLanguageModelTools(fakeCli(), api);

    const result = await registered.get(LM_EXPLAIN_TOOL)!.invoke({ input: {} }, undefined);
    expect(textOf(result)).toMatch(/No code/);
  });
});

describe('execute tool', () => {
  it('runs the goal', async () => {
    const { api, registered } = fakeApi();
    const cli = fakeCli();
    registerLanguageModelTools(cli, api);

    const result = await registered.get(LM_EXECUTE_TOOL)!.invoke({ input: { goal: 'add tests' } }, undefined);

    expect((cli as { executeGoal: ReturnType<typeof vi.fn> }).executeGoal).toHaveBeenCalledWith('add tests');
    expect(textOf(result)).toBe('EXECUTED');
  });

  it('requires a non-empty goal', async () => {
    const { api, registered } = fakeApi();
    registerLanguageModelTools(fakeCli(), api);

    const result = await registered.get(LM_EXECUTE_TOOL)!.invoke({ input: { goal: '   ' } }, undefined);
    expect(textOf(result)).toMatch(/goal/);
  });

  it('converts an unexpected throw into text', async () => {
    const { api, registered } = fakeApi();
    const cli = fakeCli({ executeGoal: vi.fn(async () => { throw new Error('kaboom'); }) });
    registerLanguageModelTools(cli, api);

    const result = await registered.get(LM_EXECUTE_TOOL)!.invoke({ input: { goal: 'x' } }, undefined);
    expect(textOf(result)).toMatch(/kaboom/);
  });
});
