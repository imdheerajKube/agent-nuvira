/**
 * Loop project context (`src/tools/loop-project-context.ts`) — AGENTIC_CAPABILITY_ASSESSMENT
 * Addendum v4 Phase 1.4: Freebuff-pattern AMBIENT CONTEXT for the tool loop.
 *
 * The assessment's core finding: a single-loop agent needs the project shape
 * in its context FROM TURN ZERO — a token-budgeted file tree, a git-state
 * digest, and a deterministic project assessment — instead of spending an
 * entire ReasonerAgent + ContextGathererAgent call to re-discover it.
 *
 * The dashboard already builds a snapshot (its project-context module) and
 * injects it via `ctxOverrides.projectContext`; the CLI never sent one. This
 * module is the CLI twin: bounded (~2K tokens), best-effort — a failure
 * yields an EMPTY string, never a broken turn.
 *
 * Consumers: chat.ts `runChatAnswer` — when no explicit projectContext was
 * provided and the cwd looks like a project, inject this as the
 * `[Project context]` message. The dashboard path is unchanged.
 *
 * Design notes:
 * - The tree walk is a bounded BFS (readdirSync, depth-capped, ignore-dir
 *   filtered) rather than the orchestrator's full recursive builder — the
 *   loop needs SHAPE, not a complete index, and must never take >50ms on a
 *   huge repo. Entries past the line budget are truncated with an explicit
 *   note (honest truncation, like Freebuff's `truncate-file-tree`).
 * - Git digests run read-only commands with a 3s cap each and are omitted
 *   entirely outside a git repo.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { buildGitStateDigest } from './git-digest.js';
import { assessProject } from '../agents/prompt-assembly.js';

/** Hard budget: the tree block is truncated to this many lines (~1.5K tokens). */
const MAX_TREE_LINES = 60;
/** Max tree depth (BFS) — deep node_modules-style nesting is noise at this budget. */
const MAX_TREE_DEPTH = 4;
/** Max entries per directory (a flat 300-file dir gets an ellipsis note). */
const MAX_ENTRIES_PER_DIR = 25;
/** Overall block budget (~2K tokens ≈ 8K chars) — hard-truncated with a note. */
const MAX_BLOCK_CHARS = 8_000;

/** Directories never worth showing in the ambient tree (build artifacts, deps). */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
  '.cache', '__pycache__', '.venv', 'venv', '.nuvira', '.turbo',
]);

/** True when the directory plausibly contains a project worth describing. */
export function looksLikeProject(dir: string): boolean {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
    const entries = readdirSync(dir);
    if (entries.length === 0) return false;
    // A project has at least one source/config marker OR a .git dir — a bare
    // home directory or an empty scratch dir adds noise, not signal.
    const MARKERS = new Set([
      'package.json', 'tsconfig.json', 'pyproject.toml', 'setup.py', 'requirements.txt',
      'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json',
      '.git', 'Makefile', 'CMakeLists.txt', 'pubspec.yaml', 'mix.exs', 'buffconfig.json',
    ]);
    return entries.some((e) => MARKERS.has(e));
  } catch {
    return false;
  }
}

/**
 * Bounded BFS tree walk. Returns lines like `├── src/` with directories
 * suffixed `/`, sorted dirs-first then files (deterministic ordering — the
 * model sees a stable tree across turns, which keeps the prompt cache warm).
 * Appends an ellipsis note when entries/depth were capped.
 */
export function walkBoundedTree(dir: string): string[] {
  const lines: string[] = [];
  let truncatedNote = false;

  const walk = (current: string, prefix: string, depth: number): void => {
    if (depth > MAX_TREE_DEPTH || lines.length >= MAX_TREE_LINES) {
      if (lines.length >= MAX_TREE_LINES) truncatedNote = true;
      return;
    }
    interface TreeEntry { name: string; isDir: boolean; }
    let entries: TreeEntry[];
    try {
      entries = readdirSync(current, { withFileTypes: true })
        .filter((e) => !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    } catch {
      return; // unreadable dir — skip silently
    }
    if (entries.length > MAX_ENTRIES_PER_DIR) {
      entries = entries.slice(0, MAX_ENTRIES_PER_DIR);
      truncatedNote = true;
    }
    entries.forEach((e, idx) => {
      if (lines.length >= MAX_TREE_LINES) {
        truncatedNote = true;
        return;
      }
      const last = idx === entries.length - 1;
      const tee = last ? '└── ' : '├── ';
      lines.push(`${prefix}${tee}${e.name}${e.isDir ? '/' : ''}`);
      if (e.isDir) {
        walk(join(current, e.name), prefix + (last ? '    ' : '│   '), depth + 1);
      }
    });
  };

  walk(dir, '', 1);
  if (truncatedNote) lines.push('… (tree truncated to fit the context budget)');
  return lines;
}

/**
 * Build the bounded `[Project context]` block for the loop system context.
 * Returns '' when the directory is not a project (caller injects nothing).
 *
 * Layout (Freebuff system-prompt parity):
 *   ## Project   — cwd + deterministic assessment (language/framework/tests)
 *   ## File tree — bounded BFS walk, honestly truncated
 *   ## Git state — branch, dirty files, recent commits
 */
export async function buildLoopProjectContext(dir: string): Promise<string> {
  try {
    if (!looksLikeProject(dir)) return '';

    const lines: string[] = [];

    // ── Deterministic assessment (reuses the planner's own scanner) ──
    try {
      const a = assessProject(dir);
      const bits: string[] = [];
      if (a.language) bits.push(`language: ${a.language}`);
      if (a.framework) bits.push(`framework: ${a.framework}`);
      if (a.packageManager) bits.push(`package manager: ${a.packageManager}`);
      bits.push(a.isGreenfield ? 'empty/greenfield' : 'existing project');
      bits.push(a.hasTests ? 'has tests' : 'no tests detected');
      if (a.keyFiles?.length) bits.push(`key files: ${a.keyFiles.slice(0, 8).join(', ')}`);
      lines.push('## Project', `- path: ${dir}`, `- ${bits.join('; ')}`);
    } catch {
      lines.push('## Project', `- path: ${dir}`);
    }

    // ── Bounded file tree ──
    try {
      const treeLines = walkBoundedTree(dir);
      if (treeLines.length > 0) {
        lines.push('## File tree', ...treeLines);
      }
    } catch {
      // Tree failure must never break the block — omit the section.
    }

    // ── Git state digest (shared leaf module — same block the dashboard now
    // ships, so both surfaces see identical git state) ──
    try {
      const gitLines = buildGitStateDigest(dir);
      if (gitLines.length > 0) lines.push(...gitLines);
      // Outside a git repo: no Git state section — fine.
    } catch {
      // Git digest is best-effort — omit on failure.
    }

    const body = lines.join('\n');
    if (body.length > MAX_BLOCK_CHARS) {
      return body.slice(0, MAX_BLOCK_CHARS) + '\n[project context truncated to fit the context budget]';
    }
    return body;
  } catch {
    return '';
  }
}
