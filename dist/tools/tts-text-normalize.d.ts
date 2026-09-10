/**
 * tts_text_normalize — Text normalization for speech synthesis.
 *
 * Prepares assistant text for TTS by:
 * - Removing markdown formatting
 * - Expanding abbreviations
 * - Normalizing numbers and dates
 * - Handling code blocks
 * - Removing URLs and emails
 * - Adding pauses for punctuation
 */
interface NormalizeOptions {
    removeMarkdown?: boolean;
    expandAbbreviations?: boolean;
    normalizeNumbers?: boolean;
    handleCodeBlocks?: boolean;
    removeUrls?: boolean;
    addPauses?: boolean;
    maxLength?: number;
}
declare class TTSTextNormalizer {
    private abbreviations;
    private numberWords;
    /**
     * Normalize text for TTS.
     */
    normalize(text: string, options?: NormalizeOptions): string;
    /**
     * Remove markdown formatting.
     */
    private removeMarkdown;
    /**
     * Handle code blocks.
     */
    private handleCodeBlocks;
    /**
     * Remove URLs.
     */
    private removeUrls;
    /**
     * Expand abbreviations.
     */
    private expandAbbreviations;
    /**
     * Normalize numbers.
     */
    private normalizeNumbers;
    /**
     * Add pauses for punctuation.
     */
    private addPauses;
}
export declare function getTTSTextNormalizer(): TTSTextNormalizer;
export { TTSTextNormalizer };
//# sourceMappingURL=tts-text-normalize.d.ts.map