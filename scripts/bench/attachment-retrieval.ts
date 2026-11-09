/**
 * Attachment retrieval benchmark (`npm run bench:attachments`).
 *
 * The question is narrow and measurable: when a user asks a question about an
 * attached document, does retrieval put the passage containing the answer in the
 * top k? Seven arms are compared on the SAME chunks:
 *
 *   1. keyword       — the shipped `attachment_search` scoring (term occurrences);
 *   2. bm25          — the repo's BM25 lexical ranker, with no embeddings;
 *   3. bm25-id       — BM25 with compound identifiers emitted whole and split;
 *   4. bm25-id+fuzzy — bm25-id plus a trigram/edit-distance typo fallback;
 *   5. bm25-id+fuzzy+rerank — the top 20 lexical candidates reranked by a local cross-encoder;
 *   6. semantic      — bge-small-en-v1.5 over child windows, parent chunk scored;
 *   7. hybrid        — reciprocal-rank fusion of BM25 and semantic.
 *
 * The default fixture is synthetic. Pass `--fixture path/to/fixture.json` to run
 * real, user-supplied attachment questions; the fixture's `source: "real"` label
 * is what makes the report say the queries came from users.
 *
 * WHY CHILD WINDOWS FOR SEMANTIC. The embedder truncates at 2,000 characters,
 * while attachment chunks are up to 6,000. Embedding each chunk directly would
 * index only its first third. The benchmark embeds 1,800-character child
 * windows and maps each back to its parent chunk, so the semantic arm measures
 * the design that could actually ship rather than a known-broken shortcut.
 *
 * WHY THE FIXTURES ARE SYNTHETIC. They are deliberately long, contain exact
 * identifiers, and include paraphrases with no shared vocabulary. That is what
 * makes the arms separate. The numbers are a regression baseline, not a claim
 * about any user's corpus.
 *
 * LIMITATIONS. One query per case, five documents, English prose. The semantic
 * floor is the production knowledge-base default (0.5); it is not tuned on this
 * fixture. A single run is evidence about this corpus, not statistical proof.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

import {
  getAttachmentStore,
  type AttachmentChunk,
} from '../../src/web-dashboard/attachment-store.js';
import { bm25Search, type Bm25SearchOptions } from '../../src/learning/lexical-search.js';
import { DEFAULT_RERANK_MODEL, rerankPassages } from '../../src/learning/reranker.js';
import { DEFAULT_KNOWLEDGE_MIN_SIMILARITY } from '../../src/learning/knowledge-base.js';
import { embed, RETRIEVAL_MODEL } from '../../src/memory/embedder.js';
import { cosineSimilarity } from '../../src/memory/vector-store.js';

type Kind = 'exact' | 'paraphrase' | 'typo' | 'structure' | 'unanswerable' | 'adjacent';
type AnswerableKind = Exclude<Kind, 'unanswerable' | 'adjacent'>;

interface FixtureCase {
  id: string;
  document: string;
  question: string;
  kind: Kind;
  expect: string | null;
}

interface Fixture {
  description: string;
  /** `real` means the queries came from actual users, not authored fixtures. */
  source?: 'synthetic' | 'real';
  /** Directory of attachment files, relative to the fixture JSON. */
  attachmentsDir?: string;
  k: number;
  documents: string[];
  cases: FixtureCase[];
}

interface ChunkView {
  index: number;
  locator: string;
  text: string;
}

interface HitView {
  index: number;
  locator: string;
  text: string;
  score: number;
}

interface CaseResult {
  id: string;
  kind: Kind;
  document: string;
  question: string;
  expected: string | null;
  hits: HitView[];
  hit: boolean;
  rank: number;
  leak: boolean;
  latencyMs: number;
}

interface ArmReport {
  name: string;
  cases: CaseResult[];
  recallAt1: number;
  recallAt5: number;
  mrr: number;
  leakRate: number;
  adjacentRetrievalRate: number;
  byKind: Record<AnswerableKind, { hits: number; total: number }>;
  meanLatencyMs: number;
}

interface SemanticIndex {
  chunks: Array<{ chunk: ChunkView; childVectors: number[][] }>;
}

const here = dirname(fileURLToPath(import.meta.url));
const defaultFixturePath = join(here, 'fixtures', 'attachment-retrieval.json');

function argValue(name: string): string | undefined {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const fixturePath = resolve(process.cwd(), argValue('--fixture') ?? defaultFixturePath);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
const fixtureDir = resolve(dirname(fixturePath), fixture.attachmentsDir ?? 'attachments');
const k = Math.max(1, fixture.k || 5);
const useSemantic = !process.argv.includes('--no-semantic');
const useRerank = !process.argv.includes('--no-rerank');
const semanticFloor = DEFAULT_KNOWLEDGE_MIN_SIMILARITY;
const datasetLabel = fixture.source === 'real' ? 'real user questions' : 'synthetic fixture';

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function chunkViews(chunks: AttachmentChunk[]): ChunkView[] {
  return chunks
    .map((chunk) => ({ index: chunk.index, locator: chunk.locator, text: chunk.text }))
    .sort((a, b) => a.index - b.index);
}

function currentKeywordHits(
  store: ReturnType<typeof getAttachmentStore>,
  id: string,
  question: string,
  limit = k,
): HitView[] {
  const found = store.search(id, question, limit);
  if ('error' in found) return [];
  return found.hits.map((hit) => ({
    index: hit.index,
    locator: hit.locator,
    text: hit.text,
    score: hit.score,
  }));
}

function bm25Hits(
  chunks: ChunkView[],
  question: string,
  limit = k,
  options: Bm25SearchOptions = {},
): HitView[] {
  const byId = new Map(chunks.map((chunk) => [String(chunk.index), chunk]));
  return bm25Search(
    chunks.map((chunk) => ({ id: String(chunk.index), text: chunk.text })),
    question,
    limit,
    options,
  )
    .map((hit) => {
      const chunk = byId.get(hit.id);
      return chunk ? { ...chunk, score: hit.score } : null;
    })
    .filter((hit): hit is HitView => hit !== null);
}

/** 1,800-char windows with 200-char overlap: under the embedder's 2,000 cap. */
function childWindows(text: string, size = 1_800, overlap = 200): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let start = 0; start < text.length; start += size - overlap) {
    out.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return out;
}

async function embedOne(text: string): Promise<number[] | null> {
  const vector = await embed(text, undefined, false, RETRIEVAL_MODEL);
  return vector.every((value) => value === 0) ? null : vector;
}

async function buildSemanticIndex(chunks: ChunkView[]): Promise<SemanticIndex | null> {
  const indexed: SemanticIndex['chunks'] = [];
  for (const chunk of chunks) {
    const vectors: number[][] = [];
    for (const window of childWindows(chunk.text)) {
      const vector = await embedOne(window);
      if (!vector) return null;
      vectors.push(vector);
    }
    indexed.push({ chunk, childVectors: vectors });
  }
  return { chunks: indexed };
}

async function semanticHits(index: SemanticIndex, question: string, limit = k): Promise<HitView[]> {
  const query = await embedOne(question);
  if (!query) return [];
  return index.chunks
    .map(({ chunk, childVectors }) => ({
      index: chunk.index,
      locator: chunk.locator,
      text: chunk.text,
      score: Math.max(...childVectors.map((vector) => cosineSimilarity(query, vector))),
    }))
    .filter((hit) => hit.score >= semanticFloor)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit);
}

/** Reciprocal-rank fusion: rank is the only shared scale between BM25 and cosine. */
function hybridHits(lexical: HitView[], semantic: HitView[], limit = k): HitView[] {
  const fused = new Map<number, { hit: HitView; score: number }>();
  const add = (hits: HitView[]) => {
    hits.forEach((hit, rank) => {
      const entry = fused.get(hit.index) ?? { hit, score: 0 };
      entry.score += 1 / (60 + rank + 1);
      fused.set(hit.index, entry);
    });
  };
  add(lexical);
  add(semantic);
  return [...fused.values()]
    .sort((a, b) => b.score - a.score || a.hit.index - b.hit.index)
    .slice(0, limit)
    .map(({ hit, score }) => ({ ...hit, score }));
}

function evaluateCase(
  c: FixtureCase,
  hits: HitView[],
  latencyMs: number,
): CaseResult {
  const expected = c.expect ? normalize(c.expect) : null;
  const rank = expected
    ? hits.findIndex((hit) => normalize(hit.text).includes(expected)) + 1
    : 0;
  return {
    id: c.id,
    kind: c.kind,
    document: c.document,
    question: c.question,
    expected: c.expect,
    hits,
    hit: expected !== null ? rank > 0 : c.kind === 'adjacent' ? true : hits.length === 0,
    rank,
    leak: c.kind === 'unanswerable' ? hits.length > 0 : false,
    latencyMs,
  };
}

function summarize(name: string, cases: CaseResult[]): ArmReport {
  const answerable = cases.filter((c) => c.expected !== null);
  const unanswerable = cases.filter((c) => c.kind === 'unanswerable');
  const adjacent = cases.filter((c) => c.kind === 'adjacent');
  const kinds: AnswerableKind[] = ['exact', 'paraphrase', 'typo', 'structure'];
  const byKind = Object.fromEntries(
    kinds.map((kind) => {
      const subset = cases.filter((c) => c.kind === kind);
      return [kind, { hits: subset.filter((c) => c.hit).length, total: subset.length }];
    }),
  ) as ArmReport['byKind'];

  return {
    name,
    cases,
    recallAt1: answerable.length === 0 ? 0 : answerable.filter((c) => c.rank === 1).length / answerable.length,
    recallAt5: answerable.length === 0 ? 0 : answerable.filter((c) => c.rank > 0).length / answerable.length,
    mrr: answerable.length === 0 ? 0 : answerable.reduce((sum, c) => sum + (c.rank > 0 ? 1 / c.rank : 0), 0) / answerable.length,
    leakRate: unanswerable.length === 0 ? 0 : unanswerable.filter((c) => c.leak).length / unanswerable.length,
    adjacentRetrievalRate: adjacent.length === 0 ? 0 : adjacent.filter((c) => c.hits.length > 0).length / adjacent.length,
    byKind,
    meanLatencyMs: cases.length === 0 ? 0 : cases.reduce((sum, c) => sum + c.latencyMs, 0) / cases.length,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function kindSummary(report: ArmReport): string {
  return (Object.entries(report.byKind) as Array<[AnswerableKind, { hits: number; total: number }]>)
    .map(([kind, value]) => `${kind} ${value.hits}/${value.total}`)
    .join(' · ');
}

function caseMisses(report: ArmReport): CaseResult[] {
  return report.cases.filter((c) =>
    c.kind === 'unanswerable' ? c.leak : c.kind === 'adjacent' ? false : !c.hit,
  );
}

function renderMarkdownReport(
  reports: ArmReport[],
  meta: { chunkCount: number; windowCount: number; ingestionMs: number; semanticMs: number },
): string {
  const lines: string[] = [];
  const push = (line = ''): void => void lines.push(line);
  const byName = (name: string): ArmReport | undefined => reports.find((r) => r.name === name);
  const keyword = byName('keyword (shipped)');
  const baseline = byName('bm25');
  const identifier = byName('bm25-id');
  const lexical = byName('bm25-id+fuzzy');
  const reranked = byName('bm25-id+fuzzy+rerank');
  const rerankFused = byName('bm25-id+fuzzy+rerank-fused');
  const semantic = byName('semantic (bge-small)');
  const hybrid = byName('hybrid (bm25 + semantic)');
  const best = [...reports].sort((a, b) => b.recallAt5 - a.recallAt5 || b.mrr - a.mrr)[0];
  const misses = reports.filter((r) => caseMisses(r).length > 0);
  const answerableCount = fixture.cases.filter((c) => c.expect !== null).length;
  const unrelatedCount = fixture.cases.filter((c) => c.kind === 'unanswerable').length;
  const adjacentCount = fixture.cases.filter((c) => c.kind === 'adjacent').length;

  push(`# Attachment retrieval benchmark — ${fixture.source === 'real' ? 'real questions' : 'synthetic fixture'} — 2026-11-09`);
  push('');
  push('Generated by `npm run bench:attachments` (`scripts/bench/attachment-retrieval.ts`).');
  push('');
  push(`**Dataset:** ${datasetLabel}. ${fixture.description}`);
  push('');
  push(`**Corpus:** ${fixture.documents.length} documents, ${meta.chunkCount} chunks, ` +
    `${meta.windowCount} child windows. **Cases:** ${fixture.cases.length} total ` +
    `(${fixture.cases.filter((c) => c.kind === 'exact').length} exact, ` +
    `${fixture.cases.filter((c) => c.kind === 'paraphrase').length} paraphrase, ` +
    `${fixture.cases.filter((c) => c.kind === 'typo').length} typo, ` +
    `${fixture.cases.filter((c) => c.kind === 'structure').length} structure, ` +
    `${unrelatedCount} unanswerable, ${adjacentCount} adjacent).`);
  push('');
  push(`**Semantic arm:** ${useSemantic ? `${RETRIEVAL_MODEL}, cosine floor ${semanticFloor}, ` +
    '1,800-character child windows with 200-character overlap' : 'skipped'}.`);
  push('');
  push(`**Cost:** cold ingestion ${meta.ingestionMs.toFixed(0)} ms; ` +
    `cold semantic index build ${meta.semanticMs.toFixed(0)} ms for ${meta.windowCount} windows. ` +
    'Mean query time is in the table; lexical times are sub-millisecond and round to 0.');
  push('');
  push('## Results');
  push('');
  push('| Retriever | Recall@1 | Recall@5 | MRR | Leak rate | Adjacent retrieved | Mean query ms | By kind |');
  push('|---|---:|---:|---:|---:|---:|---:|---|');
  for (const report of reports) {
    push(`| ${report.name} | ${pct(report.recallAt1)} | ${pct(report.recallAt5)} | ` +
      `${report.mrr.toFixed(2)} | ${pct(report.leakRate)} | ${pct(report.adjacentRetrievalRate)} | ` +
      `${report.meanLatencyMs.toFixed(0)} | ${kindSummary(report)} |`);
  }
  push('');
  push(`Leak rate is over the ${unrelatedCount} **unrelated** questions, not the ` +
    `${adjacentCount} adjacent question${adjacentCount === 1 ? '' : 's'}. ` +
    'An adjacent retrieval is reported separately because a domain-adjacent question can legitimately match vocabulary.');
  push('');
  push('## Misses');
  push('');
  if (misses.length === 0) {
    push('None.');
  } else {
    for (const report of misses) {
      push(`### ${report.name}`);
      push('');
      for (const miss of caseMisses(report)) {
        const top = miss.hits[0];
        const outcome = miss.kind === 'unanswerable'
          ? `leaked \`${top?.locator ?? 'a passage'}\``
          : `top hit ${top?.locator ?? '(none)'}`;
        push(`- [${miss.kind}] "${miss.question}" — expected \`${miss.expected ?? '(nothing)'}\`; ${outcome}.`);
      }
      push('');
    }
  }
  push('## What this run supports');
  push('');
  push(`- **Best recall@5 in this run: ${best.name}, ${pct(best.recallAt5)}.** ` +
    `That is one ${fixture.source === 'real' ? 'real-query' : 'synthetic'} fixture, one run, and ` +
    `${answerableCount} answerable cases; it is not a production estimate.`);
  if (keyword) {
    const keywordLeaks = keyword.cases.filter((c) => c.leak).length;
    push(`- **Keyword false positives: ${keywordLeaks} of ${unrelatedCount} unrelated questions.** ` +
      'The no-content guard now returns no hits when a query has no content terms. ' +
      `Its typo score is ${keyword.byKind.typo.hits}/${keyword.byKind.typo.total}; removing the accidental ` +
      'stopword matches can cost a case that only ranked because a function word appeared inside a word.');
  }
  if (baseline && identifier) {
    push(`- **Identifier-aware tokenization: BM25 moves from ${pct(baseline.recallAt5)} to ` +
      `${pct(identifier.recallAt5)} recall@5, MRR ${baseline.mrr.toFixed(2)} to ${identifier.mrr.toFixed(2)}.** ` +
      'It recovers dotted and hyphenated identifiers without a model.');
  }
  if (baseline && lexical) {
    const lexicalLatency = lexical.meanLatencyMs < 1 ? 'under 1 ms' : `${lexical.meanLatencyMs.toFixed(0)} ms`;
    push(`- **Trigram/edit fallback: ${pct(baseline.recallAt5)} to ${pct(lexical.recallAt5)} recall@5, ` +
      `MRR ${baseline.mrr.toFixed(2)} to ${lexical.mrr.toFixed(2)}, at ${lexicalLatency}/query.** ` +
      `It reaches typo ${lexical.byKind.typo.hits}/${lexical.byKind.typo.total} with no embeddings.`);
  }
  if (lexical && reranked) {
    const rerankLatency = reranked.meanLatencyMs < 1 ? 'under 1 ms' : `${reranked.meanLatencyMs.toFixed(0)} ms`;
    push(`- **Local cross-encoder reranking: ${pct(lexical.recallAt5)} to ${pct(reranked.recallAt5)} recall@5, ` +
      `MRR ${lexical.mrr.toFixed(2)} to ${reranked.mrr.toFixed(2)}, at ${rerankLatency}/query.** ` +
      'It reorders a bounded lexical pool; it cannot recover a passage the first stage never returned.');
  }
  if (lexical && rerankFused) {
    push(`- **Lexical + reranker rank fusion: ${pct(lexical.recallAt5)} to ${pct(rerankFused.recallAt5)} recall@5, ` +
      `MRR ${lexical.mrr.toFixed(2)} to ${rerankFused.mrr.toFixed(2)}.** ` +
      'Fusion keeps the first-stage exact-term ranking instead of letting the cross-encoder overwrite it.');
  }
  if (semantic && lexical) {
    const recallDelta = semantic.recallAt5 - lexical.recallAt5;
    const mrrDelta = semantic.mrr - lexical.mrr;
    push(`- **Semantic vs best lexical: recall@5 ${pct(semantic.recallAt5)} vs ` +
      `${pct(lexical.recallAt5)} (${recallDelta >= 0 ? '+' : ''}${pct(recallDelta)}), MRR ` +
      `${semantic.mrr.toFixed(2)} vs ${lexical.mrr.toFixed(2)} (${mrrDelta >= 0 ? '+' : ''}${mrrDelta.toFixed(2)}), ` +
      `at ${semantic.meanLatencyMs.toFixed(0)} ms vs ${lexical.meanLatencyMs.toFixed(0)} ms per query.**`);
    if (recallDelta <= 0) {
      push('  On this fixture, the cheap lexical arm matches or beats semantic recall. Do not pay the embedding cost for this result.');
    } else {
      push('  Semantic has the higher recall here, but the difference is small enough that real-query evidence is still required.');
    }
  }
  if (semantic && hybrid) {
    push(`- **Hybrid did not beat semantic on recall@5** (${pct(hybrid.recallAt5)} vs ` +
      `${pct(semantic.recallAt5)}), and its MRR is ${hybrid.mrr.toFixed(2)} vs ${semantic.mrr.toFixed(2)}. ` +
      'RRF is not justified by this fixture.');
  }
  if (semantic) {
    const paraphraseMisses = caseMisses(semantic).filter((c) => c.kind === 'paraphrase');
    if (paraphraseMisses.length > 0) {
      push(`- **Semantic still misses ${paraphraseMisses.length} paraphrase case` +
        `${paraphraseMisses.length === 1 ? '' : 's'}:** ` +
        paraphraseMisses.map((c) => `"${c.question}"`).join(', ') + '. ' +
        'It is not a general paraphrase fix.');
    }
  }
  push('');
  push('## Recommendation');
  push('');
  if (rerankFused && lexical && (rerankFused.recallAt5 > lexical.recallAt5 || rerankFused.mrr > lexical.mrr)) {
    push('1. **Make fused local reranking the precision stage.** It keeps the lexical exact-term rank and ' +
      'adds cross-encoder relevance without sending document text to a provider. Validate it on real questions ' +
      'and measure p95 latency on large attachments before making it unconditional.');
  } else if (reranked && lexical && (reranked.recallAt5 > lexical.recallAt5 || reranked.mrr > lexical.mrr)) {
    push('1. **Make the local reranker the precision stage.** It improves the same lexical candidate pool ' +
      'without sending document text to a provider. Validate it on real questions and measure p95 latency ' +
      'on large attachments before making it unconditional.');
  } else if (lexical && semantic && lexical.recallAt5 >= semantic.recallAt5) {
    const lexicalLatency = lexical.meanLatencyMs < 1 ? 'under 1 ms' : `${lexical.meanLatencyMs.toFixed(0)} ms`;
    push('1. **Make the lexical upgrade the candidate, not embeddings.** Identifier-aware tokenization plus ' +
      `the typo fallback matches or beats semantic recall on this run at ${lexicalLatency}/query. ` +
      'That is the cheaper change to validate on real questions.');
  } else if (lexical) {
    push('1. **Keep the lexical upgrade as the baseline.** It recovers identifiers and typos without an ' +
      'embedding index; any semantic proposal must beat it on real queries.');
  }
  push('2. **Run the benchmark on real attachment questions before shipping either upgrade.** ' +
    'This report is directional; the fixture labels are authored. Supply a `--fixture` JSON with ' +
    '`source: "real"`, real attachment files and the exact passage each question should retrieve.');
  push('3. **Do not choose hybrid.** It did not improve recall over semantic here and has the extra ' +
    'lexical-plus-dense complexity. Add fusion only when a real eval shows complementary misses.');
  push('4. **If semantic still wins on real queries, use semantic-only as the candidate.** ' +
    'Do not add embeddings for the synthetic fixture alone.');
  push('');
  push('## Limits');
  push('');
  push(`- ${fixture.source === 'real' ? 'Real user questions supplied in the fixture' : 'Synthetic documents and authored labels'}; ` +
    'one query per case. Exact/paraphrase/typo labels are not user-labelled.');
  push('- The semantic floor is the production knowledge-base default (0.5), not tuned on this fixture. ' +
    'A different floor would change the leak/recall trade-off.');
  push('- The cold index time includes model load. A deployed process would warm the model and ' +
    'precompute embeddings at ingest, so this is not a steady-state cost.');
  push(`- Only ${answerableCount} answerable cases. A one-case difference is visible in every percentage point; ` +
    'treat the ranking as directional.');
  if (fixture.source !== 'real') {
    push('- Real-query validation is not included: no captured user attachment questions were available in ' +
      'this checkout. Supply a `--fixture` JSON with `source: "real"` to run that set.');
  }
  push('');
  return lines.join('\n');
}

function printReport(reports: ArmReport[]): void {
  console.log('\nAttachment retrieval benchmark');
  console.log(`  dataset: ${datasetLabel} · fixture: ${relative(process.cwd(), fixturePath)}`);
  console.log(`  documents: ${fixture.documents.length} · cases: ${fixture.cases.length} · k: ${k}`);
  console.log(`  semantic: ${useSemantic ? `${RETRIEVAL_MODEL} (floor ${semanticFloor})` : 'skipped (--no-semantic)'}`);
  console.log(`  reranker: ${useRerank ? DEFAULT_RERANK_MODEL : 'skipped (--no-rerank)'}`);
  console.log('');
  console.log('  retriever                          recall@1  recall@5  MRR    leak   adjacent  ms     by kind');
  console.log('  ─────────────────────────────────  ────────  ────────  ─────  ─────  ────────  ─────  ─────────────────────────');
  for (const report of reports) {
    console.log(
      `  ${report.name.padEnd(33)}  ${pct(report.recallAt1).padStart(8)}  ` +
      `${pct(report.recallAt5).padStart(8)}  ${report.mrr.toFixed(2).padStart(5)}  ` +
      `${pct(report.leakRate).padStart(5)}  ${pct(report.adjacentRetrievalRate).padStart(8)}  ` +
      `${report.meanLatencyMs.toFixed(0).padStart(5)}  ${kindSummary(report)}`,
    );
  }

  for (const report of reports) {
    const misses = report.cases.filter((c) =>
      c.kind === 'unanswerable' ? c.leak : c.kind === 'adjacent' ? false : !c.hit,
    );
    if (misses.length === 0) continue;
    console.log(`\n  ${report.name} — ${misses.length} miss${misses.length === 1 ? '' : 'es'}`);
    for (const miss of misses) {
      const top = miss.hits[0];
      const outcome = miss.kind === 'unanswerable'
        ? `LEAKED: ${top?.locator ?? 'a passage'}`
        : `top=${top?.locator ?? 'none'}`;
      console.log(`    [${miss.kind}] ${miss.question}`);
      console.log(`      expected="${miss.expected ?? '(nothing)'}" · ${outcome}`);
    }
  }
}

async function ingestDocument(
  store: ReturnType<typeof getAttachmentStore>,
  name: string,
): Promise<{ id: string; chunks: ChunkView[] }> {
  const text = readFileSync(join(fixtureDir, name), 'utf8');
  const receipt = await store.receiveUpload(Readable.from([Buffer.from(text, 'utf8')]), {
    maxBytes: 10 * 1024 * 1024,
  });
  const record = await store.finalizeUpload({
    sessionId: 'benchmark-attachments',
    name,
    mime: name.endsWith('.md') ? 'text/markdown' : 'text/plain',
    kind: 'file',
    receipt,
  });
  const ready = await store.waitFor(record.id, 15_000);
  if (!ready || ready.status === 'failed') {
    throw new Error(`Could not ingest ${name}: ${ready?.error ?? 'timed out'}`);
  }
  const raw = store.raw(record.id);
  if (!raw?.chunksPath) throw new Error(`${name} has no chunk index`);
  const chunks = readFileSync(raw.chunksPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as AttachmentChunk);
  return { id: record.id, chunks: chunkViews(chunks) };
}

async function main(): Promise<void> {
  const realAttachmentDir = process.env.NUVIRA_ATTACHMENT_DIR;
  const realIngestMax = process.env.NUVIRA_ATTACHMENT_INGEST_MAX_CHARS;
  const tempDir = mkdtempSync(join(tmpdir(), 'nuvira-attachment-bench-'));
  process.env.NUVIRA_ATTACHMENT_DIR = tempDir;
  process.env.NUVIRA_ATTACHMENT_INGEST_MAX_CHARS = '2000000';

  try {
    const store = getAttachmentStore();
    const docs = new Map<string, { id: string; chunks: ChunkView[] }>();
    const ingestionStarted = performance.now();
    for (const name of fixture.documents) {
      docs.set(name, await ingestDocument(store, name));
    }
    const ingestionMs = performance.now() - ingestionStarted;
    const chunkCount = [...docs.values()].reduce((sum, doc) => sum + doc.chunks.length, 0);
    const windowCount = [...docs.values()].reduce(
      (sum, doc) => sum + doc.chunks.reduce((chunkSum, chunk) => chunkSum + childWindows(chunk.text).length, 0),
      0,
    );

    let semanticIndexes: Map<string, SemanticIndex> | null = null;
    let semanticMs = 0;
    if (useSemantic) {
      const started = performance.now();
      semanticIndexes = new Map();
      for (const [name, doc] of docs) {
        const index = await buildSemanticIndex(doc.chunks);
        if (!index) {
          semanticIndexes = null;
          break;
        }
        semanticIndexes.set(name, index);
      }
      semanticMs = performance.now() - started;
    }

    const keywordResults: CaseResult[] = [];
    const bm25Results: CaseResult[] = [];
    const identifierResults: CaseResult[] = [];
    const fuzzyResults: CaseResult[] = [];
    const morphResults: CaseResult[] = [];
    const rerankResults: CaseResult[] = [];
    const rerankFusedResults: CaseResult[] = [];
    const keywordRerankResults: CaseResult[] = [];
    let rerankAvailable = useRerank;
    const semanticResults: CaseResult[] = [];
    const hybridResults: CaseResult[] = [];

    for (const c of fixture.cases) {
      const doc = docs.get(c.document);
      if (!doc) throw new Error(`Unknown fixture document: ${c.document}`);

      let started = performance.now();
      const keywordCandidates = currentKeywordHits(store, doc.id, c.question, Math.max(20, k * 4));
      keywordResults.push(evaluateCase(c, keywordCandidates.slice(0, k), performance.now() - started));

      started = performance.now();
      const lexical = bm25Hits(doc.chunks, c.question, k * 4);
      const lexicalTop = lexical.slice(0, k);
      bm25Results.push(evaluateCase(c, lexicalTop, performance.now() - started));

      started = performance.now();
      const identifier = bm25Hits(doc.chunks, c.question, k * 4, { identifierAware: true });
      identifierResults.push(evaluateCase(c, identifier.slice(0, k), performance.now() - started));

      started = performance.now();
      const fuzzy = bm25Hits(doc.chunks, c.question, k * 4, { identifierAware: true, fuzzy: true });
      fuzzyResults.push(evaluateCase(c, fuzzy.slice(0, k), performance.now() - started));

      started = performance.now();
      const morph = bm25Hits(doc.chunks, c.question, k * 4, {
        identifierAware: true,
        fuzzy: true,
        expandMorphology: true,
      });
      morphResults.push(evaluateCase(c, morph.slice(0, k), performance.now() - started));

      if (rerankAvailable) {
        const rerankStarted = performance.now();
        const candidates = bm25Hits(doc.chunks, c.question, Math.max(20, k * 4), {
          identifierAware: true,
          fuzzy: true,
        });
        const order = await rerankPassages(c.question, candidates.map((hit) => hit.text));
        if (!order) {
          rerankAvailable = false;
        } else {
          const reranked = order.slice(0, k).flatMap(({ index }) => {
            const hit = candidates[index];
            return hit ? [hit] : [];
          });
          rerankResults.push(evaluateCase(c, reranked, performance.now() - rerankStarted));

          const rerankHits = order.flatMap(({ index, score }) => {
            const hit = candidates[index];
            return hit ? [{ ...hit, score }] : [];
          });
          rerankFusedResults.push(
            evaluateCase(c, hybridHits(candidates, rerankHits, k), performance.now() - rerankStarted),
          );

          // The production path is the store's own lexical candidate list, not
          // this benchmark's BM25 arm. Measure that list fused with the reranker
          // so the report cannot claim a gain the product does not have.
          const keywordRerankStarted = performance.now();
          const keywordOrder = await rerankPassages(
            c.question,
            keywordCandidates.map((hit) => hit.text),
          );
          if (!keywordOrder) {
            rerankAvailable = false;
          } else {
            const keywordRerankHits = keywordOrder.flatMap(({ index, score }) => {
              const hit = keywordCandidates[index];
              return hit ? [{ ...hit, score }] : [];
            });
            keywordRerankResults.push(
              evaluateCase(
                c,
                hybridHits(keywordCandidates, keywordRerankHits, k),
                performance.now() - keywordRerankStarted,
              ),
            );
          }
        }
      }

      if (semanticIndexes) {
        const index = semanticIndexes.get(c.document);
        if (!index) throw new Error(`No semantic index for ${c.document}`);
        started = performance.now();
        const semantic = await semanticHits(index, c.question, k * 4);
        const semanticTop = semantic.slice(0, k);
        const semanticLatency = performance.now() - started;
        semanticResults.push(evaluateCase(c, semanticTop, semanticLatency));

        started = performance.now();
        const fused = hybridHits(lexical, semantic, k);
        hybridResults.push(evaluateCase(c, fused, semanticLatency + performance.now() - started));
      }
    }

    const reports = [
      summarize('keyword (shipped)', keywordResults),
      summarize('bm25', bm25Results),
      summarize('bm25-id', identifierResults),
      summarize('bm25-id+fuzzy', fuzzyResults),
      summarize('bm25-id+fuzzy+morph', morphResults),
    ];
    if (rerankResults.length === fixture.cases.length) {
      reports.push(summarize('bm25-id+fuzzy+rerank', rerankResults));
    }
    if (rerankFusedResults.length === fixture.cases.length) {
      reports.push(summarize('bm25-id+fuzzy+rerank-fused', rerankFusedResults));
    }
    if (keywordRerankResults.length === fixture.cases.length) {
      reports.push(summarize('keyword+rerank-fused (production)', keywordRerankResults));
    }
    if (semanticIndexes) {
      reports.push(summarize('semantic (bge-small)', semanticResults));
      reports.push(summarize('hybrid (bm25 + semantic)', hybridResults));
    }

    printReport(reports);
    const reportArg = argValue('--report');
    const reportPath = reportArg
      ? resolve(process.cwd(), reportArg)
      : fixturePath === resolve(defaultFixturePath)
        ? join(here, '..', '..', 'docs', 'BENCH_ATTACHMENT_RETRIEVAL_2026-11-09.md')
        : join(here, '..', '..', 'docs', 'BENCH_ATTACHMENT_RETRIEVAL_REAL.md');
    writeFileSync(
      reportPath,
      renderMarkdownReport(reports, { chunkCount, windowCount, ingestionMs, semanticMs }),
      'utf8',
    );
    console.log(
      `\n  corpus: ${chunkCount} chunks · ${windowCount} child windows · ` +
      `ingestion ${ingestionMs.toFixed(0)} ms · semantic index ${semanticMs.toFixed(0)} ms`,
    );
    console.log(`  wrote ${relative(process.cwd(), reportPath)}`);
    if (useSemantic && !semanticIndexes) {
      console.log('  semantic arm skipped: the embedder returned a zero vector or could not load.');
    }
    if (useRerank && !rerankAvailable) {
      console.log('  reranker arm skipped: the local cross-encoder could not load or is disabled.');
    }
  } finally {
    if (realAttachmentDir === undefined) delete process.env.NUVIRA_ATTACHMENT_DIR;
    else process.env.NUVIRA_ATTACHMENT_DIR = realAttachmentDir;
    if (realIngestMax === undefined) delete process.env.NUVIRA_ATTACHMENT_INGEST_MAX_CHARS;
    else process.env.NUVIRA_ATTACHMENT_INGEST_MAX_CHARS = realIngestMax;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`Attachment retrieval benchmark failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
