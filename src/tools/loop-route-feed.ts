/**
 * The route feed — what the model is TOLD about the model that is serving it.
 *
 * WHY THIS EXISTS. The loop's system prompt describes the tool surface, the
 * project, and the contract, and it says nothing about the route. So when a user
 * asks "which model are you?" — or when the model narrates its own run — the only
 * available answers are a guess, the user's config (`nuviraconfig.json`, which is
 * what the ROUTER reads, not what answered), or a model name from its own
 * training data. All three are fabrications. On this machine the config pins
 * `providers.groq.model = openai/gpt-oss-120b` while a run can be served by a
 * Gemini model, a repaired replacement, or a local model after a failover; a
 * model that answers from config is simply wrong, and confidently so.
 *
 * The fix is the one this repo already applies to every other claim: state the
 * fact that was measured, at the moment it was measured. The loop re-reads this
 * feed BEFORE EVERY MODEL CALL, so a mid-turn failover cannot leave the model
 * believing it is still something it stopped being three steps ago.
 *
 * The rules that make it honest rather than decorative:
 * - It is generated from the resolver's own result, never from config.
 * - Unknown stays unknown: an unresolved route says so and forbids inventing one.
 * - A substitution is NAMED, in both directions, because "the router quietly ran
 *   you on something else" is the defect (see the route resolver).
 * - It tells the model what to do with the fact (answer from this line; if a user
 *   asks, quote it), because a fact with no instruction is a fact the model
 *   paraphrases into something else.
 */

import type { ServedRoute } from '../inference/route-resolver.js';

/** Marker that identifies the feed inside the thread (used to replace it). */
export const ROUTE_FEED_MARKER = 'ROUTE — what is actually serving this turn';

/** Sentinel model values that mean "nothing was resolved". */
const UNRESOLVED = new Set(['', 'default', 'auto', 'unknown', 'undefined']);

export function isUnresolvedModel(model: string | undefined): boolean {
  return !model || UNRESOLVED.has(model);
}

/**
 * The thread frame.
 *
 * `requested`/`substituted` and `previous` are all optional because they are all
 * facts that may not exist yet; the frame degrades to fewer true lines rather
 * than filling gaps.
 */
export function routeFeedText(route: ServedRoute): string {
  const lines: string[] = [ROUTE_FEED_MARKER + ' (measured by the resolver, not a guess):'];

  lines.push(`- provider: ${route.providerType || 'unknown'}${route.providerName && route.providerName !== route.providerType ? ` (${route.providerName})` : ''}`);

  if (isUnresolvedModel(route.model)) {
    lines.push('- model: UNRESOLVED — the provider chooses at call time. You do NOT know which model is answering.');
  } else {
    lines.push(`- model: ${route.model}`);
  }

  if (route.requested && route.substituted) {
    lines.push(`- requested: ${route.requested} → NOT available on ${route.providerType}; the router substituted ${route.model}. Say it that way if it comes up.`);
  } else if (route.requested && !route.substituted) {
    lines.push(`- requested: ${route.requested} (served as asked)`);
  }

  if (route.previous && route.previous.length > 0) {
    lines.push(`- earlier in this turn: ${route.previous.join(', ')} (a failover moved the work; the newest line above is the truth)`);
  }

  lines.push(
    '- If the user asks which model/provider you are, answer from THIS line. If it says UNRESOLVED, say the route is unresolved — do not name a model from memory, from the user\'s config, or from an earlier step, and do not claim a model you have not been told about.',
  );

  return lines.join('\n');
}

/**
 * Record a NEW serving route, carrying the ones it replaced (bounded).
 *
 * The history is what turns "you are on local/gemma4:e4b" into the honest
 * "steps 1-3 were answered by groq/openai/gpt-oss-120b, then it failed over" — a
 * model told only the current pair will happily describe the whole turn as
 * having been run by it.
 */
export function noteServedRoute(previous: ServedRoute | null, next: ServedRoute): ServedRoute {
  const history = [...(previous?.previous ?? [])];
  if (previous && !isUnresolvedModel(previous.model)) {
    const pair = `${previous.providerType}/${previous.model}`;
    const current = `${next.providerType}/${next.model}`;
    if (pair !== current && !history.includes(pair)) history.push(pair);
  }
  const bounded = history.slice(-MAX_ROUTE_HISTORY);
  return bounded.length > 0 ? { ...next, previous: bounded } : next;
}

/** Cap on remembered serving pairs — enough for a turn's failovers, not a log. */
export const MAX_ROUTE_HISTORY = 4;

/**
 * Identity of a feed, for change detection. Two feeds with the same fingerprint
 * render the same text, so the loop can skip a rewrite instead of churning the
 * thread on every step.
 */
export function routeFeedFingerprint(route: ServedRoute | null | undefined): string {
  if (!route) return '';
  return [
    route.providerType || '',
    route.providerName || '',
    route.model || '',
    route.requested || '',
    route.substituted ? '1' : '0',
    (route.previous || []).join('>'),
  ].join('|');
}
