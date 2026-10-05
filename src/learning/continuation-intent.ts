/**
 * Intent-aware escalation for BARE continuations.
 *
 * WHY THIS EXISTS (2026-10-04). Routing is decided per message, which is right
 * for a fresh ask — but a conversation's next turn is often just `yes`, `do it`
 * or `go ahead`. Those carry no routing signal of their own: `analyzeTaskProfile`
 * reads them as a trivial ask, so the follow-up to a real software task gets
 * scored as small talk and can be sent to a weak/cheap model even though it is
 * the continuation of complex code work.
 *
 * This module lets a caller (the chat REPL, `answerOnce`, the loop executor)
 * recognise that case and hand the router the RECENT SOFTWARE ASK as the routing
 * text instead of the bare continuation. The ANSWER still uses the user's own
 * message — only the routing decision is escalated, and only when the
 * conversation really was software work.
 *
 * Deliberately conservative: it fires only on a short, unambiguous affirmation,
 * and only when a recent user turn was a software ask. Everything else routes
 * exactly as before, so a genuine "thanks" or a fresh question is untouched.
 */

import { analyzeTaskProfile } from './auto-router.js';

/**
 * Intents that mean "this is code work". The router's `analyzeTaskProfile`
 * defaults a non-creative ask to `coding`, so this is the union of the explicit
 * software intents; `creative` and `chat` are deliberately excluded.
 */
const SOFTWARE_INTENTS = new Set<string>([
  'coding',
  'debugging',
  'verification',
  'migration',
  'architecture',
  'security',
  'planning',
]);

/**
 * A short, unambiguous affirmation/continuation that names no new task. Kept
 * tight on purpose: a message with ANY task content ("yes, but make it red")
 * is not a bare continuation and must route on its own text.
 */
const BARE_CONTINUATION_RE =
  /^(?:yes|yep|yeah|yup|ok|okay|sure|go|go ahead|do it|proceed|continue|please do|fix it|make it so|sounds good|go on|carry on|keep going|and|then)\.?$/i;

/** Longest message still treated as a bare continuation (chars). */
const MAX_BARE_LEN = 40;

/** A minimal turn shape — matches chat history ({ role, content }). */
export interface ContinuationTurn {
  role: string;
  content: string;
}

/**
 * Is this message a bare continuation that names no task of its own?
 * Pure; never throws.
 */
export function isBareContinuation(message: string): boolean {
  const m = (message ?? '').trim();
  if (!m || m.length > MAX_BARE_LEN) return false;
  return BARE_CONTINUATION_RE.test(m);
}

/**
 * The routing text for a turn: the PREVIOUS SOFTWARE ASK when this message is a
 * bare continuation of it, otherwise `null` (the caller keeps its own message).
 *
 * Considers only the MOST RECENT user turn — the one the continuation most
 * plausibly refers to. Deliberately NOT a search further back: resurrecting an
 * old code ask after the conversation has moved on (to chit-chat or writing)
 * would escalate a turn that is no longer about that work. Returns `null` when
 * the message is not a bare continuation, when there is no prior user turn, or
 * when the previous ask was not software work.
 */
export function continuationSoftwareText(
  message: string,
  history: readonly ContinuationTurn[] | undefined,
): string | null {
  if (!isBareContinuation(message)) return null;
  const lastUser = [...(history ?? [])]
    .reverse()
    .find((h) => h && h.role === 'user' && typeof h.content === 'string');
  if (!lastUser) return null;
  try {
    const profile = analyzeTaskProfile(lastUser.content);
    return SOFTWARE_INTENTS.has(profile.intent) ? lastUser.content : null;
  } catch {
    // A classifier failure must never break routing.
    return null;
  }
}
