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
  'with', 'would', 'could', 'might', 'must', 'may', 'shall', 'you', 'your',
]);

/**
 * Content words that are too common to prove relevance on their own. These are
 * deliberately NOT stopwords: `current version` should still rank on `current`
 * once `version` supplies specific evidence. But a query whose only matched
 * terms are these words gets no hit. The Bitcoin fixture shares only `current`
 * with the steering document; `Bitcoin` and `price` are absent, so without this
 * guard every lexical arm returned the passage.
 */
export const GENERIC_TERMS = new Set([
  'current', 'currently', 'recent', 'recently', 'latest', 'today', 'now',
  'price', 'cost',
]);

export function isGenericTerm(term: string): boolean {
  return GENERIC_TERMS.has(term);
}

/**
 * Conservative English form expansion for lexical matching.
 *
 * This is deliberately NOT a full stemmer. It only turns the common
 * inflection that actually hid a real passage (`applied` vs `apply` / `applies`)
 * into a small, deterministic candidate set. Both the attachment store and the
 * BM25 arms use it, so the benchmark measures the same behaviour the product
 * uses. Identifiers, stopwords, generic terms and words ending in `ss` are left
 * alone: `WH-8821`, `the`, `current`, `class` and `business` are not verbs.
 */
export function termVariants(term: string): string[] {
  const base = term.toLowerCase();
  if (base.length < 4 || !/^[a-z]+$/.test(base) || STOPWORDS.has(base) || isGenericTerm(base)) {
    return [base];
  }

  const out = new Set([base]);
  const add = (value: string): void => {
    if (value.length >= 3 && /^[a-z]+$/.test(value)) out.add(value);
  };

  // Only the y -> ies/ied/ying and plural families are expanded. The earlier
  // broad `-e/-ed/-ing` rules turned `France` and `capital` into spurious
  // matches and raised the synthetic leak rate to 60%.
  if (base.endsWith('ied') && base.length > 4) {
    const y = `${base.slice(0, -3)}y`;
    add(y);
    add(`${y.slice(0, -1)}ies`);
    add(`${y}ing`);
  } else if (base.endsWith('ies') && base.length > 4) {
    const y = `${base.slice(0, -3)}y`;
    add(y);
    add(`${y.slice(0, -1)}ied`);
    add(`${y}ing`);
  } else if (base.endsWith('ying') && base.length > 5) {
    const y = `${base.slice(0, -4)}y`;
    if (!y.endsWith('yy')) {
      add(y);
      add(`${y.slice(0, -1)}ied`);
      add(`${y.slice(0, -1)}ies`);
    }
  } else if (base.endsWith('y') && base.length > 3) {
    const stem = base.slice(0, -1);
    add(`${stem}ies`);
    add(`${stem}ied`);
    add(`${base}ing`);
  } else if (base.endsWith('s') && !base.endsWith('ss') && base.length > 3) {
    add(base.slice(0, -1));
  }

  return [...out];
}

/**
 * Function words that must never become a fuzzy target even if a caller hands
 * the ranker a pre-tokenized term. `world -> would` scored 0.800 on real prose;
 * `would` is not topic evidence, so a typo fallback must not turn a World Cup
 * question into a hit on a sentence that merely says "would".
 */
const FUZZY_BLOCKED = new Set([
  'would', 'could', 'might', 'must', 'may', 'shall', 'also', 'into', 'onto',
  'over', 'under', 'about', 'after', 'before', 'between', 'through', 'during',
  'without', 'within',
]);

/** Lowercased content tokens (length ≥ 3, not a stopword), in order. */
export function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

const TOKEN_PATTERN = /[a-z0-9]+(?:[._@+'-][a-z0-9]+)+|[a-z0-9]+/g;

function isIdentifierPart(token: string): boolean {
  // Keep a two-character part only when it is an identifier shape such as v3 or
  // s3. A bare number like 30 stays out, so ordinary prose keeps the same terms.
  return token.length >= 3 || (token.length === 2 && /[a-z]/.test(token) && /\d/.test(token));
}

/**
 * Identifier-aware tokens. A dotted, hyphenated or snake_case identifier is
 * emitted BOTH whole and split, so `v3.5.15`, `WH-8821` and
 * `ERR_DB_POOL_EXHAUSTED` are findable by the exact identifier as well as by
 * the words inside it. This is deliberately separate from `contentTokens`: the
 * baseline stays comparable while a caller opts into the upgrade.
 */
export function identifierTokens(text: string): string[] {
  const out: string[] = [];
  const matches = text.toLowerCase().match(TOKEN_PATTERN) ?? [];
  for (const token of matches) {
    if (/[._@+'-]/.test(token) && token.length >= 2 && !STOPWORDS.has(token)) {
      out.push(token);
    }
    for (const part of token.split(/[._@+'-]+/)) {
      if (isIdentifierPart(part) && !STOPWORDS.has(part)) out.push(part);
    }
  }
  return out;
}

/** Character-trigram Dice similarity, used only as a typo fallback. */
export function trigramSimilarity(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left === right) return 1;
  if (left.length < 3 || right.length < 3) return 0;

  const grams = (value: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (let i = 0; i < value.length - 2; i += 1) {
      const gram = value.slice(i, i + 3);
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    return counts;
  };

  const leftGrams = grams(left);
  const rightGrams = grams(right);
  let intersection = 0;
  let leftTotal = 0;
  let rightTotal = 0;
  for (const count of leftGrams.values()) leftTotal += count;
  for (const count of rightGrams.values()) rightTotal += count;
  for (const [gram, count] of leftGrams) {
    intersection += Math.min(count, rightGrams.get(gram) ?? 0);
  }
  // Dice, not Jaccard: a single inserted/deleted character changes a short
  // word's trigram union disproportionately. Dice keeps a clear typo like
  // idempotancy/idempotency above the fallback threshold while still rejecting
  // unrelated words such as france/finance.
  return leftTotal + rightTotal === 0 ? 0 : (2 * intersection) / (leftTotal + rightTotal);
}

/** Levenshtein distance, iterative and bounded to the two input lengths. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Similarity for a typo fallback: trigram Dice catches insertions/deletions,
 * while normalised edit distance catches a one-character substitution in a
 * short word such as latancy/latency that trigrams alone score too low.
 */
export function fuzzySimilarity(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left === right) return 1;
  const edit = 1 - editDistance(left, right) / Math.max(left.length, right.length);
  return Math.max(trigramSimilarity(left, right), edit);
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

export interface Bm25SearchOptions {
  /** Emit compound identifiers whole as well as split. */
  identifierAware?: boolean;
  /** Fall back to the closest spelling when a query term has no exact match. */
  fuzzy?: boolean;
  /** Minimum trigram Dice similarity for the fallback. */
  fuzzyThreshold?: number;
  /** Expand common inflections (`applied` -> `apply`/`applies`). */
  expandMorphology?: boolean;
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
export function bm25Search(
  documents: LexicalDocument[],
  query: string,
  k: number,
  options: Bm25SearchOptions = {},
): LexicalHit[] {
  const tokenize = options.identifierAware ? identifierTokens : contentTokens;
  const rawQueryTerms = [...new Set(tokenize(query))];
  const queryTerms = options.expandMorphology
    ? [...new Set(rawQueryTerms.flatMap((term) => termVariants(term)))]
    : rawQueryTerms;
  if (queryTerms.length === 0 || documents.length === 0 || k <= 0) return [];

  const documentLengths = new Map<string, number>();
  /** term → docId → term frequency. */
  const postings = new Map<string, Map<string, number>>();
  let totalLength = 0;

  for (const doc of documents) {
    const tokens = tokenize(doc.text);
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
  /** Documents with at least one non-generic query term. */
  const evidenceDocs = new Set<string>();

  const addTerm = (term: string, weight: number, evidence: boolean): void => {
    const posting = postings.get(term);
    if (!posting) return;
    if (evidence) for (const docId of posting.keys()) evidenceDocs.add(docId);
    const documentFrequency = posting.size;
    // The standard BM25 idf: a term every document carries is worth ~nothing, a
    // term only one document carries is worth a lot.
    const idf = Math.log(1 + (total - documentFrequency + 0.5) / (documentFrequency + 0.5));
    for (const [docId, frequency] of posting) {
      const length = documentLengths.get(docId) ?? 0;
      const denominator = frequency + K1 * (1 - B + (B * length) / averageLength);
      const contribution = idf * ((frequency * (K1 + 1)) / denominator);
      scores.set(docId, (scores.get(docId) ?? 0) + contribution * weight);
    }
  };

  for (const term of queryTerms) {
    if (postings.has(term)) {
      addTerm(term, 1, !isGenericTerm(term));
      continue;
    }
    // A generic word is not a typo candidate: expanding `current` toward a
    // different spelling would manufacture the exact evidence it cannot supply.
    if (!options.fuzzy || term.length < 4 || isGenericTerm(term)) continue;

    const threshold = options.fuzzyThreshold ?? 0.75;
    let bestTerm: string | null = null;
    let bestSimilarity = 0;
    for (const candidate of postings.keys()) {
      // A typo rarely changes the first letter or the word's length class.
      // These guards keep the fallback from scanning and scoring the whole
      // vocabulary of a large attachment on every query.
      if (candidate.length < 4 || candidate[0] !== term[0]) continue;
      if (FUZZY_BLOCKED.has(candidate) || FUZZY_BLOCKED.has(term)) continue;
      if (isGenericTerm(candidate)) continue;
      if (Math.abs(candidate.length - term.length) > 3) continue;
      const similarity = fuzzySimilarity(term, candidate);
      if (similarity > bestSimilarity ||
          (similarity === bestSimilarity && bestTerm !== null && candidate < bestTerm)) {
        bestTerm = candidate;
        bestSimilarity = similarity;
      }
    }
    // A typo is weaker evidence than an exact term, so the match is discounted
    // by its similarity rather than scored as if the spelling had been exact.
    if (bestTerm && bestSimilarity >= threshold) {
      addTerm(bestTerm, bestSimilarity * bestSimilarity, !isGenericTerm(bestTerm));
    }
  }

  return [...scores.entries()]
    .filter(([id, score]) => score > 0 && evidenceDocs.has(id))
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, k);
}
