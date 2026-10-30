/**
 * Loop project context (`src/tools/loop-project-context.ts`) — AGENTIC_CAPABILITY_ASSESSMENT
 * Addendum v4 Phase 1.4: AMBIENT CONTEXT for the tool loop.
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
 *   note (honest truncation, never a silent drop).
 * - Git digests run read-only commands with a 3s cap each and are omitted
 *   entirely outside a git repo.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { buildGitStateDigest } from './git-digest.js';
import { buildCodeMapCached, countSourceFiles, formatCodeMapBrief } from '../cli/code-map.js';
import { assessProject } from '../agents/prompt-assembly.js';
import { handoffBlockFor } from '../agents/step-handoff.js';
import { describeProjectInterpreter } from '../utils/project-env.js';
import { workingStateBlock as readWorkingStateBlock } from '../learning/working-state.js';
import { findingsBlockFor } from '../findings/ledger.js';
import { formatCrossSessionMemory } from '../learning/context-assembly.js';

/** Hard budget: the tree block is truncated to this many lines (~1.5K tokens). */
const MAX_TREE_LINES = 60;
/** Max tree depth (BFS) — deep node_modules-style nesting is noise at this budget. */
const MAX_TREE_DEPTH = 4;
/** Max entries per directory (a flat 300-file dir gets an ellipsis note). */
const MAX_ENTRIES_PER_DIR = 25;
/** Overall block budget (~2K tokens ≈ 8K chars) — hard-truncated with a note. */
const MAX_BLOCK_CHARS = 8_000;

/**
 * How many source files a project may have before the SYMBOL MAP is left out of
 * the ambient context.
 *
 * WHY A CAP AT ALL (MEASURED 2026-10-16, this repository): `buildCodeMap` parses
 * every source file through the AST engine and costs 4.4–4.6 s for 1 568 files
 * (~2.9 ms/file), against 8–18 ms for the 16-file project the side-by-side audit
 * ran on. The map is memoised per tree state (so later turns are ~free), but
 * the FIRST turn of a session pays it — and an ambient context that adds seconds of
 * synchronous work before the model's first token would make the agent slower, not
 * faster, which is the opposite of what a symbol map is for.
 *
 * 300 files keeps that first call to well under a second on measured rates while
 * covering the projects where exploration is actually the bottleneck. Past it the
 * block names the command instead of the map: `nuvira code-map` is one tool call
 * away, so the capability is available either way — only the AUTOMATIC copy is
 * bounded. Honest omission, never a silent one.
 */
const MAX_SYMBOL_MAP_FILES = 300;

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
 * Layout (stable ambient-context sections):
 *   ## Project   — cwd + deterministic assessment (language/framework/tests)
 *   ## File tree — bounded BFS walk, honestly truncated
 *   ## Git state — branch, dirty files, recent commits
 */
/**
 * Is this directory EMPTY (nothing to read, nothing to find)?
 *
 * Distinct from `!looksLikeProject`, which is also true for a home directory with
 * a thousand unrelated files. Only a genuinely empty workspace (ignoring the
 * directories nobody reads) makes "there is nothing here" a fact worth stating.
 */
function isEmptyWorkspace(dir: string): boolean {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
    return readdirSync(dir).filter((entry) => !IGNORE_DIRS.has(entry)).length === 0;
  } catch {
    return false;
  }
}

export async function buildLoopProjectContext(
  dir: string,
  opts: {
    goal?: string;
    sessionRecall?: boolean;
    /**
     * Include the SYMBOL MAP (functions/classes with line numbers) as well as the
     * file tree. Off by default because it is the only section here that parses
     * the tree; the caller turns it on for the turns whose cost it repays — an
     * assessment, which would otherwise read files to find out what is in them.
     */
    symbolMap?: boolean;
  } = {},
): Promise<string> {
  try {
    if (!looksLikeProject(dir)) {
      // AN EMPTY WORKSPACE IS A FACT, AND IT BELONGS IN THE PROMPT (measured
      // 2026-10-30, GREENFIELD-API). A greenfield build was told nothing about its
      // project, so the model spent its first steps reading the tree (`read_file`,
      // `glob`, `list_dir`) and discovering there was nothing there — two of 31
      // steps spent on a fact the loop already knew. `looksLikeProject` is false
      // for a home directory too, so only a genuinely empty directory gets the
      // line; everywhere else silence is still the right answer.
      if (!isEmptyWorkspace(dir)) return '';
      return [
        '## Project',
        `- path: ${dir}`,
        '- empty/greenfield: this workspace has NO files yet.',
        '- There is nothing here to read, list or search — do not spend a step exploring. Create what the request asks for, in this directory.',
      ].join('\n');
    }

    const lines: string[] = [];

    // ── Deterministic assessment (reuses the planner's own scanner) ──
    try {        const a = assessProject(dir);
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

    // ── Pinned project interpreter ──
    // States WHICH interpreter this project runs under, so the model does not
    // re-derive it (or build against the system Python) on every turn. The
    // live Aukat_check failure was exactly that guess going wrong.
    try {
      const interpreter = describeProjectInterpreter(dir);
      if (interpreter) lines.push(`- ${interpreter}`);
    } catch {
      // Best-effort — omit on failure.
    }

    // ── Cross-turn working state (parity with the orchestrator path) ──
    // The SAME deterministic ledger `prompt-assembly` injects, so the loop stops
    // re-deriving what previous turns already established in this project (files
    // changed, outstanding verification debt, user-reported regressions). This
    // closes the drift where the orchestrator remembered across turns and the
    // loop did not. Self-labelled and self-bounded; omits itself when empty.
    try {
      const workingState = readWorkingStateBlock(dir);
      if (workingState) lines.push(workingState);
    } catch {
      // Working-state read is best-effort — omit on failure.
    }

    // ── Findings earlier runs in this project settled ──
    // The working-state block above says what was TOUCHED; this one says what was
    // CONCLUDED and checked. Without it a run's findings live on its own trace and
    // the next pass over the same tree re-derives every one of them — and can
    // re-raise a claim a previous pass already retracted (see findings/ledger.ts).
    // Self-labelled, capped, and omitted entirely when nothing is settled, so a
    // project with no history adds no prompt weight.
    try {
      const findings = findingsBlockFor(dir);
      if (findings) lines.push('', findings);
    } catch {
      // Findings recall is best-effort — omit on failure.
    }

    // ── Cross-session memory (the ONE composer, shared with the orchestrator) ──
    // RECENT asks (the deterministic digest) plus, only when the deployment asks
    // for it, semantically similar PAST asks. Advisory only: the block is
    // self-labelled history, not a status, so an old "completed" line can never
    // be read as proof the current work is done (completion still derives from
    // disk). Delegated to `context-assembly.ts` so this block is byte-identical
    // wherever it is shown (see the orchestrator's assessment).
    try {
      const memory = await formatCrossSessionMemory(dir, {
        goal: opts.goal,
        ...(opts.sessionRecall === undefined ? {} : { sessionRecall: opts.sessionRecall }),
      });
      if (memory) lines.push(memory);
    } catch {
      // Best-effort — omit on failure.
    }

    // ── Unfinished work from earlier attempts in this project ──
    // The loop engine re-reads the tree and re-plans on every turn, so without
    // this a repeated or reworded ask restarts from zero even when a previous
    // attempt already put half the deliverable on disk (see step-handoff.ts).
    // Read and reconciled on EVERY context build, not only on an explicit
    // resume. Self-labelled and self-bounded, so it is pushed as-is; a clean
    // project adds nothing.
    try {
      const handoff = handoffBlockFor(dir);
      if (handoff) lines.push('## Unfinished work (hand-off)', handoff);
    } catch {
      // Hand-off read is best-effort — omit on failure.
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

    // ── Symbol map (opt-in: an ASSESSMENT turn asks for it) ──
    //
    // The tree says what EXISTS; the symbol map says what is IN the files, which
    // is the difference between reading fourteen files to find out and knowing
    // which one to read. It is opt-in because it is the only section here that
    // parses the whole tree — `countSourceFiles` is the cheap pre-check that keeps
    // the cost bounded (see MAX_SYMBOL_MAP_FILES), and the map itself is memoised
    // per tree state so only the first turn of a session pays for it.
    if (opts.symbolMap) {
      try {
        const fileCount = countSourceFiles(dir);
        if (fileCount <= MAX_SYMBOL_MAP_FILES) {
          const brief = formatCodeMapBrief(buildCodeMapCached(dir));
          if (brief) lines.push('', brief);
        } else {
          lines.push(
            '',
            `## Symbol map — omitted: ~${fileCount} source files is past this turn's map budget.`,
            'Run `nuvira code-map` (one tool call) for the full symbol map of this project.',
          );
        }
      } catch {
        // The map is an accelerator, never a dependency — omit it on failure.
      }
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
