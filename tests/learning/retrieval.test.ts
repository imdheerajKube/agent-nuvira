/**
 * Retrieval engine tests — vectorization layer (chunking, indexing, query,
 * context assembly with token savings, failover, stats persistence).
 *
 * The embedder is forced to the deterministic LLM tier (setForceLLM) with a
 * mock LLM so tests don't download bge-small-en-v1.5 or hit Python.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  chunkText,
  estimateTokens,
  indexFiles,
  retrieve,
  assembleContext,
  recordRetrievalStats,
  readRetrievalAggregateStats,
  clearRetrievalState,
  retrievalOptionsFromConfig,
  DEFAULT_CHUNK_TOKENS,
  DEFAULT_TOP_K,
  DEFAULT_THRESHOLD_TOKENS,
  REPO_NAMESPACE,
} from '../../src/learning/retrieval.js';
import { setForceLLM, clearEmbeddingCache } from '../../src/memory/embedder.js';
import { getVectorStore, cosineSimilarity } from '../../src/memory/vector-store.js';

// ─── Deterministic 384-dim embedding: hash-based so similar text → similar vector ───

function mockEmbed(text: string): number[] {
  // A crude but deterministic "semantic" embedding: character bigram histogram
  // normalized. Similar text → similar histogram → high cosine similarity.
  const dim = 384;
  const vec = new Array(dim).fill(0);
  const words = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  for (const word of words) {
    for (let i = 0; i < word.length - 1; i++) {
      const bigram = word.slice(i, i + 2);
      let h = 0;
      for (const ch of bigram) h = (h * 31 + ch.charCodeAt(0)) % dim;
      vec[h] += 1;
    }
  }
  // Normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

const mockLLM = async (prompt: string): Promise<string> => {
  const m = prompt.match(/Text to embed:\n([\s\S]*?)$/);
  return JSON.stringify(mockEmbed(m?.[1] || prompt));
};

// ─── Test fixtures ──────────────────────────────────────────────────────────

let tempDir: string;
let prevMemoryDir: string | undefined;

beforeEach(() => {
  vi.restoreAllMocks();
  clearEmbeddingCache();
  setForceLLM(true); // Force the deterministic LLM tier everywhere in tests
  tempDir = mkdtempSync(join(tmpdir(), 'buff-retrieval-'));
  prevMemoryDir = process.env.BUFF_MEMORY_DIR;
  process.env.BUFF_MEMORY_DIR = join(tempDir, 'memory');
  mkdirSync(process.env.BUFF_MEMORY_DIR, { recursive: true });
});

afterEach(() => {
  setForceLLM(false);
  clearRetrievalState();
  if (prevMemoryDir === undefined) delete process.env.BUFF_MEMORY_DIR;
  else process.env.BUFF_MEMORY_DIR = prevMemoryDir;
  rmSync(tempDir, { recursive: true, force: true });
});

function makeFile(name: string, content: string): string {
  const p = join(tempDir, name);
  mkdirSync(join(tempDir, name).slice(0, join(tempDir, name).lastIndexOf('/')) || tempDir, { recursive: true });
  writeFileSync(p, content, 'utf-8');
  return p;
}

// ─── Chunking ───────────────────────────────────────────────────────────────

describe('chunkText', () => {
  it('returns a single chunk for small text', () => {
    const chunks = chunkText('hello world', 'a.ts');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toBe('a.ts#0');
    expect(chunks[0].text).toBe('hello world');
  });

  it('splits large text into multiple chunks with stable ids', () => {
    const big = Array.from({ length: 200 }, (_, i) => `line ${i} with some words here`).join('\n');
    const chunks = chunkText(big, 'big.ts', 50, 0);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].id).toBe('big.ts#0');
    expect(chunks[1].id).toBe('big.ts#1');
    expect(chunks.every((c) => c.tokenCount > 0)).toBe(true);
  });

  it('estimates tokens at ~4 chars per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});

// ─── Indexing + retrieval roundtrip ─────────────────────────────────────────

describe('indexFiles + retrieve', () => {
  it('indexes files and finds semantically similar chunks', async () => {
    const authFile = makeFile('auth.ts', [
      '// Authentication service',
      'function login(user, password) {',
      '  const token = createJwt(user);',
      '  return token;',
      '}',
      'function createJwt(user) { return "jwt." + user.id; }',
    ].join('\n'));
    const uiFile = makeFile('ui.ts', [
      '// UI components',
      'function renderButton(label) { return `<button>${label}</button>`; }',
      'function renderModal(title) { return `<div>${title}</div>`; }',
    ].join('\n'));

    const { files, chunks } = await indexFiles([authFile, uiFile], { callLLM: mockLLM });
    expect(files).toBe(2);
    expect(chunks).toBeGreaterThan(0);

    // Query about authentication should surface the auth chunk first.
    const hits = await retrieve('how does login with jwt work?', { callLLM: mockLLM, topK: 3 });
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0];
    expect(top.chunk.filePath).toContain('auth.ts');
    expect(top.similarity).toBeGreaterThan(0);
  });

  it('re-indexing overwrites instead of duplicating', async () => {
    const f = makeFile('dup.ts', 'function alpha() {}');
    await indexFiles([f], { callLLM: mockLLM });
    const first = getVectorStore(REPO_NAMESPACE).stats().totalEntries;
    // Change the file and re-index — ids are stable so count stays the same.
    writeFileSync(f, 'function alpha() { return 1; } // more content here\n'.repeat(20), 'utf-8');
    await indexFiles([f], { callLLM: mockLLM });
    const second = getVectorStore(REPO_NAMESPACE).stats().totalEntries;
    expect(second).toBe(first);
  });

  it('skips unreadable files without throwing', async () => {
    const good = makeFile('good.ts', 'export const x = 1;');
    const { files, chunks } = await indexFiles([good, join(tempDir, 'missing.ts')], { callLLM: mockLLM });
    expect(files).toBe(1);
    expect(chunks).toBeGreaterThan(0);
  });
});

// ─── assembleContext (the router hook) ──────────────────────────────────────

describe('assembleContext', () => {
  it('passes small contexts through untouched (simple-task fast path)', async () => {
    const small = 'short context';
    const result = await assembleContext('do something', [], small, {
      callLLM: mockLLM,
      thresholdTokens: DEFAULT_THRESHOLD_TOKENS,
    });
    expect(result.stats.used).toBe(false);
    expect(result.stats.originalTokens).toBe(estimateTokens(small));
    expect(result.context).toBe(small);
    expect(result.stats.failover).toBe(false);
  });

  it('returns unchanged context when retrieval is disabled', async () => {
    const big = 'x'.repeat(10_000); // ~2500 tokens > threshold 100
    const f = makeFile('disabled.ts', big);
    const result = await assembleContext('query', [f], null, {
      callLLM: mockLLM,
      enabled: false,
      thresholdTokens: 100,
    });
    expect(result.stats.used).toBe(false);
    // The full file content must be present (rebuilt from the file with its
    // header prefix) — no reduction, no truncation.
    expect(result.context).toContain(big);
  });

  it('reduces large contexts and reports token savings', async () => {
    // Two files: one relevant to the query, one huge and irrelevant.
    const relevantContent = 'database connection pool with transactions and rollbacks'.repeat(50);
    const hugeContent = 'meaningless noise about widgets and gadgets'.repeat(500);
    const relevant = makeFile('db.ts', relevantContent);
    const hugeIrrelevant = makeFile('logs.ts', hugeContent);

    const result = await assembleContext('how do database transactions work?', [relevant, hugeIrrelevant], null, {
      callLLM: mockLLM,
      thresholdTokens: 50,
      topK: 3,
    });

    expect(result.stats.used).toBe(true);
    expect(result.stats.savedTokens).toBeGreaterThan(0);
    expect(result.stats.pctReduced).toBeGreaterThan(0);
    expect(result.stats.chunksRetrieved).toBeGreaterThan(0);
    expect(result.stats.failover).toBe(false);
    expect(result.stats.originalTokens).toBeGreaterThan(result.stats.reducedTokens);
    // The reduced context must be dramatically smaller than the huge file and
    // must carry the RELEVANT content (db.ts, matched by the query).
    expect(result.context.length).toBeLessThan(hugeContent.length);
    expect(result.context).toContain('database');
  });

  it('falls back to full context when retrieval throws (failover)', async () => {
    // The embedder itself swallows LLM-tier failures (returns a zero vector), so
    // to exercise assembleContext's failover catch we force the VECTOR SEARCH
    // to reject on the shared repo store instance — retrieve() calls
    // store.search() on that instance, so the rejection propagates into
    // assembleContext's catch. The reduce path must fall back to the full
    // context, never throw, and mark the call as a failover.
    const bigFile = makeFile('big-failover.ts', 'y'.repeat(10_000));
    const store = getVectorStore(REPO_NAMESPACE);
    vi.spyOn(store, 'search').mockRejectedValue(new Error('vector search down'));

    const result = await assembleContext('query', [bigFile], null, {
      callLLM: mockLLM,
      thresholdTokens: 100,
    });

    expect(result.stats.failover).toBe(true);
    expect(result.stats.originalTokens).toBeGreaterThan(100);
    // Full context returned (the file content with its header prefix).
    expect(result.context).toContain('y'.repeat(1000));
    expect(result.stats.used).toBe(false);
  });
});

// ─── Stats persistence ──────────────────────────────────────────────────────

describe('retrieval stats', () => {
  it('records and aggregates per-call stats', async () => {
    recordRetrievalStats({
      used: true,
      originalTokens: 20_000,
      reducedTokens: 3_000,
      savedTokens: 17_000,
      pctReduced: 85,
      chunksRetrieved: 5,
      failover: false,
      hits: [{ filePath: 'src/a.ts', similarity: 0.9 }],
      timestamp: Date.now(),
    });
    const stats = readRetrievalAggregateStats();
    expect(stats.totalCalls).toBe(1);
    expect(stats.totalRetrievals).toBe(1);
    expect(stats.totalSavedTokens).toBe(17_000);
    expect(stats.lastCall?.savedTokens).toBe(17_000);
    expect(stats.recent).toHaveLength(1);
  });

  it('clearRetrievalState wipes stats + index', async () => {
    recordRetrievalStats({
      used: true,
      originalTokens: 100,
      reducedTokens: 50,
      savedTokens: 50,
      pctReduced: 50,
      chunksRetrieved: 2,
      failover: false,
      hits: [],
      timestamp: Date.now(),
    });
    await indexFiles([makeFile('x.ts', 'export const a = 1;')], { callLLM: mockLLM });
    clearRetrievalState();
    expect(readRetrievalAggregateStats().totalCalls).toBe(0);
    expect(getVectorStore(REPO_NAMESPACE).stats().totalEntries).toBe(0);
  });
});

// ─── Config resolution ──────────────────────────────────────────────────────

describe('retrievalOptionsFromConfig', () => {
  it('returns defaults when no config is present', () => {
    const opts = retrievalOptionsFromConfig(undefined);
    expect(opts.enabled).toBe(true);
    expect(opts.topK).toBe(DEFAULT_TOP_K);
    expect(opts.chunkTokens).toBe(DEFAULT_CHUNK_TOKENS);
    expect(opts.thresholdTokens).toBe(DEFAULT_THRESHOLD_TOKENS);
  });
});

// ─── Vector math sanity (namespace isolation) ───────────────────────────────

describe('repo namespace isolation', () => {
  it('stores repo chunks in a separate index from memory vectors', async () => {
    const f = makeFile('iso.ts', 'isolated content here for namespace check');
    await indexFiles([f], { callLLM: mockLLM });
    expect(getVectorStore(REPO_NAMESPACE).stats().totalEntries).toBeGreaterThan(0);
    // The default (memory) store must remain empty.
    expect(getVectorStore().stats().totalEntries).toBe(0);
  });

  it('cosine similarity behaves sanely for the mock embedder', () => {
    const a = mockEmbed('login with jwt authentication token');
    const b = mockEmbed('user login authentication');
    const c = mockEmbed('paint the fence red green blue');
    expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c));
  });
});
