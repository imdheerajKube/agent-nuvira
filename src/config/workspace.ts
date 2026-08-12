/**
 * WorkspaceStore — Phase A2: workspace state + project registry.
 *
 * Replaces ad-hoc JSON state with a single SQLite database
 * (`~/.buff/workspaces.db` via `node:sqlite` `DatabaseSync`) so project
 * continuity has one source of truth: `projects(id, git_repo, cwd_hash,
 * prefs, last_session_id, last_run_at, last_goal, run_summary)` — STRICT
 * tables, WAL journal.
 *
 * Design (mirrors Hermes `hermes_state.py` / `hermes_state_schema.py`):
 * - **Tiered storage**: `node:sqlite` when available (Node ≥ 22.5), else a
 *   JSON-file fallback tier (`workspaces.json`). Both implement the SAME
 *   interface, so project continuity never depends on the runtime version.
 * - **Corruption tolerance**: a corrupt/unreadable DB (or JSON) file degrades
 *   to a FRESH workspace instead of crashing — the Hermes corruption-tolerance
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

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

import { resolveBuffConfigDir } from './paths.js';
import { logger } from '../utils/logger.js';

// node:sqlite is NOT in @types/node@20 — load it guarded via createRequire
// (never a static import) and shape the minimal API locally.
const require = createRequire(import.meta.url);

/** Minimal shape of the node:sqlite DatabaseSync API we use. */
interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: Array<string | number | null>): { changes: number };
    get(...params: Array<string | number | null>): Record<string, unknown> | undefined;
    all(...params: Array<string | number | null>): Record<string, unknown>[];
  };
  close(): void;
}

// ─── Types ──────────────────────────────────────────────────────────────────

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

// ─── Constants ──────────────────────────────────────────────────────────────

const JSON_VERSION = 1;
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id               TEXT PRIMARY KEY,
  git_repo         TEXT NOT NULL DEFAULT '',
  cwd_hash         TEXT NOT NULL DEFAULT '',
  prefs            TEXT NOT NULL DEFAULT '{}',
  last_session_id  TEXT NOT NULL DEFAULT '',
  last_run_at      INTEGER NOT NULL DEFAULT 0,
  last_goal        TEXT NOT NULL DEFAULT '',
  run_summary      TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
) STRICT`;

// ─── Helpers ────────────────────────────────────────────────────────────────

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

/**
 * Parse a git remote URL into a stable `owner/repo` slug (GitLab nested-group
 * paths like `group/sub/repo` are preserved verbatim so the slug is faithful
 * to the remote). Supports the common shapes: `https://github.com/owner/repo.git`,
 * `git@github.com:owner/repo.git`, `ssh://git@host/owner/repo.git`, and
 * arbitrary self-hosted `host:path`.
 */
export function parseGitRemoteSlug(remote: string): string {
  const r = remote.trim();
  if (!r) return '';
  let path = r;
  // scp-style: git@github.com:owner/repo.git
  if (/^[^@/]+@[^:/]+:/.test(path)) {
    path = path.replace(/^[^@/]+@[^:/]+:/, '');
  } else {
    // URL-style: scheme://host[:port]/owner/repo[.git]
    path = path.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    path = path.replace(/^[^/]+/, ''); // drop host[:port]
  }
  path = path.replace(/^\/+/, '').replace(/\.git$/, '');
  const parts = path.split('/').filter(Boolean);
  return parts.join('/');
}

/**
 * Detect the git remote slug for `cwd` ('' when not a git repo).
 * Cross-platform, best-effort, short timeout.
 */
function detectGitRemote(cwd: string): string {
  try {
    const out = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: 'pipe',
    });
    return parseGitRemoteSlug(out.trim());
  } catch {
    return '';
  }
}

/**
 * Derive the stable project identity for a working directory:
 * `{ id, gitRepo, cwdHash }`. The id is `repo:<slug>` when the cwd is inside
 * a git repo, else `cwd:<sha1(realpath)>` — both stable across sessions.
 */
export function deriveProjectId(cwd: string): { id: string; gitRepo: string; cwdHash: string } {
  let resolved = cwd;
  try {
    resolved = realpathSync(cwd);
  } catch {
    // cwd may not exist yet (a brand-new project) — hash the raw path.
  }
  const cwdHash = sha1(resolved).slice(0, 16);
  const gitRepo = detectGitRemote(cwd);
  const id = gitRepo ? `repo:${gitRepo}` : `cwd:${cwdHash}`;
  return { id, gitRepo, cwdHash };
}

// ─── Row mapping ────────────────────────────────────────────────────────────

interface ProjectRow {
  id: string;
  git_repo: string;
  cwd_hash: string;
  prefs: string;
  last_session_id: string;
  last_run_at: number;
  last_goal: string;
  run_summary: string;
  created_at: number;
  updated_at: number;
}

function rowToProject(row: ProjectRow): WorkspaceProject {
  let prefs: Record<string, unknown> = {};
  try {
    prefs = JSON.parse(row.prefs || '{}') as Record<string, unknown>;
  } catch {
    prefs = {};
  }
  return {
    id: row.id,
    gitRepo: row.git_repo || '',
    cwdHash: row.cwd_hash || '',
    prefs,
    lastSessionId: row.last_session_id || '',
    lastRunAt: row.last_run_at || 0,
    lastGoal: row.last_goal || '',
    runSummary: row.run_summary || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectToRow(p: WorkspaceProject): ProjectRow {
  return {
    id: p.id,
    git_repo: p.gitRepo || '',
    cwd_hash: p.cwdHash || '',
    prefs: JSON.stringify(p.prefs || {}),
    last_session_id: p.lastSessionId || '',
    last_run_at: p.lastRunAt || 0,
    last_goal: p.lastGoal || '',
    run_summary: p.runSummary || '',
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

// ─── WorkspaceStore ─────────────────────────────────────────────────────────

export class WorkspaceStore {
  private configDir: string;
  private backend: WorkspaceBackend = 'json';
  private db: DatabaseSyncLike | null = null;
  private dbPath: string;
  private jsonPath: string;
  /** In-memory mirror for the json tier (or fresh-degraded sqlite). */
  private jsonProjects: Record<string, WorkspaceProject> = {};
  private opened = false;

  constructor(configDir?: string, opts: { forceBackend?: WorkspaceBackend } = {}) {
    this.configDir = resolveBuffConfigDir(configDir);
    this.dbPath = join(this.configDir, 'workspaces.db');
    this.jsonPath = join(this.configDir, 'workspaces.json');
    this.backend = opts.forceBackend ?? this.pickBackend();
    // Register in the singleton cache so resetWorkspaceStore() closes the SQLite
    // handle even for DIRECTLY-constructed stores. Without this, an open
    // workspaces.db handle makes rmSync() of the config dir fail on Windows
    // (EPERM/EBUSY — POSIX allows deleting open files, Windows does not) and,
    // when that failure is swallowed, leaves stale rows behind for the next
    // test. getWorkspaceStore() checks the cache first, so this is idempotent.
    storeCache.set(this.configDir, this);
  }

  /** Feature-detect node:sqlite; fall back to the JSON tier when absent. */
  private pickBackend(): WorkspaceBackend {
    try {
      const mod = require('node:sqlite') as { DatabaseSync?: unknown } | undefined;
      return mod && typeof mod.DatabaseSync === 'function' ? 'sqlite' : 'json';
    } catch {
      return 'json';
    }
  }

  /** Lazy open: create dir, open the backend, ensure schema. Never throws. */
  private ensureOpen(): void {
    if (this.opened) return;
    this.opened = true;
    try {
      if (!existsSync(this.configDir)) {
        mkdirSync(this.configDir, { recursive: true });
      }
    } catch {
      // Best-effort — if the dir can't be created, both tiers degrade to empty.
      return;
    }
    if (this.backend === 'sqlite') {
      if (this.tryOpenSqlite()) return;
      // Corrupt/unopenable DB → degrade to the JSON tier (Hermes corruption
      // tolerance: a broken store never crashes the agent).
      this.backend = 'json';
      logger.warn('      ⚠️ workspaces.db unreadable — using JSON fallback tier');
    }
    this.tryOpenJson();
  }

  private tryOpenSqlite(): boolean {
    let db: DatabaseSyncLike | null = null;
    try {
      const mod = require('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSyncLike };
      db = new mod.DatabaseSync(this.dbPath);
      db.exec('PRAGMA journal_mode = WAL');
      db.exec(CREATE_TABLE_SQL);
      this.db = db;
      return true;
    } catch {
      // Close the half-opened handle: a corrupt DB leaves `db` allocated, and
      // on Windows an open workspaces.db handle makes rmSync() of the config
      // dir fail with EBUSY (POSIX allows deleting open files, Windows does not).
      try {
        db?.close();
      } catch { /* already closed */ }
      this.db = null;
      return false;
    }
  }

  private tryOpenJson(): void {
    try {
      if (existsSync(this.jsonPath)) {
        const raw = readFileSync(this.jsonPath, 'utf-8');
        const parsed = JSON.parse(raw) as { version?: number; projects?: Record<string, WorkspaceProject> };
        if (parsed && typeof parsed === 'object' && parsed.projects && typeof parsed.projects === 'object') {
          this.jsonProjects = parsed.projects;
        }
      }
    } catch {
      // Corrupt JSON → back it up and start fresh (never crash).
      try {
        if (existsSync(this.jsonPath)) {
          renameSync(this.jsonPath, `${this.jsonPath}.corrupt-${Date.now()}`);
        }
      } catch { /* best-effort */ }
      this.jsonProjects = {};
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Which backend is active and basic stats (for `buff doctor`).
   *
   * READ-ONLY: unlike getProjectForCwd, this NEVER creates a project row — a
   * diagnostic (`buff doctor`) must not write the registry as a side effect.
   */
  status(cwd?: string): WorkspaceStatus {
    this.ensureOpen();
    let currentProject: WorkspaceProject | null = null;
    if (cwd) {
      const { id } = deriveProjectId(cwd);
      currentProject = this.getProject(id);
    }
    return {
      backend: this.backend,
      dbPath: this.backend === 'sqlite' ? this.dbPath : this.jsonPath,
      projectCount: this.listProjects().length,
      currentProject,
    };
  }

  /** Load a project by id (null when missing). */
  getProject(id: string): WorkspaceProject | null {
    this.ensureOpen();
    if (this.backend === 'sqlite' && this.db) {
      try {
        const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
        return row ? rowToProject(row) : null;
      } catch {
        return null;
      }
    }
    return this.jsonProjects[id] || null;
  }

  /** Load (or create the stub of) the project for a cwd. */
  getProjectForCwd(cwd: string): WorkspaceProject {
    this.ensureOpen();
    const { id, gitRepo, cwdHash } = deriveProjectId(cwd);
    const existing = this.getProject(id);
    if (existing) return existing;
    const now = Date.now();
    const fresh: WorkspaceProject = {
      id,
      gitRepo,
      cwdHash,
      prefs: {},
      lastSessionId: '',
      lastRunAt: 0,
      lastGoal: '',
      runSummary: '',
      createdAt: now,
      updatedAt: now,
    };
    this.upsertProject(fresh);
    return fresh;
  }

  /** List all projects (most recently updated first). */
  listProjects(): WorkspaceProject[] {
    this.ensureOpen();
    if (this.backend === 'sqlite' && this.db) {
      try {
        const rows = this.db.prepare('SELECT * FROM projects').all() as unknown as ProjectRow[];
        return rows.map(rowToProject).sort((a, b) => b.updatedAt - a.updatedAt);
      } catch {
        return [];
      }
    }
    return Object.values(this.jsonProjects).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Insert or update a project row. Best-effort — never throws. */
  upsertProject(project: WorkspaceProject): void {
    this.ensureOpen();
    const row = projectToRow(project);
    if (this.backend === 'sqlite' && this.db) {
      try {
        this.db.prepare(`
          INSERT INTO projects (id, git_repo, cwd_hash, prefs, last_session_id, last_run_at, last_goal, run_summary, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            git_repo = excluded.git_repo,
            cwd_hash = excluded.cwd_hash,
            prefs = excluded.prefs,
            last_session_id = excluded.last_session_id,
            last_run_at = excluded.last_run_at,
            last_goal = excluded.last_goal,
            run_summary = excluded.run_summary,
            updated_at = excluded.updated_at
        `).run(
          row.id, row.git_repo, row.cwd_hash, row.prefs, row.last_session_id,
          row.last_run_at, row.last_goal, row.run_summary, row.created_at, row.updated_at,
        );
        return;
      } catch (err) {
        logger.debug(`Workspace sqlite write failed (non-critical): ${err}`);
        // A failed sqlite WRITE means the DB is no longer trustworthy — degrade
        // the whole tier to JSON so READS and WRITES agree on one source of
        // truth (the mirror must not diverge from what getProject/listProjects
        // return). Same corruption-tolerance principle as the open path.
        this.backend = 'json';
        try {
          this.db?.close();
        } catch { /* already closed */ }
        this.db = null;
        this.tryOpenJson();
      }
    }
    this.jsonProjects[project.id] = { ...project };
    this.writeJson();
  }

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
  }): WorkspaceProject | null {
    try {
      this.ensureOpen();
      const project = this.getProjectForCwd(input.cwd);
      const now = Date.now();
      const status = input.success === true ? '✅' : input.success === false ? '❌' : '➡️';
      // An explicit summary always carries the icon. Goal-only writes carry the
      // icon ONLY when success is explicit (true/false) — doctor/dashboards can
      // then read the outcome at a glance; a chat-session write (success
      // undefined) stays goal-only, no icon.
      let summary: string;
      if (input.summary) {
        summary = `${status} ${input.summary.slice(0, 500)}`;
      } else if (input.success === undefined) {
        summary = input.goal.slice(0, 500);
      } else {
        summary = `${status} ${input.goal.slice(0, 500)}`;
      }
      const updated: WorkspaceProject = {
        ...project,
        lastSessionId: input.sessionId || project.lastSessionId,
        lastRunAt: now,
        lastGoal: input.goal || project.lastGoal,
        runSummary: summary,
        updatedAt: now,
      };
      this.upsertProject(updated);
      return updated;
    } catch {
      return null;
    }
  }

  /** Close the sqlite handle (no-op for the json tier). */
  close(): void {
    try {
      this.db?.close();
    } catch { /* already closed */ }
    this.db = null;
  }

  // ── JSON tier persistence ──────────────────────────────────────────────

  private writeJson(): void {
    try {
      if (!existsSync(this.configDir)) {
        mkdirSync(this.configDir, { recursive: true });
      }
      writeFileSync(
        this.jsonPath,
        JSON.stringify({ version: JSON_VERSION, projects: this.jsonProjects }, null, 2),
        'utf-8',
      );
    } catch {
      // Best-effort — an unwritable fallback must never throw.
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

const storeCache = new Map<string, WorkspaceStore>();

/**
 * Get (or create) the shared WorkspaceStore for a config dir. Cached per dir
 * so ConfigManager instantiations share one handle; honors BUFF_CONFIG_DIR.
 */
export function getWorkspaceStore(configDir?: string): WorkspaceStore {
  const dir = resolveBuffConfigDir(configDir);
  let store = storeCache.get(dir);
  if (!store) {
    store = new WorkspaceStore(dir);
    storeCache.set(dir, store);
  }
  return store;
}

/** Reset the singleton cache (test isolation). */
export function resetWorkspaceStore(): void {
  for (const store of storeCache.values()) {
    store.close();
  }
  storeCache.clear();
}
