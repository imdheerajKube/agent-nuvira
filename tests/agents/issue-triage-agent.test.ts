/**
 * Unit tests for IssueTriageAgent — automated issue classification, prioritization, and labeling.
 *
 * Coverage goals:
 * - execute() — detect operations: triage-all, triage-specific, classify, list-unlabeled
 * - detectSource() — github, gitlab, auto, token-based inference
 * - parseClassificationResponse() — valid JSON, markdown-wrapped, malformed, empty
 * - buildClassificationPrompt() — includes issue title, body, labels
 * - buildTriageComment() — all fields present, markdown table format
 * - inferAssigneeFromGitBlame() — file path extraction, git blame parsing
 * - label helpers — ensureGitHubLabels, getLabelColor
 * - Validation helpers — validateClassification, validatePriority, validateDifficulty
 * - Group helpers — groupByClassification, groupByPriority, groupByDifficulty
 * - Error handling — API failures, auth failures, LLM failures
 * - Edge cases — empty issue body, no labels, no token
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IssueTriageAgent, type IssueClassification, type IssuePriority, type IssueDifficulty, type TriageResult, type IssueSummary } from '../../src/agents/agents/issue-triage-agent.js';
import type { AgentContext } from '../../src/agents/agent.js';

// ─── Context Factory ─────────────────────────────────────────────────────────

function createContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    goal: overrides.goal ?? 'Triage open issues in my-org/my-repo',
    taskPlan: overrides.taskPlan ?? [],
    metadata: overrides.metadata ?? {},
    contextFiles: overrides.contextFiles ?? [],
    artifacts: overrides.artifacts ?? [],
    ...overrides,
  } as AgentContext;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('IssueTriageAgent', () => {
  let agent: IssueTriageAgent;

  beforeEach(() => {
    agent = new IssueTriageAgent();
  });

  describe('operation detection (detectOperation)', () => {
    it('should detect triage-all from "triage" keyword', () => {
      const result = (agent as any).detectOperation('Triage open issues');
      expect(result).toBe('triage-all');
    });

    it('should detect triage-all from "all open issues"', () => {
      const result = (agent as any).detectOperation('Review all open issues and classify them');
      expect(result).toBe('triage-all');
    });

    it('should detect triage-specific from description with #number', () => {
      const result = (agent as any).detectOperation('Triage issue #42 for classification');
      expect(result).toBe('triage-specific');
    });

    it('should detect classify from "classify #42"', () => {
      const result = (agent as any).detectOperation('Classify issue #42');
      expect(result).toBe('classify');
    });

    it('should detect list-unlabeled from "list unlabeled issues"', () => {
      const result = (agent as any).detectOperation('List unlabeled issues');
      expect(result).toBe('list-unlabeled');
    });

    it('should default to triage-all for ambiguous descriptions', () => {
      const result = (agent as any).detectOperation('Look at the issues');
      expect(result).toBe('triage-all');
    });

    it('should detect list-unlabeled from "show unlabeled"', () => {
      const result = (agent as any).detectOperation('Show all unlabeled issues');
      expect(result).toBe('list-unlabeled');
    });

    it('should detect classify from "categorize #15"', () => {
      const result = (agent as any).detectOperation('Categorize issue #15');
      expect(result).toBe('classify');
    });

    it('should detect triage-specific from "assess #7"', () => {
      const result = (agent as any).detectOperation('Assess issue #7');
      expect(result).toBe('triage-specific');
    });
  });

  describe('source detection (detectSource)', () => {
    it('should detect GitHub from "github" keyword', () => {
      const result = (agent as any).detectSource('Triage issues in my-org/my-repo on github');
      expect(result).toBe('github');
    });

    it('should detect GitLab from "gitlab" keyword', () => {
      const result = (agent as any).detectSource('Triage issues on gitlab');
      expect(result).toBe('gitlab');
    });

    it('should detect auto when no keyword matches', () => {
      const result = (agent as any).detectSource('Triage open issues');
      expect(result).toBe('auto');
    });

    it('should detect gitlab when only glToken is set', () => {
      const agentWithGl = new (IssueTriageAgent as any)();
      agentWithGl.ghToken = '';
      agentWithGl.glToken = 'glpat-test';
      const result = agentWithGl.detectSource('Triage open issues');
      expect(result).toBe('gitlab');
    });

    it('should detect github when only ghToken is set', () => {
      const agentWithGh = new (IssueTriageAgent as any)();
      agentWithGh.ghToken = 'ghp_test';
      agentWithGh.glToken = '';
      const result = agentWithGh.detectSource('Triage open issues');
      expect(result).toBe('github');
    });
  });

  describe('parseClassificationResponse', () => {
    it('should parse a valid JSON response', () => {
      const response = JSON.stringify({
        classification: 'bug',
        priority: 'high',
        suggestedLabels: ['bug', 'needs-triage'],
        estimatedDifficulty: 'medium',
        reasoning: 'This is a clear bug report with reproduction steps',
        suggestedAction: 'Fix the null pointer exception in the login handler',
      });
      const result = (agent as any).parseClassificationResponse(response);
      expect(result.classification).toBe('bug');
      expect(result.priority).toBe('high');
      expect(result.suggestedLabels).toContain('bug');
      expect(result.estimatedDifficulty).toBe('medium');
      expect(result.reasoning).toBeTruthy();
      expect(result.suggestedAction).toBeTruthy();
    });

    it('should parse JSON wrapped in markdown code blocks', () => {
      const response = '```json\n{\n  "classification": "feature",\n  "priority": "medium",\n  "suggestedLabels": ["enhancement", "feature-request"],\n  "estimatedDifficulty": "hard",\n  "reasoning": "This is a significant feature request",\n  "suggestedAction": "Discuss in planning meeting"\n}\n```';
      const result = (agent as any).parseClassificationResponse(response);
      expect(result.classification).toBe('feature');
      expect(result.priority).toBe('medium');
      expect(result.suggestedLabels).toContain('enhancement');
      expect(result.estimatedDifficulty).toBe('hard');
    });

    it('should return defaults for malformed JSON', () => {
      const response = 'This is not valid JSON at all';
      const result = (agent as any).parseClassificationResponse(response);
      expect(result.classification).toBe('question');
      expect(result.priority).toBe('medium');
      expect(result.suggestedLabels).toContain('needs-triage');
      expect(result.estimatedDifficulty).toBe('medium');
    });

    it('should return defaults for empty response', () => {
      const result = (agent as any).parseClassificationResponse('');
      expect(result.classification).toBe('question');
      expect(result.priority).toBe('medium');
      expect(result.suggestedLabels).toContain('needs-triage');
    });

    it('should handle invalid classification values with fallback', () => {
      const response = JSON.stringify({
        classification: 'invalid-type',
        priority: 'medium',
        suggestedLabels: ['bug'],
        estimatedDifficulty: 'easy',
        reasoning: 'Test',
        suggestedAction: 'Fix',
      });
      const result = (agent as any).parseClassificationResponse(response);
      expect(result.classification).toBe('question'); // Falls back to 'question'
      expect(result.priority).toBe('medium');
    });

    it('should handle invalid priority values with fallback', () => {
      const response = JSON.stringify({
        classification: 'bug',
        priority: 'urgent',
        suggestedLabels: ['bug'],
        estimatedDifficulty: 'easy',
        reasoning: 'Test',
        suggestedAction: 'Fix',
      });
      const result = (agent as any).parseClassificationResponse(response);
      expect(result.classification).toBe('bug');
      expect(result.priority).toBe('medium'); // Falls back to 'medium'
    });

    it('should handle invalid difficulty values with fallback', () => {
      const response = JSON.stringify({
        classification: 'docs',
        priority: 'low',
        suggestedLabels: ['documentation'],
        estimatedDifficulty: 'trivial',
        reasoning: 'Test',
        suggestedAction: 'Update docs',
      });
      const result = (agent as any).parseClassificationResponse(response);
      expect(result.classification).toBe('docs');
      expect(result.estimatedDifficulty).toBe('medium'); // Falls back to 'medium'
    });
  });

  describe('buildClassificationPrompt', () => {
    it('should include issue title and body in prompt', () => {
      const issue: IssueSummary = {
        number: 42,
        title: 'Login button not working',
        body: 'When I click the login button, nothing happens.',
        author: 'testuser',
        labels: [],
        createdAt: '2026-01-15T10:00:00Z',
        updatedAt: '2026-01-15T12:00:00Z',
        url: 'https://github.com/org/repo/issues/42',
        comments: 3,
      };
      const prompt = (agent as any).buildClassificationPrompt(issue);
      expect(prompt).toContain('#42');
      expect(prompt).toContain('Login button not working');
      expect(prompt).toContain('nothing happens');
      expect(prompt).toContain('testuser');
      expect(prompt).toContain('3');
    });

    it('should handle empty body gracefully', () => {
      const issue: IssueSummary = {
        number: 1,
        title: 'Empty body test',
        body: '',
        author: 'testuser',
        labels: ['bug'],
        createdAt: '2026-01-15T10:00:00Z',
        updatedAt: '2026-01-15T12:00:00Z',
        url: 'https://github.com/org/repo/issues/1',
        comments: 0,
      };
      const prompt = (agent as any).buildClassificationPrompt(issue);
      expect(prompt).toContain('#1');
      expect(prompt).toContain('(no description)');
      expect(prompt).toContain('bug');
    });

    it('should include classification guidelines', () => {
      const issue: IssueSummary = {
        number: 1,
        title: 'Test',
        body: 'Test body',
        author: 'test',
        labels: [],
        createdAt: '',
        updatedAt: '',
        url: '',
        comments: 0,
      };
      const prompt = (agent as any).buildClassificationPrompt(issue);
      expect(prompt).toContain('bug');
      expect(prompt).toContain('feature');
      expect(prompt).toContain('critical');
      expect(prompt).toContain('easy');
    });
  });

  describe('buildTriageComment', () => {
    it('should include all classification fields in markdown table', () => {
      const result: TriageResult = {
        issueNumber: 42,
        title: 'Test issue',
        classification: 'bug',
        priority: 'high',
        suggestedLabels: ['bug', 'high'],
        estimatedDifficulty: 'medium',
        suggestedAction: 'Fix the issue',
        reasoning: 'Clear reproduction steps provided',
      };
      const comment = (agent as any).buildTriageComment(result);
      expect(comment).toContain('bug');
      expect(comment).toContain('high');
      expect(comment).toContain('medium');
      expect(comment).toContain('Clear reproduction steps provided');
      expect(comment).toContain('Fix the issue');
      expect(comment).toContain('| **Classification** |');
      expect(comment).toContain('| **Priority** |');
      expect(comment).toContain('| **Difficulty** |');
    });

    it('should include suggested assignee when available', () => {
      const result: TriageResult = {
        issueNumber: 1,
        title: 'Test',
        classification: 'feature',
        priority: 'medium',
        suggestedLabels: ['enhancement'],
        suggestedAssignee: 'alice',
        estimatedDifficulty: 'easy',
        suggestedAction: '',
        reasoning: 'Simple change',
      };
      const comment = (agent as any).buildTriageComment(result);
      expect(comment).toContain('alice');
      expect(comment).toContain('| **Suggested Assignee** |');
    });

    it('should not include suggested assignee section when not available', () => {
      const result: TriageResult = {
        issueNumber: 1,
        title: 'Test',
        classification: 'docs',
        priority: 'low',
        suggestedLabels: ['documentation'],
        estimatedDifficulty: 'easy',
        suggestedAction: '',
        reasoning: 'Docs update',
      };
      const comment = (agent as any).buildTriageComment(result);
      expect(comment).not.toContain('Suggested Assignee');
    });

    it('should include suggested action when available', () => {
      const result: TriageResult = {
        issueNumber: 1,
        title: 'Test',
        classification: 'question',
        priority: 'low',
        suggestedLabels: ['question'],
        estimatedDifficulty: 'easy',
        suggestedAction: 'Answer the question about API usage',
        reasoning: 'User needs help',
      };
      const comment = (agent as any).buildTriageComment(result);
      expect(comment).toContain('Answer the question about API usage');
      expect(comment).toContain('### Suggested Action');
    });
  });

  describe('getLabelColor', () => {
    it('should return correct color for "bug"', () => {
      expect((agent as any).getLabelColor('bug')).toBe('d73a4a');
    });

    it('should return correct color for "enhancement"', () => {
      expect((agent as any).getLabelColor('enhancement')).toBe('a2eeef');
    });

    it('should return correct color for "documentation"', () => {
      expect((agent as any).getLabelColor('documentation')).toBe('0075ca');
    });

    it('should return correct color for "question"', () => {
      expect((agent as any).getLabelColor('question')).toBe('d876e3');
    });

    it('should return default color for unknown labels', () => {
      expect((agent as any).getLabelColor('unknown-label')).toBe('c5def5');
    });

    it('should be case-insensitive', () => {
      expect((agent as any).getLabelColor('BUG')).toBe('d73a4a');
      expect((agent as any).getLabelColor('Enhancement')).toBe('a2eeef');
    });
  });

  describe('validation helpers', () => {
    describe('validateClassification', () => {
      it('should accept valid classifications', () => {
        expect((agent as any).validateClassification('bug')).toBe(true);
        expect((agent as any).validateClassification('feature')).toBe(true);
        expect((agent as any).validateClassification('question')).toBe(true);
        expect((agent as any).validateClassification('docs')).toBe(true);
        expect((agent as any).validateClassification('chore')).toBe(true);
      });

      it('should reject invalid classifications', () => {
        expect((agent as any).validateClassification('invalid')).toBe(false);
        expect((agent as any).validateClassification('')).toBe(false);
        expect((agent as any).validateClassification(null)).toBe(false);
        expect((agent as any).validateClassification(undefined)).toBe(false);
        expect((agent as any).validateClassification(42)).toBe(false);
      });
    });

    describe('validatePriority', () => {
      it('should accept valid priorities', () => {
        expect((agent as any).validatePriority('critical')).toBe(true);
        expect((agent as any).validatePriority('high')).toBe(true);
        expect((agent as any).validatePriority('medium')).toBe(true);
        expect((agent as any).validatePriority('low')).toBe(true);
      });

      it('should reject invalid priorities', () => {
        expect((agent as any).validatePriority('urgent')).toBe(false);
        expect((agent as any).validatePriority('')).toBe(false);
      });
    });

    describe('validateDifficulty', () => {
      it('should accept valid difficulties', () => {
        expect((agent as any).validateDifficulty('easy')).toBe(true);
        expect((agent as any).validateDifficulty('medium')).toBe(true);
        expect((agent as any).validateDifficulty('hard')).toBe(true);
      });

      it('should reject invalid difficulties', () => {
        expect((agent as any).validateDifficulty('trivial')).toBe(false);
        expect((agent as any).validateDifficulty('')).toBe(false);
      });
    });
  });

  describe('group helpers', () => {
    it('groupByClassification should group correctly', () => {
      const results: TriageResult[] = [
        createTriageResult(1, 'bug', 'high', 'medium'),
        createTriageResult(2, 'feature', 'medium', 'hard'),
        createTriageResult(3, 'bug', 'critical', 'medium'),
        createTriageResult(4, 'question', 'low', 'easy'),
      ];
      const groups = (agent as any).groupByClassification(results);
      expect(groups).toEqual({ bug: 2, feature: 1, question: 1 });
    });

    it('groupByPriority should group correctly', () => {
      const results: TriageResult[] = [
        createTriageResult(1, 'bug', 'critical', 'medium'),
        createTriageResult(2, 'bug', 'high', 'medium'),
        createTriageResult(3, 'feature', 'medium', 'hard'),
        createTriageResult(4, 'docs', 'low', 'easy'),
        createTriageResult(5, 'chore', 'low', 'easy'),
      ];
      const groups = (agent as any).groupByPriority(results);
      expect(groups).toEqual({ critical: 1, high: 1, medium: 1, low: 2 });
    });

    it('groupByDifficulty should group correctly', () => {
      const results: TriageResult[] = [
        createTriageResult(1, 'bug', 'high', 'easy'),
        createTriageResult(2, 'feature', 'medium', 'hard'),
        createTriageResult(3, 'question', 'low', 'easy'),
        createTriageResult(4, 'docs', 'low', 'medium'),
      ];
      const groups = (agent as any).groupByDifficulty(results);
      expect(groups).toEqual({ easy: 2, hard: 1, medium: 1 });
    });

    it('should handle empty arrays', () => {
      expect((agent as any).groupByClassification([])).toEqual({});
      expect((agent as any).groupByPriority([])).toEqual({});
      expect((agent as any).groupByDifficulty([])).toEqual({});
    });
  });

  describe('execute error handling', () => {
    it('should handle execution gracefully without crashing', async () => {
      const context = createContext({
        goal: 'Triage issues in none/zero',
        metadata: {},
      });
      const callLLM = vi.fn();

      // Should not throw regardless of success/failure
      let result;
      try {
        result = await agent.execute(context, callLLM);
      } catch (err) {
        // Should never reach here
        expect.unreachable('execute should not throw');
      }

      expect(result).toBeDefined();
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('summary');
    });

    it('should handle LLM failure gracefully', async () => {
      const context = createContext({
        goal: 'Triage issues in none/zero',
        metadata: {},
        taskPlan: [],
      });
      const callLLM = vi.fn().mockRejectedValue(new Error('LLM API error'));

      // Should handle gracefully even though API calls will fail
      const result = await agent.execute(context, callLLM);
      expect(result).toBeDefined();
      expect(result).toHaveProperty('success');
      // Should not throw
    });
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTriageResult(
  issueNumber: number,
  classification: IssueClassification,
  priority: IssuePriority,
  estimatedDifficulty: IssueDifficulty,
): TriageResult {
  return {
    issueNumber,
    title: `Issue #${issueNumber}`,
    classification,
    priority,
    suggestedLabels: [classification],
    estimatedDifficulty,
    suggestedAction: 'Review and fix',
    reasoning: 'Auto-classified by test',
  };
}
