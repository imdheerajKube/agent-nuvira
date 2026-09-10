/**
 * ModalityCatalog — data-driven provider definitions for modality tools.
 *
 * This is the modality equivalent of `provider-catalog.ts` for LLMs.
 * Instead of hardcoding providers in tool-router.ts, we define them as data
 * objects that can be extended via config without code changes.
 *
 * Design principles:
 *   1. Data over code — providers are data objects, not if/else blocks
 *   2. User-configurable — add providers via config, no code changes
 *   3. Generic API caller — uses requestBuilder + responseParser
 *   4. Consistent scoring — same pattern as LLM routing
 *
 * Usage:
 *   const providers = getModalityProviders('image');
 *   const best = selectBestModalityProvider(providers, context);
 *   const result = await callModalityProvider(best, prompt, opts);
 */
export type ModalityType = 'image' | 'tts' | 'video' | 'transcription';
export type ApiType = 'openai' | 'rest' | 'grpc' | 'local' | 'pollinations';
export interface ModalityProvider {
    /** Unique provider identifier (e.g., 'dalle', 'pollinations'). */
    id: string;
    /** Human-readable name (e.g., 'DALL-E 3'). */
    name: string;
    /** Which modality this provider serves. */
    modality: ModalityType;
    /** API type determines how to call the provider. */
    apiType: ApiType;
    /** Base URL for API calls. */
    baseUrl: string;
    /** Environment variable for API key (undefined for keyless). */
    envVar?: string;
    /** Custom headers to include in API calls. */
    headers?: Record<string, string>;
    /** Endpoint path (appended to baseUrl). Default depends on modality. */
    endpoint?: string;
    /** Cost per unit (image=per image, tts=per 1K chars, video=per second). */
    costPerUnit: number;
    /** Quality score 0-1 (higher = better). */
    quality: number;
    /** Speed score 0-1 (higher = faster). */
    speed: number;
    /** Available models for this provider. */
    models: string[];
    /** Default model to use if none specified. */
    defaultModel?: string;
    /** Timeout in milliseconds. */
    timeoutMs?: number;
    /** Whether this provider is currently available (has API key). */
    available: boolean;
    /** Build the API request body from prompt and options. */
    requestBuilder: (prompt: string, opts: ModalityOptions) => Record<string, unknown>;
    /** Parse the API response into a standardized result. */
    responseParser: (data: unknown) => ModalityResponse;
}
export interface ModalityOptions {
    width?: number;
    height?: number;
    duration?: number;
    resolution?: string;
    voice?: string;
    language?: string;
    model?: string;
    cwd?: string;
}
export interface ModalityResponse {
    /** Whether the operation succeeded. */
    ok: boolean;
    /** Output data (buffer for image/audio, URL for video). */
    data?: Buffer | string;
    /** Output file path (if saved to disk). */
    file?: string;
    /** Text output (for transcription). */
    text?: string;
    /** Error message if failed. */
    error?: string;
    /** Duration in milliseconds. */
    durationMs: number;
}
/**
 * Get all providers for a modality (built-in + user-configured).
 */
export declare function getModalityProviders(modality: ModalityType): ModalityProvider[];
/**
 * Get all available providers for a modality (has API key or is keyless).
 */
export declare function getAvailableModalityProviders(modality: ModalityType): ModalityProvider[];
/**
 * Get a specific provider by ID.
 */
export declare function getModalityProvider(id: string): ModalityProvider | undefined;
/**
 * Add a user-configured provider.
 * Called when user sets config like:
 *   nuvira config set modality.image.replicate.apiKey=xxxxx
 */
export declare function addModalityProvider(provider: ModalityProvider): void;
/**
 * Remove a user-configured provider.
 */
export declare function removeModalityProvider(id: string): boolean;
/**
 * Load user-configured providers from config.
 */
export declare function loadUserConfiguredProviders(config: Record<string, unknown>): void;
/**
 * Score a modality provider for routing.
 */
export declare function scoreModalityProvider(provider: ModalityProvider, context?: {
    maxCost?: number;
    priorityQuality?: boolean;
    prioritySpeed?: boolean;
}): number;
/**
 * Select the best modality provider for a task.
 */
export declare function selectBestModalityProvider(modality: ModalityType, context?: {
    maxCost?: number;
    priorityQuality?: boolean;
    prioritySpeed?: boolean;
}): ModalityProvider | null;
/**
 * Get status of all modality providers (for dashboard display).
 */
export declare function getModalityProviderStatus(): Record<ModalityType, Array<{
    id: string;
    name: string;
    available: boolean;
    costPerUnit: number;
    quality: number;
    speed: number;
}>>;
//# sourceMappingURL=modality-catalog.d.ts.map