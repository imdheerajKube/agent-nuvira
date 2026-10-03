/**
 * Session digest — the per-project memory of what RECENT ASKS did, across
 * sessions (Phase 4 / G6, the DETERMINISTIC branch).
 *
 * WHY THIS EXISTS (and why it is not an LLM summary)
 * ---------------------------------------------------
 * Two continuity needs sit next to each other:
 *   - `working-state.ts` remembers the WORK (files touched, verification debt,
 *     user-reported regressions) but NOT what was ASKED or how it ended; and
 *   - a cross-session "what happened recently" memory, which the plan flagged as
 *     a possible LLM-compaction target.
 *
 * The plan left that second one as an OPEN DECISION (LLM summary vs deterministic).
 * This module makes the DETERMINISTIC choice, deliberately:
 *   - a model-written summary can assert "the build works" and re-introduce the
 *     exact false-success class Parts 1/2 closed;
 *   - a digest of FACTS (goal, outcome, tools, whether anything was verified)
 *     cannot lie about completion because it does not judge it.
 *
 * So the digest is ADVISORY CONTEXT ONLY. It is never read to decide whether a
 * step is done — completion still derives from artifacts on disk. A test pins
 * that (a digest claiming success cannot flip a completion).
 *
 * Deterministic, LLM-free, best-effort (never throws), and bounded so it adds a
 * fixed, small weight to the prompt.
 */

import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** One finished turn, as recorded by the caller. */
export interface SessionTurn {
  /** Epoch ms the turn ended. */
  at: number;
  /** The ask, truncated. */
  goal: string;
  /** The turn's outcome kind (`acted` / `incomplete` / `failed` / `cancelled`). */
  outcome: string;
  /** Tools that ran (deduped, capped). */
  tools: string[];
  /** A verification tool ran successfully this turn. */
  verified: boolean;
}

/** What a caller records when a turn ends. */
export interface SessionTurnInput {
  projectPath: string;
  goal: string;
  outcome: string;
  tools?: readonly string[];
  verified?: boolean;
}

export interface ProjectSessionDigest {
  projectPath: string;
  /** Newest last. */
  turns: SessionTurn[];
  updatedAt: number;
}

interface DigestFile {
  version: number;
  projects: Record<string, ProjectSessionDigest>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CURRENT_VERSION = 1;
/** Cap on remembered turns per project (oldest drop first). */
export const MAX_TURNS = 12;
/** Cap on remembered tools per turn. */
export const MAX_TOOLS_PER_TURN = 8;
/** Cap on the goal text kept per turn. */
export const MAX_GOAL_CHARS = 160;
/** Cap on the rendered block — it rides in prompts, so it stays small. */
export const MAX_BLOCK_CHARS = 1_600;
/** Turns shown in the block (newest last). */
const SHOWN_TURNS = 8;

// ─── Storage ────────────────────────────────────────────────────────────────

function memoryDir(): string {
  return envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
}

function storePath(): string {
  return join(memoryDir(), 'session-digests.json');
}

function normalizeProjectPath(projectPath: string): string {
  try {
    return resolve(projectPath);
  } catch {
    return projectPath;
  }
}

function readFileSafe(): DigestFile {
  try {
    if (!existsSync(storePath())) return { version: CURRENT_VERSION, projects: {} };
    const data = JSON.parse(readFileSync(storePath(), 'utf-8')) as DigestFile;
    if (!data || typeof data !== 'object' || !data.projects || typeof data.projects !== 'object') {
      return { version: CURRENT_VERSION, projects: {} };
    }
    return data;
  } catch {
    return { version: CURRENT_VERSION, projects: {} };
  }
}

function writeFileSafe(data: DigestFile): void {
  try {
    if (!existsSync(memoryDir())) mkdirSync(memoryDir(), { recursive: true });
    writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Best-effort — a digest write must never break a turn.
  }
}

function clip(text: string, max: number): string {
  const flat = (text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ─── API ────────────────────────────────────────────────────────────────────

/**
 * Record a finished turn and return the updated digest. Best-effort: never throws.
 */
export function recordSessionTurn(input: SessionTurnInput): ProjectSessionDigest {
  const projectPath = normalizeProjectPath(input.projectPath);
  const now = Date.now();
  try {
    const data = readFileSafe();
    const prev: ProjectSessionDigest = data.projects[projectPath] ?? {
      projectPath,
      turns: [],
      updatedAt: now,
    };
    const tools = [...new Set((input.tools ?? []).filter((t) => typeof t === 'string' && t))].slice(
      0,
      MAX_TOOLS_PER_TURN,
    );
    const turn: SessionTurn = {
      at: now,
      goal: clip(input.goal, MAX_GOAL_CHARS),
      outcome: clip(input.outcome || 'unknown', 24),
      tools,
      verified: input.verified === true,
    };
    const turns = [...prev.turns, turn];
    if (turns.length > MAX_TURNS) turns.splice(0, turns.length - MAX_TURNS);
    const next: ProjectSessionDigest = { projectPath, turns, updatedAt: now };
    data.projects[projectPath] = next;
    writeFileSafe(data);
    return next;
  } catch {
    return { projectPath, turns: [], updatedAt: now };
  }
}

/** Read one project's digest, or null. */
export function getSessionDigest(projectPath: string): ProjectSessionDigest | null {
  try {
    return readFileSafe().projects[normalizeProjectPath(projectPath)] ?? null;
  } catch {
    return null;
  }
}

/** Relative age, spelled for a human reader. */
function relativeAge(ts: number, now: number): string {
  const mins = Math.max(0, Math.round((now - ts) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Format a project's digest as a bounded, model-readable block ('' when there is
 * nothing to show — a clean project adds no prompt weight).
 *
 * ADVISORY ONLY: the header says outright that this is history, not a status —
 * so a model cannot read an old "completed" line as proof the work is done now.
 */
export function formatSessionDigest(projectPath: string, now: number = Date.now()): string {
  try {
    const digest = getSessionDigest(projectPath);
    if (!digest || digest.turns.length === 0) return '';
    const shown = digest.turns.slice(-SHOWN_TURNS);
    const lines: string[] = [
      '[Recent sessions in THIS project — history for context only. This is NOT a status of the current work; verify artifacts on disk before assuming anything is done.]',
    ];
    for (const turn of shown) {
      const verified = turn.verified ? ', verified' : '';
      const tools = turn.tools.length > 0 ? ` (tools: ${turn.tools.join(', ')}${verified})` : verified ? ` (${verified.slice(2)})` : '';
      lines.push(`• ${relativeAge(turn.at, now)} — ${turn.outcome}: "${turn.goal}"${tools}`);
    }
    let block = lines.join('\n');
    if (block.length > MAX_BLOCK_CHARS) {
      block = `${block.slice(0, MAX_BLOCK_CHARS)}\n[digest truncated to fit the context budget]`;
    }
    return block;
  } catch {
    return '';
  }
}

/** Forget one project's digest. */
export function clearSessionDigest(projectPath: string): void {
  try {
    const data = readFileSafe();
    const key = normalizeProjectPath(projectPath);
    if (!(key in data.projects)) return;
    delete data.projects[key];
    writeFileSafe(data);
  } catch {
    // Best-effort.
  }
}
