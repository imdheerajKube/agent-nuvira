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
import { getModalityProviders, getAvailableModalityProviders, loadUserConfiguredProviders, } from './modality-catalog.js';
import { callModalityWithFailover } from './generic-caller.js';
// ─── Re-exports ─────────────────────────────────────────────────────────────
export { getModalityProviderStatus } from './modality-catalog.js';
// ─── Configuration ──────────────────────────────────────────────────────────
/**
 * Initialize the tool router with user config.
 * Call this once at startup to load user-configured providers.
 */
export function initToolRouter(config) {
    loadUserConfiguredProviders(config);
}
/**
 * Route image generation to the best available backend with failover.
 */
export async function routeImageGeneration(prompt, opts = {}, config) {
    const result = await callModalityWithFailover('image', prompt, opts, config);
    return { ...result, backend: result.provider };
}
// ─── TTS ────────────────────────────────────────────────────────────────────
/**
 * Route TTS to the best available backend with failover.
 */
export async function routeTTS(text, opts = {}, config) {
    const result = await callModalityWithFailover('tts', text, opts, config);
    return { ...result, backend: result.provider };
}
// ─── Video Generation ──────────────────────────────────────────────────────
/**
 * Route video generation to the best available backend with failover.
 */
export async function routeVideoGeneration(prompt, opts = {}, config) {
    const result = await callModalityWithFailover('video', prompt, opts, config);
    return { ...result, backend: result.provider };
}
// ─── Transcription ──────────────────────────────────────────────────────────
/**
 * Route transcription to the best available backend with failover.
 */
export async function routeTranscription(audioPath, opts = {}, config) {
    const result = await callModalityWithFailover('transcription', audioPath, opts, config);
    return { ...result, backend: result.provider };
}
// ─── Provider Management ────────────────────────────────────────────────────
/**
 * Add a custom provider at runtime.
 * Useful for testing or dynamic provider registration.
 */
export function addCustomProvider(provider) {
    const { addModalityProvider } = require('./modality-catalog.js');
    addModalityProvider(provider);
}
/**
 * Get all providers for a modality (for display in dashboard).
 */
export function getAllProviders(modality) {
    return getModalityProviders(modality);
}
/**
 * Get available providers for a modality.
 */
export function getAvailableProviders(modality) {
    return getAvailableModalityProviders(modality);
}
//# sourceMappingURL=tool-router.js.map