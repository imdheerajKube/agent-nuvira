/**
 * Domain reference-docs injection (v1.62.4).
 *
 * When a task mentions a known framework/domain, we inject CURATED reference
 * snippets into the writer's prompt so the model uses the real API instead of
 * hallucinating one. This is the fix for the live NVDA-addon failure where the
 * model invented `nvda.register_key_handler` / `from nvda import ui` instead of
 * the real `globalPluginHandler` / `scriptHandler` / `addonHandler` APIs.
 *
 * The snippets are small, hand-verified, and deliberately conservative: they
 * show the REAL public API surface + a minimal working example. Matching is
 * keyword-based against the task description (and optionally the goal); keep
 * the keywords specific enough to avoid false positives.
 */
export interface ReferenceDoc {
    /** Keywords that trigger this doc (lowercased, substring match). */
    keywords: string[];
    /** The curated snippet injected into the prompt. */
    snippet: string;
}
/**
 * Find reference docs matching the given text (task description + goal).
 * Returns a formatted prompt section, or '' when nothing matches.
 */
export declare function referenceDocsFor(text: string): string;
//# sourceMappingURL=reference-docs.d.ts.map