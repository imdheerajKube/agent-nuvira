/**
 * DOCX text extraction via `mammoth`.
 *
 * A `.docx` is a ZIP of XML parts — reading it as UTF-8 and stripping tags
 * (the old implementation) recovers the container, not the words. Mammoth parses
 * the OOXML properly, so it resolves styles, numbering and tables, and reports the
 * parts it could not represent.
 *
 * Mammoth's HTML output is then run through `htmlToText`, which keeps table cells
 * on one line separated by ` | ` — the shape a reader needs to pair a value with
 * its reference range. Mammoth's own markdown output was not used because it does
 * not represent tables.
 */

import { htmlToText } from './html-text.js';

export interface DocxExtractResult {
  text: string;
  /** Non-fatal problems mammoth reported (unsupported styles, etc.). */
  warnings: string[];
  truncated: boolean;
}

/** Thrown when the bytes are not a readable DOCX. */
export class DocxExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocxExtractError';
  }
}

export async function extractDocxText(
  bytes: Buffer,
  opts: { maxChars: number },
): Promise<DocxExtractResult> {
  // mammoth ships CommonJS. Under Node's ESM interop the namespace import exposes
  // the functions directly, but a bundler (or a future ESM build) may only provide
  // them under `default` — so both shapes are accepted rather than assuming one.
  type ConvertToHtml = (input: { buffer: Buffer }) => Promise<{ value: string; messages: unknown[] }>;
  const mod = await import('mammoth');
  const convertToHtml: ConvertToHtml | undefined =
    (mod as unknown as { default?: { convertToHtml?: ConvertToHtml } }).default?.convertToHtml
    ?? (mod.convertToHtml as unknown as ConvertToHtml | undefined);

  if (typeof convertToHtml !== 'function') {
    throw new DocxExtractError('The DOCX reader (mammoth) did not load correctly.');
  }

  let value: string;
  let messages: unknown[];
  try {
    const result = await convertToHtml({ buffer: bytes });
    value = result.value;
    messages = result.messages ?? [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DocxExtractError(`The DOCX could not be read: ${msg}`);
  }

  const full = htmlToText(value);
  const truncated = full.length > opts.maxChars;

  return {
    text: truncated ? `${full.slice(0, opts.maxChars)}\n…[truncated]` : full,
    warnings: messages.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).slice(0, 10),
    truncated,
  };
}
