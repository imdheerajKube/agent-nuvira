/**
 * The SESSION GRANT — "allow all write commands for this session".
 *
 * WHY THIS EXISTS. The confirm gate is correct to ask before a state-changing
 * action, but asking at ACTION granularity is the manual cadence at scale: on a
 * real codebase the number of interruptions is O(number of edits), which is not
 * safety, it is friction that merely looks like diligence. The intent envelope
 * (`intent-envelope.ts`) already removed the friction for work a request or an
 * approved plan authorized — but it is derived from the REQUEST, so an
 * operation the request did not obviously cover still asks, every time, for the
 * whole session.
 *
 * WHAT THIS IS. An EXPLICIT, user-granted, session-scoped permission to run a
 * CATEGORY of state-changing action without asking again:
 *
 *   - `write`    — file mutations (`edit_file`, `write_file`, …).
 *   - `terminal` — recoverable *local-state* shell commands (installs, mkdir,
 *                  cp/mv, git add — the workspace set).
 *
 * It is offered at the exact moment the guard would ask (the `ask_user` a
 * confirmation refusal asks for) as one extra choice — "Allow all <category>
 * for this session" — so the user's explicit go-ahead is received, never
 * inferred. A user who does not pick it keeps the ask-every-time default; there
 * is no silent widening.
 *
 * THE LINE IT DOES NOT CROSS. Exactly like the envelope, a session grant NEVER
 * covers the two classes that must stay the user's call: `external` (publishes,
 * spends, anything that leaves this machine) and `destructive` (irreversible
 * removal). "Allow all terminal commands" is therefore "allow all recoverable
 * workspace commands", not "run anything". The absolute DENY patterns in
 * `run-terminal.ts` still run BEFORE this grant is ever consulted, so a
 * `sudo`/`git push`/`rm -rf /` is refused regardless of what was granted.
 *
 * WHERE IT LIVES. Per CONVERSATION, keyed to the session's plan store — the
 * same key the intent envelope uses — so it survives the turn that granted it
 * and dies with the conversation. A `WeakMap` key means nothing to clean up. A
 * TTL is the brakeman on a stale grant; the default is long enough to outlast a
 * working session and short enough that yesterday's go-ahead cannot silently
 * authorize today's work.
 */

/** The categories a session grant can cover. */
export type SessionGrantCategory = 'write' | 'terminal';

/**
 * How long a session grant stays live. Eight hours is a working session; the
 * grant is per-conversation anyway, so this only bounds a conversation that is
 * left open far longer than its work.
 */
export const SESSION_GRANT_TTL_MS = 8 * 60 * 60 * 1000;

/** An explicit, session-scoped permission to skip the confirm gate. */
export interface SessionGrant {
  categories: SessionGrantCategory[];
  grantedAt: number;
  expiresAt: number;
  /** How it was granted — recorded so the decision is auditable, not a vibe. */
  reason: string;
}

/** Per-conversation grant store, keyed by the session's plan store. */
const store = new WeakMap<object, SessionGrant>();

function isKey(key: unknown): key is object {
  return (typeof key === 'object' && key !== null) || typeof key === 'function';
}

/** The human label for a category, used in the offered choice and messages. */
export function sessionGrantLabel(category: SessionGrantCategory): string {
  return category === 'terminal' ? 'terminal commands' : 'file writes';
}

/**
 * Grant (or extend) session permission for the given categories. Additive on
 * purpose: granting `write` after `terminal` must not revoke the first.
 */
export function grantSession(
  key: object | undefined,
  categories: SessionGrantCategory[],
  reason = 'the user allowed this for the session',
  now = Date.now(),
): SessionGrant | null {
  if (!isKey(key) || categories.length === 0) return null;
  const prev = store.get(key);
  const merged = new Set<SessionGrantCategory>([
    ...((prev && prev.expiresAt > now ? prev.categories : []) as SessionGrantCategory[]),
    ...categories,
  ]);
  const grant: SessionGrant = {
    categories: [...merged],
    grantedAt: now,
    expiresAt: now + SESSION_GRANT_TTL_MS,
    reason,
  };
  store.set(key, grant);
  return grant;
}

/** The live grant for a conversation, or null. An EXPIRED grant is dropped on read. */
export function getSessionGrant(key: object | undefined, now = Date.now()): SessionGrant | null {
  if (!isKey(key)) return null;
  const grant = store.get(key);
  if (!grant) return null;
  if (grant.expiresAt <= now) {
    store.delete(key);
    return null;
  }
  return grant;
}

/** Revoke the grant (the user asked to be asked again, or the session ended). */
export function clearSessionGrant(key: object | undefined): void {
  if (isKey(key)) store.delete(key);
}

/** Does the session grant cover this category right now? */
export function sessionGrantCovers(
  key: object | undefined,
  category: SessionGrantCategory,
  now = Date.now(),
): boolean {
  return getSessionGrant(key, now)?.categories.includes(category) ?? false;
}

/** A one-line disclosure, so a granted session says so instead of acting silently. */
export function sessionGrantNotice(grant: SessionGrant): string {
  const labels = grant.categories.map(sessionGrantLabel).join(' and ');
  return (
    `✅ Allowed for this session: ${labels}. They run without asking again; ` +
    'irreversible and off-machine actions still ask, and the permission ends with this conversation.'
  );
}
