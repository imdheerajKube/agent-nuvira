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
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { VectorStoreBackend, VectorEntry, SearchResult } from './vector-store.js';
import { cosineSimilarity, indexPathFor, readNamespaceEntries } from './vector-store.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Resolve the memory dir lazily so test hermeticity via BUFF_MEMORY_DIR works. */
function memoryDir(): string {
  return process.env.BUFF_MEMORY_DIR || join(homedir(), '.buff', 'memory');
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

// ─── Types ──────────────────────────────────────────────────────────────────

/** Options for the pure-JS IVF backend. */
export interface FaissIvfOptions {
  /** Number of inverted lists (centroids). Default: 16. */
  nlist?: number;
  /** Lists probed per query. Default: 4. */
  nprobe?: number;
  /** Below this entry count, search exactly. Default: 512. */
  exactThreshold?: number;
  /** Deterministic k-means++ seed (tests rely on reproducibility). */
  seed?: number;
}

// ─── Vector math helpers ────────────────────────────────────────────────────

/** L2-normalize a vector in place of a copy. */
function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

/** Squared Euclidean distance. */
function distSq(a: number[], b: number[]): number {
  let d = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = a[i] - b[i];
    d += diff * diff;
  }
  return d;
}

/** Deterministic PRNG (mulberry32) so k-means++ seeding is reproducible. */
function mulberry32(seed: number): () => number {
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
function kMeansPlusPlus(points: number[][], k: number, rand: () => number, iterations = 6): number[][] {
  if (points.length === 0) return [];
  const kk = Math.max(1, Math.min(k, points.length));
  if (points.length === 1) return [points[0].slice()];

  // k-means++ seeding
  const centroids: number[][] = [points[Math.floor(rand() * points.length)].slice()];
  while (centroids.length < kk) {
    const dists = points.map((p) => {
      let best = Infinity;
      for (const c of centroids) {
        const d = distSq(p, c);
        if (d < best) best = d;
      }
      return best;
    });
    let total = 0;
    for (const d of dists) total += d;
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
      for (let d = 0; d < dim; d++) sums[bestC][d] += p[d];
      counts[bestC]++;
    }
    for (let i = 0; i < kk; i++) {
      if (counts[i] === 0) continue;
      for (let d = 0; d < dim; d++) centroids[i][d] = sums[i][d] / counts[i];
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
export class FaissIvfBackend implements VectorStoreBackend {
  readonly name = 'faiss-ivf';
  private namespace: string;
  private nlist: number;
  private nprobe: number;
  private exactThreshold: number;
  private seed: number;

  /** Lazy-loaded entries (source of truth is the shared JSON file). */
  private entries: Map<string, VectorEntry> | null = null;
  /** True when the in-memory IVF index must be rebuilt from entries. */
  private dirty = true;
  /** Normalized centroids (nlist × dim). */
  private centroids: number[][] = [];
  /** Inverted lists: centroid index → entry ids. */
  private lists = new Map<number, string[]>();
  /** Entry ids with zero vectors (cannot be assigned to a centroid). */
  private unassigned: string[] = [];
  private dim = 0;

  constructor(namespace: string = 'default', opts: FaissIvfOptions = {}) {
    this.namespace = namespace;
    this.nlist = opts.nlist ?? DEFAULT_NLIST;
    this.nprobe = opts.nprobe ?? DEFAULT_NPROBE;
    this.exactThreshold = opts.exactThreshold ?? DEFAULT_EXACT_THRESHOLD;
    this.seed = opts.seed ?? 42;
  }

  /** Resolve the index path per operation so `BUFF_MEMORY_DIR` changes (tests) take effect. */
  private get indexPath(): string {
    return indexPathFor(this.namespace);
  }

  // ── Persistence (shared JSON entry format) ────────────────────────────

  private ensureLoaded(): void {
    if (this.entries) return;
    this.entries = new Map(Object.entries(readNamespaceEntries(this.namespace)));
    if (this.entries.size > 0) {
      const first = [...this.entries.values()][0];
      this.dim = first.vector.length;
    }
    this.dirty = true;
  }

  private persist(): void {
    ensureDir();
    const obj: Record<string, VectorEntry> = {};
    for (const [id, e] of this.entries ?? []) obj[id] = e;
    writeFileSync(this.indexPath, JSON.stringify({ entries: obj, version: 2 }, null, 2), 'utf-8');
  }

  // ── Index build (lazy, deterministic) ─────────────────────────────────

  private rebuildIndex(): void {
    this.ensureLoaded();
    const vectors: Array<{ id: string; vector: number[] }> = [];
    this.unassigned = [];
    for (const e of this.entries!.values()) {
      if (e.vector.length === 0 || e.vector.every((x) => x === 0)) {
        this.unassigned.push(e.id);
        continue;
      }
      vectors.push({ id: e.id, vector: e.vector });
      if (this.dim === 0) this.dim = e.vector.length;
    }

    if (vectors.length === 0) {
      this.centroids = [];
      this.lists.clear();
      this.dirty = false;
      return;
    }

    const k = Math.max(1, Math.min(this.nlist, vectors.length));
    const rawCentroids = kMeansPlusPlus(
      vectors.map((v) => v.vector),
      k,
      mulberry32(this.seed),
    );
    this.centroids = rawCentroids.map((c) => normalize(c));

    this.lists.clear();
    for (let i = 0; i < k; i++) this.lists.set(i, []);
    for (const { id, vector } of vectors) {
      const ci = this.nearestCentroid(vector);
      this.lists.get(ci)!.push(id);
    }
    this.dirty = false;
  }

  /** Index of the centroid nearest to `vector` (by cosine / normalized IP). */
  private nearestCentroid(vector: number[]): number {
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

  async insert(id: string, vector: number[], metadata: Record<string, unknown> = {}): Promise<void> {
    this.ensureLoaded();
    this.entries!.set(id, { id, vector, metadata, createdAt: Date.now() });
    if (this.dim === 0 && vector.length > 0) this.dim = vector.length;
    this.dirty = true;
    this.persist();
  }

  async get(id: string): Promise<VectorEntry | null> {
    this.ensureLoaded();
    return this.entries!.get(id) ?? null;
  }

  async delete(id: string): Promise<boolean> {
    this.ensureLoaded();
    const existed = this.entries!.delete(id);
    if (existed) {
      this.dirty = true;
      this.persist();
    }
    return existed;
  }

  async search(
    queryVector: number[],
    k: number = 5,
    filterFn?: (entry: VectorEntry) => boolean,
  ): Promise<SearchResult[]> {
    this.ensureLoaded();
    if (this.entries!.size === 0) return [];

    // Small index → exact scan (identical results to the JSON backend).
    if (this.entries!.size <= this.exactThreshold) {
      return this.exactSearch(queryVector, k, filterFn);
    }

    if (this.dirty) this.rebuildIndex();
    return this.ivfSearch(queryVector, k, filterFn);
  }

  /** Exact linear scan with cosine similarity (parity with JsonBackend). */
  private exactSearch(
    queryVector: number[],
    k: number,
    filterFn?: (entry: VectorEntry) => boolean,
  ): SearchResult[] {
    const scored: SearchResult[] = [];
    for (const entry of this.entries!.values()) {
      if (filterFn && !filterFn(entry)) continue;
      scored.push({ entry, similarity: cosineSimilarity(queryVector, entry.vector) });
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, k);
  }

  /** IVF-flat approximate search with filter-aware probe expansion. */
  private ivfSearch(
    queryVector: number[],
    k: number,
    filterFn?: (entry: VectorEntry) => boolean,
  ): SearchResult[] {
    const q = normalize(queryVector);

    // Rank centroids by inner product with the query.
    const ranked = this.centroids
      .map((c, i) => ({ i, score: dot(q, c) }))
      .sort((a, b) => b.score - a.score);

    const results: SearchResult[] = [];
    const seen = new Set<string>();
    let probe = Math.max(1, Math.min(this.nprobe, this.centroids.length));

    // Probe top-nprobe lists; expand if the filter leaves gaps.
    while (results.length < k && probe <= this.centroids.length) {
      for (let p = 0; p < probe; p++) {
        const list = this.lists.get(ranked[p]?.i ?? p);
        if (!list) continue;
        for (const id of list) {
          if (seen.has(id)) continue;
          seen.add(id);
          const entry = this.entries!.get(id);
          if (!entry) continue;
          if (filterFn && !filterFn(entry)) continue;
          results.push({ entry, similarity: cosineSimilarity(queryVector, entry.vector) });
        }
      }
      if (results.length >= k || probe >= this.centroids.length) break;
      probe = Math.min(this.centroids.length, probe * 2);
    }

    // Zero-vector entries can't be assigned to a list; scan them last so they
    // still appear (at similarity 0) when the index is under-filled.
    if (results.length < k) {
      for (const id of this.unassigned) {
        if (seen.has(id)) continue;
        const entry = this.entries!.get(id);
        if (!entry) continue;
        if (filterFn && !filterFn(entry)) continue;
        results.push({ entry, similarity: 0 });
        seen.add(id);
        if (results.length >= k) break;
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, k);
  }

  async count(): Promise<number> {
    this.ensureLoaded();
    return this.entries!.size;
  }

  async clear(): Promise<void> {
    this.entries = new Map();
    this.centroids = [];
    this.lists.clear();
    this.unassigned = [];
    this.dirty = true;
    this.dim = 0;
    ensureDir();
    writeFileSync(this.indexPath, JSON.stringify({ entries: {}, version: 2 }, null, 2), 'utf-8');
  }

  async getAll(): Promise<VectorEntry[]> {
    this.ensureLoaded();
    return [...this.entries!.values()];
  }

  stats(): { totalEntries: number; dimensions: number } {
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
export class NativeFaissBackend implements VectorStoreBackend {
  readonly name = 'faiss-native';
  private namespace: string;
  private fallback: FaissIvfBackend;
  private faiss: any;
  private nativeIndex: any = null;
  private idToNative = new Map<string, number>();
  private nativeToId = new Map<number, string>();
  private nextId = 0;

  constructor(namespace: string, faissModule: unknown) {
    this.namespace = namespace;
    this.fallback = new FaissIvfBackend(namespace);
    this.faiss = faissModule as any;
  }

  /** Rebuild the native IndexFlatIP from the shared entries file. */
  private rebuildNative(): void {
    const entries = Object.values(readNamespaceEntries(this.namespace));
    const dim = entries.length > 0 ? entries[0].vector.length : 0;
    if (dim === 0) return;

    this.nativeIndex = new this.faiss.IndexFlatIP(dim);
    this.idToNative.clear();
    this.nativeToId.clear();
    this.nextId = 0;
    const matrix: number[] = [];
    const nativeIds: number[] = [];
    for (const e of entries) {
      const nid = this.nextId++;
      this.idToNative.set(e.id, nid);
      this.nativeToId.set(nid, e.id);
      const v = e.vector.length === dim ? e.vector : e.vector.concat(new Array(dim - e.vector.length).fill(0));
      matrix.push(...v);
      nativeIds.push(nid);
    }
    this.nativeIndex.addWithIds(matrix, nativeIds);
  }

  async insert(id: string, vector: number[], metadata: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.fallback.insert(id, vector, metadata);
      this.rebuildNative();
    } catch {
      // Persistence already handled by fallback; index rebuild is best-effort.
    }
  }

  async get(id: string): Promise<VectorEntry | null> {
    return this.fallback.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const ok = await this.fallback.delete(id);
    if (ok) {
      try {
        this.rebuildNative();
      } catch {
        // best-effort
      }
    }
    return ok;
  }

  async search(
    queryVector: number[],
    k: number = 5,
    filterFn?: (entry: VectorEntry) => boolean,
  ): Promise<SearchResult[]> {
    try {
      if (!this.nativeIndex) this.rebuildNative();
      if (!this.nativeIndex) return this.fallback.search(queryVector, k, filterFn);

      const q = normalize(queryVector);
      const res = this.nativeIndex.search([q], k);
      const labels: number[] = res?.labels?.[0] ?? [];
      const distances: number[] = res?.distances?.[0] ?? [];

      const out: SearchResult[] = [];
      for (let i = 0; i < labels.length; i++) {
        const id = this.nativeToId.get(labels[i]);
        if (!id) continue;
        const entry = await this.fallback.get(id);
        if (!entry) continue;
        if (filterFn && !filterFn(entry)) continue;
        out.push({ entry, similarity: distances[i] ?? 0 });
      }
      return out;
    } catch {
      // Native failure → pure-JS IVF fallback (never break the search).
      return this.fallback.search(queryVector, k, filterFn);
    }
  }

  async count(): Promise<number> {
    return this.fallback.count();
  }

  async clear(): Promise<void> {
    await this.fallback.clear();
    this.nativeIndex = null;
    this.idToNative.clear();
    this.nativeToId.clear();
  }

  async getAll(): Promise<VectorEntry[]> {
    return this.fallback.getAll();
  }

  stats(): { totalEntries: number; dimensions: number } {
    return this.fallback.stats();
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

let nativeModule: any = null;
let nativeChecked = false;

/** Load @faiss-node/native once; smoke-test it; null when unusable. */
async function loadNativeFaiss(): Promise<any | null> {
  if (nativeChecked) return nativeModule;
  nativeChecked = true;
  try {
    const mod = await import('@faiss-node/native');
    if (!mod || typeof mod.IndexFlatIP !== 'function') {
      nativeModule = null;
      return null;
    }
    // Smoke test: build a tiny index and search it.
    const idx = new mod.IndexFlatIP(2);
    idx.add([1, 0]);
    const res = idx.search([1, 0], 1);
    if (!res || !Array.isArray(res.labels) || res.labels.length === 0) {
      nativeModule = null;
      return null;
    }
    nativeModule = mod;
    return mod;
  } catch {
    nativeModule = null;
    return null;
  }
}

/**
 * Create the best available FAISS-style backend for a namespace:
 * native FAISS when installed+buildable, otherwise the pure-JS IVF-flat
 * backend. Never throws — the caller can always fall back to JsonBackend.
 */
export async function createFaissBackend(namespace: string): Promise<VectorStoreBackend> {
  try {
    const mod = await loadNativeFaiss();
    if (mod) {
      return new NativeFaissBackend(namespace, mod);
    }
  } catch {
    // fall through to pure-JS
  }
  return new FaissIvfBackend(namespace);
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function ensureDir(): void {
  const dir = memoryDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}
