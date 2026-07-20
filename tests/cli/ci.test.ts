/**
 * Tests for the CI/CD Headless Mode (buff ci) implementation.
 *
 * Covers:
 *   - CIExecuteResult, CIReviewResult, CICheckResult type shape
 *   - parseReviewOutput() helper for extracting structured findings
 *   - GitHub Actions annotation format
 *   - CLI command registration (via router)
 *   - Error handling and edge cases
 */

import { describe, it, expect } from 'vitest';

import {
  CICommand,
  parseReviewOutput,
  type CIExecuteResult,
  type CIReviewResult,
  type CIReviewFinding,
  type CICheckResult,
} from '../../src/cli/ci.js';

// ─── Test: Type Shapes ──────────────────────────────────────────────────────

describe('CI result types', () => {
  it('CIExecuteResult has all required fields', () => {
    const result: CIExecuteResult = {
      success: true,
      goal: 'test goal',
      summary: 'completed',
      tasksCompleted: 3,
      tasksTotal: 3,
      durationMs: 1000,
    };
    expect(result.success).toBe(true);
    expect(result.goal).toBe('test goal');
    expect(result.summary).toBe('completed');
    expect(result.tasksCompleted).toBe(3);
    expect(result.tasksTotal).toBe(3);
    expect(result.durationMs).toBe(1000);
  });

  it('CIExecuteResult accepts optional fields', () => {
    const result: CIExecuteResult = {
      success: false,
      goal: 'failing goal',
      summary: 'failed',
      tasksCompleted: 1,
      tasksTotal: 3,
      durationMs: 500,
      error: 'Something went wrong',
      fileChanges: [{ path: 'test.ts', status: 'modified', originalContent: '', newContent: '' }],
      fileChangesSummary: 'Modified test.ts',
      runOutput: 'npm test passed',
      trajectoryId: 'traj-001',
      provider: 'groq',
      model: 'llama-3.3-70b',
    };
    expect(result.error).toBe('Something went wrong');
    expect(result.fileChanges).toHaveLength(1);
    expect(result.fileChanges![0].path).toBe('test.ts');
    expect(result.trajectoryId).toBe('traj-001');
    expect(result.provider).toBe('groq');
  });

  it('CIReviewResult has all required fields', () => {
    const result: CIReviewResult = {
      success: true,
      filesReviewed: 2,
      totalFindings: 3,
      errors: 0,
      warnings: 2,
      infos: 1,
      findings: [],
      durationMs: 2000,
    };
    expect(result.success).toBe(true);
    expect(result.filesReviewed).toBe(2);
    expect(result.totalFindings).toBe(3);
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(2);
    expect(result.infos).toBe(1);
    expect(result.durationMs).toBe(2000);
  });

  it('CICheckResult has all required fields', () => {
    const result: CICheckResult = {
      passed: true,
      summary: 'All checks passed',
      durationMs: 1500,
    };
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('All checks passed');
    expect(result.durationMs).toBe(1500);
  });
});

// ─── Test: parseReviewOutput ────────────────────────────────────────────────

describe('parseReviewOutput', () => {
  it('parses ERROR prefixed lines', () => {
    const findings = parseReviewOutput('src/test.ts', 'ERROR: Null pointer risk on line 42');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('error');
    expect(findings[0].message).toContain('Null pointer risk');
    expect(findings[0].line).toBe(42);
    expect(findings[0].file).toBe('src/test.ts');
  });

  it('parses WARNING prefixed lines', () => {
    const findings = parseReviewOutput('src/api.ts', 'WARNING: Unused variable detected');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].message).toContain('Unused variable');
  });

  it('parses INFO prefixed lines', () => {
    const findings = parseReviewOutput('src/utils.ts', 'INFO: Consider adding error handling');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('info');
    expect(findings[0].message).toContain('Consider adding error handling');
  });

  it('parses emoji-prefixed lines', () => {
    const findings1 = parseReviewOutput('src/test.ts', '❌ Security vulnerability in input validation');
    expect(findings1[0].severity).toBe('error');

    const findings2 = parseReviewOutput('src/test.ts', '⚠️ This could be optimized');
    expect(findings2[0].severity).toBe('warning');

    const findings3 = parseReviewOutput('src/test.ts', '💡 Could use a helper function');
    expect(findings3[0].severity).toBe('info');
  });

  it('parses checklist items', () => {
    const unchecked = parseReviewOutput('src/test.ts', '- [ ] Add input validation');
    expect(unchecked[0].severity).toBe('warning');
    expect(unchecked[0].message).toContain('Add input validation');

    const checked = parseReviewOutput('src/test.ts', '* [x] Add input validation');
    expect(checked[0].severity).toBe('info');
  });

  it('extracts line numbers from messages', () => {
    const findings = parseReviewOutput('src/test.ts', 'ERROR: line 99: Outdated API call');
    expect(findings[0].line).toBe(99);
  });

  it('extracts suggestion from Suggestion: prefix', () => {
    const findings = parseReviewOutput('src/test.ts', 'WARNING: Hardcoded secret. Suggestion: Use env vars');
    expect(findings[0].suggestion).toBe('Use env vars');
  });

  it('extracts suggestion from -> arrow', () => {
    const findings = parseReviewOutput('src/test.ts', 'ERROR: Inefficient query -> Add an index');
    expect(findings[0].suggestion).toBe('Add an index');
  });

  it('creates a generic info finding for unclassified lines', () => {
    const findings = parseReviewOutput('src/test.ts', 'This is a normal sentence without a prefix.\nAnd another one.');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('info');
  });

  it('creates generic finding when no structured output found but text exists', () => {
    const findings = parseReviewOutput('src/test.ts', 'Single unclassified line');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('info');
    expect(findings[0].file).toBe('src/test.ts');
  });

  it('handles multiple findings in one text', () => {
    const text = [
      'ERROR: line 10: Memory leak detected',
      'WARNING: line 25: Consider using const',
      'INFO: line 30: Variable name could be clearer',
    ].join('\n');

    const findings = parseReviewOutput('src/test.ts', text);
    expect(findings).toHaveLength(3);
    expect(findings[0].severity).toBe('error');
    expect(findings[1].severity).toBe('warning');
    expect(findings[2].severity).toBe('info');
  });

  it('cleans up leading/trailing punctuation from message', () => {
    const findings = parseReviewOutput('src/test.ts', 'ERROR: : Null check missing:');
    expect(findings[0].message).not.toMatch(/^[:.,\s]/);
    expect(findings[0].message).not.toMatch(/[:.,\s]$/);
  });
});

// ─── Test: CICommand CLI Registration ───────────────────────────────────────

describe('CICommand CLI registration', () => {
  const command = new CICommand();

  it('creates a ci command with execute, check, and review subcommands', () => {
    const cmd = command.create();
    expect(cmd.name()).toBe('ci');
    expect(cmd.description()).toContain('CI/CD');
  });

  it('has execute subcommand', () => {
    const cmd = command.create();
    const executeCmd = cmd.commands.find((c) => c.name() === 'execute');
    expect(executeCmd).toBeDefined();
    expect(executeCmd!.description()).toContain('Execute');
  });

  it('has check subcommand', () => {
    const cmd = command.create();
    const checkCmd = cmd.commands.find((c) => c.name() === 'check');
    expect(checkCmd).toBeDefined();
    expect(checkCmd!.description()).toContain('gate');
  });

  it('has review subcommand', () => {
    const cmd = command.create();
    const reviewCmd = cmd.commands.find((c) => c.name() === 'review');
    expect(reviewCmd).toBeDefined();
    expect(reviewCmd!.description()).toContain('Review');
  });

  it('execute subcommand expects a goal argument', () => {
    const cmd = command.create();
    const executeCmd = cmd.commands.find((c) => c.name() === 'execute')!;
    // Commander stores args in the command
    expect(executeCmd.args).toBeDefined();
  });

  it('review subcommand expects files arguments', () => {
    const cmd = command.create();
    const reviewCmd = cmd.commands.find((c) => c.name() === 'review')!;
    expect(reviewCmd.args).toBeDefined();
  });

  it('check subcommand has --verbose flag', () => {
    const cmd = command.create();
    const checkCmd = cmd.commands.find((c) => c.name() === 'check')!;
    const verboseOption = checkCmd.options.find((o) => o.long === '--verbose');
    expect(verboseOption).toBeDefined();
  });

  it('execute subcommand has --github-annotations flag', () => {
    const cmd = command.create();
    const executeCmd = cmd.commands.find((c) => c.name() === 'execute')!;
    const annotationOption = executeCmd.options.find((o) => o.long === '--github-annotations');
    expect(annotationOption).toBeDefined();
  });
});

// ─── Test: Edge Cases ───────────────────────────────────────────────────────

describe('parseReviewOutput edge cases', () => {
  it('handles empty text', () => {
    const findings = parseReviewOutput('src/test.ts', '');
    expect(findings).toHaveLength(0);
  });

  it('handles text with only whitespace', () => {
    const findings = parseReviewOutput('src/test.ts', '   \n  \n   ');
    expect(findings).toHaveLength(0);
  });

  it('handles very long lines gracefully', () => {
    const longLine = 'WARNING: ' + 'x'.repeat(2000);
    const findings = parseReviewOutput('src/test.ts', longLine);
    expect(findings).toHaveLength(1);
    expect(findings[0].message.length).toBeLessThanOrEqual(2000);
  });

  it('handles mixed case severity prefixes', () => {
    expect(parseReviewOutput('src/test.ts', 'Error: something')[0].severity).toBe('error');
    expect(parseReviewOutput('src/test.ts', 'Warning: something')[0].severity).toBe('warning');
    expect(parseReviewOutput('src/test.ts', 'Info: something')[0].severity).toBe('info');
  });
});
