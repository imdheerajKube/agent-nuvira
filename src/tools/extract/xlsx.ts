/**
 * XLSX text extraction via SheetJS (`@e965/xlsx`).
 *
 * A `.xlsx` is a ZIP of XML parts; the old implementation returned an empty string
 * and an "requires xlsx library" error (honest, but useless).
 *
 * Why SheetJS and not a hand-rolled ZIP+XML reader: `raw: false` makes SheetJS
 * apply each cell's number format, so a date cell comes out as a date rather than
 * its serial (45000-ish). Emitting serials to a model reading a health panel would
 * be exactly the silent-wrongness this workstream exists to remove, and re-deriving
 * Excel's format rules is not a small job.
 *
 * Distribution note: the `xlsx` name on the public npm registry is stale at 0.18.5
 * (SheetJS moved distribution to cdn.sheetjs.com). `@e965/xlsx` republishes the
 * official 0.20.3 build on the registry with zero dependencies; it is pinned
 * exactly in package.json. See TOOL_TRUTHFULNESS_TRACKER.md P1.1.
 *
 * Every cell is formatted to a string and rows become `a | b | c` lines, so the
 * row/column pairing survives — the same shape as the CSV and DOCX readers.
 */

export interface XlsxExtractResult {
  text: string;
  sheets: string[];
  /** Total non-empty rows across all sheets. */
  rows: number;
  truncated: boolean;
  /** Sheet names skipped because the character budget ran out. */
  skippedSheets: string[];
}

export class XlsxExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxExtractError';
  }
}

/**
 * Re-format every date cell to ISO, and drop its cached rendering (`w`) so it is
 * recomputed.
 *
 * A sheet's own date format is usually `m/d/yy`, which is genuinely ambiguous —
 * `3/4/26` is a different day either side of the Atlantic, and a model reasoning
 * about a health trend across months cannot resolve it. `dateNF` alone does not win
 * against a cell that already carries a format, which is why this is explicit.
 * Exported for tests.
 */
export function normalizeDateFormats(sheet: unknown, iso: string): void {
  if (!sheet || typeof sheet !== 'object') return;
  for (const [key, cell] of Object.entries(sheet as Record<string, unknown>)) {
    if (key.startsWith('!') || !cell || typeof cell !== 'object') continue;
    const c = cell as { t?: string; z?: string; w?: string };
    if (c.t === 'd') {
      c.z = iso;
      delete c.w;
    }
  }
}

interface SheetJsLike {
  read: (data: unknown, opts: Record<string, unknown>) => { SheetNames: string[]; Sheets: Record<string, unknown> };
  utils: {
    sheet_to_json: (
      sheet: unknown,
      opts: Record<string, unknown>,
    ) => unknown[];
  };
}

export async function extractXlsxText(
  bytes: Buffer,
  opts: { maxChars: number },
): Promise<XlsxExtractResult> {
  const mod = await import('@e965/xlsx');
  const XLSX = ((mod as { default?: unknown }).default ?? mod) as SheetJsLike;

  if (typeof XLSX.read !== 'function' || typeof XLSX.utils?.sheet_to_json !== 'function') {
    throw new XlsxExtractError('The XLSX reader (SheetJS) did not load correctly.');
  }

  let workbook: { SheetNames: string[]; Sheets: Record<string, unknown> };
  try {
    // `cellDates` surfaces genuine date cells as type 'd' so their presentation can
    // be normalised below, instead of leaving them as numbers with a date format.
    workbook = XLSX.read(bytes, { type: 'buffer', cellDates: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new XlsxExtractError(`The spreadsheet could not be read: ${msg}`);
  }

  const parts: string[] = [];
  const sheets: string[] = [];
  const skippedSheets: string[] = [];
  let rows = 0;
  let used = 0;
  let truncated = false;

  for (const name of workbook.SheetNames) {
    if (used >= opts.maxChars) {
      truncated = true;
      skippedSheets.push(name);
      continue;
    }

    normalizeDateFormats(workbook.Sheets[name], 'yyyy-mm-dd');

    const table = XLSX.utils.sheet_to_json(workbook.Sheets[name], {
      header: 1,
      raw: false,     // apply number formats: dates as dates, not serials
      dateNF: 'yyyy-mm-dd',
      defval: '',
      blankrows: false,
    }) as unknown[][];

    const body = table
      .map((row) => (Array.isArray(row) ? row.map((c) => String(c ?? '').trim()).join(' | ').trim() : ''))
      .filter((line) => line.length > 0)
      .join('\n');

    if (body.length === 0) {
      sheets.push(name);
      continue;
    }

    const header = `## Sheet: ${name}`;
    const chunk = `${header}\n${body}`;
    const remaining = opts.maxChars - used;

    if (chunk.length > remaining) {
      parts.push(`${chunk.slice(0, Math.max(0, remaining))}\n…[sheet truncated]`);
      truncated = true;
      used = opts.maxChars;
    } else {
      parts.push(chunk);
      used += chunk.length;
    }

    sheets.push(name);
    rows += table.length;
  }

  return { text: parts.join('\n\n'), sheets, rows, truncated, skippedSheets };
}
