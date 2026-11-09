/**
 * Configurable size limits — how much text one read may carry into a turn.
 *
 * Two limits used to be hardcoded constants that a user could not move:
 *
 *   - `read_extract` capped one extraction at 40,000 characters. A 66,021-char
 *     lab report was therefore read only in part, and — worse — the truncation
 *     was reported in `metadata.truncated` but NOT in the text, so the model
 *     could (and did) assess half a document as if it were the whole one.
 *   - the dashboard composer refused any attachment over 300 KB. A project file
 *     larger than that had no route in at all.
 *
 * Both are now read from the environment on every call (so a change takes effect
 * on the NEXT turn, and a value exported in a shell wins over the file, exactly
 * like every other process switch), with the historical values as the defaults.
 * The readers are pure and never throw: a malformed value falls back to the
 * default rather than breaking a read.
 *
 * Names are `NUVIRA_*`; the `BUFF_*` aliases are accepted for compatibility.
 */

/** The historical `read_extract` cap, in characters. */
export const DEFAULT_EXTRACT_MAX_CHARS = 40_000;

/** The historical dashboard attachment cap, in bytes (~300 KB). */
export const DEFAULT_ATTACHMENT_MAX_BYTES = 300_000;

/**
 * A sane upper bound, so a typo cannot ask for a gigabyte of extraction text and
 * take the process out. 8M characters is ~2M tokens — already far past any
 * model's window, so this only ever bites a mistake.
 */
export const MAX_EXTRACT_MAX_CHARS_CEILING = 8_000_000;

/** Ceiling on the legacy inline attachment cap, in bytes (256 MB). */
export const MAX_ATTACHMENT_MAX_BYTES_CEILING = 256 * 1024 * 1024;

/**
 * Default cap for a STREAMED upload, in bytes (2 GB).
 *
 * The old 300 KB constant applied to a JSON body that carried the file inline,
 * which conflated "what can be uploaded" with "what can be put in a prompt". A
 * streamed upload is stored as an artifact and read through retrieval tools, so
 * its limit is a disk/quota decision rather than a context-window decision.
 */
export const DEFAULT_ATTACHMENT_UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** Ceiling on a streamed upload, in bytes (8 GB). */
export const MAX_ATTACHMENT_UPLOAD_MAX_BYTES_CEILING = 8 * 1024 * 1024 * 1024;

/**
 * Default character budget for INGESTING an attachment (20M chars).
 *
 * This is deliberately much larger than one tool result: ingestion stores the
 * whole extracted document in chunks, while `attachment_read` returns a bounded
 * window. The old 40K budget was applied at ingestion time, so the rest of a
 * document never existed anywhere and could never be retrieved later.
 */
export const DEFAULT_ATTACHMENT_INGEST_MAX_CHARS = 20_000_000;

/** Ceiling on ingestion text, in characters (100M). */
export const MAX_ATTACHMENT_INGEST_MAX_CHARS_CEILING = 100_000_000;

/** How long an attachment nobody references is kept (30 days). */
export const DEFAULT_ATTACHMENT_RETENTION_DAYS = 30;

/** Ceiling on attachment retention, in days (one year). */
export const MAX_ATTACHMENT_RETENTION_DAYS_CEILING = 365;

/** Total attachment-store budget (50 GB). */
export const DEFAULT_ATTACHMENT_STORE_MAX_BYTES = 50 * 1024 * 1024 * 1024;

/** Ceiling on the total store, in bytes (1 TB). */
export const MAX_ATTACHMENT_STORE_MAX_BYTES_CEILING = 1024 * 1024 * 1024 * 1024;

/** One conversation's attachment budget (10 GB). */
export const DEFAULT_ATTACHMENT_SESSION_MAX_BYTES = 10 * 1024 * 1024 * 1024;

/** Ceiling on one conversation's budget, in bytes (100 GB). */
export const MAX_ATTACHMENT_SESSION_MAX_BYTES_CEILING = 100 * 1024 * 1024 * 1024;

/** Read an integer from the environment, falling back to `fallback` on anything invalid. */
function intFromEnv(names: string[], fallback: number, min: number, max: number): number {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') continue;
    const n = Number(raw.trim());
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) continue;
    return Math.min(n, max);
  }
  return fallback;
}

/**
 * The character budget for one `read_extract` call.
 *
 * Read fresh on every call, so setting the env var (from the dashboard's Process
 * Environment page, the CLI, or a shell export) applies to the next read without
 * a restart.
 */
export function resolveExtractMaxChars(): number {
  return intFromEnv(
    ['NUVIRA_EXTRACT_MAX_CHARS', 'BUFF_EXTRACT_MAX_CHARS'],
    DEFAULT_EXTRACT_MAX_CHARS,
    1,
    MAX_EXTRACT_MAX_CHARS_CEILING,
  );
}

/**
 * The size cap for one composer attachment, in bytes.
 *
 * Read fresh on every hydration, so raising it takes effect on the next turn.
 */
export function resolveAttachmentMaxBytes(): number {
  return intFromEnv(
    ['NUVIRA_ATTACHMENT_MAX_BYTES', 'BUFF_ATTACHMENT_MAX_BYTES'],
    DEFAULT_ATTACHMENT_MAX_BYTES,
    1,
    MAX_ATTACHMENT_MAX_BYTES_CEILING,
  );
}

/** The size cap for one streamed attachment upload, in bytes. */
export function resolveAttachmentUploadMaxBytes(): number {
  return intFromEnv(
    ['NUVIRA_ATTACHMENT_UPLOAD_MAX_BYTES', 'BUFF_ATTACHMENT_UPLOAD_MAX_BYTES'],
    DEFAULT_ATTACHMENT_UPLOAD_MAX_BYTES,
    1,
    MAX_ATTACHMENT_UPLOAD_MAX_BYTES_CEILING,
  );
}

/** The character budget used while INDEXING an attachment. */
export function resolveAttachmentIngestMaxChars(): number {
  return intFromEnv(
    ['NUVIRA_ATTACHMENT_INGEST_MAX_CHARS', 'BUFF_ATTACHMENT_INGEST_MAX_CHARS'],
    DEFAULT_ATTACHMENT_INGEST_MAX_CHARS,
    1,
    MAX_ATTACHMENT_INGEST_MAX_CHARS_CEILING,
  );
}

/** How long an unreferenced attachment is retained, in days. */
export function resolveAttachmentRetentionDays(): number {
  return intFromEnv(
    ['NUVIRA_ATTACHMENT_RETENTION_DAYS', 'BUFF_ATTACHMENT_RETENTION_DAYS'],
    DEFAULT_ATTACHMENT_RETENTION_DAYS,
    1,
    MAX_ATTACHMENT_RETENTION_DAYS_CEILING,
  );
}

/** Total disk budget for the durable attachment store, in bytes. */
export function resolveAttachmentStoreMaxBytes(): number {
  return intFromEnv(
    ['NUVIRA_ATTACHMENT_STORE_MAX_BYTES', 'BUFF_ATTACHMENT_STORE_MAX_BYTES'],
    DEFAULT_ATTACHMENT_STORE_MAX_BYTES,
    1,
    MAX_ATTACHMENT_STORE_MAX_BYTES_CEILING,
  );
}

/** One conversation's disk budget for durable attachments, in bytes. */
export function resolveAttachmentSessionMaxBytes(): number {
  return intFromEnv(
    ['NUVIRA_ATTACHMENT_SESSION_MAX_BYTES', 'BUFF_ATTACHMENT_SESSION_MAX_BYTES'],
    DEFAULT_ATTACHMENT_SESSION_MAX_BYTES,
    1,
    MAX_ATTACHMENT_SESSION_MAX_BYTES_CEILING,
  );
}

/**
 * Optional absolute floor for the cross-encoder relevance score. A negative
 * value is valid: MS MARCO logits put unrelated passages well below zero. When
 * unset, there is no absolute gate and the lexical generic-term guard remains
 * the only abstention rule. The default stays unset until real unanswered
 * questions exist; a threshold tuned on the authored fixtures is not a
 * calibration.
 */
export function resolveAttachmentRerankMinScore(): number | undefined {
  for (const name of ['NUVIRA_ATTACHMENT_RERANK_MIN_SCORE', 'BUFF_ATTACHMENT_RERANK_MIN_SCORE']) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') continue;
    const value = Number(raw.trim());
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}
