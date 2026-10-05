import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { envBuff } from '../config/paths';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { resolveNuviraHome } from '../config/paths.js';

// Resolve lazily (not at module load) and honor NUVIRA_MEMORY_DIR — the same
// convention every other memory file follows (ledger, registry, recall-hits,
// artifact-store). Without this, tests writing through a temp NUVIRA_MEMORY_DIR
// would still read/write the REAL ~/.nuvira/cache.json (cross-run cache hits
// make suites order-dependent), and a hermetic run could never isolate its
// cache. Production path is unchanged when the env var is unset.
function cachePath(): string {
  const memDir = envBuff('MEMORY_DIR');
  if (memDir) return join(memDir, 'cache.json');
  return join(resolveNuviraHome(), 'cache.json');
}

function cacheDir(): string {
  return dirname(cachePath());
}

interface CacheEntry {
  response: string;
  model: string;
  provider: string;
  createdAt: number;
  ttl: number;
  /**
   * The WORKSPACE this answer is about (an absolute directory), or absent for an
   * answer produced with none. Stored as well as hashed into the key so the
   * dashboard can answer "where did this come from?" and clear one project's
   * answers without touching another's.
   */
  scope?: string;
  /**
   * The first ~80 chars of the prompt, for the dashboard's cache list. The key
   * is a one-way hash, so without this the UI could only say "N entries" — a
   * count nobody can act on. Truncated on purpose: the list exists to identify an
   * entry, not to keep a second copy of the conversation.
   */
  promptPreview?: string;
  /**
   * #30 — the turn's ACTIVITY, stored with the answer so a replay can report
   * what the original turn actually did. Without this, a repeated prompt on the
   * dashboard rendered no tool cards (the cards were part of the dropped
   * metadata, not the text), so a replayed turn read as a turn that did nothing.
   *
   * Deliberately NOT the honesty FLAGS: a turn that carries one is never cached
   * at all (see `ChatCacheFacts` and the write guard in `cli/chat.ts`), so there
   * is no entry that could replay an unverified claim as clean.
   */
  toolCalls?: string[];
  successfulToolCalls?: string[];
  bounded?: boolean;
}

/**
 * #30 — the turn facts a caller may store with a cached answer, and read back on
 * a hit. Only NON-flag facts live here on purpose: a flagged turn is not cached,
 * so persisting a flag would be storing a state that can never legitimately be
 * replayed.
 */
export interface ChatCacheFacts {
  toolCalls?: string[];
  successfulToolCalls?: string[];
  bounded?: boolean;
}

/** A cache hit, with the answer plus the activity it recorded. */
export interface CacheHit {
  response: string;
  toolCalls?: string[];
  successfulToolCalls?: string[];
  bounded?: boolean;
}

interface CacheData {
  entries: Record<string, CacheEntry>;
}

/** How many prompt previews a workspace summary carries (newest first). */
const PREVIEW_LIMIT = 80;
const SAMPLE_LIMIT = 5;

/**
 * One workspace's cached answers, as the dashboard lists them.
 *
 * Grouped by DIRECTORY because that is the unit the cache is now scoped to: a
 * stale answer is always "the answers for THIS project are out of date", never
 * "the cache is out of date", so clearing has to be per project or it cannot be
 * used at all.
 */
export interface CacheWorkspaceSummary {
  /** Absolute directory, or null for answers produced with no workspace. */
  scope: string | null;
  count: number;
  /** Newest / oldest entry, epoch ms. */
  newestAt: number;
  oldestAt: number;
  /** Distinct providers / models represented (sorted). */
  providers: string[];
  models: string[];
  /** A bounded sample of what is cached, newest first. */
  samples: Array<{ prompt: string; model: string; provider: string; at: number }>;
}

function ensureDir(): void {
  if (!existsSync(cacheDir())) {
    mkdirSync(cacheDir(), { recursive: true });
  }
}

function readCache(): CacheData {
  try {
    ensureDir();
    if (!existsSync(cachePath())) {
      return { entries: {} };
    }
    const raw = readFileSync(cachePath(), 'utf-8');
    return JSON.parse(raw) as CacheData;
  } catch {
    return { entries: {} };
  }
}

function writeCache(data: CacheData): void {
  ensureDir();
  writeFileSync(cachePath(), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Remove expired entries from the cache data in-place
 */
function pruneExpired(data: CacheData): void {
  const now = Math.floor(Date.now() / 1000);
  for (const [key, entry] of Object.entries(data.entries)) {
    if (entry.createdAt + entry.ttl < now) {
      delete data.entries[key];
    }
  }
}

/**
 * Generate a cache key from the prompt and options.
 *
 * `scope` is the WORKSPACE the answer belongs to (an absolute directory). It is
 * part of the key because an answer is a statement about a directory: without
 * it, "what's the current status of this project?" asked in project B replayed
 * the answer produced in project A — the same words, a confident report about a
 * tree the user was not looking at. The scope is optional so a caller with no
 * workspace (a pure question) keeps the old, unscoped key.
 */
function generateKey(prompt: string, model: string, provider: string, scope?: string): string {
  const hash = createHash('sha256')
    .update(`${provider}:${model}:${scope ? `${scope}:` : ''}${prompt}`)
    .digest('hex');
  return hash;
}

/**
 * Context cache for inference results.
 * Uses a simple JSON file — no native dependencies, works everywhere.
 */
export class InferenceCache {
  /**
   * Get cached response if available and not expired
   */
  async get(prompt: string, model: string, provider: string, scope?: string): Promise<string | null> {
    const hit = await this.getEntry(prompt, model, provider, scope);
    return hit ? hit.response : null;
  }

  /**
   * #30 — the same lookup, but returning the turn ACTIVITY stored with the
   * answer (tool calls, bounded) rather than only the text. A surface that
   * replayed a cached answer used to hand back `{ content }` alone, so a repeated
   * prompt rendered no tool cards while the first run did. `get()` is kept as the
   * string-returning convenience for callers that only want the text (web
   * research), so no existing call site changes.
   */
  async getEntry(prompt: string, model: string, provider: string, scope?: string): Promise<CacheHit | null> {
    const data = readCache();
    const key = generateKey(prompt, model, provider, scope);
    const entry = data.entries[key];

    if (!entry) return null;

    const now = Math.floor(Date.now() / 1000);
    if (entry.createdAt + entry.ttl < now) {
      // Expired — remove it
      delete data.entries[key];
      writeCache(data);
      return null;
    }

    return {
      response: entry.response,
      ...(entry.toolCalls ? { toolCalls: entry.toolCalls } : {}),
      ...(entry.successfulToolCalls ? { successfulToolCalls: entry.successfulToolCalls } : {}),
      ...(entry.bounded ? { bounded: entry.bounded } : {}),
    };
  }

  /**
   * Store a response in the cache
   *
   * `facts` (#30) records the turn ACTIVITY on the entry so a replay can report
   * it. Callers must NOT cache a turn that carries an honesty flag — that guard
   * lives at the call site because only the caller sees the turn's flags (see
   * `cli/chat.ts`).
   */
  async set(
    prompt: string,
    response: string,
    model: string,
    provider: string,
    ttl: number = 3600,
    /** The workspace this answer is about (see generateKey). */
    scope?: string,
    /** #30 — the turn activity to persist alongside the answer. */
    facts?: ChatCacheFacts
  ): Promise<void> {
    const data = readCache();
    pruneExpired(data); // Clean up expired entries before writing
    const key = generateKey(prompt, model, provider, scope);

    data.entries[key] = {
      response,
      model,
      provider,
      createdAt: Math.floor(Date.now() / 1000),
      ttl,
      ...(scope ? { scope } : {}),
      ...(prompt ? { promptPreview: prompt.slice(0, PREVIEW_LIMIT) } : {}),
      ...(facts?.toolCalls && facts.toolCalls.length > 0 ? { toolCalls: facts.toolCalls } : {}),
      ...(facts?.successfulToolCalls && facts.successfulToolCalls.length > 0
        ? { successfulToolCalls: facts.successfulToolCalls }
        : {}),
      ...(facts?.bounded ? { bounded: true } : {}),
    };

    writeCache(data);
  }

  /**
   * Every workspace with cached answers, largest first.
   *
   * Expired entries are pruned (and the prune persisted) before grouping, so the
   * list can never offer to clear answers that would already miss.
   */
  async listByWorkspace(): Promise<CacheWorkspaceSummary[]> {
    const data = readCache();
    const before = Object.keys(data.entries).length;
    pruneExpired(data);
    if (Object.keys(data.entries).length !== before) writeCache(data);

    const byScope = new Map<string | null, CacheEntry[]>();
    for (const entry of Object.values(data.entries)) {
      const key = typeof entry.scope === 'string' && entry.scope ? entry.scope : null;
      const list = byScope.get(key);
      if (list) list.push(entry);
      else byScope.set(key, [entry]);
    }

    const summaries: CacheWorkspaceSummary[] = [];
    for (const [scope, entries] of byScope) {
      const sorted = [...entries].sort((a, b) => b.createdAt - a.createdAt);
      summaries.push({
        scope,
        count: entries.length,
        newestAt: (sorted[0]?.createdAt ?? 0) * 1000,
        oldestAt: (sorted[sorted.length - 1]?.createdAt ?? 0) * 1000,
        providers: [...new Set(entries.map((e) => e.provider))].sort(),
        models: [...new Set(entries.map((e) => e.model))].sort(),
        samples: sorted.slice(0, SAMPLE_LIMIT).map((e) => ({
          prompt: e.promptPreview ?? '(prompt not recorded)',
          model: e.model,
          provider: e.provider,
          at: e.createdAt * 1000,
        })),
      });
    }

    // Largest bucket first, then newest — the order an operator scans in.
    return summaries.sort((a, b) => b.count - a.count || b.newestAt - a.newestAt);
  }

  /**
   * Remove one workspace's cached answers. Returns how many entries went.
   *
   * `null` targets the answers produced with NO workspace — the entries that
   * predate scoping, and the ones most likely to be the stale report that
   * started this. Exact-match on the scope string: a parent directory is a
   * different workspace, so clearing `/repo` never clears `/repo/sub`.
   */
  async clearWorkspace(scope: string | null): Promise<number> {
    const data = readCache();
    let removed = 0;
    for (const [key, entry] of Object.entries(data.entries)) {
      const entryScope = typeof entry.scope === 'string' && entry.scope ? entry.scope : null;
      if (entryScope === scope) {
        delete data.entries[key];
        removed += 1;
      }
    }
    if (removed > 0) writeCache(data);
    return removed;
  }

  /**
   * Clear all cache entries
   */
  async clear(): Promise<void> {
    writeCache({ entries: {} });
  }

  /**
   * Get cache statistics
   */
  async stats(): Promise<{ total: number; providers: Record<string, number> }> {
    const data = readCache();
    pruneExpired(data);

    const total = Object.keys(data.entries).length;
    const providers: Record<string, number> = {};

    for (const entry of Object.values(data.entries)) {
      providers[entry.provider] = (providers[entry.provider] || 0) + 1;
    }

    return { total, providers };
  }
}

// Singleton instance
let cacheInstance: InferenceCache | null = null;

export function getCache(): InferenceCache {
  if (!cacheInstance) {
    cacheInstance = new InferenceCache();
  }
  return cacheInstance;
}
