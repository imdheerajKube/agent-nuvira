/**
 * Live answer streaming (P7) — the chat REPL's live preview.
 *
 * The contract that must hold:
 *  1. Off a real terminal (pipes, CI, `--json-events`) the helper is INERT:
 *     no Ink view and no `onToken`, so the provider is called exactly as before.
 *  2. On a terminal it supplies `onToken`/`onToolCall`, and the REPL actually
 *     hands them to the turn.
 *  3. A `tool:started` event clears the preview, because `onToken` fires for
 *     every model call in the loop — not only for the answer.
 *  4. The preview is never archived: the turn's own answer path prints the
 *     authoritative frame, so `stop()` must not print a second copy.
 */

import { Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import inquirer from 'inquirer';

import { ChatCommand } from '../../src/cli/chat.js';
import { AnswerStream } from '../../src/cli/ui/index.js';
import { EventNames, getEventBus } from '../../src/observability/event-bus.js';
import { logger } from '../../src/utils/logger.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';
import { resetWorkspaceStore } from '../../src/config/workspace.js';
import type { InferenceProvider } from '../../src/inference/interface.js';

/** A fake terminal stream that records everything written to it. */
function makeTtyStream(chunks: string[]): NodeJS.WriteStream {
  const stream = new Writable({
    write(chunk: unknown, _encoding: BufferEncoding, cb: () => void) {
      chunks.push(String(chunk));
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
  (stream as unknown as { columns: number }).columns = 80;
  return stream;
}

const ORIGINAL_STDOUT_TTY = (process.stdout as { isTTY?: boolean }).isTTY;
const ORIGINAL_STDIN_TTY = (process.stdin as { isTTY?: boolean }).isTTY;

function setStdTty(on: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { value: on, configurable: true });
  Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
}

function restoreStd(): void {
  Object.defineProperty(process.stdout, 'isTTY', { value: ORIGINAL_STDOUT_TTY, configurable: true });
  Object.defineProperty(process.stdin, 'isTTY', { value: ORIGINAL_STDIN_TTY, configurable: true });
}

type LiveAnswerFn = (header?: string, opts?: unknown) => {
  overrides: {
    onToken?: (t: string) => void;
    onToolCall?: (p: string, i: unknown) => void;
    onGitDiff?: (payload: { summary: string; files: Array<{ path: string; body: string }> }) => void;
  };
  stop: () => void;
  stream: AnswerStream | null;
};

describe('ChatCommand.liveAnswer', () => {
  let cmd: ChatCommand;

  beforeEach(() => {
    cmd = new ChatCommand();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreStd();
  });

  it('is inert off a real terminal (no Ink, no onToken)', () => {
    setStdTty(false);
    const live = (cmd as unknown as { liveAnswer: LiveAnswerFn }).liveAnswer('nuvira');
    expect(live.stream).toBeNull();
    expect(live.overrides).toEqual({});
    // stop() must be safe to call unconditionally.
    expect(() => live.stop()).not.toThrow();
  });

  it('supplies onToken/onToolCall on a terminal', () => {
    const chunks: string[] = [];
    const live = (cmd as unknown as { liveAnswer: LiveAnswerFn }).liveAnswer('nuvira · test/model', {
      stream: makeTtyStream(chunks),
      tty: true,
    });
    expect(live.stream).not.toBeNull();
    expect(typeof live.overrides.onToken).toBe('function');
    expect(typeof live.overrides.onToolCall).toBe('function');
    live.stop();
  });

  it('accumulates streamed tokens and clears them when a tool step starts', () => {
    const chunks: string[] = [];
    const live = (cmd as unknown as { liveAnswer: LiveAnswerFn }).liveAnswer('nuvira', {
      stream: makeTtyStream(chunks),
      tty: true,
    });
    const stream = live.stream!;

    live.overrides.onToken?.('let me look ');
    live.overrides.onToken?.('at the file');
    expect(stream.current).toBe('let me look at the file');

    // A tool call starting is the boundary between loop steps: the preamble
    // above is not the answer, so the preview is cleared for the next step.
    live.overrides.onToolCall?.('started', { tool: 'read_file' });
    expect(stream.current).toBe('');

    live.overrides.onToken?.('Here is the answer.');
    expect(stream.current).toBe('Here is the answer.');

    live.stop();
  });

  it('renders a card for a completed tool call and for a git diff', () => {
    const chunks: string[] = [];
    const live = (cmd as unknown as { liveAnswer: LiveAnswerFn }).liveAnswer('nuvira', {
      stream: makeTtyStream(chunks),
      tty: true,
    });

    live.overrides.onToolCall?.('called', { tool: 'read_file', ok: true, result: 'ok', durationMs: 7 });
    const afterTool = chunks.join('');
    expect(afterTool).toContain('╭');
    expect(afterTool).toContain('read_file');

    live.overrides.onGitDiff?.({ summary: '1 file changed', files: [{ path: 'src/a.ts', body: '+added' }] });
    const afterDiff = chunks.join('');
    expect(afterDiff).toContain('git diff · 1 file changed');
    expect(afterDiff).toContain('src/a.ts');

    live.stop();
  });

  it('renders a card when a shell command finishes, and stops after the turn', () => {
    const chunks: string[] = [];
    const live = (cmd as unknown as { liveAnswer: LiveAnswerFn }).liveAnswer('nuvira', {
      stream: makeTtyStream(chunks),
      tty: true,
    });

    getEventBus().emit(EventNames.EXEC_SHELL_END, { command: 'npm run build', exitCode: 0, success: true, durationMs: 3210 }, 'shell');
    const afterShell = chunks.join('');
    expect(afterShell).toContain('shell · exit 0');
    expect(afterShell).toContain('npm run build');

    // `stop()` detaches the subscription — a shell command from a later turn
    // must not be drawn into this turn's transcript.
    live.stop();
    const settled = chunks.join('').length;
    getEventBus().emit(EventNames.EXEC_SHELL_END, { command: 'late', exitCode: 0, success: true }, 'shell');
    expect(chunks.join('').length).toBe(settled);
  });
});

describe('AnswerStream.finish({ archive: false })', () => {
  it('unmounts without printing a frame (no duplicate answer)', () => {
    const chunks: string[] = [];
    const stream = new AnswerStream({}, { stream: makeTtyStream(chunks), tty: true, color: false });
    stream.append('# Preview text');
    const out = stream.finish({ archive: false });
    expect(out).toBe('');
    expect(chunks.join('')).toBe('');
  });

  it('still archives the final frame by default', () => {
    const chunks: string[] = [];
    const stream = new AnswerStream({}, { stream: makeTtyStream(chunks), tty: true, color: false });
    stream.append('## Archived');
    const out = stream.finish();
    expect(out).toContain('Archived');
    expect(chunks.join('')).toContain('Archived');
  });
});

describe('chat REPL wires streaming into the turn', () => {
  let tempDir: string;
  let originalMemoryDir: string | undefined;
  let originalConfigDir: string | undefined;
  let cmd: ChatCommand;

  const mockProvider = {
    name: 'Mock',
    isAvailable: vi.fn().mockResolvedValue(true),
    generate: vi.fn().mockResolvedValue('unused'),
    getInfo: () => 'Mock',
    listModels: vi.fn().mockResolvedValue([]),
  } as unknown as InferenceProvider;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'highlight').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'buff-live-stream-'));
    originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
    originalConfigDir = process.env.NUVIRA_CONFIG_DIR;
    process.env.NUVIRA_MEMORY_DIR = tempDir;
    process.env.NUVIRA_CONFIG_DIR = join(tempDir, 'config');
    resetModelRegistry();
    cmd = new ChatCommand();
    vi.spyOn(cmd as unknown as { getProvider: Function }, 'getProvider').mockResolvedValue({
      type: 'mock',
      provider: mockProvider,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreStd();
    resetModelRegistry();
    if (originalMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
    if (originalConfigDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = originalConfigDir;
    // Close the SQLite handle BEFORE deleting the config dir. The CLI opens
    // `<config>/workspaces.db` in this process, and Windows cannot unlink an open
    // file (POSIX can), so the removal failed with EBUSY there — and with the
    // error thrown from `afterEach`, an otherwise-passing test was reported as a
    // failure on the Windows runner.
    resetWorkspaceStore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('hands onToken and onToolCall to the turn on a terminal', async () => {
    setStdTty(true);
    const runChatAnswer = vi
      .spyOn(cmd as unknown as { runChatAnswer: Function }, 'runChatAnswer')
      .mockResolvedValue({ content: 'streamed answer', followups: [], toolCalls: [] });
    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ n: '' } as never);
    vi.spyOn(cmd as unknown as { readMultiLineInput: Function }, 'readMultiLineInput').mockResolvedValue('/exit');
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await (cmd as unknown as { execute: Function }).execute('hi', { provider: 'mock', model: 'mock-model', cache: false });

    const overrides = runChatAnswer.mock.calls[0]?.[7] as { onToken?: unknown; onToolCall?: unknown };
    expect(typeof overrides.onToken).toBe('function');
    expect(typeof overrides.onToolCall).toBe('function');
  });

  it('delivers the provider\u2019s real streamed tokens to onToken end-to-end', async () => {
    // The full chain: provider stream \u2192 tool loop \u2192 ctxOverrides.onToken.
    // `generateToolsStream` is the streaming twin the loop prefers when a sink
    // is present (chat.ts line ~4477), so this proves the CLI now actually
    // consumes provider tokens rather than a callback that is never called.
    const provider = {
      name: 'Mock',
      // The native path requires generateTools to exist; generateToolsStream is
      // the streaming twin the loop PREFERS whenever a token sink is wired.
      generateTools: vi.fn(async () => ({ content: 'Hello!', toolCalls: [] })),
      generateToolsStream: vi.fn(
        async (_messages: unknown, _tools: unknown, _options: unknown, onToken: (t: string) => void) => {
          onToken('Hel');
          onToken('lo!');
          return { content: 'Hello!', toolCalls: [] };
        },
      ),
      generate: vi.fn().mockResolvedValue('unused'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;

    const seen: string[] = [];
    const cmd2 = new ChatCommand() as unknown as { runChatAnswer: Function };
    const out = await cmd2.runChatAnswer(
      'hi',
      [],
      { type: 'groq', provider, model: 'mock-model' },
      {},
      false,
      { auto: false },
      undefined,
      { onToken: (t: string) => seen.push(t) },
    );

    expect(out.content).toBe('Hello!');
    expect(seen.join('')).toBe('Hello!');
    expect(provider.generateToolsStream).toHaveBeenCalledTimes(1);
  });

  it('does not hand onToken to the turn off a terminal', async () => {
    setStdTty(false);
    const runChatAnswer = vi
      .spyOn(cmd as unknown as { runChatAnswer: Function }, 'runChatAnswer')
      .mockResolvedValue({ content: 'plain answer', followups: [], toolCalls: [] });
    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ n: '' } as never);
    vi.spyOn(cmd as unknown as { readMultiLineInput: Function }, 'readMultiLineInput').mockResolvedValue('/exit');
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await (cmd as unknown as { execute: Function }).execute('hi', { provider: 'mock', model: 'mock-model', cache: false });

    const overrides = runChatAnswer.mock.calls[0]?.[7] as { onToken?: unknown; onToolCall?: unknown };
    // Unchanged from before this feature: a piped/CI run streams nothing.
    expect(overrides.onToken).toBeUndefined();
    expect(overrides.onToolCall).toBeUndefined();
  });
});
