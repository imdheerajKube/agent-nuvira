/**
 * SingleShotAutoRunner — the shared single-shot auto-failover walk
 * (Nuvira-Router M0.2 Stage B).
 *
 * The auto router picks the best provider, but a provider's key/model can
 * still fail at generation time (quota exhausted → 429, deprecated model →
 * 404). This walks the ranked candidates and returns the first successful
 * response, so Auto routing NEVER crashes the CLI — it always answers from a
 * working provider.
 *
 * Behavior-identical extraction of ChatCommand.generateAutoWithFailover: same
 * candidate order, same per-attempt telemetry, same prompt-on-failover
 * semantics, same last-error throw. The caller supplies only what is
 * genuinely caller-specific:
 *   - route()        — how a route is resolved for this action (chat's
 *                      routeMessageAuto, plan's/execute's future equivalents)
 *   - generate()     — how a provider call is made (file-context assembly,
 *                      streaming, caching all stay at the call site)
 *   - recordFailure()— the shared failure bookkeeping (recordActionFailure)
 *
 * This file lives in the CLI layer (not src/learning) because the walk needs
 * CLI-layer plumbing (resolveProvider, the failover confirmation prompt) —
 * keeping src/learning free of CLI dependencies.
 */

import { resolveProvider } from './router.js';
import { getAutoRouter } from '../learning/auto-router.js';
import { resolveWorkingModel } from '../inference/model-validator.js';
import { recordRoutingDecision, type RoutingSource } from '../learning/routing-history.js';
import { shouldConfirmFailover, promptFailoverChoice } from './failover-prompt.js';
import type { ConfigManager } from '../config/manager.js';
import type { InferenceProvider } from '../inference/interface.js';
import { logger } from '../utils/logger.js';

/** A resolved auto route — the shape routeMessageAuto returns today. */
export interface AutoRoute {
  type: string;
  provider: InferenceProvider;
  model: string;
  ranked: string[];
  complexity: string;
  score: number;
}

export interface SingleShotAutoOptions {
  /** Action tag for telemetry + audit (chat / plan / execute / ...). */
  action: string;
  /** Task label for routing + audit history. */
  task: string;
  configManager: ConfigManager;
  /**
   * Resolve the route for this action, excluding already-attempted providers.
   * The caller owns session state + cold-start probing (chat's
   * routeMessageAuto); this walk only consumes the route.
   */
  route: (excludeProviders: string[]) => Promise<AutoRoute>;
  /**
   * Actually generate a response from a provider. The caller composes its own
   * prompt handling, streaming, caching, and success telemetry.
   */
  generate: (provider: InferenceProvider, providerType: string, model: string) => Promise<string>;
  /** Record a failed attempt (delegate to recordActionFailure). */
  recordFailure: (providerType: string, model: string | undefined, err: unknown) => void;
}

/**
 * Run the single-shot auto walk: route → try ranked candidates in order →
 * first success wins. Every failure is recorded through the caller's
 * recordFailure hook; the shared confirmation prompt may decline a silent
 * switch (routing.promptOnFailover + manual), in which case the original
 * error is rethrown. Throws the LAST error when every candidate fails.
 */
export async function runSingleShotAuto(opts: SingleShotAutoOptions): Promise<string> {
  const first = await opts.route([]);
  const attempted = new Set<string>();
  let lastError: unknown = new Error(`No auto-routed provider succeeded for: ${opts.task.slice(0, 80)}`);

  for (const candidateType of [first.type, ...first.ranked]) {
    if (attempted.has(candidateType)) continue;
    attempted.add(candidateType);
    // Hoisted so the failure write-through can attribute the exact model that
    // was attempted (registry telemetry needs provider × model).
    let candidateModel: string | undefined;
    try {
      const resolved = resolveProvider(opts.configManager, candidateType);
      if (!(await resolved.provider.isAvailable())) {
        logger.warn(`   ⚠️ ${candidateType} is not available — trying the next auto candidate...`);
        continue;
      }
      const desired = candidateType === first.type
        ? first.model
        : getAutoRouter().resolveModel(candidateType, opts.action, opts.configManager);
      // Model health: only use models that actually exist on the provider
      // (a pinned config.model can be deprecated → 404) — repair to live.
      const model = await resolveWorkingModel(resolved.provider, candidateType, desired);
      candidateModel = model;
      const result = await opts.generate(resolved.provider, resolved.type, model);
      if (candidateType !== first.type) {
        logger.success(`✅ Auto failover: answered from ${resolved.provider.name} (${model}) after ${first.type} failed`);
        // Keep the audit trail accurate: the initial route was recorded by the
        // caller's route(), but the actual answer came from this candidate.
        recordRoutingDecision({
          // RoutingSource is a closed union today (chat/orchestrator/...); the
          // action tag is the generic telemetry label, so it needs a cast until
          // the union is widened when execute/plan adopt this runner (P0 note).
          source: opts.action as RoutingSource,
          agentType: opts.action,
          task: opts.task,
          complexity: first.complexity,
          provider: candidateType,
          model,
          score: first.score,
        });
      }
      return result;
    } catch (err) {
      lastError = err;
      opts.recordFailure(candidateType, candidateModel, err);
      const msg = err instanceof Error ? err.message : String(err);
      // Opt-in confirmation (routing.promptOnFailover): when the user wants
      // control over failover, ask before auto-switching to the next
      // candidate. 'manual' surfaces the original error instead of silently
      // switching — single-shot has no interactive recovery, so the caller
      // surfaces the failure (matching non-auto behavior).
      const order = [first.type, ...first.ranked];
      const nextCandidate = order.find((c) => !attempted.has(c));
      // Only prompt when stdin is a TTY — in a CI/piped context an inquirer
      // prompt would block forever, so fall through to silent auto-failover
      // (the pre-existing safe behavior for non-interactive runs).
      if (nextCandidate && shouldConfirmFailover(opts.configManager.getAll()) && process.stdin.isTTY) {
        let nextProviderName = nextCandidate;
        try {
          nextProviderName = resolveProvider(opts.configManager, nextCandidate).provider.name;
        } catch {
          // Keep the raw type name if the provider can't resolve.
        }
        const nextModel = nextCandidate === first.type
          ? first.model
          : getAutoRouter().resolveModel(nextCandidate, opts.action, opts.configManager);
        const choice = await promptFailoverChoice(candidateType, nextProviderName, nextModel);
        if (choice === 'manual') throw lastError;
      }
      logger.warn(`   ⚠️ ${candidateType} failed (${msg.slice(0, 160)}) — trying the next auto candidate...`);
    }
  }

  throw lastError;
}
