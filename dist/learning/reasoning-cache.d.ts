/**
 * Reasoning-replay cache (Nuvira-Router P4 M4.2).
 *
 * Some reasoning models REQUIRE their prior `reasoning_content` on retry — a
 * strict provider 400s when the conversation omits the reasoning that produced
 * a previous assistant turn. This module caches the LAST reasoning_content per
 * (provider, model, conversation-key) so a retry to the SAME provider can
 * re-inject it instead of failing.
 *
 * Persisted to `~/.nuvira/memory/reasoning-cache.json` (honors NUVIRA_MEMORY_DIR)
 * like other registry state, best-effort writes. Keys are FNV-1a fingerprints
 * of the conversation prefix — no raw conversation content is ever persisted.
 */
export interface ReasoningCacheEntry {
    provider: string;
    model: string;
    /** FNV-1a fingerprint of the conversation prefix that produced the reasoning. */
    conversationKey: string;
    reasoningContent: string;
    timestamp: number;
}
/**
 * Stable fingerprint of a conversation prefix (FNV-1a 32-bit, base-36).
 * Identical prefixes → identical keys; no raw content is persisted.
 */
export declare function buildConversationKey(messages: Array<{
    role: string;
    content: string;
}>): string;
/**
 * Store the last reasoning_content for a (provider, model, conversation).
 * Best-effort; a newer entry for the same triple replaces the older one.
 */
export declare function cacheReasoning(entry: Omit<ReasoningCacheEntry, 'timestamp'>): void;
/**
 * Retrieve the cached reasoning for a (provider, model, conversation), or null.
 */
export declare function getCachedReasoning(provider: string, model: string, conversationKey: string): string | null;
/** Clear the reasoning cache (tests, debugging). */
export declare function clearReasoningCache(): void;
/** Read the current cache (tests, diagnostics). */
export declare function readReasoningCache(): ReasoningCacheEntry[];
//# sourceMappingURL=reasoning-cache.d.ts.map