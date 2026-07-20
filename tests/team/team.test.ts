/**
 * Tests for Team Collaboration module — config, memory, and review.
 *
 * Covers:
 * - Team Config: findProjectConfig, getTeamConfig, hasProjectConfig, getTeamDataDir
 * - Team Memory: initTeamMemory, syncTeamMemory, shareTrajectories, getTeamMemoryStats
 * - Team Review: createReview, getReview, listReviews, addReviewComment,
 *   mergeReview, rejectReview, createReviewFromResult
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Mocks (hoisted) ────────────────────────────────────────────────────────

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    copyFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import * as fs from 'node:fs';
import { execSync } from 'node:child_process';

import {
  DEFAULT_TEAM_CONFIG,
  findProjectConfig,
  getTeamConfig,
  hasProjectConfig,
  getTeamDataDir,
} from '../../src/team/config.js';

import {
  initTeamMemory,
  syncTeamMemory,
  shareTrajectories,
  getTeamMemoryStats,
} from '../../src/team/memory.js';

import {
  createReview,
  getReview,
  listReviews,
  addReviewComment,
  mergeReview,
  rejectReview,
  createReviewFromResult,
  type ReviewBundle,
  type ReviewFileChange,
} from '../../src/team/review.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Reset all mock state between tests */
function resetAll() {
  vi.clearAllMocks();
  // Re-apply default mock behaviors after clear
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.readFileSync).mockReturnValue('');
  vi.mocked(execSync).mockReturnValue('');
}

// ═══════════════════════════════════════════════════════════════════════════
// Team Config Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Team Config', () => {
  beforeEach(() => {
    // Don't call resetAll() here because vi.clearAllMocks() resets the
    // nested vi.fn() instances inside the ConfigManager mock factory.
    // Each test sets up its own fs mocks before the first assertion anyway.
  });

  describe('DEFAULT_TEAM_CONFIG', () => {
    it('has expected default values', () => {
      expect(DEFAULT_TEAM_CONFIG.branch).toBe('main');
      expect(DEFAULT_TEAM_CONFIG.autoSyncMinutes).toBe(0);
      expect(DEFAULT_TEAM_CONFIG.shareTrajectories).toBe(true);
    });
  });

  describe('findProjectConfig', () => {
    it('returns null when no project config file exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const result = findProjectConfig('/some/project');
      expect(result).toBeNull();
      expect(fs.existsSync).toHaveBeenCalled();
    });

    it('returns parsed config when .buffconfig.json exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ defaultProvider: 'groq', providers: {}, team: { repository: 'https://github.com/team/repo.git' } }),
      );

      const result = findProjectConfig('/some/project');
      expect(result).not.toBeNull();
      expect(result!.defaultProvider).toBe('groq');
      expect(result!.team?.repository).toBe('https://github.com/team/repo.git');
    });

    it('tries next filename when first is unreadable', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync)
        .mockImplementationOnce(() => { throw new Error('Invalid JSON'); })
        .mockReturnValueOnce(JSON.stringify({ defaultProvider: 'gemini', providers: {} }));

      const result = findProjectConfig('/some/project');
      expect(result).not.toBeNull();
      expect(result!.defaultProvider).toBe('gemini');
    });
  });

  describe('getTeamConfig', () => {
    it('returns project-level team config when available', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ defaultProvider: 'groq', providers: {}, team: { repository: 'https://github.com/team/repo.git', branch: 'develop' } }),
      );

      const result = getTeamConfig('/project');
      expect(result.repository).toBe('https://github.com/team/repo.git');
      expect(result.branch).toBe('develop');
      expect(result.shareTrajectories).toBe(true); // from defaults
    });

    it('returns user config when findProjectConfig returns null', () => {
      // With no project config file, getTeamConfig falls through
      // to the ConfigManager (mocked) for user-level settings.
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const result = getTeamConfig('/project');
      // The function should return without crashing
      expect(result).toBeDefined();
      expect(typeof result.branch).toBe('string');
      expect(typeof result.shareTrajectories).toBe('boolean');
    });
  });

  describe('hasProjectConfig', () => {
    it('returns true when findProjectConfig returns non-null', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ defaultProvider: 'local', providers: {} }));
      expect(hasProjectConfig('/project')).toBe(true);
    });

    it('returns false when findProjectConfig returns null', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(hasProjectConfig('/project')).toBe(false);
    });
  });

  describe('getTeamDataDir', () => {
    it('returns a valid team data directory path', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const result = getTeamDataDir('/project');
      // Should return a non-empty string path
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Team Memory Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Team Memory', () => {
  beforeEach(() => {
    resetAll();
  });

  describe('initTeamMemory', () => {
    it('clones repository when repoUrl is provided', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      await initTeamMemory('https://github.com/team/repo.git');

      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('git clone'),
        expect.objectContaining({ timeout: 120_000 }),
      );
    });

    it('initializes empty repo when no repoUrl', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await initTeamMemory();

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('trajectories'),
        expect.objectContaining({ recursive: true }),
      );
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('patterns'),
        expect.objectContaining({ recursive: true }),
      );
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('templates'),
        expect.objectContaining({ recursive: true }),
      );
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.gitkeep'),
        '',
      );
      expect(execSync).toHaveBeenCalledWith('git init', expect.any(Object));
    });

    it('handles clone failure due to existing directory gracefully', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execSync).mockImplementationOnce(() => {
        const err = new Error('already exists') as Error & { stderr?: string };
        err.stderr = 'fatal: destination path already exists';
        throw err;
      });

      await expect(initTeamMemory('https://github.com/team/repo.git')).resolves.toBeUndefined();
    });
  });

  describe('syncTeamMemory', () => {
    it('throws when not a git repo', async () => {
      vi.mocked(execSync).mockImplementation(() => { throw new Error('not a git repository'); });
      await expect(syncTeamMemory()).rejects.toThrow('not a git repository');
    });

    it('works in local-only mode (no remote)', async () => {
      vi.mocked(execSync)
        .mockReturnValueOnce('')        // rev-parse (isGitRepo)
        .mockReturnValueOnce('')        // status --porcelain → no changes
        .mockImplementationOnce(() => { throw new Error('No remote'); }); // remote -v

      const result = await syncTeamMemory();
      expect(result.pulled).toBe(0);
      expect(result.pushed).toBe(0);
    });

    it('handles conflicts during pull', async () => {
      vi.mocked(execSync)
        .mockReturnValueOnce('')         // rev-parse (isGitRepo)
        .mockReturnValueOnce(' M f.ts')  // status → has changes
        .mockReturnValueOnce('')         // add -A
        .mockReturnValueOnce('')         // commit
        .mockReturnValueOnce('origin')   // remote -v → has remote
        .mockReturnValueOnce('main')     // rev-parse HEAD
        .mockImplementationOnce(() => {  // pull → conflict!
          const err = new Error('CONFLICT') as Error & { stderr?: string };
          err.stderr = 'CONFLICT (content): Merge conflict';
          throw err;
        });

      const result = await syncTeamMemory();
      expect(result.conflicts.length).toBeGreaterThan(0);
    });
  });

  describe('shareTrajectories', () => {
    it('returns 0 when no local trajectories directory', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(await shareTrajectories()).toBe(0);
    });

    it('shares trajectory files', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync)
        .mockReturnValueOnce(['traj-1.json', 'notes.txt', 'traj-2.json'] as any)
        .mockReturnValueOnce([] as any);
      // Return unique content per read so files are never skipped as identical
      let c = 0;
      vi.mocked(fs.readFileSync).mockImplementation(() => `content-${++c}`);

      expect(await shareTrajectories()).toBe(2);
      expect(fs.copyFileSync).toHaveBeenCalledTimes(2);
    });

    it('skips identical files', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync)
        .mockReturnValueOnce(['traj-1.json'] as any)
        .mockReturnValueOnce([] as any);
      // Both src and dst return same content → identical → skip
      vi.mocked(fs.readFileSync).mockReturnValue('same content');

      expect(await shareTrajectories()).toBe(0);
      expect(fs.copyFileSync).not.toHaveBeenCalled();
    });

    it('also shares pattern files', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync)
        .mockReturnValueOnce(['traj.json'] as any)
        .mockReturnValueOnce(['pattern.json'] as any);
      let c = 0;
      vi.mocked(fs.readFileSync).mockImplementation(() => `content-${++c}`);

      expect(await shareTrajectories()).toBe(2);
    });
  });

  describe('getTeamMemoryStats', () => {
    it('returns zeros when team directory does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const stats = getTeamMemoryStats();
      expect(stats.trajectoryCount).toBe(0);
      expect(stats.patternCount).toBe(0);
      expect(stats.templateCount).toBe(0);
      expect(stats.gitConfigured).toBe(false);
      expect(stats.branch).toBe('N/A');
    });

    it('returns stats from a configured git repo', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync)
        .mockReturnValueOnce(['t1.json', 't2.json'] as any)
        .mockReturnValueOnce(['p1.json'] as any)
        .mockReturnValueOnce(['tmpl.json'] as any);
      vi.mocked(execSync)
        .mockReturnValueOnce('')           // rev-parse → isGitRepo
        .mockReturnValueOnce('main')       // rev-parse HEAD → branch
        .mockReturnValueOnce(' M f.ts')    // status → 1 change
        .mockReturnValueOnce('2026-07-19 12:00:00 -0400'); // log

      const stats = getTeamMemoryStats();
      expect(stats.trajectoryCount).toBe(2);
      expect(stats.patternCount).toBe(1);
      expect(stats.templateCount).toBe(1);
      expect(stats.gitConfigured).toBe(true);
      expect(stats.branch).toBe('main');
      expect(stats.uncommittedChanges).toBeGreaterThan(0);
      expect(stats.lastSync).toContain('2026');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Team Review Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Team Review', () => {
  let lastReviewId: string;

  beforeEach(() => {
    resetAll();

    // Default: reviews index doesn't exist → readIndex returns empty
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ reviews: [] }));

    // Capture review IDs when bundles are written
    vi.mocked(fs.writeFileSync).mockImplementation((path: string | Buffer | URL, content: string | Buffer) => {
      const pathStr = typeof path === 'string' ? path : String(path);
      if (pathStr.includes('review-')) {
        try {
          const c = typeof content === 'string' ? content : String(content);
          const parsed = JSON.parse(c);
          if (parsed.id) lastReviewId = parsed.id;
        } catch { /* ignore */ }
      }
    });
  });

  function makeFC(overrides: Partial<ReviewFileChange> = {}): ReviewFileChange {
    return {
      path: 'src/file.ts',
      newContent: 'console.log("hello");',
      status: 'created',
      ...overrides,
    };
  }

  function makeBundle(id: string, overrides: Partial<ReviewBundle> = {}): ReviewBundle {
    return {
      id, title: 'Test', goal: 'Goal', author: 'author',
      status: 'pending', createdAt: Date.now(),
      provider: 'groq', model: 'default',
      changes: [], comments: [], tags: [],
      ...overrides,
    };
  }

  /** Setup mocks so readFileSync returns index data for index path, bundle data otherwise */
  function setupBundleRead(bundle: ReviewBundle, extraIndexEntries: any[] = []): void {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((path: string | Buffer | URL) => {
      const p = typeof path === 'string' ? path : String(path);
      if (p.includes('index.json')) {
        return JSON.stringify({
          reviews: [
            { id: bundle.id, title: bundle.title, status: bundle.status, createdAt: bundle.createdAt, author: bundle.author },
            ...extraIndexEntries,
          ],
        });
      }
      return JSON.stringify(bundle);
    });
  }

  // ── createReview ───────────────────────────────────────────────────────

  describe('createReview', () => {
    it('creates a review bundle with pending status', () => {
      const bundle = createReview('Add feature', 'Implement login', [makeFC()]);
      expect(bundle.status).toBe('pending');
      expect(bundle.title).toBe('Add feature');
      expect(bundle.goal).toBe('Implement login');
      expect(bundle.changes).toHaveLength(1);
      expect(bundle.comments).toEqual([]);
      expect(bundle.tags).toEqual([]);
    });

    it('saves bundle to disk and updates index', () => {
      createReview('Fix bug', 'Fix auth bug', [makeFC()], { provider: 'groq', model: 'llama-3.3-70b', tags: ['bug-fix'] });

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining(lastReviewId),
        expect.any(String),
        'utf-8',
      );
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('index.json'),
        expect.any(String),
        'utf-8',
      );
    });

    it('accepts optional metadata', () => {
      const bundle = createReview('Refactor', 'Refactor module', [makeFC()], {
        provider: 'gemini', model: 'gemini-2.0-flash', author: 'test-user',
        summary: 'Refactored auth', tags: ['refactor', 'auth'],
      });
      expect(bundle.provider).toBe('gemini');
      expect(bundle.model).toBe('gemini-2.0-flash');
      expect(bundle.author).toBe('test-user');
      expect(bundle.summary).toBe('Refactored auth');
      expect(bundle.tags).toEqual(['refactor', 'auth']);
    });

    it('limits index to 100 entries', () => {
      const existing = Array.from({ length: 100 }, (_, i) => ({
        id: `old-${i}`, title: `Old ${i}`, status: 'merged' as const,
        createdAt: Date.now() - (100 - i) * 1000, author: 'user',
      }));
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ reviews: existing }));

      createReview('Latest', 'Do something', [makeFC()]);

      const indexCalls = vi.mocked(fs.writeFileSync).mock.calls.filter(
        ([p]: any) => typeof p === 'string' && p.includes('index.json'),
      );
      expect(indexCalls.length).toBeGreaterThan(0);
      const idx = JSON.parse(indexCalls[indexCalls.length - 1][1] as string);
      expect(idx.reviews.length).toBeLessThanOrEqual(100);
    });
  });

  // ── getReview ──────────────────────────────────────────────────────────

  describe('getReview', () => {
    it('returns null when review does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(getReview('nonexistent')).toBeNull();
    });

    it('returns parsed bundle when review exists', () => {
      const bundle = makeBundle('review-test-123', { changes: [{ path: 'f.ts', status: 'created', newContent: 'x' }] });
      setupBundleRead(bundle);

      const result = getReview('review-test-123');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('review-test-123');
      expect(result!.title).toBe('Test');
    });

    it('returns null when file is malformed', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not valid json');
      expect(getReview('malformed')).toBeNull();
    });
  });

  // ── listReviews ────────────────────────────────────────────────────────

  describe('listReviews', () => {
    it('returns empty array when no reviews', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ reviews: [] }));
      expect(listReviews()).toEqual([]);
    });

    it('returns reviews sorted by recency (newest first)', () => {
      const entries = [
        { id: 'review-a', title: 'A', status: 'pending' as const, createdAt: 3000, author: 'alice' },
        { id: 'review-b', title: 'B', status: 'pending' as const, createdAt: 2000, author: 'bob' },
        { id: 'review-c', title: 'C', status: 'pending' as const, createdAt: 1000, author: 'charlie' },
      ];

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((path: string | Buffer | URL) => {
        const p = typeof path === 'string' ? path : String(path);
        if (p.includes('index.json')) return JSON.stringify({ reviews: entries });
        const m = p.match(/review-([a-z])\.json$/);
        if (m) {
          const e = entries.find(r => r.id === `review-${m[1]}`);
          if (e) return JSON.stringify(makeBundle(e.id, { title: e.title, author: e.author, createdAt: e.createdAt }));
        }
        return '{}';
      });

      const reviews = listReviews(10);
      expect(reviews).toHaveLength(3);
      expect(reviews[0].id).toBe('review-a');
      expect(reviews[1].id).toBe('review-b');
      expect(reviews[2].id).toBe('review-c');
    });

    it('respects the limit parameter', () => {
      const entries = Array.from({ length: 50 }, (_, i) => ({
        id: `review-${i}`, title: `R${i}`, status: 'pending' as const, createdAt: i, author: 'u',
      }));

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((path: string | Buffer | URL) => {
        const p = typeof path === 'string' ? path : String(path);
        if (p.includes('index.json')) return JSON.stringify({ reviews: entries });
        const m = p.match(/review-(\d+)\.json$/);
        if (m) {
          const e = entries.find(r => r.id === `review-${m[1]}`);
          if (e) return JSON.stringify(makeBundle(e.id));
        }
        return '{}';
      });

      expect(listReviews(5)).toHaveLength(5);
    });
  });

  // ── addReviewComment ───────────────────────────────────────────────────

  describe('addReviewComment', () => {
    it('returns null for non-existent review', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(addReviewComment('nonexistent', 'reviewer', 'comment', 'Looks good')).toBeNull();
    });

    it('sets status to approved when approving', () => {
      const bundle = makeBundle('review-approve');
      setupBundleRead(bundle);

      const result = addReviewComment('review-approve', 'reviewer', 'approve', 'Looks great!');
      expect(result!.status).toBe('approved');
      expect(result!.comments).toHaveLength(1);
      expect(result!.comments[0].reviewer).toBe('reviewer');
      expect(result!.comments[0].comment).toBe('Looks great!');
    });

    it('sets status to changes-requested when requesting changes', () => {
      const bundle = makeBundle('review-changes');
      setupBundleRead(bundle);

      const result = addReviewComment('review-changes', 'reviewer', 'request-changes', 'Fix this');
      expect(result!.status).toBe('changes-requested');
    });

    it('keeps status unchanged when just commenting', () => {
      const bundle = makeBundle('review-comment');
      setupBundleRead(bundle);

      const result = addReviewComment('review-comment', 'reviewer', 'comment', 'Just a thought');
      expect(result!.status).toBe('pending');
      expect(result!.comments).toHaveLength(1);
    });
  });

  // ── mergeReview ────────────────────────────────────────────────────────

  describe('mergeReview', () => {
    function approvedBundle(): ReviewBundle {
      return makeBundle('review-merge', {
        status: 'approved',
        changes: [
          { path: 'src/new.ts', newContent: 'const x = 1;', status: 'created' },
          { path: 'src/existing.ts', originalContent: 'old', newContent: 'new', status: 'modified' },
          { path: 'src/old.ts', status: 'deleted' },
        ],
      });
    }

    it('returns 0 when review not found', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(mergeReview('nonexistent')).toBe(0);
    });

    it('returns 0 when review is rejected', () => {
      const bundle = approvedBundle();
      bundle.status = 'rejected';
      setupBundleRead(bundle);
      expect(mergeReview('review-merge', '/tmp/test')).toBe(0);
    });

    it('returns 0 when review is pending', () => {
      const bundle = approvedBundle();
      bundle.status = 'pending';
      setupBundleRead(bundle);
      expect(mergeReview('review-merge', '/tmp/test')).toBe(0);
    });

    it('applies created and modified files from an approved review', () => {
      const bundle = approvedBundle();
      setupBundleRead(bundle);

      const count = mergeReview('review-merge', '/tmp/test');
      expect(count).toBe(3); // created + modified + deleted (all use proper imports now)
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('new.ts'),
        'const x = 1;',
        'utf-8',
      );
    });

    it('updates status to merged after applying', () => {
      const bundle = approvedBundle();
      setupBundleRead(bundle);

      mergeReview('review-merge', '/tmp/test');

      const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(
        ([p]: any) => typeof p === 'string' && p.includes('review-merge'),
      );
      expect(writes.length).toBeGreaterThan(0);
      expect(JSON.parse(writes[writes.length - 1][1] as string).status).toBe('merged');
    });
  });

  // ── rejectReview ───────────────────────────────────────────────────────

  describe('rejectReview', () => {
    it('returns false when review not found', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(rejectReview('nonexistent')).toBe(false);
    });

    it('sets status to rejected', () => {
      const bundle = makeBundle('review-reject');
      setupBundleRead(bundle);
      expect(rejectReview('review-reject')).toBe(true);
    });

    it('adds a comment with reason when provided', () => {
      const bundle = makeBundle('review-reject');
      setupBundleRead(bundle);

      rejectReview('review-reject', 'Does not meet requirements');

      const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(
        ([p]: any) => typeof p === 'string' && p.includes('review-reject'),
      );
      expect(writes.length).toBeGreaterThan(0);
      const saved = JSON.parse(writes[writes.length - 1][1] as string);
      expect(saved.status).toBe('rejected');
      expect(saved.comments).toHaveLength(1);
      expect(saved.comments[0].comment).toBe('Does not meet requirements');
    });
  });

  // ── createReviewFromResult ─────────────────────────────────────────────

  describe('createReviewFromResult', () => {
    it('creates a review from orchestrator file changes', () => {
      const changes = [
        { path: 'src/new.ts', newContent: 'const greet = () => "Hello";', status: 'created' },
        { path: 'src/existing.ts', originalContent: 'old', newContent: 'new', status: 'modified' },
      ];

      vi.mocked(fs.existsSync).mockReturnValue(false);
      const bundle = createReviewFromResult('Add greeting', changes, 'Created 2 files', { provider: 'groq' });

      expect(bundle.status).toBe('pending');
      expect(bundle.changes).toHaveLength(2);
      expect(bundle.changes[0].path).toBe('src/new.ts');
      expect(bundle.changes[0].status).toBe('created');
      expect(bundle.changes[0].newContent).toBe('const greet = () => "Hello";');
      expect(bundle.changes[1].originalContent).toBe('old');
      expect(bundle.tags).toContain('agent-generated');
    });

    it('reads original content for modified files from disk', () => {
      const changes = [{ path: 'src/modified.ts', newContent: 'new content', status: 'modified' }];

      // Path-aware existsSync: .buff paths don't exist (reviews dir), other paths exist (the file on disk)
      vi.mocked(fs.existsSync).mockImplementation((path: string | Buffer) => {
        const p = typeof path === 'string' ? path : String(path);
        return !p.includes('.buff');
      });

      vi.mocked(fs.readFileSync).mockImplementation((path: string | Buffer | URL) => {
        const p = typeof path === 'string' ? path : String(path);
        if (p.includes('index.json')) return JSON.stringify({ reviews: [] });
        return 'original content';
      });

      const bundle = createReviewFromResult('Modify file', changes);
      expect(bundle.changes[0].originalContent).toBe('original content');
    });
  });
});
