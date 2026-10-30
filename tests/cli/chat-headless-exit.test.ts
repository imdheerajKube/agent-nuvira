/**
 * R2 — a headless one-shot must EXIT, not park on an MCP child.
 *
 * Measured 2026-10-17 (Cline head-to-head, task 2): `nuvira chat "<task>"` printed
 * its answer after 126 s and the process was still alive — `%CPU 0.0`, with the
 * `quote` stdio MCP server still running — eight minutes later, until killed by
 * hand. The turn itself was complete and graded 100/100. The same command exited
 * cleanly in the other run because stdin was `/dev/null` (run.mjs) instead of an
 * open pipe that never EOFs: whether stdin EOFs determined whether the process
 * ever died.
 *
 * Root cause: the one-shot branch returned from `execute()` and relied on the
 * event loop emptying. A stdio MCP server is a real child process; its pipes keep
 * the loop referenced, so the process has nothing to do and never exits.
 *
 * Contract pinned here:
 *  1. headless + `exitOnComplete` (the CLI armed it because stdin is not a TTY)
 *     → the turn finishes and the process exits 0.
 *  2. headless WITHOUT the flag (tests, the dashboard, parity drivers call
 *     `execute()` directly) → it returns as before; exiting would kill the host.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ChatCommand } from '../../src/cli/chat.js';
import { logger } from '../../src/utils/logger.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';
import { resetWorkspaceStore } from '../../src/config/workspace.js';
import type { InferenceProvider } from '../../src/inference/interface.js';

const ORIGINAL_STDIN_TTY = (process.stdin as { isTTY?: boolean }).isTTY;

function setStdinTty(on: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
}

function restoreStdin(): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: ORIGINAL_STDIN_TTY, configurable: true });
}

describe('headless chat exits after its one-shot answer (R2)', () => {
  let tempDir: string;
  let originalMemoryDir: string | undefined;
  let originalConfigDir: string | undefined;
  let cmd: ChatCommand;
  let exit: ReturnType<typeof vi.spyOn>;

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
    tempDir = mkdtempSync(join(tmpdir(), 'buff-headless-exit-'));
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
    vi.spyOn(cmd as unknown as { runChatAnswer: Function }, 'runChatAnswer').mockResolvedValue({
      content: 'done',
      followups: [],
      toolCalls: [],
    });
    setStdinTty(false);
    // Never let the assertion itself end the test runner.
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreStdin();
    resetModelRegistry();
    if (originalMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
    if (originalConfigDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = originalConfigDir;
    resetWorkspaceStore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('exits 0 when the CLI armed exitOnComplete', async () => {
    await (cmd as unknown as { execute: Function }).execute('hi', {
      provider: 'mock',
      model: 'mock-model',
      cache: false,
      exitOnComplete: true,
    });

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('returns without exiting when a library caller did not arm it', async () => {
    await (cmd as unknown as { execute: Function }).execute('hi', {
      provider: 'mock',
      model: 'mock-model',
      cache: false,
    });

    expect(exit).not.toHaveBeenCalled();
  });

  it('does not take the headless exit on a terminal — the REPL owns the process', async () => {
    setStdinTty(true);
    vi.spyOn(cmd as unknown as { readMultiLineInput: Function }, 'readMultiLineInput').mockResolvedValue('/exit');
    const finish = vi.spyOn(cmd as unknown as { finishHeadless: Function }, 'finishHeadless');

    await (cmd as unknown as { execute: Function }).execute('hi', {
      provider: 'mock',
      model: 'mock-model',
      cache: false,
      // Even if a caller wrongly armed it, the terminal path must not use it.
      exitOnComplete: true,
    });

    expect(finish).not.toHaveBeenCalled();
  });
});
