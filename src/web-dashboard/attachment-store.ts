/**
 * Durable attachment store + bounded retrieval.
 *
 * WHY THIS EXISTS. The composer used to turn an attachment into ONE prompt
 * string and send it inline. That made upload size, extraction size and model
 * context size the same decision, so the smallest of the three silently became
 * the only size a user could attach. This module separates them:
 *
 *   upload bytes  -> durable artifact (any size the quota allows)
 *   extraction    -> full text, chunked and indexed on disk
 *   model context -> a small manifest plus the few chunks a question needs
 *
 * The model can then call `attachment_search` / `attachment_read` for more,
 * including on a later turn, because the attachment ID is persisted in the
 * conversation history rather than the file bytes.
 *
 * Storage layout (under `$NUVIRA_CONFIG_DIR`, default `~/.nuvira`):
 *
 *   attachments/objects/<uuid>/meta.json
 *   attachments/objects/<uuid>/original.<ext>
 *   attachments/objects/<uuid>/extracted.txt
 *   attachments/objects/<uuid>/chunks.jsonl
 *
 * Everything is per-file and best-effort atomic: metadata is written through a
 * temp file + rename, and a failed ingestion leaves a readable `failed` record
 * instead of a half-written `ready` one.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { resolveNuviraDataPath } from '../config/paths.js';
import {
  resolveAttachmentIngestMaxChars,
  resolveAttachmentRetentionDays,
  resolveAttachmentStoreMaxBytes,
  resolveAttachmentUploadMaxBytes,
} from '../config/limits.js';
import { getReadExtractManager } from '../tools/read-extract.js';

export type AttachmentStatus = 'uploading' | 'processing' | 'ready' | 'partial' | 'failed';
export type AttachmentKind = 'file' | 'paste' | 'drop';

export interface AttachmentRecord {
  id: string;
  sessionId: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  sha256: string;
  status: AttachmentStatus;
  createdAt: number;
  updatedAt: number;
  /** Extracted characters available to retrieval. */
  chars?: number;
  /** Number of stored chunks. */
  chunkCount?: number;
  pages?: number;
  pagesWithText?: number;
  sheets?: string[];
  slides?: number;
  rows?: number;
  truncated?: boolean;
  extractionError?: string;
  warnings?: string[];
  /** Absolute paths stay server-side; `publicRecord` removes them. */
  storagePath: string;
  extractedPath?: string;
  chunksPath?: string;
}

export interface PublicAttachment {
  id: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  status: AttachmentStatus;
  createdAt: number;
  updatedAt: number;
  chars?: number;
  chunkCount?: number;
  pages?: number;
  sheets?: string[];
  slides?: number;
  rows?: number;
  truncated?: boolean;
  error?: string;
  warnings?: string[];
}

export interface AttachmentChunk {
  index: number;
  locator: string;
  page?: number;
  sheet?: string;
  start: number;
  end: number;
  text: string;
}

export interface AttachmentHit extends AttachmentChunk {
  score: number;
  snippet: string;
}

export interface AttachmentUploadReceipt {
  tempPath: string;
  size: number;
  sha256: string;
}

export interface AttachmentUsage {
  count: number;
  bytes: number;
  /** Per-conversation totals, largest first. */
  sessions: Array<{ sessionId: string; count: number; bytes: number }>;
  oldestAt?: number;
}

export interface AttachmentPruneOptions {
  now?: number;
  maxAgeMs?: number;
  maxBytes?: number;
  /** Never remove an attachment this young, even when a cap is exceeded. */
  minAgeMs?: number;
  /** IDs referenced by a live or recently active conversation. */
  protectedIds?: Iterable<string>;
}

export interface AttachmentPruneResult {
  removed: number;
  bytesFreed: number;
  skipped: number;
  remainingBytes: number;
  remainingCount: number;
}

export class AttachmentUploadError extends Error {
  constructor(
    message: string,
    readonly code: 'too_large' | 'empty' | 'failed',
  ) {
    super(message);
    this.name = 'AttachmentUploadError';
  }
}

const MAX_CHUNK_CHARS = 6_000;
const CHUNK_OVERLAP_CHARS = 400;
const DEFAULT_READ_CHARS = 12_000;
const MAX_READ_CHARS = 40_000;

/** Keep a user-supplied session id from becoming a filesystem path. */
function safeSegment(value: string): string {
  const clean = value.trim().replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return clean || 'unknown';
}

/** Keep a filename's extension (read_extract dispatches on it) but nothing else. */
function safeName(name: string): string {
  const base = name.trim().replace(/\\/g, '/').split('/').pop() || 'attachment';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '');
  return cleaned.slice(0, 140) || 'attachment';
}

function extensionOf(name: string): string {
  const ext = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

/** A streamed file with no suffix still needs a reader dispatch key. */
function extensionFor(name: string, mime: string): string {
  const fromName = extensionOf(name);
  if (fromName) return fromName;
  const type = mime.toLowerCase().split(';')[0].trim();
  if (type === 'application/pdf') return '.pdf';
  if (type === 'application/json') return '.json';
  if (type === 'text/csv') return '.csv';
  if (type === 'text/markdown') return '.md';
  if (type === 'text/html') return '.html';
  if (type === 'application/xml' || type === 'text/xml') return '.xml';
  if (type === 'application/yaml' || type === 'text/yaml') return '.yaml';
  if (type.startsWith('text/')) return '.txt';
  return '.bin';
}

function publicRecord(record: AttachmentRecord): PublicAttachment {
  return {
    id: record.id,
    name: record.name,
    mime: record.mime,
    kind: record.kind,
    size: record.size,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.chars !== undefined ? { chars: record.chars } : {}),
    ...(record.chunkCount !== undefined ? { chunkCount: record.chunkCount } : {}),
    ...(record.pages !== undefined ? { pages: record.pages } : {}),
    ...(record.sheets && record.sheets.length > 0 ? { sheets: record.sheets } : {}),
    ...(record.slides !== undefined ? { slides: record.slides } : {}),
    ...(record.rows !== undefined ? { rows: record.rows } : {}),
    ...(record.truncated !== undefined ? { truncated: record.truncated } : {}),
    ...(record.extractionError ? { error: record.extractionError } : {}),
    ...(record.warnings && record.warnings.length > 0 ? { warnings: record.warnings } : {}),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

/**
 * Split extracted text into sections at the markers the readers already emit:
 * `[Page N]` for PDFs, `## Sheet: name` for workbooks. A plain document is one
 * section. Markers are metadata, so they stay on the locator rather than being
 * repeated inside every chunk.
 */
function sectionsOf(text: string): Array<{ locator?: string; page?: number; sheet?: string; text: string; offset: number }> {
  const marker = /^(?:\[Page\s+(\d+)\]|##\s*Sheet:\s*(.+))\s*$/gm;
  const matches = [...text.matchAll(marker)];
  if (matches.length === 0) return [{ text, offset: 0 }];

  const out: Array<{ locator?: string; page?: number; sheet?: string; text: string; offset: number }> = [];
  const preamble = text.slice(0, matches[0].index ?? 0);
  if (preamble.trim()) out.push({ text: preamble, offset: 0 });

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const page = match[1] ? Number(match[1]) : undefined;
    const sheet = match[2]?.trim() || undefined;
    out.push({
      text: text.slice(start, end).replace(/^\s*\n/, ''),
      offset: start,
      ...(page ? { page, locator: `page ${page}` } : {}),
      ...(sheet ? { sheet, locator: `sheet ${sheet}` } : {}),
    });
  }
  return out;
}

/**
 * Paragraph-aware chunks with a small overlap. The overlap is intentional: a
 * fact split across a chunk boundary must still be findable from either side.
 */
export function chunkAttachmentText(text: string): AttachmentChunk[] {
  const chunks: AttachmentChunk[] = [];
  let index = 0;
  for (const section of sectionsOf(text)) {
    if (!section.text.trim()) continue;
    let local = 0;
    while (local < section.text.length) {
      let end = Math.min(section.text.length, local + MAX_CHUNK_CHARS);
      if (end < section.text.length) {
        const boundary = section.text.lastIndexOf('\n', end);
        if (boundary > local + Math.floor(MAX_CHUNK_CHARS * 0.55)) end = boundary;
      }
      const body = section.text.slice(local, end).trim();
      if (body) {
        const start = section.offset + local;
        const finish = section.offset + end;
        chunks.push({
          index: index++,
          locator: `${section.locator ? `${section.locator}, ` : ''}chars ${formatCount(start + 1)}-${formatCount(finish)}`,
          ...(section.page ? { page: section.page } : {}),
          ...(section.sheet ? { sheet: section.sheet } : {}),
          start,
          end: finish,
          text: body,
        });
      }
      if (end >= section.text.length) break;
      local = Math.max(local + 1, end - CHUNK_OVERLAP_CHARS);
    }
  }
  return chunks;
}

function queryTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_]+/i)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2 && !['the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'when', 'where', 'which', 'how', 'why', 'are', 'was', 'were', 'you', 'your'].includes(t)),
    ),
  ).slice(0, 24);
}

function makeSnippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return text.slice(0, 360).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, at - 140);
  const end = Math.min(text.length, at + 320);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

export class AttachmentStore {
  private readonly processing = new Map<string, Promise<void>>();

  private root(): string {
    return process.env.NUVIRA_ATTACHMENT_DIR || resolveNuviraDataPath('attachments');
  }

  private objectsDir(): string {
    return join(this.root(), 'objects');
  }

  private tmpDir(): string {
    return join(this.root(), 'tmp');
  }

  private objectDir(id: string): string {
    return join(this.objectsDir(), id);
  }

  private metaPath(id: string): string {
    return join(this.objectDir(id), 'meta.json');
  }

  /** Validate an opaque id before it is joined into a path. */
  private validId(id: string): boolean {
    return /^[a-f0-9-]{36}$/i.test(id);
  }

  private readMeta(id: string): AttachmentRecord | null {
    if (!this.validId(id)) return null;
    try {
      const raw = readFileSync(this.metaPath(id), 'utf8');
      const parsed = JSON.parse(raw) as AttachmentRecord;
      if (!parsed || parsed.id !== id || typeof parsed.sessionId !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private writeMeta(record: AttachmentRecord): void {
    const dir = this.objectDir(record.id);
    mkdirSync(dir, { recursive: true });
    const target = this.metaPath(record.id);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    renameSync(tmp, target);
  }

  /** Start ingest exactly once per attachment, even if two turns ask at once. */
  private ensureIngest(id: string): Promise<void> {
    const existing = this.processing.get(id);
    if (existing) return existing;
    const run = this.ingest(id)
      .catch(() => {
        /* ingest records its own failure; this catch only protects the process */
      })
      .finally(() => {
        this.processing.delete(id);
      });
    this.processing.set(id, run);
    return run;
  }

  /**
   * Stream one upload into a temp file while hashing it. No JSON body, no
   * base64, and no full-file buffer: a multi-GB upload reaches disk in bounded
   * chunks.
   */
  async receiveUpload(
    stream: NodeJS.ReadableStream,
    opts: { maxBytes?: number } = {},
  ): Promise<AttachmentUploadReceipt> {
    mkdirSync(this.tmpDir(), { recursive: true });
    const id = randomUUID();
    const tempPath = join(this.tmpDir(), `${id}.part`);
    const maxBytes = opts.maxBytes ?? resolveAttachmentUploadMaxBytes();
    const hash = createHash('sha256');
    let size = 0;

    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > maxBytes) {
          callback(new AttachmentUploadError(
            `The attachment is larger than the ${formatBytes(maxBytes)} upload limit.`,
            'too_large',
          ));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(stream, meter, createWriteStream(tempPath));
    } catch (err) {
      rmSync(tempPath, { force: true });
      if (err instanceof AttachmentUploadError) throw err;
      throw new AttachmentUploadError(
        err instanceof Error ? err.message : 'The upload could not be written.',
        'failed',
      );
    }

    if (size === 0) {
      rmSync(tempPath, { force: true });
      throw new AttachmentUploadError('The upload was empty.', 'empty');
    }

    return { tempPath, size, sha256: hash.digest('hex') };
  }

  /**
   * Move a completed stream into the durable store and begin indexing. The
   * returned record is `processing`; callers can poll `get` or `waitFor`.
   */
  async finalizeUpload(input: {
    sessionId: string;
    name: string;
    mime?: string;
    kind?: AttachmentKind;
    receipt: AttachmentUploadReceipt;
  }): Promise<PublicAttachment> {
    const id = randomUUID();
    const name = safeName(input.name);
    const dir = this.objectDir(id);
    mkdirSync(dir, { recursive: true });
    const ext = extensionFor(name, input.mime || '');
    const original = join(dir, `original${ext}`);
    try {
      renameSync(input.receipt.tempPath, original);
    } catch (err) {
      rmSync(input.receipt.tempPath, { force: true });
      rmSync(dir, { recursive: true, force: true });
      throw new AttachmentUploadError(
        err instanceof Error ? err.message : 'The upload could not be stored.',
        'failed',
      );
    }

    const now = Date.now();
    const record: AttachmentRecord = {
      id,
      sessionId: safeSegment(input.sessionId),
      name,
      mime: input.mime?.trim() || 'application/octet-stream',
      kind: input.kind === 'paste' || input.kind === 'drop' ? input.kind : 'file',
      size: input.receipt.size,
      sha256: input.receipt.sha256,
      status: 'processing',
      createdAt: now,
      updatedAt: now,
      storagePath: original,
    };
    this.writeMeta(record);
    void this.ensureIngest(id);
    return publicRecord(record);
  }

  async ingest(id: string): Promise<void> {
    const record = this.readMeta(id);
    if (!record) return;
    const started = Date.now();
    const extraction = await getReadExtractManager()
      .extract(record.storagePath, {
        maxChars: resolveAttachmentIngestMaxChars(),
      })
      .catch((err: unknown) => ({
        success: false as const,
        error: err instanceof Error ? err.message : 'The document could not be extracted.',
        alternatives: [] as string[],
      }));

    if (!extraction.success) {
      const error = extraction.error || 'The document could not be extracted.';
      const done: AttachmentRecord = {
        ...record,
        status: 'failed',
        updatedAt: started,
        extractionError: error,
        warnings: extraction.alternatives ?? [],
      };
      writeFileSync(
        join(this.objectDir(id), 'extracted.txt'),
        `[The attached file "${record.name}" could not be read.]\nReason: ${error}\n`,
        'utf8',
      );
      this.writeMeta(done);
      return;
    }

    const text = extraction.text ?? '';
    const chunks = chunkAttachmentText(text);
    writeFileSync(join(this.objectDir(id), 'extracted.txt'), text, 'utf8');
    writeFileSync(
      join(this.objectDir(id), 'chunks.jsonl'),
      chunks.map((chunk) => JSON.stringify(chunk)).join('\n') + (chunks.length > 0 ? '\n' : ''),
      'utf8',
    );

    const warnings = extraction.metadata?.warnings ?? [];
    const done: AttachmentRecord = {
      ...record,
      status: extraction.metadata?.truncated ? 'partial' : 'ready',
      updatedAt: Date.now(),
      chars: text.length,
      chunkCount: chunks.length,
      ...(extraction.metadata?.pages !== undefined ? { pages: extraction.metadata.pages } : {}),
      ...(extraction.metadata?.pagesWithText !== undefined ? { pagesWithText: extraction.metadata.pagesWithText } : {}),
      ...(extraction.metadata?.sheets ? { sheets: extraction.metadata.sheets } : {}),
      ...(extraction.metadata?.slides !== undefined ? { slides: extraction.metadata.slides } : {}),
      ...(extraction.metadata?.rows !== undefined ? { rows: extraction.metadata.rows } : {}),
      ...(extraction.metadata?.truncated ? { truncated: true } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      extractedPath: join(this.objectDir(id), 'extracted.txt'),
      chunksPath: join(this.objectDir(id), 'chunks.jsonl'),
    };
    this.writeMeta(done);
  }

  get(id: string): PublicAttachment | null {
    const record = this.readMeta(id);
    return record ? publicRecord(record) : null;
  }

  raw(id: string): AttachmentRecord | null {
    return this.readMeta(id);
  }

  /** Wait up to `timeoutMs` for ingestion, so a fast text file is ready on the first turn. */
  async waitFor(id: string, timeoutMs = 1500): Promise<PublicAttachment | null> {
    const before = this.readMeta(id);
    if (!before) return null;
    if (before.status !== 'processing') return publicRecord(before);
    await Promise.race([
      this.ensureIngest(id),
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, timeoutMs))),
    ]);
    const after = this.readMeta(id);
    return after ? publicRecord(after) : null;
  }

  list(sessionId?: string): PublicAttachment[] {
    const dir = this.objectsDir();
    if (!existsSync(dir)) return [];
    const out: PublicAttachment[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !this.validId(entry.name)) continue;
      const record = this.readMeta(entry.name);
      if (!record) continue;
      if (sessionId && record.sessionId !== safeSegment(sessionId)) continue;
      out.push(publicRecord(record));
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  delete(id: string): boolean {
    const record = this.readMeta(id);
    if (!record) return false;
    const dir = this.objectDir(id);
    this.processing.delete(id);
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /** Every artifact's disk footprint, including metadata and retrieval index. */
  private directoryBytes(id: string): number {
    const dir = this.objectDir(id);
    if (!existsSync(dir)) return 0;
    let total = 0;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        try { total += statSync(join(dir, entry.name)).size; } catch { /* vanished */ }
      }
    } catch { /* unreadable object */ }
    return total;
  }

  private recordsWithBytes(): Array<{ record: AttachmentRecord; bytes: number }> {
    const dir = this.objectsDir();
    if (!existsSync(dir)) return [];
    const out: Array<{ record: AttachmentRecord; bytes: number }> = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !this.validId(entry.name)) continue;
      const record = this.readMeta(entry.name);
      if (record) out.push({ record, bytes: this.directoryBytes(entry.name) });
    }
    return out;
  }

  /** Stored bytes and counts, globally or for one conversation. */
  usage(sessionId?: string): AttachmentUsage {
    const wanted = sessionId ? safeSegment(sessionId) : undefined;
    const sessions = new Map<string, { sessionId: string; count: number; bytes: number }>();
    let count = 0;
    let bytes = 0;
    let oldestAt: number | undefined;
    for (const { record, bytes: size } of this.recordsWithBytes()) {
      if (wanted && record.sessionId !== wanted) continue;
      count += 1;
      bytes += size;
      oldestAt = oldestAt === undefined ? record.createdAt : Math.min(oldestAt, record.createdAt);
      const total = sessions.get(record.sessionId) ?? { sessionId: record.sessionId, count: 0, bytes: 0 };
      total.count += 1;
      total.bytes += size;
      sessions.set(record.sessionId, total);
    }
    return {
      count,
      bytes,
      sessions: [...sessions.values()].sort((a, b) => b.bytes - a.bytes),
      ...(oldestAt !== undefined ? { oldestAt } : {}),
    };
  }

  /**
   * Remove expired artifacts, then the oldest unprotected artifacts until the
   * store fits `maxBytes`. Ids referenced by a live/recent conversation and files
   * younger than `minAgeMs` are never removed. Safe to call on startup.
   */
  prune(opts: AttachmentPruneOptions = {}): AttachmentPruneResult {
    const now = opts.now ?? Date.now();
    const maxAgeMs = Math.max(0, opts.maxAgeMs ?? resolveAttachmentRetentionDays() * 86_400_000);
    const maxBytes = Math.max(0, opts.maxBytes ?? resolveAttachmentStoreMaxBytes());
    const minAgeMs = Math.max(0, opts.minAgeMs ?? 60 * 60 * 1000);
    const protectedIds = new Set(opts.protectedIds ?? []);
    const entries = this.recordsWithBytes().sort((a, b) => a.record.createdAt - b.record.createdAt);
    const kept = new Set(entries.map(({ record }) => record.id));
    let totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    let removed = 0;
    let bytesFreed = 0;
    let skipped = 0;

    const remove = (entry: { record: AttachmentRecord; bytes: number }): boolean => {
      const record = entry.record;
      if (!kept.has(record.id)) return false;
      if (protectedIds.has(record.id) || now - record.createdAt < minAgeMs || record.status === 'processing' || record.status === 'uploading') {
        skipped += 1;
        return false;
      }
      if (!this.delete(record.id)) {
        skipped += 1;
        return false;
      }
      kept.delete(record.id);
      removed += 1;
      bytesFreed += entry.bytes;
      totalBytes -= entry.bytes;
      return true;
    };

    for (const entry of entries) {
      if (now - entry.record.createdAt > maxAgeMs) remove(entry);
    }
    for (const entry of entries) {
      if (totalBytes <= maxBytes) break;
      remove(entry);
    }

    return {
      removed,
      bytesFreed,
      skipped,
      remainingBytes: totalBytes,
      remainingCount: kept.size,
    };
  }

  /** Read a bounded character window from the stored full extraction. */
  read(id: string, opts: { offset?: number; limit?: number } = {}): string {
    const record = this.readMeta(id);
    if (!record) return `No attachment with id "${id}".`;
    if (record.status === 'failed') {
      return `[Attachment "${record.name}" is NOT readable — do not describe its contents.]\nReason: ${record.extractionError || 'extraction failed'}`;
    }
    if (record.status === 'processing' || record.status === 'uploading') {
      return `[Attachment "${record.name}" is still being indexed. Try attachment_read again in a moment.]`;
    }
    const path = record.extractedPath || join(this.objectDir(id), 'extracted.txt');
    let text = '';
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return `[Attachment "${record.name}" has no extracted text on disk.]`;
    }
    const total = text.length;
    const offset = Math.max(0, Math.min(total, Math.floor(opts.offset ?? 0)));
    const limit = Math.max(1, Math.min(MAX_READ_CHARS, Math.floor(opts.limit ?? DEFAULT_READ_CHARS)));
    const end = Math.min(total, offset + limit);
    const body = text.slice(offset, end);
    const next = end < total ? `\n\n[Read up to ${formatCount(end)} of ${formatCount(total)} chars. Continue with offset=${end}.]` : '';
    return `[Attachment "${record.name}" — chars ${formatCount(offset + 1)}-${formatCount(end)} of ${formatCount(total)}]\n${body}${next}`;
  }

  /** Search the stored chunks. Deterministic keyword scoring — no model call. */
  search(id: string, query: string, limit = 5): { record: PublicAttachment; hits: AttachmentHit[] } | { error: string } {
    const record = this.readMeta(id);
    if (!record) return { error: `No attachment with id "${id}".` };
    if (record.status === 'failed') {
      return { error: `Attachment "${record.name}" is NOT readable: ${record.extractionError || 'extraction failed'}` };
    }
    if (record.status === 'processing' || record.status === 'uploading') {
      return { error: `Attachment "${record.name}" is still being indexed. Try again in a moment.` };
    }
    const terms = queryTerms(query);
    const chunks = this.chunks(id);
    const scored = chunks
      .map((chunk) => {
        const lower = chunk.text.toLowerCase();
        let score = 0;
        for (const term of terms) {
          let at = lower.indexOf(term);
          while (at >= 0) {
            score += 1;
            at = lower.indexOf(term, at + term.length);
          }
        }
        if (terms.length > 0 && lower.includes(query.trim().toLowerCase())) score += terms.length * 2;
        return { chunk, score };
      })
      .filter((x) => terms.length === 0 || x.score > 0)
      .sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index)
      .slice(0, Math.max(1, Math.min(20, limit)));

    return {
      record: publicRecord(record),
      hits: scored.map(({ chunk, score }) => ({ ...chunk, score, snippet: makeSnippet(chunk.text, terms) })),
    };
  }

  private chunks(id: string): AttachmentChunk[] {
    const record = this.readMeta(id);
    const path = record?.chunksPath || join(this.objectDir(id), 'chunks.jsonl');
    if (!existsSync(path)) return [];
    try {
      return readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as AttachmentChunk)
        .filter((chunk) => typeof chunk.text === 'string');
    } catch {
      return [];
    }
  }

  /** The model-facing description of one attachment. Deliberately small. */
  manifest(record: PublicAttachment): string {
    const facts = [
      `id="${record.id}"`,
      `name="${record.name}"`,
      `status=${record.status}`,
      `size=${formatBytes(record.size)}`,
    ];
    if (record.chars !== undefined) facts.push(`chars=${formatCount(record.chars)}`);
    if (record.pages !== undefined) facts.push(`pages=${formatCount(record.pages)}`);
    if (record.sheets && record.sheets.length > 0) facts.push(`sheets=${record.sheets.join('|')}`);
    if (record.slides !== undefined) facts.push(`slides=${formatCount(record.slides)}`);
    if (record.rows !== undefined) facts.push(`rows=${formatCount(record.rows)}`);
    if (record.truncated) facts.push('truncated=true');
    if (record.status === 'failed') {
      return `- ${facts.join('; ')}\n  NOT READABLE: ${record.error || 'extraction failed'}. Do not describe its contents.`;
    }
    if (record.status === 'processing') {
      return `- ${facts.join('; ')}\n  STILL INDEXING: do not claim to know its contents yet.`;
    }
    return (
      `- ${facts.join('; ')}\n` +
      `  Use attachment_search(id="${record.id}", query="…") to find passages, or ` +
      `attachment_read(id="${record.id}", offset=0, limit=${DEFAULT_READ_CHARS}) to page through the full text.`
    );
  }

  /**
   * Build the bounded turn context: every attachment's manifest, plus a small
   * number of relevant excerpts when a query can select them. This is the ONLY
   * attachment text that reaches the first model call; the rest is retrieved
   * on demand.
   */
  buildContext(
    ids: string[],
    query: string,
    opts: { maxChars?: number; maxHitsPerAttachment?: number } = {},
  ): { records: PublicAttachment[]; context: string } {
    const records: PublicAttachment[] = [];
    const lines: string[] = [];
    let remaining = Math.max(2_000, opts.maxChars ?? 14_000);
    const maxHits = Math.max(0, Math.min(6, opts.maxHitsPerAttachment ?? 2));

    for (const id of Array.from(new Set(ids)).slice(0, 10)) {
      const record = this.get(id);
      if (!record) continue;
      records.push(record);
      const manifest = this.manifest(record);
      lines.push(manifest);
      remaining -= manifest.length;
      if (remaining <= 0) continue;
      if (record.status !== 'ready' && record.status !== 'partial') continue;
      const found = this.search(id, query, maxHits);
      if ('error' in found) continue;
      for (const hit of found.hits) {
        if (remaining <= 200) break;
        // Centre the excerpt on the matched term. Taking the HEAD of the chunk
        // loses the very passage the query selected when the match sits later
        // in a 6K chunk (the first implementation did exactly that).
        const excerpt = hit.snippet.slice(0, Math.max(80, Math.min(remaining - 80, hit.snippet.length)));
        if (!excerpt.trim()) continue;
        lines.push(
          `  Excerpt [${hit.locator}]:\n${excerpt}${excerpt.length < hit.text.length ? '\n  …[excerpt truncated — use attachment_read for more]' : ''}`,
        );
        remaining -= excerpt.length + hit.locator.length + 40;
      }
    }

    return {
      records,
      context: lines.length > 0 ? `[Attachments]\n${lines.join('\n')}` : '',
    };
  }
}

let _store: AttachmentStore | null = null;

export function getAttachmentStore(): AttachmentStore {
  if (!_store) _store = new AttachmentStore();
  return _store;
}

export { publicRecord, formatBytes };
