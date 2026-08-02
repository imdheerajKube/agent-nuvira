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
    author: {
        name: string;
        username: string;
    };
    assignees: Array<{
        name: string;
        username: string;
    }>;
    labels: string[];
    draft: boolean;
    mergedBy?: {
        name: string;
        username: string;
    };
    diffRefs?: {
        baseSha: string;
        headSha: string;
        startSha: string;
    };
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
    author: {
        name: string;
        username: string;
    };
    assignees: Array<{
        name: string;
        username: string;
    }>;
    milestone?: {
        title: string;
    };
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
    author: {
        name: string;
        username: string;
    };
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
export declare class GitLabAPIClient {
    private token;
    private baseUrl;
    constructor(token?: string, baseUrl?: string);
    /** Check if the client has a token configured */
    hasToken(): boolean;
    /** Verify the token is valid by calling /user */
    verifyToken(): Promise<{
        username: string;
        email: string;
    } | null>;
    /** List accessible projects, optionally filtered by search */
    listProjects(opts?: {
        search?: string;
        membership?: boolean;
        perPage?: number;
    }): Promise<GitLabProject[]>;
    /** Get a single project by ID or URL-encoded path */
    getProject(projectId: number | string): Promise<GitLabProject>;
    /** List merge requests for a project */
    listMergeRequests(projectId: number, opts?: {
        state?: 'opened' | 'closed' | 'merged' | 'all';
        labels?: string[];
        perPage?: number;
    }): Promise<GitLabMergeRequest[]>;
    /** Get a single merge request */
    getMergeRequest(projectId: number, mrIid: number): Promise<GitLabMergeRequest>;
    /** Create a merge request */
    createMergeRequest(projectId: number, options: CreateMROptions): Promise<GitLabMergeRequest>;
    /** Update a merge request (e.g., change title, description, labels) */
    updateMergeRequest(projectId: number, mrIid: number, updates: Partial<{
        title: string;
        description: string;
        labels: string[];
        assigneeId: number;
        stateEvent: 'close' | 'reopen';
    }>): Promise<GitLabMergeRequest>;
    /** Merge a merge request */
    mergeMergeRequest(projectId: number, mrIid: number, opts?: {
        mergeCommitMessage?: string;
        squash?: boolean;
        shouldRemoveSourceBranch?: boolean;
    }): Promise<GitLabMergeRequest>;
    /** Get the diff of a merge request (changed files) */
    getMergeRequestDiff(projectId: number, mrIid: number): Promise<GitLabMRDiffFile[]>;
    /** List notes/comments on a merge request */
    listMRNotes(projectId: number, mrIid: number): Promise<GitLabNote[]>;
    /** Create a note/comment on a merge request */
    createMRNote(projectId: number, mrIid: number, body: string): Promise<GitLabNote>;
    /** Create an inline review comment on a merge request diff */
    createMRDiffNote(projectId: number, mrIid: number, options: {
        body: string;
        position: {
            baseSha: string;
            startSha: string;
            headSha: string;
            newPath: string;
            newLine: number;
            oldPath?: string;
            oldLine?: number;
        };
    }): Promise<GitLabNote>;
    /** List issues for a project */
    listIssues(projectId: number, opts?: {
        state?: 'opened' | 'closed' | 'all';
        labels?: string[];
        perPage?: number;
    }): Promise<GitLabIssue[]>;
    /** Get a single issue */
    getIssue(projectId: number, issueIid: number): Promise<GitLabIssue>;
    /** Create an issue */
    createIssue(projectId: number, options: CreateIssueOptions): Promise<GitLabIssue>;
    /** Create an issue note/comment */
    createIssueNote(projectId: number, issueIid: number, body: string): Promise<GitLabNote>;
    /** List pipelines for a project */
    listPipelines(projectId: number, opts?: {
        ref?: string;
        status?: string;
        perPage?: number;
    }): Promise<GitLabPipeline[]>;
    /** Get file content from a repository */
    getFileContent(projectId: number, filePath: string, ref?: string): Promise<string | null>;
    private get headers();
    private get;
    private post;
    private put;
}
//# sourceMappingURL=gitlab-api-client.d.ts.map