/**
 * Dynamic Model Catalog — generates badges and descriptions from model metadata
 * patterns, NOT hardcoded model names. This ensures the system adapts when
 * providers add/remove models without code changes.
 *
 * Design principles:
 * 1. Pattern-based: Match model IDs by patterns (e.g., "70b" = large, "flash" = fast)
 * 2. Metadata-driven: Use provider-reported info (context window, capabilities)
 * 3. Self-healing: Stale entries are automatically removed
 * 4. No code changes: Providers can add/remove models freely
 */
// ─── Pattern-based badge generation ──────────────────────────────────────────
/**
 * Badge patterns are ordered by specificity — more specific patterns match first.
 * Each pattern has a regex and a badge generator function.
 */
const BADGE_PATTERNS = [
    // Speech/Audio models (highest priority — these are NOT chat models)
    { pattern: /whisper/i, badge: () => 'Speech-to-text transcription', priority: 100 },
    { pattern: /orpheus/i, badge: () => 'Text-to-speech voice generation', priority: 100 },
    { pattern: /tts/i, badge: () => 'Text-to-speech', priority: 100 },
    { pattern: /stt/i, badge: () => 'Speech-to-text', priority: 100 },
    // Size indicators (common in model names)
    { pattern: /120b/i, badge: () => 'Large model — high quality, slower', priority: 90 },
    { pattern: /70b/i, badge: () => 'Large model — strong reasoning', priority: 90 },
    { pattern: /32b/i, badge: () => 'Medium model — balanced', priority: 90 },
    { pattern: /27b/i, badge: () => 'Medium model — balanced', priority: 90 },
    { pattern: /20b/i, badge: () => 'Medium model — fast', priority: 90 },
    { pattern: /9b/i, badge: () => 'Small model — fast, lightweight', priority: 90 },
    { pattern: /8b/i, badge: () => 'Small model — fast, lightweight', priority: 90 },
    { pattern: /7b/i, badge: () => 'Small model — fast, lightweight', priority: 90 },
    // Speed indicators (word-boundary aware to avoid false positives like 'gemini' matching 'mini')
    { pattern: /\bflash\b/i, badge: () => 'Fast model — optimized for speed', priority: 80 },
    { pattern: /\blite\b/i, badge: () => 'Lightweight — fastest, lowest cost', priority: 80 },
    { pattern: /\bmini\b/i, badge: () => 'Compact — fast and efficient', priority: 80 },
    { pattern: /\binstant\b/i, badge: () => 'Ultra-fast — low latency', priority: 80 },
    { pattern: /\bturbo\b/i, badge: () => 'Turbo — optimized for speed', priority: 80 },
    // Capability indicators
    { pattern: /pro/i, badge: () => 'Premium — best quality', priority: 70 },
    { pattern: /reasoning/i, badge: () => 'Reasoning-focused — complex tasks', priority: 70 },
    { pattern: /code/i, badge: () => 'Code-focused — programming tasks', priority: 70 },
    { pattern: /instruct/i, badge: () => 'Instruction-following fine-tune', priority: 60 },
    { pattern: /chat/i, badge: () => 'General chat model', priority: 60 },
    { pattern: /vision/i, badge: () => 'Multimodal — image understanding', priority: 70 },
    { pattern: /compound/i, badge: () => 'Compound model with tool use', priority: 60 },
    // Preview/Experimental
    { pattern: /preview/i, badge: () => 'Preview — experimental, may change', priority: 50 },
    { pattern: /exp/i, badge: () => 'Experimental — may change', priority: 50 },
    { pattern: /dev/i, badge: () => 'Development — unstable', priority: 50 },
    // Quality indicators
    { pattern: /safeguard/i, badge: () => 'Safety model — content moderation', priority: 80 },
    { pattern: /guard/i, badge: () => 'Safety model — content moderation', priority: 80 },
    { pattern: /embed/i, badge: () => 'Embedding model — not for chat', priority: 80 },
    { pattern: /rerank/i, badge: () => 'Reranking model — not for chat', priority: 80 },
    // Deprecated/Retired
    { pattern: /deprecated/i, badge: () => '⚠️ Deprecated — will be removed', priority: 100 },
    { pattern: /retired/i, badge: () => '⚠️ Retired — will be removed', priority: 100 },
    { pattern: /eol/i, badge: () => '⚠️ End of life — will be removed', priority: 100 },
];
/**
 * Generate a badge for a model based on its ID pattern.
 * Falls back to context-window-based heuristics if no pattern matches.
 */
export function generateDynamicBadge(modelId, meta) {
    // Try pattern matching first (ordered by priority)
    const sorted = [...BADGE_PATTERNS].sort((a, b) => b.priority - a.priority);
    for (const { pattern, badge } of sorted) {
        if (pattern.test(modelId)) {
            return badge(modelId, meta);
        }
    }
    // Fallback: use context window size if available
    if (meta?.contextWindowTokens) {
        if (meta.contextWindowTokens >= 1_000_000)
            return 'Ultra-large context — 1M+ tokens';
        if (meta.contextWindowTokens >= 200_000)
            return 'Large context — 200K+ tokens';
        if (meta.contextWindowTokens >= 128_000)
            return 'Standard context — 128K tokens';
        if (meta.contextWindowTokens >= 32_000)
            return 'Moderate context — 32K tokens';
        if (meta.contextWindowTokens <= 4_096)
            return 'Small context — limited to short tasks';
    }
    return undefined;
}
/**
 * Detect the category of a model based on its ID pattern.
 * This replaces hardcoded category assignments.
 */
export function detectModelCategory(modelId) {
    const id = modelId.toLowerCase();
    // Speech/Audio
    if (/whisper|tts|stt|orpheus|speech|audio|voice/.test(id))
        return 'speech';
    // Embedding
    if (/embed|rerank|e5|bge|gte/.test(id))
        return 'embedding';
    // Safety
    if (/safeguard|guard|moderation|safety/.test(id))
        return 'safety';
    // Code
    if (/code|coder|codellama|deepseek-coder|starcoder/.test(id))
        return 'code';
    // Vision
    if (/vision|visual|image|multimodal|gpt-4o/.test(id))
        return 'vision';
    // Reasoning
    if (/reasoning|think|o1|o3|o4/.test(id))
        return 'reasoning';
    // Fast
    if (/flash|lite|mini|instant|turbo|fast|quick/.test(id))
        return 'fast';
    // Creative
    if (/creative|story|poem|write/.test(id))
        return 'creative';
    // Default to chat
    return 'chat';
}
// ─── Model quality scoring ───────────────────────────────────────────────────
/**
 * Score a model's quality based on its metadata.
 * Used for automatic model ranking without hardcoded preferences.
 */
export function scoreModelQuality(modelId, meta) {
    let score = 0.5; // Base score
    // Size bonus (larger models tend to be better)
    const sizeMatch = modelId.match(/(\d+)b/i);
    if (sizeMatch) {
        const sizeB = parseInt(sizeMatch[1]);
        if (sizeB >= 100)
            score += 0.3;
        else if (sizeB >= 70)
            score += 0.25;
        else if (sizeB >= 30)
            score += 0.15;
        else if (sizeB >= 10)
            score += 0.05;
    }
    // Context window bonus
    if (meta?.contextWindowTokens) {
        if (meta.contextWindowTokens >= 1_000_000)
            score += 0.2;
        else if (meta.contextWindowTokens >= 200_000)
            score += 0.15;
        else if (meta.contextWindowTokens >= 128_000)
            score += 0.1;
    }
    // Penalty for preview/experimental
    if (/preview|exp|dev|beta/.test(modelId))
        score -= 0.1;
    // Penalty for deprecated
    if (/deprecated|retired|eol/.test(modelId))
        score -= 0.5;
    return Math.max(0, Math.min(1, score));
}
// ─── Stale model detection ──────────────────────────────────────────────────
/**
 * Check if a model is likely stale based on its last-seen timestamp.
 * Models not seen in the provider's listModels() for >7 days are suspect.
 */
export function isModelStale(lastProbedAt, now = Date.now()) {
    const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    return now - lastProbedAt > STALE_THRESHOLD_MS;
}
/**
 * Check if a model is likely removed by the provider.
 * Models not seen for >30 days with errors are probably gone.
 */
export function isModelProbablyRemoved(lastProbedAt, errorRate, now = Date.now()) {
    const REMOVED_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    return now - lastProbedAt > REMOVED_THRESHOLD_MS && errorRate > 0.5;
}
//# sourceMappingURL=dynamic-catalog.js.map