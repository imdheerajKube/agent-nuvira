/**
 * Integration tests for InlineSuggestProvider.callCLIForSuggestion.
 *
 * Tests the child process spawning, token cancellation, and NONE handling
 * using a controllable mock CLI process.
 *
 * Each test:
 * 1. Spies on child_process.spawn to capture the mock process
 * 2. Calls the private callCLIForSuggestion method
 * 3. Controls the mock process to emit data and close
 * 4. Asserts the returned suggestion string or null
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ─── Mock child_process with controllable process ───────────────────────────

type ProcessEventHandler = (...args: unknown[]) => void;

function createControllableMockProcess() {
  const stdoutListeners: ProcessEventHandler[] = [];
  const stderrListeners: ProcessEventHandler[] = [];
  const closeListeners: ProcessEventHandler[] = [];
  const errorListeners: ProcessEventHandler[] = [];

  const mockProcess = {
    stdout: {
      on: vi.fn((event: string, handler: ProcessEventHandler) => {
        if (event === 'data') stdoutListeners.push(handler);
      }),
    },
    stderr: {
      on: vi.fn((event: string, handler: ProcessEventHandler) => {
        if (event === 'data') stderrListeners.push(handler);
      }),
    },
    on: vi.fn((event: string, handler: ProcessEventHandler) => {
      if (event === 'close') closeListeners.push(handler);
      if (event === 'error') errorListeners.push(handler);
    }),
    kill: vi.fn(),
    killed: false,
    exitCode: null as number | null,
    pid: 99999,
  };

  const emitStdout = (data: string) => {
    for (const handler of stdoutListeners) handler(Buffer.from(data, 'utf-8'));
  };

  const emitStderr = (data: string) => {
    for (const handler of stderrListeners) handler(Buffer.from(data, 'utf-8'));
  };

  const emitClose = (exitCode: number) => {
    mockProcess.exitCode = exitCode;
    for (const handler of closeListeners) handler(exitCode);
  };

  const emitError = (err: NodeJS.ErrnoException) => {
    for (const handler of errorListeners) handler(err);
  };

  return { mockProcess, emitStdout, emitStderr, emitClose, emitError };
}

// ─── Setup mocks ────────────────────────────────────────────────────────────

vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn(),
    ChildProcess: function () { /* noop */ },
  };
});

vi.mock('vscode', () => {
  return import('./__mocks__/vscode.js');
});

import { spawn } from 'node:child_process';
import { InlineSuggestProvider } from '../inlineSuggest.js';
import type { ExtensionConfig } from '../types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a simple cancellable token for testing */
function createTestToken(): { token: { isCancellationRequested: boolean; onCancellationRequested: (fn: () => void) => { dispose: () => void } }; cancel: () => void } {
  const listeners: Array<() => void> = [];
  let cancelled = false;

  return {
    token: {
      get isCancellationRequested() { return cancelled; },
      onCancellationRequested: (fn: () => void) => {
        listeners.push(fn);
        return { dispose: () => { /* noop */ } };
      },
    },
    cancel: () => {
      cancelled = true;
      for (const fn of listeners) fn();
    },
  };
}

/** Default suggestion prompt (matches what buildSuggestionPrompt would produce) */
const SAMPLE_PROMPT = [
  'You are a code completion engine for typescript (.ts).',
  'Complete the code at the cursor position (marked by <CURSOR>).',
  'Return ONLY the completion text — no explanations, no markdown, no code fences.',
  'Your completion should be concise and idiomatic.',
  'If nothing useful to add, return "NONE".',
  '',
  '--- Code context ---',
  'const x = 1;',
  '<CURSOR>',
  '',
  '---',
  '',
  'Complete:',
].join('\n');

const defaultConfig: ExtensionConfig = {
  cliPath: 'buff',
  defaultProvider: '',
  defaultModel: '',
  autoApplyChanges: false,
  maxTokens: 4096,
  showProgressPanel: true,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('InlineSuggestProvider — callCLIForSuggestion', () => {
  let provider: InlineSuggestProvider;
  let mockControl: ReturnType<typeof createControllableMockProcess>;
  let token: ReturnType<typeof createTestToken>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockControl = createControllableMockProcess();
    vi.mocked(spawn).mockReturnValue(mockControl.mockProcess as any);
    provider = new InlineSuggestProvider({ ...defaultConfig });
    token = createTestToken();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Access private callCLIForSuggestion method */
  function callCLIForSuggestion(prompt: string): Promise<string | null> {
    return (provider as any).callCLIForSuggestion.call(provider, prompt, token.token);
  }

  // ─── Basic spawning ─────────────────────────────────────────────────────

  describe('spawning', () => {
    it('spawns the CLI with chat command, prompt, and --stream flag', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      mockControl.emitClose(0);
      await promise;

      expect(spawn).toHaveBeenCalledWith('buff', ['chat', SAMPLE_PROMPT, '--stream'], expect.any(Object));
    });

    it('passes FORCE_COLOR=0 in the environment', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      mockControl.emitClose(0);
      await promise;

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({ FORCE_COLOR: '0' }),
        }),
      );
    });

    it('sets a 10-second timeout on the child process', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      mockControl.emitClose(0);
      await promise;

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ timeout: 10_000 }),
      );
    });
  });

  // ─── CLI path handling ──────────────────────────────────────────────────

  describe('CLI path handling', () => {
    it('uses default "buff" when cliPath is not in config', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      mockControl.emitClose(0);
      await promise;

      const call = vi.mocked(spawn).mock.calls[0];
      expect(call[0]).toBe('buff');
    });

    it('uses cliPath as the command when configured', async () => {
      const customProvider = new InlineSuggestProvider({
        ...defaultConfig,
        cliPath: '/usr/local/bin/buff',
      });
      const promise = (customProvider as any).callCLIForSuggestion.call(customProvider, SAMPLE_PROMPT, token.token);
      mockControl.emitClose(0);
      await promise;

      const call = vi.mocked(spawn).mock.calls[0];
      expect(call[0]).toBe('/usr/local/bin/buff');
    });

    it('handles "npx " prefix by splitting into npx + package', async () => {
      const npxProvider = new InlineSuggestProvider({
        ...defaultConfig,
        cliPath: 'npx agent-nuvira',
      });
      const npxMock = createControllableMockProcess();
      vi.mocked(spawn).mockReturnValue(npxMock.mockProcess as any);

      const promise = (npxProvider as any).callCLIForSuggestion.call(npxProvider, 'test prompt', token.token);
      npxMock.emitClose(0);
      await promise;

      const call = vi.mocked(spawn).mock.calls[0];
      expect(call[0]).toBe('npx');
      expect(call[1][0]).toBe('agent-nuvira');
      expect(call[1][1]).toBe('chat');
      expect(call[1][2]).toBe('test prompt');
    });
  });

  // ─── Provider/model args ────────────────────────────────────────────────

  describe('provider and model args', () => {
    it('adds --provider and --model flags when configured', async () => {
      const configuredProvider = new InlineSuggestProvider({
        ...defaultConfig,
        defaultProvider: 'groq',
        defaultModel: 'llama-3.3-70b',
      });
      const cfgMock = createControllableMockProcess();
      vi.mocked(spawn).mockReturnValue(cfgMock.mockProcess as any);

      const promise = (configuredProvider as any).callCLIForSuggestion.call(configuredProvider, 'prompt', token.token);
      cfgMock.emitClose(0);
      await promise;

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      const providerIdx = args.indexOf('--provider');
      const modelIdx = args.indexOf('--model');
      expect(providerIdx).toBeGreaterThanOrEqual(0);
      expect(args[providerIdx + 1]).toBe('groq');
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(args[modelIdx + 1]).toBe('llama-3.3-70b');
    });

    it('only adds --provider when --model is not configured', async () => {
      const providerOnly = new InlineSuggestProvider({
        ...defaultConfig,
        defaultProvider: 'gemini',
      });
      const pMock = createControllableMockProcess();
      vi.mocked(spawn).mockReturnValue(pMock.mockProcess as any);

      const promise = (providerOnly as any).callCLIForSuggestion.call(providerOnly, 'prompt', token.token);
      pMock.emitClose(0);
      await promise;

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      expect(args).toContain('--provider');
      expect(args).not.toContain('--model');
    });

    it('does not add provider/model flags when not configured', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      mockControl.emitClose(0);
      await promise;

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      expect(args).not.toContain('--provider');
      expect(args).not.toContain('--model');
    });
  });

  // ─── Stdout collection ──────────────────────────────────────────────────

  describe('stdout collection', () => {
    it('returns the trimmed stdout output on process close', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      mockControl.emitStdout('const result = 42;');
      mockControl.emitClose(0);

      const result = await promise;
      expect(result).toBe('const result = 42;');
    });

    it('collects multi-line stdout output', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      mockControl.emitStdout('function add(a: number, b: number): number {\n  return a + b;\n}');
      mockControl.emitClose(0);

      const result = await promise;
      expect(result).toContain('function add');
      expect(result).toContain('return a + b;');
    });

    it('collects stdout emitted in multiple chunks', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      mockControl.emitStdout('const x = ');
      mockControl.emitStdout('42;');
      mockControl.emitStdout('\nconsole.log(x);');
      mockControl.emitClose(0);

      const result = await promise;
      expect(result).toBe('const x = 42;\nconsole.log(x);');
    });

    it('trims trailing whitespace from output', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      mockControl.emitStdout('  return value;\n\n  ');
      mockControl.emitClose(0);

      const result = await promise;
      expect(result).toBe('return value;');
    });
  });

  // ─── NONE handling ──────────────────────────────────────────────────────

  describe('NONE handling', () => {
    it('returns null when output is exactly "NONE"', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      mockControl.emitStdout('NONE');
      mockControl.emitClose(0);

      const result = await promise;
      expect(result).toBeNull();
    });

    it('returns null when output is "NONE" with surrounding whitespace', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      mockControl.emitStdout('  NONE  ');
      mockControl.emitClose(0);

      const result = await promise;
      expect(result).toBeNull();
    });

    it('returns the suggestion when output starts with "NONE" but has more content', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      mockControl.emitStdout('NONE of the above, do this instead');
      mockControl.emitClose(0);

      const result = await promise;
      expect(result).toBe('NONE of the above, do this instead');
    });
  });

  // ─── Empty/no output ────────────────────────────────────────────────────

  describe('empty output', () => {
    it('returns null when there is no stdout output', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      mockControl.emitClose(0);

      const result = await promise;
      expect(result).toBeNull();
    });

    it('returns null when stdout is only whitespace', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      mockControl.emitStdout('   \n  \n  ');
      mockControl.emitClose(0);

      const result = await promise;
      expect(result).toBeNull();
    });
  });

  // ─── Exit code handling ─────────────────────────────────────────────────

  describe('exit code handling', () => {
    it('returns output even on non-zero exit code when output exists', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      mockControl.emitStdout('const x = 1;');
      mockControl.emitClose(1);

      const result = await promise;
      expect(result).toBe('const x = 1;');
    });

    it('returns null on non-zero exit code with no output', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      mockControl.emitClose(1);

      const result = await promise;
      expect(result).toBeNull();
    });
  });

  // ─── Error handling ─────────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns null on spawn error', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      const err = new Error('spawn ENOENT');
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      mockControl.emitError(err);

      const result = await promise;
      expect(result).toBeNull();
    });

    it('returns null when both error and close fire', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      const err = new Error('connection refused');
      mockControl.emitError(err);
      mockControl.emitClose(1);

      const result = await promise;
      expect(result).toBeNull();
    });
  });

  // ─── Token cancellation ─────────────────────────────────────────────────

  describe('token cancellation', () => {
    it('kills the child process when cancellation is requested', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);

      // Cancel before the process closes
      token.cancel();

      expect(mockControl.mockProcess.kill).toHaveBeenCalledWith('SIGTERM');

      // Process close still resolves the promise
      mockControl.emitClose(0);
      const result = await promise;
      expect(result).toBeNull();
    });

    it('returns null when token is already cancelled before close', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);

      // Emit some data, then cancel, then close
      mockControl.emitStdout('partial output');
      token.cancel();

      expect(mockControl.mockProcess.kill).toHaveBeenCalled();

      mockControl.emitClose(0);
      const result = await promise;

      // Should return null because cancellation was requested
      expect(result).toBeNull();
    });

    it('handles cancellation after close (no double-resolve)', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      mockControl.emitStdout('completed output');
      mockControl.emitClose(0);

      // Cancel after the process has already closed
      token.cancel();

      const result = await promise;
      // Should still return the output since close resolved first
      expect(result).toBe('completed output');
    });

    it('registers cancellation listener on the token', async () => {
      // Verify that onCancellationRequested is called by setting up a listener
      let cancellationHandlerCalled = false;
      const customToken = {
        token: {
          isCancellationRequested: false,
          onCancellationRequested: vi.fn((fn: () => void) => {
            cancellationHandlerCalled = true;
            fn(); // immediately invoke the handler
            return { dispose: () => {} };
          }),
        },
        cancel: () => {},
      };

      const promise = (provider as any).callCLIForSuggestion.call(provider, 'prompt', customToken.token);
      mockControl.emitClose(0);
      await promise;

      expect(cancellationHandlerCalled).toBe(true);
      expect(mockControl.mockProcess.kill).toHaveBeenCalled();
    });
  });

  // ─── stderr handling ────────────────────────────────────────────────────

  describe('stderr handling', () => {
    it('ignores stderr output and still returns stdout', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      mockControl.emitStderr('Warning: deprecated API');
      mockControl.emitStdout('const x = 1;');
      mockControl.emitClose(0);

      const result = await promise;
      expect(result).toBe('const x = 1;');
    });

    it('returns null when only stderr output exists', async () => {
      const promise = callCLIForSuggestion(SAMPLE_PROMPT);
      mockControl.emitStderr('Error: something went wrong');
      mockControl.emitClose(1);

      const result = await promise;
      expect(result).toBeNull();
    });
  });

  // ─── Config change impact ───────────────────────────────────────────────

  describe('config change impact', () => {
    it('uses updated cliPath after updateConfig call', async () => {
      provider.updateConfig({ ...defaultConfig, cliPath: '/new/path/buff' });
      const customMock = createControllableMockProcess();
      vi.mocked(spawn).mockReturnValue(customMock.mockProcess as any);

      const promise = (provider as any).callCLIForSuggestion.call(provider, 'prompt', token.token);
      customMock.emitClose(0);
      await promise;

      const call = vi.mocked(spawn).mock.calls[0];
      expect(call[0]).toBe('/new/path/buff');
    });

    it('uses updated provider/model after updateConfig call', async () => {
      provider.updateConfig({ ...defaultConfig, defaultProvider: 'openrouter', defaultModel: 'mixtral' });
      const customMock = createControllableMockProcess();
      vi.mocked(spawn).mockReturnValue(customMock.mockProcess as any);

      const promise = (provider as any).callCLIForSuggestion.call(provider, 'prompt', token.token);
      customMock.emitClose(0);
      await promise;

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      const providerIdx = args.indexOf('--provider');
      const modelIdx = args.indexOf('--model');
      expect(args[providerIdx + 1]).toBe('openrouter');
      expect(args[modelIdx + 1]).toBe('mixtral');
    });
  });
});
