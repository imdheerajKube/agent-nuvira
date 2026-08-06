/**
 * ConservativeCompression — M4.4 lossless-for-code context compression.
 *
 * WHY: long chats / big tool outputs bloat every provider call, but aggressive
 * summarization corrupts CODE. This module compresses PROSE (system prompts,
 * narration, tool-output prose) while leaving code blocks byte-identical —
 * identifiers, string literals, and symbols ALWAYS survive (property-tested).
 *
 * Guarantees:
 *  - Code blocks (fenced ``` … ```) are preserved verbatim — never stripped,
 *    never reworded, never "summarized".
 *  - Prose outside code blocks is trimmed to a head + tail with an elision
 *    marker (the middle is the least load-bearing for prompt continuity).
 *  - OFF BY DEFAULT. Wire it behind `routing.compression.enabled`; when off it
 *    is a pure pass-through with zero behavior change (M4.4 "off by default,
 *    documented with a warning").
 *
 * The property test (tests/learning/compression.test.ts) asserts that every
 * identifier / string literal present in the ORIGINAL code block is still
 * present in the compressed output — this is the lossless-for-code contract.
 */

import { estimateTokens } from './cost-tracker.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CompressionOptions {
  /**
   * When false (default), compressLossless is a pass-through — the text is
   * returned untouched with elided=false. Mirrors `routing.compression.enabled`.
   */
  enabled?: boolean;
  /**
   * Target fraction of ORIGINAL PROSE tokens to keep (head+tail split).
   * Default 0.6 — keeps 60% of prose, eliding the middle 40%.
   * Code blocks are always kept at 100% regardless of this value.
   */
  keepRatio?: number;
  /**
   * Minimum PROSE length (chars) before compression kicks in. Shorter prose
   * passes through untouched (zero overhead for small prompts).
   * Default 800.
   */
  minProseChars?: number;
}

export interface CompressionResult {
  /** The compressed (or untouched) text. */
  text: string;
  /** Estimated tokens in the original text. */
  originalTokens: number;
  /** Estimated tokens in the output text. */
  compressedTokens: number;
  /** True when any elision actually happened. */
  elided: boolean;
  /** Number of fenced code blocks found (always preserved). */
  codeBlocks: number;
  /** Prose chars removed (code never counted). */
  proseCharsRemoved: number;
}

// ─── Token estimate (reuses cost-tracker's heuristic) ──────────────────────

function estimateCharsTokens(chars: number): number {
  return estimateTokens('x'.repeat(chars));
}

// ─── Pure helpers (property-tested) ─────────────────────────────────────────

/**
 * Extract every identifier / symbol token from a code block: word tokens,
 * hex/numeric literals, string literals (single/double/backtick), and
 * punctuation-heavy operator sequences. Used by the lossless property test to
 * prove compression never drops code.
 */
export function extractCodeTokens(code: string): Set<string> {
  const tokens = new Set<string>();
  // String literals (single, double, backtick, with escapes tolerated).
  const strings = code.match(/["'`](?:[^"'`\\]|\\.)*["'`]/g);
  for (const s of strings || []) tokens.add(s);
  // Identifiers / numeric literals.
  const words = code.match(/[$A-Z_a-z][$\w]*|\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b/g);
  for (const w of words || []) tokens.add(w);
  return tokens;
}

/** Split text into prose segments and fenced code blocks (preserve order). */
export function splitCodeAndProse(
  text: string,
): Array<{ kind: 'prose'; content: string } | { kind: 'code'; content: string }> {
  const parts: Array<{ kind: 'prose'; content: string } | { kind: 'code'; content: string }> = [];
  const fence = /```[\s\S]*?(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    if (m.index > last) parts.push({ kind: 'prose', content: text.slice(last, m.index) });
    parts.push({ kind: 'code', content: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: 'prose', content: text.slice(last) });
  if (parts.length === 0) parts.push({ kind: 'prose', content: text });
  return parts;
}

/**
 * Elide the MIDDLE of a prose chunk, keeping the head (first half of the
 * keep-fraction) and the tail (second half). The elision marker names the
 * format so downstream agents know content was intentionally compacted.
 */
function elideProse(prose: string, keepRatio: number): { text: string; removed: number } {
  const keepChars = Math.floor(prose.length * keepRatio);
  if (keepChars >= prose.length) return { text: prose, removed: 0 };
  const head = Math.floor(keepChars * 0.6);
  const tail = Math.max(0, keepChars - head);
  const marker = `\n⟦…${prose.length - keepChars} chars of non-code context elided by conservative compression — code blocks preserved verbatim…⟧\n`;
  const text = `${prose.slice(0, head)}${marker}${prose.slice(prose.length - tail)}`;
  return { text, removed: prose.length - keepChars };
}

/**
 * M4.4 conservative compression. Lossless for code — fenced code blocks are
 * returned byte-identical; only prose is elided (middle-out).
 *
 * @param text  The prompt / context text to compress.
 * @param opts  See CompressionOptions. enabled defaults to false → pass-through.
 */
export function compressLossless(text: string, opts: CompressionOptions = {}): CompressionResult {
  const enabled = opts.enabled ?? false;
  const keepRatio = Math.min(1, Math.max(0.1, opts.keepRatio ?? 0.6));
  const minProseChars = opts.minProseChars ?? 800;
  const originalTokens = estimateCharsTokens(text.length);

  if (!enabled || text.length === 0) {
    // Pass-through — but still report the real code-block count so callers get
    // accurate diagnostics even when compression is off (M4.4 default).
    const blocks = splitCodeAndProse(text).filter((p) => p.kind === 'code').length;
    return {
      text,
      originalTokens,
      compressedTokens: originalTokens,
      elided: false,
      codeBlocks: blocks,
      proseCharsRemoved: 0,
    };
  }

  const parts = splitCodeAndProse(text);
  let out = '';
  let codeBlocks = 0;
  let proseCharsRemoved = 0;
  let elided = false;

  for (const part of parts) {
    if (part.kind === 'code') {
      codeBlocks++;
      out += part.content; // verbatim — lossless for code
    } else {
      if (part.content.length > minProseChars) {
        const r = elideProse(part.content, keepRatio);
        out += r.text;
        proseCharsRemoved += r.removed;
        if (r.removed > 0) elided = true;
      } else {
        out += part.content; // short prose passes through untouched
      }
    }
  }

  return {
    text: out,
    originalTokens,
    compressedTokens: estimateCharsTokens(out.length),
    elided,
    codeBlocks,
    proseCharsRemoved,
  };
}

/**
 * The lossless-for-code contract, as a boolean — used by the property test AND
 * by callers who want to double-check before sending.
 *
 * @returns true when every identifier/string token in every fenced code block
 *   of `original` is still present in `compressed`.
 */
export function isLosslessForCode(original: string, compressed: string): boolean {
  const originalBlocks = splitCodeAndProse(original).filter((p) => p.kind === 'code');
  if (originalBlocks.length === 0) return true; // no code → nothing to protect
  for (const block of originalBlocks) {
    const tokens = extractCodeTokens(block.content);
    if (tokens.size === 0) continue;
    for (const t of tokens) {
      if (!compressed.includes(t)) return false;
    }
  }
  return true;
}
