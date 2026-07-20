/**
 * Team CLI Integration Tests — End-to-end testing of `buff team` commands.
 *
 * Covers:
 *   1. `buff team init` — creates .buffconfig.json with team settings
 *   2. `buff team init --repo` — init with repo URL (mocked git)
 *   3. `buff team join <url>` — clone and configure (mocked git)
 *   4. `buff team sync` — pull + push via git
 *   5. `buff team status` — displays config, memory, and reviews
 *   6. `buff team review` — full lifecycle: create, list, show, approve, merge
 *   7. Error handling — existing config, no repo, invalid review
 *
 * Uses tmpdir for isolation and mocks git exec to avoid real git operations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Mocks (hoisted before imports) ─────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    // Default mock: return empty string for all git commands
    if (cmd.startsWith('git')) return '';
    throw new Error(`Unexpected command: ${cmd}`);
  }),
}));

// Mock homedir to use a temp path so review tests don't pollute real ~/.buff/
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const { join: pJoin } = await import('node:path');
  const testHome = pJoin(actual.tmpdir(), `buff-team-home-${Date.now()}`);
  return {
    ...actual,
    homedir: () => testHome,
    tmpdir: actual.tmpdir,
  };
});

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { execSync } from 'node:child_process';
import { TeamCommand } from '../../src/cli/team.js';
import { Command } from 'commander';
import { homedir } from 'node:os';

// ─── Helpers ────────────────────────────────────────────────────────────────

function useTempDir(): string {
  const testDir = mkdtempSync(join(tmpdir(), 'buff-team-int-'));
  vi.spyOn(process, 'cwd').mockReturnValue(testDir);
  return testDir;
}

function cleanupTempDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function muteConsole(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

function mockedExec() {
  return vi.mocked(execSync);
}

/**
 * Create a fresh TeamCommand and run it with the given args.
 * We pass args WITHOUT the 'team' command name since Commander's
 * parseAsync on a subcommand doesn't skip past it.
 * Each call creates a new command to avoid leaked state.
 */
async function runTeam(args: string[]): Promise<void> {
  const cmd = new TeamCommand();
  const command = cmd.create();
  await command.parseAsync(['node', 'buff', ...args]);
}

function createBuffConfig(
  dir: string,
  overrides: Record<string, unknown> = {},
): void {
  const config = {
    defaultProvider: 'groq',
    providers: {},
    team: {
      repository: 'https://github.com/team/repo.git',
      branch: 'main',
      autoSyncMinutes: 0,
      shareTrajectories: true,
      ...overrides,
    },
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.buffconfig.json'), JSON.stringify(config, null, 2), 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Integration Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Team CLI Integration', () => {
  let testDir: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    testDir = useTempDir();
    muteConsole();
  });

  afterAll(() => {
    // Clean up the mock homedir temp directory created by the node:os mock
    try {
      const mockHome = homedir();
      if (mockHome && mockHome.includes('buff-team-home')) {
        rmSync(mockHome, { recursive: true, force: true });
      }
    } catch { /* best-effort cleanup */ }
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  // ── buff team init ───────────────────────────────────────────────────────

  describe('buff team init', () => {
    it('creates a .buffconfig.json with default team settings', async () => {
      await runTeam(['init']);

      const configPath = join(testDir, '.buffconfig.json');
      expect(existsSync(configPath)).toBe(true);

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.team).toBeDefined();
      expect(config.team.branch).toBe('main');
      expect(config.team.shareTrajectories).toBe(true);
      expect(config.team.autoSyncMinutes).toBe(0);
    });

    it('does not call git clone when no --repo flag', async () => {
      await runTeam(['init']);
      expect(mockedExec()).not.toHaveBeenCalledWith(
        expect.stringContaining('git clone'),
        expect.anything(),
      );
    });

    it('calls git clone when --repo flag is provided', async () => {
      const repoUrl = 'https://github.com/team/repo.git';
      await runTeam(['init', '--repo', repoUrl]);

      expect(mockedExec()).toHaveBeenCalledWith(
        expect.stringContaining('git clone'),
        expect.anything(),
      );
      expect(mockedExec()).toHaveBeenCalledWith(
        expect.stringContaining(repoUrl),
        expect.anything(),
      );
    });

    it('warns when .buffconfig.json already exists', async () => {
      // Create existing config file
      writeFileSync(join(testDir, '.buffconfig.json'), JSON.stringify({ defaultProvider: 'groq', providers: {} }), 'utf-8');

      await runTeam(['init']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('already exists'),
      );
    });

    it('accepts --branch option', async () => {
      await runTeam(['init', '--branch', 'develop']);

      const config = JSON.parse(
        readFileSync(join(testDir, '.buffconfig.json'), 'utf-8'),
      );
      expect(config.team.branch).toBe('develop');
    });

    it('accepts team name as argument', async () => {
      await runTeam(['init', 'my-team']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Created .buffconfig.json'),
      );
    });

    it('handles git clone failure gracefully (already exists)', async () => {
      mockedExec().mockImplementationOnce(() => {
        throw Object.assign(new Error('already exists'), { stderr: 'fatal: destination path already exists' });
      });

      // Should not throw — the handler catches the error
      await expect(runTeam(['init', '--repo', 'https://github.com/team/repo.git'])).resolves.toBeUndefined();
    });

    it('handles git clone failure with error message', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockedExec().mockImplementationOnce(() => {
        throw Object.assign(new Error('Permission denied'), { stderr: 'Permission denied (publickey)' });
      });

      await runTeam(['init', '--repo', 'https://github.com/team/repo.git']);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Failed'));
    });
  });

  // ── buff team join ───────────────────────────────────────────────────────

  describe('buff team join <repo-url>', () => {
    const repoUrl = 'https://github.com/existing/team.git';

    it('calls git clone with the provided URL', async () => {
      await runTeam(['join', repoUrl]);

      expect(mockedExec()).toHaveBeenCalledWith(
        expect.stringContaining('git clone'),
        expect.anything(),
      );
      expect(mockedExec()).toHaveBeenCalledWith(
        expect.stringContaining(repoUrl),
        expect.anything(),
      );
    });

    it('creates .buffconfig.json if none exists', async () => {
      await runTeam(['join', repoUrl]);

      const configPath = join(testDir, '.buffconfig.json');
      expect(existsSync(configPath)).toBe(true);

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.team.repository).toBe(repoUrl);
    });

    it('does not overwrite existing .buffconfig.json', async () => {
      // Create existing config with custom value
      createBuffConfig(testDir, { repository: 'https://github.com/original/repo.git' });
      await runTeam(['join', repoUrl]);

      const config = JSON.parse(
        readFileSync(join(testDir, '.buffconfig.json'), 'utf-8'),
      );
      // Should still have the original repo URL
      expect(config.team.repository).toBe('https://github.com/original/repo.git');
    });

    it('handles git clone failure gracefully', async () => {
      mockedExec().mockImplementationOnce(() => {
        throw Object.assign(new Error('Repository not found'), { stderr: 'Repository not found' });
      });

      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await runTeam(['join', repoUrl]);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Failed'));
    });
  });

  // ── buff team sync ───────────────────────────────────────────────────────

  describe('buff team sync', () => {
    it('shows error when team memory is not a git repo', async () => {
      createBuffConfig(testDir);

      // Make isGitRepo() return false by having execSync throw on first call.
      // Using mockImplementationOnce so it doesn't affect subsequent tests.
      mockedExec().mockImplementationOnce(() => {
        throw new Error('not a git repository');
      });

      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await runTeam(['sync']);

      // handleSync catches the error from syncTeamMemory and calls logger.error
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('not a git repository'),
      );
    });

    it('warns when no team repository is configured', async () => {
      // Create config without a repository
      createBuffConfig(testDir, { repository: undefined });

      await runTeam(['sync']);

      // The sync code checks for team.repository and warns if missing
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('No remote repository'),
      );
    });

    it('runs git pull when repo is configured', async () => {
      createBuffConfig(testDir);

      // All git commands return empty string — pull appears to succeed
      await runTeam(['sync']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('up to date'),
      );
    });

    it('reports sync errors', async () => {
      createBuffConfig(testDir);

      // First 6 calls (rev-parse, status, add, commit, remote, branch) succeed,
      // 7th call (pull) throws — this is 6 initial calls, not 6 total
      let callIdx = 0;
      mockedExec().mockImplementation((cmd: string) => {
        callIdx++;
        // With no uncommitted changes, pull is the 5th execSync call:
        // 1=rev-parse, 2=status, 3=remote, 4=branch, 5=pull
        if (callIdx === 5) {
          throw Object.assign(new Error('Could not resolve host'), { stderr: 'fatal: Could not resolve host' });
        }
        return '';
      });

      await runTeam(['sync']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('error(s)'),
      );
    });

    it('reports conflicts during pull', async () => {
      createBuffConfig(testDir);

      let callIdx = 0;
      mockedExec().mockImplementation((cmd: string) => {
        callIdx++;
        // With no uncommitted changes, pull is the 5th execSync call:
        // 1=rev-parse, 2=status, 3=remote, 4=branch, 5=pull
        if (callIdx === 5) {
          throw Object.assign(new Error('CONFLICT'), { stderr: 'CONFLICT (content): Merge conflict in f.ts' });
        }
        return '';
      });

      await runTeam(['sync']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('conflict(s)'),
      );
    });
  });

  // ── buff team review lifecycle ──────────────────────────────────────────

  describe('buff team review lifecycle', () => {

    it('create: creates a review bundle from specified files', async () => {
      // Create a test file to include in the review
      const testFile = join(testDir, 'src', 'main.ts');
      mkdirSync(join(testDir, 'src'), { recursive: true });

      const fileContent = 'console.log("hello");\n';
      // Use real fs
      const fs = await import('node:fs');
      fs.writeFileSync(testFile, fileContent, 'utf-8');

      await runTeam(['review', 'create', 'Add greeting', 'Add hello world', '--files', 'src/main.ts']);

      // Check that a review was created
      const rDir = join(homedir(), '.buff', 'team', 'reviews');
      expect(existsSync(rDir)).toBe(true);
      const files = readdirSync(rDir).filter(f => f.endsWith('.json') && f !== 'index.json');
      expect(files.length).toBeGreaterThan(0);
    });

    it('list: shows no reviews when empty', async () => {
      await runTeam(['review', 'list']);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('review'),
      );
    });

    it('show: shows error for non-existent review', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await runTeam(['review', 'show', 'nonexistent-review']);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });

    it('approve: shows error for non-existent review', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await runTeam(['review', 'approve', 'nonexistent-review']);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });

    it('reject: shows error for non-existent review', async () => {
      // rejectReview returns false, handleReviewReject logs error
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await runTeam(['review', 'reject', 'nonexistent-review']);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });

    it('merge: shows error for non-existent review', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await runTeam(['review', 'merge', 'nonexistent-review']);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });

    it('reject with reason: logs rejection reason', async () => {
      // First create a review
      const testFile = join(testDir, 'src', 'app.ts');
      mkdirSync(join(testDir, 'src'), { recursive: true });
      const fs = await import('node:fs');
      fs.writeFileSync(testFile, '// test', 'utf-8');

      await runTeam(['review', 'create', 'Test reject', 'Testing reject', '--files', 'src/app.ts']);

      // Find the created review ID
      const rDir = join(homedir(), '.buff', 'team', 'reviews');
      const reviewFiles = readdirSync(rDir).filter(f => f.endsWith('.json') && f !== 'index.json');
      const reviewId = reviewFiles[0].replace('.json', '');

      // Reject with reason
      await runTeam(['review', 'reject', reviewId, 'Not needed']);

      const bundle = JSON.parse(fs.readFileSync(join(rDir, reviewFiles[0]), 'utf-8'));
      expect(bundle.status).toBe('rejected');
    });
  });

  // ── buff team status ─────────────────────────────────────────────────────

  describe('buff team status', () => {
    it('shows no team config message when unconfigured', async () => {
      await runTeam(['status']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('No team configuration'),
      );
    });

    it('displays team config details when configured', async () => {
      createBuffConfig(testDir);

      // Mock git operations for memory stats
      mockedExec()
        .mockReturnValueOnce('')        // rev-parse (isGitRepo)
        .mockReturnValueOnce('main')    // rev-parse HEAD → branch
        .mockReturnValueOnce('')        // status → no changes
        .mockReturnValueOnce('2026-07-19 12:00:00 -0400') // log
        ;

      await runTeam(['status']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Team Status'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('.buffconfig.json'),
      );
    });
  });
});
