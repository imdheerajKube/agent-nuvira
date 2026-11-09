/**
 * Local cross-encoder reranker (`src/learning/reranker.ts`).
 *
 * WHY THIS EXISTS. A first-stage retriever optimises recall: BM25 or a dense
 * index returns a candidate pool. It cannot tell whether a candidate actually
 * answers the question, and hand-written stopword lists cannot either. A
 * cross-encoder reads the query and each passage together and scores relevance
 * directly, which is the missing precision stage.
 *
 * WHY IT IS OPTIONAL. The dependency is already optional in this repo
 * (`@huggingface/transformers`). If it is missing, the model cannot be loaded, or
 * the caller turns it off, this module returns `null`; the caller keeps the
 * lexical order rather than failing the search. The model is local, so document
 * text is not sent to a provider.
 *
 * The default model is a small MS MARCO cross-encoder. It is deliberately not a
 * large reranker: attachment search is an interactive path, and a compact model
 * that loads once and scores a bounded candidate pool is the useful trade.
 */

import { logger } from '../utils/logger.js';

export const DEFAULT_RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';

const MAX_QUERY_CHARS = 512;
const MAX_PASSAGE_CHARS = 2_000;

export interface RerankedPassage {
  index: number;
  score: number;
}

export interface RerankOptions {
  model?: string;
  maxChars?: number;
}

type Tokenizer = (text: string, options: Record<string, unknown>) => Promise<unknown>;
type CrossEncoder = (inputs: unknown) => Promise<{ logits: { data: ArrayLike<number> } }>;

interface RerankRuntime {
  tokenizer: Tokenizer;
  model: CrossEncoder;
}

let runtimePromise: Promise<RerankRuntime | null> | null = null;
let runtimeModel: string | null = null;

/**
 * The switch is ON when unset. `NUVIRA_ATTACHMENT_RERANK=0` is the explicit
 * escape hatch for a machine that cannot download or run the model.
 */
export function attachmentRerankEnabled(): boolean {
  const raw = process.env.NUVIRA_ATTACHMENT_RERANK;
  if (raw === undefined) return true;
  const value = raw.trim().toLowerCase();
  return !(value === '' || value === '0' || value === 'false' || value === 'off' || value === 'no');
}

async function loadRuntime(model: string): Promise<RerankRuntime | null> {
  try {
    const mod = (await import('@huggingface/transformers' as string)) as {
      AutoTokenizer: { from_pretrained: (id: string) => Promise<Tokenizer> };
      AutoModelForSequenceClassification: { from_pretrained: (id: string) => Promise<CrossEncoder> };
    };
    const [tokenizer, encoder] = await Promise.all([
      mod.AutoTokenizer.from_pretrained(model),
      mod.AutoModelForSequenceClassification.from_pretrained(model),
    ]);
    return { tokenizer, model: encoder };
  } catch (err) {
    logger.debug(
      `Local reranker unavailable (${model}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function getRuntime(model: string): Promise<RerankRuntime | null> {
  if (!runtimePromise || runtimeModel !== model) {
    runtimeModel = model;
    runtimePromise = loadRuntime(model);
  }
  return runtimePromise;
}

/** Test hook: forget the loaded model and the failed-load cache. */
export function resetRerankerCache(): void {
  runtimePromise = null;
  runtimeModel = null;
}

/**
 * Score each passage against the query. Returns `null` when reranking is off or
 * unavailable; returns one finite score per passage otherwise.
 */
export async function scorePassages(
  query: string,
  passages: string[],
  opts: RerankOptions = {},
): Promise<number[] | null> {
  if (!attachmentRerankEnabled()) return null;
  if (!query.trim() || passages.length === 0) return [];

  const runtime = await getRuntime(opts.model ?? DEFAULT_RERANK_MODEL);
  if (!runtime) return null;

  const maxChars = Math.max(200, opts.maxChars ?? MAX_PASSAGE_CHARS);
  const scores: number[] = [];
  try {
    for (const passage of passages) {
      const inputs = await runtime.tokenizer(query.slice(0, MAX_QUERY_CHARS), {
        text_pair: passage.slice(0, maxChars),
        padding: true,
        truncation: true,
      });
      const output = await runtime.model(inputs);
      const logits = Array.from(output.logits.data);
      // MS MARCO exports one relevance logit. A binary classifier exports two;
      // use the positive-minus-negative margin so both shapes work.
      const score = logits.length > 1 ? logits[1] - logits[0] : logits[0];
      scores.push(Number.isFinite(score) ? score : Number.NEGATIVE_INFINITY);
    }
    return scores;
  } catch (err) {
    logger.debug(`Local reranker failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Pure ordering step, separated so it is testable without a model. */
export function orderByScores(scores: number[]): RerankedPassage[] {
  return scores
    .map((score, index) => ({ index, score }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

/**
 * Apply an optional absolute relevance floor. A missing threshold means the
 * caller has not opted into the gate; a missing reranker result means the caller
 * should keep the lexical fallback rather than abstain.
 */
export function passesRerankThreshold(
  reranked: RerankedPassage[] | null,
  minScore: number | undefined,
): boolean {
  if (minScore === undefined || !Number.isFinite(minScore)) return true;
  // `null` means the model was unavailable, not that every passage was
  // irrelevant. Only a completed rerank can abstain.
  if (!reranked) return true;
  const top = reranked[0]?.score;
  return top !== undefined && top >= minScore;
}

/** Rerank a candidate list, or return `null` when the caller should keep lexical order. */
export async function rerankPassages(
  query: string,
  passages: string[],
  opts: RerankOptions = {},
): Promise<RerankedPassage[] | null> {
  const scores = await scorePassages(query, passages, opts);
  return scores ? orderByScores(scores) : null;
}
