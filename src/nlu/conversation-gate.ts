/**
 * P0.5 — conversation-vs-pipeline gate.
 *
 * Deterministic classifier: is this ask a conversational QUESTION (answer
 * directly) or a coding GOAL (run the pipeline)? This gate exists to kill the
 * observed failure: "agent can't answer a simple question if asked in
 * execute, it will only create a python program even against a genuine
 * question or clarification."
 *
 * Reuses the existing deterministic signals — zero model calls, <5ms budget:
 *
 * 1. `parseRequestSync` (C1/C3 action map): explain/assess/compare/write/
 *    unknown → action.run 'chat' (answer directly); create/fix/continue →
 *    action.run 'pipeline'. The NLU already routes the obvious cases
 *    ("assess the project" → chat, "fix the failing test" → pipeline).
 * 2. `isTrivialPrompt`: bare greetings / acknowledgements
 *    ("hi", "thanks", "ok", "continue") are conversational — never a goal
 *    for the multi-agent pipeline.
 * 3. A coding-action override for the NLU's known blind spot: a TASK phrased
 *    as a question ("can you fix the login bug?", "how do I add JWT auth to
 *    the app?") parses as explain (chat) because it starts with an
 *    interrogative — when the coding verb sits in COMMAND position (sentence
 *    start, or after a polite/imperative prefix), it marks the ask a task
 *    again. A verb used as a NOUN ("what is the fix for this error?", "why
 *    does deploy fail?") never triggers the override, so genuine questions
 *    keep answering directly.
 *
 * The gate is deliberately conservative: it only redirects UNAMBIGUOUS
 * questions away from the pipeline and lets every coding goal through. When
 * in doubt it returns false (task) so no legitimate pipeline goal is ever
 * starved of execution.
 */

import { isTrivialPrompt } from '../memory/provider.js';
import { parseRequestSync, type ParsedRequest } from './parser.js';
import { isContentArtifactAsk, stripArtifactReferences } from './intent.js';
import { asksForAuthoredFile, isLongFormAuthoredGoal } from '../learning/deliverable-class.js';
// The learned corrections. A plain store (mtime-cached, no routing graph), so
// consulting it on every ask costs a comparison, not a read.
import { applyLearning, noteLearningApplied, type NluLearning } from './learnings.js';

/**
 * Verbs that are unambiguous coding TASKS when used in command position.
 * Kept to verbs that are rarely used as nouns (unlike "update"/"remove"/
 * "delete", where "why did the update fail?" is a genuine question) — the
 * gate must not misfire on a question.
 */
const STRONG_TASK_VERBS =
  'fix|debug|repair|troubleshoot|patch|address|diagnose|correct|create|build|implement|generate|scaffold|bootstrap|develop|refactor|migrate|deploy|install|configure|setup|set up|integrate|optimize|restructure';

/** Verb at the very start of the ask ("fix the failing test", "deploy the api"). */
const TASK_VERB_AT_START = new RegExp(`^(?:please\\s+)?(?:${STRONG_TASK_VERBS})\\b`, 'i');

/**
 * Verb after a polite/imperative prefix — the exact shape the NLU's explain
 * rule traps as a chat question ("can you fix the login bug?", "how do I add
 * JWT auth to the app?"). "add" is included HERE but not at sentence start,
 * because "add 2 + 2" (start position) is math while "how do I add auth" is
 * coding — the NLU's own create rule mirrors this (article/project noun gate).
 */
const TASK_VERB_AFTER_PREFIX = new RegExp(
  `^(?:please\\s+)?(?:can you|could you|will you|would you|how do i|how can i|i need you to|help me|go ahead and)\\s+(?:${STRONG_TASK_VERBS}|add)\\b`,
  'i',
);

/** True when the ask carries an unambiguous coding action (task, not question). */
export function hasCodingAction(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  // A CONTENT artifact ask ("create a plan/routine/schedule for my child",
  // "build a routine", "create a test for class 4") is not code — the verbs
  // below would otherwise force it into the developer pipeline (observed live:
  // a WhatsApp teaching-plan ask ran the pipeline, whose planner emitted a
  // Python program). The guard runs BEFORE the verb test so no create/build/
  // fix verb can override it; it is a no-op when the ask names a coding object
  // ("create a plan for the ecommerce app").
  if (isContentArtifactAsk(t)) return false;
  // Command position only — a verb used as a noun ("what is the fix for…")
  // must never be read as an imperative. Judged on the REQUESTED action: a
  // sentence that opens by pointing back at an earlier artifact ("Following
  // the plan, develop the calculator") still starts the work in command
  // position, and testing the raw text would miss it. Leading punctuation is
  // dropped too, since removing a reference clause leaves its comma behind.
  // A leading discourse marker is not part of the action ("Now implement the
  // calculator", "Then fix the login bug"). Only markers are dropped, and a
  // STRONG_TASK_VERB must still follow immediately, so a question is never
  // misread ("so, what is the fix?" finds no verb in command position).
  const action = stripArtifactReferences(t)
    .replace(/^[\s,;:.!-]+/, '')
    .replace(/^(?:(?:please|now|next|then|ok|okay|so|also|and)\s*,?\s*)+/i, '');
  return TASK_VERB_AT_START.test(action) || TASK_VERB_AFTER_PREFIX.test(action);
}

/**
 * Is this a LONG-FORM authored deliverable — content the pipeline must build in
 * bounded units rather than answer in one reply?
 *
 * WHY THIS EXISTS (live evidence): "write a 12 page story called Kharig Nights
 * about a village boy who finds a lamp in a banyan root" was read as a
 * CONVERSATIONAL question — the NLU maps `write` to a chat action — and answered
 * in a single reply, bypassing the unit ledger entirely. For 12 pages that
 * looked acceptable; for "write a 200 page book" it is fatal: the ask never
 * reaches the machinery that decomposes it, so nothing measures progress,
 * nothing resumes, and nothing continues unattended. A long-form deliverable is
 * not a question, whatever verb introduces it.
 *
 * BOTH conditions are required:
 *   1. an EXPLICIT magnitude (pages/chapters/words/sections) splitting into more
 *      than one unit — "write a story" keeps answering directly, and the
 *      DEFAULT chapter count invented for a bare "book" does not count as one;
 *   2. the deliverable classifier reads the ask as authored content. Without
 *      this, "write a 20 page plan for my child" would be pushed into a pipeline
 *      whose authored path does not recognise it — reintroducing exactly the
 *      category error (plan a program for prose) this workstream exists to
 *      remove.
 */
/**
 * Does this ask need more than one unit of work?
 *
 * Kept as a named export because callers and tests read it by this name, but it
 * now DELEGATES to `isLongFormAuthoredGoal` — one definition, in the module that
 * owns deliverable classification. The rule used to exist twice (here and in
 * the classifier), which is exactly how "what counts as longer than one
 * generation" drifts.
 */
export function isLongFormDeliverable(text: string | null | undefined): boolean {
  return isLongFormAuthoredGoal(String(text ?? ''));
}

/**
 * The P0.5 gate: return true when the ask is a conversational question that
 * must be ANSWERED DIRECTLY and must NEVER run the multi-agent pipeline
 * (which would create a python program to "answer" it).
 *
 * Priority: trivial prompts first (greetings/acknowledgements → question),
 * then the coding-action override (a task phrased as a question stays a
 * task), then the NLU action map (chat actions → question; everything else
 * → task).
 */
export function isConversationalQuestion(text: string | null | undefined): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (isTrivialPrompt(t)) return true;
  // An authored deliverable that has to land ON DISK outranks the NLU's chat
  // mapping for `write`: the machinery that can actually produce the artifact
  // must be the one that receives it. Two evidence kinds qualify, and both are
  // precise — a magnitude needing more than one unit ("a 200 page book"), or a
  // NAMED DESTINATION ("write a 2 page story to /path/kharig-nights.md").
  //
  // The second one is G13b, found live: "2 pages" resolves to a single unit, so
  // `isLongFormDeliverable` fails it and the ask fell through to the NLU's chat
  // mapping — a complete story in the reply, and no file at the path the user
  // named. This gate is the only place that could fix it: every surface routes
  // through here, and the engine router (which would have sent it to the
  // pipeline) is never reached when the ask is called chat.
  //
  // Deliberately NOT trigger-happy — this is `asksForAuthoredFile`, the narrow
  // half. A creation verb on an authored noun alone does not qualify, so "write a
  // poem about rain", "write an essay about my village" and "write a book about
  // the sea" (default magnitude) stay chat answers: for those the text IS the
  // deliverable. The broader `wantsAuthoredArtifact` would re-route every one of
  // them, which is the original category error in reverse.
  if (asksForAuthoredFile(t)) return false;
  if (hasCodingAction(t)) return false;
  const parsed = parseRequestSync(t);
  return parsed.action.run === 'chat';
}

/** What an ask needs: a direct answer, or the multi-agent pipeline. */
export type AskKind = 'chat' | 'pipeline';

/**
 * THE routing decision — one function, every surface.
 *
 * Before this existed, each entry point re-derived the chat-vs-pipeline choice
 * its own way and they disagreed. The gateway asked only
 * `parseRequestSync(text).action.run`, so "how do I add JWT auth to the app?"
 * (status: the NLU's explain rule traps it as a chat question) came back as
 * prose instead of getting the auth added, while a pipeline-shaped ask that was
 * really a question still burned a multi-agent run. The CLI chat path already
 * had the fix — the gate's question check first, then the coding-action
 * override — so the gateway now calls the same function.
 *
 * Order (load-bearing):
 * 1. a genuine question → 'chat' (never create a program to "answer" it);
 * 2. a coding verb in command position → 'pipeline' (even when the NLU
 *    misreads it as explain);
 * 3. otherwise the NLU action map decides, defaulting to 'chat'.
 *
 * `parsed` may be supplied by a caller that already parsed the text (the
 * gateway does), so this costs nothing extra on the hot path.
 */
export function resolveAskKind(
  text: string | null | undefined,
  parsed?: ParsedRequest,
): AskKind {
  return explainAskKind(text, parsed).kind;
}

/** One routing verdict WITH the reason it differs from the rules. */
export interface AskKindExplanation {
  /** The route to use. */
  kind: AskKind;
  /** What the deterministic rules alone would have said. */
  base: AskKind;
  /** The learned correction that overrode those rules, when there is one. */
  learning?: NluLearning;
}

/**
 * Resolve the route AND explain it — the same function `resolveAskKind` uses,
 * split out so the CLI can say WHY a route differs from the rules. An override
 * nobody can see is its own bug.
 *
 * A LEARNED correction outranks the rules: it exists because this exact ask was
 * read wrong before and the model confirmed what it really is (see
 * `intent-confirm.ts`), so the rules have already been shown to fail here. It is
 * checked against the HEURISTIC verdict — a learning that agrees with the rules
 * is not an override, and must not be reported as one.
 */
export function explainAskKind(
  text: string | null | undefined,
  parsed?: ParsedRequest,
): AskKindExplanation {
  const t = String(text ?? '').trim();
  if (!t) return { kind: 'chat', base: 'chat' };
  if (isTrivialPrompt(t)) return { kind: 'chat', base: 'chat' };

  // Same two artifact rules as `isConversationalQuestion`, in the same order:
  // the two must agree, or a surface that calls one and a surface that calls the
  // other would route the identical ask differently (the disagreement this
  // function was written to end). `asksForAuthoredFile` is the whole rule — it
  // already covers the long-form magnitude case that used to be spelled out
  // separately here.
  const base: AskKind = asksForAuthoredFile(t)
    ? 'pipeline'
    : hasCodingAction(t)
    ? 'pipeline'
    : (parsed ?? parseRequestSync(t)).action.run === 'pipeline'
      ? 'pipeline'
      : 'chat';

  const learned = applyLearning(t, base);
  if (!learned) return { kind: base, base };
  noteLearningApplied(learned.learning.id);
  return { kind: learned.kind, base, learning: learned.learning };
}

/**
 * Is this ask a LOCAL CLI COMMAND aimed at the agent itself ("run nuvira
 * gateway status", "agent-nuvira models", "buff gateway status")?
 *
 * Observed live: a sender typed a diagnostic command into WhatsApp and the
 * gateway dispatched a SIX-TASK multi-agent pipeline (because the NLU read
 * "run …" as a create intent) that failed after 112s and wrote an approval
 * artifact. A remote sender cannot execute a command on the operator's
 * machine, and a coding pipeline is the worst possible answer — so this is
 * recognised explicitly and answered with a pointer instead.
 */
export function looksLikeAgentCliAsk(text: string | null | undefined): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  return /(?:^|\s)(?:nuvira|agent-nuvira|buff)\s+(?:gateway|models?|status|config|contacts?|delivery|whatsapp|dashboard|traces?|leaderboard)\b/i.test(
    t,
  );
}
