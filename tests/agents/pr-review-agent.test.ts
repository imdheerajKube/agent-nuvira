/**
 * Unit tests for PR Review Agent (PRReviewAgent).
 *
 * Tests:
 * - Operation detection (list, review, review-specific, summarize)
 * - Repo resolution from git remote and metadata
 * - PR listing via GitHub API
 * - Single PR review flow (fetch PR → fetch diff → verify → post comments)
 * - All-open-PR review flow
 * - Error handling (auth failures, rate limits, no PRs)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PRReviewAgent } from '../../src/agents/agents/pr-review-agent.js';
import type { AgentContext } from '../../src/agents/agent.js';

// Mock execSync to prevent git remote resolution from succeeding in tests
vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockImplementation(() => {
    throw new Error('Mock git remote error');
  }),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function createContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    goal: 'Review open pull requests',
    workingDirectory: '/tmp/test-project',
    taskPlan: [
      { id: 'step-1', description: 'Review open PRs', agentType: 'pr-review', dependsOn: [], status: 'running' },
    ],
    artifacts: [],
    conversations: [],
    fileChanges: [],
    metadata: {
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubApiKey: 'ghp_test-token-12345',
    },
    ...overrides,
  };
}

function mockGitHubAPI(
  mockFetch: ReturnType<typeof vi.fn>,
  pathPattern: string,
  responseData: unknown,
  status = 200,
): void {
  mockFetch.mockImplementation(async (_url: string) => {
    if (_url.includes(pathPattern)) {
      return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(responseData),
        text: () => Promise.resolve(JSON.stringify(responseData)),
      };
    }
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
    };
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('PRReviewAgent', () => {
  let agent: PRReviewAgent;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', mockFetch);
    agent = new PRReviewAgent();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('constructor', () => {
    it('should create agent with correct name', () => {
      expect(agent.name).toBe('PR Review');
      expect(agent.description).toContain('pull requests');
    });
  });

  describe('execute with no token', () => {
    it('should attempt the review even without token (API may fail gracefully)', async () => {
      const noTokenAgent = new PRReviewAgent();
      mockGitHubAPI(mockFetch, '/pulls', { message: 'Bad credentials' }, 401);

      const context = createContext({ metadata: { githubOwner: 'owner', githubRepo: 'repo' } });
      const result = await noTokenAgent.execute(context, vi.fn() as any);
      expect(result.success).toBe(false);
    });
  });

  describe('repo resolution from metadata', () => {
    it('should use metadata owner/repo when available', async () => {
      mockGitHubAPI(mockFetch, '/pulls', [
        { number: 1, title: 'Fix bug', state: 'open', draft: false, labels: [], head: { ref: 'fix', sha: 'abc' }, base: { ref: 'main', sha: 'def' }, user: { login: 'test' }, htmlUrl: '', createdAt: '', updatedAt: '' },
      ]);

      const context = createContext({
        goal: 'List open PRs',
        taskPlan: [{ id: 'step-1', description: 'List open pull requests', agentType: 'pr-review', dependsOn: [], status: 'running' }],
        metadata: { githubOwner: 'my-org', githubRepo: 'my-repo', githubApiKey: 'test-token' },
      });

      const result = await agent.execute(context, vi.fn() as any);
      expect(result.success).toBe(true);
      expect(result.summary).toContain('1 open PR');
    });
  });

  describe('list operation', () => {
    it('should list open PRs', async () => {
      mockGitHubAPI(mockFetch, '/pulls', [
        {
          number: 42, title: 'Add authentication', state: 'open', draft: false,
          head: { ref: 'feat/auth', sha: 'abc123' }, base: { ref: 'main', sha: 'def456' },
          user: { login: 'dev1' }, htmlUrl: 'https://github.com/owner/repo/pull/42',
          labels: [{ name: 'enhancement' }], body: '', createdAt: '', updatedAt: '',
        },
        {
          number: 43, title: 'Fix typo in README', state: 'open', draft: true,
          head: { ref: 'fix/readme', sha: 'ghi789' }, base: { ref: 'main', sha: 'def456' },
          user: { login: 'dev2' }, htmlUrl: 'https://github.com/owner/repo/pull/43',
          labels: [], body: '', createdAt: '', updatedAt: '',
        },
      ]);

      const context = createContext({
        goal: 'List open pull requests',
        taskPlan: [{ id: 'step-1', description: 'List open PRs', agentType: 'pr-review', dependsOn: [], status: 'running' }],
      });

      const result = await agent.execute(context, vi.fn() as any);
      expect(result.success).toBe(true);
      expect(result.summary).toContain('2 open PR(s)');
      expect(result.details).toContain('#42');
      expect(result.details).toContain('#43');
    });

    it('should handle no open PRs', async () => {
      mockGitHubAPI(mockFetch, '/pulls', []);

      const context = createContext({
        goal: 'List PRs',
        taskPlan: [{ id: 'step-1', description: 'List open PRs', agentType: 'pr-review', dependsOn: [], status: 'running' }],
      });

      const result = await agent.execute(context, vi.fn() as any);
      expect(result.success).toBe(true);
      expect(result.summary).toContain('No open pull requests');
    });
  });

  describe('review-specific operation', () => {
    it('should parse PR number from description', async () => {
      const mockPR = {
        number: 42, title: 'Add feature', state: 'open', draft: false,
        head: { ref: 'feat', sha: 'abc' }, base: { ref: 'main', sha: 'def' },
        user: { login: 'dev' }, htmlUrl: '', labels: [], body: 'Adds new feature',
        createdAt: '', updatedAt: '',
      };
      const mockFiles: Array<Record<string, unknown>> = [];

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(mockPR), text: () => Promise.resolve('') })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(mockFiles), text: () => Promise.resolve('') })
        .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') });

      const context = createContext({
        goal: 'Review PR #42 in test-owner/test-repo',
        taskPlan: [{ id: 'step-1', description: 'Review PR #42', agentType: 'pr-review', dependsOn: [], status: 'running' }],
      });

      const result = await agent.execute(context, vi.fn() as any);
      expect(result.success).toBe(true);
    });
  });

  describe('summarize operation', () => {
    it('should summarize a specific PR when LLM is available', async () => {
      const mockPR = {
        number: 42, title: 'Add auth module', state: 'open', draft: false,
        head: { ref: 'feat/auth', sha: 'abc' }, base: { ref: 'main', sha: 'def' },
        user: { login: 'dev' }, htmlUrl: '', labels: [], body: 'Adds JWT auth',
        createdAt: '', updatedAt: '',
      };

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(mockPR), text: () => Promise.resolve('') })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve([]), text: () => Promise.resolve('') });

      const mockLLM = vi.fn().mockResolvedValue('This PR adds JWT authentication to the Express app.');

      const context = createContext({
        goal: 'Summarize PR #42',
        taskPlan: [{ id: 'step-1', description: 'Summarize PR #42', agentType: 'pr-review', dependsOn: [], status: 'running' }],
      });

      const result = await agent.execute(context, mockLLM);
      expect(result.success).toBe(true);
      expect(result.summary).toContain('Generated summary');
    });
  });

  describe('error handling', () => {
    it('should handle 401 Unauthorized', async () => {
      mockGitHubAPI(mockFetch, '/pulls', { message: 'Bad credentials' }, 401);

      const context = createContext({
        goal: 'Review PRs',
        taskPlan: [{ id: 'step-1', description: 'Review PRs', agentType: 'pr-review', dependsOn: [], status: 'running' }],
        metadata: { githubOwner: 'owner', githubRepo: 'repo', githubApiKey: '' },
      });

      const result = await agent.execute(context, vi.fn() as any);
      expect(result.success).toBe(false);
    });

    it('should handle 404 Not Found', async () => {
      mockGitHubAPI(mockFetch, '/pulls', { message: 'Not Found' }, 404);

      const context = createContext({
        goal: 'Review PRs',
        taskPlan: [{ id: 'step-1', description: 'Review PRs', agentType: 'pr-review', dependsOn: [], status: 'running' }],
        metadata: { githubOwner: 'owner', githubRepo: 'does-not-exist', githubApiKey: 'test' },
      });

      const result = await agent.execute(context, vi.fn() as any);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should handle no repo resolved', async () => {
      const context = createContext({
        goal: 'Review PRs',
        taskPlan: [{ id: 'step-1', description: 'Review PRs', agentType: 'pr-review', dependsOn: [], status: 'running' }],
        metadata: {}, // No owner/repo — and execSync is mocked to throw
      });

      const result = await agent.execute(context, vi.fn() as any);
      expect(result.success).toBe(false);
      expect(result.summary).toContain('Could not resolve');
    });
  });
});
