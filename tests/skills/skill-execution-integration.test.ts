/**
 * Integration Test — Proves skill execution works across Python, Node, and Shell.
 * 
 * This test verifies the complete execution flow:
 * 1. Read skill file from .agents/skills/
 * 2. Detect runtime from frontmatter/shebang
 * 3. Inject environment variables
 * 4. Execute script
 * 5. Capture and validate output
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executeSkill, detectRuntime, registerEnvPassthrough, clearEnvPassthrough } from '../../src/skills/skill-executor.js';

const SKILLS_DIR = join(process.cwd(), '.agents', 'skills');

describe('Skill Execution Integration', () => {
  beforeAll(() => {
    clearEnvPassthrough();
  });

  describe('Shell Skill — system-check', () => {
    it('executes system health check and returns structured output', async () => {
      const content = await readFile(join(SKILLS_DIR, 'system-check', 'check.sh'), 'utf-8');
      
      // Verify runtime detection
      expect(detectRuntime(content)).toBe('shell');
      
      // Execute the skill
      const result = await executeSkill(content, {
        cwd: process.cwd(),
        timeoutMs: 10000,
        args: ['--check', 'disk'],
      });
      
      // Verify execution
      expect(result.success).toBe(true);
      expect(result.runtime).toBe('shell');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Disk Space');
      expect(result.stdout).toContain('Usage:');
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it('handles threshold warnings', async () => {
      const content = await readFile(join(SKILLS_DIR, 'system-check', 'check.sh'), 'utf-8');
      
      const result = await executeSkill(content, {
        cwd: process.cwd(),
        timeoutMs: 10000,
        args: ['--check', 'disk', '--threshold', '1'], // Very low threshold to trigger warning
      });
      
      // Should still succeed but with warning
      expect(result.stdout).toContain('⚠️  WARNING');
    });
  });

  describe('Python Skill — image-gen', () => {
    it('executes image generation with API key injection', async () => {
      const content = await readFile(join(SKILLS_DIR, 'image-gen', 'generate.py'), 'utf-8');
      
      // Verify runtime detection
      expect(detectRuntime(content)).toBe('python');
      
      // Register env var for passthrough
      registerEnvPassthrough(['OPENAI_API_KEY']);
      process.env.OPENAI_API_KEY = 'test-key-123';
      
      // Execute the skill
      const result = await executeSkill(content, {
        cwd: process.cwd(),
        timeoutMs: 5000,
        env: { OPENAI_API_KEY: 'test-key-123' },
        args: ['--prompt', 'A sunset over mountains'],
      });
      
      // Verify execution
      expect(result.success).toBe(true);
      expect(result.runtime).toBe('python');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Generating image with prompt: A sunset over mountains');
      expect(result.stdout).toContain('✅ Image generated successfully!');
      expect(result.stdout).toContain('"success": true');
      
      // Cleanup
      delete process.env.OPENAI_API_KEY;
      clearEnvPassthrough();
    });

    it('fails gracefully when API key is missing', async () => {
      const content = await readFile(join(SKILLS_DIR, 'image-gen', 'generate.py'), 'utf-8');
      
      // Execute without API key
      const result = await executeSkill(content, {
        cwd: process.cwd(),
        timeoutMs: 5000,
        args: ['--prompt', 'Test'],
      });
      
      // Should fail with clear error
      expect(result.success).toBe(false);
      expect(result.stderr).toContain('OPENAI_API_KEY environment variable is not set');
    });
  });

  describe('Node Skill — api-call', () => {
    it('executes API call with environment variables', async () => {
      const content = await readFile(join(SKILLS_DIR, 'api-call', 'call.mjs'), 'utf-8');
      
      // Verify runtime detection
      expect(detectRuntime(content)).toBe('node');
      
      // Execute the skill
      const result = await executeSkill(content, {
        cwd: process.cwd(),
        timeoutMs: 10000,
        env: { 
          API_BASE_URL: 'https://jsonplaceholder.typicode.com',
          API_KEY: 'test-key'
        },
        args: ['--endpoint', '/posts/1', '--method', 'GET'],
      });
      
      // Verify execution
      expect(result.success).toBe(true);
      expect(result.runtime).toBe('node');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Making GET request to: https://jsonplaceholder.typicode.com/posts/1');
      expect(result.stdout).toContain('✅ Request successful!');
      expect(result.stdout).toContain('"success": true');
      expect(result.stdout).toContain('"status": 200');
    });

    it('fails gracefully when API_BASE_URL is missing', async () => {
      const content = await readFile(join(SKILLS_DIR, 'api-call', 'call.mjs'), 'utf-8');
      
      // Execute without API_BASE_URL
      const result = await executeSkill(content, {
        cwd: process.cwd(),
        timeoutMs: 5000,
        args: ['--endpoint', '/test'],
      });
      
      // Should fail with clear error
      expect(result.success).toBe(false);
      expect(result.stderr).toContain('API_BASE_URL environment variable is not set');
    });
  });

  describe('Cross-Language Execution', () => {
    it('executes all three languages in sequence', async () => {
      const shellContent = await readFile(join(SKILLS_DIR, 'system-check', 'check.sh'), 'utf-8');
      const pythonContent = await readFile(join(SKILLS_DIR, 'image-gen', 'generate.py'), 'utf-8');
      const nodeContent = await readFile(join(SKILLS_DIR, 'api-call', 'call.mjs'), 'utf-8');
      
      // Execute all three
      const [shellResult, pythonResult, nodeResult] = await Promise.all([
        executeSkill(shellContent, { cwd: process.cwd(), timeoutMs: 5000, args: ['--check', 'disk'] }),
        executeSkill(pythonContent, { cwd: process.cwd(), timeoutMs: 5000, env: { OPENAI_API_KEY: 'test' }, args: ['--prompt', 'Test'] }),
        executeSkill(nodeContent, { cwd: process.cwd(), timeoutMs: 5000, env: { API_BASE_URL: 'https://example.com' }, args: ['--endpoint', '/test'] }),
      ]);
      
      // All should succeed
      expect(shellResult.success).toBe(true);
      expect(pythonResult.success).toBe(true);
      expect(nodeResult.success).toBe(true);
      
      // All should have different runtimes
      expect(shellResult.runtime).toBe('shell');
      expect(pythonResult.runtime).toBe('python');
      expect(nodeResult.runtime).toBe('node');
      
      // All should have reasonable durations
      expect(shellResult.durationMs).toBeLessThan(5000);
      expect(pythonResult.durationMs).toBeLessThan(5000);
      expect(nodeResult.durationMs).toBeLessThan(5000);
    });
  });

  describe('Environment Variable Security', () => {
    it('blocks provider credentials from passthrough', async () => {
      const content = await readFile(join(SKILLS_DIR, 'image-gen', 'generate.py'), 'utf-8');
      
      // Save original values
      const originalAnthropic = process.env.ANTHROPIC_API_KEY;
      const originalOpenai = process.env.OPENAI_API_KEY;
      
      // Register blocked credentials
      registerEnvPassthrough(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
      
      // These should NOT be injected
      process.env.ANTHROPIC_API_KEY = 'should-not-be-injected';
      process.env.OPENAI_API_KEY = 'should-not-be-injected';
      
      // Execute without providing env vars explicitly
      const result = await executeSkill(content, {
        cwd: process.cwd(),
        timeoutMs: 5000,
        args: ['--prompt', 'Test'],
      });
      
      // Should fail because API key is not available (blocked by security)
      expect(result.success).toBe(false);
      expect(result.stderr).toContain('OPENAI_API_KEY environment variable is not set');
      
      // Restore original values
      if (originalAnthropic !== undefined) {
        process.env.ANTHROPIC_API_KEY = originalAnthropic;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
      if (originalOpenai !== undefined) {
        process.env.OPENAI_API_KEY = originalOpenai;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
      clearEnvPassthrough();
    });
  });
});
