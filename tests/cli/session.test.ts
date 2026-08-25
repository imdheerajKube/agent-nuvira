/**
 * Session command (G1) — tests for src/cli/session.ts.
 *
 * The command is a debug surface over D1's machinery: `list` filters via
 * searchSessions (project + temporal phrase), `summarize` shows metadata for
 * one session, `resume` runs autoRecall and prints the recall card. The
 * handlers are exercised against a temp homedir / BUFF_MEMORY_DIR so no real
 * user data is touched.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const testDirHolder = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs');
  const { join } = require('node:path');
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return { value: mkdtempSync(join(base, 'buff-session-')) };
});

vi.mock('node:os', () => ({
  homedir: () => testDirHolder.value,
}));

vi.mock('../../src/memory/embedder.js', () => ({
  embed: vi.fn(),
  EMBEDDING_DIM: 384,
  clearEmbeddingCache: vi.fn(),
  embeddingCacheSize: vi.fn().mockReturnValue(0),
  resetEmbeddingTierCache: vi.fn(),
  setForceLLM: vi.fn(),
  isXenovaAvailable: vi.fn().mockResolvedValue(false),
  isPythonAvailable: vi.fn().mockResolvedValue(false),
  getActiveEmbeddingTier: vi.fn().mockResolvedValue('llm (fallback, 384-dim)'),
}));

import { SessionCommand } from '../../src/cli/session.js';
import { getChatHistory } from '../../src/context/history.js';
import { resetFactStore } from '../../src/memory/fact-store.js';
import { resetWorkspaceStore } from '../../src/config/workspace.js';

const ORIGINAL_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;

beforeAll(() => {
  process.env.NUVIRA_MEMORY_DIR = join(testDirHolder.value, 'memory');
});

afterAll(() => {
  if (ORIGINAL_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = ORIGINAL_MEMORY_DIR;
  rmSync(testDirHolder.value, { recursive: true, force: true });
});

beforeEach(() => {
  resetWorkspaceStore();
  getChatHistory().clear();
});

afterEach(() => {
  getChatHistory().clear();
  resetFactStore();
  resetWorkspaceStore();
});

function createCommand(): SessionCommand {
  // The command extends BaseCommand which builds a ConfigManager — fine in
  // tests (it reads the temp config dir best-effort).
  return new (SessionCommand as unknown as new () => SessionCommand)();
}

describe('SessionCommand', () => {
  it('creates a commander command named session with list/summarize/resume', () => {
    const command = createCommand().create();
    expect(command.name()).toBe('session');
    const sub = command.commands.map((c) => c.name());
    expect(sub).toEqual(expect.arrayContaining(['list', 'summarize', 'resume']));
  });

  it('list returns no-session guidance when history is empty', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'log');
    const cmd = createCommand();
    // Drive the action handlers directly (avoids commander process.exit).
    await (cmd as any).listSessions({ limit: 10, since: '' });
    expect(infoSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('summarize prints metadata for a stored session', async () => {
    const history = getChatHistory();
    const id = history.storeSession(
      [
        { role: 'user' as const, content: 'build the checkout flow', timestamp: Date.now() },
        { role: 'assistant' as const, content: 'Done', timestamp: Date.now() + 1000 },
      ],
      'groq',
      'llama',
      false,
      'repo:acme/shop',
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cmd = createCommand();
    (cmd as any).summarizeSession(id);
    const calls = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(calls).toContain('build the checkout flow');
    expect(calls).toContain('groq');
    expect(calls).toContain('repo:acme/shop');
    logSpy.mockRestore();
  });

  it('summarize reports not-found for unknown ids', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cmd = createCommand();
    (cmd as any).summarizeSession('does-not-exist');
    expect(errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n')).toContain('Session not found');
    errorSpy.mockRestore();
  });
});
