/**
 * Knowledge retrieval EVAL (`src/learning/knowledge-eval.ts`).
 *
 * WHY THIS EXISTS. Everything else in this area is a judgement call — chunk
 * size, the relevance floor, dense-only vs hybrid — and a judgement call that is
 * never measured is just a preference. This module turns "is retrieval good?"
 * into three numbers:
 *
 *   - **recall@k** — of the questions with a known right document, how many
 *     actually retrieved it in the top k;
 *   - **MRR** — how high the right document landed (1.0 = always first);
 *   - **leak rate** — of the questions that have NO answer in the corpus, how
 *     many still came back with passages. This is the one that matters most for
 *     the "leak-proof" concern: a system that never leaks but never finds
 *     anything is useless, and a system that always finds something is leaking.
 *
 * It is deliberately PURE on the scoring side (`scoreKnowledgeEval` takes hits,
 * not a corpus) so the arithmetic can be tested without an embedder, and the
 * runner (`runKnowledgeEval`) is a thin loop over `queryKnowledge`.
 *
 * OFFLINE BY DEFAULT. `lexicalEmbed` is a deterministic bag-of-words embedder —
 * it hashes tokens into the same 384 dimensions the real model uses and
 * L2-normalizes, so cosine similarity means "shared vocabulary", exactly as a
 * real embedder means "shared meaning". It is not a semantic model and cannot
 * judge paraphrase, but it makes the PIPELINE's properties (floor, fusion,
 * ordering, diversity, leak) reproducible in CI with no ~130 MB download. The
 * real numbers come from `tests/live/knowledge-eval-live.test.ts`, which uses
 * the actual embedder and is opt-in, because a semantic claim needs a semantic
 * embedder and CI cannot have one.
 */

import { queryKnowledge, type KnowledgeHit, type KnowledgeOptions } from './knowledge-base.js';
// The tokenizer is imported, not copied: "what counts as a term" must be ONE
// definition shared with the lexical retriever, or the eval would measure a
// retrieval whose notion of a term had quietly diverged from its own.
import { contentTokens, fnv1a } from './lexical-search.js';

// ─── Cases ──────────────────────────────────────────────────────────────────

/**
 * What kind of question this is — and the distinction is the heart of the leak
 * measurement, because "returns nothing" is only the right answer for ONE of the
 * three.
 *
 *   - `relevant` — the corpus answers it; a miss is a recall failure.
 *   - `unrelated` — the corpus has nothing to do with it ("the capital of
 *     France" against a billing policy). Retrieving ANY passage is a LEAK, and
 *     it is the kind of leak that misleads: a passage presented as evidence for
 *     a question it cannot answer.
 *   - `adjacent` — shares a domain word while asking something the corpus does
 *     not cover ("how much tax do I owe on my salary?" against a document with a
 *     "Currency and tax" section). This is a DIFFERENT claim. Retrieving the
 *     adjacent section is defensible — it is genuinely the closest thing in the
 *     corpus — and what stops it becoming a wrong answer is the grounding policy
 *     in `formatKnowledgeContext`, not the floor. Counting it as a leak would
 *     force the floor up until real questions were dropped to hide a case the
 *     floor was never the right instrument for.
 */
export type KnowledgeEvalKind = 'relevant' | 'unrelated' | 'adjacent';

export interface KnowledgeEvalCase {
  /** Question put to the corpus. */
  question: string;
  /** Strict leak probe: nothing in the corpus should be returned. */
  unrelated?: boolean;
  /** Near-miss probe: may retrieve; reported, not asserted as empty. */
  adjacent?: boolean;
  /**
   * Documents a good answer must draw from. Matched on BASENAME, so a fixture
   * does not depend on where it was written.
   */
  expectSources?: string[];
}

export interface KnowledgeEvalCaseResult {
  question: string;
  kind: KnowledgeEvalKind;
  /** Passages returned (after the relevance floor). */
  hits: number;
  /** Did the top-k contain an expected document? */
  hit: boolean;
  /** 1/rank of the first expected document, 0 when none was found. */
  reciprocalRank: number;
}

export interface KnowledgeEvalReport {
  /** Questions with a known answer. */
  relevantCases: number;
  /** `recallAtK` over those cases, 0..1. */
  recallAtK: number;
  /** Mean reciprocal rank over those cases, 0..1. */
  mrr: number;
  /** Fraction of strictly UNRELATED questions that returned ≥1 passage. Target: 0. */
  leakRate: number;
  /** Fraction of ADJACENT questions that returned ≥1 passage. Reported, not gated. */
  adjacentRetrievalRate: number;
  /**
   * Passages returned on LEXICAL evidence alone — i.e. the cosine floor would
   * have dropped them and the term match is the only reason they are here.
   * Reported rather than gated: on a corpus whose questions share vocabulary
   * with their answers the dense half wins them anyway, and a zero here means
   * "this corpus did not need the second retriever", not "fusion is broken".
   * It exists so the contribution of the lexical half is a measured number
   * instead of an assumption.
   */
  termEvidenceHits: number;
  /** The k the run used. */
  k: number;
  perCase: KnowledgeEvalCaseResult[];
}

/** The gate. Tight enough to catch a regression, loose enough not to flap. */
export interface KnowledgeEvalThresholds {
  minRecallAtK: number;
  minMrr: number;
  maxLeakRate: number;
}

/**
 * Thresholds for the hermetic (offline) gate — MEASURED, then held.
 *
 * `maxLeakRate: 0` is a real assertion rather than an aspiration, and it is only
 * honest because the case taxonomy is split (see `KnowledgeEvalKind`). A question
 * that shares NO vocabulary with the corpus scores exactly zero under a fitted
 * bag-of-words embedder, so nothing clears any positive floor and the rate must
 * be 0 — if it ever stops being 0, retrieval has started returning passages for
 * questions it has no evidence about, which is the failure that matters.
 *
 * The questions that share a domain word with the corpus while asking something
 * it does not cover are tracked separately as `adjacentRetrievalRate`, because
 * whether they retrieve is a genuine judgement call about a genuinely closest
 * section, and forcing them to zero would only mean raising the floor until real
 * questions were dropped too.
 */
export const KNOWLEDGE_EVAL_THRESHOLDS: KnowledgeEvalThresholds = {
  minRecallAtK: 0.9,
  minMrr: 0.8,
  maxLeakRate: 0,
};

// ─── Scoring (pure) ─────────────────────────────────────────────────────────

/** True when a retrieved source path is one of the expected documents. */
export function sourceMatches(sourcePath: string, expected: string[]): boolean {
  const got = sourcePath.toLowerCase();
  return expected.some((e) => {
    const want = e.toLowerCase();
    return got === want || got.endsWith(`/${want}`) || got.endsWith(want);
  });
}

/**
 * Score a run. `hitsByCase` is positional with `cases` — the caller supplies
 * what retrieval actually returned, so this function is arithmetic only.
 */
export function scoreKnowledgeEval(
  cases: KnowledgeEvalCase[],
  hitsByCase: KnowledgeHit[][],
  k: number,
): KnowledgeEvalReport {
  const kindOf = (c: KnowledgeEvalCase): KnowledgeEvalKind =>
    c.unrelated ? 'unrelated' : c.adjacent ? 'adjacent' : 'relevant';

  const perCase: KnowledgeEvalCaseResult[] = cases.map((c, i) => {
    const hits = hitsByCase[i] ?? [];
    const kind = kindOf(c);
    if (kind !== 'relevant') {
      return { question: c.question, kind, hits: hits.length, hit: false, reciprocalRank: 0 };
    }
    const expected = c.expectSources ?? [];
    const rank = hits.findIndex((h) => sourceMatches(h.sourcePath, expected));
    const found = rank !== -1;
    return {
      question: c.question,
      kind,
      hits: hits.length,
      hit: found,
      reciprocalRank: found ? 1 / (rank + 1) : 0,
    };
  });

  const relevant = perCase.filter((r) => r.kind === 'relevant');
  const unrelated = perCase.filter((r) => r.kind === 'unrelated');
  const adjacent = perCase.filter((r) => r.kind === 'adjacent');
  const rate = (subset: KnowledgeEvalCaseResult[]) =>
    subset.length === 0 ? 0 : subset.filter((r) => r.hits > 0).length / subset.length;

  return {
    relevantCases: relevant.length,
    recallAtK: relevant.length === 0 ? 0 : relevant.filter((r) => r.hit).length / relevant.length,
    mrr: relevant.length === 0 ? 0 : relevant.reduce((sum, r) => sum + r.reciprocalRank, 0) / relevant.length,
    leakRate: rate(unrelated),
    adjacentRetrievalRate: rate(adjacent),
    termEvidenceHits: hitsByCase.flat().filter((h) => h.evidence === 'term').length,
    k,
    perCase,
  };
}

/** Human-readable reasons a report fails the gate. Empty means it passed. */
export function checkKnowledgeEval(
  report: KnowledgeEvalReport,
  thresholds: KnowledgeEvalThresholds = KNOWLEDGE_EVAL_THRESHOLDS,
): string[] {
  const failures: string[] = [];
  if (report.recallAtK < thresholds.minRecallAtK) {
    failures.push(`recall@${report.k} ${report.recallAtK.toFixed(2)} < ${thresholds.minRecallAtK}`);
  }
  if (report.mrr < thresholds.minMrr) {
    failures.push(`MRR ${report.mrr.toFixed(2)} < ${thresholds.minMrr}`);
  }
  if (report.leakRate > thresholds.maxLeakRate) {
    failures.push(`leak rate ${report.leakRate.toFixed(2)} > ${thresholds.maxLeakRate}`);
  }
  return failures;
}

// ─── Running ────────────────────────────────────────────────────────────────

/** Every case is asked against the same tag (the corpus is one tag). */
export async function runKnowledgeEval(
  tag: string,
  cases: KnowledgeEvalCase[],
  opts: KnowledgeOptions = {},
): Promise<KnowledgeEvalReport> {
  const hitsByCase: KnowledgeHit[][] = [];
  for (const c of cases) {
    hitsByCase.push(await queryKnowledge(tag, c.question, opts));
  }
  return scoreKnowledgeEval(cases, hitsByCase, opts.topK ?? 6);
}

// ─── The offline embedder ───────────────────────────────────────────────────

// `contentTokens` is re-exported so existing callers keep importing it from here.
export { contentTokens };

/**
 * A deterministic bag-of-words embedder FITTED ON THE CORPUS: inverse document
 * frequency over the corpus's own terms, sublinear term frequency, hashed into
 * the same 384 dimensions the real model uses, L2-normalized so the dot product
 * IS the cosine.
 *
 * Why fitted rather than a plain token count: an unfitted count gives every
 * document a magnitude that grows with its length, so a short question against
 * a long document scores near zero no matter how relevant it is — the right
 * answer would be outranked by, or fall below the floor with, the wrong one. A
 * fitted vectorizer puts the weight on the terms that DISTINGUISH documents, so
 * a question sharing three domain terms scores well above one sharing a single
 * incidental word. That is the behaviour the floor and the ranking are built to
 * reason about.
 *
 * A term the corpus has never seen carries NO evidence, so it contributes
 * nothing — which is what lets a question made of unknown words score exactly
 * zero rather than match by hash collision. This is the honest limit of the
 * model: it knows vocabulary, not meaning, and a paraphrase with no shared
 * terms is legitimately out of reach. The semantic claim is the live eval's job
 * (`tests/live/knowledge-eval-live.test.ts`); this one measures the pipeline.
 */
export function createKnowledgeEvalEmbedder(
  documents: string[],
  dimensions = 384,
): (text: string) => Promise<number[]> {
  const documentFrequency = new Map<string, number>();
  for (const doc of documents) {
    for (const token of new Set(contentTokens(doc))) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const totalDocuments = Math.max(documents.length, 1);
  const idf = (token: string): number => {
    const seen = documentFrequency.get(token);
    if (seen === undefined) return 0; // out of vocabulary → carries no evidence
    return Math.log(1 + totalDocuments / (1 + seen));
  };

  return async (text: string): Promise<number[]> => {
    const termFrequency = new Map<string, number>();
    for (const token of contentTokens(text)) {
      termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
    }
    const vector = new Array<number>(dimensions).fill(0);
    for (const [token, count] of termFrequency) {
      const weight = idf(token) * (1 + Math.log(count));
      if (weight === 0) continue;
      vector[fnv1a(token) % dimensions] += weight;
    }
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (magnitude === 0) return vector;
    return vector.map((v) => v / magnitude);
  };
}

/**
 * The floor the OFFLINE gate runs at.
 *
 * Deliberately not `DEFAULT_KNOWLEDGE_MIN_SIMILARITY`: the fitted bag-of-words
 * vectorizer works on a different similarity scale from a trained embedding
 * model, so the production default cannot be validated against it. What this
 * gate CAN pin is ordering and the leak behaviour; the production default is
 * calibrated in the live eval, where the real embedder sets the scale. Stating
 * the split is the point — a gate that quietly substituted a comfortable number
 * for the shipped one would be measuring nothing.
 */
export const KNOWLEDGE_EVAL_OFFLINE_MIN_SIMILARITY = 0.15;
