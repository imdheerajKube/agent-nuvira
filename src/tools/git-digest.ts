/**
 * Shared, bounded git digest (`src/tools/git-digest.ts`) — a LEAF module.
 *
 * One read-only summary of a repository's working state (branch, uncommitted
 * files, recent commits) used by BOTH ambient-context builders:
 *   - the CLI tool loop's `loop-project-context.ts`
 *   - the dashboard's `web-dashboard/project-context.ts`
 *
 * It lives in its own module (node builtins only — no registry, no agents)
 * so the dashboard can import it without dragging the heavy agent graph into
 * its bundle. Both surfaces therefore carry the SAME git state, which is the
 * parity fix: the dashboard snapshot used to ship a file tree with no git info.
 */

import { spawnSync } from 'node:child_process';

/** Uncommitted status lines kept (a huge dirty tree truncates honestly). */
export const MAX_GIT_STATUS_LINES = 30;
/** Recent commits listed. */
export const MAX_GIT_LOG_LINES = 5;
/** Per-command timeout — the digest must never stall a turn. */
const GIT_TIMEOUT_MS = 3_000;

/** Run a read-only git command in `dir`; '' on any failure (best-effort). */
export function git(dir: string, args: string[]): string {
  try {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8', timeout: GIT_TIMEOUT_MS });
    if (r.status !== 0 || !r.stdout) return '';
    return r.stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Build the `## Git state` block lines for `dir`, or `[]` when the directory
 * is not inside a git repo (or git is unavailable). Never throws.
 */
export function buildGitStateDigest(dir: string): string[] {
  const lines: string[] = [];
  try {
    const branchLine = git(dir, ['status', '--porcelain', '-b']).split('\n')[0] || '';
    if (!branchLine) return [];
    const statusLines = git(dir, ['status', '--porcelain']).split('\n').filter(Boolean);
    const log = git(dir, ['log', '--oneline', `-${MAX_GIT_LOG_LINES}`]).split('\n').filter(Boolean);

    lines.push('## Git state', `- ${branchLine}`);
    if (statusLines.length > 0) {
      lines.push(`- ${statusLines.length} uncommitted change(s):`);
      for (const s of statusLines.slice(0, MAX_GIT_STATUS_LINES)) lines.push(`  ${s}`);
      if (statusLines.length > MAX_GIT_STATUS_LINES) {
        lines.push(`  … ${statusLines.length - MAX_GIT_STATUS_LINES} more`);
      }
    } else {
      lines.push('- working tree clean');
    }
    if (log.length > 0) {
      lines.push('- recent commits:');
      for (const c of log) lines.push(`  ${c}`);
    }
  } catch {
    // Best-effort — an unreadable repo adds no section.
  }
  return lines;
}
