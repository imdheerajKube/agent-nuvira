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
import type { ConfigManager } from '../config/manager.js';
import type { InferenceProvider } from '../inference/interface.js';
/**
 * M2.3: the full key pool for a provider — primary `apiKey` + additional
 * `apiKeys`, de-duplicated, empty-safe. The failover runner rotates through
 * these before switching providers.
 */
export declare function getProviderKeys(configManager: ConfigManager, providerType: string): string[];
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
export declare function runSingleShotAuto(opts: SingleShotAutoOptions): Promise<string>;
//# sourceMappingURL=failover-runner.d.ts.map