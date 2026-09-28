/**
 * Vision Tools — image analysis backed by a REAL engine, or a typed refusal.
 *
 * What is real here, and what is not:
 *
 * - `analyze` reports the image's actual format and pixel dimensions (parsed from
 *   the PNG/JPEG/GIF/BMP headers) and, when a vision backend is configured,
 *   a genuine description from it.
 * - `ocr` transcribes an image through the configured vision model
 *   (`./modality/vision.js` — a local Ollama vision model such as llava /
 *   llama3.2-vision, or Gemini when a key is set). A vision-model transcription
 *   is not a confidence-scored OCR engine, so the result says which engine ran
 *   and never invents a `confidence` number.
 * - `detect-elements`, `find-element` and `compare` have **no backend** and refuse
 *   with `not_configured`. They previously returned `[]` / `{similarity: 0}` —
 *   empty-but-valid payloads that read as "ran, found nothing", which is the same
 *   class of defect as the `read_extract` PDF stub.
 *
 * The registry's `vision` tool ("analyze images, extract text via OCR, detect UI
 * elements") pointed at this file while `describe_image` pointed at the real
 * engine — two tools for one capability, one of them a stub. See
 * TOOL_TRUTHFULNESS_TRACKER.md finding #6.
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { describeImage, isVisionAvailable, type VisionOptions } from './modality/vision.js';
import { refuse, type ToolRefusal, type ToolRefusalCode } from './tool-refusal.js';

/**
 * Render a `ToolRefusal` into this module's result shape — the message field here
 * is named `error` rather than `reason`, so the mapping is explicit instead of
 * spreading `refuse()` output and ending up with an undeclared `reason` key.
 */
function asVisionRefusal(r: ToolRefusal): { ok: false; code: ToolRefusalCode; error: string; alternatives?: string[] } {
  return {
    ok: false,
    code: r.code,
    error: r.reason,
    ...(r.alternatives ? { alternatives: r.alternatives } : {}),
  };
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ImageAnalysis {
  /** Image path */
  path: string;
  /** Real pixel dimensions, or {0,0} when the header could not be parsed */
  dimensions: { width: number; height: number };
  /** Image format */
  format: string;
  /** Description text — from the vision backend when one is configured, else the metadata line */
  description: string;
  /** Tags */
  tags: string[];
  /** Whether the analysis ran (a failed read is `ok: false`, never an empty success) */
  ok: boolean;
  /** Which engine produced `description` */
  via?: 'vision-model' | 'metadata';
  /** Explains what was NOT done, when a capability is missing */
  note?: string;
  code?: ToolRefusalCode;
  alternatives?: string[];
  error?: string;
}

export interface OCRResult {
  text: string;
  ok: boolean;
  /** The engine that produced the text — absent when nothing ran */
  via?: 'vision-model';
  code?: ToolRefusalCode;
  alternatives?: string[];
  error?: string;
}

export interface UIElement {
  /** Element type */
  type: string;
  /** Element text */
  text?: string;
  /** Element ref (for automation) */
  ref?: string;
  /** Bounding box */
  bounds: { x: number; y: number; width: number; height: number };
  /** Is interactive */
  interactive: boolean;
}

export interface DetectElementsResult {
  ok: boolean;
  elements: UIElement[];
  code?: ToolRefusalCode;
  alternatives?: string[];
  error?: string;
}

export interface CompareResult {
  ok: boolean;
  similarity?: number;
  differences?: Array<{ x: number; y: number; width: number; height: number }>;
  code?: ToolRefusalCode;
  alternatives?: string[];
  error?: string;
}

/** Prompt used for OCR-via-vision-model. Asks for the text ONLY, no commentary. */
const OCR_PROMPT =
  'Transcribe ALL visible text in this image exactly as it appears, preserving line breaks and any table '
  + 'rows/columns. Output only the transcription, with no preamble and no commentary.';

/** What a user can do when no vision backend is configured. */
const VISION_SETUP_ALTERNATIVES = [
  'Configure a vision backend: a local Ollama vision model (llava / llama3.2-vision) or a Gemini API key',
  'Ask the user to paste the text instead',
];

// ─── Vision Analyzer ──────────────────────────────────────────────────────

export class VisionAnalyzer {
  /**
   * Analyze an image: real format + dimensions always, plus a real description
   * when a vision backend is available.
   */
  async analyze(imagePath: string, opts: VisionOptions = {}): Promise<ImageAnalysis> {
    const ext = extname(imagePath).toLowerCase();
    const content = await readFile(imagePath).catch(() => null);

    if (!content) {
      return {
        path: imagePath,
        dimensions: { width: 0, height: 0 },
        format: ext.slice(1) || 'unknown',
        description: `Could not read the image at ${imagePath}.`,
        tags: [],
        ok: false,
        code: 'no_data',
        error: `Could not read image: ${imagePath}`,
        alternatives: ['Check the path and that the file is a readable image'],
      };
    }

    const format = ext.slice(1) || 'unknown';
    const dimensions = this.getImageDimensions(content, format);
    const metadataLine = `Image: ${format.toUpperCase()} (${dimensions.width}x${dimensions.height})`;

    // Prefer a real description when a backend exists; otherwise report honestly
    // that only the metadata was read.
    if (await isVisionAvailable(opts)) {
      const described = await describeImage(imagePath, undefined, opts);
      if (described.ok && described.description) {
        return {
          path: imagePath,
          dimensions,
          format,
          description: described.description,
          tags: [format],
          ok: true,
          via: 'vision-model',
        };
      }
      return {
        path: imagePath,
        dimensions,
        format,
        description: metadataLine,
        tags: [format],
        ok: true,
        via: 'metadata',
        note: `The vision backend was configured but failed (${described.error ?? 'unknown error'}), so only image metadata was read.`,
      };
    }

    return {
      path: imagePath,
      dimensions,
      format,
      description: metadataLine,
      tags: [format],
      ok: true,
      via: 'metadata',
      note: 'No vision backend is configured, so only image metadata was read — no description of the contents.',
      alternatives: VISION_SETUP_ALTERNATIVES,
    };
  }

  /**
   * Transcribe the text in an image through the configured vision model.
   *
   * Refuses when no backend is configured — it never returns an empty string as
   * if the image simply contained no text.
   */
  async ocr(imagePath: string, opts: VisionOptions = {}): Promise<OCRResult> {
    if (!(await isVisionAvailable(opts))) {
      return {
        text: '',
        ...asVisionRefusal(refuse(
          'not_configured',
          'No vision backend is configured (a local Ollama vision model such as llava/llama3.2-vision, or a Gemini API key), so no text could be read from the image.',
          VISION_SETUP_ALTERNATIVES,
        )),
      };
    }

    const described = await describeImage(imagePath, OCR_PROMPT, opts);
    if (!described.ok || described.description === undefined) {
      return {
        text: '',
        ...asVisionRefusal(refuse(
          'unavailable',
          `The vision backend could not read ${imagePath}: ${described.error ?? 'no output'}`,
          ['Retry once — a local vision model can time out on a large image'],
        )),
      };
    }

    return { text: described.description.trim(), ok: true, via: 'vision-model' };
  }

  /**
   * Detect UI elements in a screenshot.
   *
   * There is no detector backend (no ML model, no DOM access from a raster image),
   * so this refuses rather than returning an empty element list.
   */
  async detectUIElements(imagePath: string): Promise<DetectElementsResult> {
    return {
      elements: [],
      ...asVisionRefusal(refuse(
        'not_configured',
        `UI-element detection has no backend — it needs a DOM or an ML detector, and neither is wired up, so no elements were detected in ${imagePath}.`,
        [
          'Use the browser tools (browser / browser_supervisor) to query the live DOM instead of a screenshot',
          'Use describe_image to get a prose description of the screenshot',
        ],
      )),
    };
  }

  /**
   * Compare two images.
   *
   * No pixel-diff or embedding backend is wired up, so this refuses. It used to
   * return `{ similarity: 0, differences: [] }`, which reads as "identical images
   * with no differences" — the opposite of what it knew.
   */
  async compare(imagePath1: string, imagePath2: string): Promise<CompareResult> {
    return asVisionRefusal(refuse(
      'not_configured',
      `Image comparison has no backend, so ${imagePath1} and ${imagePath2} were NOT compared.`,
      [
        'Describe both images with describe_image and compare the descriptions',
        'Compare the files byte-wise if you only need to know whether they differ',
      ],
    ));
  }

  /**
   * Extract text from a screenshot (thin alias over `ocr`, kept for callers that
   * expect a bare string). A refusal yields an empty string — prefer `ocr` when
   * you need to tell "no text in the image" apart from "no backend configured".
   */
  async extractText(imagePath: string, opts: VisionOptions = {}): Promise<string> {
    const result = await this.ocr(imagePath, opts);
    return result.text;
  }

  /**
   * Find an element whose text matches. Refuses for the same reason as
   * `detectUIElements` — there is no detector to search.
   */
  async findElementByText(imagePath: string, text: string): Promise<UIElement | null> {
    const result = await this.detectUIElements(imagePath);
    if (!result.ok) return null;
    return result.elements.find((e) => e.text?.toLowerCase().includes(text.toLowerCase())) || null;
  }

  /**
   * Get image dimensions from the format header (PNG / JPEG / GIF / BMP).
   * Returns {0,0} when the header is not one of those — an unknown size, never a
   * guessed one.
   */
  getImageDimensions(buffer: Buffer, format: string): { width: number; height: number } {
    // PNG header
    if (format === 'png' && buffer.length > 24) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height };
    }

    // JPEG header (search the SOF marker)
    if (format === 'jpeg' || format === 'jpg') {
      let offset = 2;
      while (offset < buffer.length - 1) {
        if (buffer[offset] === 0xFF) {
          const marker = buffer[offset + 1];
          if (marker === 0xC0 || marker === 0xC2) {
            const height = buffer.readUInt16BE(offset + 5);
            const width = buffer.readUInt16BE(offset + 7);
            return { width, height };
          }
          const segmentLength = buffer.readUInt16BE(offset + 2);
          offset += 2 + segmentLength;
        } else {
          offset++;
        }
      }
    }

    // GIF header
    if (format === 'gif' && buffer.length > 10) {
      const width = buffer.readUInt16LE(6);
      const height = buffer.readUInt16LE(8);
      return { width, height };
    }

    // BMP header
    if (format === 'bmp' && buffer.length > 26) {
      const width = buffer.readUInt32LE(18);
      const height = Math.abs(buffer.readInt32LE(22));
      return { width, height };
    }

    return { width: 0, height: 0 };
  }
}

// ─── Singletons ───────────────────────────────────────────────────────────

let _visionAnalyzer: VisionAnalyzer | null = null;

export function getVisionAnalyzer(): VisionAnalyzer {
  if (!_visionAnalyzer) _visionAnalyzer = new VisionAnalyzer();
  return _visionAnalyzer;
}
