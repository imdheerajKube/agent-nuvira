/**
 * Tool-Router — Intelligent routing for modality tools (image/audio/video).
 *
 * This is the adaptive version that uses:
 *   1. ModalityCatalog — data-driven provider definitions
 *   2. GenericCaller — handles API calls with provider-specific parsers
 *   3. Consistent scoring — same pattern as LLM routing
 *
 * Users can add new providers via config:
 *   nuvira config set modality.image.replicate.apiKey=r8_xxxxx
 *   nuvira config set modality.image.replicate.baseUrl=https://api.replicate.com/v1
 *
 * No code changes required — just config.
 *
 * Usage:
 *   const result = await routeImageGeneration('a cat', { width: 1024, height: 1024 });
 *   const result = await routeTTS('Hello world');
 *   const result = await routeVideoGeneration('A cat walking');
 */
import { type ModalityType, type ModalityProvider, type ModalityOptions, type ModalityResponse } from './modality-catalog.js';
export { getModalityProviderStatus } from './modality-catalog.js';
/**
 * Initialize the tool router with user config.
 * Call this once at startup to load user-configured providers.
 */
export declare function initToolRouter(config: Record<string, unknown>): void;
export interface ImageGenRouteOptions extends ModalityOptions {
    width?: number;
    height?: number;
    cwd?: string;
}
/**
 * Route image generation to the best available backend with failover.
 */
export declare function routeImageGeneration(prompt: string, opts?: ImageGenRouteOptions, config?: Record<string, unknown>): Promise<ModalityResponse & {
    backend: string;
}>;
/**
 * Route TTS to the best available backend with failover.
 */
export declare function routeTTS(text: string, opts?: {
    voice?: string;
    model?: string;
    cwd?: string;
}, config?: Record<string, unknown>): Promise<ModalityResponse & {
    backend: string;
}>;
/**
 * Route video generation to the best available backend with failover.
 */
export declare function routeVideoGeneration(prompt: string, opts?: {
    duration?: number;
    resolution?: string;
    cwd?: string;
}, config?: Record<string, unknown>): Promise<ModalityResponse & {
    backend: string;
}>;
/**
 * Route transcription to the best available backend with failover.
 */
export declare function routeTranscription(audioPath: string, opts?: {
    language?: string;
    cwd?: string;
}, config?: Record<string, unknown>): Promise<ModalityResponse & {
    text?: string;
    backend: string;
}>;
/**
 * Add a custom provider at runtime.
 * Useful for testing or dynamic provider registration.
 */
export declare function addCustomProvider(provider: ModalityProvider): void;
/**
 * Get all providers for a modality (for display in dashboard).
 */
export declare function getAllProviders(modality: ModalityType): ModalityProvider[];
/**
 * Get available providers for a modality.
 */
export declare function getAvailableProviders(modality: ModalityType): ModalityProvider[];
//# sourceMappingURL=tool-router.d.ts.map