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
import { parseRequestSync } from './parser.js';

/**
 * Verbs that are unambiguous coding TASKS when used in command position.
 * Kept to verbs that are rarely used as nouns (unlike "update"/"remove"/
 * "delete", where "why did the update fail?" is a genuine question) — the
 * gate must not misfire on a question.
 */
const STRONG_TASK_VERBS =
  'fix|debug|repair|troubleshoot|create|build|implement|generate|scaffold|bootstrap|develop|refactor|migrate|deploy|install|configure|setup|set up|integrate|optimize|restructure';

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
  // Command position only — a verb used as a noun ("what is the fix for…")
  // must never be read as an imperative.
  return TASK_VERB_AT_START.test(t) || TASK_VERB_AFTER_PREFIX.test(t);
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
  if (hasCodingAction(t)) return false;
  const parsed = parseRequestSync(t);
  return parsed.action.run === 'chat';
}
