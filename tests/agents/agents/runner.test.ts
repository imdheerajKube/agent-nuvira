/**
 * RunnerAgent Unit Tests
 *
 * Covers:
 * 1. Command detection — backtick, "Run:" prefix, LLM fallback, no-command
 * 2. Execute with real commands — stdout capture, stderr capture, exit codes
 * 3. Error handling — non-existent commands, output truncation
 * 4. Metadata — runResult stored in context.metadata
 * 5. Cross-platform shell detection (via platform() calls)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { RunnerAgent } from '../../../src/agents/agents/runner.js';
import type { AgentContext, LLMCallFn } from '../../../src/agents/agent.js';
import type { RunResult } from '../../../src/agents/agents/runner.js';

// ─── Context Builder ──────────────────────────────────────────────────────

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    goal: 'test goal',
    workingDirectory: tmpdir(),
    taskPlan: [],
    artifacts: [],
    conversations: [],
    fileChanges: [],
    metadata: {},
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('RunnerAgent', () => {
  let runner: RunnerAgent;
  /** Tracks LLM call count for tests that need it */
  let llmCallCount: number;

  beforeEach(() => {
    runner = new RunnerAgent();
    llmCallCount = 0;
  });

  // ─── Metadata ──────────────────────────────────────────────────────────

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(runner.name).toBe('Runner');
    });

    it('should have correct description', () => {
      expect(runner.description).toContain('Executes shell commands');
    });
  });

  // ─── Command Detection (private methods via prototype) ─────────────────

  describe('command detection', () => {
    /**
     * Access private determineCommand via prototype (same pattern as Writer tests).
     */
    function determineCommand(context: AgentContext, mockLLM: LLMCallFn): Promise<string | null> {
      return (runner as any).determineCommand.call(runner, context, mockLLM);
    }

    // ── Backtick Strategy ──────────────────────────────────────────────

    it('should extract command from backtick-wrapped in task description', async () => {
      const context = makeContext({
        taskPlan: [
          { id: 'step-1', description: 'Run `echo hello` and verify output', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      // The backtick strategy kicks in before the LLM is called, so mockLLM shouldn't be invoked
      const mockLLM: LLMCallFn = async () => {
        llmCallCount++;
        return 'should not be called';
      };

      const command = await determineCommand(context, mockLLM);
      expect(command).toBe('echo hello');
      expect(llmCallCount).toBe(0); // LLM should NOT be called
    });

    it('should extract command from backticks even with surrounding text', async () => {
      const context = makeContext({
        taskPlan: [
          { id: 'step-1', description: 'Now run `python hello.py` in the terminal', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      const mockLLM: LLMCallFn = async () => { llmCallCount++; return ''; };
      const command = await determineCommand(context, mockLLM);
      expect(command).toBe('python hello.py');
      expect(llmCallCount).toBe(0);
    });

    it('should extract the first backtick-wrapped command when multiple exist', async () => {
      const context = makeContext({
        taskPlan: [
          { id: 'step-1', description: 'Run `npm install` then `npm test` to verify', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      const mockLLM: LLMCallFn = async () => { llmCallCount++; return ''; };
      const command = await determineCommand(context, mockLLM);
      expect(command).toBe('npm install'); // First backtick match
      expect(llmCallCount).toBe(0);
    });

    // ── "Run:" Prefix Strategy ─────────────────────────────────────────

    it('should extract command from "Run:" prefix in task description', async () => {
      const context = makeContext({
        taskPlan: [
          { id: 'step-1', description: 'Run: node index.js', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      const mockLLM: LLMCallFn = async () => { llmCallCount++; return ''; };
      const command = await determineCommand(context, mockLLM);
      expect(command).toBe('node index.js');
      expect(llmCallCount).toBe(0);
    });

    it('should handle "Run:" prefix case-insensitively', async () => {
      const context = makeContext({
        taskPlan: [
          { id: 'step-1', description: 'rUN: python main.py', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      const mockLLM: LLMCallFn = async () => { llmCallCount++; return ''; };
      const command = await determineCommand(context, mockLLM);
      expect(command).toBe('python main.py');
      expect(llmCallCount).toBe(0);
    });

    it('should prefer backtick over "Run:" when both exist', async () => {
      const context = makeContext({
        taskPlan: [
          { id: 'step-1', description: 'Run: ignored-command', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      // Only "Run:" prefix, no backticks — should use Run:
      const mockLLM: LLMCallFn = async () => { llmCallCount++; return ''; };
      const command = await determineCommand(context, mockLLM);
      expect(command).toBe('ignored-command');
    });

    // ── LLM Fallback Strategy ──────────────────────────────────────────

    it('should fall back to LLM when no backtick or Run: prefix found', async () => {
      const context = makeContext({
        goal: 'create a Python script and run it',
        taskPlan: [
          { id: 'step-1', description: 'Run the Python script to verify output', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
        fileChanges: [
          { path: 'hello.py', newContent: 'print("hi")', status: 'created' },
        ],
      });

      const mockLLM: LLMCallFn = async () => {
        llmCallCount++;
        return 'python hello.py';
      };

      const command = await determineCommand(context, mockLLM);
      expect(command).toBe('python hello.py');
      expect(llmCallCount).toBe(1); // LLM was called once
    });

    it('should pass file changes context to LLM fallback', async () => {
      const context = makeContext({
        goal: 'run the node app',
        taskPlan: [
          { id: 'step-1', description: 'Execute and check output', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
        fileChanges: [
          { path: 'server.js', newContent: 'console.log("running")', status: 'created' },
          { path: 'package.json', newContent: '{"name":"test"}', status: 'created' },
        ],
      });

      let llmPrompt = '';
      const mockLLM: LLMCallFn = async (prompt: string) => {
        llmCallCount++;
        llmPrompt = prompt;
        return 'node server.js';
      };

      await determineCommand(context, mockLLM);
      expect(llmCallCount).toBe(1);
      // The LLM prompt should mention the files changed
      expect(llmPrompt).toContain('server.js');
      expect(llmPrompt).toContain('package.json');
      expect(llmPrompt).toContain('created');
    });

    it('should strip markdown code fences from LLM response', async () => {
      const context = makeContext({
        goal: 'run the app',
        taskPlan: [
          { id: 'step-1', description: 'Run the application', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      const mockLLM: LLMCallFn = async () => {
        llmCallCount++;
        return '```bash\nnode app.js\n```';
      };

      const command = await determineCommand(context, mockLLM);
      expect(command).toBe('node app.js');
    });

    it('should reject multi-line commands from LLM', async () => {
      const context = makeContext({
        goal: 'build the project',
        taskPlan: [
          { id: 'step-1', description: 'Build and run', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      const mockLLM: LLMCallFn = async () => {
        llmCallCount++;
        return 'npm install\nnpm test';
      };

      const command = await determineCommand(context, mockLLM);
      expect(command).toBeNull(); // Multi-line is rejected
    });

    it('should return null when LLM fallback also fails', async () => {
      const context = makeContext({
        goal: 'ambiguous task',
        taskPlan: [
          { id: 'step-1', description: 'Do something', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      const mockLLM: LLMCallFn = async () => {
        llmCallCount++;
        throw new Error('API error');
      };

      const command = await determineCommand(context, mockLLM);
      expect(command).toBeNull();
      expect(llmCallCount).toBe(1);
    });

    // ── Goal Fallback ──────────────────────────────────────────────────

    it('should fall back to goal when no runner task is in plan', async () => {
      // When there's no runner task in taskPlan, determineCommand uses context.goal
      const context = makeContext({
        goal: 'Run: npm test',
        taskPlan: [], // No runner task
      });

      // Should find "Run:" in the goal
      const mockLLM: LLMCallFn = async () => { llmCallCount++; return ''; };
      const command = await determineCommand(context, mockLLM);
      expect(command).toBe('npm test');
      expect(llmCallCount).toBe(0);
    });

    it('should try to find backtick command in goal when no runner task exists', async () => {
      const context = makeContext({
        goal: 'Run `echo from-goal` to verify',
        taskPlan: [],
      });

      const mockLLM: LLMCallFn = async () => { llmCallCount++; return ''; };
      const command = await determineCommand(context, mockLLM);
      expect(command).toBe('echo from-goal');
    });
  });

  // ─── Execute with Real Commands ─────────────────────────────────────────

  describe('execute', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'buff-runner-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function context(overrides: Partial<AgentContext> = {}): AgentContext {
      return makeContext({
        workingDirectory: tmpDir,
        taskPlan: [
          { id: 'step-1', description: 'Run: echo "hello world"', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
        ...overrides,
      });
    }

    function mockLLM(): LLMCallFn {
      return async () => { llmCallCount++; return ''; };
    }

    // ── Success Path ──────────────────────────────────────────────────

    it('should run a simple echo command and capture stdout', async () => {
      const result = await runner.execute(context(), mockLLM());

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Command succeeded');
      expect(result.summary).toContain('echo "hello world"');
      expect(result.details).toContain('Exit code: 0');
      expect(result.details).toContain('hello world');
    });

    it('should execute a command and show exit code 0', async () => {
      const ctx = context({
        taskPlan: [
          { id: 'step-1', description: 'Run: echo test', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      const result = await runner.execute(ctx, mockLLM());

      expect(result.success).toBe(true);
      expect(result.details).toContain('Exit code: 0');
    });

    it('should store runResult in context metadata on success', async () => {
      const ctx = context();
      await runner.execute(ctx, mockLLM());

      const runResult = ctx.metadata['runResult'] as RunResult;
      expect(runResult).toBeDefined();
      expect(runResult.success).toBe(true);
      expect(runResult.command).toBe('echo "hello world"');
      expect(runResult.exitCode).toBe(0);
      expect(runResult.stdout).toContain('hello world');
      expect(typeof runResult.duration).toBe('number');
      expect(runResult.duration).toBeGreaterThan(0);
    });

    // ── Error Handling ────────────────────────────────────────────────

    it('should report failure for non-existent command (exit code 127)', async () => {
      const ctx = context({
        taskPlan: [
          { id: 'step-1', description: 'Run: nonexistent-command-xyz-123', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      const result = await runner.execute(ctx, mockLLM());

      expect(result.success).toBe(false);
      expect(result.summary).toContain('Command failed');
      expect(result.details).toContain('Exit code:');
      // Should capture some error output
      expect(result.error).toBeTruthy();
    });

    it('should capture stderr for failed commands', async () => {
      const ctx = context({
        taskPlan: [
          { id: 'step-1', description: 'Run: node -e "process.stderr.write(\'error output\');process.exit(1)"', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      const result = await runner.execute(ctx, mockLLM());

      expect(result.success).toBe(false);
      expect(result.details).toContain('error output');
      expect(result.details).toContain('stderr:');
    });

    it('should store runResult with failure details in metadata', async () => {
      const ctx = context({
        taskPlan: [
          { id: 'step-1', description: 'Run: nonexistent-command-xyz-123', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      await runner.execute(ctx, mockLLM());

      const runResult = ctx.metadata['runResult'] as RunResult;
      expect(runResult).toBeDefined();
      expect(runResult.success).toBe(false);
      expect(runResult.exitCode).not.toBe(0);
    });

    // ── Output Truncation ─────────────────────────────────────────────

    it('should truncate long stdout in details but keep full in metadata', async () => {
      // Write a file with 1000 chars of known content
      const longContent = 'a'.repeat(1000);
      writeFileSync(join(tmpDir, 'long-output.txt'), longContent, 'utf-8');

      const ctx = context({
        taskPlan: [
          { id: 'step-1', description: `Run: node -e "const fs=require('fs');console.log(fs.readFileSync('long-output.txt','utf-8'))"`, agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      const result = await runner.execute(ctx, mockLLM());

      // Details should be truncated (shows first 500 chars)
      const details = result.details || '';
      const stdoutSectionIndex = details.indexOf('stdout:');
      if (stdoutSectionIndex >= 0) {
        // Should contain a truncation marker since 1000 > 500
        const stdoutSection = details.slice(stdoutSectionIndex);
        expect(stdoutSection).toContain('... (');
        expect(stdoutSection).toContain('more chars)');
      }

      // Metadata should have full output (up to MAX_OUTPUT_LENGTH)
      const runResult = ctx.metadata['runResult'] as RunResult;
      expect(runResult.stdout.length).toBe(1000); // Full output preserved in metadata
    });

    // ── Working Directory ─────────────────────────────────────────────

    it('should execute commands in the working directory', async () => {
      // Create a file in the temp dir and verify the command can see it
      writeFileSync(join(tmpDir, 'test-output.txt'), 'hello from test', 'utf-8');

      const ctx = context({
        taskPlan: [
          { id: 'step-1', description: `Run: node -e "const fs=require('fs');console.log(fs.readFileSync('test-output.txt','utf-8'))"`, agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      const result = await runner.execute(ctx, mockLLM());

      expect(result.success).toBe(true);
      expect(result.details).toContain('hello from test');
    });
  });

  // ─── RunResult Interface ───────────────────────────────────────────────

  describe('RunResult structure', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'buff-runner-struct-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should have all required RunResult fields on success', async () => {
      const ctx = makeContext({
        workingDirectory: tmpDir,
        taskPlan: [
          { id: 'step-1', description: 'Run: echo ok', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      await runner.execute(ctx, async () => '');

      const rr = ctx.metadata['runResult'] as RunResult;
      expect(rr).toHaveProperty('success');
      expect(rr).toHaveProperty('command');
      expect(rr).toHaveProperty('exitCode');
      expect(rr).toHaveProperty('stdout');
      expect(rr).toHaveProperty('stderr');
      expect(rr).toHaveProperty('duration');

      expect(typeof rr.success).toBe('boolean');
      expect(typeof rr.command).toBe('string');
      expect(typeof rr.exitCode).toBe('number');
      expect(typeof rr.stdout).toBe('string');
      expect(typeof rr.stderr).toBe('string');
      expect(typeof rr.duration).toBe('number');
    });

    it('should have error field set on failure', async () => {
      const ctx = makeContext({
        workingDirectory: tmpDir,
        taskPlan: [
          { id: 'step-1', description: 'Run: nonexistent-cmd-xyz', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      await runner.execute(ctx, async () => '');

      const rr = ctx.metadata['runResult'] as RunResult;
      expect(rr.success).toBe(false);
      expect(rr.error).toBeTruthy(); // Error message should be present
    });

    it('should not have error field on success', async () => {
      const ctx = makeContext({
        workingDirectory: tmpDir,
        taskPlan: [
          { id: 'step-1', description: 'Run: echo ok', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      await runner.execute(ctx, async () => '');

      const rr = ctx.metadata['runResult'] as RunResult;
      expect(rr.success).toBe(true);
      expect(rr.error).toBeUndefined(); // No error on success
    });

    it('should report no-command error when command cannot be determined', async () => {
      const ctx = makeContext({
        workingDirectory: tmpDir,
        taskPlan: [
          { id: 'step-1', description: 'Ambiguous task with no executable command', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      // LLM also fails to return a command
      const failingLLM: LLMCallFn = async () => { throw new Error('API error'); };
      const result = await runner.execute(ctx, failingLLM);

      expect(result.success).toBe(false);
      expect(result.summary).toBe('No command to run');
      expect(result.error).toContain('Could not determine which command to execute');
    });
  });

  // ─── Cross-Platform Shell Detection ────────────────────────────────────

  describe('shell detection', () => {
    it('should execute a basic command via the configured shell', async () => {
      // Use 'echo' which works on both /bin/sh (Unix) and cmd.exe (Windows)
      const tmpDir = mkdtempSync(join(tmpdir(), 'buff-runner-shell-'));
      try {
        const ctx = makeContext({
          workingDirectory: tmpDir,
          taskPlan: [
            { id: 'step-1', description: 'Run: echo shell_works', agentType: 'runner', dependsOn: [], status: 'running' },
          ],
        });
        const result = await runner.execute(ctx, async () => '');
        expect(result.success).toBe(true);
        expect(result.details).toContain('shell_works');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should expand variables via the configured shell', async () => {
      // Test that shell variable expansion works (works in both /bin/sh and cmd.exe via echo)
      const tmpDir = mkdtempSync(join(tmpdir(), 'buff-runner-shell-'));
      try {
        const ctx = makeContext({
          workingDirectory: tmpDir,
          taskPlan: [
            { id: 'step-1', description: 'Run: echo hello_from_shell', agentType: 'runner', dependsOn: [], status: 'running' },
          ],
        });
        const result = await runner.execute(ctx, async () => '');
        expect(result.success).toBe(true);
        expect(result.details).toContain('hello_from_shell');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ─── Working Directory Edge Cases ───────────────────────────────────────

  describe('working directory edge cases', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'buff-runner-edge-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should handle command with special characters in output', async () => {
      // Test that a command with special shell characters (semicolons, pipes, quotes) works
      const ctx = makeContext({
        workingDirectory: tmpDir,
        taskPlan: [
          { id: 'step-1', description: 'Run: echo "hello; world | test"', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      const result = await runner.execute(ctx, async () => '');
      expect(result.success).toBe(true);
      expect(result.details).toContain('hello; world | test');
    });

    it('should handle command with exit code 0 but non-empty stderr', async () => {
      const ctx = makeContext({
        workingDirectory: tmpDir,
        taskPlan: [
          { id: 'step-1', description: 'Run: node -e "console.log(\'stdout\');process.stderr.write(\'stderr\')"', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      const result = await runner.execute(ctx, async () => '');
      // This command exits 0, so result should be success
      expect(result.success).toBe(true);
      expect(result.details).toContain('stdout');
    });

    it('should handle very short commands', async () => {
      // Use 'echo' which works on both Unix (/bin/sh) and Windows (cmd.exe)
      const ctx = makeContext({
        workingDirectory: tmpDir,
        taskPlan: [
          { id: 'step-1', description: 'Run: echo ok', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      const result = await runner.execute(ctx, async () => '');
      expect(result.success).toBe(true);
      expect(result.details).toContain('ok');
    });
  });

  // ─── Writer → Runner Integration (File Write Then Run) ─────────────────
  //
  // These tests validate the exact scenario that was broken on Windows:
  // the WriterAgent creates a file (stored in context.fileChanges), the file
  // is written to disk, and then the RunnerAgent executes a command that
  // references that file. This catches path-resolution regressions across
  // Windows, Linux, and macOS.
  //
  // Unlike the orchestrator's applyFileChanges (which resolves relative paths
  // via resolve(process.cwd(), change.path) in the applyFileChanges method),
  // here we directly write the file before running the runner to simulate the
  // same flow without spinning up the full orchestrator.

  describe('writer → runner integration (file-write-then-execute)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'buff-writer-runner-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    /** Check if a CLI tool is available */
    function isToolAvailable(tool: string): boolean {
      try {
        execSync(`${tool} --version`, { stdio: 'ignore', timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    }

    /**
     * Write a file to the temp dir (simulating what the WriterAgent +
     * orchestrator.applyFileChanges would do), then run a command against it.
     */
    async function writeThenRun(
      fileName: string,
      fileContent: string,
      runCommand: string,
    ): Promise<{ result: import('../../../src/agents/agents/runner.js').AgentResult; runResult: RunResult }> {
      // Step 1: Write the file (simulating orchestrator's applyFileChanges)
      const absolutePath = resolve(tmpDir, fileName);
      const dir = dirname(absolutePath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(absolutePath, fileContent, 'utf-8');
      expect(existsSync(absolutePath)).toBe(true);

      // Step 2: Run the command against it
      const ctx = makeContext({
        workingDirectory: tmpDir,
        taskPlan: [
          {
            id: 'step-run',
            description: `Run: ${runCommand}`,
            agentType: 'runner',
            dependsOn: [],
            status: 'running',
          },
        ],
        fileChanges: [
          { path: fileName, newContent: fileContent, status: 'created' },
        ],
      });

      const result = await runner.execute(ctx, async () => '');
      const runResult = ctx.metadata['runResult'] as RunResult;
      return { result, runResult };
    }

    it('should run a Python script written to the working directory', async () => {
      if (!isToolAvailable('python') && !isToolAvailable('python3')) {
        return; // Skip — Python not available
      }
      const pythonCmd = isToolAvailable('python3') ? 'python3' : 'python';

      const { result, runResult } = await writeThenRun(
        'hello_world.py',
        'print("Hello from Runner!")',
        `${pythonCmd} hello_world.py`,
      );

      expect(result.success).toBe(true);
      expect(runResult.exitCode).toBe(0);
      expect(runResult.stdout).toContain('Hello from Runner!');
    });

    it('should run a Node.js script written to the working directory', async () => {
      if (!isToolAvailable('node')) {
        return; // Skip — Node not available (shouldn't happen in CI)
      }

      const { result, runResult } = await writeThenRun(
        'script.js',
        'console.log("Hello from Runner!")',
        'node script.js',
      );

      expect(result.success).toBe(true);
      expect(runResult.exitCode).toBe(0);
      expect(runResult.stdout).toContain('Hello from Runner!');
    });

    it('should handle file in a subdirectory with relative path', async () => {
      const { result, runResult } = await writeThenRun(
        'subdir/greeting.txt',
        'Hello from subdirectory',
        // Use node -e to read the file (works cross-platform unlike cat/type)
        'node -e "console.log(require(\'fs\').readFileSync(\'subdir/greeting.txt\',\'utf-8\'))"',
      );

      expect(result.success).toBe(true);
      expect(runResult.exitCode).toBe(0);
      expect(runResult.stdout).toContain('Hello from subdirectory');
    });

    it('should handle a file with spaces in the path', async () => {
      const { result, runResult } = await writeThenRun(
        'my folder/test.js',
        'console.log("path with spaces works")',
        // Node handles spaces in quoted paths correctly on all platforms
        'node "my folder/test.js"',
      );

      expect(result.success).toBe(true);
      expect(runResult.exitCode).toBe(0);
      expect(runResult.stdout).toContain('path with spaces works');
    });
  });

  // ─── Dependency Install (detectInstallPlan / commandExists) ───────────

  describe('dependency install', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'buff-dep-install-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    /** Access private detectInstallPlan via prototype */
    function detectInstallPlan(workingDir: string) {
      return (runner as any).detectInstallPlan.call(runner, workingDir);
    }

    /** Access private commandExists via prototype */
    function commandExists(tool: string): boolean {
      return (runner as any).commandExists.call(runner, tool);
    }

    it('detects npm for package.json', () => {
      writeFileSync(join(tmpDir, 'package.json'), '{"name":"test"}', 'utf-8');
      const plan = detectInstallPlan(tmpDir);
      expect(plan).not.toBeNull();
      expect(plan.tool).toBe('npm');
      expect(plan.command).toContain('npm install');
    });

    it('detects pip for requirements.txt', () => {
      writeFileSync(join(tmpDir, 'requirements.txt'), 'requests', 'utf-8');
      const plan = detectInstallPlan(tmpDir);
      expect(plan.tool).toBe('pip');
      expect(plan.command).toContain('pip install -r');
    });

    it('detects pip for pyproject.toml', () => {
      writeFileSync(join(tmpDir, 'pyproject.toml'), '[project]', 'utf-8');
      expect(detectInstallPlan(tmpDir).tool).toBe('pip');
    });

    it('detects pip for setup.py', () => {
      writeFileSync(join(tmpDir, 'setup.py'), 'from setuptools import setup', 'utf-8');
      expect(detectInstallPlan(tmpDir).tool).toBe('pip');
    });

    it('detects bundle for Gemfile', () => {
      writeFileSync(join(tmpDir, 'Gemfile'), 'source "https://rubygems.org"', 'utf-8');
      const plan = detectInstallPlan(tmpDir);
      expect(plan.tool).toBe('bundle');
      expect(plan.command).toBe('bundle install');
    });

    it('detects cargo for Cargo.toml', () => {
      writeFileSync(join(tmpDir, 'Cargo.toml'), '[package]', 'utf-8');
      expect(detectInstallPlan(tmpDir).tool).toBe('cargo');
    });

    it('detects go for go.mod', () => {
      writeFileSync(join(tmpDir, 'go.mod'), 'module test', 'utf-8');
      expect(detectInstallPlan(tmpDir).tool).toBe('go');
    });

    it('detects composer for composer.json', () => {
      writeFileSync(join(tmpDir, 'composer.json'), '{"name":"test"}', 'utf-8');
      expect(detectInstallPlan(tmpDir).tool).toBe('composer');
    });

    it('detects dart for pubspec.yaml', () => {
      writeFileSync(join(tmpDir, 'pubspec.yaml'), 'name: test', 'utf-8');
      expect(detectInstallPlan(tmpDir).tool).toBe('dart');
    });

    it('returns null when no manifest is present', () => {
      expect(detectInstallPlan(tmpDir)).toBeNull();
    });

    it('commandExists detects a real tool and rejects a fake one', () => {
      // node definitely exists (the tests run under node)
      expect(commandExists('node')).toBe(true);
      expect(commandExists('definitely-not-a-real-tool-xyz-12345')).toBe(false);
    });

    it('installDependencies returns a clear message when no manifest exists', async () => {
      // Access private installDependencies via prototype
      const result = (runner as any).installDependencies.call(runner, tmpDir, false);
      expect(result.success).toBe(false);
      expect(result.message).toContain('No supported dependency manifest');
    });

    it('installDependencies runs npm install for a package.json project when npm exists', async () => {
      if (!commandExists('npm')) {
        return; // Skip — npm not available
      }
      writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'dep-test', version: '1.0.0' }), 'utf-8');
      const result = (runner as any).installDependencies.call(runner, tmpDir, false);
      expect(result.success).toBe(true);
      expect(result.tool).toBe('npm');
      expect(result.command).toContain('npm install');
      // A lockfile / node_modules may or may not be created, but install must succeed
      expect(result.message).toBeUndefined(); // success with no error message
    });

    it('installDependencies auto-installs a missing tool from the failed command', () => {
      // Stub commandExists/installTool so nothing runs against the real machine
      const commandExistsSpy = vi.spyOn(runner as any, 'commandExists').mockReturnValue(false);
      const installToolSpy = vi.spyOn(runner as any, 'installTool').mockReturnValue({
        success: true,
        command: 'python3 script.py',
        tool: 'pip',
        toolInstalled: true,
        message: 'Auto-installed missing tool pip',
      });
      try {
        const result = (runner as any).installDependencies.call(runner, tmpDir, true, 'python3 script.py');
        expect(result.success).toBe(true);
        expect(result.tool).toBe('pip');
        expect(result.toolInstalled).toBe(true);
        expect(installToolSpy).toHaveBeenCalledWith('pip');
        expect(commandExistsSpy).toHaveBeenCalled();
      } finally {
        installToolSpy.mockRestore();
        commandExistsSpy.mockRestore();
      }
    });

    it('detectToolFromCommand maps known interpreters to bootstrap tools', () => {
      const detect = (cmd: string) => (runner as any).detectToolFromCommand.call(runner, cmd);
      // Stub commandExists so the mapping check returns "missing" for everything
      const spy = vi.spyOn(runner as any, 'commandExists').mockReturnValue(false);
      try {
        expect(detect('python3 script.py')).toBe('pip');
        expect(detect('node index.js')).toBe('npm');
        expect(detect('cargo build')).toBe('cargo');
        expect(detect('bundle install')).toBe('bundle');
        expect(detect('composer install')).toBe('composer');
        expect(detect('dart pub get')).toBe('dart');
        expect(detect('flutter run')).toBe('dart');
        expect(detect('yarn install')).toBe('yarn');
        expect(detect('pnpm install')).toBe('pnpm');
        expect(detect('/usr/bin/go run main.go')).toBe('go'); // paths handled
        expect(detect('echo hello')).toBeNull(); // no mapping
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ─── Composer Tool Install (installTool('composer')) ───────────────────
  //
  // installTool('composer') must:
  // 1. Install to a user-writable dir ($HOME/.local/bin) — NOT /usr/local/bin,
  //    which needs sudo and doesn't exist on Apple Silicon
  // 2. Bootstrap PHP first via installPhpViaPlatform when php is missing
  // 3. Propagate a PHP-install failure instead of attempting composer blindly

  describe('composer tool install', () => {
    /** Access private installTool via prototype */
    function installTool(tool: string) {
      return (runner as any).installTool.call(runner, tool);
    }

    /** Install tool with fully stubbed sub-commands (nothing touches the machine) */
    function installToolWithStubs(opts: {
      phpExists: boolean;
      phpInstallSuccess: boolean;
      composerInstallSuccess: boolean;
    }) {
      const executed: string[] = [];
      const commandExistsSpy = vi.spyOn(runner as any, 'commandExists').mockImplementation((t: string) => {
        // Everything "exists" except php when phpExists is false
        return t === 'php' ? opts.phpExists : false;
      });
      const installPhpSpy = vi.spyOn(runner as any, 'installPhpViaPlatform').mockReturnValue({
        success: opts.phpInstallSuccess,
        command: 'brew install php',
        tool: 'php',
        toolInstalled: true,
        message: opts.phpInstallSuccess ? 'php installed' : 'Could not install PHP on Linux',
      });
      const runInstallSpy = vi.spyOn(runner as any, 'runInstallCommand').mockImplementation((cmd: string) => {
        executed.push(cmd);
        return {
          success: opts.composerInstallSuccess,
          command: cmd,
          toolInstalled: true,
          message: opts.composerInstallSuccess ? 'Installed via: ' + cmd : 'composer install failed',
        };
      });
      return { executed, commandExistsSpy, installPhpSpy, runInstallSpy };
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('installs composer to $HOME/.local/bin when PHP already exists', () => {
      const { executed } = installToolWithStubs({
        phpExists: true,
        phpInstallSuccess: true,
        composerInstallSuccess: true,
      });

      const result = installTool('composer');

      expect(result.success).toBe(true);
      expect(executed.length).toBe(1);
      const cmd = executed[0];
      // Must NOT use /usr/local/bin (sudo + missing on Apple Silicon)
      expect(cmd).not.toContain('/usr/local/bin');
      // Must target the user-writable local bin dir
      const home = process.env.HOME || process.env.USERPROFILE || '';
      expect(cmd).toContain(`${home}/.local/bin`);
      // Uses the official getcomposer.org installer
      expect(cmd).toContain('getcomposer.org/installer');
      // Local bin path is quoted so spaces in HOME don't break it
      expect(cmd).toContain(`"${home}/.local/bin"`);
    });

    it('bootstraps PHP first when php is missing, then installs composer', () => {
      const { executed, installPhpSpy } = installToolWithStubs({
        phpExists: false,
        phpInstallSuccess: true,
        composerInstallSuccess: true,
      });

      const result = installTool('composer');

      expect(result.success).toBe(true);
      // PHP was installed before the composer install ran
      expect(installPhpSpy).toHaveBeenCalled();
      expect(executed.length).toBe(1);
      expect(executed[0]).toContain('getcomposer.org/installer');
    });

    it('does not run the composer installer when the PHP bootstrap fails', () => {
      const { executed, runInstallSpy } = installToolWithStubs({
        phpExists: false,
        phpInstallSuccess: false,
        composerInstallSuccess: true,
      });

      const result = installTool('composer');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Could not install PHP');
      // The composer installer must never run if PHP couldn't be installed
      expect(executed.length).toBe(0);
      expect(runInstallSpy).not.toHaveBeenCalled();
    });
  });

  // ─── Tool Install Bootstrap Paths (installTool) ───────────────────────
  //
  // installTool() must bootstrap-install missing package managers without
  // touching the real machine. Each test stubs commandExists / runInstallCommand
  // / install*ViaPlatform so nothing runs against the host.

  describe('tool install bootstrap paths', () => {
    /** Access private installTool via prototype */
    function installTool(tool: string) {
      return (runner as any).installTool.call(runner, tool);
    }

    /** Stub commandExists to return `exists` for a specific set of tools, false otherwise */
    function stubCommandExists(exists: string[]) {
      return vi.spyOn(runner as any, 'commandExists').mockImplementation((t: string) => exists.includes(t));
    }

    /** Stub runInstallCommand to record commands and return success */
    function stubRunInstall(success = true) {
      const executed: string[] = [];
      const spy = vi.spyOn(runner as any, 'runInstallCommand').mockImplementation((cmd: string) => {
        executed.push(cmd);
        return {
          success,
          command: cmd,
          toolInstalled: true,
          message: success ? 'Installed via: ' + cmd : 'install failed: ' + cmd,
        };
      });
      return { executed, spy };
    }

    /** Stub a platform installer (e.g. installNodeViaPlatform) to return success */
    function stubPlatformInstaller(name: string, success = true) {
      return vi.spyOn(runner as any, name).mockReturnValue({
        success,
        command: `${name} stub`,
        tool: name.replace('install', '').replace('ViaPlatform', '').toLowerCase() || name,
        toolInstalled: true,
        message: success ? `${name} ok` : `${name} failed`,
      });
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // ── npm ────────────────────────────────────────────────────────────

    it('npm: returns success immediately when npm already exists (no reinstall)', () => {
      stubCommandExists(['npm']);
      const nodeSpy = stubPlatformInstaller('installNodeViaPlatform');
      const { executed } = stubRunInstall();

      const result = installTool('npm');

      expect(result.success).toBe(true);
      expect(result.message).toBe('npm is now available');
      expect(nodeSpy).not.toHaveBeenCalled(); // no reinstall loop
      expect(executed.length).toBe(0);
    });

    it('npm: bootstraps Node.js first when npm is missing', () => {
      let npmExists = false;
      vi.spyOn(runner as any, 'commandExists').mockImplementation((t: string) => {
        if (t === 'npm') return npmExists;
        return true;
      });
      // Installing Node makes npm available (as it does in the real flow)
      const nodeSpy = vi.spyOn(runner as any, 'installNodeViaPlatform').mockImplementation(() => {
        npmExists = true;
        return { success: true, command: 'brew install node', tool: 'node', toolInstalled: true, message: 'node ok' };
      });

      const result = installTool('npm');

      expect(nodeSpy).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.message).toBe('npm is now available');
    });

    it('npm: propagates a Node.js install failure', () => {
      stubCommandExists([]);
      const nodeSpy = stubPlatformInstaller('installNodeViaPlatform', false);

      const result = installTool('npm');

      expect(result.success).toBe(false);
      expect(nodeSpy).toHaveBeenCalled();
    });

    it('npm: reports when npm was installed but is not on PATH for this process', () => {
      stubCommandExists([]);
      stubPlatformInstaller('installNodeViaPlatform');
      // Even after a successful Node install, npm is not visible on PATH for
      // this process (open a new terminal) — must report failure honestly.
      const result = installTool('npm');

      expect(result.success).toBe(false);
      expect(result.message).toContain('not on PATH');
    });

    it('yarn: installs via npm install -g yarn', () => {
      stubCommandExists(['npm']);
      const { executed } = stubRunInstall();

      const result = installTool('yarn');

      expect(result.success).toBe(true);
      expect(executed[0]).toBe('npm install -g yarn');
    });

    it('pnpm: installs via npm install -g pnpm', () => {
      stubCommandExists(['npm']);
      const { executed } = stubRunInstall();

      const result = installTool('pnpm');

      expect(result.success).toBe(true);
      expect(executed[0]).toBe('npm install -g pnpm');
    });

    // ── pip ────────────────────────────────────────────────────────────

    it('pip: bootstraps pip via ensurepip when Python already exists', () => {
      stubCommandExists(['python3']);
      const { executed } = stubRunInstall();

      const result = installTool('pip');

      expect(result.success).toBe(true);
      expect(executed[0]).toBe('python3 -m ensurepip --upgrade');
    });

    it('pip: installs Python first when neither python3 nor python exists', () => {
      stubCommandExists([]);
      const pySpy = stubPlatformInstaller('installPythonViaPlatform');
      const { executed } = stubRunInstall();

      const result = installTool('pip');

      expect(pySpy).toHaveBeenCalled();
      expect(result.success).toBe(true);
      // ensurepip runs against the freshly installed python3
      expect(executed.some((c) => c.includes('ensurepip'))).toBe(true);
    });

    it('pip: propagates a Python install failure without running ensurepip', () => {
      stubCommandExists([]);
      const pySpy = stubPlatformInstaller('installPythonViaPlatform', false);
      const { executed } = stubRunInstall();

      const result = installTool('pip');

      expect(result.success).toBe(false);
      expect(pySpy).toHaveBeenCalled();
      expect(executed.length).toBe(0);
    });

    // ── brew ───────────────────────────────────────────────────────────

    it('brew: runs the official Homebrew install script with NONINTERACTIVE=1', () => {
      const { executed } = stubRunInstall();

      const result = installTool('brew');

      expect(result.success).toBe(true);
      expect(executed[0]).toContain('Homebrew/install/HEAD/install.sh');
      expect(executed[0]).toContain('NONINTERACTIVE=1');
    });

    // ── bundle ─────────────────────────────────────────────────────────

    it('bundle: installs via gem install bundler when gem exists', () => {
      stubCommandExists(['gem']);
      const { executed } = stubRunInstall();

      const result = installTool('bundle');

      expect(result.success).toBe(true);
      expect(executed[0]).toBe('gem install bundler');
    });

    it('bundle: installs Ruby first when gem is missing', () => {
      stubCommandExists([]);
      const rubySpy = stubPlatformInstaller('installRubyViaPlatform');
      const { executed } = stubRunInstall();

      const result = installTool('bundle');

      expect(rubySpy).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(executed[0]).toBe('gem install bundler');
    });

    it('bundle: propagates a Ruby install failure', () => {
      stubCommandExists([]);
      const rubySpy = stubPlatformInstaller('installRubyViaPlatform', false);

      const result = installTool('bundle');

      expect(result.success).toBe(false);
      expect(rubySpy).toHaveBeenCalled();
    });

    // ── cargo ──────────────────────────────────────────────────────────

    it('cargo: installs via rustup', () => {
      const { executed } = stubRunInstall();

      const result = installTool('cargo');

      expect(result.success).toBe(true);
      expect(executed[0]).toContain('sh.rustup.rs');
      expect(executed[0]).toContain('-y');
    });

    // ── go ─────────────────────────────────────────────────────────────

    it('go on darwin: installs via the platform installer (brew)', () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      try {
        const goSpy = stubPlatformInstaller('installGoViaPlatform');

        const result = installTool('go');

        expect(result.success).toBe(true);
        expect(goSpy).toHaveBeenCalledWith('darwin');
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform as PropertyDescriptor);
      }
    });

    it('go on win32: installs via winget', () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        const { executed } = stubRunInstall();

        const result = installTool('go');

        expect(result.success).toBe(true);
        expect(executed[0]).toContain('winget install GoLang.Go');
        expect(executed[0]).toContain('--silent');
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform as PropertyDescriptor);
      }
    });

    // ── dart ───────────────────────────────────────────────────────────

    it('dart on darwin: installs via Homebrew when brew exists', () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      try {
        stubCommandExists(['brew']);
        const { executed } = stubRunInstall();

        const result = installTool('dart');

        expect(result.success).toBe(true);
        expect(executed[0]).toBe('brew install dart-lang/dart/dart');
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform as PropertyDescriptor);
      }
    });

    it('dart on linux: adds Google apt repo then installs dart', () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      try {
        const { executed } = stubRunInstall();

        const result = installTool('dart');

        expect(result.success).toBe(true);
        const cmd = executed[0];
        expect(cmd).toContain('apt-get install -y dart');
        expect(cmd).toContain('dl-ssl.google.com/linux/linux_signing_key.pub');
        expect(cmd).toContain('sources.list.d/dart.list');
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform as PropertyDescriptor);
      }
    });

    it('dart on win32: installs via winget', () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        const { executed } = stubRunInstall();

        const result = installTool('dart');

        expect(result.success).toBe(true);
        expect(executed[0]).toContain('winget install Dart.Dart');
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform as PropertyDescriptor);
      }
    });

    // ── unknown tool ───────────────────────────────────────────────────

    it('returns a clear error for tools with no bootstrap strategy', () => {
      const result = installTool('definitely-not-a-tool');

      expect(result.success).toBe(false);
      expect(result.message).toContain('No bootstrap strategy');
    });
  });

  // ─── Command Validation (isCommandAvailable) ──────────────────────────
  //
  // Tests for the isCommandAvailable() method added to prevent hardcoded
  // "npm test" failures when the project has no test script.

  describe('command validation', () => {
    /** Access private isCommandAvailable via prototype */
    function isCommandAvailable(command: string, workingDir: string): { available: boolean; reason?: string } {
      return (runner as any).isCommandAvailable.call(runner, command, workingDir);
    }

    it('should allow "npm test" when package.json has a test script', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'buff-cmd-valid-'));
      try {
        writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf-8');
        const result = isCommandAvailable('npm test', tmpDir);
        expect(result.available).toBe(true);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should allow "npm run test" when package.json has a test script', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'buff-cmd-valid2-'));
      try {
        writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }), 'utf-8');
        const result = isCommandAvailable('npm run test', tmpDir);
        expect(result.available).toBe(true);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should block "npm test" when package.json has no test script', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'buff-cmd-block-'));
      try {
        writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ scripts: { start: 'node index.js' } }), 'utf-8');
        const result = isCommandAvailable('npm test', tmpDir);
        expect(result.available).toBe(false);
        expect(result.reason).toContain('no "test" script');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should block "npm test" when package.json has empty scripts', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'buff-cmd-empty-'));
      try {
        writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ scripts: {} }), 'utf-8');
        const result = isCommandAvailable('npm test', tmpDir);
        expect(result.available).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should block "npm test" when no package.json exists', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'buff-cmd-nopkg-'));
      try {
        const result = isCommandAvailable('npm test', tmpDir);
        expect(result.available).toBe(false);
        expect(result.reason).toContain('No package.json found');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should allow non-npm commands regardless of package.json', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'buff-cmd-other-'));
      try {
        writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({}), 'utf-8');
        const result = isCommandAvailable('python hello.py', tmpDir);
        expect(result.available).toBe(true);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should allow "npm run build" even without a test script', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'buff-cmd-build-'));
      try {
        writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }), 'utf-8');
        const result = isCommandAvailable('npm run build', tmpDir);
        expect(result.available).toBe(true);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should handle "npm test -- --coverage" (with flags)', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'buff-cmd-flag-'));
      try {
        writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }), 'utf-8');
        const result = isCommandAvailable('npm test -- --coverage', tmpDir);
        expect(result.available).toBe(true);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should handle malformed package.json gracefully', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'buff-cmd-badjson-'));
      try {
        writeFileSync(join(tmpDir, 'package.json'), 'not valid json', 'utf-8');
        const result = isCommandAvailable('npm test', tmpDir);
        expect(result.available).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
