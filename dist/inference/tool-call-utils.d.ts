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
 * TWO families are detected (both observed live; the second was previously
 * slipping through in both WhatsApp and the dashboard):
 *
 *  A. CONTRACT META-TALK — the model narrates the contract: apologetic tone
 *     plus contract nouns (tool names, "example call", "given schema",
 *     "dictionary of tasks, actions, and their parameters").
 *  B. CONTRACT-AS-REQUEST — the subtler and far more common failure: the
 *     model reads the *suggest_followups* INSTRUCTION as the user's request
 *     and answers by OFFERING to suggest things and asking the user to supply
 *     the content. Real examples this now catches:
 *       "Sure, I can help you with suggestions and followups. Please provide
 *        me with more details so I can assist you better."
 *       "Sure, I can help you with suggesting followups. Please provide some
 *        details or a specific query you'd like me to suggest."
 *       "I'm ready to help! Could you please provide more details about the
 *        tasks or actions you'd like to perform or discuss?"
 *       "Sure, I can help you with your suggestions. What do you need help with?"
 * You cannot catch these by matching the literal tool name: the model
 * PARAPHRASES it ("suggestions and followups", "suggesting followups"), which
 * is why the old name-only test let them through.
 *
 * Both branches stay conservative so a legitimate answer is never flagged:
 * branch A needs contract nouns AND a confused tone; branch B needs the
 * suggest/followup vocabulary AND an offer-to-help or please-provide frame AND
 * an explicit request for input (a "?" or an imperative ask). A real answer
 * that merely mentions a tool ("Sure — I can call suggest_followups once the
 * song is written.") satisfies neither: it has no confused tone, and its
 * "I can call …" is not an offer to help.
 *
 * @param content  the model's visible reply text
 * @param tools    tool names to look for (defaults to suggest_followups —
 *                 the contract marker every turn ends with)
 */
export declare function looksLikeConfusedScaffoldingReply(content: string, tools?: string[]): boolean;
/**
 * True when the provider rejected the request because the MODEL cannot do
 * native tool/function calling at all.
 *
 * Live (Groq, via the fixed router):
 *   400 {"error":{"message":"`tool calling` is not supported with this model",
 *                "type":"invalid_request_error","param":"tool calling"}}
 *
 * This is NOT a transient failure and NOT a bad model choice by itself — many
 * perfectly good models (and every server-tool agentic model) simply do not
 * accept a `tools` array. Before this check the loop treated it as a hard
 * generation failure, so the whole turn died even though the loop ALREADY
 * ships a transport that needs no provider tool support (the JSON fallback:
 * `buildJsonFallbackPrompt` + `extractFallbackToolCalls`). Callers use this to
 * fall through to that transport instead of losing the turn.
 */
export declare function isToolCallingUnsupported(err: unknown): boolean;
/**
 * One canonical, human-readable line for a failed generation. Every surface
 * (CLI chat, dashboard console, gateway) shows this instead of the provider's
 * wire error.
 */
export declare const GENERATION_FAILURE_MESSAGE = "I couldn't complete that request just now \u2014 the language model was unavailable. Please try again in a moment.";
/**
 * Map a provider/runtime error to a SHORT, user-facing sentence.
 *
 * Why this exists: the tool loop used to interpolate the raw provider message
 * into the delivered answer — `I couldn't complete that request (${message})` —
 * so a messaging-app sender and the dashboard got a wall of provider JSON
 * ("Gemini streaming tool-calling API error (429): {\"error\":{\"code\":429, …
 * quotaValue … retryDelay …}") instead of a sentence. The raw text still goes
 * to the logger and the reasoning trace; only the USER sees this.
 *
 * Categories mirror `classifyFallbackError` (learning/provider-fallback.ts),
 * kept local on purpose: this module is imported by the chat hot path and by
 * unit tests, so it must not drag the provider-factory/model-registry graph in.
 */
export declare function toUserFacingGenerationError(err: unknown): string;
/**
 * Strip the model's TOOL-CALL ARTIFACTS out of a user-facing answer.
 *
 * A model that cannot (or forgets to) emit a real `suggest_followups` tool call
 * often writes the call as TEXT instead — either as a trailing bare object or
 * inside a fenced ```json block. The user then reads the contract's plumbing in
 * the answer:
 *
 *   ok
 *   {"tool":"suggest_followups","arguments":{"followups":[…]}}
 *
 *   **Next steps you might consider:**
 *   ```json
 *   ```                       ← the body was parsed out, the empty fence stayed
 *
 * Both were observed live from the CLI's one-shot path, which printed
 * `answer.content` raw while the dashboard console and the gateway applied the
 * strip — a parity gap, not a rendering choice. This is the ONE copy of the
 * strip (the helper module's whole reason for existing), so every surface that
 * shows an answer can share it.
 *
 * Deliberately conservative: it only removes artifacts that ARE the followups
 * contract. A fenced block with real content, and a code block the user asked
 * for, are untouched.
 */
export declare function stripToolCallArtifacts(content: string): string;
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