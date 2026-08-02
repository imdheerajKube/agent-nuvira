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
// ─── HTTP Helpers ───────────────────────────────────────────────────────────
const DEFAULT_GITLAB_URL = 'https://gitlab.com/api/v4';
function getDefaultToken() {
    return process.env.GITLAB_TOKEN || process.env.GITLAB_ACCESS_TOKEN || '';
}
function getDefaultBaseUrl() {
    const envUrl = process.env.GITLAB_URL || process.env.CI_SERVER_URL;
    if (envUrl) {
        const base = envUrl.replace(/\/+$/, '');
        return base.endsWith('/api/v4') ? base : `${base}/api/v4`;
    }
    return DEFAULT_GITLAB_URL;
}
function createAPIError(message, status, body) {
    const err = new Error(message);
    err.status = status;
    err.body = body;
    return err;
}
async function handleResponse(response) {
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        const status = response.status;
        if (status === 401)
            throw createAPIError('GitLab authentication failed — check GITLAB_TOKEN', status, body);
        if (status === 403)
            throw createAPIError('GitLab access denied — token may lack permissions', status, body);
        if (status === 404)
            throw createAPIError('GitLab resource not found', status, body);
        if (status === 429)
            throw createAPIError('GitLab rate limit exceeded — try again later', status, body);
        throw createAPIError(`GitLab API error: ${status} — ${body.slice(0, 200)}`, status, body);
    }
    // Handle 204 No Content
    if (response.status === 204)
        return null;
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
    token;
    baseUrl;
    constructor(token, baseUrl) {
        this.token = token || getDefaultToken();
        this.baseUrl = (baseUrl || getDefaultBaseUrl()).replace(/\/+$/, '');
    }
    // ── Auth ───────────────────────────────────────────────────────────────
    /** Check if the client has a token configured */
    hasToken() {
        return this.token.length > 0;
    }
    /** Verify the token is valid by calling /user */
    async verifyToken() {
        try {
            const user = await this.get('/user');
            return { username: user.username, email: user.email || '' };
        }
        catch {
            return null;
        }
    }
    // ── Projects ───────────────────────────────────────────────────────────
    /** List accessible projects, optionally filtered by search */
    async listProjects(opts) {
        const params = new URLSearchParams();
        if (opts?.search)
            params.set('search', opts.search);
        if (opts?.membership)
            params.set('membership', 'true');
        if (opts?.perPage)
            params.set('per_page', String(opts.perPage));
        else
            params.set('per_page', '50');
        return this.get(`/projects?${params}`);
    }
    /** Get a single project by ID or URL-encoded path */
    async getProject(projectId) {
        const path = typeof projectId === 'string' ? encodeURIComponent(projectId) : String(projectId);
        return this.get(`/projects/${path}`);
    }
    // ── Merge Requests ─────────────────────────────────────────────────────
    /** List merge requests for a project */
    async listMergeRequests(projectId, opts) {
        const params = new URLSearchParams();
        if (opts?.state)
            params.set('state', opts.state);
        if (opts?.labels && opts.labels.length > 0)
            params.set('labels', opts.labels.join(','));
        if (opts?.perPage)
            params.set('per_page', String(opts.perPage));
        else
            params.set('per_page', '20');
        return this.get(`/projects/${projectId}/merge_requests?${params}`);
    }
    /** Get a single merge request */
    async getMergeRequest(projectId, mrIid) {
        return this.get(`/projects/${projectId}/merge_requests/${mrIid}`);
    }
    /** Create a merge request */
    async createMergeRequest(projectId, options) {
        const body = {
            title: options.title,
            source_branch: options.sourceBranch,
            target_branch: options.targetBranch,
        };
        if (options.description)
            body.description = options.description;
        if (options.labels && options.labels.length > 0)
            body.labels = options.labels.join(',');
        if (options.draft !== undefined)
            body.draft = options.draft;
        if (options.removeSourceBranch !== undefined)
            body.remove_source_branch = options.removeSourceBranch;
        if (options.squash !== undefined)
            body.squash = options.squash;
        if (options.assigneeId !== undefined)
            body.assignee_id = options.assigneeId;
        return this.post(`/projects/${projectId}/merge_requests`, body);
    }
    /** Update a merge request (e.g., change title, description, labels) */
    async updateMergeRequest(projectId, mrIid, updates) {
        const body = {};
        if (updates.title !== undefined)
            body.title = updates.title;
        if (updates.description !== undefined)
            body.description = updates.description;
        if (updates.labels !== undefined)
            body.labels = updates.labels.join(',');
        if (updates.assigneeId !== undefined)
            body.assignee_id = updates.assigneeId;
        if (updates.stateEvent !== undefined)
            body.state_event = updates.stateEvent;
        return this.put(`/projects/${projectId}/merge_requests/${mrIid}`, body);
    }
    /** Merge a merge request */
    async mergeMergeRequest(projectId, mrIid, opts) {
        const body = {};
        if (opts?.mergeCommitMessage)
            body.merge_commit_message = opts.mergeCommitMessage;
        if (opts?.squash !== undefined)
            body.squash = opts.squash;
        if (opts?.shouldRemoveSourceBranch !== undefined)
            body.should_remove_source_branch = opts.shouldRemoveSourceBranch;
        return this.put(`/projects/${projectId}/merge_requests/${mrIid}/merge`, body);
    }
    /** Get the diff of a merge request (changed files) */
    async getMergeRequestDiff(projectId, mrIid) {
        return this.get(`/projects/${projectId}/merge_requests/${mrIid}/diffs`);
    }
    // ── Notes (Comments) ──────────────────────────────────────────────────
    /** List notes/comments on a merge request */
    async listMRNotes(projectId, mrIid) {
        return this.get(`/projects/${projectId}/merge_requests/${mrIid}/notes`);
    }
    /** Create a note/comment on a merge request */
    async createMRNote(projectId, mrIid, body) {
        return this.post(`/projects/${projectId}/merge_requests/${mrIid}/notes`, { body });
    }
    /** Create an inline review comment on a merge request diff */
    async createMRDiffNote(projectId, mrIid, options) {
        return this.post(`/projects/${projectId}/merge_requests/${mrIid}/notes`, {
            body: options.body,
            position: options.position,
        });
    }
    // ── Issues ─────────────────────────────────────────────────────────────
    /** List issues for a project */
    async listIssues(projectId, opts) {
        const params = new URLSearchParams();
        if (opts?.state)
            params.set('state', opts.state);
        if (opts?.labels && opts.labels.length > 0)
            params.set('labels', opts.labels.join(','));
        if (opts?.perPage)
            params.set('per_page', String(opts.perPage));
        else
            params.set('per_page', '20');
        return this.get(`/projects/${projectId}/issues?${params}`);
    }
    /** Get a single issue */
    async getIssue(projectId, issueIid) {
        return this.get(`/projects/${projectId}/issues/${issueIid}`);
    }
    /** Create an issue */
    async createIssue(projectId, options) {
        const body = { title: options.title };
        if (options.description)
            body.description = options.description;
        if (options.labels && options.labels.length > 0)
            body.labels = options.labels.join(',');
        if (options.assigneeId !== undefined)
            body.assignee_id = options.assigneeId;
        if (options.milestoneId !== undefined)
            body.milestone_id = options.milestoneId;
        return this.post(`/projects/${projectId}/issues`, body);
    }
    /** Create an issue note/comment */
    async createIssueNote(projectId, issueIid, body) {
        return this.post(`/projects/${projectId}/issues/${issueIid}/notes`, { body });
    }
    // ── Pipelines ──────────────────────────────────────────────────────────
    /** List pipelines for a project */
    async listPipelines(projectId, opts) {
        const params = new URLSearchParams();
        if (opts?.ref)
            params.set('ref', opts.ref);
        if (opts?.status)
            params.set('status', opts.status);
        if (opts?.perPage)
            params.set('per_page', String(opts.perPage));
        else
            params.set('per_page', '10');
        return this.get(`/projects/${projectId}/pipelines?${params}`);
    }
    // ── Repository / Files ─────────────────────────────────────────────────
    /** Get file content from a repository */
    async getFileContent(projectId, filePath, ref) {
        try {
            const encodedPath = encodeURIComponent(filePath);
            const params = ref ? `?ref=${encodeURIComponent(ref)}` : '';
            const result = await this.get(`/projects/${projectId}/repository/files/${encodedPath}${params}`);
            if (result.encoding === 'base64') {
                return Buffer.from(result.content, 'base64').toString('utf-8');
            }
            return result.content;
        }
        catch {
            return null;
        }
    }
    // ── Internal HTTP helpers ────────────────────────────────────────────────
    get headers() {
        const h = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        };
        if (this.token) {
            h['Authorization'] = `Bearer ${this.token}`;
        }
        return h;
    }
    async get(path) {
        const response = await fetch(`${this.baseUrl}${path}`, {
            method: 'GET',
            headers: this.headers,
        });
        return handleResponse(response);
    }
    async post(path, body) {
        const response = await fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(body),
        });
        return handleResponse(response);
    }
    async put(path, body) {
        const response = await fetch(`${this.baseUrl}${path}`, {
            method: 'PUT',
            headers: this.headers,
            body: JSON.stringify(body),
        });
        return handleResponse(response);
    }
}
//# sourceMappingURL=gitlab-api-client.js.map