/**
 * Unit tests for GitLab API client (GitLabAPIClient) and GitLab agent (GitLabAgent).
 *
 * Follows the mock pattern from tests/mcp/mcp-client.test.ts and tests/cli/provider.test.ts:
 * - Mocks global fetch for API client tests
 * - Uses mock GitLabAPIClient for agent tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GitLabAPIClient } from '../../src/agents/agents/gitlab-api-client.js';
import type { GitLabProject, GitLabMergeRequest, GitLabIssue, GitLabNote, GitLabMRDiffFile, GitLabPipeline } from '../../src/agents/agents/gitlab-api-client.js';
import { GitLabAgent } from '../../src/agents/agents/gitlab-agent.js';
import type { AgentContext } from '../../src/agents/agent.js';

// ─── Tests: GitLabAPIClient ─────────────────────────────────────────────────

describe('GitLabAPIClient', () => {
  /** Mock fetch that always returns a 200 empty JSON by default */
  let mockFetch: ReturnType<typeof vi.fn>;
  let client: GitLabAPIClient;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', mockFetch);
    client = new GitLabAPIClient('glpat-test-token', 'https://gitlab.com/api/v4');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('constructor', () => {
    it('should use provided token and baseUrl', () => {
      expect(client.hasToken()).toBe(true);
    });

    it('should detect missing token', () => {
      const noTokenClient = new GitLabAPIClient('', 'https://gitlab.com/api/v4');
      expect(noTokenClient.hasToken()).toBe(false);
    });
  });

  describe('verifyToken', () => {
    it('should return user info on valid token', async () => {
      const mockUser = { username: 'testuser', email: 'test@example.com' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockUser),
      });

      const result = await client.verifyToken();
      expect(result).toEqual({ username: 'testuser', email: 'test@example.com' });
      expect(mockFetch).toHaveBeenCalledWith('https://gitlab.com/api/v4/user', expect.any(Object));
    });

    it('should return null on invalid token', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      const result = await client.verifyToken();
      expect(result).toBeNull();
    });
  });

  describe('listProjects', () => {
    it('should return list of projects', async () => {
      const projects: GitLabProject[] = [
        { id: 1, name: 'Project A', nameWithNamespace: 'org/project-a', pathWithNamespace: 'org/project-a', webUrl: 'https://gitlab.com/org/project-a', visibility: 'public', defaultBranch: 'main', description: '' },
        { id: 2, name: 'Project B', nameWithNamespace: 'org/project-b', pathWithNamespace: 'org/project-b', webUrl: 'https://gitlab.com/org/project-b', visibility: 'private', defaultBranch: 'main', description: '' },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(projects),
      });

      const result = await client.listProjects();
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Project A');
    });

    it('should pass search parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });

      await client.listProjects({ search: 'api' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('search=api'),
        expect.any(Object),
      );
    });
  });

  describe('getProject', () => {
    it('should fetch project by path', async () => {
      const project: GitLabProject = { id: 1, name: 'Test', nameWithNamespace: 'org/test', pathWithNamespace: 'org/test', webUrl: '', visibility: 'public', defaultBranch: 'main', description: '' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(project),
      });

      const result = await client.getProject('org/test');
      expect(result.id).toBe(1);
      expect(mockFetch).toHaveBeenCalledWith('https://gitlab.com/api/v4/projects/org%2Ftest', expect.any(Object));
    });

    it('should fetch project by numeric ID', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 42 }),
      });

      const result = await client.getProject(42);
      expect(result.id).toBe(42);
      expect(mockFetch).toHaveBeenCalledWith('https://gitlab.com/api/v4/projects/42', expect.any(Object));
    });
  });

  describe('merge requests', () => {
    const projectId = 1;

    it('should list merge requests', async () => {
      const mrs: GitLabMergeRequest[] = [
        { id: 10, iid: 1, projectId, title: 'Fix bug', description: '', state: 'opened', sourceBranch: 'fix/bug', targetBranch: 'main', webUrl: '', author: { name: 'Alice', username: 'alice' }, assignees: [], labels: [], draft: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200, json: () => Promise.resolve(mrs),
      });

      const result = await client.listMergeRequests(projectId, { state: 'opened' });
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Fix bug');
    });

    it('should create a merge request', async () => {
      const mr: GitLabMergeRequest = { id: 10, iid: 1, projectId, title: 'Fix bug', description: 'Fixes the login issue', state: 'opened', sourceBranch: 'fix/bug', targetBranch: 'main', webUrl: 'https://gitlab.com/org/project/-/merge_requests/1', author: { name: 'Bot', username: 'bot' }, assignees: [], labels: ['bug'], draft: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 201, json: () => Promise.resolve(mr),
      });

      const result = await client.createMergeRequest(projectId, {
        title: 'Fix bug',
        sourceBranch: 'fix/bug',
        targetBranch: 'main',
        labels: ['bug'],
      });

      expect(result.iid).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const call = mockFetch.mock.calls[0];
      expect(call[1].method).toBe('POST');
      const body = JSON.parse(call[1].body);
      expect(body.title).toBe('Fix bug');
      expect(body.source_branch).toBe('fix/bug');
      expect(body.labels).toBe('bug');
    });

    it('should get merge request diff', async () => {
      const diffs: GitLabMRDiffFile[] = [
        { oldPath: 'old.ts', newPath: 'new.ts', newFile: false, renamedFile: false, deletedFile: false, diff: '@@ -1 +1 @@\n-old code\n+new code' },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200, json: () => Promise.resolve(diffs),
      });

      const result = await client.getMergeRequestDiff(projectId, 1);
      expect(result).toHaveLength(1);
      expect(result[0].newPath).toBe('new.ts');
    });
  });

  describe('issues', () => {
    const projectId = 1;

    it('should list issues', async () => {
      const issues: GitLabIssue[] = [
        { id: 10, iid: 1, projectId, title: 'Bug report', description: '', state: 'opened', labels: ['bug'], author: { name: 'A', username: 'a' }, assignees: [], webUrl: '', createdAt: '', updatedAt: '' },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200, json: () => Promise.resolve(issues),
      });

      const result = await client.listIssues(projectId);
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Bug report');
    });

    it('should create an issue', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 201, json: () => Promise.resolve({ iid: 1, title: 'New issue' }),
      });

      const result = await client.createIssue(projectId, {
        title: 'New issue',
        labels: ['bug'],
      });

      expect(result.iid).toBe(1);
      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.title).toBe('New issue');
      expect(body.labels).toBe('bug');
    });
  });

  describe('notes/comments', () => {
    it('should create MR note', async () => {
      const note: GitLabNote = { id: 1, body: 'LGTM!', author: { name: 'Bot', username: 'bot' }, system: false, createdAt: '', resolvable: true };
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 201, json: () => Promise.resolve(note),
      });

      const result = await client.createMRNote(1, 1, 'LGTM!');
      expect(result.id).toBe(1);
      expect(result.body).toBe('LGTM!');
    });
  });

  describe('pipelines', () => {
    it('should list pipelines', async () => {
      const pipelines: GitLabPipeline[] = [
        { id: 1, status: 'success', ref: 'main', sha: 'abc123', webUrl: '', createdAt: '' },
        { id: 2, status: 'failed', ref: 'main', sha: 'def456', webUrl: '', createdAt: '' },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200, json: () => Promise.resolve(pipelines),
      });

      const result = await client.listPipelines(1);
      expect(result).toHaveLength(2);
      expect(result[0].status).toBe('success');
    });
  });

  describe('error handling', () => {
    it('should handle 401 Unauthorized', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false, status: 401, text: () => Promise.resolve('Unauthorized'),
      });

      await expect(client.listProjects()).rejects.toThrow('authentication failed');
    });

    it('should handle 404 Not Found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false, status: 404, text: () => Promise.resolve('Not Found'),
      });

      await expect(client.getProject(999)).rejects.toThrow('not found');
    });

    it('should handle 429 Rate Limited', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false, status: 429, text: () => Promise.resolve('Rate limit exceeded'),
      });

      await expect(client.listProjects()).rejects.toThrow('rate limit');
    });
  });
});

// ─── Tests: GitLabAgent ─────────────────────────────────────────────────────

describe('GitLabAgent', () => {
  let agent: GitLabAgent;
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockClient: GitLabAPIClient;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', mockFetch);

    mockClient = new GitLabAPIClient('glpat-test', 'https://gitlab.com/api/v4');
    agent = new GitLabAgent(mockClient);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createContext(overrides?: Partial<AgentContext>): AgentContext {
    const defaultContext: AgentContext = {
      goal: 'Create merge request for bug fix',
      workingDirectory: '/tmp/test-project',
      taskPlan: [
        { id: 'step-1', description: 'Create MR for branch fix/login', agentType: 'gitlab', dependsOn: [], status: 'running' },
      ],
      artifacts: [],
      conversations: [],
      fileChanges: [],
      metadata: {},
    };
    return { ...defaultContext, ...overrides };
  }

  describe('no token', () => {
    it('should return error when no GitLab token is configured', async () => {
      const noTokenAgent = new GitLabAgent(new GitLabAPIClient('', 'https://gitlab.com/api/v4'));
      const result = await noTokenAgent.execute(createContext(), vi.fn() as any);
      expect(result.success).toBe(false);
      expect(result.summary).toContain('not configured');
    });
  });

  describe('mr-create', () => {
    it('should create a merge request when project ID is in metadata', async () => {
      // The agent checks hasToken() → no fetch
      // Then resolveProjectId() checks metadata.gitlabProjectId → returns 1, no fetch needed
      // Then createMergeRequest() → makes one fetch call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ iid: 42, title: 'Fix the login bug', webUrl: 'https://gitlab.com/-/mr/42' }),
      });

      const context = createContext({
        goal: 'Fix the login bug',
        taskPlan: [{ id: 'step-1', description: 'Create merge request for branch fix/login', agentType: 'gitlab', dependsOn: [], status: 'running' }],
        metadata: { gitlabProjectId: 1 },
      });

      const result = await agent.execute(context, vi.fn() as any);
      expect(result.success).toBe(true);
      expect(result.summary).toContain('Created MR');
      expect(result.summary).toContain('#42');
    });
  });

  describe('mr-list', () => {
    it('should list open merge requests', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve([
          { iid: 1, title: 'Fix bug', state: 'opened', sourceBranch: 'fix/bug', targetBranch: 'main' },
        ]),
      });

      const context = createContext({
        goal: 'Show open merge requests',
        taskPlan: [{ id: 'step-1', description: 'List open merge requests', agentType: 'gitlab', dependsOn: [], status: 'running' }],
        metadata: { gitlabProjectId: 1 },
      });

      const result = await agent.execute(context, vi.fn() as any);
      expect(result.success).toBe(true);
      expect(result.summary).toContain('merge request');
    });
  });

  describe('discover', () => {
    it('should discover projects', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve([
          { id: 1, nameWithNamespace: 'org/test', name: 'test' },
        ]),
      });

      const context = createContext({
        goal: 'Discover my GitLab projects',
        taskPlan: [{ id: 'step-1', description: 'Discover projects', agentType: 'gitlab', dependsOn: [], status: 'running' }],
      });

      const result = await agent.execute(context, vi.fn() as any);
      expect(result.success).toBe(true);
      expect(result.summary).toContain('project');
    });
  });

  describe('pipeline-status', () => {
    it('should check pipeline status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve([{ id: 1, status: 'success', ref: 'main' }]),
      });

      const context = createContext({
        goal: 'Check pipeline status',
        taskPlan: [{ id: 'step-1', description: 'Check CI pipeline status', agentType: 'gitlab', dependsOn: [], status: 'running' }],
        metadata: { gitlabProjectId: 1 },
      });

      const result = await agent.execute(context, vi.fn() as any);
      expect(result.success).toBe(true);
      expect(result.summary).toContain('Pipeline');
    });

    it('should report when no pipelines found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve([]),
      });

      const context = createContext({
        goal: 'Check CI',
        taskPlan: [{ id: 'step-1', description: 'Check CI pipeline', agentType: 'gitlab', dependsOn: [], status: 'running' }],
        metadata: { gitlabProjectId: 1 },
      });

      const result = await agent.execute(context, vi.fn() as any);
      expect(result.success).toBe(true);
      expect(result.summary).toContain('No pipelines');
    });
  });
});
