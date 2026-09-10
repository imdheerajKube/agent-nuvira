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
import { logger } from '../../utils/logger.js';
import { envBuff } from '../../config/paths.js';
// ─── Built-in Providers ─────────────────────────────────────────────────────
/**
 * Built-in image generation providers.
 */
const IMAGE_PROVIDERS = [
    {
        id: 'pollinations',
        name: 'Pollinations.ai (Free)',
        modality: 'image',
        apiType: 'pollinations',
        baseUrl: 'https://image.pollinations.ai/prompt',
        costPerUnit: 0,
        quality: 0.7,
        speed: 0.5,
        models: ['stable-diffusion'],
        available: true, // Always available (no key needed)
        timeoutMs: 30000,
        requestBuilder: (prompt, opts) => ({
            prompt,
            width: opts.width ?? 1024,
            height: opts.height ?? 1024,
        }),
        responseParser: (data) => ({
            ok: true,
            data: data.buffer,
            durationMs: data.durationMs || 0,
        }),
    },
    {
        id: 'dalle',
        name: 'DALL-E 3 (OpenAI)',
        modality: 'image',
        apiType: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        envVar: 'OPENAI_API_KEY',
        endpoint: '/images/generations',
        costPerUnit: 0.04, // ~$0.04 per image
        quality: 0.95,
        speed: 0.6,
        models: ['dall-e-3', 'dall-e-2'],
        defaultModel: 'dall-e-3',
        available: !!process.env.OPENAI_API_KEY,
        timeoutMs: 60000,
        requestBuilder: (prompt, opts) => ({
            model: opts.model || 'dall-e-3',
            prompt,
            n: 1,
            size: `${opts.width ?? 1024}x${opts.height ?? 1024}`,
        }),
        responseParser: (data) => ({
            ok: true,
            data: data.data?.[0]?.url,
            durationMs: data.durationMs || 0,
        }),
    },
    {
        id: 'stability',
        name: 'Stable Diffusion (Stability AI)',
        modality: 'image',
        apiType: 'rest',
        baseUrl: 'https://api.stability.ai/v1',
        envVar: 'STABILITY_API_KEY',
        endpoint: '/generation/stable-diffusion-xl/text-to-image',
        costPerUnit: 0.002, // ~$0.002 per generation
        quality: 0.85,
        speed: 0.7,
        models: ['stable-diffusion-xl-1024-v1-0'],
        defaultModel: 'stable-diffusion-xl-1024-v1-0',
        available: !!process.env.STABILITY_API_KEY,
        timeoutMs: 30000,
        requestBuilder: (prompt, opts) => ({
            text_prompts: [{ text: prompt }],
            cfg_scale: 7,
            height: opts.height ?? 1024,
            width: opts.width ?? 1024,
        }),
        responseParser: (data) => ({
            ok: true,
            data: Buffer.from(data.artifacts?.[0]?.base64 || '', 'base64'),
            durationMs: data.durationMs || 0,
        }),
    },
    {
        id: 'comfyui',
        name: 'Local ComfyUI / Stable Diffusion',
        modality: 'image',
        apiType: 'local',
        baseUrl: envBuff('IMAGE_API_URL') || 'http://localhost:7860',
        costPerUnit: 0,
        quality: 0.9,
        speed: 0.8,
        models: ['local'],
        available: !!envBuff('IMAGE_API_URL'),
        timeoutMs: 30000,
        requestBuilder: (prompt, opts) => ({
            prompt,
            width: opts.width ?? 1024,
            height: opts.height ?? 1024,
        }),
        responseParser: (data) => ({
            ok: true,
            data: data.buffer,
            durationMs: data.durationMs || 0,
        }),
    },
];
/**
 * Built-in TTS providers.
 */
const TTS_PROVIDERS = [
    {
        id: 'openai-tts',
        name: 'OpenAI TTS',
        modality: 'tts',
        apiType: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        envVar: 'OPENAI_API_KEY',
        endpoint: '/audio/speech',
        costPerUnit: 0.000015, // ~$15 per 1M chars
        quality: 0.9,
        speed: 0.8,
        models: ['tts-1', 'tts-1-hd'],
        defaultModel: 'tts-1',
        available: !!process.env.OPENAI_API_KEY,
        timeoutMs: 30000,
        requestBuilder: (prompt, opts) => ({
            model: opts.model || 'tts-1',
            input: prompt,
            voice: opts.voice || 'alloy',
        }),
        responseParser: (data) => ({
            ok: true,
            data: data.buffer,
            durationMs: data.durationMs || 0,
        }),
    },
    {
        id: 'elevenlabs',
        name: 'ElevenLabs',
        modality: 'tts',
        apiType: 'rest',
        baseUrl: 'https://api.elevenlabs.io/v1',
        envVar: 'ELEVENLABS_API_KEY',
        endpoint: '/text-to-speech/21m00Tcm4TlvDq8ikWAM',
        costPerUnit: 0.000030, // ~$30 per 1M chars
        quality: 0.95,
        speed: 0.7,
        models: ['eleven_monolingual_v1', 'eleven_multilingual_v1'],
        defaultModel: 'eleven_monolingual_v1',
        available: !!process.env.ELEVENLABS_API_KEY,
        timeoutMs: 30000,
        requestBuilder: (prompt, opts) => ({
            text: prompt,
            model_id: opts.model || 'eleven_monolingual_v1',
        }),
        responseParser: (data) => ({
            ok: true,
            data: data.buffer,
            durationMs: data.durationMs || 0,
        }),
    },
];
/**
 * Built-in video generation providers.
 */
const VIDEO_PROVIDERS = [
    {
        id: 'fal',
        name: 'FAL AI',
        modality: 'video',
        apiType: 'rest',
        baseUrl: 'https://fal.run',
        envVar: 'FAL_KEY',
        endpoint: '/fal-ai/flux/video',
        costPerUnit: 0.05, // ~$0.05 per video
        quality: 0.85,
        speed: 0.6,
        models: ['fal-ai/flux/video'],
        defaultModel: 'fal-ai/flux/video',
        available: !!process.env.FAL_KEY,
        timeoutMs: 120000,
        requestBuilder: (prompt, opts) => ({
            prompt,
            duration: opts.duration ?? 4,
            aspect_ratio: '16:9',
        }),
        responseParser: (data) => ({
            ok: true,
            data: data.video_url,
            durationMs: data.durationMs || 0,
        }),
    },
    {
        id: 'runway',
        name: 'Runway ML',
        modality: 'video',
        apiType: 'rest',
        baseUrl: 'https://api.runwayml.com/v1',
        envVar: 'RUNWAY_API_KEY',
        endpoint: '/generation',
        costPerUnit: 0.10, // ~$0.10 per video
        quality: 0.95,
        speed: 0.5,
        models: ['gen-3'],
        defaultModel: 'gen-3',
        available: !!process.env.RUNWAY_API_KEY,
        timeoutMs: 180000,
        requestBuilder: (prompt, opts) => ({
            prompt,
            duration: opts.duration ?? 4,
            resolution: opts.resolution ?? '720p',
        }),
        responseParser: (data) => ({
            ok: true,
            data: data.video_url,
            durationMs: data.durationMs || 0,
        }),
    },
];
/**
 * Built-in transcription providers.
 */
const TRANSCRIPTION_PROVIDERS = [
    {
        id: 'openai-whisper',
        name: 'OpenAI Whisper API',
        modality: 'transcription',
        apiType: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        envVar: 'OPENAI_API_KEY',
        endpoint: '/audio/transcriptions',
        costPerUnit: 0.006, // ~$0.006 per minute
        quality: 0.95,
        speed: 0.9,
        models: ['whisper-1'],
        defaultModel: 'whisper-1',
        available: !!process.env.OPENAI_API_KEY,
        timeoutMs: 60000,
        requestBuilder: (prompt, opts) => ({
            model: opts.model || 'whisper-1',
            file: prompt, // Will be handled specially for file uploads
            language: opts.language,
        }),
        responseParser: (data) => ({
            ok: true,
            text: data.text,
            durationMs: data.durationMs || 0,
        }),
    },
];
// ─── Provider Registry ──────────────────────────────────────────────────────
/** All built-in providers by modality. */
const PROVIDERS_BY_MODALITY = {
    image: IMAGE_PROVIDERS,
    tts: TTS_PROVIDERS,
    video: VIDEO_PROVIDERS,
    transcription: TRANSCRIPTION_PROVIDERS,
};
/** User-configured providers (from config). */
const userConfiguredProviders = [];
/**
 * Get all providers for a modality (built-in + user-configured).
 */
export function getModalityProviders(modality) {
    const builtIn = PROVIDERS_BY_MODALITY[modality] || [];
    const configured = userConfiguredProviders.filter(p => p.modality === modality);
    return [...builtIn, ...configured];
}
/**
 * Get all available providers for a modality (has API key or is keyless).
 */
export function getAvailableModalityProviders(modality) {
    return getModalityProviders(modality).filter(p => p.available);
}
/**
 * Get a specific provider by ID.
 */
export function getModalityProvider(id) {
    return getModalityProviders('image') // Check all modalities
        .concat(getModalityProviders('tts'))
        .concat(getModalityProviders('video'))
        .concat(getModalityProviders('transcription'))
        .find(p => p.id === id);
}
// ─── Provider Configuration ─────────────────────────────────────────────────
/**
 * Add a user-configured provider.
 * Called when user sets config like:
 *   nuvira config set modality.image.replicate.apiKey=xxxxx
 */
export function addModalityProvider(provider) {
    // Check if already exists
    const existing = userConfiguredProviders.findIndex(p => p.id === provider.id);
    if (existing >= 0) {
        userConfiguredProviders[existing] = provider;
    }
    else {
        userConfiguredProviders.push(provider);
    }
    logger.info(`[modality-catalog] Added provider: ${provider.id} (${provider.name})`);
}
/**
 * Remove a user-configured provider.
 */
export function removeModalityProvider(id) {
    const index = userConfiguredProviders.findIndex(p => p.id === id);
    if (index >= 0) {
        userConfiguredProviders.splice(index, 1);
        logger.info(`[modality-catalog] Removed provider: ${id}`);
        return true;
    }
    return false;
}
/**
 * Load user-configured providers from config.
 */
export function loadUserConfiguredProviders(config) {
    const modalityConfig = config.modality;
    if (!modalityConfig)
        return;
    for (const [modality, providers] of Object.entries(modalityConfig)) {
        if (!['image', 'tts', 'video', 'transcription'].includes(modality))
            continue;
        if (typeof providers !== 'object' || providers === null)
            continue;
        for (const [providerId, providerConfig] of Object.entries(providers)) {
            if (typeof providerConfig !== 'object' || providerConfig === null)
                continue;
            const cfg = providerConfig;
            // Build provider from config
            const provider = {
                id: providerId,
                name: cfg.name || providerId,
                modality: modality,
                apiType: cfg.apiType || 'rest',
                baseUrl: cfg.baseUrl || '',
                envVar: cfg.envVar,
                endpoint: cfg.endpoint,
                costPerUnit: cfg.costPerUnit || 0,
                quality: cfg.quality || 0.7,
                speed: cfg.speed || 0.7,
                models: Array.isArray(cfg.models) ? cfg.models : [],
                defaultModel: cfg.defaultModel,
                available: !!(cfg.apiKey || (cfg.envVar && typeof cfg.envVar === 'string' && process.env[cfg.envVar])),
                timeoutMs: cfg.timeoutMs || 30000,
                requestBuilder: (prompt, opts) => ({
                    prompt,
                    model: opts.model || cfg.defaultModel,
                    ...opts,
                }),
                responseParser: (data) => ({
                    ok: true,
                    data: data.data || data.url || data.text,
                    durationMs: data.durationMs || 0,
                }),
            };
            addModalityProvider(provider);
        }
    }
}
// ─── Provider Scoring ───────────────────────────────────────────────────────
/**
 * Score a modality provider for routing.
 */
export function scoreModalityProvider(provider, context = {}) {
    const maxCost = context.maxCost || 0.10; // Default max cost
    // Cost score: lower cost = higher score
    const costScore = Math.max(0, 1 - (provider.costPerUnit / maxCost));
    // Quality score: direct mapping
    const qualityScore = provider.quality;
    // Speed score: direct mapping
    const speedScore = provider.speed;
    // Availability score: available = 1, unavailable = 0
    const availabilityScore = provider.available ? 1 : 0;
    // Weighted combination
    const weights = {
        cost: context.priorityQuality ? 0.20 : 0.35,
        quality: context.priorityQuality ? 0.45 : 0.30,
        speed: context.prioritySpeed ? 0.35 : 0.20,
        availability: 0.15,
    };
    return (costScore * weights.cost +
        qualityScore * weights.quality +
        speedScore * weights.speed +
        availabilityScore * weights.availability);
}
/**
 * Select the best modality provider for a task.
 */
export function selectBestModalityProvider(modality, context = {}) {
    const providers = getAvailableModalityProviders(modality);
    if (providers.length === 0)
        return null;
    const scored = providers.map(p => ({
        provider: p,
        score: scoreModalityProvider(p, context),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored[0].provider;
}
// ─── Status ─────────────────────────────────────────────────────────────────
/**
 * Get status of all modality providers (for dashboard display).
 */
export function getModalityProviderStatus() {
    const status = {
        image: [],
        tts: [],
        video: [],
        transcription: [],
    };
    for (const modality of ['image', 'tts', 'video', 'transcription']) {
        const providers = getModalityProviders(modality);
        status[modality] = providers.map(p => ({
            id: p.id,
            name: p.name,
            available: p.available,
            costPerUnit: p.costPerUnit,
            quality: p.quality,
            speed: p.speed,
        }));
    }
    return status;
}
//# sourceMappingURL=modality-catalog.js.map