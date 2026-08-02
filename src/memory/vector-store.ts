/**
 * VectorStore — A lightweight, JSON-based vector index with cosine similarity search.
 *
 * Stores embeddings as `{ id, vector, metadata }` entries in a single JSON file.
 * No external dependencies — uses only Node.js built-in fs and crypto.
 *
 * File location: ~/.buff/memory/vectors.json
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

// ─── Constants ──────────────────────────────────────────────────────────────

const MEMORY_DIR = process.env.BUFF_MEMORY_DIR || join(homedir(), '.buff', 'memory');

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

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
  }
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

// ─── VectorStore ────────────────────────────────────────────────────────────

/**
 * Lightweight vector store for semantic search.
 *
 * Usage:
 * ```ts
 * const store = new VectorStore();
 * await store.insert("traj-001", [0.1, 0.2, ...], { goal: "add auth" });
 * const results = await store.search([0.15, 0.25, ...], 3);
 * ```
 */
export class VectorStore {
  /** Namespace key — memory vectors use the default; repo retrieval uses 'repo'. */
  private namespace: string;
  /** Index file path for this store's namespace. */
  private indexPath: string;

  /**
   * @param namespace Optional namespace. Each namespace gets its OWN index file
   *   (vectors.json for the default, vectors-<namespace>.json otherwise), so
   *   different vector families (memory/history vs repo retrieval chunks) never
   *   cross-pollinate while sharing the same schema + vector math.
   */
  constructor(namespace: string = 'default') {
    this.namespace = namespace;
    this.indexPath = namespace === 'default'
      ? join(MEMORY_DIR, 'vectors.json')
      : join(MEMORY_DIR, `vectors-${namespace}.json`);
  }

  /**
   * Insert a vector entry into the index.
   * If an entry with the same `id` already exists, it is overwritten.
   */
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

  /**
   * Retrieve a single entry by ID.
   */
  async get(id: string): Promise<VectorEntry | null> {
    const data = readIndex(this.indexPath);
    return data.entries[id] || null;
  }

  /**
   * Remove an entry from the index.
   */
  async delete(id: string): Promise<boolean> {
    const data = readIndex(this.indexPath);
    if (!data.entries[id]) return false;
    delete data.entries[id];
    writeIndex(this.indexPath, data);
    return true;
  }

  /**
   * Search for the top-k most similar entries to the query vector.
   * Returns results sorted by similarity (highest first).
   */
  async search(
    queryVector: number[],
    k: number = 5,
    filterFn?: (entry: VectorEntry) => boolean,
  ): Promise<Array<{ entry: VectorEntry; similarity: number }>> {
    const data = readIndex(this.indexPath);
    const entries = Object.values(data.entries);

    // Compute similarities
    const scored: Array<{ entry: VectorEntry; similarity: number }> = [];
    for (const entry of entries) {
      if (filterFn && !filterFn(entry)) continue;
      const sim = cosineSimilarity(queryVector, entry.vector);
      scored.push({ entry, similarity: sim });
    }

    // Sort by similarity descending, take top-k
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, k);
  }

  /**
   * Get the total number of stored entries.
   */
  async count(): Promise<number> {
    const data = readIndex(this.indexPath);
    return Object.keys(data.entries).length;
  }

  /**
   * Clear all entries from the index.
   */
  async clear(): Promise<void> {
    writeIndex(this.indexPath, { entries: {}, version: CURRENT_VERSION });
  }

  /**
   * Get all entries (for iteration/export).
   */
  async getAll(): Promise<VectorEntry[]> {
    const data = readIndex(this.indexPath);
    return Object.values(data.entries);
  }

  /**
   * Get vector store statistics.
   */
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

// Singleton instances per namespace
const storeInstances = new Map<string, VectorStore>();

export function getVectorStore(namespace: string = 'default'): VectorStore {
  let store = storeInstances.get(namespace);
  if (!store) {
    store = new VectorStore(namespace);
    storeInstances.set(namespace, store);
  }
  return store;
}
