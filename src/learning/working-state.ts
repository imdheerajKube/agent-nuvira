/**
 * Working state — the per-project ledger that gives the agent a memory of
 * what it changed, whether the change was verified, and what the user has
 * already reported broken (enterprise-grade hardening, G3 + G4).
 *
 * WHY THIS EXISTS (the trace audit):
 * The calculator session ran 15 turns over 77 minutes. Each turn RE-DERIVED
 * the same root cause from scratch (input tokens grew 2,172 → 7,317), the
 * model flip-flopped on the diagnosis (found the `id`-mapping bug in turn 23,
 * declared the CSS "perfectly valid" in turn 25), and its own fixes kept
 * undoing earlier ones (turn 17 made the converter vanish; turn 21 broke the
 * dropdowns). Nothing carried the STATE of the work across turns — only the
 * raw transcript, which is the worst possible carrier.
 *
 * This ledger is deliberately DETERMINISTIC and LLM-free: it records facts
 * (files touched, verified-or-not, user-reported regressions) and formats a
 * compact block that is injected at the start of the next turn. No summarizer,
 * no latency, no drift — the same philosophy as `trimThreadBudget`.
 *
 * Storage: `~/.nuvira/memory/working-state.json`, keyed by project path.
 * Honours `NUVIRA_MEMORY_DIR` / `BUFF_MEMORY_DIR` like the reasoning traces.
 * Every write is best-effort — a ledger write must NEVER break a turn.
 */

import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * One outstanding unverified change: a path that mutated and that no check has
 * since exercised.
 *
 * WHY THIS IS A SET AND NOT A COUNT. The ledger used to record only
 * `unverifiedEdits: 2` — which cannot be reconciled: the next turn cannot tell
 * WHICH file is owed a check, so a verification of anything (or a root-level
 * `npm test` that never loaded the file's own suite) settled the whole backlog.
 * The calculator audit's lesson was "the artifact is the source of truth"; a
 * debt you cannot name an artifact for is not one.
 */
export interface UnverifiedPath {
  path: string;
  /** Epoch ms this path was last changed while unverified. */
  at: number;
}

/** One project's working state — everything worth remembering between turns. */
export interface ProjectWorkingState {
  /** Absolute project path (the ledger key). */
  projectPath: string;
  /** Files the agent changed, most-recent last (deduped, capped). */
  filesTouched: string[];
  /** Distinct tools used across the session (for a quick capability read). */
  toolsUsed: string[];
  /** Turns recorded against this project. */
  turns: number;
  /**
   * Turns that left unverified changes outstanding. Reset to 0 when the debt set
   * empties. `unverifiedPaths` is the authoritative list; this is the count a
   * reader shows when it only has room for a number.
   */
  unverifiedEdits: number;
  /**
   * The outstanding per-file debt (see {@link UnverifiedPath}). A path leaves
   * this list only when a verification actually covered it.
   */
  unverifiedPaths: UnverifiedPath[];
  /** Epoch ms of the last turn that verified (ran tests/typecheck/browser). */
  lastVerifiedAt?: number;
  /**
   * What the USER reported broken, newest last (deduped, capped). This is the
   * regression memory: the exact thing the agent must not re-break or
   * re-derive next turn.
   */
  openIssues: string[];
  /** How many turns carried a regression signal ("still", "same issue"...). */
  corrections: number;
  /** Epoch ms of the last write. */
  updatedAt: number;
}

/** A single finished turn, as recorded by the caller. */
export interface TurnRecord {
  /** Files edited this turn (any order; deduped + capped on write). */
  filesTouched?: string[];
  /** Tools that ran successfully this turn. */
  toolsUsed?: readonly string[];
  /** A verification tool ran successfully this turn. */
  verified?: boolean;
  /** The turn mutated the workspace and verified nothing. */
  unverifiedEdit?: boolean;
  /**
   * PER-FILE truth from `assessEditActivity` — the changed paths a check
   * actually exercised. When either list is supplied the turn is recorded in
   * per-path mode: the debt is settled per file, not wholesale.
   */
  verifiedPaths?: readonly string[];
  /** The changed paths no check covered this turn — the new debt. */
  unverifiedPaths?: readonly string[];
  /** The user's message for this turn (scanned for a regression signal). */
  userMessage?: string;
}

interface WorkingStateFile {
  version: number;
  projects: Record<string, ProjectWorkingState>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CURRENT_VERSION = 1;
/** Cap on remembered files per project (oldest drop first). */
export const MAX_FILES = 40;
/** Cap on remembered user-reported issues per project. */
export const MAX_ISSUES = 8;
/** Cap on remembered tools per project. */
export const MAX_TOOLS = 24;
/** Cap on outstanding unverified paths (oldest drop first). */
export const MAX_UNVERIFIED_PATHS = 40;
/** Git read timeout — a repository read must never stall a turn. */
const GIT_TIMEOUT_MS = 2_500;

// ─── Storage ────────────────────────────────────────────────────────────────

function memoryDir(): string {
  return envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
}

function statePath(): string {
  return join(memoryDir(), 'working-state.json');
}

function readFileSafe(): WorkingStateFile {
  try {
    if (!existsSync(statePath())) return { version: CURRENT_VERSION, projects: {} };
    const data = JSON.parse(readFileSync(statePath(), 'utf-8')) as WorkingStateFile;
    if (!data || typeof data !== 'object' || !data.projects || typeof data.projects !== 'object') {
      return { version: CURRENT_VERSION, projects: {} };
    }
    // Normalize on read: an entry written before per-path debt existed has no
    // `unverifiedPaths`, and every reader treats it as a list.
    for (const project of Object.values(data.projects)) {
      if (!Array.isArray(project.unverifiedPaths)) project.unverifiedPaths = [];
    }
    return data;
  } catch {
    return { version: CURRENT_VERSION, projects: {} };
  }
}

function writeFileSafe(data: WorkingStateFile): void {
  try {
    if (!existsSync(memoryDir())) mkdirSync(memoryDir(), { recursive: true });
    writeFileSync(statePath(), JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Best-effort — the ledger must never break a turn.
  }
}

/** Normalize a project path so the same project always maps to one entry. */
export function normalizeProjectPath(projectPath: string): string {
  try {
    return resolve(projectPath);
  } catch {
    return projectPath;
  }
}

// ─── Regression signals ─────────────────────────────────────────────────────

/**
 * Does the user's message report that something is STILL broken?
 *
 * This is the correction signal the audit was built on: the user said
 * "still same issue", "i don't see any change", "converter is not having any
 * conversion logic" six turns in a row. Detecting it lets the ledger keep the
 * issue in front of the agent instead of letting it re-diagnose from zero.
 *
 * Deliberately conservative: a bare question ("does this work?") is not a
 * regression, and neither is a fresh feature request.
 */
export function detectRegressionSignal(userMessage: string): boolean {
  const text = (userMessage || '').trim();
  if (!text) return false;
  if (text.length > 600) return false; // a long brief is a new task, not a correction
  const patterns: RegExp[] = [
    /\bstill\b/i,
    /\bsame (?:issue|problem|bug|thing|error|behaviou?r)\b/i,
    /\bnot (?:working|fixed|visible|showing|appearing|there)\b/i,
    /\bdoesn'?t work\b/i,
    /\bdidn'?t work\b/i,
    /\bno (?:change|changes|luck|effect)\b/i,
    /\bi (?:still )?(?:can'?t|cannot|don'?t) (?:see|find)\b/i,
    /\byou (?:broke|broke?n)\b/i,
    /\bregress(?:ion|ed)?\b/i,
    /\bit'?s (?:blank|empty|gone|missing)\b/i,
    /\bagain\b/i,
  ];
  return patterns.some((re) => re.test(text));
}

// ─── API ────────────────────────────────────────────────────────────────────

/**
 * Is this directory a PROJECT the ledger may speak for?
 *
 * The ledger block is injected as "carried from previous turns in THIS project",
 * which is a claim about a workspace. Two directories can never honestly make
 * that claim:
 *  - the HOME directory — a container of unrelated checkouts, not a project;
 *  - a filesystem ROOT — the same reason, and nothing to edit there.
 *
 * This fixes a real, reported defect. With no folder attached, a dashboard turn
 * ran in the server process's own cwd; when that was `$HOME`, the home
 * directory's ledger — whose `filesTouched` had accumulated edits under
 * `~/Documents/kuttaaddon` — was injected as THIS project's working state. Asked
 * "what's the state of this project?", the agent answered by describing that NVDA
 * add-on, a project the user never mentioned, and it was right to: the block it
 * was handed said those files were this project's. The ledger was accurate; the
 * DIRECTORY was not a project, so the claim was false.
 */
export function isProjectLedgerDir(dir: string): boolean {
  try {
    const abs = resolve(dir);
    if (abs === resolve(homedir())) return false;
    if (abs === parse(abs).root) return false;
    return true;
  } catch {
    // An unresolvable path is not evidence either way — keep the old behavior.
    return true;
  }
}

/** Read one project's state (null when nothing has been recorded). */
export function getWorkingState(projectPath: string): ProjectWorkingState | null {
  const data = readFileSafe();
  return data.projects[normalizeProjectPath(projectPath)] ?? null;
}

/**
 * Record a finished turn and return the updated state. Best-effort: on any
 * failure the caller still gets a usable (possibly unchanged) state.
 *
 * The rules encode the audit's lessons:
 * - Touched files accumulate and are capped oldest-first.
 * - A VERIFIED turn clears the unverified backlog AND the open issues (the
 *   fix is proven, so the previous report is answered).
 * - An UNVERIFIED edit turn increments the backlog — the debt the agent owes.
 * - A regression signal keeps the user's own words as an open issue.
 */
export function recordWorkingState(projectPath: string, turn: TurnRecord): ProjectWorkingState {
  const key = normalizeProjectPath(projectPath);
  const data = readFileSafe();
  const now = Date.now();
  const prev: ProjectWorkingState =
    data.projects[key] ??
    {
      projectPath: key,
      filesTouched: [],
      toolsUsed: [],
      turns: 0,
      unverifiedEdits: 0,
      unverifiedPaths: [],
      openIssues: [],
      corrections: 0,
      updatedAt: now,
    };

  const next: ProjectWorkingState = {
    ...prev,
    filesTouched: [...prev.filesTouched],
    toolsUsed: [...prev.toolsUsed],
    unverifiedPaths: [...(prev.unverifiedPaths ?? [])],
    openIssues: [...prev.openIssues],
  };
  next.turns = prev.turns + 1;
  next.updatedAt = now;

  // Files — dedupe (move-to-end so recency is meaningful) then cap.
  for (const f of turn.filesTouched ?? []) {
    if (!f) continue;
    const idx = next.filesTouched.indexOf(f);
    if (idx !== -1) next.filesTouched.splice(idx, 1);
    next.filesTouched.push(f);
  }
  if (next.filesTouched.length > MAX_FILES) {
    next.filesTouched = next.filesTouched.slice(-MAX_FILES);
  }

  // Tools — distinct, capped.
  for (const t of turn.toolsUsed ?? []) {
    if (t && !next.toolsUsed.includes(t)) next.toolsUsed.push(t);
  }
  if (next.toolsUsed.length > MAX_TOOLS) {
    next.toolsUsed = next.toolsUsed.slice(-MAX_TOOLS);
  }

  // ── Verification debt ───────────────────────────────────────────────────
  // PER-PATH mode (either list supplied): settle the debt file by file. A
  // verification of one change must not clear the debt on another, and a root
  // check that never loaded a nested package's suite must not clear it either —
  // which is exactly why the caller now hands over the paths a check covered.
  const perPath = turn.verifiedPaths !== undefined || turn.unverifiedPaths !== undefined;
  if (perPath) {
    const settled = new Set((turn.verifiedPaths ?? []).filter(Boolean));
    const kept = next.unverifiedPaths.filter((u) => !settled.has(u.path));
    const byPath = new Map(kept.map((u) => [u.path, u]));
    for (const p of turn.unverifiedPaths ?? []) {
      if (p) byPath.set(p, { path: p, at: now });
    }
    next.unverifiedPaths = [...byPath.values()].slice(-MAX_UNVERIFIED_PATHS);
    if (settled.size > 0) {
      next.lastVerifiedAt = now;
      // A proven fix answers the open reports.
      next.openIssues = [];
    }
    next.unverifiedEdits =
      next.unverifiedPaths.length === 0
        ? 0
        : prev.unverifiedEdits + ((turn.unverifiedPaths ?? []).length > 0 ? 1 : 0);
  } else if (turn.verified) {
    next.unverifiedEdits = 0;
    next.unverifiedPaths = [];
    next.lastVerifiedAt = now;
    // A proven fix answers the open reports.
    next.openIssues = [];
  } else if (turn.unverifiedEdit) {
    next.unverifiedEdits = prev.unverifiedEdits + 1;
  }

  // Regression memory — keep the user's own words.
  const msg = (turn.userMessage || '').trim();
  if (msg && detectRegressionSignal(msg)) {
    next.corrections = prev.corrections + 1;
    const short = msg.replace(/\s+/g, ' ').slice(0, 200);
    if (!next.openIssues.includes(short)) next.openIssues.push(short);
    if (next.openIssues.length > MAX_ISSUES) next.openIssues = next.openIssues.slice(-MAX_ISSUES);
  }

  data.projects[key] = next;
  // Bound the file: keep the most recently updated projects only.
  const entries = Object.entries(data.projects);
  if (entries.length > 50) {
    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    data.projects = Object.fromEntries(entries.slice(0, 50));
  }
  writeFileSafe(data);
  return next;
}

/** Forget one project (or the whole ledger when no path is given). */
export function clearWorkingState(projectPath?: string): void {
  if (!projectPath) {
    writeFileSafe({ version: CURRENT_VERSION, projects: {} });
    return;
  }
  const data = readFileSafe();
  delete data.projects[normalizeProjectPath(projectPath)];
  writeFileSafe(data);
}

// ─── Workspace reconciliation (what the FILESYSTEM says) ─────────────────────

/** What a git read says about the workspace behind the ledger. */
export interface WorkspaceReconciliation {
  /** True when `projectPath` is inside a git work tree we could read. */
  isGitRepo: boolean;
  /** Repo-relative paths with uncommitted changes. */
  dirty: string[];
  /**
   * Dirty paths the ledger never recorded as touched — an edit made outside the
   * agent, or a session that died before it could record. This is the gap the
   * ledger alone cannot see: it trusts its own report of what it changed.
   */
  unrecorded: string[];
  /**
   * Dirty paths MODIFIED AFTER the last verification. These are the changes no
   * passing check can speak for; empty when the ledger has never verified
   * anything (then `unverifiedPaths` carries the signal instead, and listing the
   * whole dirty tree would just be noise).
   */
  staleSinceVerification: string[];
}

/** No git answer — used on every best-effort failure path. */
const NO_RECONCILIATION: WorkspaceReconciliation = {
  isGitRepo: false,
  dirty: [],
  unrecorded: [],
  staleSinceVerification: [],
};

/** Run a read-only git command in `dir`; '' on any failure (never throws). */
function gitRead(dir: string, args: string[]): string {
  try {
    const r = spawnSync('git', args, {
      cwd: dir,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (r.status !== 0 || !r.stdout) return '';
    return r.stdout;
  } catch {
    return '';
  }
}

/**
 * Parse `git status --porcelain` output into repo-relative paths.
 *
 * Handles the two shapes that are not straight line-slices: a rename prints
 * `R  old -> new` (the NEW path is the one on disk), and git QUOTES a path with
 * unusual bytes. Malformed lines are skipped rather than guessed at.
 */
function parsePorcelainPaths(out: string): string[] {
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    if (line.length < 4) continue;
    let rest = line.slice(3);
    const arrow = rest.lastIndexOf(' -> ');
    if (arrow !== -1) rest = rest.slice(arrow + 4);
    if (rest.startsWith('"') && rest.endsWith('"') && rest.length > 1) {
      rest = rest.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    if (rest.trim()) paths.push(rest);
  }
  return paths;
}

/** Are two paths the same file? (One may be absolute, the other repo-relative.) */
function samePath(a: string, b: string, projectPath: string): boolean {
  if (a === b) return true;
  const abs = (p: string): string => (isAbsolute(p) ? resolve(p) : resolve(projectPath, p));
  try {
    return abs(a) === abs(b);
  } catch {
    return false;
  }
}

/** File mtime in ms, or 0 when it cannot be read (never throws). */
function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Re-read the WORLD behind the ledger: what is actually changed on disk, and
 * whether anything changed after the last verification.
 *
 * WHY THIS EXISTS. The ledger records what the LOOP said it changed. That is a
 * report, and the repo's own invariant (see `docs/rca_false_success_and_no_resume.md`
 * §6) is that a report is a proposal — "re-read the world: files on disk, VCS
 * status". Two real cases the report cannot cover: an edit made by something
 * other than the agent, and a turn killed before it recorded anything. Both are
 * exactly "work from the previous session whose state nobody knows".
 *
 * Read-only, bounded by a timeout, and best-effort: a directory that is not a
 * repository (or has no git) reconciles to nothing rather than throwing.
 */
export function reconcileWithWorkspace(
  state: ProjectWorkingState | null,
  projectPath: string,
  now: number = Date.now(),
): WorkspaceReconciliation {
  try {
    const dir = normalizeProjectPath(projectPath);
    const inside = gitRead(dir, ['rev-parse', '--is-inside-work-tree']).trim();
    if (inside !== 'true') return NO_RECONCILIATION;
    // `-uall` lists untracked FILES individually; the paths are what matter here.
    const dirty = parsePorcelainPaths(gitRead(dir, ['status', '--porcelain', '-uall']));
    if (dirty.length === 0) return { isGitRepo: true, dirty: [], unrecorded: [], staleSinceVerification: [] };

    const touched = state?.filesTouched ?? [];
    const unrecorded = dirty.filter((p) => !touched.some((t) => samePath(t, p, dir)));

    const verifiedAt = state?.lastVerifiedAt;
    const staleSinceVerification =
      verifiedAt === undefined
        ? []
        : dirty.filter((p) => {
            const at = mtimeMs(resolve(dir, p));
            return at > verifiedAt;
          });

    return { isGitRepo: true, dirty, unrecorded, staleSinceVerification };
  } catch {
    // Best-effort — the ledger must never break a turn.
    return NO_RECONCILIATION;
  }
}

// ─── Formatting (the injected block) ────────────────────────────────────────

function relativeAge(ts: number, now: number): string {
  const mins = Math.max(0, Math.round((now - ts) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Format the state as a compact, model-readable block ('' when there is
 * nothing worth saying — a pristine project must not add noise to the prompt).
 *
 * Kept short on purpose: this rides in EVERY turn, so a verbose block would
 * recreate the very drift it exists to prevent.
 */
export function formatWorkingState(
  state: ProjectWorkingState | null,
  now: number = Date.now(),
  reconciled?: WorkspaceReconciliation,
): string {
  if (!state) return '';
  const lines: string[] = [];
  if (state.filesTouched.length > 0) {
    const files = state.filesTouched.slice(-8);
    lines.push(
      `• Files changed this session (${state.filesTouched.length}): ${files.join(', ')}${state.filesTouched.length > files.length ? ', …' : ''}`,
    );
  }
  if (state.unverifiedEdits > 0) {
    lines.push(
      `• ⚠️ ${state.unverifiedEdits} edit turn(s) were NEVER verified — do not assume they work; re-check before building on them.`,
    );
  }
  // The per-file debt, named. A count cannot be acted on ("re-check before
  // building on THEM" leaves the model to guess which files); the paths can.
  const owed = state.unverifiedPaths ?? [];
  if (owed.length > 0) {
    const shown = owed.slice(-5);
    const named = shown.map((u) => `${u.path} (${relativeAge(u.at, now)})`).join(', ');
    lines.push(
      `• ⚠️ Unverified changes (${owed.length}): ${named}${owed.length > shown.length ? ', …' : ''} — no check has exercised these.`,
    );
  }
  if (state.lastVerifiedAt !== undefined) {
    lines.push(`• Last verified: ${relativeAge(state.lastVerifiedAt, now)} (a test/typecheck/browser run passed).`);
  }
  // What GIT says the workspace holds, when it disagrees with (or adds to) the
  // ledger's own report. Capped: this rides in every prompt.
  if (reconciled?.isGitRepo) {
    const stale = reconciled.staleSinceVerification;
    if (stale.length > 0) {
      const shown = stale.slice(0, 5);
      lines.push(
        `• ⚠️ ${stale.length} file(s) changed on disk AFTER the last verification: ${shown.join(', ')}${stale.length > shown.length ? ', …' : ''} — nothing has checked them.`,
      );
    }
    const extra = reconciled.unrecorded;
    if (extra.length > 0) {
      const shown = extra.slice(0, 5);
      lines.push(
        `• ${extra.length} changed file(s) this ledger never recorded (an edit outside the agent, or a turn that died mid-work): ${shown.join(', ')}${extra.length > shown.length ? ', …' : ''}`,
      );
    }
  }
  if (state.openIssues.length > 0) {
    const latest = state.openIssues[state.openIssues.length - 1];
    lines.push(
      `• User has reported ${state.corrections} regression(s). Most recent report: "${latest}" — fix THIS, do not re-diagnose from scratch.`,
    );
  }
  if (lines.length === 0) return '';
  return `[Working state — carried from previous turns in THIS project]\n${lines.join('\n')}`;
}

/**
 * The block every surface injects: the ledger PLUS the git reconciliation of the
 * same workspace. One call so the CLI loop, the dashboard prompt assembly and the
 * orchestrator cannot read the ledger without re-reading the world beside it.
 *
 * Returns '' for a project with nothing to say (a pristine workspace must add no
 * prompt weight). Best-effort throughout.
 */
export function workingStateBlock(projectPath: string, now: number = Date.now()): string {
  try {
    const state = getWorkingState(projectPath);
    if (!state) return '';
    return formatWorkingState(state, now, reconcileWithWorkspace(state, projectPath, now));
  } catch {
    return '';
  }
}
