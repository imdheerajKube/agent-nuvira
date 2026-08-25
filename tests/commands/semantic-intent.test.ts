import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { semanticResolve, aliasCorpusSize } from '../../src/commands/semantic-intent.js';

/**
 * Deterministic fake embedder for hermetic tests: maps text → 384-dim vector
 * by hashing words into buckets, so texts sharing words get similar vectors
 * (enough for rank assertions without loading the real model).
 */
/** Synonym map so the fake embedder preserves meaning ("terminate" ≈ "stop"). */
const SYNONYMS: Record<string, string> = {
  terminate: 'stop',
  kill: 'stop',
  shut: 'stop',
  bounce: 'stop',
  halt: 'stop',
  launch: 'start',
  open: 'start',
  enable: 'start',
  turn: 'start',
  hello: 'hi',
};

function fakeEmbed(text: string): Promise<number[]> {
  const words = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SYNONYMS[w] ?? w);
  const v = new Array(384).fill(0);
  let seed = 0;
  for (const w of words) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % 384] += 1;
    seed = (seed + h) >>> 0;
  }
  // Normalize so cosine is meaningful.
  let norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  if (norm === 0) norm = 1;
  return Promise.resolve(v.map((x) => x / norm));
}

/** Hermetic memory dir so the persisted alias-vector cache never touches ~/.nuvira. */
let memDir = '';

beforeEach(() => {
  memDir = mkdtempSync(join(tmpdir(), 'intent-eval-'));
  process.env.NUVIRA_MEMORY_DIR = memDir;
});

afterEach(() => {
  rmSync(memDir, { recursive: true, force: true });
  delete process.env.NUVIRA_MEMORY_DIR;
});

describe('semantic-intent — corpus', () => {
  it('loads the manifest alias corpus (hundreds of entries)', () => {
    expect(aliasCorpusSize()).toBeGreaterThan(100);
  });
});

describe('semantic-intent — matching with a fake embedder', () => {
  it('ranks the exact-alias intent first', async () => {
    const matches = await semanticResolve('stop the dashboard', { embedFn: fakeEmbed, minSimilarity: 0 });
    expect(matches[0].intent).toBe('dashboard.stop');
  });

  it('finds dashboard.stop for the novel phrasing "bounce the UI"', async () => {
    const matches = await semanticResolve('bounce the UI', { embedFn: fakeEmbed, minSimilarity: 0 });
    const intents = matches.map((m) => m.intent);
    expect(intents).toContain('dashboard.stop');
  });

  it('finds gateway.stop for "terminate the bot"', async () => {
    const matches = await semanticResolve('terminate the bot', { embedFn: fakeEmbed, minSimilarity: 0 });
    expect(matches[0].intent).toBe('gateway.stop');
  });

  it('returns empty above the similarity floor when nothing matches', async () => {
    const matches = await semanticResolve('completely unrelated gibberish zxqy', { embedFn: fakeEmbed, minSimilarity: 0.9 });
    expect(matches).toHaveLength(0);
  });

  it('caps results at topK', async () => {
    const matches = await semanticResolve('stop the dashboard', { embedFn: fakeEmbed, minSimilarity: 0, topK: 2 });
    expect(matches.length).toBeLessThanOrEqual(2);
  });
});

describe('semantic-intent — persisted alias-vector cache', () => {
  it('writes the cache file on first fresh embed and reuses it', async () => {
    const first = await semanticResolve('stop the dashboard', { embedFn: fakeEmbed, minSimilarity: 0 });
    expect(first[0].intent).toBe('dashboard.stop');

    // Cache file must exist in the hermetic memory dir.
    const { readFileSync } = await import('node:fs');
    const path = join(memDir, 'intent-alias-vectors.json');
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { version: number; manifestHash: string; vectors: Record<string, number[]> };
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.vectors).length).toBeGreaterThan(100);

    // Second resolve reuses the persisted cache (same results, no re-embed).
    const second = await semanticResolve('bounce the UI', { embedFn: fakeEmbed, minSimilarity: 0 });
    expect(second.map((m) => m.intent)).toContain('dashboard.stop');
  });
});
