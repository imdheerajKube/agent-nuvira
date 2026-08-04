/**
 * Execute command — Unit tests for interactive development mode.
 *
 * Tests the slash-command handler (handleDevCommand), goal input parsing
 * (parseGoalLines), session history display, and session save/resume.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import { ExecuteCommand, parseGoalLines, checkpointOptions } from '../../src/cli/execute.js';
import { logger } from '../../src/utils/logger.js';
import { ProviderFactory } from '../../src/inference/factory.js';
import { saveCheckpoint, checkpointIdFor, loadCheckpoint } from '../../src/agents/checkpoint-store.js';
import { getModelRegistry, resetModelRegistry } from '../../src/learning/model-registry.js';
import inquirer from 'inquirer';

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

// ─── Tests: checkpoint list (--checkpoint-list) ───────────────────────────

describe('ExecuteCommand — checkpoint list (--checkpoint / --resume / --checkpoint-list)', () => {
  let cmd: ExecuteCommand;
  let memDir: string;

  beforeEach(() => {
    cmd = new ExecuteCommand();
    memDir = mkdtempSync(join(tmpdir(), 'buff-exec-cp-'));
    process.env.BUFF_MEMORY_DIR = memDir;
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'highlight').mockImplementation(() => {});
    vi.spyOn(logger, 'success').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.BUFF_MEMORY_DIR;
    try { rmSync(memDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function makeContext(goal = 'cp goal', status: 'pending' | 'completed' = 'completed') {
    return {
      goal,
      workingDirectory: process.cwd(),
      taskPlan: [{ id: 'step-1', agentType: 'writer', description: 'write', status, dependsOn: [] }],
      artifacts: [],
      conversations: [],
      fileChanges: [],
      metadata: {},
    } as any;
  }

  it('should show a hint when no checkpoints exist', () => {
    (cmd as any).showCheckpointList();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('No checkpoints found'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('--checkpoint'));
  });

  it('should list saved checkpoints with goal and progress', () => {
    const id = saveCheckpoint(makeContext('smoke goal'), 'cp-smoke-1');
    expect(id).toBe('cp-smoke-1');

    (cmd as any).showCheckpointList();
    expect(logger.highlight).toHaveBeenCalledWith(expect.stringContaining('Checkpoints'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('cp-smoke-1'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('smoke goal'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('1/1 steps (100%)'));
  });

  it('should list a partial checkpoint with correct progress percentage', () => {
    saveCheckpoint(makeContext('partial goal', 'pending'), 'cp-partial-1');

    (cmd as any).showCheckpointList();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('0/1 steps (0%)'));
  });

  it('should route --checkpoint-list to the list view and exit early', async () => {
    const listSpy = vi.spyOn(cmd as any, 'showCheckpointList').mockImplementation(() => {});
    // execute() with checkpointList: true should list and return without
    // entering interactive mode or running a goal.
    await (cmd as any).execute(undefined, { checkpointList: true } as any);
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it('should derive the resume id from the auto checkpoint id for goal + cwd', () => {
    const autoId = checkpointIdFor('resume-me goal', process.cwd());
    const id = saveCheckpoint(makeContext('resume-me goal'), autoId);
    expect(id).toBe(autoId);
    // The saved checkpoint round-trips — a bare `--resume` (auto id) can find it.
    expect(loadCheckpoint(autoId)?.goal).toBe('resume-me goal');
  });

  it('should map --resume / --checkpoint flags via checkpointOptions()', () => {
    // Bare --resume → resume the auto id (no explicit id) with save-on.
    expect(checkpointOptions(false, true)).toEqual({
      checkpoint: true,
      resumeCheckpointId: undefined,
      resumeRequested: true,
    });
    // --resume <id> → explicit id, resume requested.
    expect(checkpointOptions(false, 'cp-abc')).toEqual({
      checkpoint: true,
      resumeCheckpointId: 'cp-abc',
      resumeRequested: true,
    });
    // --checkpoint only → save forward, NO resume (load gate stays closed).
    expect(checkpointOptions(true, undefined)).toEqual({
      checkpoint: true,
      resumeCheckpointId: undefined,
      resumeRequested: false,
    });
    // No flags → checkpointing entirely off.
    expect(checkpointOptions(false, undefined)).toEqual({
      checkpoint: false,
      resumeCheckpointId: undefined,
      resumeRequested: false,
    });
  });
});

// ─── Tests: analyzeFailure ─────────────────────────────────────────────────

describe('ExecuteCommand — analyzeFailure', () => {
  let cmd: ExecuteCommand;

  beforeEach(() => {
    cmd = new ExecuteCommand();
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'highlight').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeAgentResult(agent: string, success: boolean, summary: string) {
    return { agent, success, summary, details: '' };
  }

  function makeOrchestrationResult(overrides: Partial<{
    goal: string;
    success: boolean;
    summary: string;
    error: string;
    agentResults: Array<{ agent: string; success: boolean; summary: string; details: string }>;
    fileChanges: string;
    runOutput: string;
  }>) {
    return {
      goal: overrides.goal || 'test goal',
      success: overrides.success ?? false,
      summary: overrides.summary || 'Failed',
      error: overrides.error || '',
      agentResults: overrides.agentResults || [],
      fileChanges: overrides.fileChanges || '',
      runOutput: overrides.runOutput || '',
      tasksCompleted: 0,
      tasksTotal: 1,
      trajectoryId: '',
    };
  }

  // ── No failed agents (pipeline error) ───────────────────────────────────

  it('should detect pipeline error when no agent results exist', () => {
    const result = makeOrchestrationResult({
      error: 'Provider quota exceeded',
      agentResults: [],
    });
    const analysis = (cmd as any).analyzeFailure(result);
    expect(analysis.failureType).toBe('other');
    expect(analysis.failedAgents).toHaveLength(0);
    expect(analysis.advice).toContain('Provider quota exceeded');
    expect(analysis.recoveryActions).toHaveLength(1);
    expect(analysis.recoveryActions[0].action).toBe('continue');
  });

  it('should fallback to Unknown error when no error provided', () => {
    const result = makeOrchestrationResult({ agentResults: [] });
    const analysis = (cmd as any).analyzeFailure(result);
    expect(analysis.advice).toBe('Unknown error occurred');
  });

  // ── Planner failure ─────────────────────────────────────────────────────

  it('should detect planner failure', () => {
    const result = makeOrchestrationResult({
      agentResults: [makeAgentResult('planner', false, 'Could not create execution plan')],
    });
    const analysis = (cmd as any).analyzeFailure(result);
    expect(analysis.failureType).toBe('planner');
    expect(analysis.failedAgents).toHaveLength(1);
    expect(analysis.failedAgents[0].agent).toBe('planner');
    expect(analysis.advice).toContain('Planner agent');
    // Planner should NOT include retry-fix
    expect(analysis.recoveryActions.every((a: any) => a.action !== 'retry-fix')).toBe(true);
    // Should include rephrase and switch-model
    const actions = analysis.recoveryActions.map((a: any) => a.action);
    expect(actions).toContain('continue');
    expect(actions).toContain('switch-model');
  });

  // ── Writer failure ──────────────────────────────────────────────────────

  it('should detect writer failure', () => {
    const result = makeOrchestrationResult({
      agentResults: [makeAgentResult('writer', false, 'Failed to generate code')],
    });
    const analysis = (cmd as any).analyzeFailure(result);
    expect(analysis.failureType).toBe('writer');
    expect(analysis.failedAgents[0].agent).toBe('writer');
    expect(analysis.advice).toContain('Writer agent');
    // Writer SHOULD include retry-fix
    expect(analysis.recoveryActions.some((a: any) => a.action === 'retry-fix')).toBe(true);
  });

  // ── Runner failure ──────────────────────────────────────────────────────

  it('should detect runner failure', () => {
    const result = makeOrchestrationResult({
      agentResults: [makeAgentResult('runner', false, 'Command failed with exit code 1')],
    });
    const analysis = (cmd as any).analyzeFailure(result);
    expect(analysis.failureType).toBe('runner');
    expect(analysis.failedAgents[0].agent).toBe('runner');
    expect(analysis.advice).toContain('Runner agent');
    // Runner should NOT include retry-fix
    expect(analysis.recoveryActions.every((a: any) => a.action !== 'retry-fix')).toBe(true);
  });

  it('should detect runner failure with command not found', () => {
    const result = makeOrchestrationResult({
      agentResults: [makeAgentResult('runner', false, 'command not found: tsc')],
    });
    const analysis = (cmd as any).analyzeFailure(result);
    expect(analysis.advice).toContain('dependency is installed');
  });

  it('should detect runner failure with syntax error', () => {
    const result = makeOrchestrationResult({
      agentResults: [makeAgentResult('runner', false, 'SyntaxError: Unexpected token')],
    });
    const analysis = (cmd as any).analyzeFailure(result);
    expect(analysis.advice).toContain('generated code may have issues');
  });

  // ── Tester failure ──────────────────────────────────────────────────────

  it('should detect tester failure', () => {
    const result = makeOrchestrationResult({
      agentResults: [makeAgentResult('tester', false, '3 tests failed')],
    });
    const analysis = (cmd as any).analyzeFailure(result);
    expect(analysis.failureType).toBe('tester');
    expect(analysis.advice).toContain('Tester agent');
    expect(analysis.recoveryActions.some((a: any) => a.action === 'retry-fix')).toBe(true);
    expect(analysis.recoveryActions.some((a: any) => a.action === 'continue')).toBe(true);
  });

  // ── Debugger failure ────────────────────────────────────────────────────

  it('should detect debugger failure', () => {
    const result = makeOrchestrationResult({
      agentResults: [makeAgentResult('debugger', false, 'Could not apply fix')],
    });
    const analysis = (cmd as any).analyzeFailure(result);
    expect(analysis.failureType).toBe('debugger');
    expect(analysis.advice).toContain('Debugger agent');
    expect(analysis.recoveryActions.some((a: any) => a.action === 'retry-fix')).toBe(true);
    expect(analysis.recoveryActions.some((a: any) => a.action === 'switch-model')).toBe(true);
  });

  // ── Reviewer failure ────────────────────────────────────────────────────

  it('should detect reviewer failure', () => {
    const result = makeOrchestrationResult({
      agentResults: [makeAgentResult('reviewer', false, 'Review failed')],
    });
    const analysis = (cmd as any).analyzeFailure(result);
    expect(analysis.failureType).toBe('reviewer');
    expect(analysis.recoveryActions.some((a: any) => a.action === 'switch-model')).toBe(true);
    expect(analysis.recoveryActions.some((a: any) => a.action === 'retry-fix')).toBe(true);
  });

  // ── Context-gatherer failure ────────────────────────────────────────────

  it('should detect context-gatherer failure', () => {
    const result = makeOrchestrationResult({
      agentResults: [makeAgentResult('context-gatherer', false, 'Failed to read files')],
    });
    const analysis = (cmd as any).analyzeFailure(result);
    expect(analysis.failureType).toBe('context-gatherer');
    expect(analysis.recoveryActions.some((a: any) => a.action === 'retry-fix')).toBe(true);
  });

  // ── Unknown agent failure ───────────────────────────────────────────────

  it('should handle unknown agent types', () => {
    const result = makeOrchestrationResult({
      agentResults: [makeAgentResult('custom-agent', false, 'Something went wrong')],
    });
    const analysis = (cmd as any).analyzeFailure(result);
    expect(analysis.failureType).toBe('other');
    expect(analysis.advice).toContain('custom-agent');
    expect(analysis.recoveryActions.some((a: any) => a.action === 'retry-fix')).toBe(true);
  });

  // ── Multiple failed agents ──────────────────────────────────────────────

  it('should list all failed agents', () => {
    const result = makeOrchestrationResult({
      agentResults: [
        makeAgentResult('writer', false, 'Write failed'),
        makeAgentResult('runner', false, 'Run failed'),
        makeAgentResult('tester', true, 'Tests passed'),
      ],
    });
    const analysis = (cmd as any).analyzeFailure(result);
    expect(analysis.failureType).toBe('writer'); // first failed determines type
    expect(analysis.failedAgents).toHaveLength(2);
    expect(analysis.failedAgents[0].agent).toBe('writer');
    expect(analysis.failedAgents[1].agent).toBe('runner');
  });

  it('should cap error summary at 200 chars', () => {
    const longError = 'x'.repeat(300);
    const result = makeOrchestrationResult({
      agentResults: [makeAgentResult('writer', false, longError)],
    });
    const analysis = (cmd as any).analyzeFailure(result);
    expect(analysis.failedAgents[0].error.length).toBe(200);
  });
});

// ─── Tests: generateFollowUpSuggestions (rule-based fallback) ───────────────

describe('ExecuteCommand — generateFollowUpSuggestions (fallback)', () => {
  let cmd: ExecuteCommand;
  let memDir: string;

  beforeEach(() => {
    cmd = new ExecuteCommand();
    // Isolate the Model Registry: the failed-LLM path now writes telemetry
    // (recordRegistryFailure), and without BUFF_MEMORY_DIR it would hit the
    // REAL user registry.
    memDir = mkdtempSync(join(tmpdir(), 'buff-exec-fu-'));
    process.env.BUFF_MEMORY_DIR = memDir;
    resetModelRegistry();
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'highlight').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Mock configManager so getProviderConfig throws, causing LLM path to fail
    // and fall through to rule-based. This avoids needing to mock ProviderFactory.
    (cmd as any).configManager = {
      getAll: () => ({ defaultProvider: 'groq' }),
      getProviderConfig: () => { throw new Error('Mock: config unavailable'); },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetModelRegistry();
    delete process.env.BUFF_MEMORY_DIR;
    try { rmSync(memDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function makeResult(overrides: Partial<{
    goal: string;
    fileChanges: string;
    runOutput: string;
    agentResults: Array<{ agent: string; success: boolean; summary: string; details: string }>;
  }>) {
    return {
      goal: overrides.goal || 'test goal',
      success: true,
      summary: 'Completed',
      error: '',
      fileChanges: overrides.fileChanges || '',
      runOutput: overrides.runOutput || '',
      agentResults: overrides.agentResults || [],
      tasksCompleted: 1,
      tasksTotal: 1,
      trajectoryId: '',
    };
  }

  it('should suggest "Run the tests" when goal mentions testing', async () => {
    const result = makeResult({ goal: 'Add unit tests for the API' });
    const suggestions = await (cmd as any).generateFollowUpSuggestions(result, 'groq', 'llama3');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.some((s: any) => s.label.includes('Run the tests'))).toBe(true);
  });

  it('should suggest TS/JS docs and unit tests when fileChanges has .ts or .js', async () => {
    const result = makeResult({ fileChanges: 'src/index.ts\nsrc/utils.ts' });
    const suggestions = await (cmd as any).generateFollowUpSuggestions(result, 'groq', 'llama3');
    expect(suggestions.some((s: any) => s.label.includes('JSDoc/TSDoc'))).toBe(true);
    expect(suggestions.some((s: any) => s.label.includes('Add unit tests'))).toBe(true);
  });

  it('should suggest Python type hints when fileChanges has .py', async () => {
    const result = makeResult({ fileChanges: 'app.py' });
    const suggestions = await (cmd as any).generateFollowUpSuggestions(result, 'groq', 'llama3');
    expect(suggestions.some((s: any) => s.label.includes('Python type hints'))).toBe(true);
  });

  it('should suggest input validation when fileChanges mentions routes/api', async () => {
    // Use no file extension so only the 'route'/'api' condition matches.
    // Using '.ts' or '.js' would also trigger the docs/unit-tests rule,
    // pushing the input-validation suggestion past the .slice(0, 3) limit.
    const result = makeResult({ fileChanges: 'src/api/routes' });
    const suggestions = await (cmd as any).generateFollowUpSuggestions(result, 'groq', 'llama3');
    expect(suggestions.some((s: any) => s.label.includes('input validation'))).toBe(true);
  });

  it('should suggest fix errors when runOutput contains errors', async () => {
    const result = makeResult({ runOutput: 'Error: Cannot find module' });
    const suggestions = await (cmd as any).generateFollowUpSuggestions(result, 'groq', 'llama3');
    expect(suggestions.some((s: any) => s.label.includes('Fix the execution errors'))).toBe(true);
  });

  it('should suggest deploy when runner agent succeeded', async () => {
    const result = makeResult({
      agentResults: [{ agent: 'runner', success: true, summary: 'Build successful', details: '' }],
    });
    const suggestions = await (cmd as any).generateFollowUpSuggestions(result, 'groq', 'llama3');
    expect(suggestions.some((s: any) => s.label.includes('Deploy the project'))).toBe(true);
  });

  it('should limit suggestions to 3', async () => {
    const result = makeResult({
      goal: 'Add unit tests',
      fileChanges: 'src/index.ts\nsrc/utils.ts\napp.py',
      agentResults: [{ agent: 'runner', success: true, summary: 'Build successful', details: '' }],
    });
    const suggestions = await (cmd as any).generateFollowUpSuggestions(result, 'groq', 'llama3');
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });

  it('should return empty array when no rules match', async () => {
    const result = makeResult({ goal: 'Do something unrelated' });
    const suggestions = await (cmd as any).generateFollowUpSuggestions(result, 'groq', 'llama3');
    expect(suggestions).toHaveLength(0);
  });

  it('writes the failed LLM call through to the model registry (telemetry)', async () => {
    // The LLM path fails (mock config throws) and falls back to rule-based —
    // but the SHARED telemetry path must still have learned the provider×model
    // so future routing in every action skips it predictively.
    const result = makeResult({ goal: 'Add unit tests for the API' });
    await (cmd as any).generateFollowUpSuggestions(result, 'groq', 'llama3');

    const entry = getModelRegistry().getEntry('groq', 'llama3');
    expect(entry).toBeDefined();
    expect((entry?.errorRate ?? 0)).toBeGreaterThan(0);
  });
});

// ─── Tests: generateFollowUpSuggestions (LLM-powered) ───────────────────────

describe('ExecuteCommand — generateFollowUpSuggestions (LLM)', () => {
  let cmd: ExecuteCommand;

  beforeEach(() => {
    cmd = new ExecuteCommand();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const mockProvider = {
      generate: vi.fn().mockResolvedValue(
        '[{"label":"Add error handling","description":"Handle edge cases","goal":"Add error handling to API routes"},{"label":"Write tests","description":"Add unit tests for new code","goal":"Write comprehensive unit tests"}]'
      ),
    };

    // To make the LLM path succeed, we need ProviderFactory.createProvider to
    // return a mock provider. Since vi.spyOn across ESM module boundaries may
    // not work reliably, we mock the configManager to use a local provider type
    // and directly replace the method on the instance.
    (cmd as any).configManager = {
      getAll: () => ({ defaultProvider: 'local' }),
      getProviderConfig: () => ({ config: {} }),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return LLM-generated suggestions when provider works', async () => {
    // For this test, we need to mock ProviderFactory.createProvider to return
    // a mock with a generate method that returns valid JSON. We use a spy on
    // the instance's own module reference.
    const mockProvider = {
      generate: vi.fn().mockResolvedValue(
        '[{"label":"Add error handling","description":"Handle edge cases","goal":"Add error handling to API routes"},{"label":"Write tests","description":"Add unit tests for new code","goal":"Write comprehensive unit tests"}]'
      ),
    };
    vi.spyOn(ProviderFactory, 'createProvider').mockReturnValue(mockProvider as any);

    const result = {
      goal: 'Create a REST API',
      success: true,
      summary: 'Created API routes',
      error: '',
      fileChanges: 'src/routes.ts',
      runOutput: '',
      agentResults: [{ agent: 'writer', success: true, summary: 'Created files', details: '' }],
      tasksCompleted: 1,
      tasksTotal: 1,
      trajectoryId: '',
    };
    const suggestions = await (cmd as any).generateFollowUpSuggestions(result, 'local', 'llama3');
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].label).toContain('error handling');
    expect(suggestions[1].goal).toContain('unit tests');
  });

  it('should fall back to rule-based when JSON parsing fails', async () => {
    const mockProvider = {
      generate: vi.fn().mockResolvedValue('Sorry, I cannot generate suggestions'),
    };
    vi.spyOn(ProviderFactory, 'createProvider').mockReturnValue(mockProvider as any);

    const result = {
      goal: 'Add unit tests',
      success: true,
      summary: 'Done',
      error: '',
      fileChanges: 'src/index.ts',
      runOutput: '',
      agentResults: [{ agent: 'runner', success: true, summary: 'Build OK', details: '' }],
      tasksCompleted: 1,
      tasksTotal: 1,
      trajectoryId: '',
    };
    const suggestions = await (cmd as any).generateFollowUpSuggestions(result, 'local', 'llama3');
    // Should fall back to rule-based for goal "Add unit tests"
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.some((s: any) => s.label.includes('Run the tests'))).toBe(true);
  });
});

// ─── Tests: handlePostExecution ─────────────────────────────────────────────

describe('ExecuteCommand — handlePostExecution', () => {
  let cmd: ExecuteCommand;

  beforeEach(() => {
    cmd = new ExecuteCommand();

    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'highlight').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Stub generatePostExecutionActions to return simple choices (avoids inquirer rendering complex choices)
    vi.spyOn(cmd as any, 'generatePostExecutionActions').mockResolvedValue([
      { name: 'Continue', value: 'continue' },
      { name: 'Exit', value: 'exit' },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeSessionHistory(entries?: Array<{ goal: string; success: boolean; summary: string; timestamp: number }>) {
    return entries ? [...entries] : [];
  }

  function makeLastFailed(goal: string, error?: string) {
    return {
      goal,
      orchestrationResult: {
        goal,
        success: false,
        summary: 'Failed',
        error: error || 'Error',
        agentResults: [{ agent: 'writer', success: false, summary: error || 'Error', details: '' }],
        fileChanges: '',
        runOutput: '',
        tasksCompleted: 0,
        tasksTotal: 1,
        trajectoryId: '',
      },
    };
  }

  // ── Session history tracking ───────────────────────────────────────────

  it('should push successful goal to session history', async () => {
    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'continue' } as any);

    const history = makeSessionHistory();
    await (cmd as any).handlePostExecution(
      'Add auth',
      { success: true, orchestrationResult: { goal: 'Add auth', success: true, summary: 'Done', error: '', fileChanges: '', runOutput: '', agentResults: [], tasksCompleted: 1, tasksTotal: 1, trajectoryId: '' } },
      history,
      null,
      'groq',
      'llama3',
      {},
    );

    expect(history).toHaveLength(1);
    expect(history[0].goal).toBe('Add auth');
    expect(history[0].success).toBe(true);
    expect(history[0].summary).toContain('Completed');
  });

  it('should push failed goal to session history', async () => {
    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'continue' } as any);

    const history = makeSessionHistory();
    await (cmd as any).handlePostExecution(
      'Broken task',
      { success: false, orchestrationResult: { goal: 'Broken task', success: false, summary: 'Failed', error: 'Error', fileChanges: '', runOutput: '', agentResults: [{ agent: 'writer', success: false, summary: 'Error', details: '' }], tasksCompleted: 0, tasksTotal: 1, trajectoryId: '' } },
      history,
      null,
      'groq',
      'llama3',
      {},
    );

    expect(history).toHaveLength(1);
    expect(history[0].goal).toBe('Broken task');
    expect(history[0].success).toBe(false);
    expect(history[0].summary).toContain('Failed');
  });

  it('should append to existing session history', async () => {
    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'continue' } as any);

    const existing = makeSessionHistory([
      { goal: 'First goal', success: true, summary: 'Done', timestamp: 1000 },
    ]);
    await (cmd as any).handlePostExecution(
      'Second goal',
      { success: true, orchestrationResult: { goal: 'Second goal', success: true, summary: 'Done', error: '', fileChanges: '', runOutput: '', agentResults: [], tasksCompleted: 1, tasksTotal: 1, trajectoryId: '' } },
      existing,
      null,
      'groq',
      'llama3',
      {},
    );

    expect(existing).toHaveLength(2);
    expect(existing[0].goal).toBe('First goal');
    expect(existing[1].goal).toBe('Second goal');
  });

  // ── lastFailedGoal tracking ────────────────────────────────────────────

  it('should clear lastFailedGoal on success', async () => {
    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'continue' } as any);

    const previousFail = makeLastFailed('Previous fail');
    const history = makeSessionHistory();
    const result = await (cmd as any).handlePostExecution(
      'Successful goal',
      { success: true, orchestrationResult: { goal: 'Successful goal', success: true, summary: 'Done', error: '', fileChanges: '', runOutput: '', agentResults: [], tasksCompleted: 1, tasksTotal: 1, trajectoryId: '' } },
      history,
      previousFail,
      'groq',
      'llama3',
      {},
    );

    expect(result.updatedLastFailed).toBeNull();
  });

  it('should set lastFailedGoal on failure with orchestrationResult', async () => {
    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'continue' } as any);

    const orchestrationResult = {
      goal: 'Failed goal',
      success: false,
      summary: 'Error',
      error: 'Something broke',
      fileChanges: '',
      runOutput: '',
      agentResults: [{ agent: 'writer', success: false, summary: 'Error', details: '' }],
      tasksCompleted: 0,
      tasksTotal: 1,
      trajectoryId: '',
    };
    const history = makeSessionHistory();
    const result = await (cmd as any).handlePostExecution(
      'Failed goal',
      { success: false, orchestrationResult },
      history,
      null,
      'groq',
      'llama3',
      {},
    );

    expect(result.updatedLastFailed).not.toBeNull();
    expect(result.updatedLastFailed!.goal).toBe('Failed goal');
    expect(result.updatedLastFailed!.orchestrationResult).toBe(orchestrationResult);
  });

  it('should preserve existing lastFailedGoal when failure has no orchestrationResult', async () => {
    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'continue' } as any);

    const previousFail = makeLastFailed('Previous fail');
    const history = makeSessionHistory();
    const result = await (cmd as any).handlePostExecution(
      'New goal',
      { success: false }, // no orchestrationResult
      history,
      previousFail,
      'groq',
      'llama3',
      {},
    );

    // lastFailedGoal should remain the previous failure
    expect(result.updatedLastFailed).toBe(previousFail);
  });

  // ── Action parsing ─────────────────────────────────────────────────────

  it('should return continue action by default', async () => {
    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'continue' } as any);

    const result = await (cmd as any).handlePostExecution(
      'goal',
      { success: true, orchestrationResult: { goal: 'goal', success: true, summary: 'Done', error: '', fileChanges: '', runOutput: '', agentResults: [], tasksCompleted: 1, tasksTotal: 1, trajectoryId: '' } },
      [],
      null,
      'groq',
      'llama3',
      {},
    );

    expect(result.action.type).toBe('continue');
  });

  it('should return exit action when user selects exit', async () => {
    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'exit' } as any);

    const result = await (cmd as any).handlePostExecution(
      'goal',
      { success: true, orchestrationResult: { goal: 'goal', success: true, summary: 'Done', error: '', fileChanges: '', runOutput: '', agentResults: [], tasksCompleted: 1, tasksTotal: 1, trajectoryId: '' } },
      [],
      null,
      'groq',
      'llama3',
      {},
    );

    expect(result.action.type).toBe('exit');
  });

  it('should return switch-model action', async () => {
    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'switch-model' } as any);

    const result = await (cmd as any).handlePostExecution(
      'goal',
      { success: true, orchestrationResult: { goal: 'goal', success: true, summary: 'Done', error: '', fileChanges: '', runOutput: '', agentResults: [], tasksCompleted: 1, tasksTotal: 1, trajectoryId: '' } },
      [],
      null,
      'groq',
      'llama3',
      {},
    );

    expect(result.action.type).toBe('switch-model');
  });

  it('should return history action', async () => {
    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'history' } as any);

    const result = await (cmd as any).handlePostExecution(
      'goal',
      { success: true, orchestrationResult: { goal: 'goal', success: true, summary: 'Done', error: '', fileChanges: '', runOutput: '', agentResults: [], tasksCompleted: 1, tasksTotal: 1, trajectoryId: '' } },
      [],
      null,
      'groq',
      'llama3',
      {},
    );

    expect(result.action.type).toBe('history');
  });

  it('should return retry-fix action', async () => {
    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'retry-fix' } as any);

    const result = await (cmd as any).handlePostExecution(
      'goal',
      { success: true, orchestrationResult: { goal: 'goal', success: true, summary: 'Done', error: '', fileChanges: '', runOutput: '', agentResults: [], tasksCompleted: 1, tasksTotal: 1, trajectoryId: '' } },
      [],
      null,
      'groq',
      'llama3',
      {},
    );

    expect(result.action.type).toBe('retry-fix');
  });

  it('should return followup action with goal from followup: prefix', async () => {
    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'followup:Add error handling to the routes' } as any);

    const result = await (cmd as any).handlePostExecution(
      'goal',
      { success: true, orchestrationResult: { goal: 'goal', success: true, summary: 'Done', error: '', fileChanges: '', runOutput: '', agentResults: [], tasksCompleted: 1, tasksTotal: 1, trajectoryId: '' } },
      [],
      null,
      'groq',
      'llama3',
      {},
    );

    expect(result.action.type).toBe('followup');
    expect(result.action.goal).toBe('Add error handling to the routes');
  });

  it('should call generatePostExecutionActions with the result', async () => {
    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'continue' } as any);

    const mockGenerate = vi.spyOn(cmd as any, 'generatePostExecutionActions').mockClear();
    mockGenerate.mockResolvedValue([{ name: 'Continue', value: 'continue' }]);

    const orchestrationResult = { goal: 'goal', success: true, summary: 'Done', error: '', fileChanges: '', runOutput: '', agentResults: [], tasksCompleted: 1, tasksTotal: 1, trajectoryId: '' };
    await (cmd as any).handlePostExecution(
      'goal',
      { success: true, orchestrationResult },
      [],
      null,
      'groq',
      'llama3',
      { verbose: true },
    );

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
      'groq',
      'llama3',
      { verbose: true },
    );
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
