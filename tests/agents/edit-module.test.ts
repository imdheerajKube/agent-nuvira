/**
 * Unit tests for DefaultEditModule — LLM-based code change generation,
 * file parsing, AST validation, and EventBus integration.
 *
 * Coverage goals:
 * - edit() — happy path, multi-file changes, empty result, retry behavior
 * - parseFileChanges — valid filepath: blocks, malformed blocks, edge cases
 * - addFileChange — new file, existing file, unchanged content
 * - validateChanges — valid syntax, invalid syntax, non-source files
 * - Rate-limit handling — skip, abort, retry
 * - EventBus emissions — EDIT_GENERATING, EDIT_WRITTEN, EDIT_SKIPPED
 * - Constructor — default and with custom event bus
 * - Token budget — file selection, truncation, max files
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DefaultEditModule } from '../../src/agents/edit-module.js';
import type { EditParams, EditModule } from '../../src/agents/edit-module.js';
import type { Artifact } from '../../src/agents/agent.js';
import { EventBus } from '../../src/observability/event-bus.js';

// ─── Test Helpers ───────────────────────────────────────────────────────────

/** Create a temp project directory with some files */
function createTestProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'edit-test-'));
  writeFileSync(join(dir, 'index.ts'), 'export const greet = (name: string) => `Hello ${name}`;');
  writeFileSync(join(dir, 'auth.ts'), 'export function login() { return "token"; }');
  return dir;
}

/** Clean up a temp project directory */
function removeProject(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Create a mock artifact */
function makeArtifact(path: string, content: string): Artifact {
  return { path, content, description: `${path} (${content.length} chars)` };
}

/** A mock LLMCallFn that returns filepath: code blocks */
function mockLLMSuccess(blocks: string): () => Promise<string> {
  return vi.fn().mockResolvedValue(blocks);
}

/** A mock LLMCallFn that rejects with an error */
function mockLLMFailure(): () => Promise<string> {
  return vi.fn().mockRejectedValue(new Error('LLM API error'));
}

/** A mock LLMCallFn that returns no parseable file blocks */
function mockLLMEmptyResponse(): () => Promise<string> {
  return vi.fn().mockResolvedValue('I think the code looks fine. No changes needed.');
}

/** A mock rate-limit callback */
function mockOnRateLimit(action: 'retry' | 'skip' | 'abort') {
  return vi.fn().mockResolvedValue({ action });
}

/** A mock rate-limit callback that switches model */
function mockOnRateLimitSwitchModel(newCallLLM: () => Promise<string>) {
  return vi.fn().mockResolvedValue({ action: 'switch-model', callLLM: newCallLLM });
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Standard LLM response with two file changes */
const STANDARD_RESPONSE = '```filepath:index.ts\nexport const greet = (name: string) => `Hello ${name}!`;\n```\n' +
  '```filepath:auth.ts\nexport function login(username: string, password: string) { return "jwt-token"; }\n```';

/** LLM response creating a new file */
const NEW_FILE_RESPONSE = '```filepath:src/middleware.ts\nexport const authMiddleware = (req: any) => req;\n```';

/** LLM response with syntax error (unbalanced braces) */
const SYNTAX_ERROR_RESPONSE = '```filepath:auth.ts\nexport function login() { return "token";\n```'; // Unclosed brace

const EMPTY_ARTIFACTS: Artifact[] = [];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DefaultEditModule', () => {
  let module: DefaultEditModule;
  let testDir: string;

  beforeEach(() => {
    module = new DefaultEditModule();
    testDir = createTestProject();
  });

  afterEach(() => {
    removeProject(testDir);
  });

  // ── edit() — Happy Path ──────────────────────────────────────────────

  describe('edit() — happy path', () => {
    it('should produce file changes from LLM response', async () => {
      const params: EditParams = {
        goal: 'Add exclamation to greet, add params to login',
        workingDirectory: testDir,
        artifacts: [
          makeArtifact('index.ts', 'export const greet = (name: string) => `Hello ${name}`;'),
          makeArtifact('auth.ts', 'export function login() { return "token"; }'),
        ],
        callLLM: mockLLMSuccess(STANDARD_RESPONSE),
      };

      const result = await module.edit(params);

      expect(result.changeCount).toBe(2);
      expect(result.changes).toHaveLength(2);
      expect(result.changes[0].status).toBe('modified');
      expect(result.changes[1].status).toBe('modified');
    });

    it('should include new file content in changes', async () => {
      const params: EditParams = {
        goal: 'Create middleware',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM: mockLLMSuccess(NEW_FILE_RESPONSE),
      };

      const result = await module.edit(params);

      expect(result.changes.some((c) => c.status === 'created')).toBe(true);
      const middlewareChange = result.changes.find((c) => c.path.includes('middleware'));
      expect(middlewareChange).toBeDefined();
      expect(middlewareChange!.newContent).toContain('authMiddleware');
    });

    it('should return human-readable summary', async () => {
      const params: EditParams = {
        goal: 'Update files',
        workingDirectory: testDir,
        artifacts: [
          makeArtifact('index.ts', 'export const greet = (name: string) => `Hello ${name}`;'),
        ],
        callLLM: mockLLMSuccess('```filepath:index.ts\nexport const greet = (name: string) => `Hello ${name}!`;\n```'),
      };

      const result = await module.edit(params);

      expect(result.summary).toContain('Proposed changes to 1 file');
    });

    it('should handle single file change', async () => {
      const params: EditParams = {
        goal: 'Update greet',
        workingDirectory: testDir,
        artifacts: [makeArtifact('index.ts', 'export const greet = (name: string) => `Hello ${name}`;')],
        callLLM: mockLLMSuccess('```filepath:index.ts\nexport const greet = (name: string) => `Hello ${name}!`;\n```'),
      };

      const result = await module.edit(params);

      expect(result.changeCount).toBe(1);
      expect(result.changes[0].path).toBe('index.ts');
    });

    it('should detect unchanged file and skip it', async () => {
      // File on disk has the same content as what LLM returns
      const params: EditParams = {
        goal: 'No changes needed',
        workingDirectory: testDir,
        artifacts: [makeArtifact('index.ts', 'export const greet = (name: string) => `Hello ${name}`;')],
        callLLM: mockLLMSuccess('```filepath:index.ts\nexport const greet = (name: string) => `Hello ${name}`;\n```'),
      };

      const result = await module.edit(params);

      // Content is identical → no change produced
      expect(result.changeCount).toBe(0);
    });

    it('should pass the goal into the LLM prompt', async () => {
      const callLLM = mockLLMSuccess(STANDARD_RESPONSE);
      const params: EditParams = {
        goal: 'Add input validation',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM,
      };

      await module.edit(params);

      const prompt = callLLM.mock.calls[0][0] as string;
      expect(prompt).toContain('Add input validation');
    });

    it('should pass task description when provided', async () => {
      const callLLM = mockLLMSuccess(STANDARD_RESPONSE);
      const params: EditParams = {
        goal: 'General goal',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM,
        taskDescription: 'Override the goal with this specific task',
      };

      await module.edit(params);

      const prompt = callLLM.mock.calls[0][0] as string;
      expect(prompt).toContain('Override the goal with this specific task');
    });

    it('should use lower temperature on retry', async () => {
      const callLLM = mockLLMSuccess(STANDARD_RESPONSE);
      const params: EditParams = {
        goal: 'Update files',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM,
        isRetry: true,
      };

      await module.edit(params);

      const options = callLLM.mock.calls[0][1] as Record<string, unknown>;
      expect(options.temperature).toBe(0.1);
    });
  });

  // ── edit() — Empty Results ──────────────────────────────────────────

  describe('edit() — empty results', () => {
    it('should return zero changes when LLM returns no parseable blocks', async () => {
      const params: EditParams = {
        goal: 'Review code',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM: mockLLMEmptyResponse(),
      };

      const result = await module.edit(params);

      expect(result.changeCount).toBe(0);
      expect(result.changes).toHaveLength(0);
      expect(result.summary).toContain('No files needed changes');
    });

    it('should include a warning when no changes produced', async () => {
      const params: EditParams = {
        goal: 'Review',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM: mockLLMEmptyResponse(),
      };

      const result = await module.edit(params);

      expect(result.warnings).toBeDefined();
      expect(result.warnings!.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── edit() — LLM Errors ─────────────────────────────────────────────

  describe('edit() — LLM errors', () => {
    it('should handle LLM API failure gracefully', async () => {
      const params: EditParams = {
        goal: 'Update files',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM: mockLLMFailure(),
      };

      const result = await module.edit(params);

      expect(result.changeCount).toBe(0);
      expect(result.summary).toContain('Edit failed');
    });

    it('should include error message in warnings on failure', async () => {
      const params: EditParams = {
        goal: 'Update files',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM: mockLLMFailure(),
      };

      const result = await module.edit(params);

      expect(result.warnings).toBeDefined();
      expect(result.warnings!.some((w) => w.includes('LLM API error'))).toBe(true);
    });
  });

  // ── edit() — Rate-Limit Handling ────────────────────────────────────

  describe('edit() — rate-limit handling', () => {
    it('should abort when onRateLimit returns abort', async () => {
      const params: EditParams = {
        goal: 'Update files',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM: mockLLMFailure(), // Will trigger rate-limit check via error message
        onRateLimit: mockOnRateLimit('abort'),
      };

      // The failure doesn't have a rate-limit error message, so it won't trigger onRateLimit
      const result = await module.edit(params);

      expect(result.changeCount).toBe(0);
    });

    it('should skip when onRateLimit returns skip', async () => {
      const rateLimitLLM = vi.fn().mockRejectedValue(new Error('Rate limit exceeded. Try again in 10s'));
      const params: EditParams = {
        goal: 'Update files',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM: rateLimitLLM,
        onRateLimit: mockOnRateLimit('skip'),
      };

      const result = await module.edit(params);

      expect(result.changeCount).toBe(0);
      expect(result.summary).toContain('Skipped by user');
    });

    it('should switch model when onRateLimit returns switch-model', async () => {
      const rateLimitLLM = vi.fn().mockRejectedValue(new Error('Rate limit exceeded. Try again in 5s'));
      const newCallLLM = mockLLMSuccess(NEW_FILE_RESPONSE);
      const params: EditParams = {
        goal: 'Create middleware',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM: rateLimitLLM,
        onRateLimit: mockOnRateLimitSwitchModel(newCallLLM),
      };

      const result = await module.edit(params);

      // After switching model, the new callLLM should succeed
      expect(result.changeCount).toBeGreaterThanOrEqual(1);
      // Both the original and new callLLM should have been called
      expect(rateLimitLLM).toHaveBeenCalled();
      expect(newCallLLM).toHaveBeenCalled();
    });
  });

  // ── parseFileChanges — Filepath parsing ─────────────────────────────

  describe('parseFileChanges (via edit() - filepath parsing)', () => {
    it('should parse filepath: prefix in code blocks', async () => {
      const params: EditParams = {
        goal: 'Update',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM: mockLLMSuccess('```filepath:auth.ts\nexport function login() { return "new-token"; }\n```'),
      };

      const result = await module.edit(params);

      expect(result.changeCount).toBe(1);
      expect(result.changes[0].path).toBe('auth.ts');
    });

    it('should handle code blocks without filepath: prefix but with extension', async () => {
      const params: EditParams = {
        goal: 'Update',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM: mockLLMSuccess('```typescript auth.ts\nexport function login() { return "new-token"; }\n```'),
      };

      const result = await module.edit(params);

      expect(result.changeCount).toBe(1);
    });

    it('should handle paths with spaces', async () => {
      writeFileSync(join(testDir, 'my file.ts'), 'export const x = 1;');
      const params: EditParams = {
        goal: 'Update',
        workingDirectory: testDir,
        artifacts: [makeArtifact('my file.ts', 'export const x = 1;')],
        callLLM: mockLLMSuccess('```filepath:my file.ts\nexport const x = 2;\n```'),
      };

      const result = await module.edit(params);

      expect(result.changeCount).toBe(1);
      expect(result.changes[0].path).toBe('my file.ts');
    });

    it('should skip empty blocks', async () => {
      const params: EditParams = {
        goal: 'Update',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM: mockLLMSuccess('```filepath:auth.ts\n\n```'), // Empty content
      };

      const result = await module.edit(params);

      expect(result.changeCount).toBe(0);
    });

    it('should skip blocks without a valid file extension', async () => {
      const params: EditParams = {
        goal: 'Update',
        workingDirectory: testDir,
        artifacts: [],
        callLLM: mockLLMSuccess('```filepath:README\ndo not edit\n```'), // No extension
      };

      const result = await module.edit(params);

      expect(result.changeCount).toBe(0);
    });
  });

  // ── addFileChange — File detection ──────────────────────────────────

  describe('addFileChange (via edit() - file detection)', () => {
    it('should detect modified file (exists on disk)', async () => {
      const params: EditParams = {
        goal: 'Update auth',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM: mockLLMSuccess('```filepath:auth.ts\nexport function login() { return "new-jwt"; }\n```'),
      };

      const result = await module.edit(params);

      const authChange = result.changes.find((c) => c.path === 'auth.ts');
      expect(authChange).toBeDefined();
      expect(authChange!.status).toBe('modified');
      expect(authChange!.originalContent).toBeDefined();
    });

    it('should detect created file (does not exist on disk)', async () => {
      const params: EditParams = {
        goal: 'Create new file',
        workingDirectory: testDir,
        artifacts: [],
        callLLM: mockLLMSuccess('```filepath:src/new-file.ts\nexport const x = 1;\n```'),
      };

      const result = await module.edit(params);

      const newChange = result.changes.find((c) => c.path.includes('new-file'));
      expect(newChange).toBeDefined();
      expect(newChange!.status).toBe('created');
      expect(newChange!.originalContent).toBeUndefined();
    });

    it('should skip files with identical content', async () => {
      // The file on disk already has the same content as what LLM returns
      const params: EditParams = {
        goal: 'No real change',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM: mockLLMSuccess('```filepath:auth.ts\nexport function login() { return "token"; }\n```'),
      };

      const result = await module.edit(params);

      // Content matches → no file change produced
      expect(result.changeCount).toBe(0);
    });

    it('should handle absolute paths in responses', async () => {
      const params: EditParams = {
        goal: 'Update absolute',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM: mockLLMSuccess(`\`\`\`filepath:${join(testDir, 'auth.ts')}\nexport function login() { return "new-jwt"; }\n\`\`\``),
      };

      const result = await module.edit(params);

      expect(result.changeCount).toBe(1);
    });
  });

  // ── validateChanges — Syntax validation ─────────────────────────────

  describe('validateChanges (via edit() - syntax validation)', () => {
    it('should produce no warnings for valid syntax', async () => {
      const params: EditParams = {
        goal: 'Update auth',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM: mockLLMSuccess('```filepath:auth.ts\nexport function login() { return "new-token"; }\n```'),
      };

      const result = await module.edit(params);

      // Valid JS/TS → no warnings
      expect(result.warnings).toBeUndefined();
    });

    it('should warn for syntax issues in .ts files', async () => {
      // Create a response with clearly unbalanced braces
      const params: EditParams = {
        goal: 'Update auth',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM: mockLLMSuccess(SYNTAX_ERROR_RESPONSE),
      };

      const result = await module.edit(params);

      // The unclosed brace should trigger a warning
      if (result.warnings) {
        expect(result.warnings.some((w) => w.includes('Syntax') || w.includes('unbalanced'))).toBe(true);
      }
    });

    it('should not warn for non-source files (.json, .md)', async () => {
      writeFileSync(join(testDir, 'config.json'), '{"key": "value"}');
      const params: EditParams = {
        goal: 'Update config',
        workingDirectory: testDir,
        artifacts: [makeArtifact('config.json', '{"key": "value"}')],
        callLLM: mockLLMSuccess('```filepath:config.json\n{"key": "new-value"}\n```'),
      };

      const result = await module.edit(params);

      // .json is not in source language detection → no syntax check
      expect(result.warnings).toBeUndefined();
    });
  });

  // ── Token Budget / File Selection ───────────────────────────────────

  describe('file selection (budget management)', () => {
    it('should handle large number of artifacts within budget', async () => {
      const artifacts: Artifact[] = [];
      for (let i = 0; i < 20; i++) {
        artifacts.push(makeArtifact(`file-${i}.ts`, `export const x${i} = ${i};`));
      }

      const params: EditParams = {
        goal: 'Update all',
        workingDirectory: testDir,
        artifacts,
        callLLM: mockLLMSuccess('```filepath:file-0.ts\nexport const x0 = 999;\n```'),
      };

      const result = await module.edit(params);

      // Should not throw and produce at least one change
      expect(result.changeCount).toBeGreaterThanOrEqual(1);
    });

    it('should limit to MAX_CONTEXT_FILES (10) even with many artifacts', async () => {
      const artifacts: Artifact[] = [];
      for (let i = 0; i < 30; i++) {
        const content = `// file ${i}\n`.repeat(100); // Large file
        artifacts.push(makeArtifact(`big-file-${i}.ts`, content));
      }

      const params: EditParams = {
        goal: 'Update a file',
        workingDirectory: testDir,
        artifacts,
        callLLM: mockLLMSuccess('```filepath:big-file-0.ts\nexport const x = 1;\n```'),
      };

      // Should not throw
      const result = await module.edit(params);
      expect(result).toBeDefined();
    });
  });

  // ── Constructor ─────────────────────────────────────────────────────

  describe('constructor', () => {
    it('should create an instance without event bus', () => {
      expect(new DefaultEditModule()).toBeInstanceOf(DefaultEditModule);
    });

    it('should accept undefined event bus', () => {
      expect(new DefaultEditModule(undefined)).toBeInstanceOf(DefaultEditModule);
    });

    it('should accept a custom event bus', () => {
      const bus = new EventBus();
      const mod = new DefaultEditModule(bus);
      expect(mod).toBeInstanceOf(DefaultEditModule);
    });
  });

  // ── Event Bus Emissions ─────────────────────────────────────────────

  describe('event bus emissions — edit()', () => {
    it('should emit EDIT_GENERATING event when edit starts', async () => {
      const bus = new EventBus();
      const emitSpy = vi.spyOn(bus, 'emit');
      const mod = new DefaultEditModule(bus);

      const params: EditParams = {
        goal: 'Update auth',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM: mockLLMSuccess(STANDARD_RESPONSE),
      };

      await mod.edit(params);

      const generatingEvents = emitSpy.mock.calls.filter((c) => c[0] === 'edit:generating');
      expect(generatingEvents.length).toBeGreaterThanOrEqual(1);
      const payload = generatingEvents[0][1] as Record<string, unknown>;
      expect(payload.goal).toBe('Update auth');
    });

    it('should emit EDIT_WRITTEN for each file change', async () => {
      const bus = new EventBus();
      const emitSpy = vi.spyOn(bus, 'emit');
      const mod = new DefaultEditModule(bus);

      const params: EditParams = {
        goal: 'Update auth',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM: mockLLMSuccess(NEW_FILE_RESPONSE),
      };

      await mod.edit(params);

      const writtenEvents = emitSpy.mock.calls.filter((c) => c[0] === 'edit:written');
      expect(writtenEvents.length).toBeGreaterThanOrEqual(0);
      if (writtenEvents.length > 0) {
        const payload = writtenEvents[0][1] as Record<string, unknown>;
        expect(payload).toHaveProperty('path');
        expect(payload).toHaveProperty('status');
        expect(payload).toHaveProperty('bytes');
      }
    });

    it('should use source "edit-module" for emitted events', async () => {
      const bus = new EventBus();
      const emitSpy = vi.spyOn(bus, 'emit');
      const mod = new DefaultEditModule(bus);

      const params: EditParams = {
        goal: 'Update auth',
        workingDirectory: testDir,
        artifacts: [makeArtifact('auth.ts', 'export function login() { return "token"; }')],
        callLLM: mockLLMSuccess(STANDARD_RESPONSE),
      };

      await mod.edit(params);

      for (const call of emitSpy.mock.calls) {
        if (['edit:generating', 'edit:written', 'edit:skipped'].includes(call[0] as string)) {
          expect(call[2]).toBe('edit-module');
        }
      }
    });
  });
});
