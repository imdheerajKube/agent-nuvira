/**
 * PPTX text extraction via `fflate` + direct XML reading.
 *
 * A `.pptx` is a ZIP of XML parts; slide text lives in `ppt/slides/slideN.xml`
 * inside `<a:t>` runs, grouped into paragraphs by `<a:p>`. The reader unzips in
 * memory, walks the slides in numeric order, and keeps each `<a:p>` on its own
 * line — so bullet lines stay distinct rather than collapsing into one blob.
 *
 * `fflate` was chosen over a spreadsheet library's bundled ZIP code because it is
 * a zero-dependency leaf and this is the only place a raw ZIP is needed. Spreadsheet
 * text deliberately goes through SheetJS instead (see xlsx.ts) so cell formats are
 * interpreted rather than guessed.
 */

import { decodeEntities } from './html-text.js';

export interface PptxExtractResult {
  text: string;
  slides: number;
  truncated: boolean;
  /** Slide numbers present in the file that carried no text at all. */
  emptySlides: number[];
}

export class PptxExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PptxExtractError';
  }
}

export async function extractPptxText(
  bytes: Buffer,
  opts: { maxChars: number },
): Promise<PptxExtractResult> {
  const { unzipSync, strFromU8 } = await import('fflate');

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(bytes));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PptxExtractError(`The presentation could not be opened as a ZIP container: ${msg}`);
  }

  const slideNumbers = Object.keys(entries)
    .map((path) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(path))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number.parseInt(m[1], 10))
    .sort((a, b) => a - b);

  if (slideNumbers.length === 0) {
    throw new PptxExtractError('No slides were found — the file does not look like a .pptx presentation.');
  }

  const parts: string[] = [];
  const emptySlides: number[] = [];
  let used = 0;
  let truncated = false;

  for (const n of slideNumbers) {
    const xml = strFromU8(entries[`ppt/slides/slide${n}.xml`]);
    const body = slideText(xml);

    if (body.length === 0) {
      emptySlides.push(n);
      continue;
    }

    const chunk = `## Slide ${n}\n${body}`;
    if (used + chunk.length > opts.maxChars) {
      parts.push(`${chunk.slice(0, Math.max(0, opts.maxChars - used))}\n…[slides truncated]`);
      truncated = true;
      break;
    }
    parts.push(chunk);
    used += chunk.length;
  }

  return { text: parts.join('\n\n'), slides: slideNumbers.length, truncated, emptySlides };
}

/**
 * Pull the text out of one slide's XML: each `<a:p>` paragraph on its own line,
 * its `<a:t>` runs concatenated (run splits are kerning, not word breaks).
 */
export function slideText(xml: string): string {
  const paragraphs = xml.split(/<\/a:p>/);

  return paragraphs
    .map((p) => {
      const runs = [...p.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
        .map((m) => decodeEntities(m[1]))
        .join('');
      return runs.replace(/\s+/g, ' ').trim();
    })
    .filter((line) => line.length > 0)
    .join('\n');
}
