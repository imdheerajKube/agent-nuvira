/**
 * PDF text extraction — real parsing, table rows preserved.
 *
 * Why a parser is required (and why the previous implementation could never work):
 * a PDF stores its glyphs inside FlateDecode-compressed content streams, positioned
 * by a text matrix, with the glyph codes mapped back to characters through the
 * font's encoding/ToUnicode CMap. Reading the file as UTF-8 and stripping
 * non-printable bytes therefore recovers the *container*, never the text — which
 * is what `read_extract` used to present as a successful extraction.
 *
 * `pdfjs-dist/legacy/build/pdf.mjs` is used rather than the modern build: pdf.js
 * itself prints "Please use the `legacy` build in Node.js environments" for the
 * default entry, and the legacy build is the one that avoids browser-only globals.
 *
 * Table structure is reconstructed from geometry, because a lab report is a table
 * and the value/reference-range pairing is the whole point of reading it:
 *   - items are grouped into lines by their baseline `y` (transform[5]);
 *   - items on a line are ordered by `x` (transform[4]);
 *   - the horizontal gap between consecutive items decides the separator —
 *     nothing (a run split mid-word by kerning), a space, or ` | ` (a column
 *     boundary).
 * A page with no text items at all is reported as having no text layer rather
 * than returned as empty text, so a scanned report is a typed refusal instead of
 * a silent blank.
 */

/** One text item reduced to what line reconstruction needs. */
interface PositionedItem {
  str: string;
  x: number;
  y: number;
  width: number;
  size: number;
}

export interface PdfExtractResult {
  text: string;
  pages: number;
  /** Pages that yielded at least one non-whitespace text item. */
  pagesWithText: number;
  /** Page numbers (1-based) with no text layer — scanned/image-only pages. */
  pagesWithoutText: number[];
  truncated: boolean;
}

/** Thrown for inputs pdf.js parsed but could not read (encrypted, corrupt). */
export class PdfExtractError extends Error {
  constructor(message: string, readonly encrypted = false) {
    super(message);
    this.name = 'PdfExtractError';
  }
}

/** Bump when the reconstruction rules change. */
export const PDF_EXTRACTOR_VERSION = 1;

/**
 * Extract text from A4-ish PDF bytes, page by page.
 *
 * `maxChars` bounds the returned text; `truncated` says whether it was hit, so a
 * caller can never mistake a partial document for the whole one.
 */
export async function extractPdfText(
  bytes: Uint8Array,
  opts: { maxChars: number },
): Promise<PdfExtractResult> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // A document is untrusted input: no font/image fetching from inside the parser,
  // and no font faces built for a canvas we never render to.
  const task = pdfjs.getDocument({
    data: bytes,
    useWorkerFetch: false,
    useSystemFonts: true,
    disableFontFace: true,
  });

  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name ?? '';
    if (name === 'PasswordException') {
      throw new PdfExtractError('The PDF is password-protected, so its text could not be read.', true);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new PdfExtractError(`The PDF could not be opened: ${msg}`);
  }

  const pages: string[] = [];
  const pagesWithoutText: number[] = [];
  let budget = opts.maxChars;
  let truncated = false;

  try {
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      const items = toPositionedItems(content.items as unknown[]);
      const pageText = renderLines(items);

      if (pageText.length === 0) {
        pagesWithoutText.push(pageNo);
        // Kept in the output: a missing page is information, and silently
        // skipping it would misreport the document's shape.
        pages.push(`[Page ${pageNo}: no extractable text — this page is an image (scanned) or empty]`);
        continue;
      }

      if (pageText.length > budget) {
        pages.push(pageText.slice(0, Math.max(0, budget)) + '\n…[page truncated]');
        truncated = true;
        budget = 0;
      } else {
        pages.push(pageText);
        budget -= pageText.length;
      }

      page.cleanup();
      if (budget <= 0 && pageNo < doc.numPages) {
        truncated = true;
        pages.push(`[Remaining ${doc.numPages - pageNo} page(s) not read — increase the character budget to read them]`);
        break;
      }
    }
  } finally {
    // Release the parsed document (and its worker) — the loading task owns the
    // lifecycle in pdf.js v5+, not the document proxy.
    await task.destroy().catch(() => undefined);
  }

  const text = pages
    .map((p, i) => (doc.numPages > 1 ? `[Page ${i + 1}]\n${p}` : p))
    .join('\n\n');

  return {
    text,
    pages: doc.numPages,
    pagesWithText: doc.numPages - pagesWithoutText.length,
    pagesWithoutText,
    truncated,
  };
}

// ─── Internals ──────────────────────────────────────────────────────────────

/** Reduce pdf.js text items to positioned strings, dropping empty runs. */
function toPositionedItems(items: unknown[]): PositionedItem[] {
  const out: PositionedItem[] = [];

  for (const raw of items) {
    const it = raw as { str?: string; width?: number; transform?: number[] };
    const str = it.str ?? '';
    if (str.trim().length === 0) continue;
    const t = it.transform;
    if (!t || t.length < 6) continue;

    // transform = [a, b, c, d, e, f]; e/f are the run's x/y origin, d is the
    // vertical scale — effectively the font size for horizontal text.
    const size = Math.abs(t[3]) || Math.abs(t[0]) || 10;
    out.push({
      str,
      x: t[4],
      y: t[5],
      width: it.width ?? 0,
      size,
    });
  }

  return out;
}

/** Group items into visual lines and join each one. */
function renderLines(items: PositionedItem[]): string {
  if (items.length === 0) return '';

  // Group by baseline. Tolerance scales with the glyph size so a line whose runs
  // sit a hair apart vertically is not split into two rows.
  const lines: { y: number; items: PositionedItem[] }[] = [];
  for (const item of items) {
    const tol = Math.max(1.5, item.size * 0.4);
    const line = lines.find((l) => Math.abs(l.y - item.y) <= tol);
    if (line) {
      line.items.push(item);
      // Track the average so a slow drift across a wide table does not create
      // a new line on every column.
      line.y = (line.y * (line.items.length - 1) + item.y) / line.items.length;
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }

  // PDF y grows upward, so the topmost line has the largest y.
  lines.sort((a, b) => b.y - a.y);

  return lines
    .map((l) => joinLine(l.items.slice().sort((a, b) => a.x - b.x)))
    .filter((l) => l.length > 0)
    .join('\n');
}

/**
 * Join the runs of one line, choosing a separator from the gap between them.
 * Gap thresholds are expressed in multiples of the glyph size (em).
 */
export function joinLine(items: PositionedItem[]): string {
  let out = '';
  let prev: PositionedItem | null = null;

  for (const item of items) {
    const text = item.str.replace(/\s+$/, '');
    if (text.length === 0) continue;

    if (prev === null) {
      out = text;
      prev = item;
      continue;
    }

    const em = Math.max(prev.size, item.size) || 10;
    const gap = item.x - (prev.x + prev.width);

    let sep: string;
    if (gap <= em * 0.12) sep = '';          // same word, split by kerning
    else if (gap <= em * 0.7) sep = ' ';     // a space within a phrase
    else sep = ' | ';                        // a column boundary

    out += sep + text;
    prev = item;
  }

  return out.replace(/\s+/g, ' ').trim();
}
