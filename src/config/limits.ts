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

/** Ceiling on the attachment cap, in bytes (256 MB). */
export const MAX_ATTACHMENT_MAX_BYTES_CEILING = 256 * 1024 * 1024;

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
