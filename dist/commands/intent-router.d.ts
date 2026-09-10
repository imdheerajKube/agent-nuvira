/** One command in the manifest. */
export interface ManifestArg {
    name: string;
    flag: string;
    optional: boolean;
    example?: string;
    repeatable?: boolean;
}
export interface ManifestResolution {
    when: string;
    command: string;
    example: string;
    summary: string;
    rbac: string;
    confirmation: boolean;
}
export interface ManifestIntent {
    intent: string;
    summary: string;
    aliases: string[];
    objective: string;
    command?: string;
    example?: string;
    args?: ManifestArg[];
    rbac?: string;
    confirmation?: boolean;
    platforms?: string[];
    requires?: string[];
    ambiguityGroup?: string;
    resolutions?: ManifestResolution[];
}
export interface MatchResult {
    intent: string;
    summary: string;
    /** Full CLI command with placeholders still in <...> form (caller fills args). */
    command?: string;
    example?: string;
    /** Entity values pulled from the ask (phone numbers, names, platforms, …). */
    entities: Record<string, string[]>;
    /** Ambiguity — more than one valid resolution; caller must ask the user. */
    ambiguous?: boolean;
    ambiguityGroup?: string;
    /** When ambiguous: the possible resolutions to present as a question. */
    options?: Array<{
        when: string;
        command: string;
        example: string;
        summary: string;
    }>;
    rbac?: string;
    confirmation?: boolean;
    /** How the match was made (which alias hit). */
    matchedAlias?: string;
    score: number;
}
/** Pull entity values out of a raw ask. */
export declare function extractEntities(text: string): Record<string, string[]>;
/**
 * Resolve a plain-English ask to CLI command(s).
 *
 * Returns matches ordered by score. When the top match is ambiguous
 * (`ambiguous: true`), the caller MUST ask the user which option they mean
 * before running anything — the router never guesses between a trigger-access
 * (verified) list and a send-by-name mapping.
 */
export declare function resolveAsk(ask: string): MatchResult[];
/** Convenience: best single match, or null when nothing is close enough. */
export declare function resolveBest(ask: string): MatchResult | null;
/**
 * Fill manifest placeholders (`<number>`, `<Name>`, `<platform>`, `<id>`, …)
 * with entity values extracted from the ask. Unfilled placeholders are left
 * in place so the caller knows which arguments still need asking.
 */
export declare function fillPlaceholders(command: string, entities: Record<string, string[]>): string;
//# sourceMappingURL=intent-router.d.ts.map