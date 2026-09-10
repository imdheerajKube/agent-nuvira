/**
 * Video Generation Tool — Text-to-video and image-to-video generation.
 *
 * Hermes equivalents:
 * - flux3_video_tool.py (1,249 lines) — BFL FLUX 3 video generation
 * - video_generation_tool.py (575 lines) — Generic video generation
 *
 * Provides:
 * - Text-to-video generation
 * - Image-to-video generation
 * - Video polling and status tracking
 * - Multiple provider support (FAL, BFL, generic)
 */
import { logger } from '../utils/logger.js';
// ─── FAL Video Generator ─────────────────────────────────────────────────
export class FALVideoGenerator {
    config;
    constructor(config = {}) {
        this.config = {
            apiKey: config.apiKey || process.env.FAL_KEY || '',
            baseUrl: config.baseUrl || 'https://fal.run',
            provider: config.provider || 'fal-ai/flux/video',
        };
    }
    /**
     * Generate video from text prompt.
     */
    async generate(request) {
        const url = `${this.config.baseUrl}/${this.config.provider}`;
        const body = {
            prompt: request.prompt,
            num_frames: request.duration ? request.duration * 24 : 144,
            aspect_ratio: request.aspectRatio || '16:9',
            resolution: request.resolution || '720p',
        };
        if (request.imageUrl)
            body.image_url = request.imageUrl;
        if (request.negativePrompt)
            body.negative_prompt = request.negativePrompt;
        if (request.seed !== undefined)
            body.seed = request.seed;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Key ${this.config.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                const errorText = await response.text();
                return {
                    id: `fal-${Date.now()}`,
                    status: 'failed',
                    error: `FAL API error: ${response.status} - ${errorText}`,
                };
            }
            const data = await response.json();
            return {
                id: data.request_id || `fal-${Date.now()}`,
                status: data.status || 'pending',
                videoUrl: data.video?.url || data.output?.video_url,
                thumbnailUrl: data.video?.thumbnail_url,
                metadata: data,
            };
        }
        catch (err) {
            return {
                id: `fal-${Date.now()}`,
                status: 'failed',
                error: String(err),
            };
        }
    }
    /**
     * Check status of a video generation job.
     */
    async status(jobId) {
        try {
            const response = await fetch(`${this.config.baseUrl}/${this.config.provider}/status/${jobId}`, {
                headers: { 'Authorization': `Key ${this.config.apiKey}` },
            });
            if (!response.ok) {
                return { id: jobId, status: 'failed', error: `Status check failed: ${response.status}` };
            }
            const data = await response.json();
            return {
                id: jobId,
                status: data.status || 'pending',
                videoUrl: data.video?.url || data.output?.video_url,
                error: data.error?.message,
            };
        }
        catch (err) {
            return { id: jobId, status: 'failed', error: String(err) };
        }
    }
}
export class VideoGenerationManager {
    providers = new Map();
    activeProvider;
    constructor() {
        this.activeProvider = 'fal';
        // Register FAL as default
        this.registerProvider({
            name: 'fal',
            generate: async (request) => {
                const gen = new FALVideoGenerator();
                return gen.generate(request);
            },
            status: async (jobId) => {
                const gen = new FALVideoGenerator();
                return gen.status(jobId);
            },
        });
    }
    /**
     * Register a video generation provider.
     */
    registerProvider(provider) {
        this.providers.set(provider.name, provider);
        logger.info(`[video-gen] Registered provider: ${provider.name}`);
    }
    /**
     * Set active provider.
     */
    setActiveProvider(name) {
        if (!this.providers.has(name))
            return false;
        this.activeProvider = name;
        return true;
    }
    /**
     * Generate video using active provider.
     */
    async generate(request) {
        const provider = this.providers.get(this.activeProvider);
        if (!provider) {
            return { id: '', status: 'failed', error: `No provider registered: ${this.activeProvider}` };
        }
        return provider.generate(request);
    }
    /**
     * Check status.
     */
    async status(jobId) {
        const provider = this.providers.get(this.activeProvider);
        if (!provider) {
            return { id: jobId, status: 'failed', error: `No provider registered: ${this.activeProvider}` };
        }
        return provider.status(jobId);
    }
    /**
     * List available providers.
     */
    listProviders() {
        return Array.from(this.providers.keys());
    }
}
// ─── Singleton ─────────────────────────────────────────────────────────────
let _videoGenManager = null;
export function getVideoGenManager() {
    if (!_videoGenManager)
        _videoGenManager = new VideoGenerationManager();
    return _videoGenManager;
}
export function resetVideoGenManager() {
    _videoGenManager = null;
}
//# sourceMappingURL=video-generation.js.map