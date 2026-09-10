/**
 * C2 — Declared-once NLU verify schema (zod + JSON schema).
 *
 * The JSON schema for the LLM extraction call is declared HERE — a single
 * source of truth (the tool-schema discipline:
 * one schema, no per-prompt hack-parsing). The same schema can be handed to
 * any adapter that supports structured output (C3/H1), so intent resolution
 * and tool dispatch share one vocabulary.
 *
 * zod v4, pure JS, MIT — no network, no native deps.
 */
import { z, toJSONSchema } from 'zod';
/** The intent vocabulary — byte-identical to C1's NluIntent. */
export const nluIntentSchema = z.enum([
    'create',
    'continue',
    'fix',
    'explain',
    'configure',
    'unknown',
]);
/** A temporal reference (same shape as C1's TimeRange). */
export const timeRangeSchema = z.object({
    text: z.string(),
    start: z.string().optional(),
    end: z.string().optional(),
    timex: z.string().optional(),
});
/** Entities the LLM may extract from the request text. */
export const nluEntitiesSchema = z.object({
    /** Project hint (git slug / cwd id) — the caller's deterministic value wins. */
    project: z.string().optional(),
    /** File paths mentioned in the request. */
    files: z.array(z.string()).default([]),
    /** Temporal reference (the caller's recognizer result wins when present). */
    timeRange: timeRangeSchema.optional(),
    /** Frameworks / tech keywords mentioned. */
    frameworks: z.array(z.string()).default([]),
    /** Other notable keywords. */
    keywords: z.array(z.string()).default([]),
});
/**
 * The full structured response the LLM must produce on a verify call.
 * The entities default is a function so zod v4's default typing matches the
 * output shape (files/frameworks/keywords always present after parse).
 */
export const verifyResponseSchema = z.object({
    intent: nluIntentSchema,
    /** 0–1. Below the rule trust threshold is treated as unknown. */
    confidence: z.number().min(0).max(1),
    entities: nluEntitiesSchema.default(() => ({ files: [], frameworks: [], keywords: [] })),
    /** One short sentence on what prior context would help (optional). */
    memoryHint: z.string().optional(),
});
/**
 * The JSON Schema form of the verify response — for adapters that support
 * structured output (C3/H1). Derived from the same zod schema, never hand-kept.
 */
export function verifyResponseJsonSchema() {
    return toJSONSchema(verifyResponseSchema);
}
/** Type guard for the intent enum — schema is the single source of truth. */
export function isKnownIntent(intent) {
    return nluIntentSchema.safeParse(intent).success;
}
//# sourceMappingURL=schema.js.map