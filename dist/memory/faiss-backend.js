/**
 * FaissBackend — FAISS-style vector search for Agent-Nuvira.
 *
 * Two tiers, both behind the same `VectorStoreBackend` interface:
 *
 *   Tier 1 — native FAISS (`@faiss-node/native`, best-effort)
 *     Real Facebook FAISS bindings (IndexFlatIP). Only activated when the
 *     package is installed AND its native module built successfully; a smoke
 *     test at load time verifies usability. Every method is defensive and
 *     falls back to the pure-JS tier on any native error, so semantic search
 *     never breaks.
 *
 *   Tier 2 — pure-JS IVF-flat ANN (`FaissIvfBackend`, DEFAULT)
 *     A faithful TypeScript implementation of FAISS's `IndexIVFFlat`
 *     algorithm: nlist inverted lists with k-means++ centroids, nprobe probe
 *     lists per query, and cosine similarity computed as the inner product of
 *     L2-normalized vectors (the IndexFlatIP convention). Small indexes
 *     (≤ exactThreshold) use an exact scan so results are IDENTICAL to the
 *     JSON backend; large indexes get approximate sub-linear search.
 *
 * Persistence is the SHARED `vectors-<namespace>.json` entry format (same as
 * JsonBackend), so switching backends never loses data and existing vectors
 * survive upgrades.
 *
 * Why native FAISS is NOT a hard dependency (decision, documented):
 *   @faiss-node/native ships no prebuilt binaries and requires compiling
 *   FAISS from source (cmake + OpenBLAS + libomp) at install time — verified
 *   to fail on a stock macOS dev box. Making it a required dependency would
 *   break zero-setup `npx agent-nuvira` on most machines. The pure-JS
 *   IVF-flat backend provides FAISS-style approximate-NN behavior with zero
 *   native deps; users who install+build the native package automatically get
 *   the real thing.
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { join } from 'node:path';
import { cosineSimilarity, indexPathFor, readNamespaceEntries } from './vector-store.js';
// ─── Constants ──────────────────────────────────────────────────────────────
/** Resolve the memory dir lazily so test hermeticity via NUVIRA_MEMORY_DIR works. */
function memoryDir() {
    return envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
}
/** Default number of inverted lists (centroids) for IVF-flat. */
export const DEFAULT_NLIST = 16;
/** Default lists probed per query. */
export const DEFAULT_NPROBE = 4;
/**
 * Indexes at or below this many entries use an EXACT scan, guaranteeing
 * results identical to the JSON backend (small corpora — the common case for
 * a CLI — stay lossless; only large indexes go approximate).
 */
export const DEFAULT_EXACT_THRESHOLD = 512;
// ─── Vector math helpers ────────────────────────────────────────────────────
/** L2-normalize a vector in place of a copy. */
function normalize(v) {
    let sum = 0;
    for (const x of v)
        sum += x * x;
    const norm = Math.sqrt(sum);
    if (norm === 0)
        return v;
    return v.map((x) => x / norm);
}
/** Squared Euclidean distance. */
function distSq(a, b) {
    let d = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const diff = a[i] - b[i];
        d += diff * diff;
    }
    return d;
}
/** Deterministic PRNG (mulberry32) so k-means++ seeding is reproducible. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/**
 * k-means++ clustering with deterministic seeding + Lloyd iterations.
 * Returns k centroids (not normalized — callers normalize as needed).
 */
function kMeansPlusPlus(points, k, rand, iterations = 6) {
    if (points.length === 0)
        return [];
    const kk = Math.max(1, Math.min(k, points.length));
    if (points.length === 1)
        return [points[0].slice()];
    // k-means++ seeding
    const centroids = [points[Math.floor(rand() * points.length)].slice()];
    while (centroids.length < kk) {
        const dists = points.map((p) => {
            let best = Infinity;
            for (const c of centroids) {
                const d = distSq(p, c);
                if (d < best)
                    best = d;
            }
            return best;
        });
        let total = 0;
        for (const d of dists)
            total += d;
        if (total === 0) {
            centroids.push(points[Math.floor(rand() * points.length)].slice());
            continue;
        }
        let r = rand() * total;
        let chosen = points.length - 1;
        for (let i = 0; i < dists.length; i++) {
            r -= dists[i];
            if (r <= 0) {
                chosen = i;
                break;
            }
        }
        centroids.push(points[chosen].slice());
    }
    // Lloyd iterations
    const dim = points[0].length;
    for (let iter = 0; iter < iterations; iter++) {
        const sums = centroids.map(() => new Array(dim).fill(0));
        const counts = new Array(kk).fill(0);
        for (const p of points) {
            let bestC = 0;
            let bestD = Infinity;
            for (let i = 0; i < centroids.length; i++) {
                const d = distSq(p, centroids[i]);
                if (d < bestD) {
                    bestD = d;
                    bestC = i;
                }
            }
            for (let d = 0; d < dim; d++)
                sums[bestC][d] += p[d];
            counts[bestC]++;
        }
        for (let i = 0; i < kk; i++) {
            if (counts[i] === 0)
                continue;
            for (let d = 0; d < dim; d++)
                centroids[i][d] = sums[i][d] / counts[i];
        }
    }
    return centroids;
}
// ─── Pure-JS IVF-flat backend ───────────────────────────────────────────────
/**
 * FAISS `IndexIVFFlat` reimplemented in pure TypeScript.
 *
 * Structure: nlist centroids (k-means++) partition entries into inverted
 * lists. A query normalizes, ranks centroids by inner product, probes the
 * top-nprobe lists, and scores candidates by cosine similarity. Filter-aware:
 * if the filter leaves fewer than k candidates, nprobe expands up to nlist
 * (guaranteeing the same results as exact search when the filter is sparse).
 */
export class FaissIvfBackend {
    name = 'faiss-ivf';
    namespace;
    nlist;
    nprobe;
    exactThreshold;
    seed;
    /** Lazy-loaded entries (source of truth is the shared JSON file). */
    entries = null;
    /** True when the in-memory IVF index must be rebuilt from entries. */
    dirty = true;
    /** Normalized centroids (nlist × dim). */
    centroids = [];
    /** Inverted lists: centroid index → entry ids. */
    lists = new Map();
    /** Entry ids with zero vectors (cannot be assigned to a centroid). */
    unassigned = [];
    dim = 0;
    constructor(namespace = 'default', opts = {}) {
        this.namespace = namespace;
        this.nlist = opts.nlist ?? DEFAULT_NLIST;
        this.nprobe = opts.nprobe ?? DEFAULT_NPROBE;
        this.exactThreshold = opts.exactThreshold ?? DEFAULT_EXACT_THRESHOLD;
        this.seed = opts.seed ?? 42;
    }
    /** Resolve the index path per operation so `NUVIRA_MEMORY_DIR` changes (tests) take effect. */
    get indexPath() {
        return indexPathFor(this.namespace);
    }
    // ── Persistence (shared JSON entry format) ────────────────────────────
    ensureLoaded() {
        if (this.entries)
            return;
        this.entries = new Map(Object.entries(readNamespaceEntries(this.namespace)));
        if (this.entries.size > 0) {
            const first = [...this.entries.values()][0];
            this.dim = first.vector.length;
        }
        this.dirty = true;
    }
    persist() {
        ensureDir();
        const obj = {};
        for (const [id, e] of this.entries ?? [])
            obj[id] = e;
        writeFileSync(this.indexPath, JSON.stringify({ entries: obj, version: 2 }, null, 2), 'utf-8');
    }
    // ── Index build (lazy, deterministic) ─────────────────────────────────
    rebuildIndex() {
        this.ensureLoaded();
        const vectors = [];
        this.unassigned = [];
        for (const e of this.entries.values()) {
            if (e.vector.length === 0 || e.vector.every((x) => x === 0)) {
                this.unassigned.push(e.id);
                continue;
            }
            vectors.push({ id: e.id, vector: e.vector });
            if (this.dim === 0)
                this.dim = e.vector.length;
        }
        if (vectors.length === 0) {
            this.centroids = [];
            this.lists.clear();
            this.dirty = false;
            return;
        }
        const k = Math.max(1, Math.min(this.nlist, vectors.length));
        const rawCentroids = kMeansPlusPlus(vectors.map((v) => v.vector), k, mulberry32(this.seed));
        this.centroids = rawCentroids.map((c) => normalize(c));
        this.lists.clear();
        for (let i = 0; i < k; i++)
            this.lists.set(i, []);
        for (const { id, vector } of vectors) {
            const ci = this.nearestCentroid(vector);
            this.lists.get(ci).push(id);
        }
        this.dirty = false;
    }
    /** Index of the centroid nearest to `vector` (by cosine / normalized IP). */
    nearestCentroid(vector) {
        const nv = normalize(vector);
        let best = 0;
        let bestScore = -Infinity;
        for (let i = 0; i < this.centroids.length; i++) {
            const s = dot(nv, this.centroids[i]);
            if (s > bestScore) {
                bestScore = s;
                best = i;
            }
        }
        return best;
    }
    // ── VectorStoreBackend implementation ─────────────────────────────────
    async insert(id, vector, metadata = {}) {
        this.ensureLoaded();
        this.entries.set(id, { id, vector, metadata, createdAt: Date.now() });
        if (this.dim === 0 && vector.length > 0)
            this.dim = vector.length;
        this.dirty = true;
        this.persist();
    }
    async get(id) {
        this.ensureLoaded();
        return this.entries.get(id) ?? null;
    }
    async delete(id) {
        this.ensureLoaded();
        const existed = this.entries.delete(id);
        if (existed) {
            this.dirty = true;
            this.persist();
        }
        return existed;
    }
    async search(queryVector, k = 5, filterFn) {
        this.ensureLoaded();
        if (this.entries.size === 0)
            return [];
        // Small index → exact scan (identical results to the JSON backend).
        if (this.entries.size <= this.exactThreshold) {
            return this.exactSearch(queryVector, k, filterFn);
        }
        if (this.dirty)
            this.rebuildIndex();
        return this.ivfSearch(queryVector, k, filterFn);
    }
    /** Exact linear scan with cosine similarity (parity with JsonBackend). */
    exactSearch(queryVector, k, filterFn) {
        const scored = [];
        for (const entry of this.entries.values()) {
            if (filterFn && !filterFn(entry))
                continue;
            scored.push({ entry, similarity: cosineSimilarity(queryVector, entry.vector) });
        }
        scored.sort((a, b) => b.similarity - a.similarity);
        return scored.slice(0, k);
    }
    /** IVF-flat approximate search with filter-aware probe expansion. */
    ivfSearch(queryVector, k, filterFn) {
        const q = normalize(queryVector);
        // Rank centroids by inner product with the query.
        const ranked = this.centroids
            .map((c, i) => ({ i, score: dot(q, c) }))
            .sort((a, b) => b.score - a.score);
        const results = [];
        const seen = new Set();
        let probe = Math.max(1, Math.min(this.nprobe, this.centroids.length));
        // Probe top-nprobe lists; expand if the filter leaves gaps.
        while (results.length < k && probe <= this.centroids.length) {
            for (let p = 0; p < probe; p++) {
                const list = this.lists.get(ranked[p]?.i ?? p);
                if (!list)
                    continue;
                for (const id of list) {
                    if (seen.has(id))
                        continue;
                    seen.add(id);
                    const entry = this.entries.get(id);
                    if (!entry)
                        continue;
                    if (filterFn && !filterFn(entry))
                        continue;
                    results.push({ entry, similarity: cosineSimilarity(queryVector, entry.vector) });
                }
            }
            if (results.length >= k || probe >= this.centroids.length)
                break;
            probe = Math.min(this.centroids.length, probe * 2);
        }
        // Zero-vector entries can't be assigned to a list; scan them last so they
        // still appear (at similarity 0) when the index is under-filled.
        if (results.length < k) {
            for (const id of this.unassigned) {
                if (seen.has(id))
                    continue;
                const entry = this.entries.get(id);
                if (!entry)
                    continue;
                if (filterFn && !filterFn(entry))
                    continue;
                results.push({ entry, similarity: 0 });
                seen.add(id);
                if (results.length >= k)
                    break;
            }
        }
        results.sort((a, b) => b.similarity - a.similarity);
        return results.slice(0, k);
    }
    async count() {
        this.ensureLoaded();
        return this.entries.size;
    }
    async clear() {
        this.entries = new Map();
        this.centroids = [];
        this.lists.clear();
        this.unassigned = [];
        this.dirty = true;
        this.dim = 0;
        ensureDir();
        writeFileSync(this.indexPath, JSON.stringify({ entries: {}, version: 2 }, null, 2), 'utf-8');
    }
    async getAll() {
        this.ensureLoaded();
        return [...this.entries.values()];
    }
    stats() {
        const entries = Object.values(readNamespaceEntries(this.namespace));
        const dimensions = entries.length > 0 ? entries[0].vector.length : 0;
        return { totalEntries: entries.length, dimensions };
    }
}
// ─── Native FAISS tier (best-effort, activated only when buildable) ─────────
/**
 * Wrap real FAISS bindings (IndexFlatIP) behind the same backend interface.
 * Native failures are caught per method and fall back to the pure-JS IVF
 * backend, so a broken native build can never break semantic search.
 */
export class NativeFaissBackend {
    name = 'faiss-native';
    namespace;
    fallback;
    faiss;
    nativeIndex = null;
    idToNative = new Map();
    nativeToId = new Map();
    nextId = 0;
    constructor(namespace, faissModule) {
        this.namespace = namespace;
        this.fallback = new FaissIvfBackend(namespace);
        this.faiss = faissModule;
    }
    /**
     * Rebuild the native FLAT_IP index from the shared entries file.
     *
     * `@faiss-node/native` v0.1.11 exposes a `FaissIndex` class configured with
     * `{ type: 'FLAT_IP', dims }` (NOT the raw `IndexFlatIP`). Vectors are
     * L2-normalized before add, so FAISS's inner-product distance equals cosine
     * similarity (higher = more similar).
     */
    async rebuildNative() {
        this.disposeNative();
        const entries = Object.values(readNamespaceEntries(this.namespace));
        const dim = entries.length > 0 ? entries[0].vector.length : 0;
        if (dim === 0)
            return;
        this.nativeIndex = new this.faiss.FaissIndex({ type: 'FLAT_IP', dims: dim });
        this.idToNative.clear();
        this.nativeToId.clear();
        this.nextId = 0;
        const matrix = [];
        const nativeIds = [];
        for (const e of entries) {
            const nid = this.nextId++;
            this.idToNative.set(e.id, nid);
            this.nativeToId.set(nid, e.id);
            // Guard the pad length (Math.max(0,...)) — a longer-than-dim vector must
            // never build a negative-length array.
            const v = e.vector.length === dim
                ? e.vector
                : e.vector.concat(new Array(Math.max(0, dim - e.vector.length)).fill(0));
            matrix.push(...normalize(v));
            nativeIds.push(nid);
        }
        await this.nativeIndex.add(new Float32Array(matrix), new Int32Array(nativeIds));
    }
    /** Dispose the native index (frees C++ memory); safe when null. */
    disposeNative() {
        if (this.nativeIndex) {
            try {
                this.nativeIndex.dispose();
            }
            catch {
                // best-effort
            }
            this.nativeIndex = null;
        }
    }
    async insert(id, vector, metadata = {}) {
        try {
            await this.fallback.insert(id, vector, metadata);
            await this.rebuildNative();
        }
        catch {
            // Persistence already handled by fallback; index rebuild is best-effort.
        }
    }
    async get(id) {
        return this.fallback.get(id);
    }
    async delete(id) {
        const ok = await this.fallback.delete(id);
        if (ok) {
            try {
                await this.rebuildNative();
            }
            catch {
                // best-effort
            }
        }
        return ok;
    }
    async search(queryVector, k = 5, filterFn) {
        try {
            if (!this.nativeIndex)
                await this.rebuildNative();
            if (!this.nativeIndex)
                return this.fallback.search(queryVector, k, filterFn);
            const q = normalize(queryVector);
            const res = await this.nativeIndex.search(new Float32Array(q), k);
            const labels = Array.from(res?.labels ?? []);
            const distances = Array.from(res?.distances ?? []);
            const out = [];
            for (let i = 0; i < labels.length; i++) {
                const id = this.nativeToId.get(labels[i]);
                if (!id)
                    continue;
                const entry = await this.fallback.get(id);
                if (!entry)
                    continue;
                if (filterFn && !filterFn(entry))
                    continue;
                // FLAT_IP on normalized vectors → distance = cosine similarity.
                out.push({ entry, similarity: distances[i] ?? 0 });
            }
            return out;
        }
        catch {
            // Native failure → pure-JS IVF fallback (never break the search).
            return this.fallback.search(queryVector, k, filterFn);
        }
    }
    async count() {
        return this.fallback.count();
    }
    async clear() {
        this.disposeNative();
        await this.fallback.clear();
        this.idToNative.clear();
        this.nativeToId.clear();
    }
    async getAll() {
        return this.fallback.getAll();
    }
    stats() {
        return this.fallback.stats();
    }
}
/**
 * Check whether native FAISS is actually usable on this machine.
 * Used by `nuvira memory backend --check` for diagnostics.
 */
export async function checkNativeFaiss() {
    try {
        const mod = await loadNativeFaiss();
        if (mod) {
            return {
                available: true,
                reason: 'native @faiss-node/native module is installed, built, and passed the FLAT_IP smoke test',
            };
        }
        return {
            available: false,
            reason: '@faiss-node/native is not installed/built or its smoke test failed — falling back to the pure-JS IVF backend',
        };
    }
    catch (err) {
        return {
            available: false,
            reason: `@faiss-node/native load failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
// ─── Factory ────────────────────────────────────────────────────────────────
let nativeModule = null;
let nativeChecked = false;
/**
 * Load @faiss-node/native once; smoke-test it; null when unusable.
 *
 * v0.1.11 API: `FaissIndex` class with `{ type, dims }` config, async
 * `add(Float32Array, Int32Array?)` / `search(Float32Array, k)` and `dispose()`.
 */
async function loadNativeFaiss() {
    if (nativeChecked)
        return nativeModule;
    nativeChecked = true;
    try {
        const mod = await import('@faiss-node/native');
        // Normalize CJS/ESM interop: an ESM namespace may only expose the exports
        // under `default` (cjs-module-lexer can miss dynamically-built exports).
        const native = mod?.default ?? mod;
        if (!native || typeof native.FaissIndex !== 'function') {
            nativeModule = null;
            return null;
        }
        // Smoke test: build a tiny FLAT_IP index and search it.
        const idx = new native.FaissIndex({ type: 'FLAT_IP', dims: 2 });
        await idx.add(new Float32Array([1, 0]));
        const res = await idx.search(new Float32Array([1, 0]), 1);
        // NOTE: labels is a TYPED ARRAY (Int32Array) — Array.isArray() is false,
        // so check .length on the object (typed arrays have .length).
        const ok = !!res && typeof res.labels !== 'undefined' && res.labels.length > 0;
        idx.dispose();
        if (!ok) {
            nativeModule = null;
            return null;
        }
        nativeModule = native;
        return native;
    }
    catch {
        nativeModule = null;
        return null;
    }
}
/**
 * Create the best available FAISS-style backend for a namespace:
 * native FAISS when installed+buildable, otherwise the pure-JS IVF-flat
 * backend. Never throws — the caller can always fall back to JsonBackend.
 */
export async function createFaissBackend(namespace) {
    try {
        const mod = await loadNativeFaiss();
        if (mod) {
            return new NativeFaissBackend(namespace, mod);
        }
    }
    catch {
        // fall through to pure-JS
    }
    return new FaissIvfBackend(namespace);
}
// ─── Internal helpers ───────────────────────────────────────────────────────
function ensureDir() {
    const dir = memoryDir();
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}
function dot(a, b) {
    let s = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++)
        s += a[i] * b[i];
    return s;
}
//# sourceMappingURL=faiss-backend.js.map