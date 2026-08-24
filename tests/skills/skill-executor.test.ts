/**
 * Tests for the Skill Executor — language-agnostic skill execution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  detectRuntime,
  executeSkill,
  registerEnvPassthrough,
  getFilteredEnvPassthrough,
  clearEnvPassthrough,
  isEnvPassthroughAllowed,
} from '../../src/skills/skill-executor.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Skill Executor', () => {
  const tmpDir = join(tmpdir(), 'skill-exec-test');

  beforeEach(async () => {
    await mkdir(tmpDir, { recursive: true });
    clearEnvPassthrough();
  });

  afterEach(() => {
    clearEnvPassthrough();
  });

  describe('detectRuntime', () => {
    it('detects Python from frontmatter', () => {
      const content = '---\nruntime: python\n---\nprint("hello")';
      expect(detectRuntime(content)).toBe('python');
    });

    it('detects Node from frontmatter', () => {
      const content = '---\nruntime: node\n---\nconsole.log("hello")';
      expect(detectRuntime(content)).toBe('node');
    });

    it('detects shell from frontmatter', () => {
      const content = '---\nruntime: shell\n---\necho "hello"';
      expect(detectRuntime(content)).toBe('shell');
    });

    it('detects Python from file extension', () => {
      const content = 'print("hello")';
      expect(detectRuntime(content, 'skill.py')).toBe('python');
    });

    it('detects Node from file extension', () => {
      const content = 'console.log("hello")';
      expect(detectRuntime(content, 'skill.js')).toBe('node');
    });

    it('detects shell from file extension', () => {
      const content = 'echo "hello"';
      expect(detectRuntime(content, 'skill.sh')).toBe('shell');
    });

    it('detects Python from shebang', () => {
      const content = '#!/usr/bin/env python3\nprint("hello")';
      expect(detectRuntime(content)).toBe('python');
    });

    it('detects shell from bash shebang', () => {
      const content = '#!/bin/bash\necho "hello"';
      expect(detectRuntime(content)).toBe('shell');
    });

    it('defaults to shell for auto runtime', () => {
      const content = '---\nruntime: auto\n---\necho "hello"';
      expect(detectRuntime(content)).toBe('shell');
    });

    it('detects Node from TypeScript shebang', () => {
      const content = '#!/usr/bin/env tsx\nconsole.log("hello")';
      expect(detectRuntime(content)).toBe('node');
    });
  });

  describe('executeSkill', () => {
    it('executes a shell script', async () => {
      const script = 'echo "hello from shell"';
      const result = await executeSkill(script, { cwd: tmpDir });
      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe('hello from shell');
      expect(result.runtime).toBe('shell');
    });

    it('executes a Python script with shebang', async () => {
      const script = '#!/usr/bin/env python3\nprint("hello from python")';
      const result = await executeSkill(script, { cwd: tmpDir });
      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe('hello from python');
      expect(result.runtime).toBe('python');
    });

    it('executes a Node script', async () => {
      const script = 'console.log("hello from node")';
      const result = await executeSkill(script, { cwd: tmpDir, timeoutMs: 10000 });
      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe('hello from node');
      expect(result.runtime).toBe('node');
    });

    it('captures stderr', async () => {
      const script = 'echo "error" >&2';
      const result = await executeSkill(script, { cwd: tmpDir });
      expect(result.success).toBe(true);
      expect(result.stderr.trim()).toBe('error');
    });

    it('handles non-zero exit codes', async () => {
      const script = 'exit 1';
      const result = await executeSkill(script, { cwd: tmpDir });
      expect(result.success).toBe(false);
      // Windows may return 4294967295 (0xFFFFFFFF) instead of 1
      expect([1, 4294967295]).toContain(result.exitCode);
    });

    it('injects environment variables', async () => {
      const script = 'echo $MY_SKILL_VAR';
      const result = await executeSkill(script, {
        cwd: tmpDir,
        env: { MY_SKILL_VAR: 'injected-value' },
      });
      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe('injected-value');
    });

    it('reports duration', async () => {
      const script = 'echo "done"';
      const result = await executeSkill(script, { cwd: tmpDir });
      expect(result.durationMs).toBeGreaterThan(0);
    });
  });

  describe('env passthrough', () => {
    it('registers env vars for passthrough', () => {
      registerEnvPassthrough(['MY_API_KEY', 'MY_SECRET']);
      expect(isEnvPassthroughAllowed('MY_API_KEY')).toBe(true);
      expect(isEnvPassthroughAllowed('MY_SECRET')).toBe(true);
    });

    it('blocks provider credentials', () => {
      registerEnvPassthrough(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
      expect(isEnvPassthroughAllowed('ANTHROPIC_API_KEY')).toBe(false);
      expect(isEnvPassthroughAllowed('OPENAI_API_KEY')).toBe(false);
    });

    it('returns filtered env vars', () => {
      registerEnvPassthrough(['MY_API_KEY', 'MY_SECRET']);
      process.env.MY_API_KEY = 'key-123';
      process.env.MY_SECRET = 'secret-456';

      const filtered = getFilteredEnvPassthrough(['MY_API_KEY', 'MY_SECRET', 'ANTHROPIC_API_KEY']);
      expect(filtered).toEqual({
        MY_API_KEY: 'key-123',
        MY_SECRET: 'secret-456',
      });

      delete process.env.MY_API_KEY;
      delete process.env.MY_SECRET;
    });

    it('clears the allowlist', () => {
      registerEnvPassthrough(['MY_API_KEY']);
      expect(isEnvPassthroughAllowed('MY_API_KEY')).toBe(true);

      clearEnvPassthrough();
      expect(isEnvPassthroughAllowed('MY_API_KEY')).toBe(false);
    });
  });
});
