/**
 * Lexical search (`src/learning/lexical-search.ts`) — BM25 over a candidate set.
 *
 * WHY. Embeddings answer "what is this about"; they are unreliable at "which
 * passage contains `ERR_TOKEN_FAMILY_REVOKED`". A user's own documents are full
 * of exactly that — identifiers, clause numbers, dates, error codes, product
 * names — and a question built from those words fails a dense retriever and is
 * trivial for a lexical one. That is why retrieval runs both and fuses them
 * rather than choosing: the two fail on different questions.
 *
 * WHY THERE IS NO PERSISTED INVERTED INDEX. The index is built from the
 * namespace's stored chunks at query time. That sounds wasteful, and it is the
 * deliberate trade: the chunks are ALREADY being scanned to compute cosine
 * against every vector (the JSON backend is an exact linear scan, and the
 * candidate set here is a user's document folder, not a web crawl), so a second
 * on-disk structure would buy asymptotics nobody needs while adding a NEW
 * consistency problem — an index that can drift out of step with the vectors
 * every time a document is re-ingested, deleted or forgotten. A rebuild every
 * query cannot drift. If a corpus ever grows past the point where this is the
 * bottleneck, the cache is the place to add one, and the test suite will say so.
 *
 * Also here: the tokenizer, shared with the eval so that "what counts as a term"
 * is one definition rather than two that can disagree.
 */

/** Function words carry no topic signal and inflate every score. */
export const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does',
  'for', 'from', 'has', 'have', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'me',
  'my', 'no', 'not', 'of', 'on', 'or', 'our', 'should', 'so', 'than', 'that',
  'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'up',
  'us', 'was', 'we', 'what', 'when', 'where', 'which', 'who', 'why', 'will',
  'with', 'you', 'your',
]);

/** Lowercased content tokens (length ≥ 3, not a stopword), in order. */
export function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

/** FNV-1a — small, fast, deterministic, and dependency-free. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** BM25 term-frequency saturation and length-normalisation. */
const K1 = 1.2;
const B = 0.75;

export interface LexicalDocument {
  id: string;
  text: string;
}

export interface LexicalHit {
  id: string;
  score: number;
}

/**
 * Rank documents against a query with Okapi BM25.
 *
 * A document scores only on terms it actually contains, so a query sharing no
 * vocabulary with any candidate returns nothing at all — which is what keeps an
 * unrelated question out even when the dense half is floored.
 *
 * The ordering is fully deterministic: equal scores fall back to the document id,
 * so a fixture corpus scores identically on every run.
 */
export function bm25Search(documents: LexicalDocument[], query: string, k: number): LexicalHit[] {
  const queryTerms = [...new Set(contentTokens(query))];
  if (queryTerms.length === 0 || documents.length === 0 || k <= 0) return [];

  const documentLengths = new Map<string, number>();
  /** term → docId → term frequency. */
  const postings = new Map<string, Map<string, number>>();
  let totalLength = 0;

  for (const doc of documents) {
    const tokens = contentTokens(doc.text);
    documentLengths.set(doc.id, tokens.length);
    totalLength += tokens.length;
    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    for (const [term, frequency] of frequencies) {
      let posting = postings.get(term);
      if (!posting) {
        posting = new Map();
        postings.set(term, posting);
      }
      posting.set(doc.id, frequency);
    }
  }

  const total = documents.length;
  const averageLength = totalLength / total || 1;
  const scores = new Map<string, number>();

  for (const term of queryTerms) {
    const posting = postings.get(term);
    if (!posting) continue;
    const documentFrequency = posting.size;
    // The standard BM25 idf: a term every document carries is worth ~nothing, a
    // term only one document carries is worth a lot.
    const idf = Math.log(1 + (total - documentFrequency + 0.5) / (documentFrequency + 0.5));
    for (const [docId, frequency] of posting) {
      const length = documentLengths.get(docId) ?? 0;
      const denominator = frequency + K1 * (1 - B + (B * length) / averageLength);
      const contribution = idf * ((frequency * (K1 + 1)) / denominator);
      scores.set(docId, (scores.get(docId) ?? 0) + contribution);
    }
  }

  return [...scores.entries()]
    .filter(([, score]) => score > 0)
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, k);
}
