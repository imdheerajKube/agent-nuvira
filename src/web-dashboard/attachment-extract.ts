/**
 * P2 — attachment hydration: turn a composer attachment into text the model can use.
 *
 * The composer used to read EVERY attached file with `File.text()` and ship the result
 * inline. For a PDF that is the file's bytes decoded as UTF-8, which is how the
 * 2026-09-27 incident happened: `[Attachment: report.pdf]` arrived carrying
 * `%PDF-1.4 … /FlateDecode …`, the model could not assess anything, and nothing told
 * anyone extraction had failed. `chat-console.ts` even documented the intended
 * behaviour ("binary files are rejected client-side") while no code implemented it.
 *
 * Now the client encodes what it cannot read as base64 and this module does the
 * extraction server-side, through the SAME `read_extract` path the agent uses for a
 * file in the project folder. So an attachment and a workspace file can never disagree
 * about whether a document is readable — and a refusal is carried into the turn as a
 * refusal, never as mojibake.
 *
 * Security posture: bytes are written only into a fresh throwaway directory, with a
 * sanitised basename, under a hard size cap, and the directory is removed afterwards.
 * Nothing is executed, and nothing outside that directory is read or written.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { getReadExtractManager } from '../tools/read-extract.js';
import { resolveAttachmentMaxBytes } from '../config/limits.js';

/** Cap on attachments per turn (the composer allows 10). */
export const MAX_ATTACHMENTS = 10;
/** Cap on inline text content, in characters. */
export const MAX_TEXT_CHARS = 300_000;
/**
 * The DEFAULT cap on decoded binary content, in bytes.
 *
 * Kept as the documented default and the value tests pin; the effective cap is
 * `resolveAttachmentMaxBytes()` (`NUVIRA_ATTACHMENT_MAX_BYTES`), read fresh on
 * every hydration so a user can raise it for a larger file without a rebuild.
 * A project file over the default had no route into a turn at all.
 */
export const MAX_BINARY_BYTES = 300_000;

export interface RawAttachment {
  name?: unknown;
  content?: unknown;
  /** 'base64' for bytes the client could not decode as text; absent means inline text. */
  encoding?: unknown;
  kind?: unknown;
}

/** The composer's chip kinds — mirrors `ChatAttachment.kind` in chat-console.ts. */
export type AttachmentKind = 'file' | 'paste' | 'drop';

export interface HydratedAttachment {
  name: string;
  /** What the model sees: the extracted text, or a plain statement that it failed. */
  content: string;
  /** ChatAttachment's union — so a hydrated list passes straight to the engine. */
  kind: AttachmentKind;
  /** True when the content came from parsing binary bytes. */
  extracted?: boolean;
  /** The extractor's typed refusal code, when extraction failed. */
  refusalCode?: string;
}

/** Coerce a wire value to a known chip kind; anything else is an uploaded file. */
function normalizeKind(kind: unknown): AttachmentKind {
  return kind === 'paste' || kind === 'drop' ? kind : 'file';
}

/**
 * Sanitise an attachment name into a safe basename that keeps its extension —
 * `read_extract` dispatches on the extension, so dropping it would make a PDF
 * unreadable. Path separators and anything exotic are removed.
 */
export function safeAttachmentName(name: string): string {
  const base = basename(name.trim().replace(/\\/g, '/'));
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '');
  return cleaned.slice(0, 100) || 'attachment';
}

/**
 * Hydrate raw composer attachments into model-ready text.
 *
 * Text attachments pass through (capped). Base64 attachments are written to a
 * throwaway dir, run through `read_extract`, and replaced with either the extracted
 * text or an explicit refusal.
 */
export async function hydrateAttachments(
  raw: unknown,
  opts: { max?: number; tmpRoot?: string } = {},
): Promise<HydratedAttachment[]> {
  if (!Array.isArray(raw)) return [];
  const max = opts.max ?? MAX_ATTACHMENTS;

  const candidates = raw
    .filter((a): a is RawAttachment => !!a && typeof a === 'object')
    .filter((a) => typeof a.name === 'string' && (a.name as string).trim().length > 0)
    .filter((a) => typeof a.content === 'string')
    .slice(0, max);

  if (candidates.length === 0) return [];

  const binary = candidates.filter((a) => a.encoding === 'base64');
  const text = candidates.filter((a) => a.encoding !== 'base64');

  const out: HydratedAttachment[] = [];

  for (const a of text) {
    out.push({
      name: sanitize(a.name as string),
      content: (a.content as string).slice(0, MAX_TEXT_CHARS),
      kind: normalizeKind(a.kind),
    });
  }

  if (binary.length === 0) return out;

  const dir = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), 'nuvira-attach-'));
  try {
    for (const a of binary) {
      out.push(await hydrateOneBinary(a, dir));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  return out;
}

// ─── Internals ──────────────────────────────────────────────────────────────

async function hydrateOneBinary(a: RawAttachment, dir: string): Promise<HydratedAttachment> {
  const name = sanitize(a.name as string);
  const kind = normalizeKind(a.kind);
  const b64 = (a.content as string).trim();

  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, 'base64');
  } catch {
    return refusal(name, kind, 'The attachment was not valid base64, so its bytes could not be read.');
  }

  if (bytes.length === 0) {
    return refusal(name, kind, 'The attachment decoded to zero bytes, so there was nothing to read.');
  }
  const maxBytes = resolveAttachmentMaxBytes();
  if (bytes.length > maxBytes) {
    return refusal(
      name,
      kind,
      `The attachment is larger than the ${Math.round(maxBytes / 1024)} KB limit (${Math.round(bytes.length / 1024)} KB), so it was not read.`
      + ' Raise the limit with NUVIRA_ATTACHMENT_MAX_BYTES (dashboard → Process Environment, or'
      + ' `nuvira config limit set attachment-max-kb <n>`).',
    );
  }

  const target = join(dir, name);
  writeFileSync(target, bytes);

  const result = await getReadExtractManager().extract(target);

  if (!result.success) {
    const alternatives = (result.alternatives ?? []).map((x) => `- ${x}`).join('\n');
    return {
      name,
      kind,
      extracted: false,
      refusalCode: result.code ?? 'unavailable',
      content:
        `[The attached file "${name}" could NOT be read — do not describe or summarise its contents.]\n`
        + `Reason: ${result.error ?? 'extraction failed'}\n`
        + (alternatives ? `What can be done instead:\n${alternatives}\n` : ''),
    };
  }

  // Extraction succeeded. Carry the provenance the model needs: how it was read, and
  // whether the text is a transcription (OCR) rather than a parsed layer.
  const notes: string[] = [];
  if (result.metadata?.ocr) {
    notes.push('recovered by OCR from page images — verify digits against the original');
  }
  if (result.metadata?.truncated) {
    notes.push('truncated to the extraction character budget');
  }
  for (const w of result.metadata?.warnings ?? []) notes.push(w);

  const header =
    `[Extracted from the attached file "${name}" (${result.format}`
    + (result.metadata?.pages ? `, ${result.metadata.pages} page(s)` : '')
    + (result.metadata?.slides ? `, ${result.metadata.slides} slide(s)` : '')
    + (result.metadata?.sheets ? `, sheet(s): ${result.metadata.sheets.join(', ')}` : '')
    + `)${notes.length > 0 ? ` — note: ${notes.join('; ')}` : ''}]\n`;

  return {
    name,
    kind,
    extracted: true,
    content: header + result.text,
  };
}

function sanitize(name: string): string {
  return safeAttachmentName(name);
}

function refusal(name: string, kind: AttachmentKind, reason: string): HydratedAttachment {
  return {
    name,
    kind,
    extracted: false,
    refusalCode: 'unsupported_format',
    content: `[The attached file "${name}" could NOT be read — do not describe or summarise its contents.]\nReason: ${reason}\n`,
  };
}
