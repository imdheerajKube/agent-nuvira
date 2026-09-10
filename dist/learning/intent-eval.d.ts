/**
 * Intent-eval — classification accuracy harness for the two intent matchers.
 *
 * The eval-framework.ts measures END-TO-END coding tasks through the
 * orchestrator (pipeline quality). Intent matching is a different question —
 * "which intent does this plain-English ask map to?" — so this harness
 * measures exactly that, over a LABELED corpus of asks with ground-truth
 * intent ids:
 *
 *   nuvira intent eval              — run deterministic vs semantic, print scores
 *   nuvira intent eval --json       — machine-readable results
 *
 * Metrics per matcher:
 *   - top-1 accuracy   — ground-truth intent is the #1 ranked match
 *   - in-top-3 accuracy— ground-truth intent appears in the top 3
 *   - coverage         — share of asks with at least one match above threshold
 *
 * The corpus intentionally includes NOVEL phrasings that are NOT in the
 * manifest's alias lists (e.g. "bounce the UI", "where is the delivery log"),
 * because those are exactly the asks where the semantic tier should add
 * recall over the deterministic keyword matcher.
 */
/** A labeled ask: the text + the ground-truth intent id (manifest `intent`). */
export interface LabeledAsk {
    ask: string;
    intent: string;
    /** Novel = phrasing NOT in the manifest aliases (the semantic tier's target). */
    novel?: boolean;
}
/**
 * Ground-truth corpus. `novel: true` entries are phrasings that DO NOT appear
 * in src/resources/command-manifest.json aliases — keyword matching cannot
 * hit them by construction. Intent ids are the manifest's `intent` values.
 */
export declare const INTENT_EVAL_CORPUS: LabeledAsk[];
export interface MatcherEvalResult {
    /** Matcher name: 'deterministic' | 'semantic'. */
    matcher: string;
    top1: number;
    top3: number;
    coverage: number;
    total: number;
    /** Per-ask details (for --json / debugging). */
    cases: Array<{
        ask: string;
        intent: string;
        novel?: boolean;
        topIntent?: string;
        topSimilarity?: number;
        hit: boolean;
    }>;
}
/** Run both matchers and print a comparison table. */
export declare function runIntentEval(opts?: {
    json?: boolean;
}): Promise<{
    deterministic: MatcherEvalResult;
    semantic: MatcherEvalResult;
}>;
//# sourceMappingURL=intent-eval.d.ts.map