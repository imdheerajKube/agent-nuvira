import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FaissIvfBackend,
  NativeFaissBackend,
  createFaissBackend,
  DEFAULT_NLIST,
  DEFAULT_NPROBE,
  DEFAULT_EXACT_THRESHOLD,
} from '../../src/memory/faiss-backend.js';
import {
  VectorStore,
  JsonBackend,
  getVectorStore,
  setVectorBackendOverride,
  resetVectorBackendSelection,
  cosineSimilarity,
} from '../../src/memory/vector-store.js';

// ─── Hermetic memory dir ────────────────────────────────────────────────────

let memDir: string;
const ORIGINAL_MEMORY_DIR = process.env.BUFF_MEMORY_DIR;

beforeAll(() => {
  memDir = mkdtempSync(join(tmpdir(), 'faiss-test-'));
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

// ─── Deterministic PRNG (mulberry32) for reproducible large-corpus tests ────

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

// ─── createFaissBackend resolves to a working backend ──────────────────────

describe('createFaissBackend', () => {
  it('returns a usable backend (native when available, else pure-JS IVF)', async () => {
    const backend = await createFaissBackend('sel-ns');
    expect(['faiss-native', 'faiss-ivf']).toContain(backend.name);
    await backend.insert('a', [1, 0, 0], { kind: 'repo-chunk' });
    expect(await backend.count()).toBe(1);
    await backend.clear();
  });

  it('never throws on load even when native FAISS is unusable', async () => {
    // Unset any native module state by importing the factory fresh path —
    // in CI the optional dep is absent, so this must resolve to IVF.
    const backend = await createFaissBackend('sel-ns-2');
    expect(backend).toBeDefined();
  });
});

// ─── FaissIvfBackend: exact parity on small indexes ─────────────────────────

describe('FaissIvfBackend — small index (exact parity with JSON)', () => {
  let ivf: FaissIvfBackend;
  let json: JsonBackend;

  beforeEach(async () => {
    ivf = new FaissIvfBackend('parity', { seed: 7 });
    json = new JsonBackend('parity');
    await ivf.clear();
    await json.clear();
  });

  it('returns identical top-k ordering as the JSON backend', async () => {
    const rand = mulberry32(1);
    const ids = ['v1', 'v2', 'v3', 'v4', 'v5'];
    for (const id of ids) {
      const v = randomVector(rand, 8);
      await ivf.insert(id, v, { label: id });
      await json.insert(id, v, { label: id });
    }
    const query = randomVector(mulberry32(2), 8);
    const ivfRes = await ivf.search(query, 3);
    const jsonRes = await json.search(query, 3);
    expect(ivfRes.map((r) => r.entry.id)).toEqual(jsonRes.map((r) => r.entry.id));
  });

  it('returns exact cosine similarities (not approximated) under the threshold', async () => {
    await ivf.insert('a', [1, 0, 0]);
    await ivf.insert('b', [0, 1, 0]);
    const res = await ivf.search([1, 0, 0], 2);
    expect(res[0].entry.id).toBe('a');
    expect(res[0].similarity).toBeCloseTo(1, 5);
    expect(res[1].similarity).toBeCloseTo(0, 5);
  });

  it('applies the filter function', async () => {
    await ivf.insert('a', [1, 0, 0], { kind: 'x' });
    await ivf.insert('b', [1, 0, 0], { kind: 'y' });
    const res = await ivf.search([1, 0, 0], 5, (e) => e.metadata.kind === 'y');
    expect(res).toHaveLength(1);
    expect(res[0].entry.id).toBe('b');
  });

  it('count / getAll / get / delete / clear round-trip through the shared file', async () => {
    await ivf.insert('a', [1, 0, 0], { n: 1 });
    await ivf.insert('b', [0, 1, 0], { n: 2 });
    expect(await ivf.count()).toBe(2);
    expect((await ivf.getAll()).map((e) => e.id).sort()).toEqual(['a', 'b']);
    expect((await ivf.get('a'))?.metadata).toEqual({ n: 1 });
    expect(await ivf.delete('b')).toBe(true);
    expect(await ivf.count()).toBe(1);
    await ivf.clear();
    expect(await ivf.count()).toBe(0);
  });

  it('stats() is synchronous and reflects the on-disk entries', () => {
    ivf.insert('a', [1, 0, 0]);
    ivf.insert('b', [0, 1, 0]);
    const stats = ivf.stats();
    expect(stats.totalEntries).toBe(2);
    expect(stats.dimensions).toBe(3);
  });

  it('a second instance (new process) sees the persisted entries', async () => {
    await ivf.insert('persist-1', [1, 0, 0]);
    const fresh = new FaissIvfBackend('parity', { seed: 7 });
    expect(await fresh.count()).toBe(1);
    expect((await fresh.get('persist-1'))?.vector).toEqual([1, 0, 0]);
  });
});

// ─── FaissIvfBackend: approximate ANN on large indexes ──────────────────────

describe('FaissIvfBackend — large index (IVF-flat ANN)', () => {
  it('retrieves the nearest neighbor with high recall', async () => {
    const backend = new FaissIvfBackend('large', {
      nlist: 16,
      nprobe: 4,
      exactThreshold: 8, // force the IVF path even with a small corpus
      seed: 11,
    });
    await backend.clear();

    const dim = 16;
    const rand = mulberry32(42);
    const inserted: number[][] = [];
    for (let i = 0; i < 40; i++) {
      const v = randomVector(rand, dim);
      await backend.insert(`vec-${i}`, v);
      inserted.push(v);
    }

    // Query with a vector very close to vec-17.
    const near = inserted[17].map((x) => x + (Math.random() - 0.5) * 0.01);
    const res = await backend.search(near, 5);
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].similarity).toBeGreaterThan(0.9);
    // vec-17 itself must be in the top-k.
    const ids = res.map((r) => r.entry.id);
    expect(ids).toContain('vec-17');
  });

  it('expands nprobe when the filter leaves gaps (filter-aware search)', async () => {
    const backend = new FaissIvfBackend('large-filter', {
      nlist: 8,
      nprobe: 1,
      exactThreshold: 4,
      seed: 5,
    });
    await backend.clear();

    const rand = mulberry32(9);
    const dim = 12;
    for (let i = 0; i < 30; i++) {
      await backend.insert(`m-${i}`, randomVector(rand, dim), { kind: 'match' });
      await backend.insert(`n-${i}`, randomVector(rand, dim), { kind: 'noise' });
    }
    const query = randomVector(mulberry32(3), dim);
    // Filter to only 'match' entries — probe must expand to find k of them.
    const res = await backend.search(query, 5, (e) => e.metadata.kind === 'match');
    expect(res.length).toBeGreaterThanOrEqual(5);
    expect(res.every((r) => r.entry.metadata.kind === 'match')).toBe(true);
  });

  it('still returns unassigned (zero-vector) entries at similarity 0 when under-filled', async () => {
    const backend = new FaissIvfBackend('large-zero', {
      nlist: 4,
      nprobe: 1,
      exactThreshold: 1,
      seed: 1,
    });
    await backend.clear();
    await backend.insert('zero', new Array(4).fill(0), { kind: 'zero' });
    await backend.insert('real', [1, 0, 0, 0]);
    const res = await backend.search([1, 0, 0, 0], 5);
    expect(res.map((r) => r.entry.id).sort()).toEqual(['real', 'zero']);
  });
});

// ─── NativeFaissBackend: real API (FaissIndex) + graceful fallback ─────────

/** A faithful mock of @faiss-node/native's FaissIndex (FLAT_IP). */
class MockFaissIndex {
  dims: number;
  vectors: Float32Array[] = [];

  constructor(config: { type: string; dims: number }) {
    this.dims = config.dims;
  }

  async add(vectors: Float32Array, ids?: Int32Array): Promise<void> {
    for (let i = 0; i < vectors.length; i += this.dims) {
      this.vectors.push(vectors.slice(i, i + this.dims));
    }
    void ids; // ids are positional 0..n-1 in FLAT_IP
  }

  async search(query: Float32Array, k: number): Promise<{ labels: Int32Array; distances: Float32Array }> {
    const q = Array.from(query);
    const scored = this.vectors
      .map((v, i) => ({ i, d: dotProd(Array.from(v), q) }))
      .sort((a, b) => b.d - a.d)
      .slice(0, k);
    return {
      labels: new Int32Array(scored.map((s) => s.i)),
      distances: new Float32Array(scored.map((s) => s.d)),
    };
  }

  dispose(): void { /* noop */ }
}

function dotProd(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}

describe('NativeFaissBackend', () => {
  it('uses the real FaissIndex API (FLAT_IP) and maps labels back to ids', async () => {
    const backend = new NativeFaissBackend('native-ok', { FaissIndex: MockFaissIndex });
    await backend.insert('a', [1, 0, 0], { label: 'a' });
    await backend.insert('b', [0, 1, 0], { label: 'b' });

    expect(await backend.count()).toBe(2);
    // Native FLAT_IP over normalized vectors → cosine similarity.
    const res = await backend.search([1, 0, 0], 2);
    expect(res[0].entry.id).toBe('a');
    expect(res[0].similarity).toBeCloseTo(1, 5);
    expect(res[1].entry.id).toBe('b');
    expect(res[1].similarity).toBeCloseTo(0, 5);
  });

  it('applies the filter function after native search', async () => {
    const backend = new NativeFaissBackend('native-filter', { FaissIndex: MockFaissIndex });
    await backend.insert('a', [1, 0, 0], { kind: 'x' });
    await backend.insert('b', [1, 0, 0], { kind: 'y' });
    const res = await backend.search([1, 0, 0], 5, (e) => e.metadata.kind === 'y');
    expect(res).toHaveLength(1);
    expect(res[0].entry.id).toBe('b');
  });

  it('falls back to the pure-JS IVF backend when the native search throws', async () => {
    const brokenModule = {
      FaissIndex: class {
        add(): void { throw new Error('native crash'); }
        search(): never { throw new Error('native search down'); }
        dispose(): void { /* noop */ }
      },
    };
    const backend = new NativeFaissBackend('native-ns', brokenModule as unknown);
    await backend.insert('a', [1, 0, 0], { label: 'a' });
    await backend.insert('b', [0, 1, 0], { label: 'b' });

    // get/count/getAll/stats delegate to the fallback (JSON-backed IVF).
    expect(await backend.count()).toBe(2);
    expect((await backend.getAll()).map((e) => e.id).sort()).toEqual(['a', 'b']);

    // search must fall back and still return correct results.
    const res = await backend.search([1, 0, 0], 2);
    expect(res[0].entry.id).toBe('a');
    expect(res[0].similarity).toBeCloseTo(1, 5);
  });
});

// ─── Config-driven selection via getVectorStore ─────────────────────────────

describe('getVectorStore backend selection', () => {
  it('defaults to a FAISS-style backend under auto when JSON is not forced', async () => {
    // Explicitly request 'auto' so a developer's real ~/.buff/buffconfig.json
    // (e.g. memory.vectorBackend: "json") can't change the outcome.
    setVectorBackendOverride('auto');
    const store = getVectorStore('cfg-ns');
    await store.insert('a', [1, 0, 0]);
    const name = await store.backendName();
    expect(['faiss-native', 'faiss-ivf']).toContain(name);
  });

  it('uses the exact JSON backend when overridden to json', async () => {
    setVectorBackendOverride('json');
    const store = getVectorStore('cfg-ns-json');
    expect(await store.backendName()).toBe('json');
  });

  it('honors the BUFF_VECTOR_BACKEND env var over config', async () => {
    const prev = process.env.BUFF_VECTOR_BACKEND;
    process.env.BUFF_VECTOR_BACKEND = 'json';
    resetVectorBackendSelection();
    try {
      const store = getVectorStore('cfg-ns-env');
      expect(await store.backendName()).toBe('json');
    } finally {
      if (prev === undefined) delete process.env.BUFF_VECTOR_BACKEND;
      else process.env.BUFF_VECTOR_BACKEND = prev;
      resetVectorBackendSelection();
    }
  });

  it('VectorStore facade returns identical search results regardless of backend', async () => {
    const rand = mulberry32(21);
    const vectors: Array<{ id: string; v: number[] }> = [];
    for (let i = 0; i < 6; i++) vectors.push({ id: `id-${i}`, v: randomVector(rand, 10) });

    // Use EXPLICIT backends on fresh store instances — getVectorStore() caches
    // per namespace, so switching the override mid-test would return the same
    // already-resolved singleton (making the parity assertion vacuous).
    const jsonStore = new VectorStore('facade-ns', new JsonBackend('facade-ns'));
    const faissStore = new VectorStore('facade-ns', await createFaissBackend('facade-ns'));
    for (const e of vectors) {
      await jsonStore.insert(e.id, e.v);
      await faissStore.insert(e.id, e.v);
    }

    const query = randomVector(mulberry32(22), 10);
    const jsonRes = await jsonStore.search(query, 3);
    const faissRes = await faissStore.search(query, 3);
    expect(faissRes.map((r) => r.entry.id)).toEqual(jsonRes.map((r) => r.entry.id));
    faissRes.forEach((r, i) => expect(r.similarity).toBeCloseTo(jsonRes[i].similarity, 5));
  });
});

// ─── Namespace isolation ────────────────────────────────────────────────────

describe('namespace isolation', () => {
  it('keeps repo retrieval vectors separate from memory vectors', async () => {
    const repo = getVectorStore('repo');
    await repo.clear();
    const mem = getVectorStore();
    await mem.clear();

    await repo.insert('chunk-1', [1, 0, 0], { kind: 'repo-chunk', filePath: 'a.ts' });
    expect(await repo.count()).toBe(1);
    expect(await mem.count()).toBe(0);
    expect(repo.stats().totalEntries).toBe(1);
  });
});

// ─── Defaults sanity ────────────────────────────────────────────────────────

describe('FAISS defaults', () => {
  it('exports sane defaults', () => {
    expect(DEFAULT_NLIST).toBe(16);
    expect(DEFAULT_NPROBE).toBe(4);
    expect(DEFAULT_EXACT_THRESHOLD).toBe(512);
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5);
  });
});
