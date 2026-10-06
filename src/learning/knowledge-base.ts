/**
 * KnowledgeBase — tag-scoped, vectorized retrieval over a user's own documents.
 *
 * WHY THIS EXISTS. The retrieval engine (`src/learning/retrieval.ts`) vectorizes
 * a REPO for token reduction and keys everything by file path; the tagged memory
 * store (`src/tools/memory-tools.ts`) holds FACTS, not whole documents. Neither
 * answers "I brought my documents, gave them a tag, and I want precise answers
 * scoped to that tag." So a user asking about their own data had exactly one
 * path — re-read the file into context on EVERY turn, which costs the document's
 * tokens repeatedly and is slow on large files.
 *
 * This module pays that cost ONCE. A document is extracted, chunked and embedded
 * a single time under a tag; each later question embeds a short query and
 * retrieves its top-k chunks. The tag is a real scope: each tag gets its own
 * vector namespace (`knowledge-<tag>`), so tags never bleed into each other and
 * a tag can be forgotten without touching anything else.
 *
 * Retrieval is relevance-FLOORED (`DEFAULT_KNOWLEDGE_MIN_SIMILARITY`), because
 * "the nearest k neighbours" is not the same claim as "k relevant passages":
 * an unrelated question must be able to come back empty rather than receive the
 * closest six chunks of a document it has nothing to do with.
 *
 * Retrieval is also HYBRID (Phase 2.2–2.4): a dense (vector) half and a lexical
 * (BM25, see `lexical-search.ts`) half are fused with Reciprocal Rank Fusion and
 * then capped per source document. The two halves fail on different questions —
 * embeddings miss the exact identifier, clause number or error code a user pastes
 * in, and BM25 misses a paraphrase with no shared words — so ranking both and
 * fusing their RANKS (not their incomparable scores) gets both. The cosine floor
 * still governs DENSE evidence; lexical evidence is governed by its own term
 * overlap, which is why an unrelated question (no shared vocabulary) still comes
 * back empty from both halves. `fusion: 'dense'` reproduces vector-only
 * retrieval for a caller that wants it or for the eval to compare against.
 *
 * The retrieved chunks are USER DATA; the model supplies the generic half of an
 * answer (and `web-research` supplies the net-based half). `formatKnowledgeContext`
 * labels each chunk with its source file so the model can attribute precisely
 * which part of an answer came from the user's data.
 *
 * Storage: vectors in the existing pluggable VectorStore (one JSON/FAISS file
 * per namespace), a small manifest at `<memory>/knowledge-index.json` for
 * listing/removal. Everything lives in the Nuvira data dir (`~/.nuvira/memory`),
 * never in a repository or package.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname, basename } from 'node:path';

import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { embed, RETRIEVAL_MODEL } from '../memory/embedder.js';
import { getVectorStore, cosineSimilarity } from '../memory/vector-store.js';
import type { VectorEntry } from '../memory/vector-store.js';
import { DEFAULT_CHUNK_TOKENS, DEFAULT_OVERLAP_TOKENS } from './retrieval.js';
import { chunkMarkdown, parseMarkdownOutline } from './markdown-outline.js';
import { bm25Search } from './lexical-search.js';
import type { LexicalDocument } from './lexical-search.js';
import { logger } from '../utils/logger.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** A tag is a sandboxed namespace segment: lowercase alphanumerics + hyphens, with at least one alphanumeric. */
export const KNOWLEDGE_TAG_RE = /^[a-z0-9-]*[a-z0-9][a-z0-9-]*$/;

/** Namespace prefix — keeps knowledge vectors apart from memory/history/repo. */
export const KNOWLEDGE_NAMESPACE_PREFIX = 'knowledge-';

/** Manifest of tags → documents (listing/removal only; vectors live elsewhere). */
export const KNOWLEDGE_MANIFEST_FILE = 'knowledge-index.json';

/** Default chunks returned per query. */
export const DEFAULT_KNOWLEDGE_TOP_K = 6;

/**
 * Relevance floor for retrieval.
 *
 * Every backend scores in cosine similarity, where 1 means "the same direction"
 * and 0 means "unrelated", so a hit below this is at best a weak topic touch.
 * The floor is what makes an HONEST empty answer reachable: nearest-neighbour
 * search always returns its k nearest neighbours, so without a floor the k-th
 * can be a passage about something else entirely and an unrelated question still
 * receives a confident-looking block of the wrong document. A hit below the
 * floor is not evidence about the question, so it is dropped here rather than
 * left to the model to notice and ignore.
 *
 * CALIBRATED, NOT GUESSED. Cosine similarity between a question and its own
 * document is a property of the EMBEDDING MODEL, so this number only means
 * anything next to the model that produced the vectors. On the eval corpus with
 * the retrieval model (`RETRIEVAL_MODEL`, bge-small-en-v1.5), unrelated
 * questions reach up to 0.425 and the lowest-scoring CORRECT answer sits at
 * 0.635 (p50 0.772). 0.5 is the round value inside that
 * measured gap with margin on both sides: above every leak probe and below every
 * correct answer. `tests/live/knowledge-eval-live.test.ts` prints the band and
 * FAILS if the shipped floor falls outside it, so this is re-measurable rather
 * than folklore.
 *
 * IT IS TIER-SPECIFIC, and the embedder is TIERED. If the local ONNX model
 * cannot load, `embed` falls back to a different model — Python
 * `all-MiniLM-L6-v2`, on a different similarity scale — or to a zero vector,
 * WITHOUT throwing. A floor calibrated for one model is simply wrong for
 * another, and wrong in a way that looks measured. The live eval therefore proves
 * which model actually ran (an identity probe) before it reports a band, and
 * fails loudly if they disagree. The offline eval uses its OWN floor and says so
 * (`KNOWLEDGE_EVAL_OFFLINE_MIN_SIMILARITY`), because a bag-of-words vectorizer is
 * not on this model's scale at all.
 */
export const DEFAULT_KNOWLEDGE_MIN_SIMILARITY = 0.5;

/**
 * How many chunks ONE source document may contribute to a result.
 *
 * Fusion alone can hand the whole top-k to whichever document the query happens
 * to touch most, because a long document has more chances to contain a term —
 * so a single highly-ranked file would crowd out the shorter document that
 * actually answers the question. The cap promotes diversity of SOURCES.
 *
 * It is deliberately relaxed to "no cap" when the candidate pool has only one
 * source: the common case is a tag holding a single document, and capping it
 * there would throw away half the passages for no diversity to gain.
 */
export const DEFAULT_KNOWLEDGE_MAX_PER_SOURCE = 3;

/**
 * Dense AND lexical candidates considered before fusion, as a multiple of topK
 * (floored at MIN_CANDIDATE_POOL). Fusion has to see more than `topK` from each
 * half: a passage the dense half ranked 12th and the lexical half ranked 2nd
 * should be able to win, and it can only do that if both halves were given a
 * pool deeper than the answer.
 */
const CANDIDATE_POOL_MULTIPLIER = 4;
const MIN_CANDIDATE_POOL = 24;

/**
 * Reciprocal Rank Fusion's rank constant (Cormack et al., 2009). A larger value
 * flattens the difference between adjacent ranks. 60 is the standard default and
 * is what makes RRF safe here: it fuses RANKS, so cosine similarity — which is
 * on the embedding model's scale — is never added to a BM25 score, which is on
 * its own unbounded scale. The two numbers are never compared, only their orders.
 */
const RRF_K = 60;

/** Directories never walked when a tag is pointed at a folder. */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache', '.venv', 'venv',
  '__pycache__', '.turbo', '.nx', 'coverage', '.idea', '.vscode',
]);

/** Cap a directory walk so a stray `.` cannot index an entire disk. */
const MAX_FILES_PER_INGEST = 500;

/** Per-chunk text kept in metadata (matches retrieval.ts's budget). */
const MAX_EXTRACT_CHARS = 2_000_000;

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * One document recorded under a tag.
 *
 * `docId` and `contentHash` are what make the SECOND ingest of the same folder
 * cheap and correct: the id addresses the document's stored text (so a section
 * can be read verbatim), and the hash says whether anything inside it changed
 * (so an unchanged file is not extracted, chunked and embedded again).
 */
export interface KnowledgeDocument {
  /** Stable id derived from `path` — the key of the stored extracted text. */
  docId: string;
  path: string;
  /** First heading of the document, or its basename when it has none. */
  title: string;
  chunks: number;
  addedAt: number;
  /** SHA-1 of the extracted text — the change detector for re-ingest. */
  contentHash: string;
}

/** Manifest entry for a tag. */
export interface KnowledgeTagEntry {
  tag: string;
  updatedAt: number;
  chunkCount: number;
  documents: KnowledgeDocument[];
}

interface KnowledgeManifest {
  version: number;
  tags: Record<string, KnowledgeTagEntry>;
}

/** A retrieval hit scoped to a tag. */
export interface KnowledgeHit {
  tag: string;
  text: string;
  sourcePath: string;
  chunkIndex: number;
  similarity: number;
  /**
   * The heading chain the passage sits under, e.g. `Auth Design > Token refresh`.
   * Empty for a document with no headings (or a non-Markdown one), which is why
   * it is optional in the rendered citation rather than printed as `unknown`.
   */
  headingPath?: string;
  /**
   * WHY this passage is here: `dense` means it cleared the cosine floor, `term`
   * means it is a lexical-only match whose similarity is below the floor. The
   * distinction is rendered in the citation, because a passage presented with a
   * low `sim` and no explanation reads as a mistake rather than as a term match.
   */
  evidence?: 'dense' | 'term';
}

/** Result of an ingest call. */
export interface IngestResult {
  tag: string;
  files: number;
  chunks: number;
  /** Documents whose content hash matched the recorded one — nothing re-embedded. */
  unchanged: number;
  skipped: Array<{ path: string; reason: string }>;
}

/** Options shared by ingest/query. */
export interface KnowledgeOptions {
  chunkTokens?: number;
  overlapTokens?: number;
  topK?: number;
  /**
   * Relevance floor for `queryKnowledge` — hits scoring below this cosine
   * similarity are dropped. Defaults to `DEFAULT_KNOWLEDGE_MIN_SIMILARITY`.
   */
  minSimilarity?: number;
  /**
   * How to retrieve: `hybrid` (default) fuses dense + lexical evidence; `dense`
   * reproduces vector-only retrieval. Query-only.
   */
  fusion?: 'hybrid' | 'dense';
  /**
   * Lexical (BM25) floor for a candidate matched ONLY by the lexical half — a
   * dense hit is already gated by `minSimilarity`. 0 (default) keeps any passage
   * that shares a content term with the question. Query-only.
   */
  minLexicalScore?: number;
  /**
   * Chunks one source document may contribute to a result. Defaults to
   * `DEFAULT_KNOWLEDGE_MAX_PER_SOURCE`, and is relaxed automatically when only
   * one source is in the candidate pool. Query-only.
   */
  maxPerSource?: number;
  /**
   * Ingest-only. Called once per chunk that could NOT be embedded and was
   * therefore not indexed, so a caller can report the shortfall instead of a
   * document that looks fully indexed while part of it is missing.
   */
  onChunkSkipped?: (reason: string) => void;
  /**
   * Embedding function override. Defaults to the local embedder. Injectable so
   * callers (and tests) can supply a deterministic/dummy vectorizer without
   * downloading the ~130 MB model.
   */
  embedFn?: (text: string) => Promise<number[]>;
}

// ─── Paths (resolved per call so tests that set NUVIRA_MEMORY_DIR are hermetic) ──

function memoryDir(): string {
  return envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
}

function manifestPath(): string {
  return join(memoryDir(), KNOWLEDGE_MANIFEST_FILE);
}

// ─── Tag handling ───────────────────────────────────────────────────────────

/**
 * Normalize a user-supplied tag into the sandboxed form. `Dheeraj_Health_report`
 * → `dheeraj-health-report`. This is deliberately forgiving: a human naming a
 * tag should not have to know the namespace rules, and a tag is not a path.
 */
export function normalizeKnowledgeTag(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/** True when a (already-normalized) tag is valid and non-empty. */
export function isValidKnowledgeTag(tag: string): boolean {
  return KNOWLEDGE_TAG_RE.test(tag);
}

/** The VectorStore namespace for a tag. Assumes a normalized tag. */
export function namespaceForTag(tag: string): string {
  return `${KNOWLEDGE_NAMESPACE_PREFIX}${tag}`;
}

// ─── Manifest ───────────────────────────────────────────────────────────────

function emptyManifest(): KnowledgeManifest {
  return { version: 1, tags: {} };
}

/** Read the tag manifest. Never throws — a missing/corrupt file yields empty. */
export function readKnowledgeManifest(): KnowledgeManifest {
  try {
    if (!existsSync(manifestPath())) return emptyManifest();
    const data = JSON.parse(readFileSync(manifestPath(), 'utf-8')) as KnowledgeManifest;
    if (!data || typeof data !== 'object' || typeof data.tags !== 'object') return emptyManifest();
    return { version: data.version ?? 1, tags: data.tags ?? {} };
  } catch {
    return emptyManifest();
  }
}

function writeKnowledgeManifest(manifest: KnowledgeManifest): void {
  try {
    if (!existsSync(memoryDir())) mkdirSync(memoryDir(), { recursive: true });
    writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2), 'utf-8');
  } catch {
    // Best-effort — the vectors are the source of truth; the manifest is an index.
  }
}

/** Every tag with its recorded documents/chunk counts (sorted by recency). */
export function listKnowledgeTags(): KnowledgeTagEntry[] {
  return Object.values(readKnowledgeManifest().tags).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** One tag's manifest entry, or null. */
export function getKnowledgeTag(tag: string): KnowledgeTagEntry | null {
  const normalized = normalizeKnowledgeTag(tag);
  return readKnowledgeManifest().tags[normalized] ?? null;
}

// ─── Document store (the extracted text, kept so a section can be READ) ─────
//
// Retrieval returns passages, but "implement this spec" needs the section as the
// author wrote it — in order, complete, quotable. Re-extracting on every read
// would be slow and, for a PDF, would mean re-running the whole extractor just
// to show one heading's worth of text, so the extracted text is stored beside the
// vectors. It is user data in the same data dir, and it is removed with the tag.

/** SHA-1 of the extracted text — the change detector, not a security control. */
function contentHashOf(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** Stable id for a document, derived from its path. */
export function documentIdFor(sourcePath: string): string {
  return createHash('sha1').update(sourcePath).digest('hex').slice(0, 16);
}

/** A document's display title: its first heading, or its basename. */
function documentTitleOf(text: string, sourcePath: string): string {
  try {
    const first = parseMarkdownOutline(text)[0];
    if (first && first.level > 0) return first.title;
  } catch {
    // Fall through to the basename — a title is never worth failing an ingest.
  }
  return basename(sourcePath);
}

function documentStoreDir(tag: string): string {
  return join(memoryDir(), 'knowledge-docs', normalizeKnowledgeTag(tag));
}

function documentStorePath(tag: string, docId: string): string {
  return join(documentStoreDir(tag), `${docId}.txt`);
}

/** Persist a document's extracted text. Best-effort — vectors remain the truth. */
function writeStoredDocument(tag: string, docId: string, text: string): void {
  try {
    const dir = documentStoreDir(tag);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(documentStorePath(tag, docId), text, 'utf-8');
  } catch {
    // A failed write costs a later read, never an ingest.
  }
}

function readStoredDocument(tag: string, docId: string): string | null {
  try {
    const path = documentStorePath(tag, docId);
    return existsSync(path) ? readFileSync(path, 'utf-8') : null;
  } catch {
    return null;
  }
}

function deleteStoredDocument(tag: string, docId: string): void {
  try {
    const path = documentStorePath(tag, docId);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Best-effort — an orphaned text file is inert (nothing references it).
  }
}

// ─── File collection ────────────────────────────────────────────────────────

/** Recursively collect files under a path (bounded, ignores build/vendor dirs). */
export function collectKnowledgeFiles(root: string, out: string[] = [], depth = 0): string[] {
  if (out.length >= MAX_FILES_PER_INGEST || depth > 8) return out;
  let stat;
  try {
    stat = statSync(root);
  } catch {
    return out;
  }
  if (stat.isFile()) {
    out.push(root);
    return out;
  }
  if (!stat.isDirectory()) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES_PER_INGEST) break;
    if (IGNORE_DIRS.has(entry)) continue;
    collectKnowledgeFiles(join(root, entry), out, depth + 1);
  }
  return out;
}

// ─── Text extraction ────────────────────────────────────────────────────────

/**
 * Extract a file's text, reusing the `read_extract` manager so PDF/DOCX/XLSX/
 * PPTX and text formats all work (and unsupported ones refuse with a reason
 * instead of silently indexing a container's bytes).
 */
async function extractFileText(filePath: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const ext = extname(filePath).toLowerCase();
  // Plain text-ish formats need no heavy reader — read directly.
  if (['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log'].includes(ext)) {
    try {
      const text = readFileSync(filePath, 'utf-8');
      return { ok: true, text: text.length > MAX_EXTRACT_CHARS ? text.slice(0, MAX_EXTRACT_CHARS) : text };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
  try {
    const { getReadExtractManager } = await import('../tools/read-extract.js');
    const result = await getReadExtractManager().extract(filePath);
    if (!result.success || !result.text) {
      return { ok: false, reason: result.error ?? result.code ?? 'extraction failed' };
    }
    return { ok: true, text: result.text };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Ingest ─────────────────────────────────────────────────────────────────

/**
 * Ingest raw text under a tag. Idempotent per `<tag>:<sourcePath>#<i>` chunk id,
 * so re-ingesting a changed document overwrites its chunks rather than
 * duplicating them.
 */
export async function ingestKnowledgeText(
  tag: string,
  sourcePath: string,
  text: string,
  opts: KnowledgeOptions = {},
  /**
   * How many chunks this same `<tag>:<sourcePath>` contributed LAST time, so a
   * document that got shorter has its retired tail removed. `ingestKnowledge`
   * passes the count it reads from the manifest.
   */
  previousChunkCount = 0,
): Promise<number> {
  const normalized = normalizeKnowledgeTag(tag);
  const chunkTokens = opts.chunkTokens ?? DEFAULT_CHUNK_TOKENS;
  const overlapTokens = opts.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  const embedFn = opts.embedFn ?? ((t: string) => embed(t, undefined, false, RETRIEVAL_MODEL));

  const label = `${normalized}:${sourcePath}`;
  // Structure-aware: each chunk is tagged with the heading chain it sits under,
  // and is EMBEDDED with that chain prepended (see markdown-outline.ts) while the
  // stored/quotable text stays exactly as it appears in the document.
  const chunks = chunkMarkdown(text, label, chunkTokens, overlapTokens);
  const store = getVectorStore(namespaceForTag(normalized));

  let stored = 0;
  for (const chunk of chunks) {
    let vector: number[];
    try {
      vector = await embedFn(chunk.embedText);
    } catch {
      // SKIP the chunk — never store a placeholder. A zero vector was inserted
      // here before: it scores 0 (cosine guards the zero magnitude) so it could
      // never win a search, but it cost a scan forever and it made a partially
      // indexed document read as fully indexed. A hole the caller is TOLD about
      // beats a dead entry nobody can see.
      opts.onChunkSkipped?.(`chunk ${chunk.chunkIndex + 1} of ${basename(sourcePath)}`);
      continue;
    }
    await store.insert(chunk.id, vector, {
      kind: 'knowledge-chunk',
      tag: normalized,
      sourcePath,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      headingPath: chunk.headingPath,
      title: chunk.title,
      tokenCount: chunk.tokenCount,
    });
    stored += 1;
  }

  // A document that got SHORTER must not leave its old tail behind. Chunk ids
  // are `<tag>:<path>#<i>` and `insert` overwrites only the indices the new
  // version produced, so the retired chunks would otherwise stay in the
  // namespace and keep being retrieved for the life of the tag.
  for (let i = chunks.length; i < previousChunkCount; i += 1) {
    try {
      await store.delete(`${label}#${i}`);
    } catch {
      // Best-effort: a failed delete leaves one stale chunk, which the relevance
      // floor may still drop — but it must never break the ingest.
    }
  }

  return stored;
}

/**
 * Ingest one or more files/directories under a tag. Extraction, chunking and
 * embedding happen ONCE here; later questions only embed a short query.
 */
export async function ingestKnowledge(
  tag: string,
  paths: string[],
  opts: KnowledgeOptions = {},
): Promise<IngestResult> {
  const normalized = normalizeKnowledgeTag(tag);
  if (!isValidKnowledgeTag(normalized)) {
    throw new Error(`Invalid knowledge tag '${tag}' — it must contain at least one letter or digit.`);
  }

  const result: IngestResult = { tag: normalized, files: 0, chunks: 0, unchanged: 0, skipped: [] };
  const manifest = readKnowledgeManifest();
  const entry: KnowledgeTagEntry = manifest.tags[normalized] ?? {
    tag: normalized,
    updatedAt: Date.now(),
    chunkCount: 0,
    documents: [],
  };

  // Flatten dirs → files, bounded.
  const files: string[] = [];
  for (const p of paths) {
    if (existsSync(p)) {
      collectKnowledgeFiles(p, files);
    } else {
      result.skipped.push({ path: p, reason: 'not found' });
    }
  }

  for (const file of files) {
    const extracted = await extractFileText(file);
    if (!extracted.ok) {
      result.skipped.push({ path: file, reason: extracted.reason });
      continue;
    }
    try {
      // The document's previous contribution, read BEFORE the write — it drives
      // the retired-tail delete, the recorded count and the unchanged check.
      const previous = entry.documents.find((d) => d.path === file);
      const docId = documentIdFor(file);
      const contentHash = contentHashOf(extracted.text);

      // UNCHANGED: same text as last time. Re-embedding it would cost the whole
      // document again to arrive at byte-identical vectors, so the stored text is
      // refreshed (cheap, and it is what a section read serves) and the vectors
      // are left alone.
      if (previous && previous.contentHash === contentHash) {
        writeStoredDocument(normalized, docId, extracted.text);
        result.unchanged += 1;
        continue;
      }

      let embedFailures = 0;
      const chunks = await ingestKnowledgeText(
        normalized,
        file,
        extracted.text,
        { ...opts, onChunkSkipped: () => { embedFailures += 1; } },
        previous?.chunks ?? 0,
      );
      if (chunks === 0) {
        // Every chunk failed to embed. Recording the document would claim a file
        // that contributes nothing and reads as indexed; say what happened.
        result.skipped.push({ path: file, reason: 'no chunk could be embedded — nothing was indexed' });
        continue;
      }
      result.files += 1;
      result.chunks += chunks;
      if (embedFailures > 0) {
        result.skipped.push({
          path: file,
          reason: `${embedFailures} chunk(s) could not be embedded and were not indexed`,
        });
      }
      // The extracted text is kept so a section can be read verbatim later;
      // recorded BEFORE the manifest write so a crash cannot leave a document
      // recorded with no readable text behind it.
      writeStoredDocument(normalized, docId, extracted.text);
      // Re-ingesting a changed document replaces its chunks; keep the recorded
      // count in step by subtracting the previous contribution first.
      if (previous) {
        entry.chunkCount -= previous.chunks;
        if (previous.docId !== docId) deleteStoredDocument(normalized, previous.docId);
      }
      entry.documents = entry.documents.filter((d) => d.path !== file);
      entry.documents.push({
        docId,
        path: file,
        title: documentTitleOf(extracted.text, file),
        chunks,
        addedAt: Date.now(),
        contentHash,
      });
      entry.chunkCount += chunks;
    } catch (err) {
      result.skipped.push({ path: file, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  entry.updatedAt = Date.now();
  // A tag that ingested nothing AND had nothing before is not a tag: recording
  // it would put an empty entry in `list` (and in the model's view of what the
  // user has), which reads as "this document set exists" when nothing was
  // indexed at all.
  if (entry.documents.length > 0 || manifest.tags[normalized]) {
    manifest.tags[normalized] = entry;
    writeKnowledgeManifest(manifest);
  }
  return result;
}

// ─── Query ──────────────────────────────────────────────────────────────────

/** One entry in the fused ranking, with the evidence that put it there. */
interface FusedCandidate {
  entry: VectorEntry;
  similarity: number;
  /** True when this candidate cleared the cosine floor (dense evidence). */
  fromDense: boolean;
  rrf: number;
}

/** The source document a stored chunk belongs to (its path, else its id). */
function sourcePathOf(entry: VectorEntry): string {
  return String(entry.metadata?.sourcePath ?? entry.id);
}

/**
 * Embed the question and return the tag's top-k chunks. Never throws.
 *
 * Two retrievers run over the same namespace and their RANKS are fused:
 *
 *   1. **Dense** — cosine over the stored vectors, gated by `minSimilarity`.
 *      This is the Phase-0 relevance floor and it is unchanged: a passage the
 *      embeddings do not consider related is not dense evidence.
 *   2. **Lexical** — BM25 over the stored chunk text, which can find the exact
 *      term a dense retriever missed. A lexical hit is evidence by itself, so it
 *      is admitted even when its cosine sits below the floor — that is the whole
 *      reason the second retriever exists, and it is why `minSimilarity` alone
 *      can no longer force an empty result for a question that shares vocabulary
 *      with the corpus. Pass `fusion: 'dense'` to get the old, purely-cosine
 *      behaviour.
 *
 * Reciprocal Rank Fusion scores each candidate `Σ 1/(RRF_K + rank)`. Scores are
 * never summed across halves — cosine and BM25 are on different scales, and
 * adding them would silently weight whichever happens to have the larger range.
 * RRF only needs each half to ORDER its candidates, so a backend change cannot
 * move the fusion.
 *
 * The fused ranking is then capped per source document, so one long file cannot
 * take every slot from the shorter one that answers the question.
 */
export async function queryKnowledge(
  tag: string,
  question: string,
  opts: KnowledgeOptions = {},
): Promise<KnowledgeHit[]> {
  const normalized = normalizeKnowledgeTag(tag);
  const topK = opts.topK ?? DEFAULT_KNOWLEDGE_TOP_K;
  const minSimilarity = opts.minSimilarity ?? DEFAULT_KNOWLEDGE_MIN_SIMILARITY;
  const fusion = opts.fusion ?? 'hybrid';
  const minLexicalScore = opts.minLexicalScore ?? 0;
  const maxPerSource = opts.maxPerSource ?? DEFAULT_KNOWLEDGE_MAX_PER_SOURCE;
  const embedFn = opts.embedFn ?? ((t: string) => embed(t, undefined, false, RETRIEVAL_MODEL));

  try {
    const queryVector = await embedFn(question);
    const store = getVectorStore(namespaceForTag(normalized));
    const scoped = (entry: VectorEntry) =>
      entry.metadata?.kind === 'knowledge-chunk' && entry.metadata?.tag === normalized;

    const candidateK = Math.max(topK * CANDIDATE_POOL_MULTIPLIER, MIN_CANDIDATE_POOL);
    const denseResults = await store.search(queryVector, candidateK, scoped);

    // Dense evidence, floored. A non-finite score is treated as a miss: it must
    // never compare as "relevant".
    const denseKept = denseResults.filter(
      ({ similarity }) => Number.isFinite(similarity) && similarity >= minSimilarity,
    );
    if (denseKept.length < denseResults.length) {
      logger.debug(
        `Knowledge query for '${normalized}' dropped ${denseResults.length - denseKept.length} hit(s) below the ${minSimilarity} relevance floor.`,
      );
    }

    const byId = new Map<string, VectorEntry>();
    for (const { entry } of denseResults) byId.set(entry.id, entry);

    const candidates = new Map<string, FusedCandidate>();
    const fuse = (entry: VectorEntry, similarity: number, fromDense: boolean, rank: number) => {
      const contribution = 1 / (RRF_K + rank + 1);
      const existing = candidates.get(entry.id);
      if (existing) {
        existing.rrf += contribution;
        existing.fromDense = existing.fromDense || fromDense;
      } else {
        candidates.set(entry.id, { entry, similarity, fromDense, rrf: contribution });
      }
    };
    // Dense first, so a passage found by BOTH keeps the backend's similarity
    // rather than the locally recomputed one.
    denseKept.forEach(({ entry, similarity }, rank) => fuse(entry, similarity, true, rank));

    if (fusion === 'hybrid') {
      // Lexical over EVERY scoped chunk, not just the dense pool: a passage the
      // dense half never ranked is exactly the one BM25 is here to find.
      // Rebuilt per query on purpose — see lexical-search.ts, no index to drift.
      const documents: LexicalDocument[] = [];
      for (const entry of await store.getAll()) {
        if (!scoped(entry)) continue;
        byId.set(entry.id, entry);
        documents.push({ id: entry.id, text: String(entry.metadata?.text ?? '') });
      }
      const lexicalHits = bm25Search(documents, question, candidateK).filter((h) => h.score >= minLexicalScore);
      lexicalHits.forEach((hit, rank) => {
        const entry = byId.get(hit.id);
        if (!entry) return;
        // The similarity is kept for the citation even when it is below the
        // floor — reporting it is what lets a reader see that this passage came
        // from a term match rather than a near neighbour.
        fuse(entry, cosineSimilarity(queryVector, entry.vector), false, rank);
      });
    }

    if (candidates.size === 0) return [];

    // Deterministic order: RRF desc, then id — so equal scores never depend on
    // Map insertion order, which is what keeps the eval reproducible.
    const ranked = [...candidates.values()].sort(
      (a, b) => b.rrf - a.rrf || a.entry.id.localeCompare(b.entry.id),
    );

    // Diversity cap. Only meaningful when there IS more than one source to
    // promote, so a single-document tag (the common case) is never truncated.
    const sources = new Set(ranked.map((c) => sourcePathOf(c.entry)));
    const cap = sources.size > 1 ? maxPerSource : topK;
    const perSource = new Map<string, number>();
    const selected: FusedCandidate[] = [];
    for (const candidate of ranked) {
      const source = sourcePathOf(candidate.entry);
      const used = perSource.get(source) ?? 0;
      if (used >= cap) continue;
      perSource.set(source, used + 1);
      selected.push(candidate);
      if (selected.length >= topK) break;
    }

    return selected.map(({ entry, similarity, fromDense }) => ({
      tag: normalized,
      text: String(entry.metadata?.text ?? ''),
      sourcePath: sourcePathOf(entry),
      chunkIndex: Number(entry.metadata?.chunkIndex ?? 0),
      similarity,
      headingPath: entry.metadata?.headingPath ? String(entry.metadata.headingPath) : undefined,
      evidence: fromDense ? ('dense' as const) : ('term' as const),
    }));
  } catch (err) {
    logger.debug(`Knowledge query failed for tag '${normalized}': ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

// ─── Forget ─────────────────────────────────────────────────────────────────

// ─── Reading a document, whole or by section ────────────────────────────────
//
// Retrieval answers "where is it mentioned"; this answers "what does it say",
// in the document's own order and wording. The two are different jobs: a
// spec-driven build needs the section verbatim, not the six most similar
// paragraphs of it, and no amount of chunk ranking substitutes for that.

/** Cap on a read, so "the whole document" cannot become an unbounded prompt. */
export const MAX_READ_CHARS = 40_000;

/** One heading in a document's table of contents. */
export interface KnowledgeSectionInfo {
  title: string;
  headingPath: string;
  level: number;
  chars: number;
}

/** A document in a tag's table of contents. */
export interface KnowledgeDocumentOutline {
  docId: string;
  path: string;
  title: string;
  chunks: number;
  addedAt: number;
  sections: KnowledgeSectionInfo[];
}

/**
 * Find the document a caller means. Accepts a docId, an exact path, or a
 * basename; a basename that matches more than one document is reported as
 * ambiguous rather than resolved by guessing, because guessing picks the wrong
 * document silently, which is the failure this whole module is against.
 */
function resolveDocument(
  tag: string,
  docRef: string,
): { ok: true; doc: KnowledgeDocument } | { ok: false; reason: string } {
  const entry = getKnowledgeTag(tag);
  if (!entry) return { ok: false, reason: `No knowledge tag '${normalizeKnowledgeTag(tag)}' found.` };

  const ref = docRef.trim();
  const exact = entry.documents.find((d) => d.docId === ref || d.path === ref);
  if (exact) return { ok: true, doc: exact };

  const byName = entry.documents.filter((d) => basename(d.path).toLowerCase() === ref.toLowerCase());
  if (byName.length === 1) return { ok: true, doc: byName[0] };
  if (byName.length > 1) {
    return {
      ok: false,
      reason: `'${ref}' matches ${byName.length} documents under '${entry.tag}' — use the full path or the doc id: ${byName
        .map((d) => d.docId)
        .join(', ')}`,
    };
  }
  const available = entry.documents.map((d) => basename(d.path)).join(', ');
  return { ok: false, reason: `No document '${ref}' under '${entry.tag}'. Available: ${available || '(none)'}` };
}

/**
 * Read a document's text, or one of its sections.
 *
 * `section` is matched against the section's heading path, case-insensitively,
 * with or without the ancestors (`"Token refresh"` finds
 * `Auth Design > Token refresh`, and so does the full path). An unknown section
 * returns the available ones instead of the whole document, because silently
 * answering a narrower question with everything is how a reader concludes the
 * document says something it never said.
 */
export function readKnowledgeDocument(
  tag: string,
  docRef: string,
  section?: string,
): { ok: true; text: string; truncated: boolean; path: string; headingPath?: string } | { ok: false; reason: string } {
  const resolved = resolveDocument(tag, docRef);
  if (!resolved.ok) return resolved;
  const doc = resolved.doc;

  const full = readStoredDocument(normalizeKnowledgeTag(tag), doc.docId);
  if (full === null) {
    return {
      ok: false,
      reason: `The text of '${basename(doc.path)}' is not stored (it was ingested by an older version). Re-ingest it: action: add.`,
    };
  }

  let text = full;
  let headingPath: string | undefined;
  if (section && section.trim()) {
    const want = section.trim().toLowerCase();
    const sections = parseMarkdownOutline(full);
    const match = sections.find((s) => {
      const own = s.title.toLowerCase();
      const chain = s.headingPath ? `${s.headingPath} > ${s.title}`.toLowerCase() : own;
      return own === want || chain === want || chain.endsWith(` > ${want}`);
    });
    if (!match) {
      const list = sections
        .filter((s) => s.level > 0)
        .slice(0, 40)
        .map((s) => (s.headingPath ? `${s.headingPath} > ${s.title}` : s.title))
        .join('\n  ');
      return { ok: false, reason: `No section '${section}' in '${basename(doc.path)}'. Sections:\n  ${list}` };
    }
    text = match.text;
    headingPath = match.headingPath ? `${match.headingPath} > ${match.title}` : match.title;
  }

  const truncated = text.length > MAX_READ_CHARS;
  return {
    ok: true,
    text: truncated ? text.slice(0, MAX_READ_CHARS) : text,
    truncated,
    path: doc.path,
    headingPath,
  };
}

/** Every document under a tag, with its heading tree. */
export function listKnowledgeSections(tag: string, docRef?: string): KnowledgeDocumentOutline[] {
  const entry = getKnowledgeTag(tag);
  if (!entry) return [];
  const docs = docRef ? (() => {
    const resolved = resolveDocument(tag, docRef);
    return resolved.ok ? [resolved.doc] : [];
  })() : entry.documents;

  return docs.map((doc) => {
    const text = readStoredDocument(entry.tag, doc.docId);
    const sections = text
      ? parseMarkdownOutline(text)
          .filter((s) => s.level > 0)
          .map((s) => ({
            title: s.title,
            headingPath: s.headingPath,
            level: s.level,
            chars: s.text.length,
          }))
      : [];
    return { docId: doc.docId, path: doc.path, title: doc.title, chunks: doc.chunks, addedAt: doc.addedAt, sections };
  });
}

/**
 * Remove one document from a tag: its chunks, its stored text, its manifest row.
 * Used by `syncKnowledgeTag` when a file is no longer present under a synced
 * root, and by the CLI to drop a single document without forgetting the tag.
 */
export async function removeKnowledgeDocument(tag: string, docRef: string): Promise<boolean> {
  const normalized = normalizeKnowledgeTag(tag);
  const resolved = resolveDocument(normalized, docRef);
  if (!resolved.ok) return false;
  const doc = resolved.doc;

  const manifest = readKnowledgeManifest();
  const entry = manifest.tags[normalized];
  if (entry) {
    entry.documents = entry.documents.filter((d) => d.path !== doc.path);
    entry.chunkCount = Math.max(0, entry.chunkCount - doc.chunks);
    entry.updatedAt = Date.now();
    if (entry.documents.length === 0) delete manifest.tags[normalized];
    writeKnowledgeManifest(manifest);
  }

  const store = getVectorStore(namespaceForTag(normalized));
  const label = `${normalized}:${doc.path}`;
  for (let i = 0; i < doc.chunks; i += 1) {
    try {
      await store.delete(`${label}#${i}`);
    } catch {
      // Best-effort — a stale chunk is floored at query time rather than fatal.
    }
  }
  deleteStoredDocument(normalized, doc.docId);
  return true;
}

/** Remove a tag's vectors and manifest entry. Returns true when something was removed. */
export async function forgetKnowledgeTag(tag: string): Promise<boolean> {
  const normalized = normalizeKnowledgeTag(tag);
  const manifest = readKnowledgeManifest();
  const existed = Boolean(manifest.tags[normalized]);
  delete manifest.tags[normalized];
  writeKnowledgeManifest(manifest);
  try {
    await getVectorStore(namespaceForTag(normalized)).clear();
  } catch {
    // Best-effort — the manifest entry is already gone.
  }
  // The stored extracted text is user data too, and `forget` has to mean forget:
  // leaving it behind would keep the documents on disk with nothing pointing at
  // them, which is worse than either keeping or removing them.
  try {
    rmSync(documentStoreDir(normalized), { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
  return existed;
}

// ─── Sync ───────────────────────────────────────────────────────────────────

/** What a sync changed. `changed` and `added` re-embedded; `unchanged` did not. */
export interface SyncResult {
  tag: string;
  added: number;
  changed: number;
  unchanged: number;
  /** Documents dropped because they are no longer under a synced root. */
  removed: string[];
  chunks: number;
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Bring a tag up to date with the folders it is kept in step with.
 *
 * This is `add` plus the two things a folder being kept in step needs: content
 * hashes mean an unchanged file is not re-extracted, re-chunked or re-embedded,
 * and a file that has DISAPPEARED stops being served.
 *
 * Removal is scoped to the roots the caller actually synced. Syncing `./specs`
 * must not delete documents ingested from somewhere else, so a document is only
 * pruned when it lives under one of the synced directories AND was absent from
 * that directory's enumeration — a precise rule, rather than "anything not in
 * this list", which would quietly empty a tag the first time it was called with
 * the wrong path.
 */
export async function syncKnowledgeTag(
  tag: string,
  paths: string[],
  opts: KnowledgeOptions = {},
): Promise<SyncResult> {
  const normalized = normalizeKnowledgeTag(tag);
  const result: SyncResult = {
    tag: normalized,
    added: 0,
    changed: 0,
    unchanged: 0,
    removed: [],
    chunks: 0,
    skipped: [],
  };

  const files: string[] = [];
  const directoryRoots: string[] = [];
  for (const path of paths) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      result.skipped.push({ path, reason: 'not found' });
      continue;
    }
    if (stat.isDirectory()) {
      directoryRoots.push(path);
      collectKnowledgeFiles(path, files);
    } else {
      files.push(path);
    }
  }

  // Snapshot BEFORE the write: the difference between the two manifests is what
  // "added/changed/unchanged" means, and it must not be inferred from a counter.
  const before = new Map((getKnowledgeTag(normalized)?.documents ?? []).map((d) => [d.path, d]));
  const enumerated = new Set(files);

  const ingest = await ingestKnowledge(normalized, files, opts);
  result.skipped = ingest.skipped;
  result.chunks = ingest.chunks;

  // Classify the files the CALLER synced — the enumerated set — by diffing the
  // two manifests. A document that is about to be pruned must not be counted as
  // "unchanged": it is removed, and counting it here would report a sync as
  // having kept something it just deleted.
  const after = new Map((getKnowledgeTag(normalized)?.documents ?? []).map((d) => [d.path, d]));
  for (const path of enumerated) {
    const current = after.get(path);
    if (!current) continue; // could not be ingested — it is already in `skipped`
    const previous = before.get(path);
    if (!previous) result.added += 1;
    else if (previous.contentHash !== current.contentHash) result.changed += 1;
    else result.unchanged += 1;
  }

  for (const path of before.keys()) {
    if (enumerated.has(path)) continue;
    const underSyncedRoot = directoryRoots.some((root) =>
      path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`),
    );
    if (underSyncedRoot && (await removeKnowledgeDocument(normalized, path))) {
      result.removed.push(path);
    }
  }

  return result;
}

// ─── Formatting for the model ───────────────────────────────────────────────

/**
 * Render retrieved chunks as context that ATTRIBUTES each part to the user's
 * data. The model can then answer the data half from here and the generic half
 * from its own knowledge / `web-research`, and say which is which.
 */
export function formatKnowledgeContext(tag: string, hits: KnowledgeHit[]): string {
  const normalized = normalizeKnowledgeTag(tag);
  if (hits.length === 0) {
    return `No entries found for knowledge tag '${normalized}'. Ingest documents first with the knowledge tool (action: add).`;
  }
  const parts = hits.map((h) => {
    const name = basename(h.sourcePath);
    // The section is part of the citation: "clause 4" is not attributable
    // without it, and a reader checking the quote needs to know where to look.
    const section = h.headingPath ? ` · §${h.headingPath}` : '';
    // A term-only passage is marked as such: its `sim` is below the floor by
    // construction, and a bare low number next to USER DATA reads as a retrieval
    // mistake rather than as "this is the passage that contains your term".
    const evidence = h.evidence === 'term' ? ' · term match' : '';
    return `--- [from your data: ${name} · chunk ${h.chunkIndex + 1}${section} · sim ${h.similarity.toFixed(3)}${evidence}] ---\n${h.text}`;
  });
  return [
    `Knowledge tag: ${normalized} (${hits.length} relevant chunk${hits.length === 1 ? '' : 's'} from the user's own data)`,
    'Treat the following as USER DATA — quote it for facts about the user. For general advice, combine it with your own knowledge and, when current guidance is needed, the web-research tool, and say which part is which.',
    // Relevance is measured (see DEFAULT_KNOWLEDGE_MIN_SIMILARITY), but a floor
    // is a heuristic — so the fallback is stated as a policy, not left to chance:
    // passages that do not answer the question must be reported as insufficient
    // rather than stretched to fit.
    'If these passages do not answer the question, say so plainly and answer from your own knowledge — do not stretch them to fit, and never assert a fact about the user\'s data that is not in them.',
    '',
    ...parts,
  ].join('\n');
}

// Re-export for tests/callers that want the raw embedding defaults.
export { DEFAULT_CHUNK_TOKENS, DEFAULT_OVERLAP_TOKENS };
