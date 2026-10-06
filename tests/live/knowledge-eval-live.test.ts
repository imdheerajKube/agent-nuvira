/**
 * LIVE retrieval eval — the REAL numbers, and the calibration of the floor.
 *
 * GATED: nothing here runs in CI. The hermetic gate
 * (`tests/learning/knowledge-eval.test.ts`) measures the PIPELINE with a
 * deterministic bag-of-words vectorizer, because CI cannot download the ~130 MB
 * embedding model and a semantic claim needs a semantic embedder. This file is
 * the other half: the same corpus, the same questions, the actual model — and
 * therefore the only place where a similarity threshold means anything.
 *
 *   NUVIRA_LIVE_TESTS=1 npx vitest run tests/live/knowledge-eval-live.test.ts
 *
 * THE FLOOR IS MODEL-SPECIFIC, SO THE MEASUREMENT MUST BE ATTRIBUTABLE. Cosine
 * similarity is a property of the model that produced the vectors, and the
 * embedder is TIERED: if the local ONNX model cannot load it silently falls back
 * to a Python `all-MiniLM-L6-v2` subprocess — a DIFFERENT model on a different
 * similarity scale — and, failing that, to a zero vector. A floor calibrated
 * against the wrong tier is worse than an uncalibrated one, because it looks
 * measured. So this file begins by proving which model actually ran (an identity
 * probe comparing the shipped path against a direct call for `RETRIEVAL_MODEL`)
 * and FAILS LOUDLY if they disagree, rather than reporting numbers it cannot
 * attribute.
 *
 * What it answers, in order of usefulness:
 *
 *   1. Where is the separating band? `leakProbeMax` (the highest score any
 *      unrelated question reaches) must sit BELOW `relevantMin` (the lowest score
 *      a correct answer reaches), and `DEFAULT_KNOWLEDGE_MIN_SIMILARITY` must sit
 *      between them. This run prints both and asserts the shipped floor holds the
 *      line.
 *   2. recall@k / MRR / leak rate on real embeddings, and what the per-source cap
 *      costs in recall (measured at several caps, not argued).
 *   3. Whether a PARAPHRASE (no shared vocabulary) is retrieved — the thing the
 *      offline embedder provably cannot do, and the entire reason for using a
 *      trained model.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ingestKnowledge, queryKnowledge, DEFAULT_KNOWLEDGE_MIN_SIMILARITY } from '../../src/learning/knowledge-base.js';
import { embed, RETRIEVAL_MODEL } from '../../src/memory/embedder.js';
import { resetVectorBackendSelection } from '../../src/memory/vector-store.js';
import { runKnowledgeEval, sourceMatches } from '../../src/learning/knowledge-eval.js';
import { KNOWLEDGE_CORPUS, KNOWLEDGE_EVAL_CASES } from '../fixtures/knowledge-corpus.js';

const LIVE = process.env.NUVIRA_LIVE_TESTS === '1';
const TAG = 'live-corpus';

/** Paraphrases with no shared content vocabulary — a trained model's job. */
const PARAPHRASES: Array<{ question: string; expected: string }> = [
  { question: 'how long until a bill has to be settled after we receive it?', expected: 'billing-policy.md' },
  { question: 'what stops a stolen sign-in from being reused later?', expected: 'auth-design.md' },
  { question: 'how do we send traffic to a new release gradually?', expected: 'kubernetes-migration.md' },
];

/** Caps to measure the recall cost against — 3 is the shipped default. */
const CAP_SWEEP = [1, 2, 3, 6];

let dir = '';
const realMemoryDir = process.env.NUVIRA_MEMORY_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuvira-knowledge-live-'));
  process.env.NUVIRA_MEMORY_DIR = join(dir, 'memory');
  resetVectorBackendSelection();
});

afterEach(() => {
  if (realMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = realMemoryDir;
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!LIVE)('live knowledge eval — the real embedder', () => {
  /**
   * Prove the shipped embedder ran the model the floor is calibrated for.
   *
   * `embed(text, undefined, false, RETRIEVAL_MODEL)` prefers the local ONNX
   * model and falls back (Python MiniLM, then a zero vector) WITHOUT throwing,
   * so a mismatch here is the ONLY way to notice that a fallback silently
   * changed the scale underneath every number below.
   */
  async function assertShippedModelInUse(): Promise<void> {
    const probe = 'the shipped retrieval model identity probe';
    const viaShipped = await embed(probe, undefined, false, RETRIEVAL_MODEL);

    const { pipeline } = await import('@huggingface/transformers' as string);
    const extractor = await pipeline('feature-extraction', RETRIEVAL_MODEL);
    const direct = (await extractor(probe, { pooling: 'mean', normalize: true })).tolist()[0] as number[];

    const drift = viaShipped.reduce((max, v, i) => Math.max(max, Math.abs(v - direct[i])), 0);
    expect(
      drift,
      `The shipped embedder is NOT running ${RETRIEVAL_MODEL} (max component drift ${drift}). ` +
        'It fell back to another tier, so every similarity below is on a different scale and the ' +
        'floor cannot be calibrated from it.',
    ).toBeLessThan(1e-5);
  }

  it('calibrates the floor and measures what the per-source cap costs', async () => {
    await assertShippedModelInUse();

    const paths: string[] = [];
    for (const doc of KNOWLEDGE_CORPUS) {
      const path = join(dir, doc.name);
      writeFileSync(path, doc.content, 'utf-8');
      paths.push(path);
    }
    const ingested = await ingestKnowledge(TAG, paths);
    expect(ingested.files).toBe(KNOWLEDGE_CORPUS.length);

    // ── The band: score EVERYTHING (floor -1), uncapped, so the two numbers
    //    that bound the floor are measured rather than inferred. ──────────────
    const uncapped = { topK: 50, minSimilarity: -1, maxPerSource: 50 };
    const correctScores: number[] = [];
    const probeTopScores: number[] = [];
    let misses = 0;

    for (const c of KNOWLEDGE_EVAL_CASES) {
      const hits = await queryKnowledge(TAG, c.question, uncapped);
      if (c.unrelated) {
        probeTopScores.push(hits[0]?.similarity ?? 0);
        continue;
      }
      // An ADJACENT probe has no expected document by design, so it can neither
      // supply the correct-answer minimum nor count as a miss.
      if (!c.expectSources?.length) continue;
      const own = hits.filter((h) => sourceMatches(h.sourcePath, c.expectSources ?? []));
      if (own.length === 0) {
        misses += 1;
        continue;
      }
      correctScores.push(Math.max(...own.map((h) => h.similarity)));
    }

    const sortedCorrect = [...correctScores].sort((a, b) => a - b);
    const relevantMin = sortedCorrect[0] ?? 0;
    const leakProbeMax = Math.max(...probeTopScores);
    const suggestedFloor = Number(((leakProbeMax + relevantMin) / 2).toFixed(3));

    // ── What the cap costs: recall/MRR at the shipped floor for each cap. ─────
    const capped: Array<{ cap: number; recall: number; mrr: number; leak: number }> = [];
    for (const cap of CAP_SWEEP) {
      const report = await runKnowledgeEval(TAG, KNOWLEDGE_EVAL_CASES, { maxPerSource: cap, topK: 6 });
      capped.push({ cap, recall: report.recallAtK, mrr: report.mrr, leak: report.leakRate });
    }

    const paraphrase: Array<{ question: string; sim: number; found: boolean }> = [];
    for (const p of PARAPHRASES) {
      const hits = await queryKnowledge(TAG, p.question, { topK: 6, minSimilarity: -1 });
      const idx = hits.findIndex((h) => sourceMatches(h.sourcePath, [p.expected]));
      paraphrase.push({ question: p.question, sim: idx === -1 ? 0 : hits[idx].similarity, found: idx !== -1 });
    }

    console.log(
      [
        '\n  ── live knowledge eval (bge-small-en-v1.5) ──',
        `  separating band: leak-probe max ${leakProbeMax.toFixed(3)}  <  floor  <  correct min ${relevantMin.toFixed(3)}`,
        `    · suggested floor (midpoint) ${suggestedFloor} · shipped floor ${DEFAULT_KNOWLEDGE_MIN_SIMILARITY}` +
          ` · correct p50 ${sortedCorrect[Math.floor(sortedCorrect.length / 2)]?.toFixed(3)}`,
        `    · cases with no correct passage anywhere: ${misses}/${KNOWLEDGE_EVAL_CASES.filter((c) => c.expectSources?.length).length}`,
        '  per-source cap (topK 6):',
        ...capped.map((c) => `    · cap ${c.cap}: recall ${c.recall.toFixed(2)} · MRR ${c.mrr.toFixed(2)} · leak ${c.leak.toFixed(2)}`),
        '  paraphrase probes (no shared vocabulary):',
        ...paraphrase.map((p) => `    · ${p.found ? '✓' : '✗'} ${p.sim.toFixed(3)}  ${p.question}`),
        '',
      ].join('\n'),
    );

    // THE calibration assertion: the shipped floor must be above every leak
    // probe. This is the live counterpart of the hermetic leak gate, and it is
    // what makes the constant a measurement instead of a guess.
    expect(
      leakProbeMax,
      `an unrelated question scored ${leakProbeMax.toFixed(3)} — at or above the shipped floor ` +
        `${DEFAULT_KNOWLEDGE_MIN_SIMILARITY}, so it would be served as evidence. Raise the floor above this.`,
    ).toBeLessThan(DEFAULT_KNOWLEDGE_MIN_SIMILARITY);

    // And it must not sit above the correct answers, or it drops real ones.
    expect(
      relevantMin,
      `the lowest-scoring correct answer was ${relevantMin.toFixed(3)}, below the shipped floor ` +
        `${DEFAULT_KNOWLEDGE_MIN_SIMILARITY} — the floor is dropping relevant passages.`,
    ).toBeGreaterThan(DEFAULT_KNOWLEDGE_MIN_SIMILARITY);

    // A paraphrase must be reachable — the semantic claim only a real model can make.
    expect(paraphrase.every((p) => p.found)).toBe(true);
  });
});
