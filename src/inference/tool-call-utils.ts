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
export function looksLikeConfusedScaffoldingReply(
  content: string,
  tools: string[] = ['suggest_followups'],
): boolean {
  const t = (content || '').trim();
  if (!t) return false;

  // ── Branch A: contract meta-talk (nouns + apologetic/confused tone) ──
  if (t.length <= 600) {
    const mentionsContract = tools.some((name) => t.includes(name))
      || /\b(?:tool|tools)\s+call\b|\b(?:provided|given)\s+(?:example|call|schema|argument|arguments|tool|information)\b|\bexample\s+call\b|\bdictionary\s+of\s+tasks\b|\bstructured\s+(?:API|api)\s+response\b|\b(?:tasks|actions)[,.]\s+and\s+(?:their\s+)?parameters\b|\b(?:tasks|actions|operations)\b(?:\s*(?:,|and|or)\s*(?:tasks|actions|operations)\b)+/i.test(t);
    if (mentionsContract) {
      const metaTone = /\b(?:i'?m\s+)?(?:really\s+)?sorry|\bi\s+(?:cannot|can't)\b|\bcould\s+(?:you|u)\s+please\b|\bprovide\s+(?:more\s+)?(?:context|details|information|clarification)\b|\b(incomplete|invalid|malformed|unclear|not\s+fully\s+defined|directly\s+interpret)\b/i;
      if (metaTone.test(t)) return true;
    }
  }

  // ── Branch B: the contract read as the user's request (deflection) ──
  // Short by construction — a real deliverable is longer than a deflection.
  if (t.length > 400) return false;
  const suggestVocab = /\bsuggest_follow_?ups?\b|\bsuggest\w*\b|\bfollow[\s-]?ups?\b/i.test(t);
  if (!suggestVocab) return false;
  const offerToHelp =
    /\bi\s+(?:can|could|will|would|'ll)\s+(?:help|assist)\b|\bi['’]?m\s+ready\s+to\s+help|\b(?:happy|glad)\s+to\s+help\b|\bi['’]d\s+be\s+happy\b|\bplease\s+(?:provide|share|give|tell|specify)\b|\blet\s+me\s+know\b|\bcould\s+you\s+please\b/i.test(t);
  if (!offerToHelp) return false;
  const asksForInput = /\?|\bplease\s+(?:provide|share|give|tell|specify)\b/i.test(t);
  return asksForInput;
}

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
export function isToolCallingUnsupported(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  if (!m) return false;
  // "not supported" / "unsupported" NEAR a tool/function capability word.
  // Proximity matters: the phrase and its subject must be in the same clause,
  // so "the tool result was too large" and a bare "401" never match.
  const NO_CAP = '(?:not\\s+supported|unsupported|not\\s+enabled|does\\s+not\\s+support|doesn\'?t\\s+support)';
  if (new RegExp(`\\btools?\\b[^.]{0,40}${NO_CAP}`).test(m)) return true; // "tools are not supported"
  if (new RegExp(`${NO_CAP}[^.]{0,40}\\btools?\\b`).test(m)) return true; // "does not support tool calling"
  if (new RegExp(`\\bfunctions?\\b[^.]{0,40}${NO_CAP}`).test(m)) return true; // "function calling unsupported"
  if (new RegExp(`${NO_CAP}[^.]{0,40}\\bfunctions?\\b`).test(m)) return true;
  // NOTE: a `tool_use_failed` 400 is deliberately NOT included. That error means
  // the model DOES support tool calling but emitted a malformed call — salvage
  // (S3) handles the recoverable case, and the rest must FAIL OVER rather than
  // be silently answered in prose through another transport.
  return false;
}

/**
 * One canonical, human-readable line for a failed generation. Every surface
 * (CLI chat, dashboard console, gateway) shows this instead of the provider's
 * wire error.
 */
export const GENERATION_FAILURE_MESSAGE =
  "I couldn't complete that request just now — the language model was unavailable. Please try again in a moment.";

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
export function toUserFacingGenerationError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const m = raw.toLowerCase();
  // Our OWN loop-level errors are classified FIRST, on a literal match of the
  // strings this codebase throws. They must not be shadowed by a keyword that
  // happens to appear in the wrapped payload (the contract-confusion message
  // embeds the model's raw reply, which may itself contain "429"/"not found").
  //
  // Why these branches exist at all: before them, a turn that ended in tool-
  // contract confusion or a malformed step fell through to
  // GENERATION_FAILURE_MESSAGE — telling the user "the language model was
  // unavailable" about a model that had answered, just not usefully. That
  // misdiagnosis is what made a live dashboard failure undiagnosable.
  const CONTRACT_CONFUSION = /tool-contract confusion/;
  const MALFORMED_STEP = /malformed step response/;
  /**
   * ADMIN POLICY blocks (governance allow/deny lists, the PII privacy gate) are
   * our own errors and must never be reported as an unavailable model: nothing
   * was unreachable — a rule refused the provider, and the user needs the rule
   * (and which provider) to fix it. Matched by NAME, like the two above and for
   * the same reason the `instanceof` route is unavailable here: the error
   * classes live in `src/learning/auto-router.ts`, which already imports this
   * inference layer, so a reverse import would close a cycle.
   */
  const POLICY_BLOCK = /governance policy|pii governance policy|pii-domain task/;
  const QUOTA =
    /\b429\b|rate.?limit|too many requests|quota|resource.?exhausted|resource_exhausted|insufficient_quota|token_count/;
  const AUTH = /\b401\b|\b403\b|unauthorized|forbidden|api key|invalid key|permission/;
  const SERVER = /\b5\d\d\b|server error|internal server|overloaded/;
  const NETWORK = /fetch failed|econnrefused|econnreset|enotfound|eai_again|socket hang up|network/;
  const TIMEOUT = /timeout|timed out/;
  // A bare abort (no "timeout" in the message) is NOT an unavailable model —
  // Node's DOMException("This operation was aborted") carries no class keyword
  // at all, which is how an aborted request used to surface as the canned
  // "language model was unavailable" line.
  const ABORT = /\babort(?:ed|ing)?\b/;
  const CONTEXT =
    /context_length_exceeded|context length|maximum context|reduce the length of the messages|too many tokens|exceeds? the context window/;
  const NOT_FOUND = /\b404\b|not found|does not exist|no longer available|model_not_found|unsupported model/;
  if (POLICY_BLOCK.test(m)) {
    // The message already names the provider and the rule (`Governance policy:…`).
    return raw;
  }
  if (CONTRACT_CONFUSION.test(m)) {
    return "The model got tangled up in its own tool instructions and never answered your request. Try again, or switch models with `nuvira models`.";
  }
  if (MALFORMED_STEP.test(m)) {
    return 'The model returned an incomplete response. Please try again.';
  }
  if (QUOTA.test(m)) {
    return "I hit the model provider's rate limit (or ran out of quota) — please try again in a moment.";
  }
  if (AUTH.test(m)) {
    return "The model provider rejected the API key, so I couldn't generate an answer. Check your provider credentials with `nuvira models`.";
  }
  if (NOT_FOUND.test(m)) {
    return "The selected model isn't available from that provider right now. Try another model, or run `nuvira models refresh` to rediscover them.";
  }
  if (TIMEOUT.test(m)) return 'The model provider timed out. Please try again.';
  if (CONTEXT.test(m)) {
    return "That request outgrew the context window of the model it was routed to. Try again (the router lands on a larger-context model), or shorten the conversation.";
  }
  if (ABORT.test(m)) return 'The request to the model provider was aborted before it answered. Please try again.';
  if (NETWORK.test(m)) return "I couldn't reach the model provider (network error). Please try again.";
  if (SERVER.test(m)) return 'The model provider returned a server error. Please try again in a moment.';
  return GENERATION_FAILURE_MESSAGE;
}

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
export function stripToolCallArtifacts(content: string): string {
  if (!content) return '';
  return (
    content
      // An EMPTY fenced block — the fallback transport parsed the call out of
      // the body and left the fence behind.
      .replace(/\n?```[a-z]*\s*\n?\s*```\s*/gi, '\n')
      // A fenced block WHOSE BODY is the call.
      .replace(/```[a-z]*\s*\{[\s\S]*?"tool"\s*:\s*"suggest_followups"[\s\S]*?```/gi, '')
      // The bare trailing call object (the model wrote the tool JSON verbatim).
      .replace(/\n?\*?\s*\{\s*"tool"\s*:\s*"suggest_followups"[\s\S]*$/, '')
      // The Anthropic-style tag form (<function=suggest_followups …>).
      .replace(/\n?\*?\s*<function=suggest_followups[\s\S]*?<\/function>/g, '')
      .trim()
  );
}

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
export function salvageFailedGeneration(
  err: unknown,
): { content: string; followups?: FollowupSuggestion[] } | null {
  if (!(err instanceof Error)) return null;
  const m = err.message.match(/"failed_generation"\s*:\s*("(?:[^"\\]|\\.)*")/);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]) as string;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    // Only salvage when the intended calls are the end-of-response marker
    // (suggest_followups) or absent: a rejected REAL tool call (build/…)
    // must not be "answered" with its intro prose.
    const funcs = [...raw.matchAll(/<function=([^>\s]*)\s*>?\s*([\s\S]*?)<\/function>/g)];
    if (funcs.some(([, f]) => f && f !== 'suggest_followups')) return null;
    // The tag shape is `<function=name [args]</function>` — NO `>` between the
    // args and the close (a naive `<function=[^>]*>` would greedily swallow
    // through `</function>`'s `>` and strip nothing). Handle the space form
    // (observed) AND the Anthropic-style angle form `<function=name>args</function>`.
    const content = raw
      .replace(/<function=[^>\s]*\s*[\s\S]*?<\/function>/g, '')
      .replace(/<function=[^>]*>[\s\S]*?<\/function>/g, '')
      .trim();
    // Best-effort: recover the followups from the stripped tag so the turn
    // still ends with the contract (the model's suggestions were
    // also being thrown away with the rejected call).
    let followups: FollowupSuggestion[] | undefined;
    for (const [, name, body] of funcs) {
      if (name !== 'suggest_followups' || !body.trim()) continue;
      try {
        const parsed = JSON.parse(body.trim()) as unknown;
        const list = Array.isArray(parsed) ? parsed : (parsed as { followups?: unknown }).followups;
        if (Array.isArray(list)) {
          const mapped = list
            .map((f) => {
              const o = f as { prompt?: unknown; label?: unknown };
              return {
                prompt: typeof o?.prompt === 'string' ? o.prompt : '',
                ...(typeof o?.label === 'string' && o.label ? { label: o.label } : {}),
              };
            })
            .filter((f) => f.prompt.trim());
          if (mapped.length > 0) followups = mapped;
        }
      } catch {
        // Ignore malformed followups — the answer is what matters.
      }
    }
    return { content, followups };
  } catch {
    return null;
  }
}

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
export function compactToolSchemas(schemas: ToolJsonSchema[]): string {
  return schemas
    .map((s) => {
      const params = (s.parameters ?? {}) as {
        properties?: Record<string, { type?: string; items?: { type?: string } }>;
        required?: string[];
      };
      const required = new Set(params.required ?? []);
      const parts = Object.entries(params.properties ?? {}).map(([k, v]) => {
        const items = v.items?.type ? `[]<${v.items.type}>` : '';
        return `${k}: ${items || v.type || 'any'}${required.has(k) ? ' (required)' : ''}`;
      });
      return `${s.name}: { ${parts.join(', ') || 'no args'} }`;
    })
    .join('\n');
}

/**
 * S2 — the JSON-fallback flattened prompt WITH the schema-shape section
 * appended (shared so chat and any other loop build byte-identical prompts).
 */
export function buildJsonFallbackPrompt(
  messages: ToolMessage[],
  schemas: ToolJsonSchema[],
): string {
  const prompt = messages
    .map((m) => {
      if (m.role === 'system') return `[System]\n${m.content}`;
      if (m.role === 'user') return `[User]\n${m.content}`;
      if (m.role === 'assistant') return m.content ? `[Assistant]\n${m.content}` : '';
      if (m.role === 'tool') return `[Tool result]\n${m.content}`;
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
  return (
    prompt +
    (schemas.length > 0
      ? `\n\nTOOL ARGUMENT SHAPES (use these exact keys):\n${compactToolSchemas(schemas)}\n\nExample suggest_followups call:\n{"tool":"suggest_followups","arguments":{"followups":[{"prompt":"...","label":"..."}]}}`
      : '')
  );
}
