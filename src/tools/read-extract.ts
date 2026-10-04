/**
 * read_extract — Document-to-text extraction.
 *
 * IMPLEMENTED:
 *   - Text-ish: plain text, Markdown, HTML, CSV, JSON, XML, YAML (no dependency)
 *   - PDF      — `pdfjs-dist/legacy` with geometry-based row reconstruction (extract/pdf.ts)
 *   - DOCX     — `mammoth`, HTML output flattened structure-preservingly (extract/docx.ts)
 *   - XLSX     — SheetJS with cell number formats applied (extract/xlsx.ts)
 *   - PPTX     — `fflate` + direct `<a:t>` reading (extract/pptx.ts)
 *
 * NOT IMPLEMENTED — refused with a typed `unsupported_format` and alternatives:
 *   legacy binary Office formats (.doc/.xls/.ppt), .rtf, .odt — see PENDING_FORMATS.
 *
 * History: this module used to read a PDF and a DOCX by `readFileSync(path, 'utf-8')`
 * and stripping non-printable bytes, then report `success: true`. A PDF stores its
 * text inside compressed content streams and a DOCX is a ZIP of XML parts, so that
 * path could only ever return the container. On 2026-09-27 exactly that reached the
 * model as a health report it then could not assess, with no signal that extraction
 * had failed. Every extractor below either does the real work or refuses.
 *
 * The container readers are imported dynamically: pdf.js and SheetJS are megabytes
 * that the CLI, the dashboard server and the tool registry should not pay for at
 * startup, and a failure to load one is reported as `not_configured` rather than
 * silently degrading.
 *
 * See TOOL_TRUTHFULNESS_TRACKER.md (P0.1, P0.2, P1.2–P1.5).
 */

import * as fs from 'fs';
import * as path from 'path';
import { refusalFields, type ToolRefusalCode } from './tool-refusal.js';
import { htmlToText } from './extract/html-text.js';
import { resolveExtractMaxChars } from '../config/limits.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ExtractResult {
  text: string;
  format: string;
  metadata?: {
    title?: string;
    author?: string;
    created?: string;
    modified?: string;
    words?: number;
    rows?: number;
    /** PDF pages in the document. */
    pages?: number;
    /** PDF pages that yielded text (the rest are scanned images). */
    pagesWithText?: number;
    /** XLSX sheet names that were read. */
    sheets?: string[];
    /** PPTX slide count. */
    slides?: number;
    /** True when the character budget cut the output short. */
    truncated?: boolean;
    /** Non-fatal extraction warnings (e.g. mammoth's unsupported styles). */
    warnings?: string[];
    /** True when the text came from OCR of rendered pages, not from a text layer. */
    ocr?: boolean;
    /** Rasteriser used for OCR, for provenance. */
    ocrRenderer?: string;
  };
  success: boolean;
  /** Machine-readable reason when `success` is false (see tool-refusal.ts). */
  code?: ToolRefusalCode;
  /** Concrete alternatives, most useful first. */
  alternatives?: string[];
  error?: string;
}

export interface ExtractOptions {
  /**
   * Recover text from a scanned (text-layer-free) PDF by rendering pages and
   * transcribing them with the vision backend. Off by default: it costs a vision call
   * per page and returns transcribed, not parsed, text.
   */
  ocr?: boolean;
  /** Passed through to the OCR route (probe injection for tests). */
  ocrOptions?: import('./extract/pdf-ocr.js').PdfOcrOptions;
}

// ─── Budgets ────────────────────────────────────────────────────────────────

/**
 * Character budget for one extraction, when nothing overrides it. Documents are
 * unbounded input flowing into a bounded context window, so the output is capped
 * and the truncation is stated BOTH in `metadata.truncated` and in the returned
 * text (see {@link truncationNotice}) — a partial document is never presented as
 * the whole one.
 *
 * The effective budget is `resolveExtractMaxChars()` (`NUVIRA_EXTRACT_MAX_CHARS`),
 * so a user can raise it for a large document without a code change. This constant
 * stays as the documented default and the value tests pin.
 */
const MAX_EXTRACT_CHARS = 40_000;

/**
 * The model-facing sentence appended when a read was cut short.
 *
 * `metadata.truncated` alone was not enough: a live run read a 66,021-character
 * lab report, the reader capped it at 40,000 and set `truncated: true`, and the
 * model — which reads the TEXT, not the metadata — assessed the partial document
 * as if it were complete, silently missing the entire hematology section. The
 * notice travels with the text so the fact is impossible to miss, and it names
 * the way out (raise the cap, or read the rest another way).
 */
function truncationNotice(kept: number, total: number, limit: number): string {
  return (
    `\n\n⚠️ [This extraction was TRUNCATED at ${limit.toLocaleString()} of ${total.toLocaleString()} characters — `
    + `the remaining ${(total - kept).toLocaleString()} characters are NOT included above. `
    + 'Do not treat this as the complete document. To read all of it, raise the cap with '
    + '`NUVIRA_EXTRACT_MAX_CHARS` (dashboard → Process Environment, or `nuvira config limit set extract-max-chars <n>`), '
    + 'then read it again.]'
  );
}

/**
 * Apply the character budget to extracted text, appending the truncation notice
 * when the budget was hit. Shared by every text-shaped extractor so a truncated
 * read can never be silent in one format and loud in another.
 */
function capText(text: string, total: number, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const kept = text.slice(0, limit);
  return { text: kept + truncationNotice(kept.length, total, limit), truncated: true };
}

// ─── Format model ───────────────────────────────────────────────────────────

/** Formats with a working extractor. */
const IMPLEMENTED_FORMATS = new Set([
  '.txt', '.md', '.markdown', '.text', '.log',
  '.html', '.htm', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml',
  '.pdf', '.docx', '.xlsx', '.pptx',
]);

/**
 * Formats the tool does not read, with the reason surfaced to the model. Kept as a
 * map so the gap is explicit and greppable rather than implied by a missing `case`.
 */
const PENDING_FORMATS = new Map<string, string>([
  ['.doc', 'Legacy binary Word (.doc) is not supported — only the OOXML .docx container.'],
  ['.xls', 'Legacy binary Excel (.xls) is not supported — only the OOXML .xlsx container.'],
  ['.ppt', 'Legacy binary PowerPoint (.ppt) is not supported — only the OOXML .pptx container.'],
  ['.rtf', 'RTF is not supported.'],
  ['.odt', 'ODF (.odt) is not supported — only OOXML .docx.'],
  ['.ods', 'ODF (.ods) is not supported — only OOXML .xlsx.'],
]);

/** What to do instead, per unsupported format. */
const PENDING_ALTERNATIVES: Record<string, string[]> = {
  '.doc': ['Save as .docx and read that', 'Convert with LibreOffice (`soffice --convert-to docx`)'],
  '.xls': ['Save as .xlsx or CSV and read that'],
  '.ppt': ['Save as .pptx and read that'],
  '.rtf': ['Save as .docx or plain text and read that'],
  '.odt': ['Save as .docx and read that'],
  '.ods': ['Save as .xlsx or CSV and read that'],
};

/** Container formats whose reader is loaded on demand. */
const CONTAINER_FORMATS = new Set(['.pdf', '.docx', '.xlsx', '.pptx']);

// ─── Read Extract Manager ───────────────────────────────────────────────────

class ReadExtractManager {
  /**
   * Extract text from a file. Never throws: an unreadable, unsupported or
   * package-less format comes back as `success: false` with a typed `code`.
   */
  async extract(filePath: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
    const ext = path.extname(filePath).toLowerCase();

    if (PENDING_FORMATS.has(ext)) {
      return this.refused(ext, PENDING_FORMATS.get(ext)!, PENDING_ALTERNATIVES[ext] ?? []);
    }

    if (!IMPLEMENTED_FORMATS.has(ext)) {
      // An image is a common arrival here (usually from a chat attachment). The reader
      // cannot transcribe it, but a vision backend can — so say that plainly rather
      // than only listing the formats this module knows.
      const isImage = /^\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(ext);
      return this.refused(
        ext || '(no extension)',
        `Unsupported format: ${ext || '(no extension)'}.`,
        isImage
          ? [
            'Use describe_image — a vision backend can read this image directly',
            `Readable text formats: ${this.getSupportedFormats().join(', ')}`,
          ]
          : [`Readable formats: ${this.getSupportedFormats().join(', ')}`],
      );
    }

    if (!fs.existsSync(filePath)) {
      return {
        text: '',
        format: ext,
        success: false,
        code: 'no_data',
        error: `No such file: ${filePath}`,
        alternatives: ['Check the path (it is resolved relative to the workspace)'],
      };
    }

    try {
      switch (ext) {
        case '.txt':
        case '.md':
        case '.markdown':
        case '.text':
        case '.log':
          return this.extractPlainText(filePath);
        case '.html':
        case '.htm':
          return this.extractHTML(filePath);
        case '.csv':
        case '.tsv':
          return this.extractDelimited(filePath, ext === '.tsv' ? '\t' : ',');
        case '.json':
          return this.extractJSON(filePath);
        case '.xml':
          return this.extractXML(filePath);
        case '.yaml':
        case '.yml':
          return this.extractYAML(filePath);
        case '.pdf':
          return await this.extractPdf(filePath, opts);
        case '.docx':
          return await this.extractDocx(filePath);
        case '.xlsx':
          return await this.extractXlsx(filePath);
        case '.pptx':
          return await this.extractPptx(filePath);
        default:
          return this.refused(ext, `Unsupported format: ${ext}`, []);
      }
    } catch (err: any) {
      return {
        text: '',
        format: ext,
        success: false,
        code: 'unavailable',
        error: err?.message ? String(err.message) : String(err),
      };
    }
  }

  // ─── Container extractors ─────────────────────────────────────────────────

  private async extractPdf(filePath: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
    let mod: typeof import('./extract/pdf.js');
    try {
      mod = await import('./extract/pdf.js');
    } catch (err) {
      return this.notConfigured('.pdf', 'the PDF reader (pdfjs-dist)', err);
    }

    const limit = resolveExtractMaxChars();
    let result: import('./extract/pdf.js').PdfExtractResult;
    try {
      result = await mod.extractPdfText(new Uint8Array(fs.readFileSync(filePath)), {
        maxChars: limit,
      });
    } catch (err) {
      const encrypted = err instanceof mod.PdfExtractError && err.encrypted;
      return {
        text: '',
        format: 'pdf',
        success: false,
        code: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
        alternatives: encrypted
          ? ['Remove the password (print/export to a new PDF) and read that']
          : ['Re-export the PDF', 'Send the pages as screenshots so describe_image can read them'],
      };
    }

    // No page yielded text: a scanned document, not an empty one. Reported as a
    // typed refusal because "success with empty text" is the defect this workstream
    // removed — a caller cannot act on it.
    if (result.pagesWithText === 0) {
      return this.scannedPdfResult(filePath, result, opts);
    }

    // The PDF reader caps internally AND writes its own in-text marker
    // (`[Remaining N page(s) not read …]`), so the text already carries the fact;
    // it is not passed through `capText` again, which would double-report.
    return {
      text: result.text,
      format: 'pdf',
      success: true,
      metadata: {
        pages: result.pages,
        pagesWithText: result.pagesWithText,
        words: countWords(result.text),
        truncated: result.truncated,
        ...(result.pagesWithoutText.length > 0
          ? { warnings: [`Page(s) ${result.pagesWithoutText.join(', ')} have no text layer (scanned images).`] }
          : {}),
      },
    };
  }

  private async extractDocx(filePath: string): Promise<ExtractResult> {
    let mod: typeof import('./extract/docx.js');
    try {
      mod = await import('./extract/docx.js');
    } catch (err) {
      return this.notConfigured('.docx', 'the DOCX reader (mammoth)', err);
    }

    try {
      const result = await mod.extractDocxText(fs.readFileSync(filePath), { maxChars: resolveExtractMaxChars() });
      return {
        text: result.text,
        format: 'docx',
        success: true,
        metadata: {
          words: countWords(result.text),
          truncated: result.truncated,
          ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
        },
      };
    } catch (err) {
      return {
        text: '',
        format: 'docx',
        success: false,
        code: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
        alternatives: ['Re-export the document', 'Save it as .txt or .md and read that'],
      };
    }
  }

  private async extractXlsx(filePath: string): Promise<ExtractResult> {
    let mod: typeof import('./extract/xlsx.js');
    try {
      mod = await import('./extract/xlsx.js');
    } catch (err) {
      return this.notConfigured('.xlsx', 'the spreadsheet reader (SheetJS)', err);
    }

    try {
      const result = await mod.extractXlsxText(fs.readFileSync(filePath), { maxChars: resolveExtractMaxChars() });
      if (result.text.trim().length === 0) {
        return {
          text: '',
          format: 'xlsx',
          success: false,
          code: 'no_data',
          error: `The workbook has ${result.sheets.length} sheet(s) but no non-empty cells.`,
          alternatives: ['Check the sheet is not empty, or export it as CSV'],
          metadata: { sheets: result.sheets },
        };
      }
      return {
        text: result.text,
        format: 'xlsx',
        success: true,
        metadata: {
          sheets: result.sheets,
          rows: result.rows,
          words: countWords(result.text),
          truncated: result.truncated,
          ...(result.skippedSheets.length > 0
            ? { warnings: [`Sheet(s) not read (character budget): ${result.skippedSheets.join(', ')}`] }
            : {}),
        },
      };
    } catch (err) {
      return {
        text: '',
        format: 'xlsx',
        success: false,
        code: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
        alternatives: ['Re-export the workbook', 'Export the sheet as CSV and read that'],
      };
    }
  }

  private async extractPptx(filePath: string): Promise<ExtractResult> {
    let mod: typeof import('./extract/pptx.js');
    try {
      mod = await import('./extract/pptx.js');
    } catch (err) {
      return this.notConfigured('.pptx', 'the ZIP reader (fflate)', err);
    }

    try {
      const result = await mod.extractPptxText(fs.readFileSync(filePath), { maxChars: resolveExtractMaxChars() });
      if (result.text.trim().length === 0) {
        return {
          text: '',
          format: 'pptx',
          success: false,
          code: 'no_data',
          error: `All ${result.slides} slide(s) are text-free (images only).`,
          alternatives: ['Send the slides as screenshots so the vision model can read them'],
          metadata: { slides: result.slides },
        };
      }
      return {
        text: result.text,
        format: 'pptx',
        success: true,
        metadata: {
          slides: result.slides,
          words: countWords(result.text),
          truncated: result.truncated,
          ...(result.emptySlides.length > 0
            ? { warnings: [`Slide(s) with no text: ${result.emptySlides.join(', ')}`] }
            : {}),
        },
      };
    } catch (err) {
      return {
        text: '',
        format: 'pptx',
        success: false,
        code: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
        alternatives: ['Re-export the presentation', 'Export the slides as images'],
      };
    }
  }

  /**
   * A PDF with no text layer: either transcribe it (when the caller asked for OCR and
   * the route is available) or refuse with the way to ask. Both outcomes are explicit.
   */
  private async scannedPdfResult(
    filePath: string,
    result: import('./extract/pdf.js').PdfExtractResult,
    opts: ExtractOptions,
  ): Promise<ExtractResult> {
    const base = {
      pages: result.pages,
      pagesWithText: 0,
      truncated: result.truncated,
    };

    const alternatives = [
      opts.ocr
        ? 'Install a PDF rasteriser (Poppler: pdftoppm/pdftocairo) and configure a vision backend'
        : 'Call read_extract again with ocr:true to transcribe the pages with the vision model',
      'Send the page as a screenshot so the vision model can read it (describe_image)',
      'Paste the report text',
    ];

    if (!opts.ocr) {
      return {
        text: '',
        format: 'pdf',
        success: false,
        code: 'no_data',
        error:
          `The PDF has ${result.pages} page(s) but no text layer — it is a scan/image, so there is no text to extract.`,
        alternatives,
        metadata: base,
      };
    }

    // OCR was requested — attempt it, and if a prerequisite is missing say WHICH.
    try {
      const ocr = await import('./extract/pdf-ocr.js');
      const transcribed = await ocr.ocrScannedPdf(filePath, result.pages, opts.ocrOptions ?? {});
      return {
        text: transcribed.text,
        format: 'pdf',
        success: true,
        metadata: {
          ...base,
          ocr: true,
          ocrRenderer: transcribed.renderer,
          words: countWords(transcribed.text),
          truncated: transcribed.truncated,
          warnings: [
            'Text recovered by OCR from rendered page images — a transcription, not a parsed '
            + 'text layer. Verify digits (lab values, dates, doses) against the original.',
          ],
        },
      };
    } catch (err) {
      const ocr = await import('./extract/pdf-ocr.js');
      const code = err instanceof ocr.PdfOcrError ? err.code : 'unavailable';
      return {
        text: '',
        format: 'pdf',
        success: false,
        code,
        error: err instanceof Error ? err.message : String(err),
        alternatives,
        metadata: base,
      };
    }
  }

  /** An optional reader that failed to load is a typed refusal, never a silent gap. */
  private notConfigured(format: string, what: string, err: unknown): ExtractResult {
    return {
      text: '',
      format,
      success: false,
      error: `${what} is not available in this install, so ${format} could not be read (${err instanceof Error ? err.message : String(err)}).`,
      ...refusalFields('not_configured', [`Reinstall dependencies (npm install) to restore ${what}`]),
    };
  }

  /** A refusal in the module's result shape (empty text, no fabricated metadata). */
  private refused(format: string, reason: string, alternatives: string[]): ExtractResult {
    return {
      text: '',
      format,
      success: false,
      error: reason,
      ...refusalFields('unsupported_format', alternatives),
    };
  }

  // ─── Text extractors ──────────────────────────────────────────────────────

  /**
   * A NUL byte in the first 8 KB means the file is not text, whatever extension it
   * carries — the same probe `read_file` uses (`coding-tools.ts:looksBinary`). Without
   * it a mislabelled binary reaches the model as mojibake, which is the very class
   * of defect this module now refuses.
   */
  private looksBinary(filePath: string): boolean {
    const fd = fs.openSync(filePath, 'r');
    try {
      const probe = Buffer.alloc(8192);
      const read = fs.readSync(fd, probe, 0, probe.length, 0);
      return probe.subarray(0, read).includes(0);
    } finally {
      fs.closeSync(fd);
    }
  }

  private extractPlainText(filePath: string): ExtractResult {
    if (this.looksBinary(filePath)) {
      return this.refused(
        'text',
        `'${path.basename(filePath)}' looks binary (a text/Markdown file with NUL bytes) — its bytes are not text.`,
        ['Check the real file type and use the matching reader'],
      );
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const limit = resolveExtractMaxChars();
    const capped = capText(content, content.length, limit);
    return {
      text: capped.text,
      format: 'text',
      success: true,
      metadata: {
        words: countWords(content),
        truncated: capped.truncated,
      },
    };
  }

  /**
   * HTML → text. Structure-preserving (`htmlToText`): cells stay on one line so a
   * table's value/column pairing survives. Layout (CSS) is not reconstructed and is
   * not claimed to be.
   */
  private extractHTML(filePath: string): ExtractResult {
    const text = htmlToText(fs.readFileSync(filePath, 'utf-8'));
    const limit = resolveExtractMaxChars();
    const capped = capText(text, text.length, limit);
    return {
      text: capped.text,
      format: 'html',
      success: true,
      metadata: {
        words: countWords(text),
        truncated: capped.truncated,
      },
    };
  }

  /**
   * CSV/TSV → text, with RFC 4180 quoting rules rather than `split(',')`. The naive
   * split silently corrupted any row containing a quoted separator — a lab row like
   * `Glucose,112,"HIGH, range 70-99"` became four fields with the reference range torn
   * apart, while the result still reported success.
   */
  private extractDelimited(filePath: string, delimiter: string): ExtractResult {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/).filter((l) => l.trim());
    const rows = lines.map((line) => parseDelimitedRow(line, delimiter));

    // Rows stay themselves — separated by newlines, cells by ` | ` — so the table
    // shape the file encoded is the shape the model reads.
    const text = rows.map((cells) => cells.join(' | ')).join('\n');
    const limit = resolveExtractMaxChars();
    const capped = capText(text, text.length, limit);

    return {
      text: capped.text,
      format: delimiter === '\t' ? 'tsv' : 'csv',
      success: true,
      metadata: {
        words: countWords(text),
        rows: rows.length,
        truncated: capped.truncated,
      },
    };
  }

  private extractJSON(filePath: string): ExtractResult {
    const content = fs.readFileSync(filePath, 'utf-8');
    let text: string;
    let valid = true;
    try {
      text = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // Not valid JSON — return the raw text, and say so rather than implying a parse.
      text = content;
      valid = false;
    }
    const limit = resolveExtractMaxChars();
    const capped = capText(text, text.length, limit);
    return {
      text: capped.text,
      format: 'json',
      success: true,
      metadata: {
        truncated: capped.truncated,
        // A success result never carries an `error` string: the two together are
        // exactly the ambiguity ("did it work?") this module removes.
        ...(valid ? {} : { warnings: ['File is not valid JSON — raw text returned'] }),
      },
    };
  }

  private extractXML(filePath: string): ExtractResult {
    const content = fs.readFileSync(filePath, 'utf-8');
    const text = htmlToText(content);
    const limit = resolveExtractMaxChars();
    const capped = capText(text, text.length, limit);
    return {
      text: capped.text,
      format: 'xml',
      success: true,
      metadata: { words: countWords(text), truncated: capped.truncated },
    };
  }

  private extractYAML(filePath: string): ExtractResult {
    const content = fs.readFileSync(filePath, 'utf-8');
    const limit = resolveExtractMaxChars();
    const capped = capText(content, content.length, limit);
    return {
      text: capped.text,
      format: 'yaml',
      success: true,
      metadata: { words: countWords(content), truncated: capped.truncated },
    };
  }

  // ─── Capability surface ───────────────────────────────────────────────────

  /** Formats with a working extractor. Feeds the tool description. */
  getSupportedFormats(): string[] {
    return Array.from(IMPLEMENTED_FORMATS);
  }

  /** Formats the description does not advertise because nothing reads them. */
  getPendingFormats(): Array<{ format: string; reason: string }> {
    return Array.from(PENDING_FORMATS, ([format, reason]) => ({ format, reason }));
  }

  /** Whether a specific path's extension has a working extractor. */
  isFormatAvailable(filePath: string): boolean {
    return IMPLEMENTED_FORMATS.has(path.extname(filePath).toLowerCase());
  }

  /** Whether a path's format needs a heavy on-demand reader. */
  isContainerFormat(filePath: string): boolean {
    return CONTAINER_FORMATS.has(path.extname(filePath).toLowerCase());
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Split one delimited line into fields, honouring `"…"` quoting and escaped `""`.
 * Exported for tests. `parseCsvRow` is kept as the comma-specific alias.
 */
export function parseDelimitedRow(line: string, delimiter = ','): string[] {
  const cells: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(field.trim());
      field = '';
    } else {
      field += ch;
    }
  }
  cells.push(field.trim());
  return cells;
}

/** CSV-specific alias (kept for callers/tests that name the comma case). */
export function parseCsvRow(line: string): string[] {
  return parseDelimitedRow(line, ',');
}

/**
 * Probe mirrored into the `read_extract` tool description: true when the path's
 * format can actually be extracted. Callers use it to choose a tool *before*
 * spending a step on a refusal.
 */
export function isReadExtractAvailable(filePath: string): boolean {
  return getReadExtractManager().isFormatAvailable(filePath);
}

/** Formats with a working extractor (module-level convenience). */
export function getReadExtractFormats(): string[] {
  return getReadExtractManager().getSupportedFormats();
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: ReadExtractManager | null = null;

export function getReadExtractManager(): ReadExtractManager {
  if (!_instance) _instance = new ReadExtractManager();
  return _instance;
}

export { ReadExtractManager, MAX_EXTRACT_CHARS };
