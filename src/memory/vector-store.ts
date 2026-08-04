/**
 * VectorStore — pluggable vector index for semantic search.
 *
 * Stores embeddings as `{ id, vector, metadata }` entries in a JSON file
 * (~/.buff/memory/vectors.json, or vectors-<namespace>.json). No hard native
 * dependencies — uses only Node.js built-in fs and crypto.
 *
 * Backends (selected by `memory.vectorBackend` in config):
 *   - `json`  → JsonBackend: exact flat cosine scan (the original behavior).
 *   - `faiss` → a FAISS-style backend: pure-JS IVF-flat ANN by default
 *               (FaissIvfBackend, see faiss-backend.ts), or the real
 *               `@faiss-node/native` bindings when the user has installed and
 *               built them (best-effort native tier with graceful fallback).
 *   - `auto`  → FAISS-style backend when usable, JSON otherwise (default).
 *
 * The on-disk ENTRY format is identical across backends, so existing
 * memory/history/repo vectors survive upgrades AND backend switches.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single entry in the vector index */
export interface VectorEntry {
  /** Unique identifier for this entry */
  id: string;
  /** The embedding vector (array of numbers) */
  vector: number[];
  /** Arbitrary metadata for filtering/display */
  metadata: Record<string, unknown>;
  /** Timestamp when this entry was created */
  createdAt: number;
}

/** The on-disk format of the vector index */
interface VectorIndexData {
  entries: Record<string, VectorEntry>;
  version: number;
}

/** A search result: entry + cosine similarity (1 = identical). */
export interface SearchResult {
  entry: VectorEntry;
  similarity: number;
}

/** Supported vector-backend identifiers. */
export type VectorBackendType = 'json' | 'faiss' | 'auto';

/** Backend contract — all store implementations share this surface. */
export interface VectorStoreBackend {
  /** Stable backend name for diagnostics (`json` | `faiss-ivf` | `faiss-native`). */
  readonly name: string;
  insert(id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void>;
  get(id: string): Promise<VectorEntry | null>;
  delete(id: string): Promise<boolean>;
  search(
    queryVector: number[],
    k?: number,
    filterFn?: (entry: VectorEntry) => boolean,
  ): Promise<SearchResult[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
  getAll(): Promise<VectorEntry[]>;
  /** Synchronous stats — callers (CLI) read this without awaiting. */
  stats(): { totalEntries: number; dimensions: number };
}

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Resolve the memory dir lazily (per call) so tests that set
 * `BUFF_MEMORY_DIR` in beforeAll are genuinely hermetic — a module-import-
 * time capture would silently keep writing to the real ~/.buff/memory.
 */
function memoryDir(): string {
  return process.env.BUFF_MEMORY_DIR || join(homedir(), '.buff', 'memory');
}

/**
 * Schema version for the vector index.
 * Version 2: 384-dim embeddings (all-MiniLM-L6-v2 / bge-small-en-v1.5).
 *
 * Namespace support does NOT bump the version: each namespace lives in its own
 * file (vectors.json default, vectors-<ns>.json otherwise) and the ENTRY format
 * is unchanged, so existing memory/history vectors survive an upgrade. Only a
 * format change (dim, fields) would warrant a bump.
 */
const CURRENT_VERSION = 2;

// ─── File helpers (shared by every backend) ────────────────────────────────

function ensureDir(): void {
  const dir = memoryDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Resolve the index file path for a namespace (default → vectors.json). */
export function indexPathFor(namespace: string): string {
  const dir = memoryDir();
  return namespace === 'default'
    ? join(dir, 'vectors.json')
    : join(dir, `vectors-${namespace}.json`);
}

function readIndex(indexPath: string): VectorIndexData {
  try {
    ensureDir();
    if (!existsSync(indexPath)) {
      return { entries: {}, version: CURRENT_VERSION };
    }
    const raw = readFileSync(indexPath, 'utf-8');
    const data = JSON.parse(raw) as VectorIndexData;

    // Version migration: if the on-disk version doesn't match the current
    // schema version, clear old entries to prevent incompatible vectors
    // (e.g., 64-dim → 384-dim migration) from returning similarity=0 silently.
    if (data.version !== CURRENT_VERSION) {
      return { entries: {}, version: CURRENT_VERSION };
    }

    return data;
  } catch {
    return { entries: {}, version: CURRENT_VERSION };
  }
}

function writeIndex(indexPath: string, data: VectorIndexData): void {
  ensureDir();
  writeFileSync(indexPath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Synchronously read all entries for a namespace (used by backends' sync
 * `stats()` and by the FAISS-style backend to rebuild its in-memory index).
 * Returns an empty map when the file is missing/corrupt — never throws.
 */
export function readNamespaceEntries(namespace: string): Record<string, VectorEntry> {
  return readIndex(indexPathFor(namespace)).entries;
}

// ─── Vector Math ────────────────────────────────────────────────────────────

/** Compute the dot product of two vectors */
function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/** Compute the L2 norm (magnitude) of a vector */
function magnitude(v: number[]): number {
  let sum = 0;
  for (const val of v) {
    sum += val * val;
  }
  return Math.sqrt(sum);
}

/**
 * Compute cosine similarity between two vectors.
 * Returns a value between -1 and 1 (higher = more similar).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  const dot = dotProduct(a, b);
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

// ─── JsonBackend — exact flat cosine scan (the original behavior) ───────────

/**
 * Exact backend: linear scan with cosine similarity over the namespace index
 * file. This is the historical VectorStore behavior — deterministic, lossless,
 * and used for small indexes where exact search is cheapest.
 */
export class JsonBackend implements VectorStoreBackend {
  readonly name = 'json';
  private namespace: string;

  constructor(namespace: string = 'default') {
    this.namespace = namespace;
  }

  /** Resolve the index path per operation so `BUFF_MEMORY_DIR` changes (tests) take effect. */
  private get indexPath(): string {
    return indexPathFor(this.namespace);
  }

  async insert(id: string, vector: number[], metadata: Record<string, unknown> = {}): Promise<void> {
    const data = readIndex(this.indexPath);
    data.entries[id] = {
      id,
      vector,
      metadata,
      createdAt: Date.now(),
    };
    writeIndex(this.indexPath, data);
  }

  async get(id: string): Promise<VectorEntry | null> {
    const data = readIndex(this.indexPath);
    return data.entries[id] || null;
  }

  async delete(id: string): Promise<boolean> {
    const data = readIndex(this.indexPath);
    if (!data.entries[id]) return false;
    delete data.entries[id];
    writeIndex(this.indexPath, data);
    return true;
  }

  async search(
    queryVector: number[],
    k: number = 5,
    filterFn?: (entry: VectorEntry) => boolean,
  ): Promise<SearchResult[]> {
    const data = readIndex(this.indexPath);
    const entries = Object.values(data.entries);

    const scored: SearchResult[] = [];
    for (const entry of entries) {
      if (filterFn && !filterFn(entry)) continue;
      const sim = cosineSimilarity(queryVector, entry.vector);
      scored.push({ entry, similarity: sim });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, k);
  }

  async count(): Promise<number> {
    const data = readIndex(this.indexPath);
    return Object.keys(data.entries).length;
  }

  async clear(): Promise<void> {
    writeIndex(this.indexPath, { entries: {}, version: CURRENT_VERSION });
  }

  async getAll(): Promise<VectorEntry[]> {
    const data = readIndex(this.indexPath);
    return Object.values(data.entries);
  }

  stats(): { totalEntries: number; dimensions: number } {
    const data = readIndex(this.indexPath);
    const entries = Object.values(data.entries);
    const dimensions = entries.length > 0 ? entries[0].vector.length : 0;
    return {
      totalEntries: entries.length,
      dimensions,
    };
  }
}

// ─── Backend selection ──────────────────────────────────────────────────────

let backendOverride: VectorBackendType | null = null;
let resolvedBackendCache: Record<string, VectorStoreBackend> = {};
let configBackend: VectorBackendType | null = null;
let configBackendLoaded = false;

/**
 * Read `memory.vectorBackend` from ~/.buff/buffconfig.json (lazy, cached).
 * Read directly (not via ConfigManager) to avoid a heavyweight dependency in
 * the hot vector path; env/override still win over config.
 */
function readConfigBackendType(): VectorBackendType | null {
  if (configBackendLoaded) return configBackend;
  configBackendLoaded = true;
  try {
    const configPath = join(homedir(), '.buff', 'buffconfig.json');
    if (!existsSync(configPath)) return null;
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as { memory?: { vectorBackend?: VectorBackendType } };
    const b = raw.memory?.vectorBackend;
    configBackend = b === 'json' || b === 'faiss' ? b : null;
    return configBackend;
  } catch {
    return null;
  }
}

/** Preferred backend from env → test override → config → default 'faiss'.
 *
 * In practice this means the runtime prefers the FAISS-style backend (native
 * when available, otherwise the pure-JS IVF implementation) and only falls
 * back to the exact JSON backend when the FAISS stack is unavailable.
 */
function resolvePreferredBackendType(): VectorBackendType {
  const env = process.env.BUFF_VECTOR_BACKEND as VectorBackendType | undefined;
  if (env === 'json') return 'json';
  if (env === 'faiss' || env === 'auto') return 'faiss';
  if (backendOverride === 'json') return 'json';
  if (backendOverride === 'faiss' || backendOverride === 'auto') return 'faiss';
  const cfg = readConfigBackendType();
  if (cfg) return cfg;
  return 'faiss';
}

/**
 * Resolve (and cache) the backend for a namespace.
 * 'json' → JsonBackend; 'faiss'/'auto' → FAISS-style (native when available,
 * else pure-JS IVF); any native failure falls back to the exact JSON backend
 * so semantic search NEVER breaks.
 */
async function resolveBackend(namespace: string): Promise<VectorStoreBackend> {
  const cached = resolvedBackendCache[namespace];
  if (cached) return cached;

  const preferred = resolvePreferredBackendType();
  let backend: VectorStoreBackend;

  if (preferred === 'json') {
    backend = new JsonBackend(namespace);
  } else {
    try {
      // Dynamic import avoids a hard dependency on the FAISS module.
      const { createFaissBackend } = await import('./faiss-backend.js');
      backend = await createFaissBackend(namespace);
    } catch (err) {
      backend = new JsonBackend(namespace);
    }
  }

  resolvedBackendCache[namespace] = backend;
  return backend;
}

// ─── VectorStore — facade delegating to the selected backend ────────────────

/**
 * Pluggable vector store for semantic search.
 *
 * Usage:
 * ```ts
 * const store = getVectorStore();            // config-selected backend
 * await store.insert("traj-001", [0.1, 0.2], { goal: "add auth" });
 * const results = await store.search([0.15, 0.25], 3);
 * ```
 *
 * Direct construction (`new VectorStore()`) defaults to the exact JSON backend
 * (backward compatible); `getVectorStore()` applies config-driven selection.
 */
export class VectorStore {
  private namespace: string;
  /** Explicit backend (direct construction) — null means resolve via config. */
  private explicitBackend: VectorStoreBackend | null;
  private backendPromise: Promise<VectorStoreBackend> | null = null;

  constructor(namespace: string = 'default', backend?: VectorStoreBackend) {
    this.namespace = namespace;
    this.explicitBackend = backend ?? null;
  }

  /** Lazily resolve the backend once (config-selected when not explicit). */
  private async backend(): Promise<VectorStoreBackend> {
    if (this.explicitBackend) return this.explicitBackend;
    if (!this.backendPromise) {
      this.backendPromise = resolveBackend(this.namespace);
    }
    return this.backendPromise;
  }

  /** Name of the active backend (`json` | `faiss-ivf` | `faiss-native`). */
  async backendName(): Promise<string> {
    return (await this.backend()).name;
  }

  /**
   * Insert a vector entry into the index.
   * If an entry with the same `id` already exists, it is overwritten.
   */
  async insert(id: string, vector: number[], metadata: Record<string, unknown> = {}): Promise<void> {
    const b = await this.backend();
    await b.insert(id, vector, metadata);
  }

  /**
   * Retrieve a single entry by ID.
   */
  async get(id: string): Promise<VectorEntry | null> {
    const b = await this.backend();
    return b.get(id);
  }

  /**
   * Remove an entry from the index.
   */
  async delete(id: string): Promise<boolean> {
    const b = await this.backend();
    return b.delete(id);
  }

  /**
   * Search for the top-k most similar entries to the query vector.
   * Returns results sorted by similarity (highest first).
   */
  async search(
    queryVector: number[],
    k: number = 5,
    filterFn?: (entry: VectorEntry) => boolean,
  ): Promise<SearchResult[]> {
    const b = await this.backend();
    return b.search(queryVector, k, filterFn);
  }

  /**
   * Get the total number of stored entries.
   */
  async count(): Promise<number> {
    const b = await this.backend();
    return b.count();
  }

  /**
   * Clear all entries from the index.
   */
  async clear(): Promise<void> {
    const b = await this.backend();
    await b.clear();
  }

  /**
   * Get all entries (for iteration/export).
   */
  async getAll(): Promise<VectorEntry[]> {
    const b = await this.backend();
    return b.getAll();
  }

  /**
   * Get vector store statistics (SYNCHRONOUS — reads the on-disk index file,
   * identical format across backends, so callers like the CLI can call it
   * without awaiting).
   */
  stats(): { totalEntries: number; dimensions: number } {
    const data = readIndex(indexPathFor(this.namespace));
    const entries = Object.values(data.entries);
    const dimensions = entries.length > 0 ? entries[0].vector.length : 0;
    return {
      totalEntries: entries.length,
      dimensions,
    };
  }
}

// Singleton instances per namespace
const storeInstances = new Map<string, VectorStore>();

export function getVectorStore(namespace: string = 'default', backend?: VectorStoreBackend): VectorStore {
  let store = storeInstances.get(namespace);
  if (!store) {
    store = new VectorStore(namespace, backend);
    storeInstances.set(namespace, store);
  }
  return store;
}

// ─── Test / diagnostics hooks ───────────────────────────────────────────────

/**
 * Force a backend type for tests (`'json' | 'faiss' | 'auto'`).
 * Also honored via the `BUFF_VECTOR_BACKEND` env var.
 */
export function setVectorBackendOverride(type: VectorBackendType | null): void {
  backendOverride = type;
  resolvedBackendCache = {};
}

/** Clear the backend-type override + cached backend instances. */
export function resetVectorBackendSelection(): void {
  backendOverride = null;
  resolvedBackendCache = {};
  storeInstances.clear();
  configBackendLoaded = false;
  configBackend = null;
}


