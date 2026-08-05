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
import { classifyFallbackError } from '../learning/provider-fallback.js';
import { getQuotaLedger, accountIdForKey } from '../learning/quota-ledger.js';
import type { ConfigManager } from '../config/manager.js';
import type { InferenceProvider } from '../inference/interface.js';
import { logger } from '../utils/logger.js';

/**
 * M2.3: the full key pool for a provider — primary `apiKey` + additional
 * `apiKeys`, de-duplicated, empty-safe. The failover runner rotates through
 * these before switching providers.
 */
export function getProviderKeys(configManager: ConfigManager, providerType: string): string[] {
  try {
    const { config } = configManager.getProviderConfig(providerType);
    const keys = [config.apiKey, ...(config.apiKeys || [])].filter(
      (k): k is string => typeof k === 'string' && k.length > 0,
    );
    return [...new Set(keys)];
  } catch {
    return [];
  }
}

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
   * `apiKey` (M2.3) overrides the provider's configured key for this attempt
   * (key rotation) — thread it into the call's InferenceOptions so the
   * adapter sends the rotated account's credentials.
   */
  generate: (provider: InferenceProvider, providerType: string, model: string, apiKey?: string) => Promise<string>;
  /**
   * Record a failed attempt (delegate to recordActionFailure). `apiKey`
   * (M2.3) lets the bookkeeping park the SPECIFIC dead account so rotation
   * skips it while other keys of the same provider stay usable.
   */
  recordFailure: (providerType: string, model: string | undefined, err: unknown, apiKey?: string) => void;
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
    let resolvedProviderName = candidateType;
    let resolvedProvider: InferenceProvider | undefined;

    // ── Resolve + availability + model repair (provider-level, no key) ─────
    try {
      const resolved = resolveProvider(opts.configManager, candidateType);
      if (!(await resolved.provider.isAvailable())) {
        logger.warn(`   ⚠️ ${candidateType} is not available — trying the next auto candidate...`);
        continue;
      }
      resolvedProviderName = resolved.provider.name;
      const desired = candidateType === first.type
        ? first.model
        : getAutoRouter().resolveModel(candidateType, opts.action, opts.configManager);
      // Model health: only use models that actually exist on the provider
      // (a pinned config.model can be deprecated → 404) — repair to live.
      const model = await resolveWorkingModel(resolved.provider, candidateType, desired);
      candidateModel = model;
      resolvedProvider = resolved.provider;
    } catch (err) {
      lastError = err;
      opts.recordFailure(candidateType, candidateModel, err);
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`   ⚠️ ${candidateType} failed to initialize (${msg.slice(0, 120)}) — trying the next auto candidate...`);
      continue;
    }

    // ── M2.3: multi-account key rotation ────────────────────────────────
    // Try every non-parked key of THIS provider before switching providers.
    // A rate-limit/auth failure parks the specific account (fingerprint) so
    // the next run skips that key predictively while other keys stay usable.
    const ledger = getQuotaLedger();
    const keys = getProviderKeys(opts.configManager, candidateType);
    const usableKeys = keys.filter((k) => !ledger.isAccountParked(candidateType, accountIdForKey(k)));
    const keyAttempts: Array<string | undefined> = usableKeys.length > 0 ? usableKeys : [undefined];
    let providerErr: unknown = lastError;

    for (const key of keyAttempts) {
      const keyLabel = key ? `key#${usableKeys.indexOf(key) + 1}` : '';
      try {
        const result = await opts.generate(resolvedProvider!, candidateType, candidateModel!, key);
        if (candidateType !== first.type) {
          logger.success(`✅ Auto failover: answered from ${resolvedProviderName} (${candidateModel}) after ${first.type} failed`);
          // Keep the audit trail accurate: the initial route was recorded by
          // the caller's route(), but the actual answer came from this
          // candidate.
          recordRoutingDecision({
            // RoutingSource is a closed union today (chat/orchestrator/...);
            // the action tag is the generic telemetry label, so it needs a
            // cast until the union is widened (P0 note).
            source: opts.action as RoutingSource,
            agentType: opts.action,
            task: opts.task,
            complexity: first.complexity,
            provider: candidateType,
            model: candidateModel!,
            score: first.score,
          });
        } else if (key && keyAttempts.length > 1) {
          // Primary provider answered — but only after key rotation.
          logger.success(`🔑 ${candidateType} answered via ${keyLabel} after the primary key failed`);
        }
        return result;
      } catch (err) {
        providerErr = err;
        opts.recordFailure(candidateType, candidateModel, err, key);
        const msg = err instanceof Error ? err.message : String(err);
        if (key) {
          // Park the dead ACCOUNT (not just the provider) so rotation skips
          // it on the next run while other keys of the same provider remain
          // eligible. Best-effort — never break the walk.
          const kind = classifyFallbackError(err);
          if (kind === 'rate-limit' || kind === 'auth') {
            // Fixed 1h/24h FLOOR for the in-walk park: recordActionFailure
            // (via recordFailure) parks the account with the configured
            // routing.quota.windowMs, and Math.max below lets the longer
            // window win — so a config-aware window always takes precedence
            // while a missing/zero window still gets a sane default.
            const parkUntil = Date.now() + (kind === 'rate-limit' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000);
            try {
              ledger.parkAccount(candidateType, accountIdForKey(key), parkUntil, kind);
            } catch {
              // Best-effort.
            }
          }
          if (usableKeys.length > 1) {
            logger.warn(`   🔑 ${candidateType} ${keyLabel} failed (${msg.slice(0, 100)}) — rotating to the next key...`);
            continue;
          }
        }
        break; // keyless provider or last key — move to the next candidate
      }
    }

    // ── Provider exhausted: prompt-on-failover + move on ────────────────
    lastError = providerErr;
    const msg = providerErr instanceof Error ? providerErr.message : String(providerErr);
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

  throw lastError;
}
