/**
 * The Intent Envelope — authorization as a property of the INTENT, not of each
 * individual action.
 *
 * WHY THIS EXISTS (the "permission every second" audit):
 *
 * Every confirmation-gated tool asked the same question — "has the user
 * authorized this?" — and answered it by re-deriving a verdict from the LAST
 * USER MESSAGE, once per turn (`writesAuthorized`). That design has two fatal
 * properties at scale:
 *
 *   1. PERMISSION AT ACTION GRANULARITY. The number of human round trips is the
 *      number of state-changing operations. On a four-file calculator that is a
 *      handful; on a real codebase it is O(n) interruptions — the manual
 *      cadence, at scale. A permission that attaches to each keystroke is not
 *      safety; it is friction that merely LOOKS like diligence.
 *   2. AUTHORIZATION IS NOT DURABLE. It evaporates at the turn boundary and is
 *      recomputed from whatever sentence the user typed last. So an approval
 *      that was given five minutes ago ("go ahead and fix it") is worth nothing
 *      on the next turn, and an unrelated word at the front of a message
 *      ("why are you asking me this again? Apply a safe expression parser by
 *      updating script.js") can flip the entire turn to UNAUTHORIZED — which is
 *      how a complaint about repeated questions made the agent ask MORE.
 *
 * The fix is the same one a good developer applies to a client relationship:
 * agree the intent ONCE, then execute it. This module is that agreement as an
 * object.
 *
 * WHAT IT IS: `{ goal, scope, grantedAt, expiresAt, source }`. It is granted by
 * an explicit directive request, or — the path that matters most — by the user
 * APPROVING THE AGENT'S PLAN. Inside the envelope, reversible work executes with
 * no prompt. It is scoped (a tool set + optional path prefixes), it expires, and
 * it NEVER covers the two classes that must stay the user's call: actions that
 * leave this machine (`external`) and actions that irreversibly remove what
 * exists (`destructive`). A plan approval is not a licence to publish, delete,
 * or spend.
 *
 * WHERE IT LIVES: per CONVERSATION, not per turn — the envelope is stored
 * against the session's plan store (the dashboard console keeps exactly one per
 * session and re-injects it every turn), so it outlives the turn that granted
 * it and dies with the conversation. A `WeakMap` key means the entry is
 * collected with the session; nothing to clean up, nothing to leak.
 *
 * DELIBERATELY NOT HERE: any natural-language policy. The defect this replaces
 * was prose regexes over the request (`^why` disabled authorization
 * outright). Authorization is now decided from STRUCTURED state — a granted
 * envelope and a change class — with prose used only to *present* the decision.
 */

import {
  requestAuthorizesWrites,
  extractRequestedPath,
  type StateChangeClass,
} from './autonomy-policy.js';

/** What an envelope permits. */
export interface EnvelopeScope {
  /**
   * Workspace-relative path prefixes the envelope permits. EMPTY means the
   * envelope covers the whole workspace — the right default when the user's
   * request was project-wide ("fix the calculator"), and the reason a whole-file
   * overwrite still needs its path to be NAMED (see `envelopeNamesPath`).
   */
  paths: string[];
  /** Tools the envelope permits. Empty means `DEFAULT_ENVELOPE_TOOLS`. */
  tools: string[];
}

/** The approved intent — one grant, then execution. */
export interface IntentEnvelope {
  /** The intent, in the user's words (trimmed for display). */
  goal: string;
  scope: EnvelopeScope;
  grantedAt: number;
  /** Absolute epoch ms. Expiry is the brakeman on a stale grant. */
  expiresAt: number;
  /**
   * How it was granted. `plan-approval` is the high-trust path (the user saw the
   * plan and said yes); `request` is a direct order in the request text.
   */
  source: 'request' | 'plan-approval';
  /** Why — recorded so the judgment is auditable rather than a vibe. */
  reason: string;
}

/**
 * How long a grant stays live. Two hours is long enough to outlast a working
 * session and short enough that yesterday's approval cannot silently authorize
 * today's work. Deliberately no "renew on use": a grant that never expires is a
 * permanent licence, which is the failure this module exists to avoid.
 */
export const ENVELOPE_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * The reversible tool set an envelope authorizes when it names none. This is
 * NOT a safety boundary on its own — the change-class veto below is — so the
 * list is the work surface, not a fence: reads, the two write tools, the shell,
 * git, and plan tracking.
 */
export const DEFAULT_ENVELOPE_TOOLS: readonly string[] = [
  'read_file',
  'list_dir',
  'glob',
  'code_search',
  'edit_file',
  'write_file',
  'run_terminal',
  'run_cli',
  'git',
  'plan_todo',
];

/**
 * Change classes the envelope NEVER covers. Settled FIRST, so no later rule can
 * turn a publish or a delete into an autonomous action.
 */
const NEVER_COVERED: ReadonlySet<StateChangeClass> = new Set<StateChangeClass>([
  'external',
  'destructive',
]);

/** Per-conversation envelope store, keyed by the session's plan store. */
const store = new WeakMap<object, IntentEnvelope>();

/** Is this object usable as an envelope key (a session handle)? */
export function isEnvelopeKey(key: unknown): key is object {
  return (typeof key === 'object' && key !== null) || typeof key === 'function';
}

/** Grant (or replace) the envelope for a conversation. */
export function grantEnvelope(key: object, envelope: IntentEnvelope): void {
  store.set(key, envelope);
}

/**
 * The live envelope for a conversation, or null. An EXPIRED envelope is removed
 * on read, so a stale grant can never be observed — the failure direction is
 * always "ask again", never "act on yesterday's approval".
 */
export function getEnvelope(key: object | undefined, now = Date.now()): IntentEnvelope | null {
  if (!isEnvelopeKey(key)) return null;
  const env = store.get(key);
  if (!env) return null;
  if (env.expiresAt <= now) {
    store.delete(key);
    return null;
  }
  return env;
}

/** Drop the envelope (the conversation ended, or the user revoked it). */
export function clearEnvelope(key: object | undefined): void {
  if (isEnvelopeKey(key)) store.delete(key);
}

/** One action, as the acting tool can measure it. */
export interface EnvelopeAction {
  /** Tool name (`edit_file`, `run_terminal`, …). */
  tool: string;
  /** Workspace-relative target path, when the action targets a file. */
  path?: string;
  /** What kind of change the action makes (from the state-change table). */
  changeClass: StateChangeClass;
}

/** The ruling on whether the envelope covers an action. */
export interface EnvelopeVerdict {
  covered: boolean;
  reason: string;
}

/** Normalize a workspace-relative path for prefix comparison. */
function normalizeRel(path: string): string {
  return String(path ?? '').trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Is `path` inside one of `prefixes` (or under it)? */
function pathInScope(path: string, prefixes: string[]): boolean {
  const rel = normalizeRel(path);
  return prefixes.some((p) => {
    const prefix = normalizeRel(p);
    if (!prefix) return false;
    return rel === prefix || rel.startsWith(`${prefix}/`);
  });
}

/**
 * Does the approved envelope cover this action?
 *
 * Order is load-bearing, and the two never-authorized classes are settled first:
 *
 *   1. NO ENVELOPE -> not covered. The default is the original strictness.
 *   2. EXTERNAL / DESTRUCTIVE -> not covered, whatever the request said. The
 *      user approving a plan is not consenting to publish, delete or spend.
 *   3. TOOL NOT IN SCOPE -> not covered.
 *   4. PATH OUTSIDE SCOPE -> not covered. An empty path list means the whole
 *      workspace, which is the correct reading of a project-wide request.
 *   5. OTHERWISE -> covered.
 */
export function envelopeCoversAction(
  envelope: IntentEnvelope | null | undefined,
  action: EnvelopeAction,
): EnvelopeVerdict {
  if (!envelope) {
    return { covered: false, reason: 'no approved intent envelope for this conversation' };
  }
  if (NEVER_COVERED.has(action.changeClass)) {
    return {
      covered: false,
      reason:
        `an approved plan authorizes the work inside it, never a ${action.changeClass} action — ` +
        'that stays the user’s call',
    };
  }
  const tools = envelope.scope.tools.length > 0 ? envelope.scope.tools : [...DEFAULT_ENVELOPE_TOOLS];
  if (!tools.includes(action.tool)) {
    return { covered: false, reason: `'${action.tool}' is outside the approved envelope` };
  }
  if (action.path && envelope.scope.paths.length > 0 && !pathInScope(action.path, envelope.scope.paths)) {
    return {
      covered: false,
      reason: `'${action.path}' is outside the approved envelope scope (${envelope.scope.paths.join(', ')})`,
    };
  }
  return { covered: true, reason: `inside the approved envelope for “${envelope.goal}”` };
}

/**
 * Does the envelope NAME this exact path?
 *
 * The stricter question a whole-file overwrite needs. A project-wide envelope
 * ("fix the calculator") covers edits but must NOT authorize replacing a file
 * wholesale — a re-run cannot recover that, so it stays the user's call unless
 * their request named the file. Deliberately false for a whole-workspace
 * envelope, which is the entire point.
 */
export function envelopeNamesPath(
  envelope: IntentEnvelope | null | undefined,
  path: string,
): boolean {
  if (!envelope || envelope.scope.paths.length === 0) return false;
  return pathInScope(path, envelope.scope.paths);
}

/** A one-line goal for display (the request can be a paragraph). */
function summarizeGoal(request: string, max = 120): string {
  const one = String(request ?? '').replace(/\s+/g, ' ').trim();
  if (!one) return '(untitled intent)';
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * Build an envelope from a DIRECTIVE request, or null when the request does not
 * authorize the work.
 *
 * Uses the same verdict the write gates already trusted (`requestAuthorizesWrites`),
 * so "the request authorized this" is defined once — the difference is that the
 * result is now a durable, scoped object instead of a per-turn boolean.
 */
export function envelopeFromRequest(request: string, now = Date.now()): IntentEnvelope | null {
  const auth = requestAuthorizesWrites(request);
  if (!auth.authorized) return null;
  const named = auth.requestedPath ?? extractRequestedPath(request);
  return {
    goal: summarizeGoal(request),
    scope: {
      paths: named ? [normalizeRel(named)] : [],
      tools: [...DEFAULT_ENVELOPE_TOOLS],
    },
    grantedAt: now,
    expiresAt: now + ENVELOPE_TTL_MS,
    source: 'request',
    reason: auth.reason,
  };
}

/**
 * Build an envelope from an APPROVED PLAN — the high-trust path.
 *
 * This is the "ask once for the concept, then implement" contract made
 * mechanical: the user saw the plan and approved it, so the plan's goal is the
 * intent and its named paths are the scope. `paths` is optional; an empty list
 * means the whole workspace, which is what a project-wide plan should get.
 */
export function envelopeFromPlan(
  goal: string,
  paths: string[] = [],
  now = Date.now(),
): IntentEnvelope {
  const scopePaths = (paths ?? []).map(normalizeRel).filter((p) => p.length > 0);
  return {
    goal: summarizeGoal(goal),
    scope: { paths: scopePaths, tools: [...DEFAULT_ENVELOPE_TOOLS] },
    grantedAt: now,
    expiresAt: now + ENVELOPE_TTL_MS,
    source: 'plan-approval',
    reason: 'the user approved this plan — its steps run under one grant',
  };
}

/** The line shown when the agent proceeds inside an approved envelope. */
export function envelopeGrantedLine(envelope: IntentEnvelope): string {
  return (
    `✅ Approved: “${envelope.goal}” — running it under one grant. ` +
    'You will not be asked per step; say the word to stop or change course.'
  );
}
