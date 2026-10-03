/**
 * Session recall (Phase 4 follow-on) — SEMANTIC recall across past asks.
 *
 * WHY THIS EXISTS, AND WHY IT IS OPT-IN.
 * The deterministic session digest (`session-digest.ts`) shows the LAST few asks
 * in a project. That is good for continuity, but it is recency-based: an ask from
 * three weeks ago about the SAME subject is invisible if ten unrelated asks
 * happened since. This module adds *semantic* recall — embed each finished ask,
 * and at the start of a new turn retrieve the past asks that mean the same thing,
 * above an explicit cosine THRESHOLD, so relevance is by meaning rather than by
 * a literal token overlap (`goalsLookSame`) or by recency.
 *
 * It is deliberately OFF unless asked for (`NUVIRA_SESSION_RECALL=1`). Semantics
 * introduce an embedding dependency whose tiers can be slow to fail over; a
 * feature that makes an ordinary turn wait on a model download would be a worse
 * bug than the recall it buys. So, exactly like `--resume`, an ordinary run pays
 * nothing: no read, no embed, no query.
 *
 * WHY IT CANNOT RE-OPEN FALSE SUCCESS. A recalled ask is HISTORY, presented as
 * however it ENDED (`acted` / `incomplete` / `failed` / `cancelled`) — never as a
 * completion the current work inherits. The block says so outright, and nothing
 * here is read to decide whether a step is done: completion still derives from
 * artifacts on disk. A recalled "the build works" is a sentence the past model
 * wrote, quoted, not a fact the framework adopts.
 *
 * Bounded + best-effort throughout: a fixed entry cap, a fixed top-k, a fixed
 * block size, and every read/write/embed wrapped so a corrupt index or a missing
 * embedding tier degrades to "no recall", never a broken turn.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { embed } from '../memory/embedder.js';
import { cosineSimilarity } from '../memory/vector-store.js';

/** The environment key that turns semantic recall on (`1`/`true`/`yes`). */
export const SESSION_RECALL_ENV = 'NUVIRA_SESSION_RECALL';

/** Cosine floor a past ask must clear to be recalled (0-1). */
export const DEFAULT_RECALL_THRESHOLD = 0.5;
/** How many past asks to surface at most. */
export const DEFAULT_RECALL_TOP_K = 3;
/** Hard cap on the index (oldest dropped) — recall must never grow unbounded. */
export const MAX_INDEX_ENTRIES = 500;
/** Hard cap on the rendered block — it rides in prompts. */
export const MAX_RECALL_BLOCK_CHARS = 1_200;

/** An embedding function (injectable for tests / deterministic callers). */
export type EmbedFn = (text: string) => Promise<number[]>;

/** One indexed past ask. */
export interface RecallEntry {
  id: string;
  projectPath: string;
  goal: string;
  outcome: string;
  savedAt: number;
  vector: number[];
}

interface RecallIndex {
  version: number;
  entries: RecallEntry[];
}

/** A recalled past ask with its similarity. */
export interface RecallHit {
  entry: RecallEntry;
  similarity: number;
}

const CURRENT_VERSION = 1;

// ─── Enablement ─────────────────────────────────────────────────────────────

/** Words a reader treats as OFF (same vocabulary the process-env page uses). */
const OFF_WORDS = new Set(['0', 'false', 'off', 'no']);

/**
 * Is semantic recall on? DEFAULT ON — like checkpointing, an operator can turn
 * it off, but a fresh install gets the feature rather than a switch that does
 * nothing until someone reads the docs. `0`/`false`/`off`/`no` turn it off;
 * unset (or any other value) leaves it ON.
 */
export function sessionRecallEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SESSION_RECALL_ENV];
  if (typeof raw !== 'string') return true;
  return !OFF_WORDS.has(raw.trim().toLowerCase());
}

// Keep the repo's env indirection working too (`NUVIRA_` then `BUFF_`).
function recallEnabledViaHelper(): boolean | undefined {
  const raw = envBuff('SESSION_RECALL');
  if (typeof raw !== 'string') return undefined;
  return !OFF_WORDS.has(raw.trim().toLowerCase());
}

/** The config/env shape a resolver reads (structural, so no import cycle). */
export interface RecallConfigSource {
  getAll(): { memory?: { sessionRecall?: boolean } };
}

/**
 * Resolve whether semantic recall is on, with the repo's precedence:
 * an explicit FLAG wins, then the environment, then config, then the default
 * (ON). This is the single place the decision is made, so the CLI, the loop and
 * the dashboard cannot disagree.
 */
export function resolveSessionRecall(
  input: { flag?: boolean; configManager?: RecallConfigSource | null } = {},
): boolean {
  if (input.flag !== undefined) return input.flag;
  const viaEnv = recallEnabledViaHelper();
  if (viaEnv !== undefined) return viaEnv;
  const cfg = input.configManager?.getAll().memory?.sessionRecall;
  return cfg !== false;
}

function enabled(): boolean {
  return resolveSessionRecall();
}

// ─── Storage ────────────────────────────────────────────────────────────────

function memoryDir(): string {
  return envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
}

function indexPath(): string {
  return join(memoryDir(), 'session-recall-index.json');
}

function normalizeProjectPath(projectPath: string): string {
  try {
    return resolve(projectPath);
  } catch {
    return projectPath;
  }
}

function readIndex(): RecallIndex {
  try {
    if (!existsSync(indexPath())) return { version: CURRENT_VERSION, entries: [] };
    const data = JSON.parse(readFileSync(indexPath(), 'utf-8')) as RecallIndex;
    if (!data || typeof data !== 'object' || !Array.isArray(data.entries)) {
      return { version: CURRENT_VERSION, entries: [] };
    }
    const entries = data.entries.filter(isRecallEntry);
    return { version: CURRENT_VERSION, entries };
  } catch {
    return { version: CURRENT_VERSION, entries: [] };
  }
}

function isRecallEntry(value: unknown): value is RecallEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Partial<RecallEntry>;
  return (
    typeof e.id === 'string' &&
    typeof e.projectPath === 'string' &&
    typeof e.goal === 'string' &&
    Array.isArray(e.vector) &&
    e.vector.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

function writeIndex(index: RecallIndex): boolean {
  try {
    mkdirSync(memoryDir(), { recursive: true });
    writeFileSync(indexPath(), JSON.stringify(index, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function isZeroVector(vector: readonly number[]): boolean {
  return vector.length === 0 || vector.every((n) => n === 0);
}

// ─── Indexing ───────────────────────────────────────────────────────────────

/** A stable id for one ask in a project, so re-indexing a turn overwrites it. */
function entryId(projectPath: string, goal: string, savedAt: number): string {
  return `${normalizeProjectPath(projectPath)}#${savedAt}#${goal.slice(0, 48)}`;
}

/**
 * Index one finished ask for later semantic recall. Returns whether an entry was
 * written. Best-effort and NO-OP when recall is off or embeddings are
 * unavailable (a zero vector is never stored — it would only ever be a
 * meaningless match).
 */
export async function indexSessionTurn(
  input: { projectPath: string; goal: string; outcome?: string; savedAt?: number },
  opts: { embedFn?: EmbedFn; force?: boolean; enabled?: boolean } = {},
): Promise<boolean> {
  const on = opts.enabled ?? enabled();
  if ((!opts.force && !on) || !input.goal.trim()) return false;
  const embedFn = opts.embedFn ?? ((t: string) => embed(t));
  let vector: number[];
  try {
    vector = await embedFn(input.goal);
  } catch {
    return false;
  }
  if (isZeroVector(vector)) return false;

  const savedAt = input.savedAt ?? Date.now();
  const entry: RecallEntry = {
    id: entryId(input.projectPath, input.goal, savedAt),
    projectPath: normalizeProjectPath(input.projectPath),
    goal: input.goal.slice(0, 240),
    outcome: (input.outcome ?? 'unknown').slice(0, 24),
    savedAt,
    vector,
  };

  const index = readIndex();
  const entries = [...index.entries.filter((e) => e.id !== entry.id), entry];
  // Oldest-first eviction past the cap.
  if (entries.length > MAX_INDEX_ENTRIES) entries.splice(0, entries.length - MAX_INDEX_ENTRIES);
  return writeIndex({ version: CURRENT_VERSION, entries });
}

// ─── Recall ─────────────────────────────────────────────────────────────────

/**
 * The past asks semantically closest to `query`, above the threshold.
 *
 * `scope: 'project'` (default) limits recall to the current project directory —
 * the same scoping the rest of the continuity stack uses, so a new task is not
 * handed another project's history. `scope: 'all'` searches every project and
 * names each hit's project in the block.
 */
export async function recallPastSessions(
  query: string,
  opts: {
    projectPath?: string;
    scope?: 'project' | 'all';
    topK?: number;
    threshold?: number;
    embedFn?: EmbedFn;
    force?: boolean;
    enabled?: boolean;
  } = {},
): Promise<RecallHit[]> {
  if (!query.trim()) return [];
  const on = opts.enabled ?? enabled();
  if (!opts.force && !on) return [];
  const index = readIndex();
  if (index.entries.length === 0) return [];

  const scope = opts.scope ?? 'project';
  const wanted = opts.projectPath ? normalizeProjectPath(opts.projectPath) : '';
  const candidates =
    scope === 'all' || !wanted ? index.entries : index.entries.filter((e) => e.projectPath === wanted);
  if (candidates.length === 0) return [];

  const embedFn = opts.embedFn ?? ((t: string) => embed(t));
  let queryVector: number[];
  try {
    queryVector = await embedFn(query);
  } catch {
    return [];
  }
  if (isZeroVector(queryVector)) return [];

  const threshold = opts.threshold ?? DEFAULT_RECALL_THRESHOLD;
  const topK = Math.max(1, opts.topK ?? DEFAULT_RECALL_TOP_K);
  const hits: RecallHit[] = [];
  for (const entry of candidates) {
    let similarity: number;
    try {
      similarity = cosineSimilarity(queryVector, entry.vector);
    } catch {
      continue;
    }
    if (!Number.isFinite(similarity) || similarity < threshold) continue;
    hits.push({ entry, similarity });
  }
  hits.sort((a, b) => b.similarity - a.similarity);
  return hits.slice(0, topK);
}

/**
 * Render recall hits as a bounded, model-readable block ('' when there are none).
 *
 * The header is load-bearing: it states that these are PAST asks — history for
 * context only, NOT a status — so a recalled line cannot be read as proof the
 * current work is done. Each hit carries how it ENDED and its project when the
 * recall crossed projects.
 */
export function formatSessionRecall(
  hits: readonly RecallHit[],
  opts: { projectPath?: string; now?: number } = {},
): string {
  if (hits.length === 0) return '';
  const now = opts.now ?? Date.now();
  const projectScoped = opts.projectPath !== undefined;
  const lines: string[] = [
    '[Semantically similar PAST asks — history for context only. This is NOT a status of the current work; verify artifacts on disk before assuming anything is done.]',
  ];
  for (const { entry, similarity } of hits) {
    const age = relativeAge(entry.savedAt, now);
    const where = projectScoped ? '' : ` [${shortenPath(entry.projectPath)}]`;
    lines.push(`• (${Math.round(similarity * 100)}% match)${where} ${age} — ${entry.outcome}: "${entry.goal}"`);
  }
  let block = lines.join('\n');
  if (block.length > MAX_RECALL_BLOCK_CHARS) {
    block = `${block.slice(0, MAX_RECALL_BLOCK_CHARS)}\n[recall truncated to fit the context budget]`;
  }
  return block;
}

function relativeAge(ts: number, now: number): string {
  const mins = Math.max(0, Math.round((now - ts) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function shortenPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || p;
}

/**
 * List every indexed past ask, newest first. Best-effort. The vectors are part of
 * each entry; a caller that only needs a summary maps them away.
 */
export function listRecallEntries(): RecallEntry[] {
  return readIndex().entries.slice().sort((a, b) => b.savedAt - a.savedAt);
}

/** Remove one indexed past ask by id. Returns whether it was present. */
export function removeRecallEntry(id: string): boolean {
  try {
    const index = readIndex();
    const next = index.entries.filter((e) => e.id !== id);
    if (next.length === index.entries.length) return false;
    return writeIndex({ version: CURRENT_VERSION, entries: next });
  } catch {
    return false;
  }
}

/** Remove the recall index (used by `nuvira retrieval clear`-style resets / tests). */
export function clearSessionRecallIndex(): boolean {
  try {
    if (!existsSync(indexPath())) return false;
    rmSync(indexPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}
