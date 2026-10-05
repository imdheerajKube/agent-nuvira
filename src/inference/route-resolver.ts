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
      score: 0,
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
  }

  return { providerType, provider, model: served, requested, substituted };
}
