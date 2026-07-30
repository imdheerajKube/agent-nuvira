/**
 * GitLab API Client — REST API wrapper for GitLab merge requests, issues, and project operations.
 *
 * Uses GitLab REST API v4. Supports both gitlab.com and self-hosted GitLab instances.
 *
 * Authentication: `GITLAB_TOKEN` env var or explicit token in constructor.
 * Base URL: `GITLAB_URL` env var (default: https://gitlab.com/api/v4) or explicit.
 *
 * All methods throw on non-OK responses, with the HTTP status and body included in the error.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** A GitLab project (subset of the API response) */
export interface GitLabProject {
  id: number;
  name: string;
  nameWithNamespace: string;
  pathWithNamespace: string;
  webUrl: string;
  visibility: string;
  defaultBranch: string;
  description: string;
}

/** A GitLab merge request (subset of the API response) */
export interface GitLabMergeRequest {
  id: number;
  iid: number;
  projectId: number;
  title: string;
  description: string;
  state: 'opened' | 'closed' | 'merged' | 'locked';
  sourceBranch: string;
  targetBranch: string;
  webUrl: string;
  author: { name: string; username: string };
  assignees: Array<{ name: string; username: string }>;
  labels: string[];
  draft: boolean;
  mergedBy?: { name: string; username: string };
  diffRefs?: { baseSha: string; headSha: string; startSha: string };
  createdAt: string;
  updatedAt: string;
}

/** A GitLab issue (subset of the API response) */
export interface GitLabIssue {
  id: number;
  iid: number;
  projectId: number;
  title: string;
  description: string;
  state: 'opened' | 'closed';
  labels: string[];
  author: { name: string; username: string };
  assignees: Array<{ name: string; username: string }>;
  milestone?: { title: string };
  webUrl: string;
  createdAt: string;
  updatedAt: string;
}

/** Options for creating a merge request */
export interface CreateMROptions {
  title: string;
  description?: string;
  sourceBranch: string;
  targetBranch: string;
  labels?: string[];
  draft?: boolean;
  removeSourceBranch?: boolean;
  squash?: boolean;
  assigneeId?: number;
}

/** Options for creating an issue */
export interface CreateIssueOptions {
  title: string;
  description?: string;
  labels?: string[];
  assigneeId?: number;
  milestoneId?: number;
}

/** A note/comment on a merge request or issue */
export interface GitLabNote {
  id: number;
  body: string;
  author: { name: string; username: string };
  system: boolean;
  createdAt: string;
  resolvable: boolean;
}

/** Merge request diff file (from the API) */
export interface GitLabMRDiffFile {
  oldPath: string;
  newPath: string;
  newFile: boolean;
  renamedFile: boolean;
  deletedFile: boolean;
  diff: string;
}

/** Pipeline info */
export interface GitLabPipeline {
  id: number;
  status: 'running' | 'pending' | 'success' | 'failed' | 'canceled' | 'skipped';
  ref: string;
  sha: string;
  webUrl: string;
  createdAt: string;
}

// ─── HTTP Helpers ───────────────────────────────────────────────────────────

const DEFAULT_GITLAB_URL = 'https://gitlab.com/api/v4';

function getDefaultToken(): string {
  return process.env.GITLAB_TOKEN || process.env.GITLAB_ACCESS_TOKEN || '';
}

function getDefaultBaseUrl(): string {
  const envUrl = process.env.GITLAB_URL || process.env.CI_SERVER_URL;
  if (envUrl) {
    const base = envUrl.replace(/\/+$/, '');
    return base.endsWith('/api/v4') ? base : `${base}/api/v4`;
  }
  return DEFAULT_GITLAB_URL;
}

interface GitLabAPIError extends Error {
  status: number;
  body: string;
}

function createAPIError(message: string, status: number, body: string): GitLabAPIError {
  const err = new Error(message) as GitLabAPIError;
  err.status = status;
  err.body = body;
  return err;
}

async function handleResponse(response: Response): Promise<any> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const status = response.status;
    if (status === 401) throw createAPIError('GitLab authentication failed — check GITLAB_TOKEN', status, body);
    if (status === 403) throw createAPIError('GitLab access denied — token may lack permissions', status, body);
    if (status === 404) throw createAPIError('GitLab resource not found', status, body);
    if (status === 429) throw createAPIError('GitLab rate limit exceeded — try again later', status, body);
    throw createAPIError(`GitLab API error: ${status} — ${body.slice(0, 200)}`, status, body);
  }
  // Handle 204 No Content
  if (response.status === 204) return null;
  return response.json();
}

// ─── Client ─────────────────────────────────────────────────────────────────

/**
 * GitLab API Client — REST API v4 wrapper.
 *
 * @example
 * ```typescript
 * const client = new GitLabAPIClient('glpat-xxxx', 'https://gitlab.com/api/v4');
 * const projects = await client.listProjects({ search: 'my-app' });
 * const mr = await client.createMergeRequest(projectId, {
 *   title: 'Fix login bug',
 *   sourceBranch: 'fix/login',
 *   targetBranch: 'main',
 * });
 * ```
 */
export class GitLabAPIClient {
  private token: string;
  private baseUrl: string;

  constructor(token?: string, baseUrl?: string) {
    this.token = token || getDefaultToken();
    this.baseUrl = (baseUrl || getDefaultBaseUrl()).replace(/\/+$/, '');
  }

  // ── Auth ───────────────────────────────────────────────────────────────

  /** Check if the client has a token configured */
  hasToken(): boolean {
    return this.token.length > 0;
  }

  /** Verify the token is valid by calling /user */
  async verifyToken(): Promise<{ username: string; email: string } | null> {
    try {
      const user = await this.get<any>('/user');
      return { username: user.username, email: user.email || '' };
    } catch {
      return null;
    }
  }

  // ── Projects ───────────────────────────────────────────────────────────

  /** List accessible projects, optionally filtered by search */
  async listProjects(opts?: { search?: string; membership?: boolean; perPage?: number }): Promise<GitLabProject[]> {
    const params = new URLSearchParams();
    if (opts?.search) params.set('search', opts.search);
    if (opts?.membership) params.set('membership', 'true');
    if (opts?.perPage) params.set('per_page', String(opts.perPage));
    else params.set('per_page', '50');
    return this.get<GitLabProject[]>(`/projects?${params}`);
  }

  /** Get a single project by ID or URL-encoded path */
  async getProject(projectId: number | string): Promise<GitLabProject> {
    const path = typeof projectId === 'string' ? encodeURIComponent(projectId) : String(projectId);
    return this.get<GitLabProject>(`/projects/${path}`);
  }

  // ── Merge Requests ─────────────────────────────────────────────────────

  /** List merge requests for a project */
  async listMergeRequests(
    projectId: number,
    opts?: { state?: 'opened' | 'closed' | 'merged' | 'all'; labels?: string[]; perPage?: number },
  ): Promise<GitLabMergeRequest[]> {
    const params = new URLSearchParams();
    if (opts?.state) params.set('state', opts.state);
    if (opts?.labels && opts.labels.length > 0) params.set('labels', opts.labels.join(','));
    if (opts?.perPage) params.set('per_page', String(opts.perPage));
    else params.set('per_page', '20');
    return this.get<GitLabMergeRequest[]>(`/projects/${projectId}/merge_requests?${params}`);
  }

  /** Get a single merge request */
  async getMergeRequest(projectId: number, mrIid: number): Promise<GitLabMergeRequest> {
    return this.get<GitLabMergeRequest>(`/projects/${projectId}/merge_requests/${mrIid}`);
  }

  /** Create a merge request */
  async createMergeRequest(projectId: number, options: CreateMROptions): Promise<GitLabMergeRequest> {
    const body: Record<string, any> = {
      title: options.title,
      source_branch: options.sourceBranch,
      target_branch: options.targetBranch,
    };
    if (options.description) body.description = options.description;
    if (options.labels && options.labels.length > 0) body.labels = options.labels.join(',');
    if (options.draft !== undefined) body.draft = options.draft;
    if (options.removeSourceBranch !== undefined) body.remove_source_branch = options.removeSourceBranch;
    if (options.squash !== undefined) body.squash = options.squash;
    if (options.assigneeId !== undefined) body.assignee_id = options.assigneeId;
    return this.post<GitLabMergeRequest>(`/projects/${projectId}/merge_requests`, body);
  }

  /** Update a merge request (e.g., change title, description, labels) */
  async updateMergeRequest(
    projectId: number,
    mrIid: number,
    updates: Partial<{ title: string; description: string; labels: string[]; assigneeId: number; stateEvent: 'close' | 'reopen' }>,
  ): Promise<GitLabMergeRequest> {
    const body: Record<string, any> = {};
    if (updates.title !== undefined) body.title = updates.title;
    if (updates.description !== undefined) body.description = updates.description;
    if (updates.labels !== undefined) body.labels = updates.labels.join(',');
    if (updates.assigneeId !== undefined) body.assignee_id = updates.assigneeId;
    if (updates.stateEvent !== undefined) body.state_event = updates.stateEvent;
    return this.put<GitLabMergeRequest>(`/projects/${projectId}/merge_requests/${mrIid}`, body);
  }

  /** Merge a merge request */
  async mergeMergeRequest(
    projectId: number,
    mrIid: number,
    opts?: { mergeCommitMessage?: string; squash?: boolean; shouldRemoveSourceBranch?: boolean },
  ): Promise<GitLabMergeRequest> {
    const body: Record<string, any> = {};
    if (opts?.mergeCommitMessage) body.merge_commit_message = opts.mergeCommitMessage;
    if (opts?.squash !== undefined) body.squash = opts.squash;
    if (opts?.shouldRemoveSourceBranch !== undefined) body.should_remove_source_branch = opts.shouldRemoveSourceBranch;
    return this.put<GitLabMergeRequest>(`/projects/${projectId}/merge_requests/${mrIid}/merge`, body);
  }

  /** Get the diff of a merge request (changed files) */
  async getMergeRequestDiff(projectId: number, mrIid: number): Promise<GitLabMRDiffFile[]> {
    return this.get<GitLabMRDiffFile[]>(`/projects/${projectId}/merge_requests/${mrIid}/diffs`);
  }

  // ── Notes (Comments) ──────────────────────────────────────────────────

  /** List notes/comments on a merge request */
  async listMRNotes(projectId: number, mrIid: number): Promise<GitLabNote[]> {
    return this.get<GitLabNote[]>(`/projects/${projectId}/merge_requests/${mrIid}/notes`);
  }

  /** Create a note/comment on a merge request */
  async createMRNote(projectId: number, mrIid: number, body: string): Promise<GitLabNote> {
    return this.post<GitLabNote>(`/projects/${projectId}/merge_requests/${mrIid}/notes`, { body });
  }

  /** Create an inline review comment on a merge request diff */
  async createMRDiffNote(
    projectId: number,
    mrIid: number,
    options: { body: string; position: { baseSha: string; startSha: string; headSha: string; newPath: string; newLine: number; oldPath?: string; oldLine?: number } },
  ): Promise<GitLabNote> {
    return this.post<GitLabNote>(`/projects/${projectId}/merge_requests/${mrIid}/notes`, {
      body: options.body,
      position: options.position,
    });
  }

  // ── Issues ─────────────────────────────────────────────────────────────

  /** List issues for a project */
  async listIssues(
    projectId: number,
    opts?: { state?: 'opened' | 'closed' | 'all'; labels?: string[]; perPage?: number },
  ): Promise<GitLabIssue[]> {
    const params = new URLSearchParams();
    if (opts?.state) params.set('state', opts.state);
    if (opts?.labels && opts.labels.length > 0) params.set('labels', opts.labels.join(','));
    if (opts?.perPage) params.set('per_page', String(opts.perPage));
    else params.set('per_page', '20');
    return this.get<GitLabIssue[]>(`/projects/${projectId}/issues?${params}`);
  }

  /** Get a single issue */
  async getIssue(projectId: number, issueIid: number): Promise<GitLabIssue> {
    return this.get<GitLabIssue>(`/projects/${projectId}/issues/${issueIid}`);
  }

  /** Create an issue */
  async createIssue(projectId: number, options: CreateIssueOptions): Promise<GitLabIssue> {
    const body: Record<string, any> = { title: options.title };
    if (options.description) body.description = options.description;
    if (options.labels && options.labels.length > 0) body.labels = options.labels.join(',');
    if (options.assigneeId !== undefined) body.assignee_id = options.assigneeId;
    if (options.milestoneId !== undefined) body.milestone_id = options.milestoneId;
    return this.post<GitLabIssue>(`/projects/${projectId}/issues`, body);
  }

  /** Create an issue note/comment */
  async createIssueNote(projectId: number, issueIid: number, body: string): Promise<GitLabNote> {
    return this.post<GitLabNote>(`/projects/${projectId}/issues/${issueIid}/notes`, { body });
  }

  // ── Pipelines ──────────────────────────────────────────────────────────

  /** List pipelines for a project */
  async listPipelines(projectId: number, opts?: { ref?: string; status?: string; perPage?: number }): Promise<GitLabPipeline[]> {
    const params = new URLSearchParams();
    if (opts?.ref) params.set('ref', opts.ref);
    if (opts?.status) params.set('status', opts.status);
    if (opts?.perPage) params.set('per_page', String(opts.perPage));
    else params.set('per_page', '10');
    return this.get<GitLabPipeline[]>(`/projects/${projectId}/pipelines?${params}`);
  }

  // ── Repository / Files ─────────────────────────────────────────────────

  /** Get file content from a repository */
  async getFileContent(projectId: number, filePath: string, ref?: string): Promise<string | null> {
    try {
      const encodedPath = encodeURIComponent(filePath);
      const params = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const result = await this.get<{ content: string; encoding: string }>(
        `/projects/${projectId}/repository/files/${encodedPath}${params}`,
      );
      if (result.encoding === 'base64') {
        return Buffer.from(result.content, 'base64').toString('utf-8');
      }
      return result.content;
    } catch {
      return null;
    }
  }

  // ── Internal HTTP helpers ────────────────────────────────────────────────

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (this.token) {
      h['Authorization'] = `Bearer ${this.token}`;
    }
    return h;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: this.headers,
    });
    return handleResponse(response) as Promise<T>;
  }

  private async post<T>(path: string, body: Record<string, any>): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    return handleResponse(response) as Promise<T>;
  }

  private async put<T>(path: string, body: Record<string, any>): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    return handleResponse(response) as Promise<T>;
  }
}
