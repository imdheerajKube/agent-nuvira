/**
 * tool-refusal — the contract for a tool that cannot do its work.
 *
 * Live incident (2026-09-27): a PDF blood report was placed in the project and
 * `read_extract` answered `{ text: '<%PDF-1.4 …raw bytes…>', format: 'pdf',
 * success: true }`. Nothing downstream could tell extraction had failed, so the
 * turn produced a generic Markdown template instead of an assessment, claimed to
 * have "verified that the file was created correctly", and only on the third turn
 * told the user the file had never been read.
 *
 * The failure was NOT the missing extractor. The same file already returns an
 * honest `success: false, error: 'XLSX extraction requires xlsx library'` for the
 * formats it never pretended to support. The failure was that an unsupported
 * format reported success — and a `success: true` on a path that performs no work
 * is the one defect the agent cannot recover from, because the signal it would
 * need to fall back on was replaced with a plausible result.
 *
 * So: a tool that cannot perform its action returns a `ToolRefusal` — a typed,
 * machine-readable "no" with a reason and, where one exists, the concrete thing
 * the caller can do instead. Tools whose backend is optional or unconfigured
 * additionally expose an `isXAvailable()` probe, mirrored into the tool
 * description, so the model can see what is real before choosing a tool (the
 * pattern `src/tools/modality/` already follows).
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** Why a tool refused. Deliberately small — every case maps to a different recovery. */
export type ToolRefusalCode =
  /** The input is a format this tool cannot read (no parser/backend for it). */
  | 'unsupported_format'
  /** The capability exists but its backend is missing or unconfigured (no key, no binary, no package). */
  | 'not_configured'
  /** The backend is present but the input is outside what it can do (e.g. a PDF page with no text layer). */
  | 'no_data'
  /** Temporarily unusable (backend up but broken, rate-limited, disabled by policy). */
  | 'unavailable';

export interface ToolRefusal {
  ok: false;
  code: ToolRefusalCode;
  /** One sentence, in the user's language, saying what is missing — never a stack trace. */
  reason: string;
  /** Concrete alternative actions, most useful first (another tool, a CLI command, a user action). */
  alternatives?: string[];
}

/** A refusal plus optional recovery detail a specific tool wants to carry. */
export interface RefusalField {
  code: ToolRefusalCode;
  alternatives?: string[];
}

// ─── Construction ───────────────────────────────────────────────────────────

/**
 * Build a `ToolRefusal`. `alternatives` is dropped when empty so a refusal never
 * renders an empty "alternatives: []" that reads like a real (empty) answer.
 */
export function refuse(
  code: ToolRefusalCode,
  reason: string,
  alternatives: string[] = [],
): ToolRefusal {
  const refusal: ToolRefusal = { ok: false, code, reason };
  if (alternatives.length > 0) refusal.alternatives = alternatives;
  return refusal;
}

/**
 * The refusal fields to spread into a tool's own success-shaped result, so a
 * legacy `{ success: boolean, error?: string }` payload becomes machine-readable
 * without changing its shape for existing readers.
 */
export function refusalFields(
  code: ToolRefusalCode,
  alternatives: string[] = [],
): RefusalField {
  const field: RefusalField = { code };
  if (alternatives.length > 0) field.alternatives = alternatives;
  return field;
}

// ─── Inspection ─────────────────────────────────────────────────────────────

/** True when `value` is a well-formed `ToolRefusal` (ok === false + a known code). */
export function isToolRefusal(value: unknown): value is ToolRefusal {
  if (!value || typeof value !== 'object') return false;
  const v = value as { ok?: unknown; code?: unknown };
  return v.ok === false && typeof v.code === 'string' && REFUSAL_CODES.has(v.code as ToolRefusalCode);
}

const REFUSAL_CODES = new Set<ToolRefusalCode>([
  'unsupported_format',
  'not_configured',
  'no_data',
  'unavailable',
]);

/**
 * One-line, model-facing rendering of a refusal. Tools that already return JSON
 * keep returning JSON; this is for the surfaces that print a single string.
 */
export function formatRefusal(r: ToolRefusal): string {
  const alt = r.alternatives && r.alternatives.length > 0 ? ` Instead: ${r.alternatives.join(' | ')}` : '';
  return `[${r.code}] ${r.reason}${alt}`;
}

/** Human-readable phrase per code, for UI surfaces that show a badge. */
export function refusalLabel(code: ToolRefusalCode): string {
  switch (code) {
    case 'unsupported_format': return 'unsupported format';
    case 'not_configured': return 'not configured';
    case 'no_data': return 'nothing to read';
    case 'unavailable': return 'temporarily unavailable';
  }
}
