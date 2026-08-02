/**
 * FAISS IVF vs Exact backend benchmark.
 *
 * Measures the pure-JS IVF-flat ANN tradeoff on a large corpus (2,000 vectors,
 * well above the 512-entry exact threshold): recall@k against the exact JSON
 * backend (ground truth) plus search latency, so the approximate-search
 * behavior is observable and regression-guarded.
 *
 * - Deterministic (mulberry32 PRNG) — reproducible across runs/CI.
 * - Hermetic: writes to a temp BUFF_MEMORY_DIR, never the real ~/.buff/memory.
 * - Recall thresholds are generous (≥0.9@5, ≥0.8@1) to avoid flakiness while
 *   still catching a broken IVF implementation.
 * - Latency is logged, not asserted (timing assertions flake on CI).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FaissIvfBackend } from '../../src/memory/faiss-backend.js';
import { JsonBackend, resetVectorBackendSelection } from '../../src/memory/vector-store.js';

// ─── Hermetic memory dir ────────────────────────────────────────────────────

let memDir: string;
const ORIGINAL_MEMORY_DIR = process.env.BUFF_MEMORY_DIR;

beforeAll(() => {
  memDir = mkdtempSync(join(tmpdir(), 'faiss-benchmark-'));
  process.env.BUFF_MEMORY_DIR = memDir;
});

afterAll(() => {
  if (ORIGINAL_MEMORY_DIR === undefined) delete process.env.BUFF_MEMORY_DIR;
  else process.env.BUFF_MEMORY_DIR = ORIGINAL_MEMORY_DIR;
  rmSync(memDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetVectorBackendSelection();
});

// ─── Deterministic PRNG + corpus ────────────────────────────────────────────

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

function randomVector(rand: () => number, dim: number): number[] {
  const v: number[] = [];
  for (let i = 0; i < dim; i++) v.push(rand() * 2 - 1);
  return v;
}

// Cluster-based corpus: 25 clusters × 80 points → 2,000 vectors. Queries are
// perturbations of cluster centroids so true neighbors are well-defined.
function buildCorpus(seed: number, dim = 32, clusters = 25, perCluster = 80): number[][] {
  const rand = mulberry32(seed);
  const centroids = Array.from({ length: clusters }, () => randomVector(rand, dim));
  const corpus: number[][] = [];
  for (let c = 0; c < clusters; c++) {
    for (let i = 0; i < perCluster; i++) {
      // Cluster member = centroid + small noise.
      const v = centroids[c].map((x) => x + (rand() - 0.5) * 0.2);
      corpus.push(v);
    }
  }
  return corpus;
}

describe('IVF vs exact — large corpus benchmark', () => {
  const DIM = 32;
  const CLUSTERS = 25;
  const PER_CLUSTER = 80;
  const TOTAL = CLUSTERS * PER_CLUSTER; // 2,000 entries

  // 2,000 sequential insert() calls each rewrite the growing JSON index file
  // (O(n²) disk I/O) — a generous timeout beyond the 5s default is required.
  it('achieves high recall@k against the exact backend on 2,000 vectors', async () => {
    const corpus = buildCorpus(7, DIM, CLUSTERS, PER_CLUSTER);

    const ivf = new FaissIvfBackend('bench-ivf', { nlist: 16, nprobe: 4, exactThreshold: 128, seed: 7 });
    const exact = new JsonBackend('bench-ivf');
    await ivf.clear();
    await exact.clear();

    for (let i = 0; i < corpus.length; i++) {
      await ivf.insert(`v-${i}`, corpus[i], { idx: i });
      await exact.insert(`v-${i}`, corpus[i], { idx: i });
    }
    expect(await ivf.count()).toBe(TOTAL);

    // Queries: one per cluster, perturbed slightly — ground truth = cluster members.
    const queries = Array.from({ length: CLUSTERS }, (_, c) => {
      const base = corpus[c * PER_CLUSTER];
      return base.map((x) => x + (mulberry32(c + 99)() - 0.5) * 0.01);
    });

    let exactRecall5 = 0;
    let ivfRecall5 = 0;
    let ivfRecall1 = 0;
    let exactMs = 0;
    let ivfMs = 0;

    for (let q = 0; q < queries.length; q++) {
      const query = queries[q];
      const clusterStart = q * PER_CLUSTER;

      // Exact ground truth (top-5).
      const t0 = performance.now();
      const exactRes = await exact.search(query, 5);
      exactMs += performance.now() - t0;
      const exactIds = new Set(exactRes.map((r) => r.entry.id));
      const exactHits = [...exactIds].filter((id) => Number(id.slice(2)) >= clusterStart && Number(id.slice(2)) < clusterStart + PER_CLUSTER);
      exactRecall5 += exactHits.length / 5;

      // IVF top-5.
      const t1 = performance.now();
      const ivfRes = await ivf.search(query, 5);
      ivfMs += performance.now() - t1;
      const ivfIds = ivfRes.map((r) => r.entry.id);
      const ivfHits = ivfIds.filter((id) => Number(id.slice(2)) >= clusterStart && Number(id.slice(2)) < clusterStart + PER_CLUSTER);
      ivfRecall5 += ivfHits.length / 5;

      // IVF top-1 should be a true neighbor (same cluster).
      const top1 = ivfIds[0];
      const top1Cluster = Math.floor(Number(top1.slice(2)) / PER_CLUSTER);
      if (top1Cluster === q) ivfRecall1 += 1;
    }

    const exactRecall5Avg = exactRecall5 / queries.length;
    const ivfRecall5Avg = ivfRecall5 / queries.length;
    const ivfRecall1Avg = ivfRecall1 / queries.length;

    // Log the tradeoff (informational — visible in vitest output).
    // eslint-disable-next-line no-console
    console.log(
      `\n  📊 IVF-vs-exact benchmark (${TOTAL} vectors, ${DIM}-dim, nlist=16, nprobe=4):\n` +
      `     exact recall@5: ${(exactRecall5Avg * 100).toFixed(1)}% | ivf recall@5: ${(ivfRecall5Avg * 100).toFixed(1)}%\n` +
      `     ivf recall@1:   ${(ivfRecall1Avg * 100).toFixed(1)}%\n` +
      `     latency: exact ${(exactMs / queries.length).toFixed(3)}ms vs ivf ${(ivfMs / queries.length).toFixed(3)}ms per query`,
    );

    // Generous regression floors — catch a broken IVF without flaking.
    // Ground-truth sanity: the exact backend must find the true cluster
    // (its own top-5 ≈ all same-cluster) or the IVF comparison is meaningless.
    expect(exactRecall5Avg).toBeGreaterThanOrEqual(0.99);

    expect(ivfRecall5Avg).toBeGreaterThanOrEqual(0.9);
    expect(ivfRecall1Avg).toBeGreaterThanOrEqual(0.8);
  }, 120_000);

  it('keeps the exact backend as ground truth (recall@k = 1.0 vs itself)', async () => {
    // Sanity: exact backend is deterministic and self-consistent on the corpus.
    const corpus = buildCorpus(11, DIM, CLUSTERS, PER_CLUSTER);
    const exact = new JsonBackend('bench-exact');
    await exact.clear();
    for (let i = 0; i < corpus.length; i++) {
      await exact.insert(`v-${i}`, corpus[i], { idx: i });
    }
    const query = corpus[42].map((x) => x + 0.001);
    const res = await exact.search(query, 5);
    expect(res[0].entry.id).toBe('v-42');
    expect(res[0].similarity).toBeGreaterThan(0.99);
  }, 120_000);
});
