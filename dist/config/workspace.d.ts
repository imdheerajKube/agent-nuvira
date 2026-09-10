/**
 * WorkspaceStore — Phase A2: workspace state + project registry.
 *
 * Replaces ad-hoc JSON state with a single SQLite database
 * (`~/.nuvira/workspaces.db` via `node:sqlite` `DatabaseSync`) so project
 * continuity has one source of truth: `projects(id, git_repo, cwd_hash,
 * prefs, last_session_id, last_run_at, last_goal, run_summary)` — STRICT
 * tables, WAL journal.
 *
 * Design:
 * - **Tiered storage**: `node:sqlite` when available (Node ≥ 22.5), else a
 *   JSON-file fallback tier (`workspaces.json`). Both implement the SAME
 *   interface, so project continuity never depends on the runtime version.
 * - **Corruption tolerance**: a corrupt/unreadable DB (or JSON) file degrades
 *   to a FRESH workspace instead of crashing — corruption-tolerance
 *   pattern. All reads/writes are best-effort and never throw.
 * - **projectId derivation**: from the git remote slug (`owner/repo`) when the
 *   cwd is inside a git repo, else a stable hash of the resolved cwd — so the
 *   same project maps to the same row across sessions, and project switch is
 *   instant (no re-scan).
 *
 * Loaded lazily by `ConfigManager.getWorkspaceStore()` (constructor is cheap —
 * the DB/file handle is opened on first read/write, so the dozens of
 * ConfigManager instantiations per CLI run never pay for unused handles).
 */
export interface WorkspaceProject {
    /** Stable project identifier (git slug `owner/repo` or `cwd:<hash>`). */
    id: string;
    /** Git remote slug ('' when the cwd is not inside a git repo). */
    gitRepo: string;
    /** Stable hash of the resolved cwd. */
    cwdHash: string;
    /** Per-project preferences (JSON-serializable). */
    prefs: Record<string, unknown>;
    /** Last chat session id recorded for this project. */
    lastSessionId: string;
    /** Epoch ms of the last recorded run. */
    lastRunAt: number;
    /** Last user goal recorded for this project. */
    lastGoal: string;
    /** Short summary of the last run. */
    runSummary: string;
    createdAt: number;
    updatedAt: number;
}
/** Which storage tier is active. */
export type WorkspaceBackend = 'sqlite' | 'json';
export interface WorkspaceStatus {
    backend: WorkspaceBackend;
    dbPath: string;
    projectCount: number;
    currentProject: WorkspaceProject | null;
}
/**
 * Parse a git remote URL into a stable `owner/repo` slug (GitLab nested-group
 * paths like `group/sub/repo` are preserved verbatim so the slug is faithful
 * to the remote). Supports the common shapes: `https://github.com/owner/repo.git`,
 * `git@github.com:owner/repo.git`, `ssh://git@host/owner/repo.git`, and
 * arbitrary self-hosted `host:path`.
 */
export declare function parseGitRemoteSlug(remote: string): string;
/**
 * Derive the stable project identity for a working directory:
 * `{ id, gitRepo, cwdHash }`. The id is `repo:<slug>` when the cwd is inside
 * a git repo, else `cwd:<sha1(realpath)>` — both stable across sessions.
 */
export declare function deriveProjectId(cwd: string): {
    id: string;
    gitRepo: string;
    cwdHash: string;
};
export declare class WorkspaceStore {
    private configDir;
    private backend;
    private db;
    private dbPath;
    private jsonPath;
    /** In-memory mirror for the json tier (or fresh-degraded sqlite). */
    private jsonProjects;
    private opened;
    constructor(configDir?: string, opts?: {
        forceBackend?: WorkspaceBackend;
    });
    /** Feature-detect node:sqlite; fall back to the JSON tier when absent. */
    private pickBackend;
    /** Lazy open: create dir, open the backend, ensure schema. Never throws. */
    private ensureOpen;
    private tryOpenSqlite;
    private tryOpenJson;
    /**
     * Which backend is active and basic stats (for `nuvira doctor`).
     *
     * READ-ONLY: unlike getProjectForCwd, this NEVER creates a project row — a
     * diagnostic (`nuvira doctor`) must not write the registry as a side effect.
     */
    status(cwd?: string): WorkspaceStatus;
    /** Load a project by id (null when missing). */
    getProject(id: string): WorkspaceProject | null;
    /** Load (or create the stub of) the project for a cwd. */
    getProjectForCwd(cwd: string): WorkspaceProject;
    /** List all projects (most recently updated first). */
    listProjects(): WorkspaceProject[];
    /** Insert or update a project row. Best-effort — never throws. */
    upsertProject(project: WorkspaceProject): void;
    /**
     * Record a run/session end for the project at `cwd`: bumps last_run_at,
     * last_goal, run_summary, last_session_id. Best-effort — never throws.
     */
    recordRun(input: {
        cwd: string;
        goal: string;
        summary?: string;
        sessionId?: string;
        success?: boolean;
    }): WorkspaceProject | null;
    /** Close the sqlite handle (no-op for the json tier). */
    close(): void;
    private writeJson;
}
/**
 * Get (or create) the shared WorkspaceStore for a config dir. Cached per dir
 * so ConfigManager instantiations share one handle; honors NUVIRA_CONFIG_DIR.
 */
export declare function getWorkspaceStore(configDir?: string): WorkspaceStore;
/** Reset the singleton cache (test isolation). */
export declare function resetWorkspaceStore(): void;
//# sourceMappingURL=workspace.d.ts.map