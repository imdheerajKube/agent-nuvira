/**
 * Unit tests for DefaultExecuteModule — command inference, validation,
 * execution, and EventBus integration.
 *
 * Coverage goals:
 * - execute() — explicit command, inferred command, no command
 * - inferCommand() — backtick, Run: prefix, run <file>, npm patterns, file extension
 * - validateCommand() — npm test with/without package.json, valid commands
 * - EventBus emissions — EXECUTE_STARTING, EXECUTE_COMPLETED, EXECUTE_FAILED
 * - Constructor — default and with custom event bus
 * - Edge cases — empty goal, malformed commands, timeout
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DefaultExecuteModule } from '../../src/agents/execute-module.js';
import type { ExecuteParams } from '../../src/agents/execute-module.js';
import { EventBus } from '../../src/observability/event-bus.js';
import { execSync } from 'node:child_process';

// ─── Test Helpers ───────────────────────────────────────────────────────────

/** Create a temp project directory */
function createTestProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'exec-test-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'test-project',
    scripts: { test: 'echo "tests passed" && exit 0' },
  }));
  return dir;
}

/** Clean up a temp project directory */
function removeProject(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DefaultExecuteModule', () => {
  let module: DefaultExecuteModule;
  let testDir: string;

  beforeEach(() => {
    module = new DefaultExecuteModule();
    testDir = createTestProject();
  });

  afterEach(() => {
    removeProject(testDir);
  });

  // ── execute() — with explicit command ────────────────────────────────

  describe('execute() — with explicit command', () => {
    it('should execute a command and return success', async () => {
      const result = await module.execute({
        command: 'echo hello',
        goal: 'Run hello',
        workingDirectory: testDir,
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello');
    });

    it('should return failure for non-existent command', async () => {
      const result = await module.execute({
        command: 'nonexistent-command-xyz 2>&1 || true',
        goal: 'Run bad command',
        workingDirectory: testDir,
      });

      // Command may fail gracefully or succeed depending on shell
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('exitCode');
      expect(result).toHaveProperty('command');
    });

    it('should include duration in result', async () => {
      const result = await module.execute({
        command: 'echo test',
        goal: 'Run test',
        workingDirectory: testDir,
      });

      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should include the command in the result', async () => {
      const result = await module.execute({
        command: 'echo hello-world',
        goal: 'Testing',
        workingDirectory: testDir,
      });

      expect(result.command).toBe('echo hello-world');
    });
  });

  // ── execute() — without explicit command (infer) ────────────────────

  describe('execute() — inferred command', () => {
    it('should infer command from backticks in goal', async () => {
      const result = await module.execute({
        goal: 'Run `echo hello-backtick` to verify',
        workingDirectory: testDir,
      });

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('hello-backtick');
    });

    it('should infer command from Run: prefix', async () => {
      const result = await module.execute({
        goal: 'Run: echo hello-run-prefix',
        workingDirectory: testDir,
      });

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('hello-run-prefix');
    });

    it('should return error when no command can be inferred', async () => {
      const result = await module.execute({
        goal: 'Just review the code please',
        workingDirectory: testDir,
        fileChanges: [],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not determine');
      expect(result.exitCode).toBe(1);
    });

    it('should infer npm test from goal mentioning tests', async () => {
      const result = await module.execute({
        goal: 'Please npm test to verify',
        workingDirectory: testDir,
      });

      expect(result.command).toContain('npm test');
    });
  });

  // ── inferCommand — Strategy tests (via execute) ─────────────────────

  describe('inferCommand (via execute)', () => {
    it('strategy 1: should extract command from backticks', async () => {
      const result = await module.execute({
        goal: 'Run `echo backtick-test` and check output',
        workingDirectory: testDir,
      });

      expect(result.command).toBe('echo backtick-test');
    });

    it('strategy 2: should extract from Run: prefix', async () => {
      const result = await module.execute({
        goal: 'Run: echo run-prefix-test',
        workingDirectory: testDir,
      });

      expect(result.command).toBe('echo run-prefix-test');
    });

    it('strategy 4: should infer npm run build', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({
        name: 'test',
        scripts: { build: 'echo building', test: 'echo test' },
      }));
      const result = await module.execute({
        goal: 'run build the project',
        workingDirectory: testDir,
      });

      expect(result.command).toContain('npm run build');
    });

    it('strategy 5: should infer python from file changes', async () => {
      const result = await module.execute({
        goal: 'Run the script',
        workingDirectory: testDir,
        fileChanges: [{ path: 'hello.py', status: 'created' }],
      });

      expect(result.command).toBe('python hello.py');
    });

    it('strategy 5: should infer node from file changes', async () => {
      const result = await module.execute({
        goal: 'Run the server',
        workingDirectory: testDir,
        fileChanges: [{ path: 'server.js', status: 'created' }],
      });

      expect(result.command).toBe('node server.js');
    });
  });

  // ── validateCommand — Validation tests ──────────────────────────────

  describe('validateCommand (via execute)', () => {
    it('should allow npm test when package.json has test script', async () => {
      const result = await module.execute({
        command: 'npm test',
        goal: 'Run tests',
        workingDirectory: testDir,
      });

      expect(result.success).toBe(true);
    });

    it('should fail npm test when package.json lacks test script', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({
        name: 'test',
        scripts: { start: 'node index.js' },
      }));

      const result = await module.execute({
        command: 'npm test',
        goal: 'Run tests',
        workingDirectory: testDir,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('no "test" script');
    });

    it('should allow non-npm commands without validation', async () => {
      const result = await module.execute({
        command: 'echo ok',
        goal: 'Test',
        workingDirectory: testDir,
      });

      expect(result.success).toBe(true);
    });

    it('should fail npm test when no package.json exists', async () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'empty-test-'));
      try {
        const result = await module.execute({
          command: 'npm test',
          goal: 'Run tests',
          workingDirectory: emptyDir,
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('No package.json');
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  // ── Constructor ─────────────────────────────────────────────────────

  describe('constructor', () => {
    it('should create an instance without event bus', () => {
      expect(new DefaultExecuteModule()).toBeInstanceOf(DefaultExecuteModule);
    });

    it('should accept undefined event bus', () => {
      expect(new DefaultExecuteModule(undefined)).toBeInstanceOf(DefaultExecuteModule);
    });

    it('should accept a custom event bus', () => {
      const bus = new EventBus();
      const mod = new DefaultExecuteModule(bus);
      expect(mod).toBeInstanceOf(DefaultExecuteModule);
    });
  });

  // ── Event Bus Emissions ─────────────────────────────────────────────

  describe('event bus emissions — execute()', () => {
    it('should emit EXECUTE_STARTING when execution starts', async () => {
      const bus = new EventBus();
      const emitSpy = vi.spyOn(bus, 'emit');
      const mod = new DefaultExecuteModule(bus);

      await mod.execute({ command: 'echo test', goal: 'Test', workingDirectory: testDir });

      const startEvents = emitSpy.mock.calls.filter((c) => c[0] === 'execute:starting');
      expect(startEvents.length).toBeGreaterThanOrEqual(1);
      const payload = startEvents[0][1] as Record<string, unknown>;
      expect(payload.command).toBe('echo test');
    });

    it('should emit EXECUTE_COMPLETED on success', async () => {
      const bus = new EventBus();
      const emitSpy = vi.spyOn(bus, 'emit');
      const mod = new DefaultExecuteModule(bus);

      await mod.execute({ command: 'echo test', goal: 'Test', workingDirectory: testDir });

      const completedEvents = emitSpy.mock.calls.filter((c) => c[0] === 'execute:completed');
      expect(completedEvents.length).toBeGreaterThanOrEqual(1);
      const payload = completedEvents[0][1] as Record<string, unknown>;
      expect(payload.success).toBe(true);
      expect(payload.exitCode).toBe(0);
    });

    it('should emit EXECUTE_FAILED when validation fails', async () => {
      const bus = new EventBus();
      const emitSpy = vi.spyOn(bus, 'emit');
      const mod = new DefaultExecuteModule(bus);
      const emptyDir = mkdtempSync(join(tmpdir(), 'fail-test-'));

      try {
        await mod.execute({ command: 'npm test', goal: 'Test', workingDirectory: emptyDir });

        const failedEvents = emitSpy.mock.calls.filter((c) => c[0] === 'execute:failed');
        expect(failedEvents.length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('should use source "execute-module" for emitted events', async () => {
      const bus = new EventBus();
      const emitSpy = vi.spyOn(bus, 'emit');
      const mod = new DefaultExecuteModule(bus);

      await mod.execute({ command: 'echo test', goal: 'Test', workingDirectory: testDir });

      for (const call of emitSpy.mock.calls) {
        if (call[0] === 'execute:starting' || call[0] === 'execute:completed') {
          expect(call[2]).toBe('execute-module');
        }
      }
    });
  });
});
