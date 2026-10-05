/**
 * Shared AGENTIC ROUTE GATE (Workstream B).
 *
 * The router records a capability verdict on every decision
 * (`AutoRouteResult.agenticCapable`, Workstream A1), but nothing VERIFIES the
 * final pair against the task on every turn — and the only user-visible warning
 * used to fire in the orchestrator for `provider === 'local' && score < 0.5`,
 * not in chat and not for a weak cloud model. This module is the single gate
 * every surface (chat, orchestrator, dashboard) calls after routing.
 *
 * The governing rule (user's requirement, 2026-10-05): **never a silent weak
 * model for an agentic task.** The explicit per-session ASK is the primary
 * mechanism on interactive surfaces; a persistent `routing.weakModelPolicy`
 * exists ONLY as a fallback for surfaces where no one can answer (gateway
 * channels, headless/CI), so a turn can never hang on a consent prompt.
 *
 * This module deliberately holds NO I/O. It returns a typed verdict; the caller
 * decides how to ask the user, whether to retry on a stronger model, or to
 * abort — so the same logic is testable without a provider or a terminal.
 */

import { isAgenticTask, type AutoRouteResult } from './auto-router.js';
import type { ComplexityLevel } from './hybrid-router.js';
import type { TaskProfile } from './auto-router.js';

/** How weak-model use is resolved when no ask is possible (non-interactive). */
export type WeakModelPolicy = 'ask' | 'auto-allow' | 'deny';

/** The default: ask, one consent per session. */
export const DEFAULT_WEAK_MODEL_POLICY: WeakModelPolicy = 'ask';

/** The env var that overrides the config (matches repo BUFF_* alias convention). */
export const WEAK_MODEL_POLICY_ENV = 'NUVIRA_WEAK_MODEL_POLICY';
export const WEAK_MODEL_POLICY_ENV_LEGACY = 'BUFF_WEAK_MODEL_POLICY';

export function parseWeakModelPolicy(value: unknown): WeakModelPolicy | undefined {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'ask') return 'ask';
  if (v === 'auto-allow' || v === 'autoallow' || v === 'allow' || v === 'yes') return 'auto-allow';
  if (v === 'deny' || v === 'no') return 'deny';
  return undefined;
}

/** Shallow ConfigManager shape this module needs (kept structural for tests). */
interface ConfigLike {
  getAll?: () => { routing?: { weakModelPolicy?: unknown } } | undefined;
}

/**
 * Resolve the NON-INTERACTIVE fallback policy: env (`NUVIRA_WEAK_MODEL_POLICY`,
 * then `BUFF_WEAK_MODEL_POLICY`), then `routing.weakModelPolicy`, then `'ask'`.
 * Unknown values fall through to the default rather than throwing.
 */
export function resolveWeakModelPolicy(configManager?: ConfigLike): WeakModelPolicy {
  const fromEnv =
    parseWeakModelPolicy(process.env[WEAK_MODEL_POLICY_ENV]) ??
    parseWeakModelPolicy(process.env[WEAK_MODEL_POLICY_ENV_LEGACY]);
  if (fromEnv) return fromEnv;
  try {
    const routing = configManager?.getAll?.()?.routing;
    const fromCfg = parseWeakModelPolicy(routing?.weakModelPolicy);
    if (fromCfg) return fromCfg;
  } catch {
    // Best-effort — a config read must never break a turn.
  }
  return DEFAULT_WEAK_MODEL_POLICY;
}

/** A recorded consent for one session (in-memory; resets with the process). */
export type WeakModelConsent = 'granted' | 'denied';

const consentBySession = new Map<string, WeakModelConsent>();

export function getWeakModelConsent(sessionId: string): WeakModelConsent | undefined {
  return consentBySession.get(sessionId);
}

export function setWeakModelConsent(sessionId: string, consent: WeakModelConsent): void {
  consentBySession.set(sessionId, consent);
}

/**
 * Clear consent. With no argument, clears ALL sessions (test reset). With a
 * session id, clears just that one — called when a session ends, so a new
 * chat/task starts from `unset` and asks again.
 */
export function resetWeakModelConsent(sessionId?: string): void {
  if (sessionId === undefined) consentBySession.clear();
  else consentBySession.delete(sessionId);
}

/** What the caller should do after an agentic route landed on a weak model. */
export type AgenticGateAction =
  /** Not an agentic ask, or the model is capable — proceed. */
  | 'proceed'
  /** Weak model, but consent/policy allows it for this session — proceed. */
  | 'proceed-weak-consented'
  /** Ask the user once for this session (interactive, consent unset). */
  | 'ask'
  /** User/policy said no: retry on a strong model or abort honestly. */
  | 'retry-strong';

/** The typed verdict returned by `assertAgenticRoute`. */
export interface AgenticGateVerdict {
  /** Is this task agentic (needs a model that can hold a tool loop)? */
  agentic: boolean;
  /** Does the FINAL routed pair pass the shared capability predicate? */
  capable: boolean;
  /** Agentic ask that landed on a non-capable model — the case we gate. */
  weak: boolean;
  /** What the caller should do. */
  action: AgenticGateAction;
  /** One honest sentence for the console/trace, or null when nothing to say. */
  notice: string | null;
}

/**
 * The single weak-model wording used by the console (chat), the orchestrator
 * and the dashboard — so the same phrasing can be asserted in one test.
 */
export function weakRouteNotice(
  decision: Pick<AutoRouteResult, 'provider' | 'model'>,
  agenticTask: boolean,
): string | null {
  if (!agenticTask) return null;
  return (
    `⚠️ This is a software/agentic task, but routing landed on a weak model ` +
    `(${decision.provider}/${decision.model}). It may fabricate results or fail ` +
    `mid-task — prefer a stronger model.`
  );
}

export interface AssertAgenticRouteOptions {
  /** Session id whose consent applies (absent → treated as unset). */
  sessionId?: string;
  /** Resolved fallback policy. Defaults to `'ask'`. */
  policy?: WeakModelPolicy;
  /**
   * Can the user actually answer a prompt on this surface? Default true.
   * When false, an unset consent never yields `'ask'` — it falls to the policy
   * (`auto-allow` → proceed; anything else → `retry-strong`), so a gateway turn
   * can never hang.
   */
  interactive?: boolean;
  /** The already-recorded verdict (if omitted, computed by the shared rule). */
  agentic?: boolean;
}

/**
 * The one post-route gate. Pure: reads the decision and the session-consent
 * map, returns a verdict. Never swaps the model itself — a pinned model is the
 * user's explicit choice, so the caller only ever asks, retries, or aborts.
 */
export function assertAgenticRoute(
  decision: Pick<AutoRouteResult, 'complexity' | 'taskProfile' | 'provider' | 'model' | 'agenticCapable'>,
  options: AssertAgenticRouteOptions = {},
): AgenticGateVerdict {
  const agentic =
    options.agentic ??
    isAgenticTask(
      decision.complexity as ComplexityLevel,
      decision.taskProfile as Pick<TaskProfile, 'intent' | 'requiresVerification'>,
    );
  const capable = decision.agenticCapable;
  const weak = agentic && !capable;

  if (!weak) {
    return { agentic, capable, weak: false, action: 'proceed', notice: null };
  }

  const notice = weakRouteNotice(decision, agentic);
  const interactive = options.interactive ?? true;
  const policy = options.policy ?? DEFAULT_WEAK_MODEL_POLICY;

  // An explicit session consent (granted/denied) always wins on an interactive
  // surface — the user already answered for this session.
  const consent = options.sessionId ? getWeakModelConsent(options.sessionId) : undefined;
  if (interactive && consent === 'granted') {
    return { agentic, capable, weak, action: 'proceed-weak-consented', notice };
  }
  if (interactive && consent === 'denied') {
    return { agentic, capable, weak, action: 'retry-strong', notice };
  }

  // No recorded consent. On an interactive surface the DEFAULT is to ASK, even
  // if the fallback policy is something else — the ask is the primary
  // mechanism; the policy only governs surfaces that cannot ask.
  if (interactive && policy === 'ask') {
    return { agentic, capable, weak, action: 'ask', notice };
  }

  // Non-interactive (or an explicit non-ask policy): resolve without asking.
  const resolved: WeakModelPolicy = interactive ? policy : policy === 'ask' ? 'deny' : policy;
  if (resolved === 'auto-allow') {
    return { agentic, capable, weak, action: 'proceed-weak-consented', notice };
  }
  return { agentic, capable, weak, action: 'retry-strong', notice };
}
