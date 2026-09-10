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
/**
 * Extract every identifier / symbol token from a code block: word tokens,
 * hex/numeric literals, string literals (single/double/backtick), and
 * punctuation-heavy operator sequences. Used by the lossless property test to
 * prove compression never drops code.
 */
export declare function extractCodeTokens(code: string): Set<string>;
/** Split text into prose segments and fenced code blocks (preserve order). */
export declare function splitCodeAndProse(text: string): Array<{
    kind: 'prose';
    content: string;
} | {
    kind: 'code';
    content: string;
}>;
/**
 * M4.4 conservative compression. Lossless for code — fenced code blocks are
 * returned byte-identical; only prose is elided (middle-out).
 *
 * @param text  The prompt / context text to compress.
 * @param opts  See CompressionOptions. enabled defaults to false → pass-through.
 */
export declare function compressLossless(text: string, opts?: CompressionOptions): CompressionResult;
/**
 * The lossless-for-code contract, as a boolean — used by the property test AND
 * by callers who want to double-check before sending.
 *
 * @returns true when every identifier/string token in every fenced code block
 *   of `original` is still present in `compressed`.
 */
export declare function isLosslessForCode(original: string, compressed: string): boolean;
//# sourceMappingURL=compression.d.ts.map