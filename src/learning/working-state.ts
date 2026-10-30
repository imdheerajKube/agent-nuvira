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

/**
 * How deeply a path was examined — the one dimension the ledger never held.
 *
 * WHY DEPTH AND NOT A BOOLEAN. "I saw this file in a directory listing", "I read
 * it" and "I ran something against it" are three different amounts of evidence,
 * and the whole cost of a re-audit is re-establishing conclusions that were only
 * ever drawn at the shallow end. Collapsing them into `seen: true` would let a
 * `list_dir` hit look like a read conclusion, which is the more expensive lie:
 * the next run skips the file believing someone read it.
 *
 * Ordered: `listed` < `read` < `executed`. Depth only ever ESCALATES while the
 * file is unchanged — a later listing cannot demote a read.
 */
export type CoverageDepth = 'listed' | 'read' | 'executed';

/** Rank for {@link CoverageDepth}; higher is deeper. */
const DEPTH_RANK: Record<CoverageDepth, number> = { listed: 0, read: 1, executed: 2 };

/**
 * What the ledger remembers about one examined path.
 *
 * `size` + `mtime` are the STALENESS STAMP, not decoration: they are what lets a
 * later run tell "the conclusion recorded here still describes this file" from
 * "the file changed and that conclusion is about older content". A content hash
 * would be stricter, but this runs on the read path of every turn, and a re-stat
 * is cheap enough to do without thinking about it.
 */
export interface CoverageEntry {
  /** How deeply it was examined, at the recorded content. */
  depth: CoverageDepth;
  /** The conclusion reached, when the caller recorded one. Never trusted once stale. */
  verdict?: string;
  /** Which run examined it (`trace-…` when the caller has one). */
  runId: string;
  /** Bytes at record time — part of the staleness stamp. */
  size: number;
  /** mtime (ms) at record time — part of the staleness stamp. */
  mtime: number;
  /** Epoch ms this entry was last written. */
  at: number;
}

/** One path to record as examined. The caller supplies what it actually did. */
export interface CoverageNote {
  path: string;
  depth: CoverageDepth;
  /** What was concluded at this depth (`"no null check on the token"`). */
  verdict?: string;
}

/**
 * A coverage entry as a READER sees it: the record plus whether it still holds.
 *
 * `stale` is computed from the filesystem on every read -- the stored entry is
 * never mutated for it, because the fact "this WAS read at that content" stays
 * true forever. What changes is whether a later run may rely on the conclusion,
 * and that is the whole point of keeping the two apart.
 */
export interface CoverageView extends CoverageEntry {
  path: string;
  /** True when the file is gone or its stamp no longer matches the record. */
  stale: boolean;
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
  /**
   * Paths already EXAMINED in this project, keyed project-relative (see
   * {@link CoverageEntry}). This is the record that makes a second run over the
   * same tree cheaper than the first: it says what was looked at, how deeply, and
   * what was concluded, so the work is not re-derived from zero after a crash, a
   * new turn or a new conversation.
   *
   * Optional on purpose: a ledger written before this field existed parses as
   * "nothing recorded" rather than as "nothing examined".
   */
  coverage?: Record<string, CoverageEntry>;
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
  /**
   * The run id to stamp on coverage the turn adds (`trace-…` when the surface has
   * one). Recorded so a coverage entry, a finding in the trace and the turn's
   * report can be tied to the same run — an unattributed ledger is only a
   * reminder that something was looked at, not evidence of what was concluded.
   */
  runId?: string;
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
/** Cap on remembered examined paths (oldest drop first). */
export const MAX_COVERAGE = 300;
/**
 * How many mid-turn coverage notes accumulate before they are flushed to disk.
 *
 * The point of recording coverage DURING the turn rather than at its end is the
 * run that never reaches its end: a crash, a cancelled turn or a quota kill has
 * no end-of-turn write, and those are exactly the runs where knowing what had
 * already been examined saves the most. Batching keeps the write cost off the
 * read path; `COVERAGE_FLUSH_MS` bounds how much a hard kill can lose.
 */
const COVERAGE_FLUSH_NOTES = 20;
/** Flush pending coverage at most this often, even when the note count is low. */
const COVERAGE_FLUSH_MS = 4_000;
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
      // Same for the coverage map: absent means "this ledger predates it", and a
      // reader must not be handed `undefined` where it expects an object.
      if (!project.coverage || typeof project.coverage !== 'object') project.coverage = {};
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

/** The empty ledger entry for a project — one definition, so every creator agrees. */
function emptyState(key: string, now: number): ProjectWorkingState {
  return {
    projectPath: key,
    filesTouched: [],
    toolsUsed: [],
    turns: 0,
    unverifiedEdits: 0,
    unverifiedPaths: [],
    openIssues: [],
    corrections: 0,
    coverage: {},
    updatedAt: now,
  };
}

/**
 * A project-relative key for a path, or null when it lies outside the project.
 *
 * Keying relative is what makes the record survive a clone, a rename of the
 * checkout's parent, or a run started from a subdirectory — an absolute key would
 * silently stop matching and the ledger would read as empty at the exact moment
 * it was most needed. A path outside the project (`~/.nuvira/...`, `/etc/...`)
 * has no project-relative identity and is refused rather than recorded under a
 * misleading key.
 */
function coverageKey(root: string, path: string): string | null {
  if (!path || typeof path !== 'string') return null;
  try {
    const abs = isAbsolute(path) ? path : resolve(root, path);
    const rel = relative(root, abs).split('\\').join('/');
    if (!rel || rel === '.' || rel.startsWith('../')) return null;
    return rel;
  } catch {
    return null;
  }
}

/**
 * The staleness stamp of a path on disk, or null when it is not a readable file.
 *
 * A directory, a missing path or an unreadable one yields null, and a null stamp
 * means the caller records NOTHING: "examined" is a claim about content, and a
 * path whose content could not be stat'ed was not examined.
 */
function fileStamp(abs: string): { size: number; mtime: number } | null {
  try {
    const stat = statSync(abs);
    if (!stat.isFile()) return null;
    return { size: stat.size, mtime: Math.round(stat.mtimeMs) };
  } catch {
    return null;
  }
}

/** Keep the newest {@link MAX_COVERAGE} entries (oldest examined drop first). */
function capCoverage(map: Record<string, CoverageEntry>): Record<string, CoverageEntry> {
  const entries = Object.entries(map);
  if (entries.length <= MAX_COVERAGE) return map;
  entries.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(entries.slice(0, MAX_COVERAGE));
}

/**
 * Merge coverage notes into a map, preserving what the notes do not overwrite.
 *
 * The three rules, and why each one is a decision rather than a detail:
 *  1. A path that is not a file on disk is dropped — see {@link fileStamp}.
 *  2. Depth only escalates WHILE THE FILE IS UNCHANGED. When the stamp differs,
 *     the old depth described different content, so it is replaced by what the
 *     note actually did, and a stale `verdict` is dropped rather than carried
 *     forward onto a file it was never about.
 *  3. `runId` is the note's, so a reader can find the run that made the claim.
 */
function mergeCoverage(
  map: Record<string, CoverageEntry>,
  notes: readonly CoverageNote[],
  runId: string,
  root: string,
  now: number,
): Record<string, CoverageEntry> {
  const next: Record<string, CoverageEntry> = { ...map };
  for (const note of notes) {
    const key = coverageKey(root, note?.path);
    if (!key) continue;
    const stamp = fileStamp(resolve(root, key));
    if (!stamp) continue;
    const prev = next[key];
    const unchanged = Boolean(prev) && prev!.size === stamp.size && prev!.mtime === stamp.mtime;
    const depth =
      unchanged && DEPTH_RANK[prev!.depth] > DEPTH_RANK[note.depth] ? prev!.depth : note.depth;
    const entry: CoverageEntry = {
      depth,
      runId: runId || prev?.runId || 'unattributed',
      size: stamp.size,
      mtime: stamp.mtime,
      at: now,
    };
    // A verdict survives only on unchanged content; an inherited one would be a
    // conclusion about a file the current content is not.
    if (note.verdict) entry.verdict = note.verdict;
    else if (unchanged && prev?.verdict) entry.verdict = prev.verdict;
    next[key] = entry;
  }
  return capCoverage(next);
}

// ─── Coverage — what this project has already had examined ──────────────────

/** One project's unflushed coverage notes. */
interface PendingCoverage {
  notes: CoverageNote[];
  runId: string;
  since: number;
}

const pendingCoverage = new Map<string, PendingCoverage>();

/**
 * Record that a path was examined, DURING the turn.
 *
 * The reason this exists beside {@link recordWorkingState}: a run that dies —
 * crash, cancel, quota, timeout — never reaches its end-of-turn write, and the
 * half-finished run is precisely the one whose findings a next run most needs. So
 * notes accumulate in memory and flush on a small bound instead of waiting for a
 * turn that may never finish. Best-effort throughout: recording coverage must
 * never be the thing that breaks a turn.
 *
 * `depth` is the caller's HONEST report of what happened: a `read_file` result is
 * `read`, a check that exercised the file is `executed`, a `list_dir` is `listed`.
 */
export function noteCoverage(
  projectPath: string,
  note: CoverageNote | readonly CoverageNote[],
  opts: { runId?: string; root?: string; now?: number } = {},
): void {
  try {
    if (!projectPath) return;
    // The same rule the ledger states for its own writes: a home directory or a
    // filesystem root is not a project, so the block would claim "carried from
    // previous turns in THIS project" about a container of unrelated checkouts.
    if (!isProjectLedgerDir(projectPath)) return;
    const key = normalizeProjectPath(projectPath);
    const notes = (Array.isArray(note) ? [...note] : [note]) as CoverageNote[];
    if (notes.length === 0) return;
    const now = opts.now ?? Date.now();
    const pending = pendingCoverage.get(key) ?? {
      notes: [],
      // `root` is the project the RELATIVE keys are measured against; it defaults
      // to the ledger key, and a caller running in a subdirectory passes it so
      // `src/a.ts` is recorded once, not once per working directory.
      runId: opts.runId ?? 'unattributed',
      since: now,
    };
    pending.notes.push(...notes);
    if (opts.runId) pending.runId = opts.runId;
    pendingCoverage.set(key, pending);
    const due = pending.notes.length >= COVERAGE_FLUSH_NOTES || now - pending.since >= COVERAGE_FLUSH_MS;
    if (due) flushCoverage(key, opts.root);
  } catch {
    // Best-effort — coverage bookkeeping never breaks a turn.
  }
}

/**
 * Write the pending coverage for one project (or all of them) to the ledger.
 *
 * Called on the flush bounds above and at the end of a turn. It creates the
 * project's entry when the ledger has none yet: a first run that only READ files
 * still has something worth remembering, and dropping its notes because nothing
 * was edited would be the ledger forgetting on a technicality.
 */
export function flushCoverage(projectPath?: string, root?: string): void {
  const keys = projectPath ? [normalizeProjectPath(projectPath)] : [...pendingCoverage.keys()];
  for (const key of keys) {
    const pending = pendingCoverage.get(key);
    if (!pending || pending.notes.length === 0) {
      pendingCoverage.delete(key);
      continue;
    }
    pendingCoverage.delete(key);
    try {
      const data = readFileSafe();
      const now = Date.now();
      const state = data.projects[key] ?? emptyState(key, now);
      state.coverage = mergeCoverage(state.coverage ?? {}, pending.notes, pending.runId, root ?? key, now);
      state.updatedAt = now;
      data.projects[key] = state;
      writeFileSafe(data);
    } catch {
      // Best-effort — a lost flush costs one batch, never the turn.
    }
  }
}

/**
 * The examined paths of a project, as a reader should see them.
 *
 * `stale` is computed here, from the filesystem, and never written back: the
 * stored entry records what happened, the view says whether it still holds. A
 * stale entry is degraded to `listed` with its verdict dropped — the honest
 * reading is "something looked at this file once, before the content changed",
 * not "someone read this file", and the difference is the whole cost of
 * re-deriving a conclusion that no longer applies.
 */
export function coverageFor(
  projectPath: string,
  opts: { max?: number } = {},
): CoverageView[] {
  try {
    return coverageViews(getWorkingState(projectPath), projectPath, opts.max);
  } catch {
    return [];
  }
}

/** The reader-side projection of a state's coverage map (shared with the block). */
function coverageViews(
  state: ProjectWorkingState | null,
  projectPath: string,
  max?: number,
): CoverageView[] {
  const map = state?.coverage ?? {};
  const root = normalizeProjectPath(projectPath || state?.projectPath || '');
  const views: CoverageView[] = [];
  for (const [path, entry] of Object.entries(map)) {
    const stamp = root ? fileStamp(resolve(root, path)) : null;
    const stale = !stamp || stamp.size !== entry.size || stamp.mtime !== entry.mtime;
    if (stale) {
      // Degrade, do not delete: the record stays in the file, the READER stops
      // trusting the depth and the conclusion it carried.
      const { verdict: _dropped, ...rest } = entry;
      views.push({ ...rest, path, stale: true, depth: 'listed' });
    } else {
      views.push({ ...entry, path, stale: false });
    }
  }
  views.sort((a, b) => b.at - a.at);
  return max && max > 0 ? views.slice(0, max) : views;
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
  const prev: ProjectWorkingState = data.projects[key] ?? emptyState(key, now);

  const next: ProjectWorkingState = {
    ...prev,
    filesTouched: [...prev.filesTouched],
    toolsUsed: [...prev.toolsUsed],
    unverifiedPaths: [...(prev.unverifiedPaths ?? [])],
    openIssues: [...prev.openIssues],
    coverage: { ...(prev.coverage ?? {}) },
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

  // ── Coverage: the paths a CHECK exercised ───────────────────────────────
  // `verifiedPaths` is the caller's report of which changed paths a test/typecheck
  // /browser run actually covered. That is the only honest source of `executed`
  // depth: it is a fact the harness measured, not a claim the model made, and it
  // is recorded here so the NEXT run knows this file has already been run against
  // something — the depth that makes re-reading it cheaper to skip.
  const executed = (turn.verifiedPaths ?? []).filter(Boolean);
  if (executed.length > 0) {
    next.coverage = mergeCoverage(
      next.coverage ?? {},
      executed.map((path) => ({ path, depth: 'executed' as CoverageDepth })),
      turn.runId ?? 'unattributed',
      key,
      now,
    );
  }
  // Anything this turn examined mid-flight and has not flushed yet lands with it,
  // so a single write keeps the file consistent and the turn's reads are not lost
  // to a flush that happens to fall between the turn's last read and its write.
  const pending = pendingCoverage.get(key);
  if (pending && pending.notes.length > 0) {
    next.coverage = mergeCoverage(
      next.coverage ?? {},
      pending.notes,
      pending.runId,
      key,
      now,
    );
    pendingCoverage.delete(key);
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
   *
   * EMPTY when the ledger has recorded no file activity at all: with no
   * baseline, "never recorded" describes every dirty path rather than a
   * discrepancy, and printing the whole tree is the noise the sibling rule below
   * refuses for the same reason (see the rule in `reconcileWithWorkspace`, which
   * is also what keeps the block identical across two turns of an unchanged
   * world — the property a resumed step's replay depends on).
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

    // NO BASELINE, NO DISCREPANCY — and the two are not the same statement.
    //
    // `unrecorded` is meant to be the gap between what the ledger REMEMBERS
    // changing and what the tree holds. With no recorded file activity there is
    // no memory to disagree with: every dirty path is "unrecorded", so the line
    // reduces to the whole dirty tree, which is the noise the sibling rule below
    // (`staleSinceVerification`, empty until something has been verified) already
    // refuses to print.
    //
    // MEASURED (2026-10-12), and this is why the rule is written down here: a
    // FRESH ledger printed nothing on its first turn and "N changed file(s) this
    // ledger never recorded" on its second, in a workspace where nothing had
    // changed — the only difference was that turn 1 created the ledger entry. The
    // block rides in the prompt, so two identical turns over an unchanged world
    // had DIFFERENT inputs: a resumed run's unchanged step stopped replaying
    // (`stepDigest` covers the thread, and the thread had grown a message no edit
    // earned), and the parity resume probe went red on any checkout with
    // uncommitted work. The ledger's self-description is that it is DETERMINISTIC
    // — the same world produces the same block — and this restores it.
    const touched = state?.filesTouched ?? [];
    const recordedPaths =
      touched.length > 0 ? touched : (state?.unverifiedPaths ?? []).map((u) => u.path);
    const unrecorded =
      recordedPaths.length === 0
        ? []
        : dirty.filter((p) => !recordedPaths.some((t) => samePath(t, p, dir)));

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
  // What has ALREADY been examined here — the record that makes a second run over
  // this tree cheaper than the first. One line for the current entries and one for
  // the stale ones, because it rides in every prompt and a verbose block would
  // recreate the drift it exists to prevent. The stale line is separate on purpose:
  // "these were read" and "these no longer describe the file" are different
  // instructions, and a single line would blur them into "someone looked at it".
  const examined = coverageViews(state, state.projectPath, 80);
  const current = examined.filter((c) => !c.stale);
  if (current.length > 0) {
    const shown = current.slice(0, 6).map((c) => `${c.path} (${c.depth}, ${relativeAge(c.at, now)})`);
    lines.push(
      `• Already examined (${current.length} path(s), still current): ${shown.join(', ')}${current.length > shown.length ? ', …' : ''} — a conclusion recorded against these is already on the ledger; do not re-derive it.`,
    );
  }
  const gone = examined.filter((c) => c.stale);
  if (gone.length > 0) {
    const shown = gone.slice(0, 5).map((c) => c.path);
    lines.push(
      `• ⚠️ Changed since examined (${gone.length}): ${shown.join(', ')}${gone.length > shown.length ? ', …' : ''} — the earlier conclusion was about older content; re-read before relying on it.`,
    );
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
