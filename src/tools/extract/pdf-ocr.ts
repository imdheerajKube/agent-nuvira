/**
 * Scanned-PDF OCR route (P1.4) — text recovery for a PDF with no text layer.
 *
 * Rendering a PDF page to a raster needs a canvas. pdf.js in Node renders to a canvas
 * it does not ship, so the options were a native canvas package (a platform binary on
 * every install, for a path most documents never need) or an external rasteriser.
 * This uses Poppler's `pdftoppm` / `pdftocairo` **when it exists on PATH** — the same
 * `binaryOnPath` probe idiom `modality/browser.ts` uses for Playwright — and refuses
 * with `not_configured` when it does not, naming what to install.
 *
 * It is deliberately OPT-IN (the `ocr` flag on read_extract) rather than automatic:
 * this path costs a vision-model call per page and produces transcribed, not parsed,
 * text. A caller that did not ask for that should not silently pay for it — and the
 * refusal for a scanned PDF says exactly how to ask.
 *
 * The text recovered here is labelled (`metadata.ocr: true` plus a warning), because
 * a transcription is a different kind of evidence from an extraction: it can drop or
 * misread a digit, and the model reading a lab value needs to know that.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { artifactsDir, binaryOnPath } from '../modality/shared.js';
import { describeImage, isVisionAvailable, type VisionOptions } from '../modality/vision.js';

const execFileAsync = promisify(execFile);

/** Rasterisers, in preference order. `pdftocairo` gives PNG directly on more builds. */
const RENDERERS = [
  { bin: 'pdftoppm', args: (r: number) => ['-r', String(r), '-png'] },
  { bin: 'pdftocairo', args: (r: number) => ['-png', '-r', String(r)] },
] as const;

/** Prompt for OCR-via-vision-model: the text ONLY, nothing else. */
const OCR_PAGE_PROMPT =
  'Transcribe ALL visible text in this image exactly as it appears, preserving line breaks and table '
  + 'rows/columns. Output only the transcription, with no preamble and no commentary.';

/** Bounded so a 40-page scan cannot turn into 40 vision calls on one tool step. */
export const MAX_OCR_PAGES = 8;

export interface PdfOcrOptions {
  /** Injectable renderer probe (tests pass one; production uses PATH). */
  renderProbe?: (bin: string) => boolean;
  /** Vision backend options (probe is injectable for tests). */
  vision?: VisionOptions;
  /** Max pages to transcribe (default MAX_OCR_PAGES). */
  maxPages?: number;
  /** Raster resolution (default 150 dpi — enough for body text without huge images). */
  dpi?: number;
}

/** The rasteriser this machine can use, or null. */
export function findRenderer(probe: (bin: string) => boolean = binaryOnPath): string | null {
  for (const r of RENDERERS) {
    if (probe(r.bin)) return r.bin;
  }
  return null;
}

/** Whether the OCR route could run here: a rasteriser AND a vision backend. */
export async function isPdfOcrAvailable(opts: PdfOcrOptions = {}): Promise<boolean> {
  const probe = opts.renderProbe ?? binaryOnPath;
  if (findRenderer(probe) === null) return false;
  return isVisionAvailable(opts.vision ?? {});
}

export interface PdfOcrResult {
  text: string;
  /** Pages actually transcribed. */
  pagesTranscribed: number;
  /** Pages the document had, when the caller knows it. */
  truncated: boolean;
  /** The renderer used, for provenance. */
  renderer: string;
}

export class PdfOcrError extends Error {
  constructor(message: string, readonly code: 'not_configured' | 'unavailable') {
    super(message);
    this.name = 'PdfOcrError';
  }
}

/**
 * Render up to `maxPages` pages of `pdfPath` and transcribe them with the vision
 * backend, returning the concatenated text.
 *
 * Throws `PdfOcrError` with a typed code when a prerequisite is missing, so the
 * caller can turn it into a refusal with alternatives rather than a bare message.
 */
export async function ocrScannedPdf(
  pdfPath: string,
  totalPages: number,
  opts: PdfOcrOptions = {},
): Promise<PdfOcrResult> {
  const probe = opts.renderProbe ?? binaryOnPath;
  const renderer = findRenderer(probe);
  if (renderer === null) {
    throw new PdfOcrError(
      'No PDF rasteriser is available, so the pages cannot be turned into images for OCR '
      + '(install Poppler: `pdftoppm` / `pdftocairo`).',
      'not_configured',
    );
  }

  if (!(await isVisionAvailable(opts.vision ?? {}))) {
    throw new PdfOcrError(
      'No vision backend is configured (a local Ollama vision model such as llava/llama3.2-vision, '
      + 'or a Gemini API key), so there is nothing to transcribe the rendered pages with.',
      'not_configured',
    );
  }

  const dpi = opts.dpi ?? 150;
  const maxPages = opts.maxPages ?? MAX_OCR_PAGES;
  const pages = Math.max(1, Math.min(totalPages || 1, maxPages));
  const dir = artifactsDir('ocr');
  const prefix = join(dir, `scan-${Date.now().toString(36)}`);

  try {
    const spec = RENDERERS.find((r) => r.bin === renderer)!;
    await execFileAsync(
      renderer,
      [...spec.args(dpi), '-f', '1', '-l', String(pages), pdfPath, prefix],
      { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
    );

    const images = readdirSync(dir)
      .filter((f) => f.startsWith(`${prefix.split('/').pop()!}`) && /\.(png|jpe?g)$/i.test(f))
      .sort()
      .map((f) => join(dir, f));

    if (images.length === 0) {
      throw new PdfOcrError('The rasteriser produced no images for this PDF.', 'unavailable');
    }

    const parts: string[] = [];
    for (let i = 0; i < images.length; i++) {
      const described = await describeImage(images[i], OCR_PAGE_PROMPT, opts.vision ?? {});
      if (!described.ok || !described.description) {
        throw new PdfOcrError(
          `The vision backend could not read page ${i + 1}: ${described.error ?? 'no output'}`,
          'unavailable',
        );
      }
      parts.push(`[Page ${i + 1} — transcribed by OCR]\n${described.description.trim()}`);
    }

    return {
      text: parts.join('\n\n'),
      pagesTranscribed: images.length,
      truncated: (totalPages || images.length) > images.length,
      renderer,
    };
  } finally {
    // The rendered pages are intermediates — a scan's images should not accumulate
    // in the artifacts dir after the text has been recovered.
    for (const f of readdirSync(dir).filter((n) => n.startsWith(prefix.split('/').pop()!))) {
      rmSync(join(dir, f), { force: true });
    }
  }
}
