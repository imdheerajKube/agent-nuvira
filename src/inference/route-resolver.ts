/**
 * Route resolution — the ONE place a provider and its model are validated as a
 * PAIR, against the very adapter that will serve the call.
 *
 * WHY THIS EXISTS (issue #9). A live release run failed its first model call
 * with `Groq API error (404): The model 'gemini-3.1-flash-lite' does not exist`
 * — a Gemini id sent to Groq, on a machine whose `nuviraconfig.json` pins
 * `providers.groq.model = openai/gpt-oss-120b` and `providers.gemini.model =
 * gemini-flash-latest`. Neither pin was stale, so the foreign id came from a
 * RESOLUTION: provider and model were decided in different places (provider
 * ranking, the auto-router's per-task decision, and a site-local
 * `config.model || inferenceOptions?.model` fallback), and nothing checked that
 * the three agreed.
 *
 * The same class had already been found twice and patched at one call site each
 * time — chat's failover path (`src/cli/chat.ts`) and catalog-provider
 * substitution (`src/cli/router.ts`) — which is why `publish` still walked into
 * it: the fix never reached a SHARED path. This module is that shared path.
 *
 * INVARIANTS
 * 1. The model is validated against `provider` — the instance the caller is
 *    about to call — never against a provider looked up separately.
 * 2. A substitution is NEVER silent: it is printed, and it is recorded (the
 *    routing history the dashboard reads, plus the active run trace when one
 *    exists). A broken pair that looks healthy is worse than no report at all.
 * 3. `strict` (or `NUVIRA_STRICT_MODEL=1`) refuses to substitute at all, so a
 *    pinned model that is dead fails with a sentence naming the pair instead of
 *    quietly running on a different model.
 *
 * It is deliberately thin: `resolveWorkingModel()` already owns the repair
 * policy (registry fast path → live list → catalog default) and is the only
 * place a model list is fetched. This wrapper adds the PAIR guarantee, the
 * audit, and the reporting — it must never grow a second repair policy.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { InferenceProvider } from './interface.js';
import { resolveWorkingModel } from './model-validator.js';
import { getDefaultModel } from './provider-catalog.js';
import { isMaxCapability } from '../config/capability-mode.js';
import { logger } from '../utils/logger.js';
import { recordRoutingDecision, type RoutingSource } from '../learning/routing-history.js';
import { recordTraceEvent } from '../learning/reasoning-trace.js';
import { getModelRegistry } from '../learning/model-registry.js';
import { identityKey, sameModel } from '../learning/model-identity.js';

/** Who is asking — used only for the audit record's wording. */
export type RouteSource = 'orchestrator' | 'chat' | 'publish' | 'failover' | 'cli' | (string & {});

export interface RouteRequest {
  /** Provider id (`groq`, `gemini`, …) — must describe `provider`. */
  providerType: string;
  /** The adapter that will serve the call. The model is validated against THIS. */
  provider: InferenceProvider;
  /** Requested model. `undefined` or `'default'` means "let the provider decide". */
  model?: string;
  source?: RouteSource;
  agentType?: string;
  task?: string;
  /**
   * Detected complexity, when the caller knows it (`trivial`…`critical`).
   * Omitted means `unknown`: this layer resolves a PAIR, it does not classify
   * the ask, and writing a guessed bucket into the audit trail would be a new
   * lie in place of the missing record.
   */
  complexity?: string;
  /** Refuse to substitute; throw instead. Defaults to `NUVIRA_STRICT_MODEL=1`. */
  strict?: boolean;
  /**
   * `max`-mode repair: when the requested model is only UNVERIFIED and no
   * verified model is as capable, prove the requested model with a bounded call
   * instead of silently substituting a weaker one. Defaults to the ambient
   * capability mode (env); callers with the config in hand pass it explicitly.
   */
  verifyOnDemand?: boolean;
}

export interface ResolvedRoute {
  providerType: string;
  provider: InferenceProvider;
  /** The model to send. Always a real model id when one could be resolved. */
  model: string;
  /** What was asked for, when anything was. */
  requested?: string;
  /** True when `model` differs from `requested`. */
  substituted: boolean;
}

/**
 * The same fact WITHOUT the adapter — the shape that can be fed to a model (see
 * `src/tools/loop-route-feed.ts`). A provider instance is not serializable and
 * must never leak into prompt text.
 */
export interface ServedRoute {
  providerType: string;
  /** The adapter's own display name (`Groq`, `Local (llama.cpp)`). */
  providerName?: string;
  model: string;
  requested?: string;
  substituted?: boolean;
  /** Earlier serving pairs this turn, oldest first — a failover history. */
  previous?: string[];
}

/** Strip a {@link ResolvedRoute} down to the feedable fact. */
export function servedRouteFrom(route: ResolvedRoute): ServedRoute {
  return {
    providerType: route.providerType,
    providerName: route.provider?.name,
    model: route.model,
    requested: route.requested,
    substituted: route.substituted,
  };
}

/**
 * Strict model mode — a dead pin FAILS instead of being substituted.
 *
 * Off by default: a release or a long agent run must not stop dead because one
 * provider retired a model. On for a caller who would rather know than proceed
 * (`NUVIRA_STRICT_MODEL=1`), because "it ran on something else" is exactly the
 * outcome that is invisible until much later.
 *
 * A TURN can also set it, not only the process. The dashboard chat's per-chat
 * "pin this model only" switch must outrank the process default for that one
 * turn without a global env mutation (two sessions run concurrently, so an
 * env write would leak across them). `withStrictModel` scopes the override to
 * the async turn, and everything that already asks `strictModelMode()` — route
 * resolution, the loop engine's candidate walk, chat's pinned fallback — obeys
 * it without change.
 */
const strictOverride = new AsyncLocalStorage<boolean>();

/** Run `fn` with strict model mode forced on/off for this async turn. */
export function withStrictModel<T>(strict: boolean, fn: () => T): T {
  return strictOverride.run(strict, fn);
}

export function strictModelMode(): boolean {
  const scoped = strictOverride.getStore();
  if (scoped !== undefined) return scoped;
  return process.env.NUVIRA_STRICT_MODEL === '1';
}

/**
 * Substitutions already reported in this process, keyed by `provider::requested→served`.
 *
 * A substitution is a property of the PAIR, not of the call: the router selects
 * the same dead model on every message, and one release pipeline can make
 * hundreds of calls. Reporting each one buried the transcript (a live chat run
 * printed the same repair twice for a single turn — once from the pinned repair,
 * once from the failover walk) and wrote the same routing-history row over and
 * over. Announced once per pair per process, then quiet.
 */
const reportedSubstitutions = new Set<string>();

/** Test hook: forget what has already been announced. */
export function resetSubstitutionReporting(): void {
  reportedSubstitutions.clear();
}

/**
 * Happy-path routes already audited in this process, keyed by
 * `providerType::model`.
 *
 * WHY THIS EXISTS. `reportSubstitution` below audits a pair that had to be
 * REPAIRED, so the ordinary resolution — the one every normal call uses —
 * recorded nothing at all. Measured: a 12-minute, 82-step chat turn on the
 * dashboard/`-t` path left ZERO routing-history rows, while the debug header
 * and the reasoning trace disagreed about which model had served it (header
 * `deepseek/deepseek-flash`, trace summary `groq`, `model explain`
 * `gemini/gemini-3.1-flash-lite`). "Which model actually served this turn?" is
 * the first question an operator asks of a model failure, and it was
 * unanswerable from the audit trail the dashboard reads.
 *
 * Deduped per pair per process, exactly like `reportedSubstitutions`: a route is
 * a property of the PAIR, not of the call, and one pipeline can resolve the same
 * pair hundreds of times. Recording each one would bury the history instead of
 * informing it.
 */
const reportedRoutes = new Set<string>();

/** Test hook: forget which happy-path routes have been audited. */
export function resetRouteAudit(): void {
  reportedRoutes.clear();
}

/** One line naming the pair that was substituted, for the console and the trace. */
export function substitutionLine(input: {
  providerType: string;
  requested: string;
  served: string;
}): string {
  return (
    `🔀 Model substituted: ${input.providerType}/${input.requested} → ${input.served} ` +
    `('${input.requested}' is not available on ${input.providerType})`
  );
}

/**
 * Report a substitution: print it, audit it, and attach it to the active run
 * trace when there is one. Best-effort throughout — reporting must never break
 * the call it is reporting on.
 */
export function reportSubstitution(input: {
  providerType: string;
  requested: string;
  served: string;
  source?: RouteSource;
  agentType?: string;
  task?: string;
}): void {
  const line = substitutionLine(input);
  const key = `${input.providerType}::${input.requested}->${input.served}`;

  // Say it ONCE. The audit entries below are deduped with the line (see
  // `reportedSubstitutions`) so the console, the dashboard history and the run
  // trace agree about how many substitutions happened.
  if (reportedSubstitutions.has(key)) return;
  reportedSubstitutions.add(key);

  logger.warn(line);

  try {
    const source: RoutingSource = input.source === 'chat' ? 'chat' : 'orchestrator';
    recordRoutingDecision({
      source,
      agentType: input.agentType || 'unknown',
      task: input.task || `model substituted on ${input.providerType}`,
      complexity: 'simple',
      provider: input.providerType,
      model: input.served,
      // B2-a — no score, because this layer never scored a candidate. `0` was
      // the old sentinel for that, and absence is the honest way to say it now
      // that the field is optional: a real ranking score of 0 and "never ranked"
      // must not share a value.
    });
  } catch {
    // Best-effort — audit is not allowed to break the call.
  }

  try {
    // No trace id: the trace module attaches this to the run in progress.
    recordTraceEvent(undefined, { kind: 'decision', summary: line, ok: true });
  } catch {
    // Best-effort.
  }
}

/**
 * A DEFINITIVE registry verdict for a pair, or `undefined` when there is none.
 *
 * "Definitive" is deliberately narrow (A2): only `unavailable` counts, which
 * `markUnavailable` and the `auth` / `credit-exhausted` telemetry branches set
 * when a REAL call established the pair does not work. It is NOT `unverified`:
 * that state means "nothing has ever been tried", and refusing those would forbid
 * exactly the pins that exist to prove a new model — the product's own doctrine
 * says "an unknown, not a failure" (see `model-reachability.ts`).
 */
function definitiveVerdict(
  providerType: string,
  model: string,
): { reason: string } | undefined {
  try {
    const entry = getModelRegistry().getEntry(providerType, model);
    if (entry?.status === 'unavailable') {
      return {
        reason:
          entry.lastError ||
          'a real call established this model does not work on that provider',
      };
    }
  } catch {
    // Best-effort — a registry read must never block a call.
  }
  return undefined;
}

/**
 * The same model, verified somewhere else (A1), or `undefined`.
 *
 * A1 LANDED (2026-10-07): identity is now answered by `learning/model-identity.ts`
 * — an EXACT comparison against a bare or `vendor/`-prefixed id, widened only by
 * the DECLARED alias table. That is what lets this answer its own motivating
 * case: the requested `deepseek/deepseek-v4.1-flash` (the run-D pin, proven dead
 * on `openrouter`) and the `verified` `deepseek-flash` are declared as one model,
 * so the refusal sentence can now say where the SAME model does work.
 *
 * Still never a family guess: no similarity, no prefix matching, no vendor
 * heuristics. An id in no declaration falls back to the bare-id rule, so an
 * unknown relationship reads as "no known equivalent" rather than as a wrong
 * suggestion — suggesting a "similar" model the user did not ask for is a worse
 * failure than suggesting nothing, because the pin exists precisely to name one.
 */
function verifiedEquivalent(model: string, excludeProvider: string): string | undefined {
  try {
    if (!identityKey(model)) return undefined;
    const match = getModelRegistry()
      .getAllUsablePairs()
      .find((p) => p.provider !== excludeProvider && sameModel(p.model, model));
    return match ? `${match.provider}/${match.model}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The refusal sentence for a STRICT pin to a pair the registry has already
 * proven dead, or `undefined` when the pin is worth attempting.
 *
 * WHY THIS IS EXPORTED. `resolveRoute` was the only thing that consulted the
 * reachability verdict, so every caller of it got the A2 pre-flight — and every
 * caller that resolved its own model did not. Measured (Run D): re-running the
 * strict pin after the fix showed BOTH behaviours in one log — the pipeline path
 * refused the pair before any network call (line 42), while the chat tool loop
 * still sent the request and got a raw 402 body back (line 2). One gate, one
 * sentinel. This is that gate's ONE implementation, so the chat tool loop and
 * `resolveRoute` cannot drift apart about what "this pin is dead" means.
 *
 * The CALLER owns the activation condition (both current callers only ask when
 * strict model mode is on), because the sentence below states that strict mode
 * forbids substitution — it would be a lie to print it on a non-strict turn.
 * The wording is stable on purpose: `error-repair.ts` classifies on
 * `strict model mode` / `forbids substituting` to refuse spending repair
 * attempts on a pin only the user can change.
 */
export function strictPinRefusal(
  providerType: string,
  requested: string | undefined,
): string | undefined {
  if (!requested || requested === 'default') return undefined;
  const verdict = definitiveVerdict(providerType, requested);
  if (!verdict) return undefined;
  const equivalent = verifiedEquivalent(requested, providerType);
  return (
    `Refusing to call ${providerType}/${requested} without trying it: ${verdict.reason}. ` +
    'Strict model mode is on and forbids substituting another model. ' +
    (equivalent
      ? `The same model is verified on '${equivalent}' — pin that instead.`
      : 'Pick a model this provider serves (`nuvira models`), or unset NUVIRA_STRICT_MODEL to let the router repair it.')
  );
}

/**
 * Resolve `{providerType, provider, model}` as ONE validated pair.
 *
 * Never throws for a missing/unreachable model (it resolves one); it throws ONLY
 * when strict mode is on and a requested model could not be honoured, which is
 * the one case where proceeding would be a lie about what ran.
 */
export async function resolveRoute(request: RouteRequest): Promise<ResolvedRoute> {
  const { provider, providerType } = request;
  const requested =
    request.model && request.model !== 'default' ? request.model : undefined;

  // ── A2 — A PIN TO A PROVEN-DEAD PAIR IS REFUSED BEFORE ANY NETWORK CALL ──
  // Measured (Run D): `-p openrouter -m deepseek/deepseek-v4.1-flash` was fired at
  // a provider account with no credits. The pin was accepted, the call went out,
  // and the operator learned the real cause from a raw 402 body — after a full
  // round trip. Strict mode is the case that matters: substitution is forbidden
  // anyway, so the run is GUARANTEED to fail, and the only open question is
  // whether it fails fast with the reason or slowly with a provider error.
  if (request.strict ?? strictModelMode()) {
    const refusal = strictPinRefusal(providerType, requested);
    if (refusal) throw new Error(refusal);
  }

  let served = '';
  try {
    served = await resolveWorkingModel(
      provider,
      providerType,
      request.model,
      false,
      request.verifyOnDemand ?? isMaxCapability(),
    );
  } catch {
    // The validator is best-effort by contract; if it throws, a real model id is
    // still better than the 'default' sentinel reaching the API.
    served = requested || '';
  }
  if (!served || served === 'default') {
    served = requested || getDefaultModel(providerType) || '';
  }

  const substituted = !!requested && served !== requested;

  if (substituted) {
    if (request.strict ?? strictModelMode()) {
      throw new Error(
        `Model '${requested}' is not available on '${providerType}', and strict model mode ` +
          'forbids substituting another model. Pick a model this provider serves ' +
          '(`nuvira models`), or unset NUVIRA_STRICT_MODEL to let the router repair it.',
      );
    }
    reportSubstitution({
      providerType,
      requested: requested!,
      served,
      source: request.source,
      agentType: request.agentType,
      task: request.task,
    });
  } else {
    // ── HAPPY PATH — audit it (see `reportedRoutes`) ───────────────────────
    // The normal resolution used to record NOTHING, so a run that never
    // substituted left no trace of which model served it. Same row shape the
    // substitution path writes, so the two can never disagree about the model.
    // `score` is OMITTED because this layer never scored a candidate — a
    // fabricated score would read as a real ranking decision in `model explain
    // --since`, and B2-a makes "never ranked" sayable instead of encoding it as
    // a 0 that could equally be a genuine score.
    const pair = `${providerType}::${served}`;
    if (served && !reportedRoutes.has(pair)) {
      reportedRoutes.add(pair);
      try {
        const source: RoutingSource = request.source === 'chat' ? 'chat' : 'orchestrator';
        recordRoutingDecision({
          source,
          agentType: request.agentType || 'unknown',
          task: request.task || `route resolved on ${providerType}`,
          complexity: request.complexity || 'unknown',
          provider: providerType,
          model: served,
          // B2-a — see the note above: never ranked, so no score.
        });
      } catch {
        // Best-effort — audit is not allowed to break the call.
      }
    }
  }

  return { providerType, provider, model: served, requested, substituted };
}
