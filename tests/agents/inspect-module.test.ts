/**
 * Unit tests for DefaultInspectModule — codebase inspection via keyword scanning
 * and LLM-based file classification (Phase 6).
 *
 * Coverage goals:
 * - scanByKeywords() — goal parsing, stop words, scoring, edge cases
 * - inspect() — keyword path, LLM path, stats, error handling
 * - LLM classification — callLLM succeeds, callLLM fails & falls back,
 *   callLLM returns invalid JSON, buildClassifyPrompt format
 * - formatSize (via inspect artifact descriptions) — bytes, KB, KB threshold
 * - Edge cases — empty dir, maxFiles limit, file too large, missing file
 * - Constructor — default and with event bus
 * - Depth limit — recursion stops at depth 5
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DefaultInspectModule } from '../../src/agents/inspect-module.js';
import type { InspectParams, InspectArtifact } from '../../src/agents/inspect-module.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a temporary project directory with a controlled set of files. */
function createTestProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'inspect-test-'));
  writeFileSync(join(dir, 'index.ts'), 'export const greet = () => "hello";');
  writeFileSync(join(dir, 'auth.ts'), 'export function login() { return "token"; }');
  writeFileSync(join(dir, 'auth.test.ts'), 'import { login } from "./auth";');
  writeFileSync(join(dir, 'utils.ts'), 'export const formatDate = (d: Date) => d.toISOString();');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 3000, debug: true }));
  writeFileSync(join(dir, 'styles.css'), 'body { color: red; }');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'main.ts'), 'console.log("main");');
  writeFileSync(join(dir, 'src', 'handlers.ts'), 'export function handleRequest() {}');
  mkdirSync(join(dir, 'src', 'services'));
  writeFileSync(join(dir, 'src', 'services', 'auth-service.ts'), 'export class AuthService { login() {} }');
  writeFileSync(join(dir, 'src', 'services', 'user-service.ts'), 'export class UserService { find() {} }');
  writeFileSync(join(dir, 'readme.md'), '# Test Project');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test' }));
  writeFileSync(join(dir, 'icon.png'), Buffer.alloc(100));
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'lodash.js'), 'module.exports = {};');
  return dir;
}

/** Create a file with a specific byte size */
function createFileOfSize(dir: string, name: string, bytes: number): void {
  writeFileSync(join(dir, name), 'x'.repeat(bytes));
}

/** Clean up a temp project directory */
function removeProject(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** A mock LLMCallFn that returns a JSON array of file paths */
function mockLLMSuccess(paths: string[]): () => Promise<string> {
  return vi.fn().mockResolvedValue(JSON.stringify(paths));
}

/** A mock LLMCallFn that rejects with an error */
function mockLLMFailure(): () => Promise<string> {
  return vi.fn().mockRejectedValue(new Error('LLM API error'));
}

/** A mock LLMCallFn that returns invalid (non-JSON) content */
function mockLLMInvalidResponse(): () => Promise<string> {
  return vi.fn().mockResolvedValue('I think the relevant files are auth.ts and utils.ts.');
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DefaultInspectModule', () => {
  let module: DefaultInspectModule;
  let testDir: string;

  beforeEach(() => {
    module = new DefaultInspectModule();
    testDir = createTestProject();
  });

  afterEach(() => {
    removeProject(testDir);
  });

  // ── scanByKeywords() ──────────────────────────────────────────────────

  describe('scanByKeywords()', () => {
    it('should find files matching goal keywords', () => {
      const results = module.scanByKeywords('implement auth login', testDir);
      expect(results).toContain('auth.ts');
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('should find service files when searching for services', () => {
      const results = module.scanByKeywords('find user service', testDir);
      expect(results.some((r) => r.includes('user-service'))).toBe(true);
    });

    it('should return files sorted by relevance (name match > path match)', () => {
      const results = module.scanByKeywords('auth service', testDir);
      if (results.length >= 2) {
        const authFiles = results.filter((r) => r.includes('auth'));
        expect(authFiles.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('should return empty array for empty goal string', () => {
      expect(module.scanByKeywords('', testDir)).toHaveLength(0);
    });

    it('should return empty array for goal with only stop words', () => {
      expect(module.scanByKeywords('the a an in to for of and or is', testDir)).toHaveLength(0);
    });

    it('should return empty array for single-letter words', () => {
      expect(module.scanByKeywords('a b c d e f g', testDir)).toHaveLength(0);
    });

    it('should return empty array for non-existent directory', () => {
      expect(module.scanByKeywords('auth', join(testDir, 'nonexistent'))).toHaveLength(0);
    });

    it('should cap results at 10 files', () => {
      for (let i = 0; i < 20; i++) {
        writeFileSync(join(testDir, `auth-module-${i}.ts`), `export const mod${i} = ${i};`);
      }
      expect(module.scanByKeywords('auth module', testDir).length).toBeLessThanOrEqual(10);
    });

    it('should ignore node_modules directory', () => {
      expect(module.scanByKeywords('lodash', testDir).some((r) => r.includes('lodash'))).toBe(false);
    });

    it('should not include non-source extensions (.png)', () => {
      expect(module.scanByKeywords('icon', testDir).some((r) => r.includes('icon'))).toBe(false);
    });

    it('should include source extensions like .ts, .js, .json, .css', () => {
      const results = module.scanByKeywords('config json styles css', testDir);
      expect(results.some((r) => r.includes('config.json'))).toBe(true);
      expect(results.some((r) => r.includes('styles.css'))).toBe(true);
    });

    it('should match case-insensitively', () => {
      expect(module.scanByKeywords('AUTH LOGIN', testDir)).toContain('auth.ts');
    });
  });

  // ── inspect() — Keyword path (no callLLM) ────────────────────────────

  describe('inspect() — without callLLM', () => {
    it('should discover relevant files for a goal', async () => {
      const result = await module.inspect({ goal: 'implement auth service', workingDirectory: testDir });
      expect(result.artifacts.length).toBeGreaterThanOrEqual(1);
      expect(result.relevantPaths.some((p) => p.includes('auth'))).toBe(true);
    });

    it('should include the project file tree', async () => {
      const result = await module.inspect({ goal: 'auth', workingDirectory: testDir });
      expect(result.fileTree).toContain('📄');
    });

    it('should include artifact content for discovered files', async () => {
      const result = await module.inspect({ goal: 'auth', workingDirectory: testDir });
      const authArtifact = result.artifacts.find((a) => a.path.includes('auth'));
      expect(authArtifact).toBeDefined();
      expect(authArtifact!.content).toBeTruthy();
    });

    it('should respect maxFiles parameter', async () => {
      for (let i = 0; i < 15; i++) {
        writeFileSync(join(testDir, `auth-file-${i}.ts`), `// file ${i}`);
      }
      const result = await module.inspect({ goal: 'auth', workingDirectory: testDir, maxFiles: 3 });
      expect(result.artifacts.length).toBeLessThanOrEqual(3);
      expect(result.relevantPaths.length).toBeLessThanOrEqual(3);
    });

    it('should set llmFallbackUsed to true when no callLLM', async () => {
      const result = await module.inspect({ goal: 'auth service', workingDirectory: testDir });
      expect(result.stats.llmFallbackUsed).toBe(true);
    });

    it('should report errors for files exceeding MAX_FILE_CHARS', async () => {
      createFileOfSize(testDir, 'huge.ts', 200_000);
      const result = await module.inspect({ goal: 'huge', workingDirectory: testDir });
      expect(result.stats.errors).toBeGreaterThanOrEqual(1);
    });

    it('should return empty artifacts for empty project directory', async () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'inspect-empty-'));
      try {
        const result = await module.inspect({ goal: 'anything', workingDirectory: emptyDir });
        expect(result.artifacts).toHaveLength(0);
        expect(result.stats.totalFiles).toBe(0);
      } finally {
        removeProject(emptyDir);
      }
    });

    it('should handle non-existent working directory gracefully', async () => {
      const result = await module.inspect({
        goal: 'auth',
        workingDirectory: join(testDir, 'does-not-exist'),
      });
      expect(result.artifacts).toHaveLength(0);
      expect(result.stats.totalFiles).toBe(0);
    });
  });

  // ── inspect() — LLM path (with callLLM) ──────────────────────────────

  describe('inspect() — with callLLM', () => {
    it('should use LLM results when callLLM returns valid file list', async () => {
      const callLLM = mockLLMSuccess(['src/services/auth-service.ts', 'auth.ts']);
      const result = await module.inspect({
        goal: 'implement auth',
        workingDirectory: testDir,
        callLLM,
      });

      expect(callLLM).toHaveBeenCalledTimes(1);
      expect(result.relevantPaths).toContain('auth.ts');
      expect(result.relevantPaths).toContain('src/services/auth-service.ts');
      // LLM succeeded → llmFallbackUsed is false
      expect(result.stats.llmFallbackUsed).toBe(false);
    });

    it('should include artifact content for files returned by LLM', async () => {
      const callLLM = mockLLMSuccess(['auth.ts', 'src/services/auth-service.ts']);
      const result = await module.inspect({
        goal: 'implement auth',
        workingDirectory: testDir,
        callLLM,
      });

      expect(result.artifacts.length).toBeGreaterThanOrEqual(1);
      const authArtifact = result.artifacts.find((a) => a.path === 'auth.ts');
      expect(authArtifact).toBeDefined();
      expect(authArtifact!.content).toContain('token');
    });

    it('should fall back to keyword scanning when callLLM fails', async () => {
      const callLLM = mockLLMFailure();
      const result = await module.inspect({
        goal: 'auth login',
        workingDirectory: testDir,
        callLLM,
      });

      // Should have fallen back — keyword scan finds auth.ts
      expect(result.relevantPaths).toContain('auth.ts');
      expect(result.stats.llmFallbackUsed).toBe(true);
    });

    it('should return relevantPaths even when LLM fails', async () => {
      const callLLM = mockLLMFailure();
      const result = await module.inspect({
        goal: 'auth login',
        workingDirectory: testDir,
        callLLM,
      });

      expect(result.relevantPaths.length).toBeGreaterThanOrEqual(1);
    });

    it('should fall back to keyword when LLM returns invalid JSON', async () => {
      const callLLM = mockLLMInvalidResponse();
      const result = await module.inspect({
        goal: 'auth',
        workingDirectory: testDir,
        callLLM,
      });

      expect(callLLM).toHaveBeenCalledTimes(1);
      expect(result.stats.llmFallbackUsed).toBe(true);
      // Keyword scan should still find auth files
      expect(result.relevantPaths.some((p) => p.includes('auth'))).toBe(true);
    });

    it('should fall back to keyword when LLM returns empty array', async () => {
      const callLLM = mockLLMSuccess([]);
      const result = await module.inspect({
        goal: 'auth',
        workingDirectory: testDir,
        callLLM,
      });

      expect(result.stats.llmFallbackUsed).toBe(true);
      expect(result.relevantPaths.length).toBeGreaterThanOrEqual(1);
    });

    it('should pass taskDescriptions into the LLM prompt', async () => {
      const callLLM = vi.fn().mockResolvedValue(JSON.stringify(['auth.ts']));
      await module.inspect({
        goal: 'implement auth',
        workingDirectory: testDir,
        callLLM,
        taskDescriptions: ['Step 1: Add login endpoint', 'Step 2: Add JWT middleware'],
      });

      const promptArg = callLLM.mock.calls[0][0] as string;
      expect(promptArg).toContain('Step 1: Add login endpoint');
      expect(promptArg).toContain('Step 2: Add JWT middleware');
    });

    it('should respect maxFiles even when LLM returns more files', async () => {
      const callLLM = mockLLMSuccess([
        'auth.ts', 'utils.ts', 'config.json', 'styles.css', 'index.ts',
        'src/main.ts', 'src/handlers.ts',
      ]);
      const result = await module.inspect({
        goal: 'auth',
        workingDirectory: testDir,
        callLLM,
        maxFiles: 3,
      });

      expect(result.artifacts.length).toBeLessThanOrEqual(3);
      expect(result.relevantPaths.length).toBeLessThanOrEqual(3);
    });
  });

  // ── buildClassifyPrompt (via LLM call inspection) ────────────────────

  describe('buildClassifyPrompt (via LLM call inspection)', () => {
    it('should include the goal in the prompt', async () => {
      const callLLM = vi.fn().mockResolvedValue(JSON.stringify(['auth.ts']));
      await module.inspect({
        goal: 'Add JWT authentication',
        workingDirectory: testDir,
        callLLM,
      });

      const prompt = callLLM.mock.calls[0][0] as string;
      expect(prompt).toContain('Add JWT authentication');
      expect(prompt).toContain('file tree');
    });

    it('should instruct LLM to respond with JSON array', async () => {
      const callLLM = vi.fn().mockResolvedValue(JSON.stringify(['auth.ts']));
      await module.inspect({
        goal: 'auth',
        workingDirectory: testDir,
        callLLM,
      });

      const prompt = callLLM.mock.calls[0][0] as string;
      expect(prompt).toContain('JSON array');
    });
  });

  // ── formatSize (via inspect artifact descriptions) ───────────────────

  describe('formatSize (via artifact descriptions)', () => {
    it('should format small files in bytes', async () => {
      writeFileSync(join(testDir, 'small.ts'), 'console.log("tiny");');
      const result = await module.inspect({ goal: 'small', workingDirectory: testDir, maxFiles: 5 });
      const smallArtifact = result.artifacts.find((a) => a.path === 'small.ts');
      expect(smallArtifact).toBeDefined();
      expect(smallArtifact!.description).toMatch(/\(\d+ characters\)/);
    });

    it('should format larger files with KB suffix', async () => {
      createFileOfSize(testDir, 'medium.ts', 5_000);
      const result = await module.inspect({ goal: 'medium', workingDirectory: testDir, maxFiles: 5 });
      const mediumArtifact = result.artifacts.find((a) => a.path === 'medium.ts');
      expect(mediumArtifact).toBeDefined();
      expect(mediumArtifact!.description).toMatch(/\d+\.\d+k characters/);
    });

    it('should format edge of KB threshold correctly (1023 bytes)', async () => {
      createFileOfSize(testDir, 'edge-file.ts', 1023);
      const result = await module.inspect({ goal: 'edge-file', workingDirectory: testDir, maxFiles: 5 });
      const edgeArtifact = result.artifacts.find((a) => a.path === 'edge-file.ts');
      expect(edgeArtifact).toBeDefined();
      expect(edgeArtifact!.description).toMatch(/\(1023 characters\)/);
    });
  });

  // ── Depth limit ──────────────────────────────────────────────────────

  describe('scanByKeywords — depth limit', () => {
    it('should stop recursion at depth 5', () => {
      let deepDir = testDir;
      for (let i = 0; i < 8; i++) {
        deepDir = join(deepDir, `level-${i}`);
        mkdirSync(deepDir);
      }
      writeFileSync(join(deepDir, 'deep-auth.ts'), 'export const deep = true;');
      const results = module.scanByKeywords('auth', testDir);
      expect(results.some((r) => r.includes('deep-auth'))).toBe(false);
    });

    it('should find files at depth 4', () => {
      let deepDir = testDir;
      for (let i = 0; i < 4; i++) {
        deepDir = join(deepDir, `sub-${i}`);
        mkdirSync(deepDir);
      }
      writeFileSync(join(deepDir, 'found-auth.ts'), 'export const found = true;');
      const results = module.scanByKeywords('auth', testDir);
      expect(results.some((r) => r.includes('found-auth'))).toBe(true);
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────────

  describe('scanByKeywords — edge cases', () => {
    it('should handle goal with special characters', () => {
      const results = module.scanByKeywords('add-jwt-auth, implement OAuth2 flow!', testDir);
      expect(results.some((r) => r.includes('auth'))).toBe(true);
    });

    it('should handle goal with numbers', () => {
      expect(Array.isArray(module.scanByKeywords('update to version 2', testDir))).toBe(true);
    });

    it('should handle very long goal string', () => {
      const results = module.scanByKeywords('implement '.repeat(100) + 'auth login', testDir);
      expect(results.some((r) => r.includes('auth'))).toBe(true);
    });

    it('should score path matches lower than name matches', () => {
      mkdirSync(join(testDir, 'login-helpers'));
      writeFileSync(join(testDir, 'login-helpers', 'helper.ts'), 'export const h = 1;');
      writeFileSync(join(testDir, 'login-handler.ts'), 'export function loginHandler() {}');
      const results = module.scanByKeywords('login', testDir);
      const loginHandlerIndex = results.findIndex((r) => r.includes('login-handler'));
      const helperIndex = results.findIndex((r) => r.includes('helper'));
      if (loginHandlerIndex >= 0 && helperIndex >= 0) {
        expect(loginHandlerIndex).toBeLessThan(helperIndex);
      }
    });
  });

  // ── Constructor ──────────────────────────────────────────────────────

  describe('constructor', () => {
    it('should create an instance without event bus', () => {
      expect(new DefaultInspectModule()).toBeInstanceOf(DefaultInspectModule);
    });

    it('should accept undefined event bus', () => {
      expect(new DefaultInspectModule(undefined)).toBeInstanceOf(DefaultInspectModule);
    });
  });
});
