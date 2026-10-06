/**
 * The HYBRID retrieval gate (`queryKnowledge` with dense + lexical fusion).
 *
 * THE CLAIM UNDER TEST is that retrieval runs two retrievers because they fail
 * on different questions — and this gate runs the pipeline against an embedder
 * that is BLIND TO THE IDENTIFIERS (`withoutIdentifiers`, the vocabulary a model
 * that never saw `ERR_KX7F_QZ2` would have). Under that embedder the dense half
 * scores the code-only question exactly zero, so a passage that comes back at
 * all came back from the keyword half. That turns "hybrid helps" from a design
 * argument into an assertion.
 *
 * It also pins the two properties that keep fusion from becoming a flood: the
 * per-source cap (one long document cannot take every slot) and the refusal
 * (a question with no shared vocabulary still returns nothing).
 *
 * Hermetic: temp memory dir, JSON vector backend, injectable deterministic
 * embedder — no model download, no network, no flake.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ingestKnowledge, queryKnowledge, DEFAULT_KNOWLEDGE_MAX_PER_SOURCE } from '../../src/learning/knowledge-base.js';
import { createKnowledgeEvalEmbedder, runKnowledgeEval } from '../../src/learning/knowledge-eval.js';
import { resetVectorBackendSelection } from '../../src/memory/vector-store.js';
import { HYBRID_CORPUS, HYBRID_CASES, withoutIdentifiers } from '../fixtures/knowledge-hybrid-corpus.js';

const TAG = 'hybrid-corpus';
/**
 * Fitted on the corpus with the identifiers REMOVED. Ingest and query use the
 * same vectorizer (they must — a similarity is only meaningful between vectors
 * from one model), and because the identifiers are out of its vocabulary they
 * carry zero weight: the dense half genuinely cannot see them.
 */
const embed = createKnowledgeEvalEmbedder(withoutIdentifiers(HYBRID_CORPUS));

let dir = '';
const realMemoryDir = process.env.NUVIRA_MEMORY_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuvira-knowledge-hybrid-'));
  process.env.NUVIRA_MEMORY_DIR = join(dir, 'memory');
  resetVectorBackendSelection();
});

afterEach(() => {
  if (realMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = realMemoryDir;
  rmSync(dir, { recursive: true, force: true });
});

/** Write the fixture corpus and ingest it under one tag. */
async function ingestCorpus(): Promise<void> {
  const paths: string[] = [];
  for (const doc of HYBRID_CORPUS) {
    const path = join(dir, doc.name);
    writeFileSync(path, doc.content, 'utf-8');
    paths.push(path);
  }
  const result = await ingestKnowledge(TAG, paths, { embedFn: embed });
  expect(result.files + result.unchanged).toBe(HYBRID_CORPUS.length);
}

/** Count hits per source path, for the cap assertion. */
function perSource(hits: Array<{ sourcePath: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const h of hits) counts.set(h.sourcePath, (counts.get(h.sourcePath) ?? 0) + 1);
  return counts;
}

describe('hybrid retrieval — the keyword half is load-bearing', () => {
  it('finds an identifier the dense half provably cannot see', async () => {
    await ingestCorpus();

    const hits = await queryKnowledge(TAG, 'ERR_KX7F_QZ2', { embedFn: embed });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].sourcePath.endsWith('service-runbook.md')).toBe(true);
    // The evidence label is the proof: this passage scored below the cosine
    // floor and is present because it CONTAINS the term.
    expect(hits[0].evidence).toBe('term');

    // …and the same question with the second retriever switched off returns
    // nothing at all, which is what "load-bearing" means here.
    expect(await queryKnowledge(TAG, 'ERR_KX7F_QZ2', { embedFn: embed, fusion: 'dense' })).toEqual([]);
  });

  it('still refuses a question the corpus shares no vocabulary with', async () => {
    await ingestCorpus();
    // Neither half has evidence: the terms are out of the fitted vocabulary
    // (dense) and absent from the text (lexical). Adding a retriever must not
    // add a leak.
    expect(await queryKnowledge(TAG, 'what is the capital of France?', { embedFn: embed })).toEqual([]);
    expect(await queryKnowledge(TAG, 'give me a recipe for a good pizza dough', { embedFn: embed })).toEqual([]);
  });
});

describe('hybrid retrieval — the per-source cap', () => {
  it('stops one long document from taking every slot', async () => {
    await ingestCorpus();

    // Matches all seven runbook sections ('err') AND the auth section
    // ('refresh token') — two sources in the pool, so the cap applies. The exact
    // ranking does not matter to the claim: whichever order fusion produces, the
    // runbook may not contribute more than the cap.
    const hits = await queryKnowledge(TAG, 'refresh token err', { embedFn: embed, topK: 6 });
    const counts = perSource(hits);

    const runbook = [...counts.entries()].find(([path]) => path.endsWith('service-runbook.md'));
    const auth = [...counts.entries()].find(([path]) => path.endsWith('auth-design.md'));

    expect(runbook?.[1]).toBe(DEFAULT_KNOWLEDGE_MAX_PER_SOURCE);
    // The shorter document is not crowded out by the longer one…
    expect(auth?.[1]).toBe(1);
    // …and every slot the cap authorises is still filled.
    expect(hits).toHaveLength(DEFAULT_KNOWLEDGE_MAX_PER_SOURCE + 1);
  });

  it('does not truncate a single-document tag — the cap only promotes diversity', async () => {
    // Only the runbook is ingested, so there is no diversity to gain and the cap
    // must relax rather than halve the tag's own results.
    const path = join(dir, HYBRID_CORPUS[0].name);
    writeFileSync(path, HYBRID_CORPUS[0].content, 'utf-8');
    await ingestKnowledge('runbook-only', [path], { embedFn: embed });

    const hits = await queryKnowledge('runbook-only', 'err', { embedFn: embed, topK: 6 });
    expect(hits.length).toBeGreaterThan(DEFAULT_KNOWLEDGE_MAX_PER_SOURCE);
    expect(hits.every((h) => h.sourcePath.endsWith('service-runbook.md'))).toBe(true);
  });
});

describe('hybrid retrieval — the eval gate', () => {
  it('retrieves every answer and leaks nothing, at the SHIPPED floor', async () => {
    await ingestCorpus();
    // No minSimilarity override: this is the floor that actually ships.
    const report = await runKnowledgeEval(TAG, HYBRID_CASES, { embedFn: embed });

    console.log(
      `\n   hybrid recall@${report.k} ${report.recallAtK.toFixed(2)} · MRR ${report.mrr.toFixed(2)}` +
        ` · leak ${report.leakRate.toFixed(2)} · term-evidence hits ${report.termEvidenceHits}\n`,
    );

    expect(report.recallAtK).toBe(1);
    expect(report.leakRate).toBe(0);
    // Proves the corpus exercised the second retriever rather than passing on
    // the dense half's vocabulary.
    expect(report.termEvidenceHits).toBeGreaterThan(0);
  });

  it('is deterministic — the same corpus and questions score the same twice', async () => {
    await ingestCorpus();
    const opts = { embedFn: embed };
    const first = await runKnowledgeEval(TAG, HYBRID_CASES, opts);
    const second = await runKnowledgeEval(TAG, HYBRID_CASES, opts);
    expect(second).toEqual(first);
  });
});
