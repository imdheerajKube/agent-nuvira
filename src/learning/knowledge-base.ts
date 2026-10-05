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

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { embed, RETRIEVAL_MODEL } from '../memory/embedder.js';
import { getVectorStore } from '../memory/vector-store.js';
import type { VectorEntry } from '../memory/vector-store.js';
import { chunkText, DEFAULT_CHUNK_TOKENS, DEFAULT_OVERLAP_TOKENS } from './retrieval.js';
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

/** One document recorded under a tag. */
export interface KnowledgeDocument {
  path: string;
  chunks: number;
  addedAt: number;
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
}

/** Result of an ingest call. */
export interface IngestResult {
  tag: string;
  files: number;
  chunks: number;
  skipped: Array<{ path: string; reason: string }>;
}

/** Options shared by ingest/query. */
export interface KnowledgeOptions {
  chunkTokens?: number;
  overlapTokens?: number;
  topK?: number;
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
): Promise<number> {
  const normalized = normalizeKnowledgeTag(tag);
  const chunkTokens = opts.chunkTokens ?? DEFAULT_CHUNK_TOKENS;
  const overlapTokens = opts.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  const embedFn = opts.embedFn ?? ((t: string) => embed(t, undefined, false, RETRIEVAL_MODEL));

  const label = `${normalized}:${sourcePath}`;
  const chunks = chunkText(text, label, chunkTokens, overlapTokens);
  const store = getVectorStore(namespaceForTag(normalized));

  for (const chunk of chunks) {
    let vector: number[];
    try {
      vector = await embedFn(chunk.text);
    } catch {
      // A failed embed leaves a zero vector (never outranks a real match).
      vector = new Array(384).fill(0);
    }
    await store.insert(chunk.id, vector, {
      kind: 'knowledge-chunk',
      tag: normalized,
      sourcePath,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      tokenCount: chunk.tokenCount,
    });
  }
  return chunks.length;
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

  const result: IngestResult = { tag: normalized, files: 0, chunks: 0, skipped: [] };
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
      const chunks = await ingestKnowledgeText(normalized, file, extracted.text, opts);
      result.files += 1;
      result.chunks += chunks;
      // Re-ingesting a changed document replaces its chunks; keep the recorded
      // count in step by subtracting the previous contribution first.
      const previous = entry.documents.find((d) => d.path === file);
      if (previous) entry.chunkCount -= previous.chunks;
      entry.documents = entry.documents.filter((d) => d.path !== file);
      entry.documents.push({ path: file, chunks, addedAt: Date.now() });
      entry.chunkCount += chunks;
    } catch (err) {
      result.skipped.push({ path: file, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  entry.updatedAt = Date.now();
  manifest.tags[normalized] = entry;
  writeKnowledgeManifest(manifest);
  return result;
}

// ─── Query ──────────────────────────────────────────────────────────────────

/** Embed the question and return the tag's top-k chunks. Never throws. */
export async function queryKnowledge(
  tag: string,
  question: string,
  opts: KnowledgeOptions = {},
): Promise<KnowledgeHit[]> {
  const normalized = normalizeKnowledgeTag(tag);
  const topK = opts.topK ?? DEFAULT_KNOWLEDGE_TOP_K;
  const embedFn = opts.embedFn ?? ((t: string) => embed(t, undefined, false, RETRIEVAL_MODEL));

  try {
    const queryVector = await embedFn(question);
    const store = getVectorStore(namespaceForTag(normalized));
    const results = await store.search(queryVector, topK, (entry: VectorEntry) => {
      return entry.metadata?.kind === 'knowledge-chunk' && entry.metadata?.tag === normalized;
    });
    return results.map(({ entry, similarity }) => ({
      tag: normalized,
      text: String(entry.metadata?.text ?? ''),
      sourcePath: String(entry.metadata?.sourcePath ?? entry.id),
      chunkIndex: Number(entry.metadata?.chunkIndex ?? 0),
      similarity,
    }));
  } catch (err) {
    logger.debug(`Knowledge query failed for tag '${normalized}': ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

// ─── Forget ─────────────────────────────────────────────────────────────────

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
  return existed;
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
    return `--- [from your data: ${name} · chunk ${h.chunkIndex + 1} · sim ${h.similarity.toFixed(3)}] ---\n${h.text}`;
  });
  return [
    `Knowledge tag: ${normalized} (${hits.length} relevant chunk${hits.length === 1 ? '' : 's'} from the user's own data)`,
    'Treat the following as USER DATA — quote it for facts about the user. For general advice, combine it with your own knowledge and, when current guidance is needed, the web-research tool, and say which part is which.',
    '',
    ...parts,
  ].join('\n');
}

// Re-export for tests/callers that want the raw embedding defaults.
export { DEFAULT_CHUNK_TOKENS, DEFAULT_OVERLAP_TOKENS };
