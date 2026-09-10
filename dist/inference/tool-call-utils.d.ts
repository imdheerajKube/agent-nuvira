/**
 * Shared tool-call helpers (H1) — the S2/S3 reliability fixes lifted OUT of
 * `src/cli/chat.ts` so every surface that drives a model through tool calling
 * (chat's tool loop today; any future execute/plan/… loop or dashboard
 * console) gets them for free. One copy, one test, one contract.
 *
 * - `salvageFailedGeneration`  — recover a complete model answer from a
 *   tool-calling 400's `failed_generation` field (S3). The API rejects the
 *   CALL (e.g. the model emitted an Anthropic-style `<function=…>` tag inside
 *   its content) while the content is a full, deliverable answer — the essay
 *   was sitting in the error payload and being thrown away.
 * - `compactToolSchemas`       — one-line argument shapes for the JSON
 *   fallback transport (S2). The fallback contract lists tool NAMES only, so
 *   a fallback model cannot produce valid arguments for schemas it never saw.
 * - `buildJsonFallbackPrompt`  — the flattened thread + schema-shape section
 *   (the S2 injection), shared so chat and any other loop build identical
 *   prompts.
 * - `looksLikeConfusedScaffoldingReply` — answer-quality resilience (v1.8x
 *   audit): detect the model CONFUSEDLY TALKING ABOUT the tool contract
 *   instead of executing it (e.g. apologizing about the example call). Such a
 *   reply never throws, so failover never fired and the confusion was
 *   delivered verbatim to a messaging-app sender. Callers treat it like a
 *   generation failure: retry via failover, fall back to the raw reply.
 */
import type { ToolMessage } from './interface.js';
import type { FollowupSuggestion, ToolJsonSchema } from '../tools/registry.js';
/**
 * Answer-quality resilience — detect a model CONFUSEDLY TALKING ABOUT the
 * tool contract instead of executing it.
 *
 * Motivation (live WhatsApp incident): a fallback-transport model answered
 * "Write a song …" with "I'm sorry, but the provided example call to
 * suggest_followups is incomplete … Could you please provide more context" —
 * it had read the JSON-fallback prompt's `Example suggest_followups call:`
 * section and responded to IT as if it were the user's request. The reply
 * never throws, so the failover walk (which only fires on provider ERRORS)
 * accepted it and the confusion was delivered verbatim to the sender.
 *
 * Detection is deliberately conservative — the whole reply must look like
 * contract meta-talk, so a legitimate answer that merely MENTIONS a tool
 * ("I can run build for you") is never flagged:
 *  1. references the tool contract's own vocabulary (a known tool name or
 *     a tool/JSON/call-form noun phrase), AND
 *  2. is short (≤ 400 chars — real answers are longer), AND
 *  3. carries an apologetic/confused meta-tone (sorry/cannot/provided/incomplete…).
 *
 * @param content  the model's visible reply text
 * @param tools    tool names to look for (defaults to suggest_followups —
 *                 the contract marker every turn ends with)
 */
export declare function looksLikeConfusedScaffoldingReply(content: string, tools?: string[]): boolean;
/**
 * S3 — salvage the model's generated content from a tool-calling 400.
 *
 * OpenAI-compatible APIs (Groq et al.) reject the CALL but often embed the
 * model's COMPLETE answer in the error body's `failed_generation` field — e.g.
 * when the model emitted an Anthropic-style `<function=…>` tag inside its
 * content (observed with llama-3.3-70b on Groq, which destroyed a perfect
 * essay). Only salvage when the intended call is the end-of-response marker
 * (`suggest_followups`) or absent: a rejected REAL tool call (build/repair/…)
 * must not be "answered" with its intro prose.
 */
export declare function salvageFailedGeneration(err: unknown): {
    content: string;
    followups?: FollowupSuggestion[];
} | null;
/**
 * S2 — compact one-line argument shapes for the JSON-fallback transport.
 *
 * The fallback contract (TOOL_CONTRACT_JSON) lists tool NAMES only — a
 * fallback-transport model (e.g. a small local Ollama model) cannot produce
 * valid arguments for schemas it never saw (it guessed plain strings / a
 * `text` key for suggest_followups). Append these shapes to the flattened
 * prompt: top-level property name + type + required, one line per tool.
 * Deliberately NOT the full JSON schema (token-heavy for small contexts).
 */
export declare function compactToolSchemas(schemas: ToolJsonSchema[]): string;
/**
 * S2 — the JSON-fallback flattened prompt WITH the schema-shape section
 * appended (shared so chat and any other loop build byte-identical prompts).
 */
export declare function buildJsonFallbackPrompt(messages: ToolMessage[], schemas: ToolJsonSchema[]): string;
//# sourceMappingURL=tool-call-utils.d.ts.map