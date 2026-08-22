/**
 * Vision Tools — Image analysis, OCR, and visual understanding.
 *
 * Hermes equivalent: vision_tools.py
 *
 * Provides:
 * - Image analysis and description
 * - OCR (Optical Character Recognition)
 * - UI element detection
 * - Screenshot analysis
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface ImageAnalysis {
  /** Image path */
  path: string;
  /** Image dimensions */
  dimensions: { width: number; height: number };
  /** Image format */
  format: string;
  /** Detected elements */
  elements: DetectedElement[];
  /** OCR text */
  ocrText?: string;
  /** Description */
  description: string;
  /** Tags */
  tags: string[];
}

export interface DetectedElement {
  /** Element type */
  type: 'button' | 'text' | 'image' | 'link' | 'input' | 'icon' | 'container';
  /** Bounding box */
  bounds: { x: number; y: number; width: number; height: number };
  /** Element text */
  text?: string;
  /** Confidence score */
  confidence: number;
}

export interface OCRResult {
  /** Extracted text */
  text: string;
  /** Confidence score */
  confidence: number;
  /** Text regions */
  regions: Array<{
    text: string;
    bounds: { x: number; y: number; width: number; height: number };
    confidence: number;
  }>;
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

// ─── Vision Analyzer ──────────────────────────────────────────────────────

export class VisionAnalyzer {
  /**
   * Analyze an image.
   */
  async analyze(imagePath: string): Promise<ImageAnalysis> {
    const ext = extname(imagePath).toLowerCase();
    const content = await readFile(imagePath).catch(() => null);

    if (!content) {
      return {
        path: imagePath,
        dimensions: { width: 0, height: 0 },
        format: ext.slice(1) || 'unknown',
        elements: [],
        description: 'Failed to read image',
        tags: [],
      };
    }

    // Basic image info
    const format = ext.slice(1) || 'unknown';
    const dimensions = this.getImageDimensions(content, format);

    return {
      path: imagePath,
      dimensions,
      format,
      elements: [],
      description: `Image: ${format.toUpperCase()} (${dimensions.width}x${dimensions.height})`,
      tags: [format],
    };
  }

  /**
   * Perform OCR on an image.
   */
  async ocr(imagePath: string): Promise<OCRResult> {
    // In a real implementation, this would call an OCR service
    return {
      text: '',
      confidence: 0,
      regions: [],
    };
  }

  /**
   * Detect UI elements in a screenshot.
   */
  async detectUIElements(imagePath: string): Promise<UIElement[]> {
    // In a real implementation, this would use ML model
    return [];
  }

  /**
   * Compare two images.
   */
  async compare(imagePath1: string, imagePath2: string): Promise<{
    similarity: number;
    differences: Array<{ x: number; y: number; width: number; height: number }>;
  }> {
    return { similarity: 0, differences: [] };
  }

  /**
   * Extract text from a screenshot.
   */
  async extractText(imagePath: string): Promise<string> {
    const result = await this.ocr(imagePath);
    return result.text;
  }

  /**
   * Find element by text in screenshot.
   */
  async findElementByText(imagePath: string, text: string): Promise<UIElement | null> {
    const elements = await this.detectUIElements(imagePath);
    return elements.find((e) => e.text?.toLowerCase().includes(text.toLowerCase())) || null;
  }

  /**
   * Get image dimensions (basic detection for common formats).
   */
  private getImageDimensions(buffer: Buffer, format: string): { width: number; height: number } {
    // PNG header
    if (format === 'png' && buffer.length > 24) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height };
    }

    // JPEG header (simplified)
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

// ─── Screenshot Analyzer ──────────────────────────────────────────────────

export class ScreenshotAnalyzer {
  private analyzer: VisionAnalyzer;

  constructor() {
    this.analyzer = new VisionAnalyzer();
  }

  /**
   * Analyze a browser screenshot.
   */
  async analyzeBrowserScreenshot(screenshotPath: string): Promise<{
    elements: UIElement[];
    text: string;
    layout: string;
  }> {
    const elements = await this.analyzer.detectUIElements(screenshotPath);
    const text = await this.analyzer.extractText(screenshotPath);

    return {
      elements,
      text,
      layout: this.inferLayout(elements),
    };
  }

  /**
   * Find clickable elements.
   */
  async findClickableElements(screenshotPath: string): Promise<UIElement[]> {
    const elements = await this.analyzer.detectUIElements(screenshotPath);
    return elements.filter((e) => e.interactive);
  }

  /**
   * Generate automation instructions.
   */
  async generateAutomationInstructions(
    screenshotPath: string,
    goal: string,
  ): Promise<string[]> {
    const elements = await this.analyzer.detectUIElements(screenshotPath);
    const instructions: string[] = [];

    // Simple heuristic-based instruction generation
    const buttons = elements.filter((e) => e.type === 'button');
    const inputs = elements.filter((e) => e.type === 'input');
    const links = elements.filter((e) => e.type === 'link');

    if (goal.toLowerCase().includes('click')) {
      for (const btn of buttons) {
        if (btn.text) instructions.push(`Click button "${btn.text}"`);
      }
    }

    if (goal.toLowerCase().includes('type') || goal.toLowerCase().includes('enter')) {
      for (const input of inputs) {
        instructions.push(`Type in ${input.text || 'input field'}`);
      }
    }

    if (goal.toLowerCase().includes('navigate')) {
      for (const link of links) {
        if (link.text) instructions.push(`Click link "${link.text}"`);
      }
    }

    return instructions;
  }

  private inferLayout(elements: UIElement[]): string {
    if (elements.length === 0) return 'empty';
    if (elements.length > 20) return 'dense';
    if (elements.some((e) => e.type === 'container')) return 'structured';
    return 'simple';
  }
}

// ─── Singletons ───────────────────────────────────────────────────────────

let _visionAnalyzer: VisionAnalyzer | null = null;
let _screenshotAnalyzer: ScreenshotAnalyzer | null = null;

export function getVisionAnalyzer(): VisionAnalyzer {
  if (!_visionAnalyzer) _visionAnalyzer = new VisionAnalyzer();
  return _visionAnalyzer;
}

export function getScreenshotAnalyzer(): ScreenshotAnalyzer {
  if (!_screenshotAnalyzer) _screenshotAnalyzer = new ScreenshotAnalyzer();
  return _screenshotAnalyzer;
}
