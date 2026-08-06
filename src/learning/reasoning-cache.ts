/**
 * Reasoning-replay cache (Nuvira-Router P4 M4.2).
 *
 * Some reasoning models REQUIRE their prior `reasoning_content` on retry — a
 * strict provider 400s when the conversation omits the reasoning that produced
 * a previous assistant turn. This module caches the LAST reasoning_content per
 * (provider, model, conversation-key) so a retry to the SAME provider can
 * re-inject it instead of failing.
 *
 * Persisted to `~/.buff/memory/reasoning-cache.json` (honors BUFF_MEMORY_DIR)
 * like other registry state, best-effort writes. Keys are FNV-1a fingerprints
 * of the conversation prefix — no raw conversation content is ever persisted.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// ─── Types / constants ──────────────────────────────────────────────────────

export interface ReasoningCacheEntry {
  provider: string;
  model: string;
  /** FNV-1a fingerprint of the conversation prefix that produced the reasoning. */
  conversationKey: string;
  reasoningContent: string;
  timestamp: number;
}

/** Cache bound — reasoning blobs are small, but cap to be safe. */
const MAX_ENTRIES = 64;

/** Per-entry reasoning-content cap (chars) — a long chain must not bloat the file. */
const MAX_REASONING_CHARS = 32_000;

// ─── Storage ────────────────────────────────────────────────────────────────

function memoryDir(): string {
  return process.env.BUFF_MEMORY_DIR || join(homedir(), '.buff', 'memory');
}

function cachePath(): string {
  return join(memoryDir(), 'reasoning-cache.json');
}

function loadEntries(): ReasoningCacheEntry[] {
  try {
    const path = cachePath();
    if (!existsSync(path)) return [];
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { entries?: ReasoningCacheEntry[] };
    if (!Array.isArray(raw?.entries)) return [];
    return raw.entries.filter(
      (e) =>
        typeof e.provider === 'string' &&
        typeof e.model === 'string' &&
        typeof e.conversationKey === 'string' &&
        typeof e.reasoningContent === 'string',
    );
  } catch {
    return [];
  }
}

function saveEntries(entries: ReasoningCacheEntry[]): void {
  try {
    const dir = memoryDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath(), JSON.stringify({ entries }, null, 2), 'utf-8');
  } catch {
    // Best-effort — never break the caller on a cache write failure.
  }
}

// ─── API ────────────────────────────────────────────────────────────────────

/**
 * Stable fingerprint of a conversation prefix (FNV-1a 32-bit, base-36).
 * Identical prefixes → identical keys; no raw content is persisted.
 */
export function buildConversationKey(messages: Array<{ role: string; content: string }>): string {
  let hash = 0x811c9dc5;
  for (const m of messages) {
    const s = `${m.role}:${m.content}`;
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(36);
}

/**
 * Store the last reasoning_content for a (provider, model, conversation).
 * Best-effort; a newer entry for the same triple replaces the older one.
 */
export function cacheReasoning(
  entry: Omit<ReasoningCacheEntry, 'timestamp'>,
): void {
  const entries = loadEntries();
  const rest = entries.filter(
    (e) => !(e.provider === entry.provider && e.model === entry.model && e.conversationKey === entry.conversationKey),
  );
  rest.push({
    ...entry,
    // Cap a single reasoning chain so the cache file stays small (head+tail
    // kept — the beginning frames the chain, the end is the most recent step).
    reasoningContent: entry.reasoningContent.length > MAX_REASONING_CHARS
      ? `${entry.reasoningContent.slice(0, Math.floor(MAX_REASONING_CHARS * 0.3))}\n…[${entry.reasoningContent.length.toLocaleString()} chars truncated]…\n${entry.reasoningContent.slice(-Math.floor(MAX_REASONING_CHARS * 0.7))}`
      : entry.reasoningContent,
    timestamp: Date.now(),
  });
  saveEntries(rest.slice(-MAX_ENTRIES));
}

/**
 * Retrieve the cached reasoning for a (provider, model, conversation), or null.
 */
export function getCachedReasoning(
  provider: string,
  model: string,
  conversationKey: string,
): string | null {
  const entry = loadEntries()
    .filter((e) => e.provider === provider && e.model === model && e.conversationKey === conversationKey)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  return entry?.reasoningContent ?? null;
}

/** Clear the reasoning cache (tests, debugging). */
export function clearReasoningCache(): void {
  saveEntries([]);
}

/** Read the current cache (tests, diagnostics). */
export function readReasoningCache(): ReasoningCacheEntry[] {
  return loadEntries();
}
