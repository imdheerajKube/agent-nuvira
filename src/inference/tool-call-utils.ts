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
 * Answer-quality resilience — detect the model's own REASONING delivered as
 * the answer. This block documents the DETECTOR as a whole: the options type
 * below, the two opener sets, and `looksLikeReasoningLeakReply`.
 *
 * Motivation (live WhatsApp incidents, three of them, all replayed from the
 * inbox ledger): the model wrote its private analysis instead of a reply and
 * the loop accepted the text verbatim, because nothing in the pipeline asked
 * "is this addressed to the user, or is this thinking?". Delivered were:
 *
 *   `The user said "Hi" via WhatsApp. / According to the instructions: /
 *    - Deliver answer DIRECTLY. / - No preamble. / - No meta-commentary. /
 *    - End with suggest_followups. / Since it's a simple "Hi", I should…`
 *   `The user is asking for travel advice for a trip in December 2026 from
 *    Delhi, India. / Options: Vietnam or Philippines. / I need to compare …`
 *
 * WHY THE EXISTING STRIPPER DID NOT SAVE US: `stripGatewayReasoning`
 * (registry.ts) is FORMAT-dependent — it removes `<think>`-tagged blocks and
 * lines carrying a known planning label behind a `*`/`1.` marker. Reasoning
 * emitted as flat PROSE has neither, so it passed through untouched: replaying
 * the four historical leaks through today's stripper + scaffolding guard, the
 * three above are still delivered in full and only the meta-talk ones are
 * caught. A blocklist of labels cannot be completed against a model's
 * unbounded phrasing, which is why this detector keys off structure instead.
 *
 * STRUCTURE, not vocabulary. A delivered answer opens by addressing the user;
 * a leaked reasoning trace opens by describing the CONVERSATION to itself —
 * "The user is/asked/said …", "According to the instructions", "Let me
 * think/analyze/plan …", "Wait, …", "My plan:", "Response:" — or by reciting
 * the system prompt's format rules back as a checklist ("- No preamble.",
 * "- End with suggest_followups"). Two signals, both high-precision:
 *
 *   (1) a reasoning OPENER in the first non-blank line, or
 *   (2) a RECITED CONTRACT bullet anywhere (a deliverable never contains the
 *       instruction "No meta-commentary.").
 *
 * Deliberately conservative, because a wrong verdict BURNS a good answer: the
 * opener must be the very first thing in the reply (a genuine answer that
 * happens to mention "the user" mid-sentence is untouched — the two real
 * second/third-person cases in the ledger start at character 0), and a quoted
 * opening (`"The user said …" is a common test fixture`) is excluded because
 * the quote blocks the start anchor.
 *
 * Callers treat a true verdict exactly like a generation failure: throw so the
 * failover walk tries the next candidate, then suppress at the send site if
 * every candidate narrated. It never THROWS itself — detection is pure.
 */
export interface ReasoningLeakOptions {
  /**
   * Report only the HIGH-PRECISION signals — the model narrating the
   * conversation to itself, or reciting the prompt's format rules.
   *
   * Why this knob exists: an agentic step that carries TOOL CALLS may open with
   * a legitimate action narration ("Let me check the project files." followed by
   * `list_dir`). The first-person `deliberation` openers are a genuinely weaker
   * signal than `The user is asking …` — measured while wiring the loop engine's
   * gate: `I will check.` (the lead-in of a real JSON-fallback tool step) was
   * flagged, the step was rejected, and its TOOL CALL was thrown away. On the
   * step that IS the answer (no tool calls) every signal applies, which is the
   * text a user would otherwise read.
   */
  highPrecisionOnly?: boolean;
}

/**
 * Openers that can only be written while THINKING about the conversation: the
 * model describing the exchange or reciting the prompt it was given.
 */
const HIGH_PRECISION_OPENERS: RegExp[] = [
  // Narrating the conversation to itself. The verb is REQUIRED and must be an
  // input verb — a bare `The user` would flag a legitimate sentence about a
  // `user` table/record/route ("The user table now has an index"), which is
  // ordinary prose in a codebase. "The user can log in" is likewise a
  // deliverable, so modals are excluded on purpose.
  /^(?:the|this)\s+user\s+(?:is\s+(?:asking|planning|requesting|wondering|looking|trying|attempting|providing|saying|referring|describing)|(?:just\s+)?(?:said|says|asked|asks|wants|wanted|requested|requests|needs|needed|wrote|mentioned|sent|gave|seems|appears))\b/i,
  /^according\s+to\s+(?:the\s+)?(?:instructions?|system\s+prompt|prompt|rules?|guidelines?)\b/i,
  /^(?:the|my)\s+(?:system\s+)?(?:prompt|instructions?)\s+(?:says|states|asks|tells|requires)\b/i,
  // Reasoning labels / draft markers.
  /^(?:my\s+)?(?:reasoning|thinking|chain\s+of\s+thought|analysis|internal\s+notes?)\s*[:.]/i,
  /^(?:my\s+plan|final\s+plan|plan|draft|response|answer|output|reply)\s*\d*\s*:/i,
  // A bare self-address, the way a trace opens on a re-read.
  /^(?:since|because|given)\s+(?:the\s+user|this\s+is\s+a\s+request|it'?s\s+a\s+simple)\b/i,
];

/**
 * Weaker, first-person signals: the model addressing ITSELF instead of writing
 * to the user. Real deliberation, but a tool-calling step may legitimately open
 * this way before acting (see `ReasoningLeakOptions.highPrecisionOnly`).
 */
const DELIBERATION_OPENERS: RegExp[] = [
  /^(?:let\s+me|i'?ll|i\s+will)\s+(?:now\s+)?(?:think|plan|analyse|analyze|consider|reason)\b/i,
  /^(?:wait|hmm|actually|alright|okay|ok)\s*[,:]/i,
];

/**
 * @param content  the model's visible reply text
 * @param options  `highPrecisionOnly` for a step that carries tool calls
 */
export function looksLikeReasoningLeakReply(content: string, options: ReasoningLeakOptions = {}): boolean {
  const t = (content || '').trim();
  if (!t) return false;

  // ── (2) The system prompt's format rules recited back as a checklist ──
  // These lines only exist in a reasoning trace: a deliverable is written FOR
  // the user, so it has no reason to state the instruction it is following.
  if (
    /^\s*[-*\u2022]\s*(?:no\s+(?:preamble|meta-commentary|internal|narration|tool)|deliver\s+(?:the\s+)?answer\s+directly|end\s+with\s+`?suggest_follow_?ups?|only\s+the\s+text\s+outside)/im.test(
      t,
    )
  ) {
    return true;
  }

  // ── (1) A reasoning opener in the first non-blank line ──
  // Anchored (no `m` flag): the FIRST line only, so an answer that starts
  // normally and merely mentions the user later is never flagged.
  const firstLine = t.split(/\r?\n/, 1)[0] ?? '';
  if (HIGH_PRECISION_OPENERS.some((re) => re.test(firstLine))) return true;
  if (options.highPrecisionOnly) return false;
  return DELIBERATION_OPENERS.some((re) => re.test(firstLine));
}

/**
 * Salvage the deliverable from a reply that opens with a reasoning trace.
 *
 * `looksLikeReasoningLeakReply` only answers "is this thinking?". Two of the
 * three real leaks were thinking PREFIXED onto a real (if rough) answer — the
 * travel comparison sat behind `The user is asking … / Options: … / I need to
 * compare …` — so discarding the whole reply would throw away content the user
 * actually wanted. This drops the leading trace and returns what remains.
 *
 * The boundary is found by walking lines from the top while they are
 * trace-shaped, then cutting there:
 *   - an opener line (see the detector),
 *   - a continuation line WHILE already inside a trace (a bare `Label: value`
 *     narration line, a recited-contract bullet, or a first-person
 *     deliberation line) — the same shapes a trace is built from,
 *   - blank lines inside the trace (they separate its paragraphs).
 * The first line that is none of those ends the trace and is KEPT, so the
 * deliverable survives intact. A quoted opener never gets here (the detector
 * excludes quotes), and content that merely mentions the user mid-text is not
 * at line 0, so the walk stops before it.
 *
 * Returns the emptied string when the trace was the whole reply (the "Hi"
 * case), which the caller reads as "nothing to salvage". Pure — never throws.
 */
/**
 * One line that could only be written while THINKING about the conversation:
 * narrating the user, reciting the prompt, or deliberating in the first
 * person. Deliberately broader than the detector's openers — this is used to
 * decide whether a line is still inside a trace, where a mistaken "not a
 * trace line" merely ends the trim early (the tail gate below catches that),
 * and a mistaken "is a trace line" costs a line of the deliverable.
 */
const REASONING_LINE =
  /^\s*(?:[-*\u2022]\s*(?:no\s+(?:preamble|meta-commentary|internal|narration|tool)|deliver\s+(?:the\s+)?answer\s+directly|end\s+with\s+`?suggest_follow_?ups?)|(?:the|this)\s+user\b|according\s+to\s+|(?:the|my)\s+(?:system\s+)?(?:prompt|instructions?)\s+\w|(?:let\s+me|let'?s|i'?ll|i\s+will|i\s+should|i\s+need|i\s+must|i\s+can'?t|i'?m|i\s+am|we\s+(?:need|should))\b|(?:wait|hmm|actually|alright|okay|ok|so|now|then)\s*[,:]|(?:my\s+)?(?:reasoning|thinking|chain\s+of\s+thought|analysis|internal\s+notes?)\s*[:.]|(?:my\s+plan|final\s+plan|plan|draft|response|answer|output|reply)\s*\d*\s*:|(?:options?|interests?|duration|goal|tone|subject|key\s+elements?|constraints?|delivery|status|summary)\s*:|if\s+the\s+user\b|since\s+(?:the\s+user|it'?s\s+a\s+simple)|this\s+is\s+a\s+request\b|but\s+the\s+user\b|however,)/i;

/**
 * Does this look like the DELIVERABLE half of a reply — real content for the
 * reader, as opposed to more thinking?
 *
 * The reason this gate exists: a trace's vocabulary cannot be enumerated, so
 * the walk below can stop one line too late and leave a fragment of thinking
 * behind. Rather than trust the walk, require the remainder to OPEN with
 * Markdown structure (a heading, bullet, numbered item, or quote) — how the
 * two salvageable real answers both began — with an opening line that is not a
 * reasoning line. Anything else is refused, which the caller reads as "nothing
 * to salvage" and suppresses instead of delivering a fragment of thinking.
 *
 * Deliberately checks the OPENING LINE only, never the whole remainder: a real
 * answer legitimately contains sentences that read like trace
 * ("If the user wants a mix of casinos and beaches, the Philippines wins" is
 * the CONCLUSION of the very answer being salvaged), so a whole-tail check
 * rejects the good content it exists to rescue.
 */
function looksLikeDeliverableTail(text: string): boolean {
  const s = text.trim();
  if (!s) return false;
  if (!/^(?:\*\*|#{1,6}\s|[-*\u2022]\s|\d+[.)]\s|>)/.test(s)) return false;
  if (looksLikeReasoningLeakReply(s)) return false;
  return !REASONING_LINE.test(s.split(/\r?\n/, 1)[0] ?? '');
}

/**
 * Salvage the deliverable from a reply that opens with a reasoning trace.
 *
 * `looksLikeReasoningLeakReply` only answers "is this thinking?". Two of the
 * three real leaks were thinking PREFIXED onto a real (if rough) answer — the
 * travel comparison sat behind `The user is asking … / Options: … / I need to
 * compare …` — so discarding the whole reply would throw away content the user
 * actually wanted. This drops the leading trace and returns what remains.
 *
 * Returns the text UNCHANGED when the detector does not flag it (never invents
 * a trim), and the EMPTY string when the flag was right but nothing deliverable
 * survived — the caller reads empty as "suppress, do not deliver".
 */
export function stripLeadingReasoningTrace(content: string): string {
  const text = (content || '').replace(/^\s*\n/, '');
  if (!text.trim()) return '';
  if (!looksLikeReasoningLeakReply(text)) return text;

  const lines = text.split(/\r?\n/);
  let cut = 0;
  let sawTrace = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') {
      // A blank line inside the trace separates its paragraphs and continues
      // it; a blank line before any trace line cannot occur (leading blanks are
      // stripped above), so this never advances past real content.
      if (sawTrace) cut = i + 1;
      continue;
    }
    if (!REASONING_LINE.test(line)) break;
    sawTrace = true;
    cut = i + 1;
  }
  const tail = sawTrace ? lines.slice(cut).join('\n').trim() : text.trim();
  // A trace-and-nothing-else, or a remainder that still reads as thinking:
  // report nothing salvageable rather than shipping a fragment.
  return looksLikeDeliverableTail(tail) ? tail : '';
}

/**
 * The answer-quality failures a model reply can exhibit — the two families this
 * module detects, named so callers can report WHICH one happened.
 */
export type AnswerQualityKind = 'confusion' | 'reasoning';

export interface AnswerQualityFailure {
  kind: AnswerQualityKind;
}

/**
 * THE answer-quality detector — one predicate for every surface.
 *
 * Both failures below were shipped to real users by surfaces that had no check
 * at all (the loop engine driving `nuvira execute` and every pipeline run), so
 * the engine and the chat loop must ask the SAME question. Returns null when
 * the reply is usable, which is the overwhelmingly common case — both detectors
 * are deliberately high-precision.
 *
 * @param content  the model's visible reply text
 * @param tools    tool names the turn exposed (for the contract-confusion
 *                 branch); defaults to the end-of-turn marker
 * @param options  `highPrecisionOnly` when the step carries tool calls (see
 *                 `ReasoningLeakOptions`)
 */
export function detectAnswerQualityFailure(
  content: string,
  tools: string[] = ['suggest_followups'],
  options: ReasoningLeakOptions = {},
): AnswerQualityFailure | null {
  if (looksLikeConfusedScaffoldingReply(content, tools)) return { kind: 'confusion' };
  if (looksLikeReasoningLeakReply(content, options)) return { kind: 'reasoning' };
  return null;
}

/**
 * Build the error a caller THROWS to drive a failover walk on a quality
 * failure.
 *
 * Why an error at all: a quality failure never throws on its own, so the
 * failover walk (which only reacts to provider errors) used to accept the reply
 * and ship it — the thinking/meta-talk was delivered verbatim AND the turn was
 * cached as a success. Throwing routes it through the existing walk instead.
 *
 * The message wording is load-bearing: `toUserFacingGenerationError` matches
 * these two phrases to report the honest cause, and the raw reply is carried on
 * `confusedReply` so a caller can log/salvage it without shipping it.
 */
export function answerQualityError(content: string, failure: AnswerQualityFailure): Error {
  const described = failure.kind === 'confusion' ? 'tool-contract confusion' : 'its own reasoning';
  const err = new Error(
    `model answered with ${described} instead of the task (reply: ${content.slice(0, 160)})`,
  );
  const tagged = err as Error & { confusedReply?: string; qualityKind?: AnswerQualityKind };
  tagged.confusedReply = content;
  tagged.qualityKind = failure.kind;
  return err;
}

/**
 * The line a surface shows when a reply was nothing but the model's OWN
 * TRACE — i.e. `stripReasoningLeak` had to suppress it entirely.
 *
 * It must not blame the model's absence ("the language model was unavailable")
 * — the model answered, it just answered with its working notes — so it names
 * the real cause and offers the two things that actually help.
 */
export const ANSWER_QUALITY_FAILURE_LINE =
  '🤖 Sorry — I could not produce a usable answer just now. The model answered with its own working notes instead of your request. Please try again, or switch models with `nuvira models`.';

/**
 * RENDER-SITE sanitizer: never hand a leaked reasoning trace to a user.
 *
 * Two of the three real incidents had a genuine (if rough) answer sitting
 * BEHIND the trace, so suppressing everything throws away content the user
 * asked for; discarding nothing shows the reader "The user said \"Hi\" …
 * According to the instructions: …" as the answer. So: return the text
 * unchanged when it is not a leak, the deliverable when one can be recovered,
 * and EMPTY when the trace was the whole reply — the caller substitutes
 * `ANSWER_QUALITY_FAILURE_LINE` (empty is unambiguous: a real answer is never
 * blank by the time it reaches a render site).
 *
 * The loop engines now REJECT these replies at generation time, so reaching a
 * render site means every candidate narrated; this is the last line of defence,
 * not the mechanism.
 */
export function stripReasoningLeak(content: string): string {
  const text = content ?? '';
  if (!looksLikeReasoningLeakReply(text)) return text;
  const salvaged = stripLeadingReasoningTrace(text);
  return salvaged.trim() && !looksLikeReasoningLeakReply(salvaged) ? salvaged : '';
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
  /**
   * The OTHER quality failure — the model delivered its own REASONING (or its
   * plan for what it was about to do) as the answer. Produced by
   * `answerQualityError`, so the phrase is a fixed contract. Reported separately
   * from confusion because the two need different words: confusion means the
   * model got lost in the tool contract, this means it never wrote to the user
   * at all. Without this branch a turn whose every candidate narrated fell all
   * the way through to GENERATION_FAILURE_MESSAGE — telling the user "the
   * language model was unavailable" about a model that answered, just not
   * usefully (the same misdiagnosis the CONTRACT_CONFUSION branch fixed).
   */
  const REASONING_LEAK = /answered with its own reasoning/;
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
  if (REASONING_LEAK.test(m)) {
    return "The model wrote its own working notes instead of an answer, so there was nothing fit to send. Please try again, or switch models with `nuvira models`.";
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
  const stripped = content
    // An EMPTY fenced block — the fallback transport parsed the call out of
    // the body and left the fence behind.
    .replace(/\n?```[a-z]*\s*\n?\s*```\s*/gi, '\n')
    // A fenced block WHOSE BODY is the call.
    .replace(/```[a-z]*\s*\{[\s\S]*?"tool"\s*:\s*"suggest_followups"[\s\S]*?```/gi, '')
    // The bare trailing call object (the model wrote the tool JSON verbatim).
    .replace(/\n?\*?\s*\{\s*"tool"\s*:\s*"suggest_followups"[\s\S]*$/, '')
    // The Anthropic-style tag form (<function=suggest_followups …>).
    .replace(/\n?\*?\s*<function=suggest_followups[\s\S]*?<\/function>/g, '');
  // The THIRD shape — the model wrote the tool's ARGUMENTS (not the call) as
  // text, optionally under a bold header. Observed live from the execute loop:
  //
  //   Would you like to dive deeper…?
  //
  //   **suggest_followups**
  //   ```json
  //   { "followups": [ { "label": "…", "prompt": "…" } ] }
  //   ```
  //
  // No regex above matches it (there is no `"tool"` key), and a pure regex
  // cannot be trusted here: a fenced block legitimately containing a
  // `followups` field ("write me a JSON schema with a followups array") must
  // survive. So the payload is PARSED and only removed when it really is the
  // suggest_followups contract.
  return stripTrailingFollowupsPayload(stripped).trim();
}

/** JSON.parse that never throws — null for anything unparseable. */
function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

/**
 * Is this parsed value the model's `suggest_followups` payload?
 *
 * Accepts the tool-call object (`{tool:'suggest_followups',…}`) and the bare
 * arguments shape — an object with a `followups` list, or the list itself as a
 * BARE ARRAY under a `**suggest_followups**` caption (both observed live
 * 2026-09-21 from `nuvira execute`).
 *
 * CONSERVATISM ON PLAIN STRINGS: an entry that is a `{prompt}` object is the
 * tool's own schema and is accepted anywhere; a plain STRING entry is only
 * accepted when the model captioned the payload with the tool name, because
 * `{"followups":["Do you like it?"]}` is also a perfectly ordinary config a
 * user could have asked for and a bare one must survive. (These flags are
 * deliberately asymmetric rather than perfectly symmetric — this helper must
 * never delete a deliverable.)
 */
function isFollowupsPayload(value: unknown, allowStringEntries: boolean): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return isFollowupList(value, allowStringEntries);
  const o = value as { tool?: unknown; arguments?: unknown; followups?: unknown };
  if (o.tool === 'suggest_followups') return true;
  const nested = (o.arguments ?? {}) as { followups?: unknown };
  const list = Array.isArray(o.followups) ? o.followups : nested.followups;
  return isFollowupList(list, allowStringEntries);
}

/** A non-empty list of followup entries (`{prompt,label?}` objects, ± strings). */
function isFollowupList(list: unknown, allowStringEntries: boolean): boolean {
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.every(
    (f) =>
      (allowStringEntries && typeof f === 'string') ||
      (f !== null && typeof f === 'object' && typeof (f as { prompt?: unknown }).prompt === 'string'),
  );
}

/** Does the text immediately before a payload end on a tool-name caption? */
function hasFollowupsCaption(textBefore: string): boolean {
  return /\*{0,2}\s*suggest[_ ]?follow[_ ]?ups\s*\*{0,2}\s*:?[ \t]*$/i.test(
    textBefore.replace(/\s+$/, ''),
  );
}

/**
 * Drop a trailing followups payload — a fenced block whose body IS the payload,
 * or a bare trailing JSON value (object OR array) — plus the bold
 * `**suggest_followups**` header the model tends to caption it with. Structural (parses the body), so
 * a user-requested code block that merely contains the word `followups` is
 * never touched.
 */
function stripTrailingFollowupsPayload(text: string): string {
  const trimmed = text.replace(/\s+$/, '');
  if (!trimmed) return text;

  // 1. The LAST fenced block, when it ends the text and its body parses to
  //    the payload. (Anchoring on the last block — not the first — keeps an
  //    answer+code-block+followups-fence sequence correct.)
  if (trimmed.endsWith('```')) {
    const closing = trimmed.length - 3;
    const opening = trimmed.lastIndexOf('```', closing - 1);
    if (opening >= 0) {
      const newline = trimmed.indexOf('\n', opening);
      if (newline >= 0 && newline < closing) {
        const body = trimmed.slice(newline + 1, closing);
        if (isFollowupsPayload(parseJsonLoose(body), hasFollowupsCaption(trimmed.slice(0, opening)))) {
          return stripTrailingFollowupsHeader(trimmed.slice(0, opening));
        }
      }
    }
  }

  // 2. A bare trailing JSON value (object OR array), opening at a line boundary
  //    (where a model appends the payload). Try the candidates from the END
  //    backwards: the first whose slice parses is the OUTERMOST value that
  //    reaches the end (a nested `{` yields an unbalanced slice and fails).
  const lineStarts: number[] = [];
  const openRe = /^[ \t]*(\{|\[)/gm;
  let open: RegExpExecArray | null;
  while ((open = openRe.exec(trimmed)) !== null) lineStarts.push(open.index + open[0].length - 1);
  for (let k = lineStarts.length - 1; k >= 0; k--) {
    const start = lineStarts[k];
    if (isFollowupsPayload(parseJsonLoose(trimmed.slice(start)), hasFollowupsCaption(trimmed.slice(0, start)))) {
      return stripTrailingFollowupsHeader(trimmed.slice(0, start));
    }
  }
  return text;
}

/**
 * Remove the caption line left after a payload was stripped — a
 * `**suggest_followups**` label and/or the horizontal rule the model tends to
 * put in front of it. Only ever called once a payload WAS removed, so an
 * answer that legitimately ends in `---` on its own is untouched.
 */
function stripTrailingFollowupsHeader(text: string): string {
  return text
    .replace(/\n+\s*\*{0,2}\s*suggest[_ ]?follow[_ ]?ups\s*\*{0,2}\s*:?[ \t]*$/i, '')
    .replace(/\n+\s*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/, '')
    .replace(/\s+$/, '');
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
