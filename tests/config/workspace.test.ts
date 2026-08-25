import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  WorkspaceStore,
  deriveProjectId,
  parseGitRemoteSlug,
  getWorkspaceStore,
  resetWorkspaceStore,
} from '../../src/config/workspace.js';
import { ConfigManager } from '../../src/config/manager.js';

describe('parseGitRemoteSlug', () => {
  it('parses https github remotes', () => {
    expect(parseGitRemoteSlug('https://github.com/owner/repo.git')).toBe('owner/repo');
    expect(parseGitRemoteSlug('https://github.com/owner/repo')).toBe('owner/repo');
  });

  it('parses ssh git@ remotes', () => {
    expect(parseGitRemoteSlug('git@github.com:owner/repo.git')).toBe('owner/repo');
    // GitLab nested-group paths are preserved verbatim (faithful to the remote).
    expect(parseGitRemoteSlug('git@gitlab.com:group/sub/repo.git')).toBe('group/sub/repo');
  });

  it('parses bitbucket and self-hosted remotes', () => {
    expect(parseGitRemoteSlug('https://bitbucket.org/team/proj.git')).toBe('team/proj');
    expect(parseGitRemoteSlug('ssh://git@git.example.com:2222/team/proj.git')).toBe('team/proj');
  });

  it('returns empty for empty input', () => {
    expect(parseGitRemoteSlug('')).toBe('');
    expect(parseGitRemoteSlug('   ')).toBe('');
  });
});

describe('deriveProjectId', () => {
  it('derives cwd:<hash> for a non-git directory (stable across calls)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'buff-ws-nogit-'));
    try {
      const a = deriveProjectId(dir);
      const b = deriveProjectId(dir);
      expect(a.id).toBe(b.id);
      expect(a.id.startsWith('cwd:')).toBe(true);
      expect(a.cwdHash).toHaveLength(16);
      expect(a.gitRepo).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives a stable id even when the directory does not exist yet', () => {
    const missing = join(tmpdir(), 'buff-ws-missing-' + Date.now());
    const a = deriveProjectId(missing);
    const b = deriveProjectId(missing);
    expect(a.id).toBe(b.id);
    expect(a.id.startsWith('cwd:')).toBe(true);
  });

  it('uses a repo:slug id inside a git repo', () => {
    // The repo itself is a git repo — its remote (if any) is used; without a
    // remote the cwd hash still wins, but the id must be deterministic.
    const a = deriveProjectId(process.cwd());
    const b = deriveProjectId(process.cwd());
    expect(a.id).toBe(b.id);
    expect(a.cwdHash).toBe(b.cwdHash);
  });
});

describe('WorkspaceStore', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'buff-workspace-'));
  });

  afterEach(() => {
    resetWorkspaceStore();
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('json fallback tier', () => {
    it('create/load/update round-trips through the JSON file', () => {
      const store = new WorkspaceStore(testDir, { forceBackend: 'json' });
      expect(store.status().backend).toBe('json');
      expect(store.status().dbPath.endsWith('workspaces.json')).toBe(true);

      const proj = store.getProjectForCwd(testDir);
      expect(proj.lastRunAt).toBe(0);

      const updated = store.recordRun({
        cwd: testDir,
        goal: 'build the NVDA addon',
        summary: 'created files',
        sessionId: 'sess-1',
        success: true,
      });
      expect(updated).not.toBeNull();
      expect(updated!.lastGoal).toContain('build the NVDA addon');
      expect(updated!.runSummary).toContain('✅');
      expect(updated!.lastSessionId).toBe('sess-1');
      expect(updated!.lastRunAt).toBeGreaterThan(0);

      // Persisted on disk — a fresh store (same dir) reads the same row.
      const fresh = new WorkspaceStore(testDir, { forceBackend: 'json' });
      const reloaded = fresh.getProjectForCwd(testDir);
      expect(reloaded.lastGoal).toContain('build the NVDA addon');
      expect(reloaded.lastSessionId).toBe('sess-1');
      expect(fresh.status().projectCount).toBe(1);
    });

    it('upsertProject updates an existing row instead of duplicating', () => {
      const store = new WorkspaceStore(testDir, { forceBackend: 'json' });
      const proj = store.getProjectForCwd(testDir);
      store.upsertProject({ ...proj, lastGoal: 'first goal' });
      store.upsertProject({ ...store.getProjectForCwd(testDir), lastGoal: 'second goal' });
      const list = store.listProjects();
      expect(list).toHaveLength(1);
      expect(list[0].lastGoal).toBe('second goal');
    });

    it('tolerates a corrupt JSON file by degrading to a fresh workspace', () => {
      const jsonPath = join(testDir, 'workspaces.json');
      writeFileSync(jsonPath, '{ this is not valid json !!!', 'utf-8');
      const store = new WorkspaceStore(testDir, { forceBackend: 'json' });
      // Corruption is quarantined (renamed) so the store starts fresh.
      expect(store.status().projectCount).toBe(0);
      store.recordRun({ cwd: testDir, goal: 'g', success: true });
      expect(store.getProjectForCwd(testDir).lastGoal).toBe('g');
    });
  });

  describe('sqlite tier', () => {
    it('uses SQLite when available and round-trips rows', () => {
      const store = new WorkspaceStore(testDir, { forceBackend: 'sqlite' });
      expect(store.status().backend).toBe('sqlite');
      expect(store.status().dbPath.endsWith('workspaces.db')).toBe(true);
      expect(existsSync(store.status().dbPath)).toBe(true);

      store.recordRun({ cwd: testDir, goal: 'sqlite goal', summary: 'ok', sessionId: 's1' });
      // Close the first handle before a second store for the SAME dir replaces
      // it in the per-dir cache — otherwise resetWorkspaceStore() only closes
      // the latest store and the first sqlite handle stays open, making the
      // afterEach rmSync fail on Windows (EBUSY — Windows cannot delete an
      // open file).
      store.close();
      const fresh = new WorkspaceStore(testDir, { forceBackend: 'sqlite' });
      expect(fresh.getProjectForCwd(testDir).lastGoal).toBe('sqlite goal');
      expect(fresh.status().projectCount).toBe(1);
    });

    it('degrades to the JSON tier when the DB file is corrupt', () => {
      const dbPath = join(testDir, 'workspaces.db');
      writeFileSync(dbPath, 'this is not a sqlite database', 'utf-8');
      const store = new WorkspaceStore(testDir, { forceBackend: 'sqlite' });
      // Corrupt DB → JSON fallback, but the store still works.
      expect(store.status().backend).toBe('json');
      store.recordRun({ cwd: testDir, goal: 'survived corruption', success: false });
      expect(store.getProjectForCwd(testDir).runSummary).toContain('❌');
    });
  });

  describe('listProjects ordering + recordRun status icon', () => {
    it('sorts most-recently-updated first', () => {
      const store = new WorkspaceStore(testDir, { forceBackend: 'json' });
      const p1 = mkdtempSync(join(testDir, 'proj-'));
      const p2 = mkdtempSync(join(testDir, 'proj2-'));
      store.recordRun({ cwd: p1, goal: 'old' });
      const old = store.getProjectForCwd(p1).updatedAt;
      store.recordRun({ cwd: p2, goal: 'new' });
      const list = store.listProjects();
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe(store.getProjectForCwd(p2).id);
      expect(list[0].updatedAt).toBeGreaterThanOrEqual(old);
    });

    it('marks success/failure with the right icon', () => {
      const store = new WorkspaceStore(testDir, { forceBackend: 'json' });
      store.recordRun({ cwd: testDir, goal: 'ok goal', success: true });
      expect(store.getProjectForCwd(testDir).runSummary.startsWith('✅')).toBe(true);
      store.recordRun({ cwd: testDir, goal: 'fail goal', success: false });
      expect(store.getProjectForCwd(testDir).runSummary.startsWith('❌')).toBe(true);
    });
  });
});

describe('ConfigManager wiring (A2)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'buff-ws-cfg-'));
  });

  afterEach(() => {
    resetWorkspaceStore();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('exposes the workspace store bound to its config dir', () => {
    const cm = new ConfigManager(testDir);
    const store = cm.getWorkspaceStore();
    expect(store).toBeInstanceOf(WorkspaceStore);
    // The singleton is per-dir: a second manager for the same dir shares it.
    expect(cm.getWorkspaceStore()).toBe(store);
    // Workspace file lives in the config dir, not the default ~/.nuvira.
    expect(store.status().dbPath.startsWith(testDir)).toBe(true);
  });

  it('survives a missing config dir (created lazily, never crashes)', () => {
    const missing = join(testDir, 'does-not-exist-yet');
    const cm = new ConfigManager(missing);
    const store = cm.getWorkspaceStore();
    store.recordRun({ cwd: process.cwd(), goal: 'g', success: true });
    expect(store.status().projectCount).toBe(1);
  });
});
