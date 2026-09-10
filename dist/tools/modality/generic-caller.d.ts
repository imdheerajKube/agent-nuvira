/**
 * GenericCaller — handles API calls to modality providers.
 *
 * Instead of provider-specific code, this module:
 *   1. Uses provider's requestBuilder to construct the request
 *   2. Makes the API call with proper auth, timeouts, retries
 *   3. Uses provider's responseParser to parse the response
 *   4. Handles errors generically
 *
 * This allows adding new providers without writing new API calling code.
 */
import type { ModalityProvider, ModalityOptions, ModalityResponse } from './modality-catalog.js';
export declare class ModalityError extends Error {
    readonly providerId: string;
    readonly statusCode: number;
    readonly details: string;
    constructor(providerId: string, statusCode: number, details: string);
}
/**
 * Call a modality provider with generic API handling.
 *
 * Flow:
 *   1. Build request using provider's requestBuilder
 *   2. Resolve auth (API key from config or env)
 *   3. Make HTTP request with timeout
 *   4. Parse response using provider's responseParser
 *   5. Return standardized result
 */
export declare function callModalityProvider(provider: ModalityProvider, prompt: string, opts?: ModalityOptions, config?: Record<string, unknown>): Promise<ModalityResponse>;
/**
 * Call modality with failover across providers.
 *
 * Flow:
 *   1. Get all available providers for the modality
 *   2. Score each provider
 *   3. Try best provider first
 *   4. On failure, try next best
 *   5. Continue until success or all providers exhausted
 */
export declare function callModalityWithFailover(modality: string, prompt: string, opts?: ModalityOptions, config?: Record<string, unknown>): Promise<ModalityResponse & {
    provider: string;
}>;
//# sourceMappingURL=generic-caller.d.ts.map