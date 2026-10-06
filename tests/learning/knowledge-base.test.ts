/**
 * Knowledge base tests (`src/learning/knowledge-base.ts`).
 *
 * Hermetic: the memory dir is a temp dir (vectors + manifest live there) and the
 * vector backend is pinned to `json`. Embeddings are injectable, so these tests
 * never download the ~130 MB model — a constant vector is enough to prove the
 * pipeline (extract → chunk → embed → store → tag-scoped retrieve → forget).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  normalizeKnowledgeTag,
  isValidKnowledgeTag,
  namespaceForTag,
  ingestKnowledge,
  queryKnowledge,
  listKnowledgeTags,
  getKnowledgeTag,
  forgetKnowledgeTag,
  formatKnowledgeContext,
  collectKnowledgeFiles,
} from '../../src/learning/knowledge-base.js';
import { resetVectorBackendSelection, getVectorStore } from '../../src/memory/vector-store.js';

/** Deterministic 384-dim embedding — constant, so every chunk scores equally. */
const constantEmbed = async (): Promise<number[]> => new Array(384).fill(0.1);

let dir = '';
const realMemoryDir = process.env.NUVIRA_MEMORY_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuvira-knowledge-'));
  process.env.NUVIRA_MEMORY_DIR = join(dir, 'memory');
  resetVectorBackendSelection();
});

afterEach(() => {
  if (realMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = realMemoryDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('tag normalization', () => {
  it('normalizes a human tag into a sandboxed namespace segment', () => {
    expect(normalizeKnowledgeTag('Dheeraj_Health_report')).toBe('dheeraj-health-report');
    expect(normalizeKnowledgeTag('  My Report  ')).toBe('my-report');
    expect(normalizeKnowledgeTag('a b  c')).toBe('a-b-c');
  });

  it('validates the normalized form', () => {
    expect(isValidKnowledgeTag('dheeraj-health-report')).toBe(true);
    expect(isValidKnowledgeTag('has_underscore')).toBe(false);
    expect(isValidKnowledgeTag('---')).toBe(false);
  });

  it('namespaces per tag', () => {
    expect(namespaceForTag('dheeraj-health-report')).toBe('knowledge-dheeraj-health-report');
  });
});

describe('collectKnowledgeFiles', () => {
  it('walks a directory and skips vendor dirs', () => {
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'skip.txt'), 'x');
    writeFileSync(join(dir, 'a.txt'), 'a');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'b.txt'), 'b');
    const files = collectKnowledgeFiles(dir);
    expect(files.some((f) => f.endsWith('a.txt'))).toBe(true);
    expect(files.some((f) => f.endsWith('b.txt'))).toBe(true);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
  });
});

describe('ingest → query → forget', () => {
  it('answers a question from a tagged document without re-reading it per query', async () => {
    const docPath = join(dir, 'health.txt');
    writeFileSync(docPath, 'LDL cholesterol: 142 mg/dL\nHDL: 55 mg/dL\nTriglycerides: 120 mg/dL\n', 'utf-8');

    const result = await ingestKnowledge('Dheeraj_Health_report', [docPath], { embedFn: constantEmbed });
    expect(result.tag).toBe('dheeraj-health-report');
    expect(result.files).toBe(1);
    expect(result.chunks).toBeGreaterThan(0);

    const hits = await queryKnowledge('dheeraj-health-report', 'what is my LDL', { embedFn: constantEmbed });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.tag === 'dheeraj-health-report')).toBe(true);
    expect(hits.some((h) => h.text.includes('LDL'))).toBe(true);
    // Constant embeddings clear the floor, so these are dense evidence and the
    // citation shows no term-match caveat.
    expect(hits.every((h) => h.evidence === 'dense')).toBe(true);

    const context = formatKnowledgeContext('dheeraj-health-report', hits);
    expect(context).toContain("from your data: health.txt");
    expect(context).toContain('USER DATA');

    const tags = listKnowledgeTags();
    expect(tags.map((t) => t.tag)).toContain('dheeraj-health-report');
    expect(getKnowledgeTag('Dheeraj Health Report')?.documents.length).toBe(1);

    const removed = await forgetKnowledgeTag('dheeraj-health-report');
    expect(removed).toBe(true);
    expect(getKnowledgeTag('dheeraj-health-report')).toBeNull();
    expect(await queryKnowledge('dheeraj-health-report', 'ldl', { embedFn: constantEmbed })).toEqual([]);
  });

  it('re-ingesting a changed document overwrites its chunks instead of duplicating', async () => {
    const docPath = join(dir, 'note.md');
    writeFileSync(docPath, 'version one', 'utf-8');
    await ingestKnowledge('notes', [docPath], { embedFn: constantEmbed });
    const first = getKnowledgeTag('notes')?.chunkCount ?? 0;

    writeFileSync(docPath, 'version two', 'utf-8');
    await ingestKnowledge('notes', [docPath], { embedFn: constantEmbed });
    const entry = getKnowledgeTag('notes');
    // One document recorded, not two.
    expect(entry?.documents.length).toBe(1);
    expect(entry?.chunkCount).toBe(first);
  });

  it('skips unreadable paths and reports why', async () => {
    const result = await ingestKnowledge('misc', [join(dir, 'does-not-exist.txt')], { embedFn: constantEmbed });
    expect(result.files).toBe(0);
    expect(result.skipped[0].reason).toBe('not found');
  });

  it('rejects a tag with no letters or digits', async () => {
    await expect(ingestKnowledge('---', [join(dir, 'x.txt')], { embedFn: constantEmbed })).rejects.toThrow();
  });
});

/**
 * The relevance floor.
 *
 * Nearest-neighbour search ALWAYS returns its k nearest neighbours, so the only
 * thing standing between "an unrelated question" and "a confident block of the
 * wrong document" is a floor. These pin that an unrelated question can come back
 * EMPTY, and that the floor is a knob rather than a constant.
 */
describe('relevance floor', () => {
  /** One-hot vectors, so two different axes are exactly orthogonal (cosine 0). */
  const oneHot = (axis: number) => async (): Promise<number[]> => {
    const v = new Array(384).fill(0);
    v[axis] = 1;
    return v;
  };
  /** Halfway between axes 0 and 1 → cosine 1/√2 ≈ 0.707 against `oneHot(0)`. */
  const mixed = async (): Promise<number[]> => {
    const v = new Array(384).fill(0);
    v[0] = 1;
    v[1] = 1;
    return v;
  };

  async function seeded(): Promise<string> {
    const docPath = join(dir, 'policy.md');
    writeFileSync(docPath, 'Clause 4.2: invoices are due within 30 days of receipt.', 'utf-8');
    await ingestKnowledge('policy', [docPath], { embedFn: oneHot(0) });
    return docPath;
  }

  it('returns NO hits for a question unrelated to the tagged document', async () => {
    await seeded();
    // Orthogonal to the document's vector: a real nearest neighbour, but not
    // evidence about the question — so nothing is returned, not the closest one.
    expect(await queryKnowledge('policy', 'write an essay about cows', { embedFn: oneHot(1) })).toEqual([]);
    // The SAME question against a matching embedding still retrieves, so the
    // empty result above is the floor working, not retrieval being broken.
    const hits = await queryKnowledge('policy', 'when are invoices due', { embedFn: oneHot(0) });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].similarity).toBeCloseTo(1, 5);
  });

  it('lets a caller move the DENSE floor without changing retrieval itself', async () => {
    await seeded();
    // Run dense-only, because `minSimilarity` governs the DENSE half — the
    // hybrid lexical half is gated by term overlap instead (see the fusion
    // block), and a query that literally contains 'clause' is a lexical match
    // no matter how its vector scores.
    // 0.707 clears the default floor…
    expect((await queryKnowledge('policy', 'clause 4.2', { embedFn: mixed, fusion: 'dense' })).length).toBeGreaterThan(0);
    // …and a stricter floor drops it, which is what makes the threshold a
    // tuning knob against a real corpus rather than a hardcoded judgement.
    expect(
      (await queryKnowledge('policy', 'clause 4.2', { embedFn: mixed, minSimilarity: 0.9, fusion: 'dense' })).length,
    ).toBe(0);
    // A floor of 0 disables the filter (the orthogonal hit comes back).
    expect(
      (await queryKnowledge('policy', 'cows', { embedFn: oneHot(1), minSimilarity: 0, fusion: 'dense' })).length,
    ).toBeGreaterThan(0);
  });
});

/**
 * Re-ingest must be a REPLACEMENT, not a merge. Chunk ids are
 * `<tag>:<path>#<i>`, so a document that got shorter would otherwise leave its
 * retired tail in the namespace and keep answering from content the user has
 * already deleted.
 */
describe('re-ingesting a shorter document', () => {
  it('deletes the retired tail instead of leaving orphan chunks behind', async () => {
    const docPath = join(dir, 'spec.md');
    // `chunkText` splits at ~512 tokens × 4 chars — 40 paragraphs is several
    // chunks, well past the 1 chunk the replacement produces.
    const paragraph = `Paragraph: ${'lorem ipsum dolor sit amet '.repeat(20)}`;
    const long = Array.from({ length: 40 }, () => paragraph).join('\n\n');
    writeFileSync(docPath, long, 'utf-8');

    const first = await ingestKnowledge('spec', [docPath], { embedFn: constantEmbed });
    expect(first.chunks).toBeGreaterThan(1);

    writeFileSync(docPath, 'short version', 'utf-8');
    const second = await ingestKnowledge('spec', [docPath], { embedFn: constantEmbed });
    expect(second.chunks).toBe(1);

    // The store holds exactly the new version's chunks — no orphans.
    expect(await getVectorStore(namespaceForTag('spec')).count()).toBe(1);
    expect(getKnowledgeTag('spec')?.chunkCount).toBe(1);
    // And the retired text is unreachable through retrieval.
    const hits = await queryKnowledge('spec', 'lorem ipsum', { embedFn: constantEmbed });
    expect(hits.every((h) => !h.text.includes('lorem ipsum'))).toBe(true);
  });
});

/**
 * A failed embed used to write a zero vector, so a partially indexed document
 * read as fully indexed. It must now be skipped, reported, and recorded only
 * when something actually landed in the store.
 */
describe('embedding failures', () => {
  const failing = async (): Promise<number[]> => {
    throw new Error('embedding model unavailable');
  };

  it('reports the shortfall instead of indexing an empty document', async () => {
    const docPath = join(dir, 'a.txt');
    writeFileSync(docPath, 'some content', 'utf-8');

    const result = await ingestKnowledge('notes', [docPath], { embedFn: failing });
    expect(result.files).toBe(0);
    expect(result.chunks).toBe(0);
    // Exactly one reason, and it names embedding as the cause — a document that
    // indexed nothing is reported, not silently registered.
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('embedded');
    // Nothing was stored, and no phantom tag claims otherwise.
    expect(await getVectorStore(namespaceForTag('notes')).count()).toBe(0);
    expect(getKnowledgeTag('notes')).toBeNull();
  });
});

/**
 * Hybrid retrieval — dense + lexical, fused by rank (Phase 2.2–2.4).
 *
 * The point of the second retriever is that it fails on DIFFERENT questions
 * from the first: a user pasting an identifier, clause number or error code
 * shares a term with the passage that answers them, and the embedding can still
 * score that passage below the floor. These pin that the lexical half rescues
 * exactly that case, that it does NOT rescue an unrelated question, and that the
 * per-source cap stops one long document taking the whole result.
 */
describe('hybrid retrieval', () => {
  /** One-hot vectors: two different axes are exactly orthogonal (cosine 0). */
  const oneHot = (axis: number) => async (): Promise<number[]> => {
    const v = new Array(384).fill(0);
    v[axis] = 1;
    return v;
  };
  const constantEmbed = async (): Promise<number[]> => new Array(384).fill(0.1);

  it('rescues a term match the dense floor dropped — and only when hybrid is on', async () => {
    const docPath = join(dir, 'policy.md');
    writeFileSync(docPath, 'Clause 4.2: invoices are due within 30 days of receipt.', 'utf-8');
    await ingestKnowledge('policy', [docPath], { embedFn: oneHot(0) });

    // Query vector is ORTHOGONAL to the document, so dense scores 0 and the
    // floor drops it. The question is built out of the document's own words,
    // though, so the lexical half has something to match.
    const hybrid = await queryKnowledge('policy', 'clause 4.2', { embedFn: oneHot(1) });
    expect(hybrid).toHaveLength(1);
    expect(hybrid[0].text).toContain('Clause 4.2');
    // Provenance is recorded, so the citation can say WHY a below-floor passage
    // is being shown rather than leaving a low `sim` unexplained.
    expect(hybrid[0].evidence).toBe('term');
    const context = formatKnowledgeContext('policy', hybrid);
    expect(context).toContain('term match');

    // Proving it was the lexical half: with fusion off the same query is empty.
    expect(await queryKnowledge('policy', 'clause 4.2', { embedFn: oneHot(1), fusion: 'dense' })).toEqual([]);
  });

  it('still returns NOTHING for a question that shares no vocabulary', async () => {
    const docPath = join(dir, 'policy.md');
    writeFileSync(docPath, 'Clause 4.2: invoices are due within 30 days of receipt.', 'utf-8');
    await ingestKnowledge('policy', [docPath], { embedFn: oneHot(0) });
    // Neither half has evidence: the vector is orthogonal and there is no shared
    // content term. Adding a retriever must not add a leak.
    expect(await queryKnowledge('policy', 'write an essay about cows', { embedFn: oneHot(1) })).toEqual([]);
  });

  it('caps how much one source document may contribute to a multi-source result', async () => {
    // Document A: long, and every chunk matches the query term.
    const aPath = join(dir, 'a.md');
    const aBody = Array.from(
      { length: 30 },
      (_, i) => `alpha cluster ${i}: ${'lorem ipsum dolor sit amet '.repeat(60)}`,
    ).join('\n\n');
    writeFileSync(aPath, aBody, 'utf-8');
    // Document B: one short passage, also matching — it must still be reachable.
    const bPath = join(dir, 'b.md');
    writeFileSync(bPath, 'alpha beta reference.', 'utf-8');

    await ingestKnowledge('mixed', [aPath, bPath], { embedFn: constantEmbed });

    const hits = await queryKnowledge('mixed', 'alpha', { embedFn: constantEmbed, topK: 4 });
    const bySource = new Map<string, number>();
    for (const h of hits) bySource.set(h.sourcePath, (bySource.get(h.sourcePath) ?? 0) + 1);

    // No single document takes more than the default cap…
    for (const count of bySource.values()) expect(count).toBeLessThanOrEqual(3);
    // …and the shorter document is not crowded out by the longer one.
    expect(hits).toHaveLength(4);
    expect(new Set(hits.map((h) => h.sourcePath)).size).toBe(2);
  });

  it('does not truncate a single-document tag — the cap only promotes diversity', async () => {
    const aPath = join(dir, 'only.md');
    writeFileSync(
      aPath,
      Array.from({ length: 30 }, (_, i) => `alpha cluster ${i}: ${'lorem ipsum '.repeat(60)}`).join('\n\n'),
      'utf-8',
    );
    await ingestKnowledge('solo', [aPath], { embedFn: constantEmbed });
    const hits = await queryKnowledge('solo', 'alpha', { embedFn: constantEmbed, topK: 6 });
    // With one source there is no diversity to gain, so the cap is relaxed and
    // the tag returns the full top-k rather than three chunks of its own document.
    expect(hits.length).toBeGreaterThan(3);
  });
});

/** The policy half of the floor: relevance is measured, but a floor is a
 * heuristic, so the fallback has to be stated rather than left to chance. */
describe('formatKnowledgeContext', () => {
  it('tells the model what to do when the passages do not answer the question', () => {
    const context = formatKnowledgeContext('policy', [
      { tag: 'policy', text: 'Clause 4.2', sourcePath: '/docs/policy.md', chunkIndex: 0, similarity: 0.9 },
    ]);
    expect(context).toContain('do not answer the question');
    expect(context).toContain('never assert a fact');
    // The attribution the model needs in order to say which part is which.
    expect(context).toContain('from your data: policy.md');
  });
});
