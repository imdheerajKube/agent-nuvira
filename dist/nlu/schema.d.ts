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
import { z } from 'zod';
/** The intent vocabulary — byte-identical to C1's NluIntent. */
export declare const nluIntentSchema: z.ZodEnum<{
    unknown: "unknown";
    explain: "explain";
    create: "create";
    fix: "fix";
    configure: "configure";
    continue: "continue";
}>;
/** A temporal reference (same shape as C1's TimeRange). */
export declare const timeRangeSchema: z.ZodObject<{
    text: z.ZodString;
    start: z.ZodOptional<z.ZodString>;
    end: z.ZodOptional<z.ZodString>;
    timex: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** Entities the LLM may extract from the request text. */
export declare const nluEntitiesSchema: z.ZodObject<{
    project: z.ZodOptional<z.ZodString>;
    files: z.ZodDefault<z.ZodArray<z.ZodString>>;
    timeRange: z.ZodOptional<z.ZodObject<{
        text: z.ZodString;
        start: z.ZodOptional<z.ZodString>;
        end: z.ZodOptional<z.ZodString>;
        timex: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    frameworks: z.ZodDefault<z.ZodArray<z.ZodString>>;
    keywords: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
/**
 * The full structured response the LLM must produce on a verify call.
 * The entities default is a function so zod v4's default typing matches the
 * output shape (files/frameworks/keywords always present after parse).
 */
export declare const verifyResponseSchema: z.ZodObject<{
    intent: z.ZodEnum<{
        unknown: "unknown";
        explain: "explain";
        create: "create";
        fix: "fix";
        configure: "configure";
        continue: "continue";
    }>;
    confidence: z.ZodNumber;
    entities: z.ZodDefault<z.ZodObject<{
        project: z.ZodOptional<z.ZodString>;
        files: z.ZodDefault<z.ZodArray<z.ZodString>>;
        timeRange: z.ZodOptional<z.ZodObject<{
            text: z.ZodString;
            start: z.ZodOptional<z.ZodString>;
            end: z.ZodOptional<z.ZodString>;
            timex: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        frameworks: z.ZodDefault<z.ZodArray<z.ZodString>>;
        keywords: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    memoryHint: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type NluEntities = z.infer<typeof nluEntitiesSchema>;
export type VerifyResponse = z.infer<typeof verifyResponseSchema>;
/**
 * The JSON Schema form of the verify response — for adapters that support
 * structured output (C3/H1). Derived from the same zod schema, never hand-kept.
 */
export declare function verifyResponseJsonSchema(): Record<string, unknown>;
/** Type guard for the intent enum — schema is the single source of truth. */
export declare function isKnownIntent(intent: string): boolean;
//# sourceMappingURL=schema.d.ts.map