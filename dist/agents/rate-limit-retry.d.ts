/**
 * Shared rate-limit-aware retry helpers for LLM-driven agents.
 *
 * Agents that call the LLM in a local retry loop (writer, reviewer,
 * context-gatherer, edit-module) must honor provider reset hints — a 429 that
 * says "try again in 18.2s" needs the FULL wait, not a fixed 1s/2s backoff.
 * Fixed backoff fires every attempt inside the reset window and the agent
 * dies on a transient TPM blip (the exact failure seen in eval: "Reviewer
 * failed after 3 API attempts" on an 18s Groq TPM reset).
 *
 * The long-wait path delegates to the orchestrator's `context.onRateLimit`
 * so the FULL automatic recovery applies (decision #26): silent wait for
 * transient hints, silent auto-switch to another provider for exhaustion and
 * storms, dashboard failover events, and the opt-in interactive prompt.
 */
import { parseRetryAfterHint } from '../learning/provider-fallback.js';
export { parseRetryAfterHint };
/** Base delay for exponential backoff (doubles each attempt: 5s, 10s, ...) */
export declare const BASE_RETRY_DELAY_MS = 5000;
/**
 * Rate-limit hints at/above this many ms are routed through the orchestrator's
 * onRateLimit callback (which may wait, switch provider, skip, or abort).
 * Shorter hints are handled by the local wait-and-retry path below — waiting
 * a sub-3s blip locally is cheaper than round-tripping the handler.
 */
export declare const LONG_WAIT_THRESHOLD_MS = 3000;
/** True when the error message indicates a rate-limit (429) error. */
export declare function isRateLimitError(errorMessage: string): boolean;
/** Best-effort model name from the error body (for the rate-limit prompt). */
export declare function parseModelName(errorMessage: string): string | undefined;
/**
 * Calculate the retry delay for a given attempt.
 * If the error message contains a "try again in Xs" / "Retry-After" hint, use
 * that exact delay; otherwise fall back to exponential backoff.
 */
export declare function calculateRetryDelay(attempt: number, errorMessage: string): number;
//# sourceMappingURL=rate-limit-retry.d.ts.map