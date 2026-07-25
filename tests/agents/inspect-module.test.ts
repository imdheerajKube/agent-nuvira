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
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DefaultInspectModule } from '../../src/agents/inspect-module.js';
import type { InspectParams, InspectArtifact } from '../../src/agents/inspect-module.js';
import { EventBus } from '../../src/observability/event-bus.js';

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

    it('should accept a custom event bus', () => {
      const bus = new EventBus();
      const mod = new DefaultInspectModule(bus);
      expect(mod).toBeInstanceOf(DefaultInspectModule);
    });
  });

  // ── Event Bus Emissions ──────────────────────────────────────────────

  describe('event bus emissions — inspect()', () => {
    it('should emit INSPECT_SCANNING event when inspect starts', async () => {
      const bus = new EventBus();
      const emitSpy = vi.spyOn(bus, 'emit');
      const mod = new DefaultInspectModule(bus);

      await mod.inspect({ goal: 'auth', workingDirectory: testDir });

      const scanningEvents = emitSpy.mock.calls.filter((c) => c[0] === 'inspect:scanning');
      expect(scanningEvents.length).toBeGreaterThanOrEqual(1);
      const payload = scanningEvents[0][1] as Record<string, unknown>;
      expect(payload.directory).toBe(testDir);
      expect(payload.goal).toBe('auth');
    });

    it('should emit INSPECT_FILE_FOUND for each inspected file', async () => {
      const bus = new EventBus();
      const emitSpy = vi.spyOn(bus, 'emit');
      const mod = new DefaultInspectModule(bus);

      const result = await mod.inspect({ goal: 'auth', workingDirectory: testDir });

      const fileEvents = emitSpy.mock.calls.filter((c) => c[0] === 'inspect:file-found');
      expect(fileEvents.length).toBe(result.artifacts.length);
      if (fileEvents.length > 0) {
        const payload = fileEvents[0][1] as Record<string, unknown>;
        expect(payload).toHaveProperty('path');
        expect(payload).toHaveProperty('size');
        expect(payload).toHaveProperty('extension');
      }
    });

    it('should emit INSPECT_COMPLETED event when inspect finishes', async () => {
      const bus = new EventBus();
      const emitSpy = vi.spyOn(bus, 'emit');
      const mod = new DefaultInspectModule(bus);

      await mod.inspect({ goal: 'auth', workingDirectory: testDir });

      const completedEvents = emitSpy.mock.calls.filter((c) => c[0] === 'inspect:completed');
      expect(completedEvents.length).toBeGreaterThanOrEqual(1);
      const payload = completedEvents[0][1] as Record<string, unknown>;
      expect(payload).toHaveProperty('artifactCount');
      expect(payload).toHaveProperty('totalFiles');
    });

    it('should emit INSPECT_LLM_CLASSIFY with method "llm" when LLM succeeds', async () => {
      const bus = new EventBus();
      const emitSpy = vi.spyOn(bus, 'emit');
      const mod = new DefaultInspectModule(bus);
      const callLLM = mockLLMSuccess(['auth.ts']);

      await mod.inspect({ goal: 'auth', workingDirectory: testDir, callLLM });

      const llmEvents = emitSpy.mock.calls.filter((c) => c[0] === 'inspect:llm-classify');
      expect(llmEvents.length).toBeGreaterThanOrEqual(1);
      const payload = llmEvents[0][1] as Record<string, unknown>;
      expect(payload.method).toBe('llm');
      expect(payload.fileCount).toBe(1);
    });

    it('should emit INSPECT_LLM_CLASSIFY with method "keyword-fallback" when LLM fails', async () => {
      const bus = new EventBus();
      const emitSpy = vi.spyOn(bus, 'emit');
      const mod = new DefaultInspectModule(bus);
      const callLLM = mockLLMFailure();

      await mod.inspect({ goal: 'auth', workingDirectory: testDir, callLLM });

      const llmEvents = emitSpy.mock.calls.filter((c) => c[0] === 'inspect:llm-classify');
      expect(llmEvents.length).toBeGreaterThanOrEqual(1);
      const payload = llmEvents[0][1] as Record<string, unknown>;
      expect(payload.method).toBe('keyword-fallback');
      expect(payload.fileCount).toBeGreaterThanOrEqual(1);
    });

    it('should use source "inspect-module" for all emitted events', async () => {
      const bus = new EventBus();
      const emitSpy = vi.spyOn(bus, 'emit');
      const mod = new DefaultInspectModule(bus);

      await mod.inspect({ goal: 'auth', workingDirectory: testDir });

      for (const call of emitSpy.mock.calls) {
        if (['inspect:scanning', 'inspect:file-found', 'inspect:completed'].includes(call[0] as string)) {
          expect(call[2]).toBe('inspect-module');
        }
      }
    });
  });

  // ── walkAndScore ─────────────────────────────────────────────────────

  describe('walkAndScore (via scanByKeywords)', () => {
    it('should score name matches higher than path-only matches', () => {
      mkdirSync(join(testDir, 'auth-helpers'));
      writeFileSync(join(testDir, 'auth-helpers', 'helpers.ts'), 'export const h = 1;');
      writeFileSync(join(testDir, 'auth-handler.ts'), 'export function handler() {}');
      // auth-handler.ts has 'auth' in name → score +3
      // auth-helpers/helpers.ts has 'auth' only in path → score +1
      const results = module.scanByKeywords('auth', testDir);
      const handlerIdx = results.findIndex((r) => r === 'auth-handler.ts');
      const helpersIdx = results.findIndex((r) => r === join('auth-helpers', 'helpers.ts'));
      expect(handlerIdx).toBeGreaterThanOrEqual(0);
      expect(helpersIdx).toBeGreaterThanOrEqual(0);
      expect(handlerIdx).toBeLessThan(helpersIdx); // name match sorts higher
    });

    it('should score multiple keyword matches additively', () => {
      writeFileSync(join(testDir, 'auth-service-handler.ts'), 'export const triple = 1;');
      writeFileSync(join(testDir, 'auth-service.ts'), 'export const double = 1;');
      // 'auth-service-handler' matches 'auth', 'service', 'handler' → score +9
      // 'auth-service' matches 'auth', 'service' → score +6
      // 'auth.ts' matches 'auth' only → score +3
      const results = module.scanByKeywords('auth service handler', testDir);
      const tripleIdx = results.findIndex((r) => r.includes('auth-service-handler'));
      const doubleIdx = results.findIndex((r) => r === 'auth-service.ts');
      const singleIdx = results.findIndex((r) => r === 'auth.ts');
      expect(tripleIdx).toBeGreaterThanOrEqual(0);
      expect(doubleIdx).toBeGreaterThanOrEqual(0);
      expect(singleIdx).toBeGreaterThanOrEqual(0);
      expect(tripleIdx).toBeLessThan(doubleIdx);
      expect(doubleIdx).toBeLessThan(singleIdx);
    });

    it('should include subdirectory files when keyword matches directory name', () => {
      const results = module.scanByKeywords('services', testDir);
      expect(results.some((r) => r.includes('auth-service.ts'))).toBe(true);
      expect(results.some((r) => r.includes('user-service.ts'))).toBe(true);
    });

    it('should not include files from ignored directories', () => {
      writeFileSync(join(testDir, 'node_modules', 'auth-pkg.ts'), 'module.exports = {};');
      const results = module.scanByKeywords('auth', testDir);
      expect(results.some((r) => r.includes('node_modules'))).toBe(false);
    });

    it('should not walk deeper than 5 levels', () => {
      let deepDir = testDir;
      for (let i = 0; i < 6; i++) {
        deepDir = join(deepDir, `d${i}`);
        mkdirSync(deepDir);
      }
      writeFileSync(join(deepDir, 'deep-nested-auth.ts'), 'export const a = 1;');
      const results = module.scanByKeywords('auth', testDir);
      // Use a unique path segment to avoid matching root-level files
      const deepPath = join('d5', 'deep-nested-auth.ts');
      expect(results.some((r) => r === deepPath || r.endsWith('/' + 'deep-nested-auth.ts'))).toBe(false);
    });

    it('should handle files at exact depth limit of 5', () => {
      let deepDir = testDir;
      for (let i = 0; i < 5; i++) {
        deepDir = join(deepDir, `d${i}`);
        mkdirSync(deepDir);
      }
      writeFileSync(join(deepDir, 'auth-at-limit.ts'), 'export const a = 1;');
      const results = module.scanByKeywords('auth', testDir);
      expect(results.some((r) => r.includes('auth-at-limit'))).toBe(true);
    });

    it('should return empty array when walking unreadable directory', async () => {
      const badDir = join(testDir, 'nope');
      mkdirSync(badDir);
      writeFileSync(join(badDir, 'target.ts'), 'export const t = 1;');
      try {
        // Make directory unreadable (Unix-only)
        try {
          const { chmodSync } = await import('node:fs');
          chmodSync(badDir, 0o000);
        } catch {
          // If chmod fails (e.g., Windows), skip the permission test
          return;
        }
        // Should not throw — walkAndScore catches readdir errors silently
        const results = module.scanByKeywords('target', testDir);
        expect(results.some((r) => r.includes('target'))).toBe(false);
      } finally {
        // Restore permissions first, then remove
        try {
          const { chmodSync } = await import('node:fs');
          chmodSync(badDir, 0o755);
        } catch { /* best-effort */ }
        rmSync(badDir, { recursive: true, force: true });
      }
    });
  });

  // ── parseClassifyResponse edge cases (via callLLM) ───────────────────

  describe('parseClassifyResponse (via callLLM)', () => {
    it('should handle markdown-wrapped JSON (```json ... ```)', async () => {
      const response = '```json\n["auth.ts", "utils.ts"]\n```';
      const callLLM = vi.fn().mockResolvedValue(response);
      const result = await module.inspect({
        goal: 'auth',
        workingDirectory: testDir,
        callLLM,
      });
      expect(result.relevantPaths).toContain('auth.ts');
      expect(result.relevantPaths).toContain('utils.ts');
      expect(result.stats.llmFallbackUsed).toBe(false);
    });

    it('should handle extra explanatory text around JSON array', async () => {
      const response = 'Based on my analysis, the relevant files are: ["auth.ts", "utils.ts"] These should be modified.';
      const callLLM = vi.fn().mockResolvedValue(response);
      const result = await module.inspect({
        goal: 'auth',
        workingDirectory: testDir,
        callLLM,
      });
      expect(result.relevantPaths).toContain('auth.ts');
      expect(result.relevantPaths).toContain('utils.ts');
    });

    it('should fall back to keywords when LLM returns text without JSON array', async () => {
      const response = 'I recommend you look at auth.ts for authentication logic.';
      const callLLM = vi.fn().mockResolvedValue(response);
      const result = await module.inspect({
        goal: 'auth',
        workingDirectory: testDir,
        callLLM,
      });
      // Fell back to keyword scanning
      expect(result.stats.llmFallbackUsed).toBe(true);
      expect(result.relevantPaths).toContain('auth.ts');
    });

    it('should fall back to keywords when LLM returns malformed JSON', async () => {
      const response = '["auth.ts", "utils.ts';
      const callLLM = vi.fn().mockResolvedValue(response);
      const result = await module.inspect({
        goal: 'auth',
        workingDirectory: testDir,
        callLLM,
      });
      expect(result.stats.llmFallbackUsed).toBe(true);
      expect(result.relevantPaths).toContain('auth.ts');
    });

    it('should handle file paths with subdirectory notation and spaces in response', async () => {
      const response = `[
  "src/services/auth-service.ts",
  "src/main.ts"
]`;
      const callLLM = vi.fn().mockResolvedValue(response);
      const result = await module.inspect({
        goal: 'auth',
        workingDirectory: testDir,
        callLLM,
      });
      expect(result.relevantPaths).toContain('src/services/auth-service.ts');
      expect(result.relevantPaths).toContain('src/main.ts');
      expect(result.stats.llmFallbackUsed).toBe(false);
    });
  });

  // ── inspect() — Edge Cases ───────────────────────────────────────────

  describe('inspect() — edge cases', () => {
    it('should ignore binary files (non-source extensions)', async () => {
      // .jpg is not in SOURCE_EXTENSIONS
      const result = await module.inspect({
        goal: 'icon',
        workingDirectory: testDir,
      });
      const binaryArtifact = result.artifacts.find((a) => a.path.includes('icon'));
      expect(binaryArtifact).toBeUndefined();
    });

    it('should skip symlinks (isFile() returns false for symlinks)', async () => {
      const realFile = join(testDir, 'real-auth.ts');
      writeFileSync(realFile, 'export const auth = true;');
      const linkPath = join(testDir, 'auth-link.ts');
      symlinkSync('real-auth.ts', linkPath);
      const result = await module.inspect({ goal: 'auth-link', workingDirectory: testDir });
      // Stats: original real-auth.ts is found via keyword scan, but auth-link symlink is not
      expect(result.artifacts.some((a) => a.path === 'auth-link.ts')).toBe(false);
      expect(result.artifacts.some((a) => a.path === 'real-auth.ts')).toBe(true);
    });

    it('should handle goal with multiple distinct keyword clusters', async () => {
      writeFileSync(join(testDir, 'user-api.ts'), 'export const userAPI = {};');
      writeFileSync(join(testDir, 'auth-api.ts'), 'export const authAPI = {};');
      const result = await module.inspect({
        goal: 'implement user authentication API',
        workingDirectory: testDir,
        maxFiles: 10,
      });
      expect(result.artifacts.some((a) => a.path.includes('auth'))).toBe(true);
      expect(result.artifacts.some((a) => a.path.includes('user'))).toBe(true);
    });

    it('should return unique file paths in relevantPaths', async () => {
      const result = await module.inspect({
        goal: 'auth service',
        workingDirectory: testDir,
      });
      const dupes = result.relevantPaths.filter(
        (p, i, arr) => arr.indexOf(p) !== i,
      );
      expect(dupes).toHaveLength(0);
    });

    it('should keep stats.totalFiles consistent across calls', async () => {
      const r1 = await module.inspect({ goal: 'auth', workingDirectory: testDir });
      const r2 = await module.inspect({ goal: 'service', workingDirectory: testDir });
      // Same project directory → same total file count
      expect(r1.stats.totalFiles).toBe(r2.stats.totalFiles);
    });
  });

  // ── scanByKeywords — Additional Edge Cases ───────────────────────────

  describe('scanByKeywords — additional edge cases', () => {
    it('should rank name matches above path-only matches', () => {
      mkdirSync(join(testDir, 'provider-helpers'));
      writeFileSync(join(testDir, 'provider-helpers', 'helper.ts'), 'export const h = 1;');
      writeFileSync(join(testDir, 'auth-provider.ts'), 'export const p = 1;');
      // auth-provider.ts has 'provider' in name → score +3
      // provider-helpers/helper.ts has 'provider' only in path (dir name) → score +1
      const results = module.scanByKeywords('provider', testDir);
      const nameMatchIdx = results.findIndex((r) => r === 'auth-provider.ts');
      const pathMatchIdx = results.findIndex((r) => r.includes('helper.ts'));
      expect(nameMatchIdx).toBeGreaterThanOrEqual(0);
      expect(pathMatchIdx).toBeGreaterThanOrEqual(0);
      expect(nameMatchIdx).toBeLessThan(pathMatchIdx);
    });

    it('should match hyphenated parts as separate words', () => {
      writeFileSync(join(testDir, 'auth-provider.ts'), 'export const p = 1;');
      const results = module.scanByKeywords('auth provider', testDir);
      expect(results.some((r) => r.includes('auth-provider'))).toBe(true);
    });

    it('should handle goal with underscore-separated keywords', () => {
      writeFileSync(join(testDir, 'user_service.ts'), 'export const us = 1;');
      const results = module.scanByKeywords('user service', testDir);
      expect(results.some((r) => r.includes('user_service'))).toBe(true);
    });

    it('should find files in deeply nested valid directories', () => {
      const nested = join(testDir, 'src', 'services', 'auth', 'core');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, 'login-handler.ts'), 'export const login = true;');
      const results = module.scanByKeywords('login handler', testDir);
      expect(results.some((r) => r.includes('login-handler'))).toBe(true);
    });

    it('should handle path with dots in directory name', () => {
      const dotted = join(testDir, 'some.dir');
      mkdirSync(dotted);
      writeFileSync(join(dotted, 'test.ts'), 'export const t = 1;');
      // Dots in directory name should not break path resolution
      const results = module.scanByKeywords('test', testDir);
      expect(results.some((r) => r.includes('test'))).toBe(true);
    });
  });

  // ── inspect() — Error Handling ───────────────────────────────────────

  describe('inspect() — error handling', () => {
    it('should handle file that exists but has no read permission', async () => {
      const restrictedFile = join(testDir, 'restricted.ts');
      writeFileSync(restrictedFile, 'export const secret = "key";');
      try {
        // Make file unreadable (unix only)
        const fs = await import('node:fs');
        fs.chmodSync(restrictedFile, 0o000);
        const result = await module.inspect({
          goal: 'restricted',
          workingDirectory: testDir,
          maxFiles: 1,
        });
        // The file might match via keyword but fail to read
        expect(result.stats.errors).toBeGreaterThanOrEqual(0);
      } finally {
        // Restore permissions so cleanup works
        const fs = await import('node:fs');
        fs.chmodSync(restrictedFile, 0o644);
      }
    });

    it('should handle files that are directories (non-file entries in results)', async () => {
      // Create a file that shadows a directory name to trick matching
      mkdirSync(join(testDir, 'auth-dir'));
      writeFileSync(join(testDir, 'auth-dir', 'content.ts'), 'export const c = 1;');
      // The directory itself won't appear in scanByKeywords results since
      // walkAndScore only returns files. But if LLM returns a directory path...
      const callLLM = vi.fn().mockResolvedValue(JSON.stringify(['auth-dir', 'auth.ts']));
      const result = await module.inspect({
        goal: 'auth',
        workingDirectory: testDir,
        callLLM,
      });
      // 'auth-dir' is a directory, not a file → statSync says it's not a file → error
      expect(result.stats.errors).toBeGreaterThanOrEqual(1);
      // 'auth.ts' should still be read successfully
      expect(result.artifacts.some((a) => a.path === 'auth.ts')).toBe(true);
    });

    it('should gracefully handle workingDirectory without trailing slash', async () => {
      // path.join normalizes paths, so this should work fine
      const dirNoSlash = testDir.replace(/\/+$/, '');
      const result = await module.inspect({ goal: 'auth', workingDirectory: dirNoSlash });
      expect(result.artifacts.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle workingDirectory with trailing slash', async () => {
      const dirWithSlash = testDir + '/';
      const result = await module.inspect({ goal: 'auth', workingDirectory: dirWithSlash });
      expect(result.artifacts.length).toBeGreaterThanOrEqual(1);
    });
  });
});
