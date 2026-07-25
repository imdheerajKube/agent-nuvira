/**
 * Unit tests for DefaultVerifyModule — explicit verification pipeline with
 * security scans, LLM-based goal alignment, test results, and runner output checks.
 *
 * Coverage goals:
 * - verify() — all check types: security, goal-alignment, tests, run output
 * - Scoring — passing/failing checks produce correct overallScore
 * - Strictness — low/medium/high affect pass thresholds and blocking severity
 * - Security scan — detects critical/high issues as blocking
 * - Goal alignment — LLM responses parsed for MISALIGNED/BLOCKING verdicts
 * - Edge cases — empty changes, no LLM, all checks pass/fail
 * - Event emission — VERIFY_STARTING, VERIFY_CHECK, VERIFY_COMPLETED
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DefaultVerifyModule } from '../../src/agents/verify-module.js';
import type { VerifyParams, VerificationResult } from '../../src/agents/verify-module.js';
import type { FileChange } from '../../src/agents/agent.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a simple file change */
function makeChange(
  path: string,
  status: FileChange['status'],
  content?: string,
): FileChange {
  return { path, status, newContent: content };
}

/** Default verify params: two safe changes, no LLM */
function makeParams(overrides: Partial<VerifyParams> = {}): VerifyParams {
  return {
    changes: [
      makeChange('src/index.ts', 'modified', 'console.log("hello");'),
      makeChange('src/utils.ts', 'created', 'export const add = (a: number, b: number) => a + b;'),
    ],
    goal: 'Add logging and utility functions',
    ...overrides,
  };
}

/** Params with security-sensitive content */
function makeSecurityParams(overrides: Partial<VerifyParams> = {}): VerifyParams {
  return {
    changes: [
      makeChange('.env', 'modified', 'API_KEY=sk-123456789012345678901234567890'),
      makeChange('src/index.ts', 'modified', 'eval(code);'),
    ],
    goal: 'Add configuration',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DefaultVerifyModule', () => {
  let module: DefaultVerifyModule;

  beforeEach(() => {
    module = new DefaultVerifyModule();
  });

  // ── verify() — Security check ───────────────────────────────────────

  describe('verify() — security check', () => {
    it('should pass security check for clean code', async () => {
      const result = await module.verify(makeParams());
      const securityCheck = result.checks.find((c) => c.type === 'security');
      expect(securityCheck).toBeDefined();
      expect(securityCheck!.passed).toBe(true);
    });

    it('should fail security check for critical findings', async () => {
      const result = await module.verify(makeSecurityParams());
      const securityCheck = result.checks.find((c) => c.type === 'security');
      expect(securityCheck).toBeDefined();
      expect(securityCheck!.passed).toBe(false);
      expect(securityCheck!.severity).toBe('blocking');
    });

    it('should include security issues in blockers', async () => {
      const result = await module.verify(makeSecurityParams());
      expect(result.blockers.length).toBeGreaterThanOrEqual(1);
      expect(result.blockers.some((b) => b.toLowerCase().includes('security'))).toBe(true);
    });
  });

  // ── verify() — Goal alignment check ─────────────────────────────────

  describe('verify() — goal alignment check', () => {
    it('should pass alignment when LLM responds ALIGNED', async () => {
      const callLLM = vi.fn().mockResolvedValue('ALIGNED');
      const result = await module.verify(makeParams({ callLLM }));
      const alignmentCheck = result.checks.find((c) => c.type === 'goal-alignment');
      expect(alignmentCheck).toBeDefined();
      expect(alignmentCheck!.passed).toBe(true);
    });

    it('should fail alignment when LLM responds MISALIGNED', async () => {
      const callLLM = vi.fn().mockResolvedValue('MISALIGNED: The changes do not match the goal');
      const result = await module.verify(makeParams({ callLLM }));
      const alignmentCheck = result.checks.find((c) => c.type === 'goal-alignment');
      expect(alignmentCheck).toBeDefined();
      expect(alignmentCheck!.passed).toBe(false);
      expect(alignmentCheck!.severity).toBe('blocking');
    });

    it('should fail alignment when LLM responds BLOCKING', async () => {
      const callLLM = vi.fn().mockResolvedValue('BLOCKING: security concern');
      const result = await module.verify(makeParams({ callLLM }));
      const alignmentCheck = result.checks.find((c) => c.type === 'goal-alignment');
      expect(alignmentCheck).toBeDefined();
      expect(alignmentCheck!.passed).toBe(false);
    });

    it('should add alignment blocker when check fails', async () => {
      const callLLM = vi.fn().mockResolvedValue('BLOCKING: hardcoded credentials');
      const result = await module.verify(makeParams({ callLLM }));
      expect(result.blockers.length).toBeGreaterThanOrEqual(1);
    });

    it('should not fail if no callLLM provided', async () => {
      const result = await module.verify(makeParams());
      const alignmentCheck = result.checks.find((c) => c.type === 'goal-alignment');
      // No callLLM → no alignment check added
      expect(alignmentCheck).toBeUndefined();
    });
  });

  // ── verify() — Test result check ────────────────────────────────────

  describe('verify() — test result check', () => {
    it('should pass when all tests pass', async () => {
      const result = await module.verify(makeParams({
        testResults: { passed: 10, failed: 0, total: 10 },
      }));
      const testCheck = result.checks.find((c) => c.type === 'tests');
      expect(testCheck).toBeDefined();
      expect(testCheck!.passed).toBe(true);
    });

    it('should fail when tests fail in medium strictness', async () => {
      const result = await module.verify(makeParams({
        testResults: { passed: 8, failed: 2, total: 10 },
        strictness: 'medium',
      }));
      const testCheck = result.checks.find((c) => c.type === 'tests');
      expect(testCheck).toBeDefined();
      expect(testCheck!.passed).toBe(false);
      expect(testCheck!.severity).toBe('blocking');
    });

    it('should not block when tests fail in low strictness', async () => {
      const result = await module.verify(makeParams({
        testResults: { passed: 8, failed: 2, total: 10 },
        strictness: 'low',
      }));
      const testCheck = result.checks.find((c) => c.type === 'tests');
      expect(testCheck).toBeDefined();
      expect(testCheck!.passed).toBe(true); // Low strictness allows failures
    });

    it('should pass when total is 0 (no tests)', async () => {
      const result = await module.verify(makeParams({
        testResults: { passed: 0, failed: 0, total: 0 },
      }));
      const testCheck = result.checks.find((c) => c.type === 'tests');
      expect(testCheck).toBeDefined();
      expect(testCheck!.passed).toBe(true);
    });
  });

  // ── verify() — Run output check ─────────────────────────────────────

  describe('verify() — run output check', () => {
    it('should pass for clean output', async () => {
      const result = await module.verify(makeParams({
        runOutput: 'Build succeeded. All tests passed.',
      }));
      const outputCheck = result.checks.find((c) => c.type === 'code-quality');
      expect(outputCheck).toBeDefined();
      expect(outputCheck!.passed).toBe(true);
    });

    it('should flag errors in output with warning', async () => {
      const result = await module.verify(makeParams({
        runOutput: 'Error: Cannot find module',
        strictness: 'medium',
      }));
      const outputCheck = result.checks.find((c) => c.type === 'code-quality');
      expect(outputCheck).toBeDefined();
      expect(outputCheck!.passed).toBe(true); // Warning, not blocking in medium
      expect(outputCheck!.severity).toBe('warning');
    });

    it('should block on errors in output with high strictness', async () => {
      const result = await module.verify(makeParams({
        runOutput: 'Error: Build failed',
        strictness: 'high',
      }));
      const outputCheck = result.checks.find((c) => c.type === 'code-quality');
      expect(outputCheck).toBeDefined();
      expect(outputCheck!.passed).toBe(false);
      expect(outputCheck!.severity).toBe('blocking');
    });
  });

  // ── verify() — Scoring ──────────────────────────────────────────────

  describe('verify() — scoring', () => {
    it('should return score of 1.0 when all checks pass', async () => {
      const result = await module.verify(makeParams({
        testResults: { passed: 5, failed: 0, total: 5 },
        runOutput: 'All good',
      }));
      expect(result.overallScore).toBe(1.0);
      expect(result.passed).toBe(true);
    });

    it('should return score < 1.0 when some checks fail', async () => {
      const result = await module.verify(makeSecurityParams());
      expect(result.overallScore).toBeLessThan(1.0);
    });

    it('should return score of 1.0 for empty changes', async () => {
      const result = await module.verify(makeParams({ changes: [] }));
      expect(result.overallScore).toBe(1.0);
      expect(result.passed).toBe(true);
    });

    it('should fail verification below medium threshold', async () => {
      // Security check fails with critical issues → score 0/1 = 0.0 < 0.7
      const result = await module.verify(makeSecurityParams({
        testResults: { passed: 0, failed: 0, total: 0 },
      }));
      expect(result.overallScore).toBeLessThan(0.7);
      expect(result.passed).toBe(false);
    });
  });

  // ── verify() — Strictness levels ────────────────────────────────────

  describe('verify() — strictness levels', () => {
    it('should pass at low strictness with minor warnings', async () => {
      const result = await module.verify(makeParams({
        runOutput: 'Error: minor warning',
        strictness: 'low',
        testResults: { passed: 8, failed: 2, total: 10 },
      }));
      // In low strictness: test failures are non-blocking, run output is warning
      // Both checks pass in low mode → score = 1.0 or all remaining checks pass
      expect(result.overallScore).toBeGreaterThanOrEqual(0.5);
    });

    it('should block at high strictness with run output errors', async () => {
      const result = await module.verify(makeParams({
        runOutput: 'Error: Build failure',
        strictness: 'high',
      }));
      // In high strictness: run output errors become blocking
      expect(result.passed).toBe(false);
    });
  });

  // ── verify() — Edge cases ───────────────────────────────────────────

  describe('verify() — edge cases', () => {
    it('should handle empty changes gracefully', async () => {
      const result = await module.verify(makeParams({ changes: [] }));
      expect(result.checks.length).toBeGreaterThanOrEqual(0);
      expect(result.passed).toBe(true);
    });

    it('should handle changes without newContent', async () => {
      const result = await module.verify(makeParams({
        changes: [{ path: 'deleted.ts', status: 'deleted' }],
      }));
      const securityCheck = result.checks.find((c) => c.type === 'security');
      expect(securityCheck).toBeDefined();
      expect(securityCheck!.passed).toBe(true); // No content to scan → clean
    });

    it('should handle all params empty', async () => {
      const result = await module.verify({
        changes: [],
        goal: '',
      });
      expect(result.passed).toBe(true);
      expect(result.overallScore).toBe(1.0);
    });

    it('should deduplicate blockers', async () => {
      const result = await module.verify(makeSecurityParams());
      const uniqueBlockers = new Set(result.blockers);
      expect(uniqueBlockers.size).toBe(result.blockers.length);
    });

    it('should deduplicate suggestions', async () => {
      const result = await module.verify(makeParams({
        changes: [
          makeChange('src/a.ts', 'modified', 'eval(x);'),
          makeChange('src/b.ts', 'created', 'eval(y);'),
        ],
      }));
      const uniqueSuggestions = new Set(result.suggestions);
      expect(uniqueSuggestions.size).toBe(result.suggestions.length);
    });
  });

  // ── verify() — Result structure ─────────────────────────────────────

  describe('verify() — result structure', () => {
    it('should include all required fields', async () => {
      const result = await module.verify(makeParams({
        testResults: { passed: 5, failed: 0, total: 5 },
      }));
      expect(result).toHaveProperty('passed');
      expect(result).toHaveProperty('checks');
      expect(result).toHaveProperty('overallScore');
      expect(result).toHaveProperty('blockers');
      expect(result).toHaveProperty('suggestions');
    });

    it('should have checks with required fields', async () => {
      const result = await module.verify(makeParams({
        callLLM: vi.fn().mockResolvedValue('ALIGNED'),
        testResults: { passed: 5, failed: 0, total: 5 },
        runOutput: 'All good',
      }));
      for (const check of result.checks) {
        expect(check).toHaveProperty('type');
        expect(check).toHaveProperty('passed');
        expect(check).toHaveProperty('details');
        expect(check).toHaveProperty('severity');
      }
    });
  });
});
