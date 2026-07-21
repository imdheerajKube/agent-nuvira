/**
 * Execute command — Unit tests for interactive development mode.
 *
 * Tests the slash-command handler (handleDevCommand), goal input parsing
 * (parseGoalLines), session history display, and session save/resume.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { ExecuteCommand, parseGoalLines } from '../../src/cli/execute.js';
import { logger } from '../../src/utils/logger.js';

// ─── Test Constants ─────────────────────────────────────────────────────────

const SESSIONS_DIR = join(homedir(), '.buff', 'sessions');

// ─── Tests: parseGoalLines (pure function, no mocking needed) ───────────────

describe('parseGoalLines', () => {
  it('should return empty string for empty array', () => {
    expect(parseGoalLines([])).toBe('');
  });

  it('should join single line', () => {
    expect(parseGoalLines(['Add JWT auth'])).toBe('Add JWT auth');
  });

  it('should join multiple lines with newline', () => {
    const result = parseGoalLines(['Add JWT auth', 'Use Express middleware']);
    expect(result).toBe('Add JWT auth\nUse Express middleware');
  });

  it('should preserve empty lines in multi-line input', () => {
    const result = parseGoalLines(['Line 1', '', 'Line 3']);
    expect(result).toBe('Line 1\n\nLine 3');
  });

  it('should handle lines with trailing spaces', () => {
    const result = parseGoalLines(['  Add JWT auth  ']);
    expect(result).toBe('  Add JWT auth  ');
  });

  it('should handle command-like input', () => {
    const result = parseGoalLines(['/exit']);
    expect(result).toBe('/exit');
  });

  it('should handle multi-line with many lines', () => {
    const lines = ['Goal 1', 'Goal 2', 'Goal 3', 'Goal 4', 'Goal 5'];
    expect(parseGoalLines(lines)).toBe('Goal 1\nGoal 2\nGoal 3\nGoal 4\nGoal 5');
  });
});

// ─── Tests: handleDevCommand ────────────────────────────────────────────────

describe('ExecuteCommand — handleDevCommand', () => {
  let cmd: ExecuteCommand;
  let mockContext: any;

  beforeEach(() => {
    cmd = new ExecuteCommand();
    // Spy on logger methods
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'highlight').mockImplementation(() => {});
    vi.spyOn(logger, 'success').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    mockContext = {
      activeModel: 'gpt-4',
      activeProvider: 'openai',
      sessionHistory: [
        { goal: 'Add JWT auth', success: true, summary: 'Done', timestamp: Date.now() - 1000 },
        { goal: 'Create API routes', success: true, summary: 'Done', timestamp: Date.now() - 500 },
      ],
      configManager: {} as any,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── /exit ─────────────────────────────────────────────────────────────────

  it('should exit on /exit command', async () => {
    const result = await (cmd as any).handleDevCommand('/exit', mockContext);
    expect(result.exit).toBe(true);
    expect(result.newModel).toBeUndefined();
  });

  it('should exit on /quit command', async () => {
    const result = await (cmd as any).handleDevCommand('/quit', mockContext);
    expect(result.exit).toBe(true);
  });

  it('should exit on /EXIT (case insensitive)', async () => {
    const result = await (cmd as any).handleDevCommand('/EXIT', mockContext);
    expect(result.exit).toBe(true);
  });

  it('should exit on /exit with trailing spaces', async () => {
    const result = await (cmd as any).handleDevCommand('  /exit  ', mockContext);
    expect(result.exit).toBe(true);
  });

  // ── /model ────────────────────────────────────────────────────────────────

  it('should request model switch on /model command', async () => {
    const result = await (cmd as any).handleDevCommand('/model', mockContext);
    expect(result.exit).toBe(false);
    expect(result.newModel).toBe(true);
  });

  it('should request model switch on /MODEL (case insensitive)', async () => {
    const result = await (cmd as any).handleDevCommand('/MODEL', mockContext);
    expect(result.exit).toBe(false);
    expect(result.newModel).toBe(true);
  });

  // ── /help ─────────────────────────────────────────────────────────────────

  it('should print help and not exit on /help', async () => {
    const result = await (cmd as any).handleDevCommand('/help', mockContext);
    expect(result.exit).toBe(false);
    expect(console.log).toHaveBeenCalled();
  });

  // ── /history ──────────────────────────────────────────────────────────────

  it('should show session history on /history command', async () => {
    const highlightSpy = vi.spyOn(logger, 'highlight');
    const result = await (cmd as any).handleDevCommand('/history', mockContext);
    expect(result.exit).toBe(false);
    expect(highlightSpy).toHaveBeenCalledWith(expect.stringContaining('Session History'));
  });

  it('should show empty message when no session history', async () => {
    const result = await (cmd as any).handleDevCommand('/history', {
      activeModel: 'gpt-4',
      activeProvider: 'openai',
      sessionHistory: [],
      configManager: {} as any,
    });
    expect(result.exit).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('No goals'));
  });

  it('should show empty message when context has no sessionHistory', async () => {
    const result = await (cmd as any).handleDevCommand('/history', undefined);
    expect(result.exit).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('No session'));
  });

  // ── /suggest ──────────────────────────────────────────────────────────────

  it('should show usage when /suggest called without query and no history', async () => {
    const result = await (cmd as any).handleDevCommand('/suggest', {
      activeModel: 'gpt-4',
      activeProvider: 'openai',
      sessionHistory: [],
      configManager: {} as any,
    });
    expect(result.exit).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  it('should trigger suggest with query argument', async () => {
    const result = await (cmd as any).handleDevCommand('/suggest authentication', mockContext);
    expect(result.exit).toBe(false);
    expect(logger.highlight).toHaveBeenCalledWith(expect.stringContaining('Searching memory'));
  });

  // ── /save ─────────────────────────────────────────────────────────────────

  it('should show usage when /save called without name', async () => {
    const result = await (cmd as any).handleDevCommand('/save', mockContext);
    expect(result.exit).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('should save session when /save called with name', async () => {
    const result = await (cmd as any).handleDevCommand('/save test-session-exec', mockContext);
    expect(result.exit).toBe(false);
    expect(logger.success).toHaveBeenCalledWith(expect.stringContaining('Session saved'));
  });

  it('should show usage when /save called without context', async () => {
    const result = await (cmd as any).handleDevCommand('/save test', undefined);
    expect(result.exit).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('No session'));
  });

  // ── /resume ───────────────────────────────────────────────────────────────

  it('should show usage when /resume called without name', async () => {
    const result = await (cmd as any).handleDevCommand('/resume', mockContext);
    expect(result.exit).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('should show error when /resume called with nonexistent session', async () => {
    const result = await (cmd as any).handleDevCommand('/resume nonexistent-session-xyz', mockContext);
    expect(result.exit).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  // ── /resume with valid saved session (created in /save test) ──────────────

  it('should resume a previously saved session', async () => {
    // First save the session (creates file on disk)
    await (cmd as any).handleDevCommand('/save test-session-exec', mockContext);

    // Then resume it
    const result = await (cmd as any).handleDevCommand('/resume test-session-exec', mockContext);
    expect(result.exit).toBe(false);
    // Resume should include restore data
    expect(result.restore).toBeDefined();
    expect(result.restore.provider).toBe('openai');
    expect(result.restore.model).toBe('gpt-4');
    expect(result.restore.history).toHaveLength(2);
  });

  // ── unknown commands ──────────────────────────────────────────────────────

  it('should warn on unknown commands', async () => {
    const result = await (cmd as any).handleDevCommand('/foobar', mockContext);
    expect(result.exit).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Unknown command'));
  });

  // ── /help with trailing argument ──────────────────────────────────────────

  it('should handle /help with extra text gracefully', async () => {
    const result = await (cmd as any).handleDevCommand('/help show me', mockContext);
    expect(result.exit).toBe(false);
    expect(console.log).toHaveBeenCalled();
  });

  // ── Session history display ───────────────────────────────────────────────

  it('should display session history with correct goal list', () => {
    const history = [
      { goal: 'Goal 1', success: true, summary: 'Done', timestamp: Date.now() - 2000 },
      { goal: 'Goal 2', success: false, summary: 'Failed', timestamp: Date.now() - 1000 },
    ];

    (cmd as any).showSessionHistory(history);

    expect(logger.highlight).toHaveBeenCalledWith(expect.stringContaining('Session History'));
  });

  it('should show empty message when session history is empty', () => {
    (cmd as any).showSessionHistory([]);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('No goals have been executed'));
  });
});

// ─── Cleanup test artifacts ─────────────────────────────────────────────────

afterAll(() => {
  // Clean up session files created during tests
  const testFiles = ['test-session-exec.json'];
  for (const file of testFiles) {
    const filePath = join(SESSIONS_DIR, file);
    if (existsSync(filePath)) {
      rmSync(filePath);
    }
  }
});
