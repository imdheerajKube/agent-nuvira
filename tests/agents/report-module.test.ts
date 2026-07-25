/**
 * Unit tests for DefaultReportModule — structured execution report generation
 * and multi-format output (text, json, markdown, github-annotation).
 *
 * Coverage goals:
 * - generate() — happy path, failure path, empty results, all optional fields
 * - format() — each of the 4 formatters produces correct output structure
 * - generateFollowUp (via report.followUp) — error path, low verification,
 *   review present, file changes present
 * - formatDuration (via report.details.duration) — sub-second, seconds,
 *   minutes, hours, edge cases
 * - generateScoreBar (via text format verification line) — 0%, 50%, 100%
 * - Edge cases — missing optional fields, empty arrays, very long strings
 * - Unknown format name falls back to JSON
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DefaultReportModule } from '../../src/agents/report-module.js';
import type { ReportParams, ExecutionReport, ReportFormat } from '../../src/agents/report-module.js';

// ─── Factory Helpers ────────────────────────────────────────────────────────

/** Build minimal ReportParams for a given scenario */
function makeParams(overrides: Partial<ReportParams> = {}): ReportParams {
  return {
    goal: 'Implement JWT authentication',
    agentResults: [
      { agent: 'planner', success: true, summary: 'Created execution plan with 3 steps' },
      { agent: 'writer', success: true, summary: 'Updated auth/login.ts and auth/middleware.ts' },
      { agent: 'tester', success: true, summary: 'All 12 tests passed' },
    ],
    fileChanges: [
      { path: 'src/auth/login.ts', status: 'modified' },
      { path: 'src/auth/middleware.ts', status: 'created' },
    ],
    hasFailures: false,
    durationMs: 5420,
    ...overrides,
  };
}

/** Build params for a failure scenario */
function makeFailureParams(overrides: Partial<ReportParams> = {}): ReportParams {
  return makeParams({
    goal: 'Implement JWT authentication',
    agentResults: [
      { agent: 'planner', success: true, summary: 'Created execution plan' },
      { agent: 'writer', success: true, summary: 'Wrote code' },
      { agent: 'tester', success: false, summary: '3 of 12 tests failed with auth timeout' },
    ],
    hasFailures: true,
    error: 'Tests failed: auth/login.test.ts timed out after 5000ms',
    ...overrides,
  });
}

/** Build an ExecutionReport directly for formatter-only tests */
function makeReport(overrides: Partial<ExecutionReport> = {}): ExecutionReport {
  return {
    success: true,
    summary: 'Completed all 3 tasks successfully in 5.4s',
    details: {
      goal: 'Implement JWT authentication',
      tasksCompleted: 3,
      tasksTotal: 3,
      duration: '5.4s',
      agentBreakdown: [
        { agent: 'planner', status: 'passed', summary: 'Created execution plan' },
        { agent: 'writer', status: 'passed', summary: 'Wrote code' },
      ],
      fileChanges: [
        { path: 'src/auth/login.ts', status: 'modified' },
        { path: 'src/auth/middleware.ts', status: 'created' },
      ],
    },
    meta: {
      durationMs: 5420,
    },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DefaultReportModule', () => {
  let module: DefaultReportModule;

  beforeEach(() => {
    module = new DefaultReportModule();
  });

  // ── generate() ────────────────────────────────────────────────────────

  describe('generate()', () => {
    it('should produce a success report when all agents pass', async () => {
      const report = await module.generate(makeParams());

      expect(report.success).toBe(true);
      expect(report.summary).toContain('Completed all 3 tasks successfully');
      expect(report.details.tasksCompleted).toBe(3);
      expect(report.details.tasksTotal).toBe(3);
      expect(report.details.error).toBeUndefined();
    });

    it('should produce a failure report when agents fail', async () => {
      const report = await module.generate(makeFailureParams());

      expect(report.success).toBe(false);
      expect(report.summary).toContain('with some failures');
      expect(report.details.tasksCompleted).toBe(2);
      expect(report.details.tasksTotal).toBe(3);
      expect(report.details.error).toContain('Tests failed');
    });

    it('should include agent breakdown with correct status mapping', async () => {
      const report = await module.generate(makeParams({
        agentResults: [
          { agent: 'planner', success: true, summary: 'OK' },
          { agent: 'writer', success: false, summary: 'Failed' },
        ],
      }));

      expect(report.details.agentBreakdown).toHaveLength(2);
      expect(report.details.agentBreakdown[0].status).toBe('passed');
      expect(report.details.agentBreakdown[1].status).toBe('failed');
    });

    it('should handle empty agent results', async () => {
      const report = await module.generate(makeParams({ agentResults: [] }));

      expect(report.details.agentBreakdown).toHaveLength(0);
      expect(report.details.tasksCompleted).toBe(0);
      expect(report.details.tasksTotal).toBe(0);
      expect(report.success).toBe(true);
    });

    it('should handle empty file changes', async () => {
      const report = await module.generate(makeParams({ fileChanges: [] }));

      expect(report.details.fileChanges).toHaveLength(0);
    });

    it('should include test summary when provided', async () => {
      const report = await module.generate(makeParams({
        testSummary: '12 passed, 0 failed, 3 skipped',
      }));

      expect(report.details.testSummary).toBe('12 passed, 0 failed, 3 skipped');
    });

    it('should include verification score when provided', async () => {
      const report = await module.generate(makeParams({ verificationScore: 0.85 }));

      expect(report.details.verificationScore).toBe(0.85);
    });

    it('should include trajectory ID in meta', async () => {
      const report = await module.generate(makeParams({ trajectoryId: 'traj-abc-123' }));

      expect(report.meta?.trajectoryId).toBe('traj-abc-123');
    });

    it('should include review ID in meta', async () => {
      const report = await module.generate(makeParams({ reviewId: 'review-42' }));

      expect(report.meta?.reviewId).toBe('review-42');
    });

    it('should include run output in meta', async () => {
      const report = await module.generate(makeParams({ runOutput: 'Build succeeded' }));

      expect(report.meta?.runOutput).toBe('Build succeeded');
    });

    it('should include error in details when pipeline fails', async () => {
      const report = await module.generate(makeFailureParams({ error: 'Runtime error in writer' }));

      expect(report.details.error).toBe('Runtime error in writer');
    });

    it('should format duration correctly (sub-second, returns ms)', async () => {
      const report = await module.generate(makeParams({ durationMs: 450 }));

      // formatDuration returns '{ms}ms' for durations under 1 second
      expect(report.details.duration).toBe('450ms');
    });

    it('should format duration correctly (1.2s)', async () => {
      const report = await module.generate(makeParams({ durationMs: 1200 }));

      expect(report.details.duration).toBe('1.2s');
    });

    it('should format duration correctly (minutes)', async () => {
      const report = await module.generate(makeParams({ durationMs: 125_000 }));

      expect(report.details.duration).toBe('2m 5s');
    });

    it('should format duration correctly (hours)', async () => {
      const report = await module.generate(makeParams({ durationMs: 7_234_000 }));

      expect(report.details.duration).toBe('2h 0m 34s');
    });

    it('should include follow-up suggestions for failure reports', async () => {
      const report = await module.generate(makeFailureParams());

      expect(report.followUp).toBeDefined();
      expect(report.followUp!.suggestedActions.length).toBeGreaterThan(0);
      expect(report.followUp!.suggestedActions.some((a) => a.includes('Review the error'))).toBe(true);
    });

    it('should include follow-up suggestions for low verification score', async () => {
      const report = await module.generate(makeParams({
        verificationScore: 0.3,
        hasFailures: false,
      }));

      expect(report.followUp).toBeDefined();
      expect(report.followUp!.suggestedActions.some(
        (a) => a.toLowerCase().includes('verification') || a.toLowerCase().includes('review'),
      )).toBe(true);
    });

    it('should include follow-up suggestions when reviewId is present', async () => {
      const report = await module.generate(makeParams({
        reviewId: 'review-99',
        hasFailures: false,
      }));

      expect(report.followUp).toBeDefined();
      expect(report.followUp!.suggestedActions.some((a) => a.includes('approve'))).toBe(true);
    });

    it('should return undefined followUp for simple success without changes', async () => {
      const report = await module.generate(makeParams({
        agentResults: [{ agent: 'planner', success: true, summary: 'Done' }],
        fileChanges: [],
        hasFailures: false,
      }));

      expect(report.followUp).toBeUndefined();
    });
  });

  // ── format() — text ──────────────────────────────────────────────────

  describe('format() — text', () => {
    it('should include success emoji for passed reports', () => {
      const report = makeReport({ success: true });
      const output = module.format(report, 'text');

      expect(output).toContain('✅');
      expect(output).not.toContain('❌');
    });

    it('should include failure emoji for failed reports', () => {
      const report = makeReport({ success: false, summary: 'Failed 2/3 tasks' });
      const output = module.format(report, 'text');

      expect(output).toContain('❌');
    });

    it('should include the goal (truncated if > 120 chars)', () => {
      const longGoal = 'Implement '.repeat(20); // 200 chars
      const report = makeReport({ details: { ...makeReport().details, goal: longGoal } });
      const output = module.format(report, 'text');

      expect(output).toContain('Goal:');
      expect(output).toContain('(truncated)');
    });

    it('should include duration and task counts', () => {
      const output = module.format(makeReport(), 'text');

      expect(output).toContain('Duration:');
      expect(output).toContain('Tasks: 3/3 completed');
    });

    it('should include error line when present', () => {
      const report = makeReport({
        success: false,
        details: { ...makeReport().details, error: 'Test failure timeout' },
      });
      const output = module.format(report, 'text');

      expect(output).toContain('Error:');
      expect(output).toContain('Test failure timeout');
    });

    it('should include agent breakdown section', () => {
      const output = module.format(makeReport(), 'text');

      expect(output).toContain('Agent Results:');
      expect(output).toContain('planner');
      expect(output).toContain('writer');
    });

    it('should include file changes section', () => {
      const output = module.format(makeReport(), 'text');

      expect(output).toContain('File Changes:');
      expect(output).toContain('src/auth/login.ts');
      expect(output).toContain('src/auth/middleware.ts');
    });

    it('should include file change status icons', () => {
      const report = makeReport({
        details: {
          ...makeReport().details,
          fileChanges: [
            { path: 'new.ts', status: 'created' as const },
            { path: 'edit.ts', status: 'modified' as const },
            { path: 'del.ts', status: 'deleted' as const },
            { path: 'same.ts', status: 'unchanged' as const },
          ],
        },
      });
      const output = module.format(report, 'text');

      expect(output).toContain('🆕');
      expect(output).toContain('✏️');
      expect(output).toContain('🗑️');
      expect(output).toContain('➖');
    });

    it('should include test summary when present', () => {
      const report = makeReport({
        details: { ...makeReport().details, testSummary: '12 passed, 0 failed' },
      });
      const output = module.format(report, 'text');

      expect(output).toContain('Tests:');
      expect(output).toContain('12 passed, 0 failed');
    });

    it('should include verification score bar when present', () => {
      const report = makeReport({
        details: { ...makeReport().details, verificationScore: 0.7 },
      });
      const output = module.format(report, 'text');

      expect(output).toContain('Verification:');
      expect(output).toContain('70%');
      expect(output).toContain('['); // score bar brackets
    });

    it('should generate a proper score bar for 0% score', () => {
      const report = makeReport({
        details: { ...makeReport().details, verificationScore: 0 },
      });
      const output = module.format(report, 'text');

      expect(output).toContain('0%');
      expect(output).toMatch(/\[[░]+\]/); // all empty
    });

    it('should generate a proper score bar for 100% score', () => {
      const report = makeReport({
        details: { ...makeReport().details, verificationScore: 1.0 },
      });
      const output = module.format(report, 'text');

      expect(output).toContain('100%');
      expect(output).toMatch(/\[[█]+\]/); // all filled
    });

    it('should include trajectory ID in meta', () => {
      const report = makeReport({ meta: { durationMs: 100, trajectoryId: 'traj-xyz' } });
      const output = module.format(report, 'text');

      expect(output).toContain('Trajectory:');
      expect(output).toContain('traj-xyz');
    });

    it('should include review ID in meta', () => {
      const report = makeReport({ meta: { durationMs: 100, reviewId: 'review-77' } });
      const output = module.format(report, 'text');

      expect(output).toContain('Review:');
      expect(output).toContain('review-77');
    });

    it('should handle report without file changes', () => {
      const report = makeReport({
        details: { ...makeReport().details, fileChanges: [] },
      });
      const output = module.format(report, 'text');

      expect(output).not.toContain('File Changes:');
    });

    it('should handle report without agent breakdown', () => {
      const report = makeReport({
        details: { ...makeReport().details, agentBreakdown: [] },
      });
      const output = module.format(report, 'text');

      expect(output).not.toContain('Agent Results:');
    });
  });

  // ── format() — markdown ──────────────────────────────────────────────

  describe('format() — markdown', () => {
    it('should start with an H1 heading', () => {
      const output = module.format(makeReport(), 'markdown');

      expect(output).toMatch(/^# /);
      expect(output).toContain('Execution Report');
    });

    it('should include summary table', () => {
      const output = module.format(makeReport(), 'markdown');

      expect(output).toContain('## Summary');
      expect(output).toContain('| Metric | Value |');
    });

    it('should include success status in summary table', () => {
      const output = module.format(makeReport({ success: true }), 'markdown');

      expect(output).toContain('✅ Passed');
    });

    it('should include failure status in summary table', () => {
      const output = module.format(makeReport({ success: false }), 'markdown');

      expect(output).toContain('❌ Failed');
    });

    it('should include verification score in summary table', () => {
      const report = makeReport({
        details: { ...makeReport().details, verificationScore: 0.85 },
      });
      const output = module.format(report, 'markdown');

      expect(output).toContain('85%');
    });

    it('should include error in summary table', () => {
      const report = makeReport({
        success: false,
        details: { ...makeReport().details, error: 'Deploy failed' },
      });
      const output = module.format(report, 'markdown');

      expect(output).toContain('Deploy failed');
    });

    it('should include agent results table', () => {
      const output = module.format(makeReport(), 'markdown');

      expect(output).toContain('## Agent Results');
      expect(output).toContain('| Agent | Status | Summary |');
      expect(output).toContain('**planner**');
      expect(output).toContain('**writer**');
    });

    it('should include file changes table', () => {
      const output = module.format(makeReport(), 'markdown');

      expect(output).toContain('## File Changes');
      expect(output).toContain('| File | Status |');
      expect(output).toContain('src/auth/login.ts');
    });

    it('should include test results section', () => {
      const report = makeReport({
        details: { ...makeReport().details, testSummary: 'All 15 tests green' },
      });
      const output = module.format(report, 'markdown');

      expect(output).toContain('## Test Results');
      expect(output).toContain('All 15 tests green');
    });

    it('should include suggested next steps section with followUp', () => {
      const report = makeReport({
        followUp: {
          suggestedActions: ['Review the error: something broke', 'Re-run with --verbose'],
          confidence: 'high',
        },
      });
      const output = module.format(report, 'markdown');

      expect(output).toContain('## Suggested Next Steps');
      expect(output).toContain('1. Review the error');
      expect(output).toContain('2. Re-run with --verbose');
    });

    it('should include metadata section', () => {
      const report = makeReport({
        meta: { durationMs: 5420, trajectoryId: 'traj-1', reviewId: 'review-2' },
      });
      const output = module.format(report, 'markdown');

      expect(output).toContain('**Trajectory ID:**');
      expect(output).toContain('**Review ID:**');
      expect(output).toContain('**Duration:**');
      expect(output).toContain('traj-1');
      expect(output).toContain('review-2');
    });

    it('should handle report without followUp', () => {
      const report = makeReport({ followUp: undefined });
      const output = module.format(report, 'markdown');

      expect(output).not.toContain('Suggested Next Steps');
    });

    it('should handle report without meta', () => {
      const report = makeReport({ meta: undefined });
      const output = module.format(report, 'markdown');

      expect(output).not.toContain('**Trajectory ID:**');
    });
  });

  // ── format() — json ─────────────────────────────────────────────────

  describe('format() — json', () => {
    it('should produce valid JSON', () => {
      const report = makeReport();
      const output = module.format(report, 'json');

      expect(() => JSON.parse(output)).not.toThrow();
    });

    it('should preserve all report fields in JSON output', () => {
      const report = makeReport({
        success: true,
        summary: 'All OK',
        details: {
          goal: 'Test',
          tasksCompleted: 2,
          tasksTotal: 2,
          duration: '1s',
          agentBreakdown: [{ agent: 'p', status: 'passed', summary: 'ok' }],
          fileChanges: [{ path: 'f.ts', status: 'modified' }],
          testSummary: 'pass',
          verificationScore: 0.9,
        },
        followUp: { suggestedActions: ['Do X'], confidence: 'high' },
        meta: { durationMs: 1000, trajectoryId: 't-1' },
      });
      const parsed = JSON.parse(module.format(report, 'json'));

      expect(parsed.success).toBe(true);
      expect(parsed.summary).toBe('All OK');
      expect(parsed.details.goal).toBe('Test');
      expect(parsed.details.tasksCompleted).toBe(2);
      expect(parsed.details.agentBreakdown).toHaveLength(1);
      expect(parsed.details.fileChanges).toHaveLength(1);
      expect(parsed.details.testSummary).toBe('pass');
      expect(parsed.details.verificationScore).toBe(0.9);
      expect(parsed.followUp.suggestedActions).toEqual(['Do X']);
      expect(parsed.meta.trajectoryId).toBe('t-1');
    });

    it('should pretty-print with 2-space indentation', () => {
      const report = makeReport();
      const output = module.format(report, 'json');

      // JSON with 2-space indentation should have newlines
      expect(output).toContain('\n');
      expect(output).toContain('  ');
    });
  });

  // ── format() — github-annotation ─────────────────────────────────────

  describe('format() — github-annotation', () => {
    it('should include workflow command annotation with status', () => {
      const report = makeReport({ success: true });
      const output = module.format(report, 'github-annotation');

      expect(output).toContain('::notice title=');
      expect(output).toContain('Agent-Nuvira Execution');
    });

    it('should use error annotation for failed reports', () => {
      const report = makeReport({ success: false });
      const output = module.format(report, 'github-annotation');

      expect(output).toContain('::error title=');
    });

    it('should include per-agent error annotations for failed agents', () => {
      const report = makeReport({
        details: {
          ...makeReport().details,
          agentBreakdown: [
            { agent: 'planner', status: 'passed', summary: 'OK' },
            { agent: 'tester', status: 'failed', summary: 'Tests timed out after 10s' },
          ],
        },
      });
      const output = module.format(report, 'github-annotation');

      expect(output).toContain('::error file=agent-tester.log');
      expect(output).toContain('tester failed');
      expect(output).toContain('Tests timed out');
    });

    it('should not include annotations for passed agents', () => {
      const report = makeReport({
        details: {
          ...makeReport().details,
          agentBreakdown: [
            { agent: 'planner', status: 'passed', summary: 'OK' },
            { agent: 'writer', status: 'passed', summary: 'Done' },
          ],
        },
      });
      const output = module.format(report, 'github-annotation');

      expect(output).not.toContain('::error file=agent-planner');
    });

    it('should include file change annotations', () => {
      const report = makeReport({
        details: {
          ...makeReport().details,
          fileChanges: [
            { path: 'src/new.ts', status: 'created' },
            { path: 'src/edit.ts', status: 'modified' },
          ],
        },
      });
      const output = module.format(report, 'github-annotation');

      expect(output).toContain('::notice file=src/new.ts,title=created');
      expect(output).toContain('::notice file=src/edit.ts,title=modified');
    });

    it('should include step summary with agent results', () => {
      const report = makeReport({ success: true });
      const output = module.format(report, 'github-annotation');

      expect(output).toContain('## Agent-Nuvira Execution');
      expect(output).toContain('**Goal:**');
      expect(output).toContain('**Duration:**');
      expect(output).toContain('**Tasks:**');
      expect(output).toContain('### Agent Results');
    });

    it('should include set-output commands for CI consumption', () => {
      const report = makeReport({ success: true });
      const output = module.format(report, 'github-annotation');

      expect(output).toContain('::set-output name=execution_status::success');
      expect(output).toContain('::set-output name=tasks_completed::3');
      expect(output).toContain('::set-output name=tasks_total::3');
    });

    it('should output failure status in set-output', () => {
      const report = makeReport({ success: false });
      const output = module.format(report, 'github-annotation');

      expect(output).toContain('::set-output name=execution_status::failure');
    });

    it('should handle special characters by escaping them', () => {
      const report = makeReport({
        summary: 'Report with "quotes" and newlines',
        details: {
          ...makeReport().details,
          fileChanges: [{ path: 'path/to/file.ts', status: 'modified' }],
        },
      });
      const output = module.format(report, 'github-annotation');

      // Quotes should be escaped in annotation commands
      expect(output).toContain('\\"');
    });
  });

  // ── format() — unknown format fallback ───────────────────────────────

  describe('format() — unknown format', () => {
    it('should fall back to JSON for unknown format', () => {
      const report = makeReport();
      const output = module.format(report, 'unknown-format' as ReportFormat);

      // Should be valid JSON (JSON formatter is the fallback)
      expect(() => JSON.parse(output)).not.toThrow();
    });
  });

  // ── Integration: generate → format pipeline ──────────────────────────

  describe('generate → format pipeline', () => {
    it('should produce valid text output from generated report', async () => {
      const report = await module.generate(makeParams());
      const output = module.format(report, 'text');

      expect(output).toContain('✅');
      expect(output).toContain('Goal:');
      expect(output).toContain('Agent Results:');
      expect(output).toContain('File Changes:');
    });

    it('should produce valid markdown from generated report', async () => {
      const report = await module.generate(makeParams());
      const output = module.format(report, 'markdown');

      expect(output).toMatch(/^# /);
      expect(output).toContain('## Summary');
      expect(output).toContain('## Agent Results');
    });

    it('should produce valid JSON from generated report', async () => {
      const report = await module.generate(makeParams());
      const output = module.format(report, 'json');

      const parsed = JSON.parse(output);
      expect(parsed.success).toBe(true);
      expect(parsed.details.agentBreakdown).toHaveLength(3);
    });

    it('should produce valid GitHub annotations from generated report', async () => {
      const report = await module.generate(makeFailureParams());
      const output = module.format(report, 'github-annotation');

      expect(output).toContain('::error title=');
      expect(output).toContain('::set-output name=execution_status::failure');
    });
  });

  // ── Edge Cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle all agents failed', async () => {
      const report = await module.generate(makeParams({
        agentResults: [
          { agent: 'planner', success: false, summary: 'Failed to parse goal' },
          { agent: 'writer', success: false, summary: 'No plan to execute' },
        ],
        hasFailures: true,
        error: 'Pipeline aborted at planning stage',
      }));

      expect(report.success).toBe(false);
      expect(report.details.tasksCompleted).toBe(0);
      expect(report.details.tasksTotal).toBe(2);
      expect(report.followUp).toBeDefined();
    });

    it('should handle single agent result', async () => {
      const report = await module.generate(makeParams({
        agentResults: [{ agent: 'runner', success: true, summary: 'Executed successfully' }],
      }));

      expect(report.details.agentBreakdown).toHaveLength(1);
      expect(report.summary).toContain('Completed all 1 tasks');
    });

    it('should handle empty goal string', async () => {
      const report = await module.generate(makeParams({ goal: '' }));

      expect(report.details.goal).toBe('');
    });

    it('should handle very long agent summaries (truncation in text format)', () => {
      const longSummary = 'A'.repeat(500);
      const report = makeReport({
        details: {
          ...makeReport().details,
          agentBreakdown: [
            { agent: 'writer', status: 'failed', summary: longSummary },
          ],
        },
      });
      const output = module.format(report, 'text');

      // The summary should be truncated to ~120 chars in the text output
      expect(output).toContain('A'.repeat(120));
      // The full 500 chars should NOT be in the output
      expect(output).not.toContain('A'.repeat(500));
    });

    it('should handle empty arrays in text format', () => {
      const report = makeReport({
        details: {
          ...makeReport().details,
          agentBreakdown: [],
          fileChanges: [],
        },
      });
      const output = module.format(report, 'text');

      expect(output).not.toContain('Agent Results:');
      expect(output).not.toContain('File Changes:');
    });

    it('should handle missing meta object', () => {
      const report = makeReport({ meta: undefined });
      const output = module.format(report, 'text');

      expect(output).not.toContain('Trajectory:');
    });

    it('should handle meta with only durationMs', () => {
      const report = makeReport({ meta: { durationMs: 5000 } });
      const output = module.format(report, 'text');

      expect(output).not.toContain('Trajectory:');
      expect(output).not.toContain('Review:');
    });
  });
});
