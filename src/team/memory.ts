/**
 * Team Memory — Git-synced shared memory for team collaboration.
 *
 * The team memory is stored in a git repository at `~/.buff/team/` (or a
 * configurable path). It contains:
 *
 *   trajectories/  — Shared agent execution trajectories (JSON)
 *   patterns/      — Project-level coding patterns (JSON)
 *   templates/     — Team workflow templates (JSON)
 *
 * Commands:
 *   buff team join <repo-url>  — Clone the team repo
 *   buff team sync             — Pull latest + push local changes
 *   buff team share            — Share local trajectories with team
 *
 * The sync operation:
 *   1. Pull latest from remote
 *   2. Apply local changes on top
 *   3. Commit new trajectories/patterns
 *   4. Push to remote
 *
 * Authentication is via Git credentials (SSH key or git-credential helper).
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';

import { logger } from '../utils/logger.js';
import { getTeamConfig, getTeamDataDir } from './config.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TeamMemoryStats {
  /** Number of shared trajectories */
  trajectoryCount: number;
  /** Number of shared patterns */
  patternCount: number;
  /** Number of shared workflow templates */
  templateCount: number;
  /** Whether git is configured */
  gitConfigured: boolean;
  /** Current git branch */
  branch: string;
  /** Uncommitted changes count */
  uncommittedChanges: number;
  /** Last sync time */
  lastSync: string | null;
}

export interface SyncResult {
  pulled: number;
  pushed: number;
  conflicts: string[];
  errors: string[];
}

// ─── Paths ──────────────────────────────────────────────────────────────────

function getTeamDir(cwd?: string): string {
  const config = getTeamConfig(cwd);
  const baseDir = config.localPath || join(homedir(), '.buff', 'team');
  return baseDir;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function getTrajectoriesDir(cwd?: string): string {
  return join(getTeamDir(cwd), 'trajectories');
}

function getPatternsDir(cwd?: string): string {
  return join(getTeamDir(cwd), 'patterns');
}

function getTemplatesDir(cwd?: string): string {
  return join(getTeamDir(cwd), 'templates');
}

// ─── Git Operations ─────────────────────────────────────────────────────────

function gitExec(args: string[], cwd?: string): string {
  const dir = getTeamDir(cwd);
  try {
    return execSync(`git ${args.join(' ')}`, {
      cwd: dir,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 60_000,
    }).trim();
  } catch (err) {
    const error = err as { stderr?: string; stdout?: string; message?: string };
    throw new Error(error.stderr?.trim() || error.message || 'Git operation failed');
  }
}

function isGitRepo(cwd?: string): boolean {
  try {
    gitExec(['rev-parse', '--git-dir'], cwd);
    return true;
  } catch {
    return false;
  }
}

// ─── Team Memory ────────────────────────────────────────────────────────────

/**
 * Initialize the team memory directory as a git repository.
 * Called by `buff team join` or `buff team init`.
 */
export async function initTeamMemory(repoUrl?: string, cwd?: string): Promise<void> {
  const dir = getTeamDir(cwd);
  ensureDir(dir);

  if (repoUrl) {
    // Clone existing team repo
    logger.info(`Cloning team repository: ${repoUrl}`);
    try {
      execSync(`git clone "${repoUrl}" "${dir}"`, {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 120_000,
      });
      logger.success(`Team repo cloned to ${dir}`);
    } catch (err) {
      const error = err as { stderr?: string; message?: string };
      if (error.stderr?.includes('already exists') || error.message?.includes('already exists')) {
        logger.info('Team directory already exists. Run `buff team sync` to update.');
      } else {
        throw new Error(`Failed to clone team repo: ${error.stderr?.slice(0, 300) || error.message}`);
      }
    }
  } else {
    // Initialize new empty team repo
    ensureDir(join(dir, 'trajectories'));
    ensureDir(join(dir, 'patterns'));
    ensureDir(join(dir, 'templates'));

    // Create .gitkeep files
    writeFileSync(join(dir, 'trajectories', '.gitkeep'), '');
    writeFileSync(join(dir, 'patterns', '.gitkeep'), '');
    writeFileSync(join(dir, 'templates', '.gitkeep'), '');

    // Create a README for the team repo
    writeFileSync(join(dir, 'README.md'),
      '# Agent-Baba-D Team Memory\n\n' +
      'This repository stores shared agent execution trajectories, coding patterns,\n' +
      'and workflow templates for the team.\n\n' +
      'Managed by the `buff team` CLI commands.\n',
    );

    // Initialize git
    execSync('git init', { cwd: dir, encoding: 'utf-8', stdio: 'pipe' });
    execSync('git add -A', { cwd: dir, encoding: 'utf-8', stdio: 'pipe' });
    execSync('git commit -m "chore: initialize team memory"', {
      cwd: dir, encoding: 'utf-8', stdio: 'pipe', timeout: 30_000,
    });

    logger.success(`Team memory initialized at ${dir}`);
  }
}

/**
 * Sync team memory with remote: pull latest, push local changes.
 */
export async function syncTeamMemory(cwd?: string): Promise<SyncResult> {
  const result: SyncResult = { pulled: 0, pushed: 0, conflicts: [], errors: [] };

  if (!isGitRepo(cwd)) {
    throw new Error('Team memory is not a git repository. Run `buff team init` or `buff team join <repo>`.');
  }

  // Check for uncommitted changes
  const status = gitExec(['status', '--porcelain'], cwd);
  const hasChanges = status.trim().length > 0;

  // Commit any pending changes
  if (hasChanges) {
    gitExec(['add', '-A'], cwd);
    gitExec(['commit', '-m', `sync: team memory update ${new Date().toISOString().slice(0, 10)}`], cwd);
    result.pushed = 1;
  }

  // Check if remote is configured
  let hasRemote = false;
  try {
    gitExec(['remote', '-v'], cwd);
    hasRemote = true;
  } catch {
    // No remote configured — local-only mode
    logger.info('No remote configured. Team memory is local-only.');
    return result;
  }

  if (hasRemote) {
    // Get current branch
    const branch = gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);

    try {
      // Pull latest
      logger.info('Pulling latest team memory...');
      gitExec(['pull', '--rebase', 'origin', branch], cwd);
      result.pulled = 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('conflict') || msg.includes('CONFLICT')) {
        result.conflicts.push(msg.slice(0, 200));
        logger.error('Sync conflicts detected. Resolve them manually in the team directory.');
        return result;
      }
      result.errors.push(msg.slice(0, 200));
      logger.warn(`Pull failed: ${msg.slice(0, 200)}`);
    }

    // Push
    if (hasChanges) {
      try {
        logger.info('Pushing team memory updates...');
        gitExec(['push', 'origin', branch], cwd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(msg.slice(0, 200));
        logger.warn(`Push failed: ${msg.slice(0, 200)}`);
      }
    }
  }

  return result;
}

/**
 * Share local trajectories with the team by copying them to the team memory directory.
 */
export async function shareTrajectories(cwd?: string): Promise<number> {
  const teamDir = getTeamDir(cwd);
  const trajectoriesDir = getTrajectoriesDir(cwd);

  ensureDir(trajectoriesDir);

  // Read local trajectories
  const localTrajDir = join(homedir(), '.buff', 'memory');
  if (!existsSync(localTrajDir)) {
    logger.info('No local trajectories found to share.');
    return 0;
  }

  const files = readdirSync(localTrajDir).filter(
    (f) => f.endsWith('.json') || f.endsWith('.trajectory.json'),
  );

  let shared = 0;
  for (const file of files) {
    const src = join(localTrajDir, file);
    const dst = join(trajectoriesDir, file);

    // Skip if already exists and is identical
    if (existsSync(dst)) {
      const srcContent = readFileSync(src, 'utf-8');
      const dstContent = readFileSync(dst, 'utf-8');
      if (srcContent === dstContent) continue;
    }

    copyFileSync(src, dst);
    shared++;
  }

  // Also share patterns
  const localPatternDir = join(localTrajDir, 'patterns');
  if (existsSync(localPatternDir)) {
    const patternFiles = readdirSync(localPatternDir).filter((f) => f.endsWith('.json'));
    const patternsDir = getPatternsDir(cwd);
    ensureDir(patternsDir);

    for (const file of patternFiles) {
      const src = join(localPatternDir, file);
      const dst = join(patternsDir, file);
      copyFileSync(src, dst);
      shared++;
    }
  }

  if (shared > 0) {
    logger.success(`Shared ${shared} file(s) with team memory. Run \`buff team sync\` to publish.`);
  } else {
    logger.info('All local trajectories already in sync with team memory.');
  }

  return shared;
}

/**
 * Get team memory statistics.
 */
export function getTeamMemoryStats(cwd?: string): TeamMemoryStats {
  const dir = getTeamDir(cwd);

  const trajectoryCount = existsSync(getTrajectoriesDir(cwd))
    ? readdirSync(getTrajectoriesDir(cwd)).filter((f) => f.endsWith('.json')).length
    : 0;

  const patternCount = existsSync(getPatternsDir(cwd))
    ? readdirSync(getPatternsDir(cwd)).filter((f) => f.endsWith('.json')).length
    : 0;

  const templateCount = existsSync(getTemplatesDir(cwd))
    ? readdirSync(getTemplatesDir(cwd)).filter((f) => f.endsWith('.json')).length
    : 0;

  let gitConfigured = false;
  let branch = 'N/A';
  let uncommittedChanges = 0;
  let lastSync: string | null = null;

  if (existsSync(dir) && isGitRepo(cwd)) {
    gitConfigured = true;
    try {
      branch = gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    } catch { /* */ }
    try {
      const status = gitExec(['status', '--porcelain'], cwd);
      uncommittedChanges = status.trim() ? status.split('\n').length : 0;
    } catch { /* */ }
    try {
      lastSync = gitExec(['log', '-1', '--format=%ci'], cwd);
    } catch { /* */ }
  }

  return {
    trajectoryCount,
    patternCount,
    templateCount,
    gitConfigured,
    branch,
    uncommittedChanges,
    lastSync,
  };
}
