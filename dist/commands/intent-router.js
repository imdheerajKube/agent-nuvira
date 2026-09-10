/**
 * intent-router.ts — plain-English → CLI routing.
 *
 * Consumes `src/resources/command-manifest.json` (the machine-readable twin of
 * docs/COMMANDS.md) and resolves a user's plain-English ask to one or more CLI
 * commands. Design goals:
 *
 *   1. A user should never need to remember command names — they describe the
 *      outcome ("stop the dashboard", "add Rahul to whatsapp") and the router
 *      produces the exact `buff` invocation.
 *   2. Ambiguous asks are surfaced, NOT silently guessed. The manifest marks
 *      ambiguity groups (e.g. verified list vs send-by-name mapping) — the
 *      router returns the candidates so the caller can ask one clarifying
 *      question before executing (see docs/COMMANDS.md §15).
 *   3. Everything here is deterministic and testable: pure string matching
 *      over aliases + entity extraction. No network, no model calls.
 *
 * The intent → command table mirrors docs/COMMANDS.md. Keep both in sync when
 * adding commands: add the entry here (aliases + command + args) and a row in
 * the doc's corresponding section.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/** Load the manifest JSON (same pattern as router.ts loading package.json). */
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../resources/command-manifest.json', import.meta.url)), 'utf-8'));
const INTENTS = manifest.intents ?? [];
/** English stop-words — common filler that would inflate alias scores (e.g.
 * "what is allowed" matching "what is the meaning of life" on the two
 * generic words alone). Distinctive words carry the match. */
const STOP_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from',
    'by', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'can',
    'could', 'will', 'would', 'should', 'may', 'might', 'must', 'have', 'has', 'had',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'my', 'your', 'our', 'their',
    'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'how', 'why',
    'when', 'where', 'not', 'no', 'yes', 'so', 'if', 'then', 'than', 'as', 'up', 'down',
    'out', 'off', 'over', 'under', 'again', 'further', 'once', 'here', 'there', 'all',
    'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'only',
    'own', 'same', 'too', 'very', 'just', 'about', 'into', 'through', 'during', 'before',
    'after', 'above', 'below', 'between', 'around', 'please', 'help', 'do', 'got', 'get',
    'me', 'my', 'make', 'want', 'need', 'like', 'would', 'could', 'should', 'also', 'etc',
]);
/** Count the distinctive (non-stop-word, non-placeholder) words in an alias. */
function distinctiveWordCount(alias) {
    return norm(alias)
        .split(' ')
        .filter((w) => w && !w.startsWith('<') && !STOP_WORDS.has(w)).length;
}
/** Escape regex metacharacters for safe word-boundary matching. */
function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** Normalize text for matching: lowercase, collapse whitespace. */
function norm(text) {
    return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}
/** Known entity patterns — keep in sync with the examples in docs/COMMANDS.md. */
const ENTITY_PATTERNS = [
    // Phone numbers: +91 9958422601 / 919958604222 / +91-99584-22601
    { key: 'phone', re: /(?:\+?\d[\d\s-]{8,}\d)/g },
    // platform:channelId targets (whatsapp:Alex, telegram:123456, slack:C0123, …)
    { key: 'target', re: /(?:whatsapp|telegram|discord|slack|email|signal|sms|whatsapp_cloud|matrix|webhook|ntfy|teams|google_chat|weixin|irc|simplex|homeassistant):[\w@.+:-]+/g },
    // bare alias after "to" ("send a message to ops" → ops)
    { key: 'target', re: /\bto\s+([a-z][a-z0-9_-]{1,31})\b/g, group: 1 },
    // Named people ("add Rahul", "block Mom") — capitalized words after a verb
    { key: 'name', re: /\b(add|block|remove|disallow|allow|save|delete|approve|ban)\s+([A-Z][a-zA-Z]+)\b/g },
    // platform words
    { key: 'platform', re: /\b(whatsapp|telegram|discord|slack|email|signal|sms|matrix|webhook|wecom|feishu|dingtalk|mattermost|irc|simplex|homeassistant|bluebubbles|ntfy|teams|google_chat|weixin)\b/g },
];
/** Pull entity values out of a raw ask. */
export function extractEntities(text) {
    const out = {};
    for (const { key, re, group } of ENTITY_PATTERNS) {
        const found = [];
        for (const m of text.matchAll(re)) {
            // `name` uses group 2 (the actual name, not the verb); the bare-alias
            // `target` uses group 1; everything else uses the whole match.
            const value = group !== undefined ? m[group] : key === 'name' ? m[2] : m[0];
            if (value && !found.includes(value))
                found.push(value);
        }
        if (found.length > 0) {
            // Merge with earlier patterns that share the same key (e.g. the two
            // `target` patterns) instead of overwriting them.
            out[key] = [...(out[key] ?? []), ...found];
        }
    }
    return out;
}
/**
 * Resolve a plain-English ask to CLI command(s).
 *
 * Returns matches ordered by score. When the top match is ambiguous
 * (`ambiguous: true`), the caller MUST ask the user which option they mean
 * before running anything — the router never guesses between a trigger-access
 * (verified) list and a send-by-name mapping.
 */
export function resolveAsk(ask) {
    const text = norm(ask);
    const entities = extractEntities(ask);
    const results = [];
    for (const intent of INTENTS) {
        // Score how many alias tokens hit the ask. Aliases use <placeholder>
        // tokens like "add <name> to whatsapp" — match them loosely: every word in
        // the alias that is not a placeholder must appear in the ask.
        let bestScore = 0;
        let matchedAlias = '';
        for (const alias of intent.aliases) {
            // Only DISTINCTIVE words count: placeholders and stop-words are
            // excluded so "what is allowed" can't match "what is the meaning of
            // life" on the two generic words alone. Word-boundary matching also
            // keeps "run the gateway" from matching "is the gateway running".
            const aliasWords = norm(alias)
                .split(' ')
                .filter((w) => w && !w.startsWith('<') && !STOP_WORDS.has(w));
            if (aliasWords.length === 0)
                continue;
            const hits = aliasWords.filter((w) => new RegExp(`\\b${escapeRegex(w)}\\b`).test(text));
            const score = hits.length / aliasWords.length;
            if (score > bestScore) {
                bestScore = score;
                matchedAlias = alias;
            }
        }
        // Needs a real majority of the distinctive words (≥0.6) — a single shared
        // word like "enable" must not match "enable sandboxing" → whatsapp.pair.
        if (bestScore < 0.6)
            continue;
        const base = {
            intent: intent.intent,
            summary: intent.summary,
            entities,
            matchedAlias,
            score: bestScore,
        };
        if (intent.ambiguityGroup && intent.resolutions?.length) {
            results.push({
                ...base,
                ambiguous: true,
                ambiguityGroup: intent.ambiguityGroup,
                options: intent.resolutions.map((r) => ({
                    when: r.when,
                    command: fillPlaceholders(r.command, entities),
                    example: fillPlaceholders(r.example, entities),
                    summary: r.summary,
                })),
                confirmation: intent.resolutions.some((r) => r.confirmation),
            });
        }
        else {
            results.push({
                ...base,
                command: fillPlaceholders(intent.command ?? '', entities),
                example: fillPlaceholders(intent.example ?? '', entities),
                rbac: intent.rbac,
                confirmation: intent.confirmation,
            });
        }
    }
    // Tie-break: higher score, then MORE distinctive words matched (a specific
    // intent like "clear conversation history" beats a generic "chat" alias
    // that shares one word), then the UNambiguous match (a user who says "the
    // verified list" gets the direct disallow, not a clarifying question).
    return results.sort((a, b) => b.score - a.score ||
        distinctiveWordCount(b.matchedAlias ?? '') - distinctiveWordCount(a.matchedAlias ?? '') ||
        Number(!!a.ambiguous) - Number(!!b.ambiguous));
}
/** Convenience: best single match, or null when nothing is close enough. */
export function resolveBest(ask) {
    return resolveAsk(ask)[0] ?? null;
}
/**
 * Fill manifest placeholders (`<number>`, `<Name>`, `<platform>`, `<id>`, …)
 * with entity values extracted from the ask. Unfilled placeholders are left
 * in place so the caller knows which arguments still need asking.
 */
export function fillPlaceholders(command, entities) {
    // The CLI takes E.164 without a leading '+' (e.g. 919958604222) — strip it
    // when filling number placeholders.
    const phone = entities.phone?.[0]?.replace(/^\+/, '');
    const map = {
        number: phone,
        id: phone ?? entities.target?.[0],
        'id...': phone ?? entities.target?.[0],
        platform: entities.platform?.[0],
        target: entities.target?.[0],
        Name: entities.name?.[0],
        name: entities.name?.[0],
    };
    return String(command ?? '').replace(/<([^>]+)>/g, (whole, key) => {
        const value = map[key] ?? map[key.toLowerCase()];
        return value !== undefined ? value : whole;
    });
}
//# sourceMappingURL=intent-router.js.map