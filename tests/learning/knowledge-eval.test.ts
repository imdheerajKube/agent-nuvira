/**
 * The retrieval gate.
 *
 * Runs the fixed corpus through the REAL pipeline (extract → chunk → embed →
 * store → floored retrieve) with the deterministic offline embedder, then holds
 * recall@k, MRR and the leak rate to a threshold. A change to chunking, the
 * floor, fusion or the diversity cap that quietly makes retrieval worse fails
 * here rather than being noticed months later in an answer.
 *
 * The limits of this gate are stated rather than hidden: the offline embedder
 * knows vocabulary, not meaning, so these numbers measure the PIPELINE. The
 * semantic claim is measured by the opt-in live run
 * (`tests/live/knowledge-eval-live.test.ts`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ingestKnowledge } from '../../src/learning/knowledge-base.js';
import {
  checkKnowledgeEval,
  createKnowledgeEvalEmbedder,
  runKnowledgeEval,
  scoreKnowledgeEval,
  sourceMatches,
  KNOWLEDGE_EVAL_OFFLINE_MIN_SIMILARITY,
  KNOWLEDGE_EVAL_THRESHOLDS,
} from '../../src/learning/knowledge-eval.js';
import { DEFAULT_KNOWLEDGE_MIN_SIMILARITY } from '../../src/learning/knowledge-base.js';
import { resetVectorBackendSelection } from '../../src/memory/vector-store.js';
import { KNOWLEDGE_CORPUS, KNOWLEDGE_EVAL_CASES } from '../fixtures/knowledge-corpus.js';

const TAG = 'eval-corpus';
/** Fitted on the corpus, so ingest and query speak the same vocabulary. */
const embed = createKnowledgeEvalEmbedder(KNOWLEDGE_CORPUS.map((d) => d.content));

let dir = '';
const realMemoryDir = process.env.NUVIRA_MEMORY_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuvira-knowledge-eval-'));
  process.env.NUVIRA_MEMORY_DIR = join(dir, 'memory');
  resetVectorBackendSelection();
});

afterEach(() => {
  if (realMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = realMemoryDir;
  rmSync(dir, { recursive: true, force: true });
});

/** Write the fixture corpus and ingest it under one tag with the offline embedder. */
async function ingestCorpus(): Promise<void> {
  const paths: string[] = [];
  for (const doc of KNOWLEDGE_CORPUS) {
    const path = join(dir, doc.name);
    writeFileSync(path, doc.content, 'utf-8');
    paths.push(path);
  }
  const result = await ingestKnowledge(TAG, paths, { embedFn: embed });
  // Every document landed. On a SECOND ingest of the same folder the files are
  // unchanged and therefore not re-embedded — `unchanged` is where they land, so
  // the sanity check has to count both or it fails for the right behaviour.
  expect(result.files + result.unchanged).toBe(KNOWLEDGE_CORPUS.length);
}

describe('scoreKnowledgeEval — the arithmetic', () => {
  const cases = [
    { question: 'q1', expectSources: ['a.md'] },
    { question: 'q2', expectSources: ['b.md'] },
    { question: 'q3', unrelated: true },
  ];
  const hit = (path: string) => ({ tag: 't', text: '', sourcePath: `/docs/${path}`, chunkIndex: 0, similarity: 0.9 });

  it('counts recall and rank, and treats any passage for an unrelated ask as a leak', () => {
    const report = scoreKnowledgeEval(
      cases,
      [
        [hit('a.md')],        // found, first
        [],                   // missed
        [hit('a.md')],        // unrelated but returned a passage → leak
      ],
      6,
    );
    expect(report.relevantCases).toBe(2);
    expect(report.recallAtK).toBeCloseTo(0.5, 5);
    expect(report.mrr).toBeCloseTo(0.5, 5); // 1/1 for the hit, 0 for the miss
    expect(report.leakRate).toBe(1);
  });

  it('matches expected documents by basename, not by full path', () => {
    expect(sourceMatches('/home/u/docs/a.md', ['a.md'])).toBe(true);
    expect(sourceMatches('/home/u/docs/a.md', ['b.md'])).toBe(false);
    // A directory named like the document must not count as the document.
    expect(sourceMatches('/home/a.md/nested.md', ['a.md'])).toBe(false);
  });

  it('names every threshold a report breaks', () => {
    const bad = scoreKnowledgeEval(cases, [[], [], [hit('a.md')]], 6);
    const failures = checkKnowledgeEval(bad, { minRecallAtK: 0.9, minMrr: 0.9, maxLeakRate: 0 });
    expect(failures).toHaveLength(3);
    expect(failures.join(' ')).toContain('recall@6');
    expect(failures.join(' ')).toContain('leak rate');
  });
});

describe('the retrieval gate — the fixture corpus', () => {
  /** The ordering half: run at the offline embedder's own floor. */
  async function offlineReport() {
    await ingestCorpus();
    return runKnowledgeEval(TAG, KNOWLEDGE_EVAL_CASES, {
      embedFn: embed,
      minSimilarity: KNOWLEDGE_EVAL_OFFLINE_MIN_SIMILARITY,
    });
  }

  it('meets the recall, MRR and leak thresholds', async () => {
    const report = await offlineReport();

    // Printed so a regression shows the numbers, not just a threshold miss.
    console.log(
      `\n   recall@${report.k} ${report.recallAtK.toFixed(2)} · MRR ${report.mrr.toFixed(2)}` +
        ` · leak ${report.leakRate.toFixed(2)} · adjacent ${report.adjacentRetrievalRate.toFixed(2)}` +
        `\n   ${report.perCase.map((c) => `${c.kind === 'relevant' ? (c.hit ? '✓' : '✗') : '·'} ${c.question}`).join('\n   ')}\n`,
    );

    expect(checkKnowledgeEval(report)).toEqual([]);
    expect(report.relevantCases).toBeGreaterThan(0);
  });

  it('LEAKS NOTHING — an unrelated question never retrieves a passage', async () => {
    // The strict probes share no vocabulary with the corpus, and an unknown word
    // carries no evidence, so they score exactly zero and no floor admits them.
    // This is the claim the leak probe exists to make, at BOTH floors.
    for (const minSimilarity of [KNOWLEDGE_EVAL_OFFLINE_MIN_SIMILARITY, DEFAULT_KNOWLEDGE_MIN_SIMILARITY]) {
      await ingestCorpus();
      const report = await runKnowledgeEval(TAG, KNOWLEDGE_EVAL_CASES, { embedFn: embed, minSimilarity });
      expect(report.perCase.filter((c) => c.kind === 'unrelated' && c.hits > 0)).toEqual([]);
      expect(report.leakRate).toBe(0);
    }
  });

  it('reports the ADJACENT probes instead of pretending they cannot retrieve', async () => {
    // "how much tax do I owe on my salary in Ireland?" borrows one word from a
    // "Currency and tax" section. That section really is the closest thing in
    // the corpus, so it is allowed to come back — measured and PRINTED, not
    // asserted away. What stops it becoming a wrong answer is the grounding
    // policy in `formatKnowledgeContext`, which is asserted where it lives.
    const report = await offlineReport();
    const adjacent = report.perCase.filter((c) => c.kind === 'adjacent');
    expect(adjacent).toHaveLength(4);
    expect(report.adjacentRetrievalRate).toBeGreaterThanOrEqual(0);
    // Exactly AT the ceiling under hybrid retrieval: the lexical half now finds
    // the two probes that borrow a real corpus word ('tax', 'laptop') where the
    // dense half alone might have missed them. It is left at 0.5 rather than
    // relaxed, so a future change that makes retrieval looser still has to
    // justify itself — but the number is the point to watch, not a comfortable
    // margin.
    expect(report.adjacentRetrievalRate).toBeLessThanOrEqual(0.5);
    // …and an adjacent hit never counts as a leak.
    expect(report.leakRate).toBe(0);
  });

  it('still ranks correctly at the SHIPPED floor — the one that actually runs', async () => {
    // The ordering run uses a lower floor because the offline embedder's scale
    // is its own and its absolute values are not the model's. What must hold at
    // the shipped floor is the ORDERING: whatever clears it is the right
    // document. (The floor's absolute calibration is the live eval's job —
    // see DEFAULT_KNOWLEDGE_MIN_SIMILARITY.)
    await ingestCorpus();
    const report = await runKnowledgeEval(TAG, KNOWLEDGE_EVAL_CASES, {
      embedFn: embed,
      minSimilarity: DEFAULT_KNOWLEDGE_MIN_SIMILARITY,
    });
    // Whatever CLEARS the shipped floor is ranked first — no wrong document wins.
    // How much clears it is a separate matter, and a pointed one: on this
    // corpus more than half the correct answers score below 0.35, which is the
    // loudest possible argument that the floor needs calibrating against the
    // real embedder before it is trusted.
    const ranked = report.perCase.filter((c) => c.kind === 'relevant' && c.hits > 0);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((c) => c.reciprocalRank === 1)).toBe(true);
    expect(report.leakRate).toBe(0);
  });

  it('is deterministic — the same corpus and questions score the same twice', async () => {
    await ingestCorpus();
    const opts = { embedFn: embed, minSimilarity: KNOWLEDGE_EVAL_OFFLINE_MIN_SIMILARITY };
    const first = await runKnowledgeEval(TAG, KNOWLEDGE_EVAL_CASES, opts);
    const second = await runKnowledgeEval(TAG, KNOWLEDGE_EVAL_CASES, opts);
    expect(second).toEqual(first);
  });

  it('sanity: the thresholds are actually reachable, not vacuous', async () => {
    const report = await offlineReport();
    expect(report.recallAtK).toBeGreaterThanOrEqual(KNOWLEDGE_EVAL_THRESHOLDS.minRecallAtK);
    expect(report.mrr).toBeGreaterThanOrEqual(KNOWLEDGE_EVAL_THRESHOLDS.minMrr);
    expect(report.k).toBe(6);
  });
});

describe('the offline embedder', () => {
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

  it('weights the terms that distinguish documents, and ignores what it has never seen', async () => {
    const fitted = createKnowledgeEvalEmbedder([
      'invoices are payable within 30 days of receipt',
      'worker nodes and an ingress controller route traffic',
    ]);

    const query = await fitted('when are the invoices payable?');
    expect(query).toHaveLength(384);
    // The billing document beats the unrelated one…
    const billing = dot(query, await fitted('invoices are payable within 30 days of receipt'));
    const kubernetes = dot(query, await fitted('worker nodes and an ingress controller route traffic'));
    expect(billing).toBeGreaterThan(kubernetes);
    // …and a question in a vocabulary the corpus never used scores exactly zero,
    // rather than matching by hash collision.
    expect(dot(query, await fitted('what is the capital of France?'))).toBe(0);
  });
});
