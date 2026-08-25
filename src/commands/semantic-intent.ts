/**
 * Semantic intent matcher — embedding-based recall tier for the intent router.
 *
 * Tier-1 of the 3-tier design (deterministic → semantic → ask_user):
 * the deterministic matcher (src/commands/intent-router.ts) requires the
 * actual words to appear; this tier finds intents by MEANING, so novel
 * phrasings ("terminate the bot", "bounce the UI", "shut down that web thing
 * on 3030") resolve without adding a new alias to the JSON manifest.
 *
 * Design:
 *   - Pure JS + the existing local embedder (`embed()` in src/memory/embedder.ts)
 *     and `cosineSimilarity` — NO FAISS, no native deps, no network at query
 *     time. The alias corpus (~85 intents × a few aliases) is tiny, so a flat
 *     cosine scan over cached alias vectors is sub-ms once the model is loaded.
 *   - Aliases are embedded lazily and cached in-process; the model load
 *     happens once per process (same pattern as src/learning/retrieval.ts).
 *   - Embedding tiers degrade gracefully (Xenova → Python → LLM → zero vector),
 *     so a machine without any embedding backend still returns a ranking
 *     (zero vector ⇒ similarity 0 ⇒ treated as "no semantic signal").
 *
 * This module is deliberately a RECALL tier: it does NOT replace entity
 * extraction, ambiguity handling, or the confirmation/RBAC flags — those stay
 * in the deterministic matcher. The CLI surfaces both side-by-side
 * (`nuvira intent resolve --semantic`) so the semantic tier can be measured
 * against the deterministic one before it ever gates execution.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {envBuff, resolveNuviraHome} from '../config/paths';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { embed } from '../memory/embedder.js';
import { cosineSimilarity } from '../memory/vector-store.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** One manifest intent flattened to its aliases (the embed corpus). */
interface AliasEntry {
  intent: string;
  summary: string;
  command?: string;
  example?: string;
  alias: string;
}

/** A semantic match — one alias whose embedding is closest to the ask. */
export interface SemanticMatch {
  intent: string;
  summary: string;
  command?: string;
  example?: string;
  /** The exact alias that matched (for debugging/audit). */
  matchedAlias: string;
  /** Cosine similarity (1 = identical meaning). */
  similarity: number;
}

/** Options for semanticResolve — tests inject a fake embedFn. */
export interface SemanticResolveOptions {
  /** Max matches to return (default 3). */
  topK?: number;
  /** Cosine floor below which matches are dropped (default 0.30). */
  minSimilarity?: number;
  /** Embedding function override (tests inject a deterministic stub). */
  embedFn?: (text: string) => Promise<number[]>;
  /** Embedding model override (defaults to the embedder's own default). */
  model?: string;
}

// ─── Manifest loading (same source as the deterministic router) ─────────────

/** Load the manifest path relative to this module (works in src/ and dist/). */
function manifestPath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, '..', 'resources', 'command-manifest.json');
}

let aliasCorpus: AliasEntry[] | null = null;

/** Flatten manifest intents into per-alias entries (lazy, once per process). */
function loadAliasCorpus(): AliasEntry[] {
  if (aliasCorpus) return aliasCorpus;
  const raw = readFileSync(manifestPath(), 'utf8');
  const parsed = JSON.parse(raw) as { intents: Array<{ intent: string; summary: string; command?: string; example?: string; aliases?: string[] }> };
  const out: AliasEntry[] = [];
  for (const intent of parsed.intents ?? []) {
    for (const alias of intent.aliases ?? []) {
      out.push({
        intent: intent.intent,
        summary: intent.summary,
        command: intent.command,
        example: intent.example,
        alias,
      });
    }
  }
  aliasCorpus = out;
  return out;
}

// ─── Embedding cache ────────────────────────────────────────────────────────

const vectorCache = new Map<string, number[]>();

/** Embed text via the injectable/cached path (per-process alias cache). */
async function vectorFor(
  text: string,
  embedFn: (t: string) => Promise<number[]>,
  model?: string,
): Promise<number[]> {
  const key = `${model ?? ''}:${text.toLowerCase().trim()}`;
  const cached = vectorCache.get(key);
  if (cached) return cached;
  const v = await embedFn(text);
  vectorCache.set(key, v);
  return v;
}

// ─── Persisted alias-vector cache ───────────────────────────────────────────

/**
 * The alias corpus is ~400 entries; embedding ALL of them costs ~30-40s per
 * fresh process (the model load is fast, the per-alias forward passes are
 * not). To keep `nuvira intent resolve --semantic` fast on every invocation we
 * precompute alias vectors ONCE and persist them as JSON (the same
 * JSON-file philosophy as the VectorStore — no FAISS, no native deps), then
 * only embed the ASK at resolve time.
 *
 * Keyed by a hash of the manifest content so the cache invalidates exactly
 * when aliases change. Persisted to `~/.nuvira/memory/intent-alias-vectors.json`
 * (honors NUVIRA_MEMORY_DIR for hermetic tests).
 */

function memoryDir(): string {
  return envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
}

function aliasVectorsPath(): string {
  return join(memoryDir(), 'intent-alias-vectors.json');
}

/** SHA-256 of the manifest JSON — the cache key. */
function manifestHash(): string {
  const raw = readFileSync(manifestPath(), 'utf8');
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

interface AliasVectorsFile {
  version: number;
  manifestHash: string;
  /** alias (lowercased) → vector */
  vectors: Record<string, number[]>;
  /** model used (so switching models invalidates). */
  model: string;
}

let persistedVectors: Record<string, number[]> | null = null;
let persistedModel = '';
let persistedHash = '';

/** Load persisted alias vectors if the manifest hash matches. */
function loadPersistedVectors(model?: string): Record<string, number[]> | null {
  const modelKey = model || '';
  if (persistedVectors && persistedModel === modelKey && persistedHash === manifestHash()) {
    return persistedVectors;
  }
  try {
    const raw = readFileSync(aliasVectorsPath(), 'utf8');
    const parsed = JSON.parse(raw) as AliasVectorsFile;
    if (parsed.manifestHash === manifestHash() && parsed.model === modelKey && parsed.version === 1) {
      persistedVectors = parsed.vectors;
      persistedModel = modelKey;
      persistedHash = parsed.manifestHash;
      return persistedVectors;
    }
  } catch {
    /* no cache yet */
  }
  return null;
}

/** Persist alias vectors (best-effort — never breaks resolve). */
function savePersistedVectors(vectors: Record<string, number[]>, model?: string): void {
  try {
    const dir = memoryDir();
    mkdirSync(dir, { recursive: true });
    const payload: AliasVectorsFile = {
      version: 1,
      manifestHash: manifestHash(),
      vectors,
      model: model || '',
    };
    writeFileSync(aliasVectorsPath(), JSON.stringify(payload), 'utf8');
  } catch {
    /* best-effort */
  }
}

/**
 * Vectors for every alias, from the persisted cache or freshly embedded.
 * Returns { byAlias, source } where source is 'cache' | 'fresh'.
 */
async function aliasVectors(
  corpus: AliasEntry[],
  embedFn: (t: string) => Promise<number[]>,
  model?: string,
): Promise<{ byAlias: Record<string, number[]>; source: 'cache' | 'fresh' }> {
  const cached = loadPersistedVectors(model);
  if (cached) {
    // Rehydrate the in-process cache for the ask embedding later.
    for (const [k, v] of Object.entries(cached)) vectorCache.set(`${model ?? ''}:${k}`, v);
    return { byAlias: cached, source: 'cache' };
  }

  const byAlias: Record<string, number[]> = {};
  for (const entry of corpus) {
    const key = entry.alias.toLowerCase().trim();
    byAlias[key] = await vectorFor(entry.alias, embedFn, model);
  }
  savePersistedVectors(byAlias, model);
  return { byAlias, source: 'fresh' };
}

// ─── The matcher ────────────────────────────────────────────────────────────

/**
 * Rank manifest intents by embedding similarity to the ask.
 *
 * Pure JS flat cosine over the alias corpus — appropriate because the corpus
 * is small (hundreds of entries). Returns top-K matches above the floor,
 * best-first. Never throws: an empty result just means "no semantic signal".
 */
export async function semanticResolve(
  ask: string,
  opts: SemanticResolveOptions = {},
): Promise<SemanticMatch[]> {
  const { topK = 3, minSimilarity = 0.3, embedFn = embed, model } = opts;
  const corpus = loadAliasCorpus();

  // Alias vectors come from the persisted JSON cache (fast path) or are
  // freshly embedded once and saved. Only the ASK is embedded per call.
  const { byAlias } = await aliasVectors(corpus, embedFn, model);
  const queryVector = await vectorFor(ask, embedFn, model);

  const scored: SemanticMatch[] = [];
  for (const entry of corpus) {
    const aliasVector = byAlias[entry.alias.toLowerCase().trim()];
    if (!aliasVector) continue;
    scored.push({
      intent: entry.intent,
      summary: entry.summary,
      command: entry.command,
      example: entry.example,
      matchedAlias: entry.alias,
      similarity: cosineSimilarity(queryVector, aliasVector),
    });
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored
    .filter((m) => m.similarity >= minSimilarity)
    .slice(0, topK);
}

/** Testing + diagnostics: how many aliases are in the corpus. */
export function aliasCorpusSize(): number {
  return loadAliasCorpus().length;
}
