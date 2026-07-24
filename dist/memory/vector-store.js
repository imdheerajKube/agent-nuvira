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
// ─── Constants ──────────────────────────────────────────────────────────────
const MEMORY_DIR = join(homedir(), '.buff', 'memory');
const INDEX_PATH = join(MEMORY_DIR, 'vectors.json');
/**
 * Schema version for the vector index.
 * Version 2: Increased embedding dimensionality from 64 to 384 (all-MiniLM-L6-v2).
 * Old version 1 entries (64-dim) are incompatible and will be cleared.
 */
const CURRENT_VERSION = 2;
// ─── Helpers ────────────────────────────────────────────────────────────────
function ensureDir() {
    if (!existsSync(MEMORY_DIR)) {
        mkdirSync(MEMORY_DIR, { recursive: true });
    }
}
function readIndex() {
    try {
        ensureDir();
        if (!existsSync(INDEX_PATH)) {
            return { entries: {}, version: CURRENT_VERSION };
        }
        const raw = readFileSync(INDEX_PATH, 'utf-8');
        const data = JSON.parse(raw);
        // Version migration: if the on-disk version doesn't match the current
        // schema version, clear old entries to prevent incompatible vectors
        // (e.g., 64-dim → 384-dim migration) from returning similarity=0 silently.
        if (data.version !== CURRENT_VERSION) {
            return { entries: {}, version: CURRENT_VERSION };
        }
        return data;
    }
    catch {
        return { entries: {}, version: CURRENT_VERSION };
    }
}
function writeIndex(data) {
    ensureDir();
    writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2), 'utf-8');
}
// ─── Vector Math ────────────────────────────────────────────────────────────
/** Compute the dot product of two vectors */
function dotProduct(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += a[i] * b[i];
    }
    return sum;
}
/** Compute the L2 norm (magnitude) of a vector */
function magnitude(v) {
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
export function cosineSimilarity(a, b) {
    if (a.length !== b.length)
        return 0;
    const dot = dotProduct(a, b);
    const magA = magnitude(a);
    const magB = magnitude(b);
    if (magA === 0 || magB === 0)
        return 0;
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
    /**
     * Insert a vector entry into the index.
     * If an entry with the same `id` already exists, it is overwritten.
     */
    async insert(id, vector, metadata = {}) {
        const data = readIndex();
        data.entries[id] = {
            id,
            vector,
            metadata,
            createdAt: Date.now(),
        };
        writeIndex(data);
    }
    /**
     * Retrieve a single entry by ID.
     */
    async get(id) {
        const data = readIndex();
        return data.entries[id] || null;
    }
    /**
     * Remove an entry from the index.
     */
    async delete(id) {
        const data = readIndex();
        if (!data.entries[id])
            return false;
        delete data.entries[id];
        writeIndex(data);
        return true;
    }
    /**
     * Search for the top-k most similar entries to the query vector.
     * Returns results sorted by similarity (highest first).
     */
    async search(queryVector, k = 5, filterFn) {
        const data = readIndex();
        const entries = Object.values(data.entries);
        // Compute similarities
        const scored = [];
        for (const entry of entries) {
            if (filterFn && !filterFn(entry))
                continue;
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
    async count() {
        const data = readIndex();
        return Object.keys(data.entries).length;
    }
    /**
     * Clear all entries from the index.
     */
    async clear() {
        writeIndex({ entries: {}, version: CURRENT_VERSION });
    }
    /**
     * Get all entries (for iteration/export).
     */
    async getAll() {
        const data = readIndex();
        return Object.values(data.entries);
    }
    /**
     * Get vector store statistics.
     */
    stats() {
        const data = readIndex();
        const entries = Object.values(data.entries);
        const dimensions = entries.length > 0 ? entries[0].vector.length : 0;
        return {
            totalEntries: entries.length,
            dimensions,
        };
    }
}
// Singleton instance
let storeInstance = null;
export function getVectorStore() {
    if (!storeInstance) {
        storeInstance = new VectorStore();
    }
    return storeInstance;
}
//# sourceMappingURL=vector-store.js.map